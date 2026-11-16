import { LOAD_PROFILES } from "../evaluation/src/benchmark-load.js";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveBenchmarkToken } from "@cookie-research/service-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";

import { createManagementApp } from "../apps/management-server/src/app.js";
import { SiteTokenAuthenticator } from "../apps/management-server/src/internal-auth.js";
import { initializeManagementContext, type ManagementContext } from "../apps/management-server/src/management-context.js";
import { InvalidationOrchestrator } from "../apps/management-server/src/services/invalidation-orchestrator.js";
import { createSiteRevocationClient } from "../apps/management-server/src/site-revocation-client.js";
import { createBenchmarkService, startBenchmarkCluster, type BenchmarkCluster } from "../evaluation/src/benchmark-services.js";

const SECRET = "benchmark-management-shared-secret-1234";
const PRINCIPAL = "benchmark-principal-001";
const SITE_TOKENS = {
  "site-a": "phase13-site-a", "site-b": "phase13-site-b", "site-c": "phase13-site-c",
} as const;

describe("Phase 13 benchmark services through Management Server", () => {
  let context: ManagementContext;
  let directory: string;
  let cluster: BenchmarkCluster | undefined;

  beforeEach(() => {
    cluster = undefined;
    directory = mkdtempSync(join(tmpdir(), "phase13-management-"));
    context = initializeManagementContext(join(directory, "management.sqlite"));
  });

  afterEach(async () => {
    await cluster?.close();
    context.database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function app() {
    const orchestrator = new InvalidationOrchestrator(
      context.database,
      context.detectionRepository,
      context.invalidationJobRepository,
      context.serviceRepository,
      {},
      createSiteRevocationClient({ retryDelayMs: 0 }),
      SECRET,
    );
    return createManagementApp(context.mappingService, {
      authenticator: new SiteTokenAuthenticator(SITE_TOKENS, SECRET),
      detectionService: context.detectionService,
      invalidationOrchestrator: orchestrator,
    });
  }

  async function registerAll(serviceCount: number): Promise<void> {
    if (cluster === undefined) throw new Error("Benchmark cluster is not started.");
    for (const service of cluster.services) {
      await request(app()).post("/api/v1/benchmark-services").send({
        serviceId: service.serviceId,
        baseUrl: `http://127.0.0.1:${service.port}`,
        principalId: PRINCIPAL,
        localUserId: "benchmark-user",
      }).expect(201);
    }
    expect(context.mappingService.findForPrincipal(PRINCIPAL)).toHaveLength(serviceCount);
  }

  async function detectThroughManagement(serviceId: `benchmark-${string}`): Promise<{ status: number; body: unknown }> {
    const response = await request(app()).post("/api/v1/detections")
      .set("Authorization", `Bearer ${deriveBenchmarkToken(SECRET, serviceId)}`)
      .send({
        eventId: randomUUID(), serviceId, localUserId: "benchmark-user",
        decoyId: randomUUID(), detectedAt: "2026-08-31T03:00:00.000Z",
      });
    return { status: response.status, body: response.body };
  }

  it("registers one benchmark service dynamically with its principal mapping", async () => {
    cluster = await startBenchmarkCluster(1, SECRET, 3900);
    await registerAll(1);
    expect(context.serviceRepository.findById("benchmark-001")?.baseUrl).toBe("http://127.0.0.1:3901");
  });

  it("registers five benchmark services and associates all with one principal", async () => {
    cluster = await startBenchmarkCluster(5, SECRET, 3920);
    await registerAll(5);
    expect(context.mappingService.findForPrincipal(PRINCIPAL).map((mapping) => mapping.serviceId)).toEqual([
      "benchmark-001", "benchmark-002", "benchmark-003", "benchmark-004", "benchmark-005",
    ]);
  });

  it("derives the service-scoped token and rejects an incorrect token", async () => {
    const service = createBenchmarkService("benchmark-001", 0, SECRET);
    const body = { requestId: randomUUID(), eventId: randomUUID(), localUserId: "benchmark-user", reason: "DECOY_COOKIE_DETECTED", detectedAt: "2026-08-31T03:00:00.000Z" };
    await request(service.app).post("/internal/v1/sessions/revoke").set("Authorization", "Bearer incorrect").send(body).expect(401);
    await request(service.app).post("/internal/v1/sessions/revoke").set("Authorization", `Bearer ${deriveBenchmarkToken(SECRET, "benchmark-001")}`).send(body).expect(200);
    expect(service.active).toBe(false);
  });

  it("invalidates one benchmark session through Management Server", async () => {
    cluster = await startBenchmarkCluster(1, SECRET, 3940);
    await registerAll(1);
    const response = await detectThroughManagement("benchmark-001");
    expect(response.status).toBe(201);
    const body = response.body as { status: string; targets: Array<Record<string, unknown>> };
    expect(body.status).toBe("SUCCESS");
    expect(body.targets).toHaveLength(1);
    expect(body.targets[0]).toMatchObject({ serviceId: "benchmark-001", status: "SUCCESS", revokedCount: 1 });
    await request(cluster.services[0]!.app).get("/session").expect({ serviceId: "benchmark-001", state: "REVOKED" });
  });

  it.each(["light", "medium", "heavy"] as const)("invalidates five %s benchmark sessions in parallel through Management Server", async (profile) => {
    cluster = await startBenchmarkCluster(5, SECRET, 0, profile, 20);
    await registerAll(5);
    const response = await detectThroughManagement("benchmark-001");
    expect(response.status).toBe(201);
    const body = response.body as { status: string; targets: Array<{ status: string; revokedCount: number }> };
    expect(body.status).toBe("SUCCESS");
    expect(body.targets).toHaveLength(5);
    expect(body.targets.every((target) => target.status === "SUCCESS" && target.revokedCount === LOAD_PROFILES[profile].sessionCount)).toBe(true);
    if (profile !== "light") {
      // Every handler must start before the first one completes: waits overlap.
      const starts = cluster.services.map((s) => Date.parse(s.timings[0]!.receivedAt) + s.timings[0]!.handlerStartedMs);
      const ends = cluster.services.map((s) => Date.parse(s.timings[0]!.receivedAt) + s.timings[0]!.handlerCompletedMs);
      expect(Math.max(...starts)).toBeLessThan(Math.min(...ends));
    }
    await Promise.all(cluster.services.map(async (service) => await request(service.app).get("/session").expect({ serviceId: service.serviceId, state: "REVOKED" })));
  });
});
