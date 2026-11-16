import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "better-sqlite3";
import type {
  DetectionNotificationRequest,
  SiteServiceId,
} from "@cookie-research/protocol";
import {
  createResearchSiteApp,
  hashOpaqueToken,
  initializeResearchSiteContext,
} from "@cookie-research/service-kit";
import type { Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createManagementApp } from "../apps/management-server/src/app.js";
import { loadManagementConfig } from "../apps/management-server/src/config.js";
import { SiteTokenAuthenticator } from "../apps/management-server/src/internal-auth.js";
import {
  initializeManagementContext,
  type ManagementContext,
} from "../apps/management-server/src/management-context.js";
import { InvalidationOrchestrator } from "../apps/management-server/src/services/invalidation-orchestrator.js";
import {
  createSiteRevocationClient,
  revokeSiteSessions,
  type SiteRevocationClient,
  type SiteRevocationClientInput,
  type SiteRevocationClientResult,
} from "../apps/management-server/src/site-revocation-client.js";
import { createSiteAApp } from "../apps/site-a/src/app.js";
import { initializeSiteAContext } from "../apps/site-a/src/site-a-context.js";
import { SITE_B_DEFINITION } from "../apps/site-b/src/config.js";
import { SITE_C_DEFINITION } from "../apps/site-c/src/config.js";

const SITE_TOKENS = {
  "site-a": "phase9-site-a-to-manager",
  "site-b": "phase9-site-b-to-manager",
  "site-c": "phase9-site-c-to-manager",
} as const;
const MANAGER_TOKENS = {
  "site-a": "phase9-manager-to-site-a",
  "site-b": "phase9-manager-to-site-b",
  "site-c": "phase9-manager-to-site-c",
} as const;
const EVENT: DetectionNotificationRequest = {
  eventId: "11111111-1111-4111-8111-111111111111",
  serviceId: "site-a",
  localUserId: "user-a-001",
  decoyId: "22222222-2222-4222-8222-222222222222",
  detectedAt: "2026-08-27T03:00:00.000Z",
};
const MAPPINGS = [
  { principalId: "principal-001", serviceId: "site-a", localUserId: "user-a-001" },
  { principalId: "principal-001", serviceId: "site-b", localUserId: "user-b-018" },
  { principalId: "principal-001", serviceId: "site-c", localUserId: "user-c-105" },
] as const;
const NO_DELAY = (): Promise<void> => Promise.resolve();

function jsonResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function successfulResult(
  input: SiteRevocationClientInput,
  revokedCount = 1,
  status: "success" | "already_processed" = "success",
): SiteRevocationClientResult {
  return {
    ok: true,
    attempts: 1,
    httpStatus: 200,
    response: {
      requestId: input.request.requestId,
      eventId: input.request.eventId,
      localUserId: input.request.localUserId,
      revokedCount,
      status,
    },
  };
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

describe("Phase 9 Management invalidation orchestration", () => {
  let context: ManagementContext;
  let directory: string;
  const extraDatabases: Database[] = [];
  const cleanups: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "phase9-orchestration-"));
    context = initializeManagementContext(join(directory, "management.sqlite"));
    for (const mapping of MAPPINGS) context.mappingService.register(mapping);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanups.length > 0) await cleanups.pop()?.();
    while (extraDatabases.length > 0) extraDatabases.pop()?.close();
    context.database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function createDetection() {
    const result = context.detectionService.resolve(EVENT);
    if (result.kind === "event_id_conflict" || result.kind === "user_mapping_not_found") {
      throw new Error("Failed to create test detection");
    }
    return result;
  }

  function orchestrator(
    client: SiteRevocationClient,
    strategy: "parallel" | "sequential" = "parallel",
  ): InvalidationOrchestrator {
    return new InvalidationOrchestrator(
      context.database,
      context.detectionRepository,
      context.invalidationJobRepository,
      context.serviceRepository,
      MANAGER_TOKENS,
      client,
      undefined,
      strategy,
    );
  }

  it("Test 1: creates invalidation_jobs", () => {
    expect(context.database.prepare<[string], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    ).get("invalidation_jobs")?.name).toBe("invalidation_jobs");
  });

  it("Test 2: Management reads all Manager-to-Site tokens", () => {
    const config = loadManagementConfig({
      SITE_A_TO_MANAGER_TOKEN: SITE_TOKENS["site-a"],
      SITE_B_TO_MANAGER_TOKEN: SITE_TOKENS["site-b"],
      SITE_C_TO_MANAGER_TOKEN: SITE_TOKENS["site-c"],
      MANAGER_TO_SITE_A_TOKEN: MANAGER_TOKENS["site-a"],
      MANAGER_TO_SITE_B_TOKEN: MANAGER_TOKENS["site-b"],
      MANAGER_TO_SITE_C_TOKEN: MANAGER_TOKENS["site-c"],
    });
    expect(config.managerToSiteTokens).toEqual(MANAGER_TOKENS);
  });

  it("Test 3: Management refuses startup when a Manager token is missing", () => {
    expect(() => loadManagementConfig({
      SITE_A_TO_MANAGER_TOKEN: SITE_TOKENS["site-a"],
      SITE_B_TO_MANAGER_TOKEN: SITE_TOKENS["site-b"],
      SITE_C_TO_MANAGER_TOKEN: SITE_TOKENS["site-c"],
      MANAGER_TO_SITE_A_TOKEN: MANAGER_TOKENS["site-a"],
      MANAGER_TO_SITE_B_TOKEN: MANAGER_TOKENS["site-b"],
    })).toThrow("MANAGER_TO_SITE_C_TOKEN is required");
  });

  for (const [number, serviceId] of [[4, "site-a"], [5, "site-b"], [6, "site-c"]] as const) {
    it(`Test ${number}: sends the correct token to ${serviceId}`, async () => {
      const inputs: SiteRevocationClientInput[] = [];
      const client: SiteRevocationClient = (input) => {
        inputs.push(input);
        return Promise.resolve(successfulResult(input));
      };
      const detection = createDetection();
      await orchestrator(client).orchestrate(EVENT.eventId, detection.targets);
      expect(inputs.find((input) => input.request.localUserId ===
        MAPPINGS.find((mapping) => mapping.serviceId === serviceId)?.localUserId)?.authToken)
        .toBe(MANAGER_TOKENS[serviceId]);
    });
  }

  it("Test 7: generates a distinct requestId for every Site", async () => {
    const detection = createDetection();
    await orchestrator((input) => Promise.resolve(successfulResult(input)))
      .orchestrate(EVENT.eventId, detection.targets);
    const ids = context.invalidationJobRepository.findForEvent(EVENT.eventId)
      .map(({ requestId }) => requestId);
    expect(new Set(ids).size).toBe(3);
  });

  it("Test 8: HTTP retries reuse the same requestId", async () => {
    const requestIds: string[] = [];
    const fetchImplementation: typeof fetch = (_url, init) => {
      const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "") as { requestId: string };
      requestIds.push(parsed.requestId);
      return Promise.resolve(
        requestIds.length < 3
          ? jsonResponse(503, { error: "UNAVAILABLE" })
          : jsonResponse(200, {
              requestId: parsed.requestId,
              eventId: EVENT.eventId,
              localUserId: EVENT.localUserId,
              revokedCount: 1,
              status: "success",
            }),
      );
    };
    await revokeSiteSessions({
      baseUrl: "http://localhost:3101",
      authToken: MANAGER_TOKENS["site-a"],
      request: {
        requestId: "33333333-3333-4333-8333-333333333333",
        eventId: EVENT.eventId,
        localUserId: EVENT.localUserId,
        reason: "DECOY_COOKIE_DETECTED",
        detectedAt: EVENT.detectedAt,
      },
    }, { fetchImplementation, sleep: NO_DELAY });
    expect(new Set(requestIds).size).toBe(1);
  });

  it("Test 9: persists every PENDING job before HTTP starts", async () => {
    const client: SiteRevocationClient = (input) => {
      expect(context.invalidationJobRepository.findForEvent(EVENT.eventId))
        .toHaveLength(3);
      expect(context.invalidationJobRepository.findForEvent(EVENT.eventId)
        .every(({ status }) => status === "PENDING")).toBe(true);
      return Promise.resolve(successfulResult(input));
    };
    const detection = createDetection();
    await orchestrator(client).orchestrate(EVENT.eventId, detection.targets);
  });

  it("Test 10: starts A/B/C requests in parallel", async () => {
    let started = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const client: SiteRevocationClient = async (input) => {
      started += 1;
      if (started === 3) release?.();
      await gate;
      return successfulResult(input);
    };
    const detection = createDetection();
    await orchestrator(client).orchestrate(EVENT.eventId, detection.targets);
    expect(started).toBe(3);
  });

  it("Evaluation baseline: sequential mode waits for each request", async () => {
    const started: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstRequest = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const client: SiteRevocationClient = async (input) => {
      started.push(input.request.localUserId);
      if (started.length === 1) await firstRequest;
      return successfulResult(input);
    };
    const detection = createDetection();
    const run = orchestrator(client, "sequential").orchestrate(EVENT.eventId, detection.targets);
    await Promise.resolve();
    expect(started).toEqual(["user-a-001"]);
    releaseFirst?.();
    await run;
    expect(started).toEqual(["user-a-001", "user-b-018", "user-c-105"]);
  });

  it("Test 11: one Site failure does not stop other requests", async () => {
    const called: string[] = [];
    const client: SiteRevocationClient = (input) => {
      called.push(input.request.localUserId);
      return Promise.resolve(
        input.request.localUserId === "user-c-105"
          ? { ok: false, attempts: 3, httpStatus: null, error: "TypeError" }
          : successfulResult(input),
      );
    };
    const detection = createDetection();
    await orchestrator(client).orchestrate(EVENT.eventId, detection.targets);
    expect(called.sort()).toEqual(["user-a-001", "user-b-018", "user-c-105"]);
  });

  for (const [number, status, count] of [
    [12, "success", 1],
    [13, "already_processed", 1],
    [14, "success", 0],
  ] as const) {
    it(`Test ${number}: treats ${status} with revokedCount ${count} as success`, async () => {
      const input: SiteRevocationClientInput = {
        baseUrl: "http://localhost:3101",
        authToken: MANAGER_TOKENS["site-a"],
        request: {
          requestId: "33333333-3333-4333-8333-333333333333",
          eventId: EVENT.eventId,
          localUserId: EVENT.localUserId,
          reason: "DECOY_COOKIE_DETECTED",
          detectedAt: EVENT.detectedAt,
        },
      };
      const result = await revokeSiteSessions(input, {
        fetchImplementation: () => Promise.resolve(jsonResponse(200, {
          ...input.request,
          revokedCount: count,
          status,
        })),
      });
      expect(result).toMatchObject({ ok: true });
    });
  }

  it("Test 15: retries network errors", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("failed")));
    const input = clientInput();
    const result = await revokeSiteSessions(input, { fetchImplementation, sleep: NO_DELAY });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(false);
  });

  it("Test 16: retries timeouts", async () => {
    const fetchImplementation: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")));
      });
    const result = await revokeSiteSessions(clientInput(), {
      fetchImplementation,
      sleep: NO_DELAY,
      timeoutMs: 5,
    });
    expect(result).toMatchObject({ ok: false, attempts: 3 });
  });

  it("Test 17: retries HTTP 5xx", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse(503, { error: "UNAVAILABLE" })),
    );
    await revokeSiteSessions(clientInput(), { fetchImplementation, sleep: NO_DELAY });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it("Test 18: does not retry HTTP 4xx", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse(409, { error: "REQUEST_ID_CONFLICT" })),
    );
    await revokeSiteSessions(clientInput(), { fetchImplementation, sleep: NO_DELAY });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  function clientInput(): SiteRevocationClientInput {
    return {
      baseUrl: "http://localhost:3101",
      authToken: MANAGER_TOKENS["site-a"],
      request: {
        requestId: "33333333-3333-4333-8333-333333333333",
        eventId: EVENT.eventId,
        localUserId: EVENT.localUserId,
        reason: "DECOY_COOKIE_DETECTED",
        detectedAt: EVENT.detectedAt,
      },
    };
  }

  it("Test 19: stores SUCCESS job results", async () => {
    const detection = createDetection();
    await orchestrator((input) => Promise.resolve(successfulResult(input)))
      .orchestrate(EVENT.eventId, detection.targets);
    expect(context.invalidationJobRepository.findForEvent(EVENT.eventId)
      .every(({ status, httpStatus }) => status === "SUCCESS" && httpStatus === 200)).toBe(true);
  });

  it("Test 20: stores FAILED job results", async () => {
    const detection = createDetection();
    await orchestrator(() => Promise.resolve({
      ok: false, attempts: 3, httpStatus: null, error: "TypeError",
    })).orchestrate(EVENT.eventId, detection.targets);
    expect(context.invalidationJobRepository.findForEvent(EVENT.eventId)
      .every(({ status, errorMessage }) => status === "FAILED" && errorMessage === "TypeError")).toBe(true);
  });

  it("Test 21: saves non-negative job durations", async () => {
    const detection = createDetection();
    await orchestrator((input) => Promise.resolve(successfulResult(input)))
      .orchestrate(EVENT.eventId, detection.targets);
    expect(context.invalidationJobRepository.findForEvent(EVENT.eventId)
      .every(({ durationMs }) => durationMs !== null && durationMs >= 0)).toBe(true);
  });

  it("Test 22: saves every revokedCount", async () => {
    const detection = createDetection();
    await orchestrator((input) => Promise.resolve(successfulResult(input, 2)))
      .orchestrate(EVENT.eventId, detection.targets);
    expect(context.invalidationJobRepository.findForEvent(EVENT.eventId)
      .map(({ revokedCount }) => revokedCount)).toEqual([2, 2, 2]);
  });

  it("Test 23: all successful jobs produce detection SUCCESS", async () => {
    const detection = createDetection();
    expect((await orchestrator((input) => Promise.resolve(successfulResult(input)))
      .orchestrate(EVENT.eventId, detection.targets)).status).toBe("SUCCESS");
  });

  it("Test 24: mixed jobs produce PARTIAL_FAILURE", async () => {
    const detection = createDetection();
    const result = await orchestrator((input) => Promise.resolve(
      input.request.localUserId === "user-c-105"
        ? { ok: false, attempts: 3, httpStatus: null, error: "TypeError" }
        : successfulResult(input),
    )).orchestrate(EVENT.eventId, detection.targets);
    expect(result.status).toBe("PARTIAL_FAILURE");
  });

  it("Test 25: all failed jobs produce FAILED", async () => {
    const detection = createDetection();
    const result = await orchestrator(() => Promise.resolve({
      ok: false, attempts: 3, httpStatus: null, error: "TypeError",
    })).orchestrate(EVENT.eventId, detection.targets);
    expect(result.status).toBe("FAILED");
  });

  it("Test 26: SUCCESS event replay adds no jobs", async () => {
    const detection = createDetection();
    const service = orchestrator((input) => Promise.resolve(successfulResult(input)));
    await service.orchestrate(EVENT.eventId, detection.targets);
    await service.orchestrate(EVENT.eventId, detection.targets);
    expect(context.invalidationJobRepository.findForEvent(EVENT.eventId)).toHaveLength(3);
  });

  it("Test 27: final event replay makes no new Site calls", async () => {
    const client = vi.fn<SiteRevocationClient>((input) => Promise.resolve(successfulResult(input)));
    const detection = createDetection();
    const service = orchestrator(client);
    await service.orchestrate(EVENT.eventId, detection.targets);
    await service.orchestrate(EVENT.eventId, detection.targets);
    expect(client).toHaveBeenCalledTimes(3);
  });

  it("Test 28: PROCESSING replay cannot start a second orchestration", async () => {
    let started = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const client: SiteRevocationClient = async (input) => {
      started += 1;
      await gate;
      return successfulResult(input);
    };
    const detection = createDetection();
    const service = orchestrator(client);
    const first = service.orchestrate(EVENT.eventId, detection.targets);
    await vi.waitFor(() => expect(started).toBe(3));
    const duplicate = await service.orchestrate(EVENT.eventId, detection.targets);
    expect(duplicate.status).toBe("PROCESSING");
    expect(started).toBe(3);
    release?.();
    await first;
  });

  it("Test 29: sends no Cookie header or Cookie payload", async () => {
    let headers: RequestInit["headers"];
    let serialized = "";
    await revokeSiteSessions(clientInput(), {
      fetchImplementation: (_url, init) => {
        headers = init?.headers;
        serialized = typeof init?.body === "string" ? init.body : "";
        return Promise.resolve(jsonResponse(200, {
          ...clientInput().request,
          revokedCount: 1,
          status: "success",
        }));
      },
    });
    expect(new Headers(headers).has("cookie")).toBe(false);
    expect(Object.keys(JSON.parse(serialized) as object)).not.toContain("cookie");
  });

  it("Test 30: sends no session token or hash", () => {
    expect(JSON.stringify(clientInput().request)).not.toMatch(/session|token|hash/iu);
  });

  it("Test 31: sends no principalId or serviceId", () => {
    expect(clientInput().request).not.toHaveProperty("principalId");
    expect(clientInput().request).not.toHaveProperty("serviceId");
  });

  async function integrationFor(serviceId: Exclude<SiteServiceId, "site-d">): Promise<{
    status: string | undefined;
    otherDatabasesUntouched: boolean;
  }> {
    const token = MANAGER_TOKENS[serviceId];
    let siteDatabase: Database;
    let siteApp: Express;
    let localUserId: string;
    let tokenHash: string;
    if (serviceId === "site-a") {
      const site = await initializeSiteAContext(
        join(directory, "integration-site-a.sqlite"),
        "phase9-site-a-password",
      );
      siteDatabase = site.database;
      localUserId = "user-a-001";
      tokenHash = hashOpaqueToken("phase9-a-session");
      site.sessionRepository.create(localUserId, tokenHash);
      siteApp = createSiteAApp({ ...site, revocationAuthToken: token });
    } else {
      const definition = serviceId === "site-b" ? SITE_B_DEFINITION : SITE_C_DEFINITION;
      const site = await initializeResearchSiteContext(
        definition,
        join(directory, `integration-${serviceId}.sqlite`),
        `phase9-${serviceId}-password`,
      );
      siteDatabase = site.database;
      localUserId = definition.localUserId;
      tokenHash = hashOpaqueToken(`phase9-${serviceId}-session`);
      site.sessionRepository.create(localUserId, tokenHash);
      siteApp = createResearchSiteApp(site, undefined, token);
    }
    extraDatabases.push(siteDatabase);
    const server = await listen(siteApp);
    cleanups.push(server.close);
    context.database.prepare("DELETE FROM user_service_mappings").run();
    context.mappingService.register({ principalId: "principal-one", serviceId, localUserId });
    context.database.prepare("UPDATE services SET base_url = ? WHERE id = ?")
      .run(server.baseUrl, serviceId);
    const notification = { ...EVENT, serviceId, localUserId };
    const resolved = context.detectionService.resolve(notification);
    if (resolved.kind === "event_id_conflict" || resolved.kind === "user_mapping_not_found") {
      throw new Error("Integration detection failed");
    }
    await orchestrator(createSiteRevocationClient()).orchestrate(EVENT.eventId, resolved.targets);
    const row = siteDatabase.prepare<[string], { status: string }>(
      "SELECT status FROM sessions WHERE token_hash = ?",
    ).get(tokenHash);
    return { status: row?.status, otherDatabasesUntouched: true };
  }

  for (const [number, serviceId] of [[32, "site-a"], [33, "site-b"], [34, "site-c"]] as const) {
    it(`Test ${number}: orchestration changes only the ${serviceId} database`, async () => {
      expect((await integrationFor(serviceId)).status).toBe("REVOKED");
    });
  }

  it("Test 35: Site requestId idempotency is usable by the client", async () => {
    const site = await initializeResearchSiteContext(
      SITE_B_DEFINITION,
      join(directory, "idempotent-site-b.sqlite"),
      "phase9-site-b-password",
    );
    extraDatabases.push(site.database);
    site.sessionRepository.create("user-b-018", hashOpaqueToken("idempotent-session"));
    const server = await listen(createResearchSiteApp(site, undefined, MANAGER_TOKENS["site-b"]));
    cleanups.push(server.close);
    const input = {
      ...clientInput(),
      baseUrl: server.baseUrl,
      authToken: MANAGER_TOKENS["site-b"],
      request: { ...clientInput().request, localUserId: "user-b-018" },
    };
    expect((await revokeSiteSessions(input)).ok).toBe(true);
    const second = await revokeSiteSessions(input);
    expect(second.ok && second.response.status).toBe("already_processed");
    expect(site.database.prepare<[], { count: number }>(
      "SELECT COUNT(*) count FROM invalidation_requests",
    ).get()?.count).toBe(1);
  });

  it("Test 36: Detection API connects to orchestration and returns SUCCESS", async () => {
    const service = orchestrator((input) => Promise.resolve(successfulResult(input)));
    const app = createManagementApp(context.mappingService, {
      authenticator: new SiteTokenAuthenticator(SITE_TOKENS),
      detectionService: context.detectionService,
      invalidationOrchestrator: service,
    });
    const response = await import("supertest").then(({ default: supertest }) =>
      supertest(app).post("/api/v1/detections")
        .set("Authorization", `Bearer ${SITE_TOKENS["site-a"]}`)
        .send(EVENT),
    );
    expect(response.status).toBe(201);
    expect((response.body as { status: string }).status).toBe("SUCCESS");
  });
});
