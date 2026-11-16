import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DetectionNotificationRequest } from "@cookie-research/protocol";
import {
  createDetectionNotifier,
  sendDetectionNotification,
  type DetectionNotifier,
} from "@cookie-research/service-kit";
import type { Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createManagementApp } from "../apps/management-server/src/app.js";
import { loadManagementConfig } from "../apps/management-server/src/config.js";
import { SiteTokenAuthenticator } from "../apps/management-server/src/internal-auth.js";
import {
  initializeManagementContext,
  type ManagementContext,
} from "../apps/management-server/src/management-context.js";
import {
  createSiteAApp,
  DECOY_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "../apps/site-a/src/app.js";
import {
  EXPERIMENT_USER,
  initializeSiteAContext,
  type SiteAContext,
} from "../apps/site-a/src/site-a-context.js";
import { hashSessionToken } from "../apps/site-a/src/security/session-token.js";
import { loadSiteAConfig } from "../apps/site-a/src/config.js";

const TOKENS = {
  "site-a": "phase7-test-token-for-site-a",
  "site-b": "phase7-test-token-for-site-b",
  "site-c": "phase7-test-token-for-site-c",
} as const;
const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const DECOY_ID = "22222222-2222-4222-8222-222222222222";
const DETECTED_AT = "2026-08-22T05:00:00.000Z";
const SITE_A_NOTIFICATION: DetectionNotificationRequest = {
  eventId: EVENT_ID,
  serviceId: "site-a",
  localUserId: "user-a-001",
  decoyId: DECOY_ID,
  detectedAt: DETECTED_AT,
};
const MAPPINGS = [
  { principalId: "principal-001", serviceId: "site-a", localUserId: "user-a-001" },
  { principalId: "principal-001", serviceId: "site-b", localUserId: "user-b-018" },
  { principalId: "principal-001", serviceId: "site-c", localUserId: "user-c-105" },
] as const;
const TARGETS = MAPPINGS.map(({ serviceId, localUserId }) => ({
  serviceId,
  localUserId,
}));
const NO_DELAY = (): Promise<void> => Promise.resolve();

function authorization(serviceId: keyof typeof TOKENS): string {
  return `Bearer ${TOKENS[serviceId]}`;
}

function jsonResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function successBody(status: "received" | "already_received" = "received") {
  return {
    eventId: EVENT_ID,
    principalId: "principal-001",
    status,
    targets: TARGETS,
  };
}

function responseBody(response: { body: unknown }): Record<string, unknown> {
  const { body } = response;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Expected a JSON object response");
  }
  return body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string") throw new Error(`Expected ${name} to be a string`);
  return value;
}

function cookie(headers: string[] | undefined, name: string): string {
  const header = headers?.find((value) => value.startsWith(`${name}=`));
  if (header === undefined) throw new Error(`${name} was not set`);
  return header.slice(0, header.indexOf(";"));
}

function cookieValue(cookiePair: string): string {
  const separator = cookiePair.indexOf("=");
  return cookiePair.slice(separator + 1);
}

async function listen(app: Express): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => {
              if (error === undefined) closeResolve();
              else closeReject(error);
            });
          }),
      });
    });
    server.once("error", reject);
  });
}

