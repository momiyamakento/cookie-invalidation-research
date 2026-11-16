import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSiteDApp, SITE_D_USER } from "../apps/site-d/src/app.js";
import { initializeManagementContext } from "../apps/management-server/src/management-context.js";
import { InvalidationOrchestrator } from "../apps/management-server/src/services/invalidation-orchestrator.js";

const TOKEN = "phase11-manager-to-site-d";
const REVOCATION = {
  requestId: "11111111-1111-4111-8111-111111111111",
  eventId: "22222222-2222-4222-8222-222222222222",
  localUserId: SITE_D_USER.id,
  reason: "DECOY_COOKIE_DETECTED" as const,
  detectedAt: "2026-08-31T00:00:00.000Z",
};

describe("Phase 11 Site D service-kit adoption", () => {
  let directory: string;
  let site: Awaited<ReturnType<typeof createSiteDApp>>;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "phase11-site-d-"));
    site = await createSiteDApp(join(directory, "site-d.sqlite"), "site-d-test-password", TOKEN);
  });
  afterEach(() => { site.database.close(); rmSync(directory, { recursive: true, force: true }); });

  async function login(): Promise<string> {
    const response = await request(site.app).post("/login").type("form")
      .send({ username: SITE_D_USER.username, password: "site-d-test-password" }).expect(302);
    const value = response.get("Set-Cookie")?.find((header) => header.startsWith("sid_site_d="));
    if (value === undefined) throw new Error("Site D did not set a session cookie");
    return value.slice(0, value.indexOf(";"));
  }

  it("starts, logs in, and protects its independent access_grants session store", async () => {
    await request(site.app).get("/health").expect(200, { status: "ok", service: "site-d" });
    const cookie = await login();
    await request(site.app).get("/protected").set("Cookie", cookie).expect(200);
    expect(site.database.prepare("SELECT state FROM access_grants").get()).toMatchObject({ state: "OPEN" });
  });

  it("uses the common router: bad authentication is rejected before Site D's handler", async () => {
    await request(site.app).post("/internal/v1/sessions/revoke").set("Authorization", "Bearer wrong")
      .send(REVOCATION).expect(401);
    expect(site.database.prepare("SELECT COUNT(*) AS count FROM revocation_log").get()).toMatchObject({ count: 0 });
  });

  it("revokes Site D sessions and safely returns the first result on retry", async () => {
    const cookie = await login();
    const first = await request(site.app).post("/internal/v1/sessions/revoke")
      .set("Authorization", `Bearer ${TOKEN}`).send(REVOCATION).expect(200);
    expect(first.body).toMatchObject({ status: "success", revokedCount: 1 });
    await request(site.app).get("/protected").set("Cookie", cookie).expect(401);
    const retry = await request(site.app).post("/internal/v1/sessions/revoke")
      .set("Authorization", `Bearer ${TOKEN}`).send(REVOCATION).expect(200);
    expect(retry.body).toMatchObject({ status: "already_processed", revokedCount: 1 });
    expect(site.database.prepare("SELECT COUNT(*) AS count FROM revocation_log").get()).toMatchObject({ count: 1 });
  });

  it("adds Site D as a fourth parallel invalidation target for Site A detection", async () => {
    const management = initializeManagementContext(join(directory, "management.sqlite"));
    try {
      for (const mapping of [
        { serviceId: "site-a", localUserId: "user-a-001" },
        { serviceId: "site-b", localUserId: "user-b-018" },
        { serviceId: "site-c", localUserId: "user-c-105" },
        { serviceId: "site-d", localUserId: SITE_D_USER.id },
      ] as const) management.mappingService.register({ principalId: "principal-001", ...mapping });
      const detected = management.detectionService.resolve({
        eventId: "33333333-3333-4333-8333-333333333333", serviceId: "site-a", localUserId: "user-a-001",
        decoyId: "44444444-4444-4444-8444-444444444444", detectedAt: REVOCATION.detectedAt,
      });
      if (detected.kind !== "received" && detected.kind !== "already_received") {
        throw new Error("Detection mapping was not resolved");
      }
      const calls: string[] = [];
      const result = await new InvalidationOrchestrator(
        management.database, management.detectionRepository, management.invalidationJobRepository,
        management.serviceRepository,
        { "site-a": "a", "site-b": "b", "site-c": "c", "site-d": "d" },
        (input) => { calls.push(input.request.localUserId); return Promise.resolve({ ok: true as const, attempts: 1, httpStatus: 200 as const, response: { requestId: input.request.requestId, eventId: input.request.eventId, localUserId: input.request.localUserId, revokedCount: 1, status: "success" as const } }); },
      ).orchestrate("33333333-3333-4333-8333-333333333333", detected.targets);
      expect(calls).toHaveLength(4);
      expect(calls).toContain(SITE_D_USER.id);
      expect(result.status).toBe("SUCCESS");
    } finally { management.database.close(); }
  });
});
