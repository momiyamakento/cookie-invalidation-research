import { COMPONENTS } from "@cookie-research/protocol";
import { createHealthApp } from "@cookie-research/service-kit";
import express, { type ErrorRequestHandler } from "express";

import { createMappingsRouter } from "./routes/mappings.js";
import { createBenchmarkServicesRouter } from "./routes/benchmark-services.js";
import { createDetectionsRouter } from "./routes/detections.js";
import { createEvaluationMetricsRouter } from "./routes/evaluation-metrics.js";
import type { SiteTokenAuthenticator } from "./internal-auth.js";
import type { SecurityAuditRepository } from "./db/repositories/security-audit-repository.js";
import { createSecurityAuditMiddleware } from "./security-audit-middleware.js";
import type { DetectionService } from "./services/detection-service.js";
import type { InvalidationOrchestrator } from "./services/invalidation-orchestrator.js";
import type { MappingService } from "./services/mapping-service.js";

export interface ManagementApiDependencies {
  authenticator: SiteTokenAuthenticator;
  detectionService?: DetectionService;
  invalidationOrchestrator?: InvalidationOrchestrator;
  securityAuditRepository?: SecurityAuditRepository;
}

export function createManagementApp(
  mappingService: MappingService,
  managementApi: ManagementApiDependencies,
) {
  const app = createHealthApp(COMPONENTS.managementServer);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  if (managementApi.securityAuditRepository !== undefined) {
    app.use(createSecurityAuditMiddleware(
      managementApi.authenticator,
      managementApi.securityAuditRepository,
    ));
  }
  app.use("/api/v1/mappings", createMappingsRouter(mappingService, managementApi.authenticator));
  app.use("/api/v1/benchmark-services", createBenchmarkServicesRouter(mappingService));
  if (managementApi.detectionService !== undefined) {
    app.use(
      "/api/v1/evaluation/process-metrics",
      createEvaluationMetricsRouter(managementApi.authenticator),
    );
    app.use(
      "/api/v1/detections",
      createDetectionsRouter(
        managementApi.detectionService,
        managementApi.authenticator,
        managementApi.invalidationOrchestrator,
      ),
    );
  }

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
  app.use(invalidJsonHandler);

  return app;
}
