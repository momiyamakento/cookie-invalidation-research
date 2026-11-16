import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { deriveBenchmarkToken } from "@cookie-research/service-kit";
import { createBenchmarkService } from "../evaluation/src/benchmark-services.js";
import { createBenchmarkLoad, LOAD_PROFILES } from "../evaluation/src/benchmark-load.js";
import { parseBenchmarkScaleOptions } from "../evaluation/src/benchmark-scale-options.js";

const secret = "load-profile-test-secret";
const payload = () => ({ requestId: randomUUID(), eventId: randomUUID(), localUserId: "benchmark-user", reason: "DECOY_COOKIE_DETECTED" as const, detectedAt: new Date().toISOString() });

describe("benchmark service load profiles", () => {
  it("defaults to light, accepts environment and CLI override, rejects invalid settings", () => {
    expect(parseBenchmarkScaleOptions([], {}).loadProfile).toBe("light");
    expect(parseBenchmarkScaleOptions([], { SERVICE_LOAD_PROFILE: "medium" }).loadProfile).toBe("medium");
    expect(parseBenchmarkScaleOptions(["--load-profile", "heavy"], { SERVICE_LOAD_PROFILE: "invalid" }).loadProfile).toBe("heavy");
    expect(() => parseBenchmarkScaleOptions([], { SERVICE_LOAD_PROFILE: "invalid" })).toThrow();
    expect(() => parseBenchmarkScaleOptions(["--load-profile"], {})).toThrow();
    expect(() => createBenchmarkService("benchmark-001", 0, secret, "invalid")).toThrow();
  });

  it.each(["light", "medium", "heavy"] as const)("%s revokes, rejects unauthenticated requests, resets and records timing without API changes", async (profile) => {
    const service = createBenchmarkService("benchmark-001", 0, secret, profile);
    const send = () => request(service.app).post("/internal/v1/sessions/revoke").set("Authorization", `Bearer ${deriveBenchmarkToken(secret, service.serviceId)}`).send(payload());
    try {
      await request(service.app).post("/internal/v1/sessions/revoke").send(payload()).expect(401);
      expect(service.active).toBe(true);
      expect(service.timings).toHaveLength(0);
      await request(service.app).post("/internal/v1/sessions/revoke").set("Authorization", `Bearer ${deriveBenchmarkToken(secret, service.serviceId)}`).send({}).expect(400);
      expect(service.active).toBe(true);
      const response = await send().expect(200);
      expect(response.body).toMatchObject({ revokedCount: LOAD_PROFILES[profile].sessionCount, status: "success" });
      expect(Object.keys(response.body as object).sort()).toEqual(["eventId", "localUserId", "requestId", "revokedCount", "status"]);
      expect(service.active).toBe(false);
      const timing = service.timings[0]!;
      expect(timing.actualWorkMs).toBeGreaterThanOrEqual(0);
      expect(timing.intentionalDelayMs).toBe(0);
      expect(timing.observedDelayMs).toBeGreaterThanOrEqual(0);
      expect(timing.processingDurationMs).toBeGreaterThanOrEqual(timing.actualWorkMs + timing.observedDelayMs);
      expect(timing.loadProfile).toBe(profile);
      expect(timing.handlerCompletedMs).toBeGreaterThanOrEqual(timing.handlerStartedMs);
      expect(timing.responseFinishedMs).toBeGreaterThanOrEqual(timing.handlerCompletedMs);
      expect((await send().expect(200)).body).toMatchObject({ revokedCount: 0 });
      service.reset();
      expect(service.timings).toHaveLength(0);
      expect(service.active).toBe(true);
      expect((await send().expect(200)).body).toMatchObject({ revokedCount: LOAD_PROFILES[profile].sessionCount });
    } finally { service.close(); }
  });

  it.each(["light", "medium", "heavy"] as const)("%s rejects an unknown user without revoking the seeded session or waiting", async (profile) => {
    const service = createBenchmarkService("benchmark-001", 0, secret, profile);
    try {
      await request(service.app).post("/internal/v1/sessions/revoke")
        .set("Authorization", `Bearer ${deriveBenchmarkToken(secret, service.serviceId)}`)
        .send({ ...payload(), localUserId: "missing" }).expect(404);
      expect(service.active).toBe(true);
      expect(service.timings).toHaveLength(1);
      expect(service.timings[0]).toMatchObject({ httpStatus: 404, intentionalDelayMs: 0, observedDelayMs: 0 });
    } finally { service.close(); }
  });

  it.each(["medium", "heavy"] as const)("%s stores actual session state in SQLite and resets it", (profile) => {
    const load = createBenchmarkLoad(profile);
    try {
      expect(load.revoke({ ...payload(), localUserId: "missing" })).toBeUndefined();
      expect(load.active).toBe(true);
      expect(load.revoke(payload())).toBe(LOAD_PROFILES[profile].sessionCount);
      expect(load.active).toBe(false);
      expect(load.revoke(payload())).toBe(0);
      load.reset();
      expect(load.active).toBe(true);
      expect(load.revoke(payload())).toBe(LOAD_PROFILES[profile].sessionCount);
    } finally { load.close(); }
  });

  it.each(["light", "medium", "heavy"] as const)("%s applies only the independently configured delay", async (profile) => {
    for (const serviceDelayMs of [0, 20, 100]) {
      const service = createBenchmarkService("benchmark-001", 0, secret, profile, serviceDelayMs);
      try {
        await request(service.app).post("/internal/v1/sessions/revoke")
          .set("Authorization", `Bearer ${deriveBenchmarkToken(secret, service.serviceId)}`).send(payload()).expect(200);
        const t = service.timings[0]!;
        expect(t.serviceDelayMs).toBe(serviceDelayMs);
        expect(t.intentionalDelayMs).toBe(serviceDelayMs);
        expect(t.actualProcessingMs).toBeGreaterThanOrEqual(0);
        expect(t.serviceProcessingMs).toBe(t.actualProcessingMs + t.measuredDelayMs);
        expect(serviceDelayMs === 0 ? t.measuredDelayMs === 0 : t.measuredDelayMs >= serviceDelayMs - 2).toBe(true);
      } finally { service.close(); }
    }
  });

  it.each(["medium", "heavy"] as const)("%s revokes related grants and audits every distinct session", (profile) => {
    const load = createBenchmarkLoad(profile);
    const { sessionCount, grantsPerSession } = LOAD_PROFILES[profile];
    try {
      expect(load.inspect()).toEqual({ activeSessions: sessionCount, activeGrants: sessionCount * grantsPerSession, auditRecords: 0, auditedGrants: 0 });
      load.revoke(payload());
      expect(load.inspect()).toEqual({ activeSessions: 0, activeGrants: 0, auditRecords: sessionCount, auditedGrants: sessionCount * grantsPerSession });
      load.revoke(payload());
      expect(load.inspect().auditRecords).toBe(sessionCount);
      load.reset();
      expect(load.inspect()).toEqual({ activeSessions: sessionCount, activeGrants: sessionCount * grantsPerSession, auditRecords: 0, auditedGrants: 0 });
    } finally { load.close(); }
  });

  it("validates delay arguments without silently coercing invalid timers", () => {
    expect(parseBenchmarkScaleOptions([], {}).serviceDelayMs).toBe(0);
    expect(parseBenchmarkScaleOptions(["--load-profile", "heavy", "--service-delay-ms", "20"], {}).serviceDelayMs).toBe(20);
    for (const value of ["-1", "1.5", "NaN", "Infinity", "2147483648"]) {
      expect(() => parseBenchmarkScaleOptions(["--service-delay-ms", value], {})).toThrow();
    }
    expect(() => parseBenchmarkScaleOptions(["--service-delay-ms"], {})).toThrow();
    expect(() => createBenchmarkService("benchmark-001", 0, secret, "light", -1)).toThrow();
  });
});