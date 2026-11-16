import type {
  SessionRevocationRequest,
  SessionRevocationResponse,
} from "@cookie-research/protocol";

export interface SiteRevocationClientInput {
  baseUrl: string;
  authToken: string;
  request: SessionRevocationRequest;
}

export type SiteRevocationClientResult =
  | {
      ok: true;
      attempts: number;
      httpStatus: 200;
      response: SessionRevocationResponse;
    }
  | {
      ok: false;
      attempts: number;
      httpStatus: number | null;
      error: string;
    };

export interface SiteRevocationClientOptions {
  fetchImplementation?: typeof fetch;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

export type SiteRevocationClient = (
  input: SiteRevocationClientInput,
) => Promise<SiteRevocationClientResult>;

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 300;
const DEFAULT_TIMEOUT_MS = 1_500;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function responseError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const { error } = body;
      if (typeof error === "string") return error;
    }
  } catch {
    // A sanitized HTTP status remains sufficient for non-JSON failures.
  }
  return `HTTP_${response.status}`;
}

async function successBody(
  response: Response,
): Promise<SessionRevocationResponse | undefined> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("requestId" in body) ||
      !("eventId" in body) ||
      !("localUserId" in body) ||
      !("revokedCount" in body) ||
      !("status" in body) ||
      typeof body.requestId !== "string" ||
      typeof body.eventId !== "string" ||
      typeof body.localUserId !== "string" ||
      !Number.isInteger(body.revokedCount) ||
      (body.status !== "success" && body.status !== "already_processed")
    ) {
      return undefined;
    }
    return body as SessionRevocationResponse;
  } catch {
    return undefined;
  }
}

export async function revokeSiteSessions(
  input: SiteRevocationClientInput,
  options: SiteRevocationClientOptions = {},
): Promise<SiteRevocationClientResult> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const sleep = options.sleep ?? delay;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImplementation(
        `${input.baseUrl.replace(/\/+$/u, "")}/internal/v1/sessions/revoke`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${input.authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(input.request),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (response.status === 200) {
        const parsed = await successBody(response);
        if (
          parsed !== undefined &&
          parsed.requestId === input.request.requestId &&
          parsed.eventId === input.request.eventId &&
          parsed.localUserId === input.request.localUserId
        ) {
          return { ok: true, attempts: attempt, httpStatus: 200, response: parsed };
        }
        return {
          ok: false,
          attempts: attempt,
          httpStatus: 200,
          error: "UNEXPECTED_SUCCESS_RESPONSE",
        };
      }
      if (response.status < 500) {
        return {
          ok: false,
          attempts: attempt,
          httpStatus: response.status,
          error: await responseError(response),
        };
      }
      if (attempt === maxAttempts) {
        return {
          ok: false,
          attempts: attempt,
          httpStatus: response.status,
          error: `HTTP_${response.status}`,
        };
      }
    } catch (error) {
      if (attempt === maxAttempts) {
        return {
          ok: false,
          attempts: attempt,
          httpStatus: null,
          error: error instanceof Error ? error.name : "NETWORK_ERROR",
        };
      }
    }
    await sleep(retryDelayMs);
  }
  throw new Error("Site revocation retry loop ended unexpectedly.");
}

export function createSiteRevocationClient(
  options?: SiteRevocationClientOptions,
): SiteRevocationClient {
  return async (input) => await revokeSiteSessions(input, options);
}
