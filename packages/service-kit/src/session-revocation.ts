import { createHash, timingSafeEqual } from "node:crypto";

import express, { Router, type ErrorRequestHandler, type Request } from "express";

import type {
  SessionRevocationRequest,
  SessionRevocationResponse,
} from "@cookie-research/protocol";

export interface InvalidationRequestRecord extends SessionRevocationRequest {
  receivedAt: string;
  revokedCount: number;
}

export type SessionRevocationHandlerResult =
  | {
      kind: "success" | "already_processed";
      record: InvalidationRequestRecord;
    }
  | { kind: "request_id_conflict" }
  | { kind: "local_user_not_found" };

/**
 * Site-owned implementation of session invalidation.
 *
 * The service-kit owns HTTP validation and Manager authentication. Each Site
 * owns its database transaction, idempotency record, and session storage.
 */
export type SessionRevocationHandler = (
  request: SessionRevocationRequest,
) => SessionRevocationHandlerResult | Promise<SessionRevocationHandlerResult>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const REQUEST_KEYS = [
  "detectedAt",
  "eventId",
  "localUserId",
  "reason",
  "requestId",
] as const;

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

class ManagerTokenAuthenticator {
  private readonly expectedDigest: Buffer;

  public constructor(token: string) {
    this.expectedDigest = tokenDigest(token);
  }

  public authenticate(authorization: string | undefined): boolean {
    if (authorization === undefined || !authorization.startsWith("Bearer ")) {
      return false;
    }
    const token = authorization.slice("Bearer ".length);
    return (
      token.length > 0 &&
      timingSafeEqual(tokenDigest(token), this.expectedDigest)
    );
  }
}

function identifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 128
    ? normalized
    : undefined;
}

function uuid(value: unknown): string | undefined {
  const normalized = identifier(value);
  return normalized !== undefined && UUID_PATTERN.test(normalized)
    ? normalized
    : undefined;
}

function datetime(value: unknown): string | undefined {
  const normalized = identifier(value);
  return normalized !== undefined &&
    ISO_DATETIME_PATTERN.test(normalized) &&
    !Number.isNaN(Date.parse(normalized))
    ? normalized
    : undefined;
}

function requestBody(request: Request): SessionRevocationRequest | undefined {
  const body: unknown = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }
  const keys = Object.keys(body).sort();
  if (
    keys.length !== REQUEST_KEYS.length ||
    keys.some((key, index) => key !== REQUEST_KEYS[index])
  ) {
    return undefined;
  }
  const requestId = uuid(Reflect.get(body, "requestId") as unknown);
  const eventId = uuid(Reflect.get(body, "eventId") as unknown);
  const localUserId = identifier(Reflect.get(body, "localUserId") as unknown);
  const reason = Reflect.get(body, "reason") as unknown;
  const detectedAt = datetime(Reflect.get(body, "detectedAt") as unknown);
  if (
    requestId === undefined ||
    eventId === undefined ||
    localUserId === undefined ||
    reason !== "DECOY_COOKIE_DETECTED" ||
    detectedAt === undefined
  ) {
    return undefined;
  }
  return { requestId, eventId, localUserId, reason, detectedAt };
}

function responseBody(
  record: InvalidationRequestRecord,
  status: SessionRevocationResponse["status"],
): SessionRevocationResponse {
  return {
    requestId: record.requestId,
    eventId: record.eventId,
    localUserId: record.localUserId,
    revokedCount: record.revokedCount,
    status,
  };
}

export function createSessionRevocationRouter(
  authToken: string,
  handler: SessionRevocationHandler,
): Router {
  const router = Router();
  const authenticator = new ManagerTokenAuthenticator(authToken);

  router.use((request, response, next) => {
    if (!authenticator.authenticate(request.header("authorization"))) {
      response.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }
    next();
  });
  router.use(express.json({ limit: "16kb" }));
  router.post("/", async (request, response, next) => {
    const revocation = requestBody(request);
    if (revocation === undefined) {
      response.status(400).json({ error: "INVALID_REVOCATION_REQUEST" });
      return;
    }
    let result: SessionRevocationHandlerResult;
    try {
      result = await handler(revocation);
    } catch (error) {
      next(error);
      return;
    }
    if (result.kind === "request_id_conflict") {
      response.status(409).json({ error: "REQUEST_ID_CONFLICT" });
      return;
    }
    if (result.kind === "local_user_not_found") {
      response.status(404).json({ error: "LOCAL_USER_NOT_FOUND" });
      return;
    }
    console.log(
      `[session-revocation] request ${result.record.requestId} event ${result.record.eventId} user ${result.record.localUserId} revoked ${result.record.revokedCount}`,
    );
    response.json(responseBody(result.record, result.kind));
  });

  const invalidJsonHandler: ErrorRequestHandler = (
    error,
    _request,
    response,
    next,
  ) => {
    if (error instanceof SyntaxError) {
      response.status(400).json({ error: "INVALID_JSON" });
      return;
    }
    next(error);
  };
  router.use(invalidJsonHandler);
  return router;
}
