import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "better-sqlite3";
import type { SessionRevocationRequest } from "@cookie-research/protocol";
import {
  createResearchSiteApp,
  hashOpaqueToken,
  initializeResearchSiteContext,
  type DetectionNotifier,
} from "@cookie-research/service-kit";
import type { Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSiteAApp,
  DECOY_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "../apps/site-a/src/app.js";
import { loadSiteAConfig } from "../apps/site-a/src/config.js";
import { initializeSiteAContext } from "../apps/site-a/src/site-a-context.js";
import { SITE_B_DEFINITION } from "../apps/site-b/src/config.js";
import { SITE_C_DEFINITION } from "../apps/site-c/src/config.js";

const TOKENS = {
  a: "phase8-manager-to-site-a-token",
  b: "phase8-manager-to-site-b-token",
  c: "phase8-manager-to-site-c-token",
} as const;
const REVOCATION: SessionRevocationRequest = {
  requestId: "11111111-1111-4111-8111-111111111111",
  eventId: "22222222-2222-4222-8222-222222222222",
  localUserId: "user-a-001",
  reason: "DECOY_COOKIE_DETECTED",
  detectedAt: "2026-08-22T06:00:00.000Z",
};

interface SessionAccess {
  create: (userId: string, tokenHash: string) => unknown;
  findByTokenHash: (tokenHash: string) =>
    | { status: "ACTIVE" | "REVOKED"; revokedAt: string | null }
    | undefined;
  revokeActiveByTokenHash: (tokenHash: string) => boolean;
}

interface SiteFixture {
  app: Express;
  cookieName: string;
  database: Database;
  localUserId: string;
  password: string;
  sessionRepository: SessionAccess;
  username: string;
}

function cookie(headers: string[] | undefined, name: string): string {
  const header = headers?.find((value) => value.startsWith(`${name}=`));
  if (header === undefined) throw new Error(`${name} was not set`);
  return header.slice(0, header.indexOf(";"));
}

function cookieValue(pair: string): string {
  return pair.slice(pair.indexOf("=") + 1);
}

function body(response: { body: unknown }): Record<string, unknown> {
  if (
    typeof response.body !== "object" ||
    response.body === null ||
    Array.isArray(response.body)
  ) {
    throw new Error("Expected a JSON object");
  }
  return response.body as Record<string, unknown>;
}

describe("Phase 8 per-Site session revocation API", () => {
  let directory: string;
  const databases: Database[] = [];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "phase8-revocation-"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    while (databases.length > 0) databases.pop()?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function siteA(token = TOKENS.a): Promise<SiteFixture> {
    const context = await initializeSiteAContext(
      join(directory, `site-a-${databases.length}.sqlite`),
      "phase8-site-a-password",
    );
    databases.push(context.database);
    return {
      app: createSiteAApp({ ...context, revocationAuthToken: token }),
      cookieName: SESSION_COOKIE_NAME,
      database: context.database,
      localUserId: "user-a-001",
      password: "phase8-site-a-password",
      sessionRepository: context.sessionRepository,
      username: "alice-a",
    };
  }

  async function siteB(token = TOKENS.b): Promise<SiteFixture> {
    const context = await initializeResearchSiteContext(
      SITE_B_DEFINITION,
      join(directory, `site-b-${databases.length}.sqlite`),
      "phase8-site-b-password",
    );
    databases.push(context.database);
    return {
      app: createResearchSiteApp(context, undefined, token),
      cookieName: "sid_site_b",
      database: context.database,
      localUserId: "user-b-018",
      password: "phase8-site-b-password",
      sessionRepository: context.sessionRepository,
      username: "alice-b",
    };
  }

  async function siteC(token = TOKENS.c): Promise<SiteFixture> {
    const context = await initializeResearchSiteContext(
      SITE_C_DEFINITION,
      join(directory, `site-c-${databases.length}.sqlite`),
      "phase8-site-c-password",
    );
    databases.push(context.database);
    return {
      app: createResearchSiteApp(context, undefined, token),
      cookieName: "sid_site_c",
      database: context.database,
      localUserId: "user-c-105",
      password: "phase8-site-c-password",
      sessionRepository: context.sessionRepository,
      username: "alice-c",
    };
  }

  async function login(site: SiteFixture): Promise<string> {
    const response = await request(site.app)
      .post("/login")
      .type("form")
      .send({ username: site.username, password: site.password });
    return cookie(response.get("Set-Cookie"), site.cookieName);
  }

  async function revoke(
    site: SiteFixture,
    payload: object = { ...REVOCATION, localUserId: site.localUserId },
    token: string = TOKENS.a,
  ) {
    return await request(site.app)
      .post("/internal/v1/sessions/revoke")
      .set("Authorization", `Bearer ${token}`)
      .send(payload);
  }

  function tableExists(database: Database): boolean {
    return (
      database
        .prepare<[string], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        )
        .get("invalidation_requests")?.name === "invalidation_requests"
    );
  }

  it("Test 1: Site A creates invalidation_requests", async () => {
    expect(tableExists((await siteA()).database)).toBe(true);
  });

  it("Test 2: Site B creates invalidation_requests", async () => {
    expect(tableExists((await siteB()).database)).toBe(true);
  });

  it("Test 3: Site C creates invalidation_requests", async () => {
    expect(tableExists((await siteC()).database)).toBe(true);
  });

  it("Test 4: missing Authorization is 401", async () => {
    const site = await siteA();
    await request(site.app).post("/internal/v1/sessions/revoke").send(REVOCATION).expect(401);
  });

  it("Test 5: invalid Manager token is 401", async () => {
    expect((await revoke(await siteA(), REVOCATION, "invalid-token")).status).toBe(401);
  });

  it("Test 6: Site A accepts only its configured token", async () => {
    const site = await siteA();
    expect((await revoke(site, REVOCATION, TOKENS.a)).status).toBe(200);
    expect((await revoke(site, { ...REVOCATION, requestId: "33333333-3333-4333-8333-333333333333" }, TOKENS.b)).status).toBe(401);
  });

  it("Test 7: Site B accepts only its configured token", async () => {
    const site = await siteB();
    expect((await revoke(site, { ...REVOCATION, localUserId: site.localUserId }, TOKENS.b)).status).toBe(200);
    expect((await revoke(site, REVOCATION, TOKENS.c)).status).toBe(401);
  });

  it("Test 8: Site C accepts only its configured token", async () => {
    const site = await siteC();
    expect((await revoke(site, { ...REVOCATION, localUserId: site.localUserId }, TOKENS.c)).status).toBe(200);
    expect((await revoke(site, REVOCATION, TOKENS.a)).status).toBe(401);
  });

  it("Test 9: Site A token is rejected by Site B", async () => {
    expect((await revoke(await siteB(), REVOCATION, TOKENS.a)).status).toBe(401);
  });

  it("Test 10: Site B token is rejected by Site C", async () => {
    expect((await revoke(await siteC(), REVOCATION, TOKENS.b)).status).toBe(401);
  });

  it("Test 11: invalid requestId is 400", async () => {
    expect((await revoke(await siteA(), { ...REVOCATION, requestId: "invalid" })).status).toBe(400);
  });

  it("Test 12: invalid eventId is 400", async () => {
    expect((await revoke(await siteA(), { ...REVOCATION, eventId: "invalid" })).status).toBe(400);
  });

  it("Test 13: invalid reason is 400", async () => {
    expect((await revoke(await siteA(), { ...REVOCATION, reason: "OTHER" })).status).toBe(400);
  });

  it("Test 14: invalid detectedAt is 400", async () => {
    expect((await revoke(await siteA(), { ...REVOCATION, detectedAt: "invalid" })).status).toBe(400);
  });

  it("Test 15: missing local user is 404 and is not recorded", async () => {
    const site = await siteA();
    const response = await revoke(site, { ...REVOCATION, localUserId: "user-x-999" });
    expect(response.status).toBe(404);
    expect(site.database.prepare<[], { count: number }>(
      "SELECT COUNT(*) count FROM invalidation_requests",
    ).get()?.count).toBe(0);
  });

  it("Test 16: revokes one ACTIVE session", async () => {
    const site = await siteA();
    const sid = await login(site);
    await revoke(site);
    expect(site.sessionRepository.findByTokenHash(hashOpaqueToken(cookieValue(sid)))?.status).toBe("REVOKED");
  });

  it("Test 17: revokes every ACTIVE session for the user", async () => {
    const site = await siteB();
    const hashes = ["active-one", "active-two", "active-three"].map(hashOpaqueToken);
    for (const hash of hashes) site.sessionRepository.create(site.localUserId, hash);
    await revoke(site, { ...REVOCATION, localUserId: site.localUserId }, TOKENS.b);
    expect(hashes.map((hash) => site.sessionRepository.findByTokenHash(hash)?.status)).toEqual([
      "REVOKED", "REVOKED", "REVOKED",
    ]);
  });

  it("Test 18: sets revoked_at on all invalidated sessions", async () => {
    const site = await siteB();
    const hashes = ["revoked-at-one", "revoked-at-two"].map(hashOpaqueToken);
    for (const hash of hashes) site.sessionRepository.create(site.localUserId, hash);
    await revoke(site, { ...REVOCATION, localUserId: site.localUserId }, TOKENS.b);
    expect(hashes.every((hash) => site.sessionRepository.findByTokenHash(hash)?.revokedAt !== null)).toBe(true);
  });

  it("Test 19: does not modify an already REVOKED session", async () => {
    const site = await siteA();
    const hash = hashOpaqueToken("already-revoked");
    site.sessionRepository.create(site.localUserId, hash);
    site.sessionRepository.revokeActiveByTokenHash(hash);
    const before = site.sessionRepository.findByTokenHash(hash)?.revokedAt;
    await revoke(site);
    expect(site.sessionRepository.findByTokenHash(hash)?.revokedAt).toBe(before);
  });

  it("Test 20: revokedCount equals the changed row count", async () => {
    const site = await siteC();
    for (const token of ["one", "two"]) {
      site.sessionRepository.create(site.localUserId, hashOpaqueToken(token));
    }
    const response = await revoke(site, { ...REVOCATION, localUserId: site.localUserId }, TOKENS.c);
    expect(body(response).revokedCount).toBe(2);
  });

  it("Test 21: zero ACTIVE sessions is successful", async () => {
    const response = await revoke(await siteA());
    expect(response.status).toBe(200);
    expect(body(response)).toMatchObject({ status: "success", revokedCount: 0 });
  });

  it("Test 22: a previously saved regular Cookie is rejected", async () => {
    const site = await siteA();
    const sid = await login(site);
    await request(site.app).get("/protected").set("Cookie", sid).expect(200);
    await revoke(site);
    await request(site.app).get("/protected").set("Cookie", sid).expect(401);
  });

  it("Test 23: revocation response does not delete a Cookie", async () => {
    const response = await revoke(await siteA());
    expect(response.get("Set-Cookie")).toBeUndefined();
  });

  it("Test 24: decoy_sessions is unchanged", async () => {
    const site = await siteA();
    await login(site);
    const before = site.database.prepare("SELECT * FROM decoy_sessions").all();
    await revoke(site);
    expect(site.database.prepare("SELECT * FROM decoy_sessions").all()).toEqual(before);
  });

  it("Test 25: local_detection_events is unchanged", async () => {
    const site = await siteA();
    const before = site.database.prepare("SELECT * FROM local_detection_events").all();
    await revoke(site);
    expect(site.database.prepare("SELECT * FROM local_detection_events").all()).toEqual(before);
  });

  it("Test 26: saves the request information and first revokedCount", async () => {
    const site = await siteA();
    await login(site);
    await revoke(site);
    expect(site.database.prepare<[], Record<string, unknown>>(
      "SELECT request_id, event_id, user_id, reason, detected_at, received_at, revoked_count FROM invalidation_requests",
    ).get()).toMatchObject({
      request_id: REVOCATION.requestId,
      event_id: REVOCATION.eventId,
      user_id: REVOCATION.localUserId,
      reason: REVOCATION.reason,
      detected_at: REVOCATION.detectedAt,
      revoked_count: 1,
    });
  });

  it("Test 27: identical requestId retry adds no row", async () => {
    const site = await siteA();
    await revoke(site);
    await revoke(site);
    expect(site.database.prepare<[], { count: number }>(
      "SELECT COUNT(*) count FROM invalidation_requests",
    ).get()?.count).toBe(1);
  });

  it("Test 28: retry returns the first revokedCount", async () => {
    const site = await siteA();
    await login(site);
    const first = await revoke(site);
    const second = await revoke(site);
    expect(body(first).revokedCount).toBe(1);
    expect(body(second)).toMatchObject({ status: "already_processed", revokedCount: 1 });
  });

  it("Test 29: changed eventId for requestId is 409", async () => {
    const site = await siteA();
    await revoke(site);
    expect((await revoke(site, { ...REVOCATION, eventId: "33333333-3333-4333-8333-333333333333" })).status).toBe(409);
  });

  it("Test 30: changed localUserId for requestId is 409", async () => {
    const site = await siteA();
    await revoke(site);
    expect((await revoke(site, { ...REVOCATION, localUserId: "other-user" })).status).toBe(409);
  });

  it("Test 31: changed detectedAt for requestId is 409", async () => {
    const site = await siteA();
    await revoke(site);
    expect((await revoke(site, { ...REVOCATION, detectedAt: "2026-08-22T06:01:00.000Z" })).status).toBe(409);
  });

  it("Test 32: session update rolls back when request INSERT fails", async () => {
    const site = await siteA();
    const sid = await login(site);
    site.database.exec(`CREATE TRIGGER force_invalidation_failure
      BEFORE INSERT ON invalidation_requests BEGIN
        SELECT RAISE(ABORT, 'forced failure');
      END`);
    expect((await revoke(site)).status).toBe(500);
    expect(site.sessionRepository.findByTokenHash(hashOpaqueToken(cookieValue(sid)))?.status).toBe("ACTIVE");
    expect(site.database.prepare<[], { count: number }>(
      "SELECT COUNT(*) count FROM invalidation_requests",
    ).get()?.count).toBe(0);
  });

  async function isolatedSites() {
    const a = await siteA();
    const b = await siteB();
    const c = await siteC();
    const hashes = {
      a: hashOpaqueToken("isolated-a"),
      b: hashOpaqueToken("isolated-b"),
      c: hashOpaqueToken("isolated-c"),
    };
    a.sessionRepository.create(a.localUserId, hashes.a);
    b.sessionRepository.create(b.localUserId, hashes.b);
    c.sessionRepository.create(c.localUserId, hashes.c);
    return { a, b, c, hashes };
  }

  it("Test 33: Site A API changes only Site A", async () => {
    const sites = await isolatedSites();
    await revoke(sites.a);
    expect([sites.a, sites.b, sites.c].map((site, index) =>
      site.sessionRepository.findByTokenHash([sites.hashes.a, sites.hashes.b, sites.hashes.c][index] ?? "")?.status,
    )).toEqual(["REVOKED", "ACTIVE", "ACTIVE"]);
  });

  it("Test 34: Site B API changes only Site B", async () => {
    const sites = await isolatedSites();
    await revoke(sites.b, { ...REVOCATION, localUserId: sites.b.localUserId }, TOKENS.b);
    expect(sites.a.sessionRepository.findByTokenHash(sites.hashes.a)?.status).toBe("ACTIVE");
    expect(sites.b.sessionRepository.findByTokenHash(sites.hashes.b)?.status).toBe("REVOKED");
    expect(sites.c.sessionRepository.findByTokenHash(sites.hashes.c)?.status).toBe("ACTIVE");
  });

  it("Test 35: Site C API changes only Site C", async () => {
    const sites = await isolatedSites();
    await revoke(sites.c, { ...REVOCATION, localUserId: sites.c.localUserId }, TOKENS.c);
    expect(sites.a.sessionRepository.findByTokenHash(sites.hashes.a)?.status).toBe("ACTIVE");
    expect(sites.b.sessionRepository.findByTokenHash(sites.hashes.b)?.status).toBe("ACTIVE");
    expect(sites.c.sessionRepository.findByTokenHash(sites.hashes.c)?.status).toBe("REVOKED");
  });

  it("Test 36: payload requires no Cookie", async () => {
    expect((await revoke(await siteA())).status).toBe(200);
    expect(Object.keys(REVOCATION)).not.toContain("cookie");
    expect(Object.keys(REVOCATION)).not.toContain("cookieHeader");
    expect(JSON.stringify(REVOCATION)).not.toMatch(/sid_site_/iu);
  });

  it("Test 37: payload requires no session token or hash", async () => {
    expect(JSON.stringify(REVOCATION)).not.toMatch(/session|token|hash/iu);
    expect((await revoke(await siteA(), {
      ...REVOCATION,
      sessionToken: "must-not-be-accepted",
    })).status).toBe(400);
  });

  it("Test 38: payload requires no principalId or serviceId", async () => {
    expect(REVOCATION).not.toHaveProperty("principalId");
    expect(REVOCATION).not.toHaveProperty("serviceId");
    expect((await revoke(await siteA(), { ...REVOCATION, principalId: "principal-001" })).status).toBe(400);
  });

  it("Test 39: Phase 7 detection notification still runs", async () => {
    const notifier = vi.fn<DetectionNotifier>(() => Promise.resolve({
      ok: true,
      status: "received",
      attempts: 1,
      response: {
        eventId: REVOCATION.eventId,
        principalId: "principal-001",
        status: "received",
        targets: [],
      },
    }));
    const context = await initializeSiteAContext(
      join(directory, "site-a-phase7-regression.sqlite"),
      "phase8-site-a-password",
    );
    databases.push(context.database);
    const app = createSiteAApp({
      ...context,
      detectionNotifier: notifier,
      revocationAuthToken: TOKENS.a,
    });
    const loginResponse = await request(app).post("/login").type("form").send({
      username: "alice-a",
      password: "phase8-site-a-password",
    });
    const decoy = cookie(loginResponse.get("Set-Cookie"), DECOY_COOKIE_NAME);
    const detection = await request(app).get("/__research/decoy-use").set("Cookie", decoy);
    expect(body(detection).notificationStatus).toBe("notified");
    expect(notifier).toHaveBeenCalledOnce();
  });

  it("Test 40: health and login from prior phases remain available", async () => {
    const site = await siteA();
    await request(site.app).get("/health").expect(200);
    const sid = await login(site);
    await request(site.app).get("/protected").set("Cookie", sid).expect(200);
  });

  it("rejects Site startup configuration without its Manager token", () => {
    expect(() => loadSiteAConfig({
      MANAGEMENT_BASE_URL: "http://localhost:4100",
      SITE_A_PRINCIPAL_ID: "principal-001",
      SITE_A_SEED_PASSWORD: "phase8-site-a-password",
      SITE_A_TO_MANAGER_TOKEN: "site-a-to-manager-token",
    })).toThrow("MANAGER_TO_SITE_A_TOKEN is required");
  });
});