describe("Phase 7 authenticated detection notification", () => {
  let app: Express;
  let context: ManagementContext;
  let directory: string;
  const cleanups: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "phase7-management-"));
    context = initializeManagementContext(join(directory, "management.sqlite"));
    for (const mapping of MAPPINGS) context.mappingService.register(mapping);
    app = createManagementApp(context.mappingService, {
      authenticator: new SiteTokenAuthenticator(TOKENS),
      detectionService: context.detectionService,
    });
  });

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
    context.database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function postDetection(
    body: object = SITE_A_NOTIFICATION,
    token = authorization("site-a"),
  ) {
    return await request(app)
      .post("/api/v1/detections")
      .set("Authorization", token)
      .send(body);
  }

  it("Test 1: creates the detection_events table", () => {
    const row = context.database
      .prepare<[string], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get("detection_events");
    expect(row?.name).toBe("detection_events");
  });

  it("Test 2: accepts a Site A event with the Site A token", async () => {
    expect((await postDetection()).status).toBe(201);
  });

  it("Test 3: accepts a Site B event with the Site B token", async () => {
    const response = await postDetection(
      { ...SITE_A_NOTIFICATION, serviceId: "site-b", localUserId: "user-b-018" },
      authorization("site-b"),
    );
    expect(response.status).toBe(201);
  });

  it("Test 4: accepts a Site C event with the Site C token", async () => {
    const response = await postDetection(
      { ...SITE_A_NOTIFICATION, serviceId: "site-c", localUserId: "user-c-105" },
      authorization("site-c"),
    );
    expect(response.status).toBe(201);
  });

  it("Test 5: rejects a missing Authorization header", async () => {
    await request(app).post("/api/v1/detections").send(SITE_A_NOTIFICATION).expect(401);
  });

  it("Test 6: rejects an invalid Bearer token", async () => {
    expect((await postDetection(SITE_A_NOTIFICATION, "Bearer invalid-token")).status).toBe(401);
  });

  it("Test 7: rejects Site B impersonation using the Site A token", async () => {
    expect((await postDetection({ ...SITE_A_NOTIFICATION, serviceId: "site-b" })).status).toBe(403);
  });

  it("Test 8: rejects Site C impersonation using the Site B token", async () => {
    const response = await postDetection(
      { ...SITE_A_NOTIFICATION, serviceId: "site-c" },
      authorization("site-b"),
    );
    expect(response.status).toBe(403);
  });

  it("Test 9: rejects a payload containing principalId", async () => {
    const response = await postDetection({ ...SITE_A_NOTIFICATION, principalId: "principal-001" });
    expect(response.status).toBe(400);
  });

  it("Test 10: resolves principalId from serviceId and localUserId", async () => {
    expect(responseBody(await postDetection()).principalId).toBe("principal-001");
  });

  it("Test 11: resolves site-a/user-a-001 to principal-001", async () => {
    await postDetection();
    expect(context.detectionRepository.findByEventId(EVENT_ID)?.principalId).toBe("principal-001");
  });

  it("Test 12: returns all three invalidation candidates", async () => {
    expect(responseBody(await postDetection()).targets).toEqual(TARGETS);
  });

  it("Test 13: returns targets in stable serviceId order", async () => {
    const targets = responseBody(await postDetection()).targets;
    if (!Array.isArray(targets)) throw new Error("Expected targets array");
    expect(
      targets.map((target: unknown) => {
        if (typeof target !== "object" || target === null || !("serviceId" in target)) {
          throw new Error("Expected target serviceId");
        }
        return target.serviceId;
      }),
    ).toEqual(["site-a", "site-b", "site-c"]);
  });

  it("Test 14: persists and exposes the resolved detection event", async () => {
    await postDetection();
    const response = await request(app).get(`/api/v1/detections/${EVENT_ID}`);
    expect(responseBody(response)).toMatchObject({
      eventId: EVENT_ID,
      sourceServiceId: "site-a",
      sourceLocalUserId: "user-a-001",
      principalId: "principal-001",
      decoyId: DECOY_ID,
      detectedAt: DETECTED_AT,
      status: "RESOLVED",
    });
  });

  it("Test 15: adds no Cookie, token, hash or password columns", () => {
    const sql = context.database
      .prepare<[string], { sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get("detection_events")?.sql.toLowerCase();
    expect(sql).not.toMatch(/cookie|token|hash|password/u);
  });

  it("Test 16: duplicate eventId does not add a row", async () => {
    await postDetection();
    await postDetection();
    const count = context.database.prepare<[], { count: number }>(
      "SELECT COUNT(*) AS count FROM detection_events",
    ).get()?.count;
    expect(count).toBe(1);
  });

  it("Test 17: identical eventId and payload returns already_received", async () => {
    await postDetection();
    const response = await postDetection();
    expect(response.status).toBe(200);
    expect(responseBody(response).status).toBe("already_received");
  });

  it("Test 18: conflicting content for an eventId returns 409", async () => {
    await postDetection();
    const response = await postDetection({ ...SITE_A_NOTIFICATION, decoyId: "33333333-3333-4333-8333-333333333333" });
    expect(response.status).toBe(409);
    expect(responseBody(response).error).toBe("EVENT_ID_CONFLICT");
  });

  it("Test 19: an unknown service user mapping returns 404 without saving", async () => {
    const response = await postDetection({ ...SITE_A_NOTIFICATION, localUserId: "unknown-user" });
    expect(response.status).toBe(404);
    expect(context.detectionRepository.findByEventId(EVENT_ID)).toBeUndefined();
  });

  it("Test 20: rejects an invalid eventId", async () => {
    expect((await postDetection({ ...SITE_A_NOTIFICATION, eventId: "not-a-uuid" })).status).toBe(400);
  });

  it("Test 21: rejects an invalid decoyId", async () => {
    expect((await postDetection({ ...SITE_A_NOTIFICATION, decoyId: "not-a-uuid" })).status).toBe(400);
  });

  it("Test 22: rejects an invalid detectedAt", async () => {
    expect((await postDetection({ ...SITE_A_NOTIFICATION, detectedAt: "not-a-date" })).status).toBe(400);
  });

  it("Test 23: Site client serializes exactly five payload fields", async () => {
    let serialized = "";
    const fetchImplementation: typeof fetch = (_input, init) => {
      serialized = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(jsonResponse(201, successBody()));
    };
    await sendDetectionNotification(
      { managementBaseUrl: "http://localhost:4100", authToken: TOKENS["site-a"], serviceId: "site-a" },
      { eventId: EVENT_ID, localUserId: "user-a-001", decoyId: DECOY_ID, detectedAt: DETECTED_AT },
      { fetchImplementation },
    );
    expect(Object.keys(JSON.parse(serialized) as object).sort()).toEqual([
      "decoyId", "detectedAt", "eventId", "localUserId", "serviceId",
    ]);
  });

  it("Test 24: Site notification payload has no principalId", () => {
    const body = JSON.stringify(SITE_A_NOTIFICATION);
    expect(body).not.toContain("principalId");
  });

  it("Test 25: Site notification payload has no Cookie", () => {
    expect(JSON.stringify(SITE_A_NOTIFICATION)).not.toMatch(/cookie|sid_site_/iu);
  });

  it("Test 26: Site notification payload has no session token or hash", () => {
    expect(JSON.stringify(SITE_A_NOTIFICATION)).not.toMatch(/session|token|hash/iu);
  });

  it("Test 27: Site notification payload has no decoy token or hash", () => {
    expect(Object.keys(SITE_A_NOTIFICATION)).toContain("decoyId");
    expect(JSON.stringify(SITE_A_NOTIFICATION)).not.toMatch(/decoyToken|tokenHash/iu);
  });

  async function createSiteA(notifier: DetectionNotifier): Promise<{
    site: SiteAContext;
    app: Express;
    sessionCookie: string;
    decoyCookie: string;
  }> {
    const siteDirectory = mkdtempSync(join(tmpdir(), "phase7-site-a-"));
    const site = await initializeSiteAContext(
      join(siteDirectory, "site-a.sqlite"),
      "phase7-site-a-password",
    );
    cleanups.push(() => {
      site.database.close();
      rmSync(siteDirectory, { recursive: true, force: true });
    });
    const siteApp = createSiteAApp({ ...site, detectionNotifier: notifier });
    const login = await request(siteApp)
      .post("/login")
      .type("form")
      .send({ username: EXPERIMENT_USER.username, password: "phase7-site-a-password" });
    return {
      site,
      app: siteApp,
      sessionCookie: cookie(login.get("Set-Cookie"), SESSION_COOKIE_NAME),
      decoyCookie: cookie(login.get("Set-Cookie"), DECOY_COOKIE_NAME),
    };
  }

  it("Test 28: first Site detection notifies Management Server", async () => {
    const management = await listen(app);
    cleanups.push(management.close);
    const notifier = createDetectionNotifier({
      managementBaseUrl: management.baseUrl,
      authToken: TOKENS["site-a"],
      serviceId: "site-a",
    });
    const site = await createSiteA(notifier);
    const detection = await request(site.app)
      .get("/__research/decoy-use")
      .set("Cookie", site.decoyCookie);
    const body = responseBody(detection);
    expect(body.notificationStatus).toBe("notified");
    expect(context.detectionRepository.findByEventId(stringField(body, "eventId"))).toBeDefined();
  });

  it("Test 29: local transaction is committed before notification starts", async () => {
    const holder: { site?: SiteAContext } = {};
    const notifier: DetectionNotifier = (event) => {
      expect(holder.site?.decoyRepository.findEventByDecoyId(event.decoyId)).toBeDefined();
      expect(holder.site?.decoyRepository.countDetectionEvents()).toBe(1);
      return Promise.resolve({ ok: true, status: "received", attempts: 1, response: successBody() });
    };
    const created = await createSiteA(notifier);
    holder.site = created.site;
    await request(created.app).get("/__research/decoy-use").set("Cookie", created.decoyCookie);
  });

  it("Test 30: regular session remains ACTIVE after successful notification", async () => {
    const notifier: DetectionNotifier = () => Promise.resolve({
      ok: true, status: "received", attempts: 1, response: successBody(),
    });
    const site = await createSiteA(notifier);
    await request(site.app).get("/__research/decoy-use").set("Cookie", site.decoyCookie);
    expect(site.site.sessionRepository.findByTokenHash(hashSessionToken(cookieValue(site.sessionCookie))))
      .toMatchObject({ status: "ACTIVE" });
  });

  it("Test 31: failed notification preserves the local event", async () => {
    const notifier: DetectionNotifier = () => Promise.resolve({
      ok: false, status: "unavailable", attempts: 3, error: "TypeError",
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const site = await createSiteA(notifier);
    const detection = await request(site.app).get("/__research/decoy-use").set("Cookie", site.decoyCookie);
    expect(responseBody(detection).notificationStatus).toBe("failed");
    expect(site.site.decoyRepository.countDetectionEvents()).toBe(1);
    error.mockRestore();
  });

  it("Test 32: network errors retry at most three times", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("failed")));
    const result = await sendDetectionNotification(
      { managementBaseUrl: "http://localhost:4100", authToken: TOKENS["site-a"], serviceId: "site-a" },
      { eventId: EVENT_ID, localUserId: "user-a-001", decoyId: DECOY_ID, detectedAt: DETECTED_AT },
      { fetchImplementation, sleep: NO_DELAY },
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ ok: false, status: "unavailable" });
  });

  it("Test 33: HTTP 5xx retries", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(503, { error: "UNAVAILABLE" }))
      .mockResolvedValueOnce(jsonResponse(201, successBody()));
    const result = await sendDetectionNotification(
      { managementBaseUrl: "http://localhost:4100", authToken: TOKENS["site-a"], serviceId: "site-a" },
      { eventId: EVENT_ID, localUserId: "user-a-001", decoyId: DECOY_ID, detectedAt: DETECTED_AT },
      { fetchImplementation, sleep: NO_DELAY },
    );
    expect(result).toMatchObject({ ok: true, attempts: 2 });
  });

  for (const status of [401, 403, 404, 409] as const) {
    const testNumber = { 401: 34, 403: 35, 404: 36, 409: 37 }[status];
    it(`Test ${testNumber}: HTTP ${status} does not retry`, async () => {
      const fetchImplementation = vi.fn<typeof fetch>(() =>
        Promise.resolve(jsonResponse(status, { error: "REJECTED" })),
      );
      await sendDetectionNotification(
        { managementBaseUrl: "http://localhost:4100", authToken: TOKENS["site-a"], serviceId: "site-a" },
        { eventId: EVENT_ID, localUserId: "user-a-001", decoyId: DECOY_ID, detectedAt: DETECTED_AT },
        { fetchImplementation, sleep: NO_DELAY },
      );
      expect(fetchImplementation).toHaveBeenCalledOnce();
    });
  }

  it("Test 38: repeated decoy use creates no new local event", async () => {
    const notifier = vi.fn<DetectionNotifier>(() => Promise.resolve({
      ok: true, status: "already_received", attempts: 1, response: successBody("already_received"),
    }));
    const site = await createSiteA(notifier);
    const first = await request(site.app).get("/__research/decoy-use").set("Cookie", site.decoyCookie);
    const second = await request(site.app).get("/__research/decoy-use").set("Cookie", site.decoyCookie);
    expect(responseBody(second).eventId).toBe(responseBody(first).eventId);
    expect(site.site.decoyRepository.countDetectionEvents()).toBe(1);
  });

  it("Test 39: repeated decoy use is idempotent at Management Server", async () => {
    const management = await listen(app);
    cleanups.push(management.close);
    const site = await createSiteA(createDetectionNotifier({
      managementBaseUrl: management.baseUrl,
      authToken: TOKENS["site-a"],
      serviceId: "site-a",
    }));
    const first = await request(site.app).get("/__research/decoy-use").set("Cookie", site.decoyCookie);
    const second = await request(site.app).get("/__research/decoy-use").set("Cookie", site.decoyCookie);
    expect(responseBody(second).eventId).toBe(responseBody(first).eventId);
    expect(responseBody(second).notificationStatus).toBe("notified");
    expect(context.database.prepare<[], { count: number }>(
      "SELECT COUNT(*) AS count FROM detection_events",
    ).get()?.count).toBe(1);
  });

  it("Test 40: mapping lookup is authenticated and scoped to the caller", async () => {
    const response = await request(app)
      .get("/api/v1/mappings/principal-001")
      .set("Authorization", authorization("site-a"));
    expect(response.status).toBe(200);
    expect(responseBody(response).services).toEqual([TARGETS[0]]);
  });

  it("refuses Management Server configuration when a Site token is missing", () => {
    expect(() =>
      loadManagementConfig({
        SITE_A_TO_MANAGER_TOKEN: TOKENS["site-a"],
        SITE_B_TO_MANAGER_TOKEN: TOKENS["site-b"],
      }),
    ).toThrow("SITE_C_TO_MANAGER_TOKEN is required");
  });

  it("refuses Site configuration when its notification token is missing", () => {
    expect(() =>
      loadSiteAConfig({
        MANAGEMENT_BASE_URL: "http://localhost:4100",
        MANAGER_TO_SITE_A_TOKEN: "manager-test-site-a-token",
        SITE_A_PRINCIPAL_ID: "principal-001",
        SITE_A_SEED_PASSWORD: "phase7-site-a-password",
      }),
    ).toThrow("SITE_A_TO_MANAGER_TOKEN is required");
  });
});
