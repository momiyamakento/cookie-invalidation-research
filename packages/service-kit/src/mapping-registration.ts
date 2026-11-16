export interface MappingRegistrationInput {
  authToken: string;
  managementBaseUrl: string;
  principalId: string;
  serviceId: string;
  localUserId: string;
}

export type MappingRegistrationResult =
  | {
      ok: true;
      status: "registered" | "already_registered";
      attempts: number;
    }
  | {
      ok: false;
      status: "rejected" | "unavailable";
      attempts: number;
      httpStatus?: number;
      error: string;
    };

export interface MappingRegistrationOptions {
  fetchImplementation?: typeof fetch;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 300;
const DEFAULT_TIMEOUT_MS = 1_500;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function mappingEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/api/v1/mappings`;
}

async function responseError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const { error } = body;
      if (typeof error === "string") {
        return error;
      }
    }
  } catch {
    // The HTTP status remains sufficient when the response is not JSON.
  }
  return `HTTP_${response.status}`;
}

async function successStatus(
  response: Response,
): Promise<"registered" | "already_registered" | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("status" in body)) {
      return undefined;
    }
    const { status } = body;
    if (response.status === 201 && status === "registered") {
      return "registered";
    }
    if (response.status === 200 && status === "already_registered") {
      return "already_registered";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function registerServiceMapping(
  input: MappingRegistrationInput,
  options: MappingRegistrationOptions = {},
): Promise<MappingRegistrationResult> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const sleep = options.sleep ?? delay;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const payload = {
    principalId: input.principalId,
    serviceId: input.serviceId,
    localUserId: input.localUserId,
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImplementation(
        mappingEndpoint(input.managementBaseUrl),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${input.authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );

      if (response.status === 200 || response.status === 201) {
        const status = await successStatus(response);
        if (status !== undefined) {
          return { ok: true, status, attempts: attempt };
        }
        return {
          ok: false,
          status: "rejected",
          attempts: attempt,
          httpStatus: response.status,
          error: "UNEXPECTED_SUCCESS_RESPONSE",
        };
      }

      if (response.status < 500) {
        return {
          ok: false,
          status: "rejected",
          attempts: attempt,
          httpStatus: response.status,
          error: await responseError(response),
        };
      }

      if (attempt === maxAttempts) {
        return {
          ok: false,
          status: "unavailable",
          attempts: attempt,
          httpStatus: response.status,
          error: `HTTP_${response.status}`,
        };
      }
    } catch (error) {
      if (attempt === maxAttempts) {
        return {
          ok: false,
          status: "unavailable",
          attempts: attempt,
          error: error instanceof Error ? error.name : "NETWORK_ERROR",
        };
      }
    }

    await sleep(retryDelayMs);
  }

  throw new Error("Mapping registration retry loop ended unexpectedly.");
}

export async function registerMappingAfterStartup(
  input: MappingRegistrationInput,
): Promise<void> {
  const result = await registerServiceMapping(input);
  const prefix = `[${input.serviceId}]`;

  if (result.ok) {
    console.log(`${prefix} mapping ${result.status.replace("_", " ")}`);
    return;
  }

  if (result.status === "unavailable") {
    console.error(
      `${prefix} mapping registration unavailable after ${result.attempts} attempts: ${result.error}`,
    );
    return;
  }

  console.error(
    `${prefix} mapping registration failed: ${result.httpStatus ?? "unknown"} ${result.error}`,
  );
}
