import { Router, type Request, type Response } from "express";

import type { MappingIdentity } from "../db/repositories/mapping-repository.js";
import type { SiteTokenAuthenticator } from "../internal-auth.js";
import type { MappingService } from "../services/mapping-service.js";

const MAX_IDENTIFIER_LENGTH = 128;

function nonEmptyIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_IDENTIFIER_LENGTH
  ) {
    return undefined;
  }

  return normalized;
}

function requestBody(request: Request): MappingIdentity | undefined {
  if (typeof request.body !== "object" || request.body === null) {
    return undefined;
  }

  const principalId = nonEmptyIdentifier(
    Reflect.get(request.body, "principalId") as unknown,
  );
  const serviceId = nonEmptyIdentifier(
    Reflect.get(request.body, "serviceId") as unknown,
  );
  const localUserId = nonEmptyIdentifier(
    Reflect.get(request.body, "localUserId") as unknown,
  );

  if (
    principalId === undefined ||
    serviceId === undefined ||
    localUserId === undefined
  ) {
    return undefined;
  }

  return { principalId, serviceId, localUserId };
}

export function createMappingsRouter(
  mappingService: MappingService,
  authenticator: SiteTokenAuthenticator,
): Router {
  const router = Router();

  function authenticatedServiceId(request: Request): string | undefined {
    return authenticator.authenticate(request.header("authorization"));
  }

  function rejectUnauthenticated(response: Response): void {
    response.set("WWW-Authenticate", "Bearer");
    response.status(401).json({ error: "UNAUTHORIZED" });
  }

  router.post("/", (request, response) => {
    const callerServiceId = authenticatedServiceId(request);
    if (callerServiceId === undefined) {
      rejectUnauthenticated(response);
      return;
    }

    const identity = requestBody(request);
    if (identity === undefined) {
      response.status(400).json({ error: "INVALID_MAPPING_REQUEST" });
      return;
    }

    if (identity.serviceId !== callerServiceId) {
      response.status(403).json({ error: "SERVICE_ID_MISMATCH" });
      return;
    }

    const result = mappingService.register(identity);
    if (result.kind === "service_not_found") {
      response.status(400).json({ error: "SERVICE_NOT_FOUND" });
      return;
    }

    if (result.kind === "conflict") {
      response.status(409).json({
        error: "MAPPING_CONFLICT",
        ...identity,
      });
      return;
    }

    response
      .status(result.kind === "registered" ? 201 : 200)
      .json({
        ...identity,
        status: result.kind,
      });
  });

  router.get("/resolve", (request, response) => {
    const callerServiceId = authenticatedServiceId(request);
    if (callerServiceId === undefined) {
      rejectUnauthenticated(response);
      return;
    }

    const serviceId = nonEmptyIdentifier(request.query.serviceId);
    const localUserId = nonEmptyIdentifier(request.query.localUserId);
    if (serviceId === undefined || localUserId === undefined) {
      response.status(400).json({ error: "INVALID_MAPPING_QUERY" });
      return;
    }

    if (serviceId !== callerServiceId) {
      response.status(403).json({ error: "SERVICE_ID_MISMATCH" });
      return;
    }

    const principalId = mappingService.findPrincipalByServiceUser(
      serviceId,
      localUserId,
    );
    if (principalId === undefined) {
      response.status(404).json({ error: "USER_MAPPING_NOT_FOUND" });
      return;
    }

    response.json({ serviceId, localUserId, principalId });
  });

  router.get("/:principalId", (request, response) => {
    const callerServiceId = authenticatedServiceId(request);
    if (callerServiceId === undefined) {
      rejectUnauthenticated(response);
      return;
    }

    const principalId = nonEmptyIdentifier(request.params.principalId);
    if (principalId === undefined) {
      response.status(400).json({ error: "INVALID_PRINCIPAL_ID" });
      return;
    }

    const mappings = mappingService
      .findForPrincipal(principalId)
      .filter(({ serviceId }) => serviceId === callerServiceId);
    if (mappings.length === 0) {
      response.status(404).json({ error: "USER_MAPPING_NOT_FOUND" });
      return;
    }

    response.json({
      principalId,
      services: mappings.map(({ serviceId, localUserId }) => ({
        serviceId,
        localUserId,
      })),
    });
  });

  return router;
}
