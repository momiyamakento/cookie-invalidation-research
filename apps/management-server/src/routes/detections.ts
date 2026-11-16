import type {
  DetectionNotificationRequest,
} from "@cookie-research/protocol";
import { isManagedServiceId } from "@cookie-research/protocol";
import { Router, type Request } from "express";

import type { SiteTokenAuthenticator } from "../internal-auth.js";
import type { DetectionRateLimiter } from "../detection-rate-limiter.js";
import type { DetectionService } from "../services/detection-service.js";
import type { InvalidationOrchestrator } from "../services/invalidation-orchestrator.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const REQUEST_KEYS = [
  "decoyId",
  "detectedAt",
  "eventId",
  "localUserId",
  "serviceId",
] as const;

function identifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 128
    ? normalized
    : undefined;
}

function validUuid(value: unknown): string | undefined {
  const normalized = identifier(value);
  return normalized !== undefined && UUID_PATTERN.test(normalized)
    ? normalized
    : undefined;
}

function validDatetime(value: unknown): string | undefined {
  const normalized = identifier(value);
  return normalized !== undefined &&
    ISO_DATETIME_PATTERN.test(normalized) &&
    !Number.isNaN(Date.parse(normalized))
    ? normalized
    : undefined;
}

function requestBody(request: Request): DetectionNotificationRequest | undefined {
  const body: unknown = request.body;
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body)
  ) {
    return undefined;
  }
  const keys = Object.keys(body).sort();
  if (
    keys.length !== REQUEST_KEYS.length ||
    keys.some((key, index) => key !== REQUEST_KEYS[index])
  ) {
    return undefined;
  }

  const eventId = validUuid(Reflect.get(body, "eventId") as unknown);
  const serviceId = identifier(
    Reflect.get(body, "serviceId") as unknown,
  );
  const localUserId = identifier(
    Reflect.get(body, "localUserId") as unknown,
  );
  const decoyId = validUuid(Reflect.get(body, "decoyId") as unknown);
  const detectedAt = validDatetime(
    Reflect.get(body, "detectedAt") as unknown,
  );
  if (
    eventId === undefined ||
    serviceId === undefined ||
    !isManagedServiceId(serviceId) ||
    localUserId === undefined ||
    decoyId === undefined ||
    detectedAt === undefined
  ) {
    return undefined;
  }
  return {
    eventId,
    serviceId,
    localUserId,
    decoyId,
    detectedAt,
  };
}

export function createDetectionsRouter(
  detectionService: DetectionService,
  authenticator: SiteTokenAuthenticator,
  invalidationOrchestrator?: InvalidationOrchestrator,
  rateLimiter?: DetectionRateLimiter,
): Router {
  const router = Router();

  router.post("/", async (request, response) => {
    const claimedServiceId = typeof request.body === "object" && request.body !== null
      ? Reflect.get(request.body, "serviceId") as unknown
      : undefined;
    const authenticatedServiceId = authenticator.authenticate(
      request.header("authorization"),
      typeof claimedServiceId === "string" ? claimedServiceId : undefined,
    );
    if (authenticatedServiceId === undefined) {
      response.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }

    const notification = requestBody(request);
    if (notification === undefined) {
      response.status(400).json({ error: "INVALID_DETECTION_REQUEST" });
      return;
    }
    if (notification.serviceId !== authenticatedServiceId) {
      response.status(403).json({ error: "SERVICE_ID_MISMATCH" });
      return;
    }

    const rateLimit = rateLimiter?.check(notification.serviceId, notification.eventId);
    if (rateLimit !== undefined && !rateLimit.allowed) {
      response.set("Retry-After", String(rateLimit.retryAfterSeconds));
      response.status(429).json({ error: "DETECTION_RATE_LIMITED" });
      return;
    }

    const result = detectionService.resolve(notification);
    if (result.kind === "event_id_conflict") {
      response.status(409).json({ error: "EVENT_ID_CONFLICT" });
      return;
    }
    if (result.kind === "received") rateLimiter?.record(notification.serviceId, notification.eventId);
    if (result.kind === "user_mapping_not_found") {
      response.status(404).json({ error: "USER_MAPPING_NOT_FOUND" });
      return;
    }

    if (invalidationOrchestrator !== undefined) {
      const orchestration = await invalidationOrchestrator.orchestrate(
        result.event.eventId,
        result.targets,
      );
      response.status(result.kind === "received" ? 201 : 200).json(orchestration);
      return;
    }

    response.status(result.kind === "received" ? 201 : 200).json({
      eventId: result.event.eventId,
      principalId: result.event.principalId,
      status: result.kind,
      targets: result.targets,
    });
  });

  router.get("/:eventId/invalidation-jobs", (request, response) => {
    const eventId = validUuid(request.params.eventId);
    if (eventId === undefined) {
      response.status(400).json({ error: "INVALID_EVENT_ID" });
      return;
    }
    const event = detectionService.findByEventId(eventId);
    const authenticatedServiceId = authenticator.authenticate(
      request.header("authorization"),
      event?.sourceServiceId,
    );
    if (authenticatedServiceId === undefined) {
      response.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }
    if (event === undefined) {
      response.status(404).json({ error: "DETECTION_EVENT_NOT_FOUND" });
      return;
    }
    if (authenticatedServiceId !== event.sourceServiceId) {
      response.status(403).json({ error: "SOURCE_SERVICE_MISMATCH" });
      return;
    }
    response.json(
      invalidationOrchestrator === undefined
        ? { eventId, jobs: [] }
        : invalidationOrchestrator.snapshot(eventId),
    );
  });

  router.get("/:eventId", (request, response) => {
    const eventId = validUuid(request.params.eventId);
    if (eventId === undefined) {
      response.status(400).json({ error: "INVALID_EVENT_ID" });
      return;
    }
    const event = detectionService.findByEventId(eventId);
    const authenticatedServiceId = authenticator.authenticate(
      request.header("authorization"),
      event?.sourceServiceId,
    );
    if (authenticatedServiceId === undefined) {
      response.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }
    if (event === undefined) {
      response.status(404).json({ error: "DETECTION_EVENT_NOT_FOUND" });
      return;
    }
    if (authenticatedServiceId !== event.sourceServiceId) {
      response.status(403).json({ error: "SOURCE_SERVICE_MISMATCH" });
      return;
    }
    response.json(
      invalidationOrchestrator === undefined
        ? event
        : {
            ...event,
            invalidation: invalidationOrchestrator.snapshot(eventId),
          },
    );
  });

  return router;
}
