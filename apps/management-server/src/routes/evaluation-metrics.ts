import { Router } from "express";

import type { SiteTokenAuthenticator } from "../internal-auth.js";

/**
 * Phase 10 local evaluation endpoint. It exposes only process counters and is
 * protected by the same per-site authentication used by detection delivery.
 */
export function createEvaluationMetricsRouter(
  authenticator: SiteTokenAuthenticator,
): Router {
  const router = Router();

  router.get("/", (request, response) => {
    if (
      authenticator.authenticate(request.header("authorization")) ===
      undefined
    ) {
      response.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }

    const cpu = process.cpuUsage();
    const memory = process.memoryUsage();
    response.set("Cache-Control", "no-store").json({
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      sampledAt: new Date().toISOString(),
    });
  });

  return router;
}
