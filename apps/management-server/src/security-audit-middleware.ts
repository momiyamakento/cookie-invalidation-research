import type { RequestHandler } from "express";

import type {
  SecurityAuditAction,
  SecurityAuditRepository,
} from "./db/repositories/security-audit-repository.js";
import type { SiteTokenAuthenticator } from "./internal-auth.js";

function action(method: string, path: string): SecurityAuditAction | undefined {
  if (method === "POST" && path === "/api/v1/mappings") return "MAPPING_REGISTER";
  if (method === "GET" && path === "/api/v1/mappings/resolve") return "MAPPING_RESOLVE";
  if (method === "GET" && path.startsWith("/api/v1/mappings/")) return "MAPPING_READ";
  if (method === "POST" && path === "/api/v1/detections") return "DETECTION_CREATE";
  if (method === "GET" && path.startsWith("/api/v1/detections/")) return "DETECTION_READ";
  return undefined;
}

function claimedServiceId(request: Parameters<RequestHandler>[0]): string | undefined {
  if (request.method === "POST" && typeof request.body === "object" && request.body !== null) {
    const value: unknown = Reflect.get(request.body, "serviceId");
    return typeof value === "string" && value.length <= 128 ? value : undefined;
  }
  if (request.path === "/api/v1/mappings/resolve") {
    const value = request.query.serviceId;
    return typeof value === "string" && value.length <= 128 ? value : undefined;
  }
  return undefined;
}

export function createSecurityAuditMiddleware(
  authenticator: SiteTokenAuthenticator,
  repository: SecurityAuditRepository,
): RequestHandler {
  return (request, response, next) => {
    const auditAction = action(request.method, request.path);
    if (auditAction === undefined) {
      next();
      return;
    }
    const occurredAt = new Date().toISOString();
    const claimed = claimedServiceId(request);
    const authenticated = authenticator.authenticate(request.header("authorization"), claimed);
    response.once("finish", () => {
      repository.insert({
        occurredAt,
        action: auditAction,
        authenticatedServiceId: authenticated ?? null,
        claimedServiceId: claimed ?? null,
        outcome: response.statusCode < 400 ? "ALLOWED" : "DENIED",
        httpStatus: response.statusCode,
      });
    });
    next();
  };
}
