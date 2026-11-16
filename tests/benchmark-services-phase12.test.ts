import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { deriveBenchmarkToken } from "@cookie-research/service-kit";
import { createBenchmarkService, startBenchmarkCluster } from "../evaluation/src/benchmark-services.js";

describe("Phase 12 benchmark services", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { while (closers.length) await closers.pop()?.(); });
  it("starts one service and revokes its active session", async () => { const service = createBenchmarkService("benchmark-001", 3201, "benchmark-shared-secret-1234"); await request(service.app).get("/session").expect({ serviceId: "benchmark-001", state: "ACTIVE" }); await request(service.app).post("/internal/v1/sessions/revoke").set("Authorization", `Bearer ${deriveBenchmarkToken("benchmark-shared-secret-1234", "benchmark-001")}`).send({ requestId: "11111111-1111-4111-8111-111111111111", eventId: "22222222-2222-4222-8222-222222222222", localUserId: "benchmark-user", reason: "DECOY_COOKIE_DETECTED", detectedAt: "2026-08-31T00:00:00.000Z" }).expect(200); expect(service.active).toBe(false); });
  it("starts five distinct benchmark instances", async () => { const cluster = await startBenchmarkCluster(5, "benchmark-shared-secret-1234", 3400); closers.push(cluster.close); expect(cluster.services.map((s) => s.serviceId)).toEqual(["benchmark-001","benchmark-002","benchmark-003","benchmark-004","benchmark-005"]); expect(new Set(cluster.services.map((s) => s.port)).size).toBe(5); });
});
