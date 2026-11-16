import type {
  DetectionNotificationRequest,
  DetectionNotificationResponse,
  SiteServiceId,
} from "@cookie-research/protocol";

export type DetectionNotificationClientResult =
  | {
      ok: true;
      status: DetectionNotificationResponse["status"];
      attempts: number;
      response: DetectionNotificationResponse;
    }
  | {
      ok: false;
      status: "rejected" | "unavailable";
      attempts: number;
      httpStatus?: number;
      error: string;
    };

export interface DetectionNotificationClientOptions {
  fetchImplementation?: typeof fetch;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

export interface DetectionNotifierConfig {
  authToken: string;
  managementBaseUrl: string;
  serviceId: SiteServiceId;
}

export type DetectionNotifier = (
  event: Omit<DetectionNotificationRequest, "serviceId">,
) => Promise<DetectionNotificationClientResult>;

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 300;
const DEFAULT_TIMEOUT_MS = 1_500;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/api/v1/detections`;
}

async function errorCode(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const { error } = body;
      if (typeof error === "string") return error;
    }
  } catch {
    // The status code is sufficient for a non-JSON failure response.
  }
  return `HTTP_${response.status}`;
}

async function successResponse(
  response: Response,
): Promise<DetectionNotificationResponse | undefined> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("status" in body) ||
      !("eventId" in body) ||
      !("principalId" in body) ||
      !("targets" in body) ||
      ![
        "received",
        "already_received",
        "RESOLVED",
        "PROCESSING",
        "SUCCESS",
        "PARTIAL_FAILURE",
        "FAILED",
      ].includes(typeof body.status === "string" ? body.status : "") ||
      typeof body.eventId !== "string" ||
      typeof body.principalId !== "string" ||
      !Array.isArray(body.targets)
    ) {
      return undefined;
    }
    return body as DetectionNotificationResponse;
  } catch {
    return undefined;
  }
}

export async function sendDetectionNotification(
  config: DetectionNotifierConfig,
  event: Omit<DetectionNotificationRequest, "serviceId">,
  options: DetectionNotificationClientOptions = {},
): Promise<DetectionNotificationClientResult> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const sleep = options.sleep ?? delay;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const payload: DetectionNotificationRequest = {
    eventId: event.eventId,
    serviceId: config.serviceId,
    localUserId: event.localUserId,
    decoyId: event.decoyId,
    detectedAt: event.detectedAt,
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImplementation(endpoint(config.managementBaseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 200 || response.status === 201) {
        const body = await successResponse(response);
        if (body !== undefined) {
          return {
            ok: true,
            status: body.status,
            attempts: attempt,
            response: body,
          };
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
          error: await errorCode(response),
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
  throw new Error("Detection notification retry loop ended unexpectedly.");
}

export function createDetectionNotifier(
  config: DetectionNotifierConfig,
  options?: DetectionNotificationClientOptions,
): DetectionNotifier {
  return async (event) => await sendDetectionNotification(config, event, options);
}
