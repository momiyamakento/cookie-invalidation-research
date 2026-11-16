import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createResearchSiteApp,
  initializeResearchSiteContext,
  registerServiceMapping,
  type MappingRegistrationInput,
} from "@cookie-research/service-kit";
import type { Express } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createManagementApp } from "../apps/management-server/src/app.js";
import { SiteTokenAuthenticator } from "../apps/management-server/src/internal-auth.js";
import {
  initializeManagementContext,
  type ManagementContext,
} from "../apps/management-server/src/management-context.js";
import { loadSiteAConfig } from "../apps/site-a/src/config.js";
import { EXPERIMENT_USER } from "../apps/site-a/src/site-a-context.js";
import {
  loadSiteBConfig,
  SITE_B_DEFINITION,
} from "../apps/site-b/src/config.js";
import {
  loadSiteCConfig,
  SITE_C_DEFINITION,
} from "../apps/site-c/src/config.js";

const MANAGEMENT_BASE_URL = "http://localhost:4100";
const PRINCIPAL_ID = "principal-001";
const BASE_INPUT: MappingRegistrationInput = {
  authToken: "site-a-test-manager-token",
  managementBaseUrl: MANAGEMENT_BASE_URL,
  principalId: PRINCIPAL_ID,
  serviceId: "site-a",
  localUserId: "user-a-001",
};
const NO_DELAY = (): Promise<void> => Promise.resolve();

function jsonResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function captureFetch(
  bodies: string[],
  response = jsonResponse(201, { status: "registered" }),
): typeof fetch {
  const implementation: typeof fetch = (_input, init) => {
    if (typeof init?.body !== "string") {
      return Promise.reject(new Error("Expected a serialized JSON body"));
    }
    bodies.push(init.body);
    return Promise.resolve(response);
  };
  return implementation;
}

function parseBody(body: string): Record<string, unknown> {
  const parsed = JSON.parse(body) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected an object payload");
  }
  return parsed as Record<string, unknown>;
}

async function serializedPayload(): Promise<string> {
  const bodies: string[] = [];
  await registerServiceMapping(BASE_INPUT, {
    fetchImplementation: captureFetch(bodies),
  });
  const body = bodies[0];
  if (body === undefined) {
    throw new Error("Mapping body was not captured");
  }
  return body;
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
        close: async () =>
          await new Promise<void>((closeResolve, closeReject) => {
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

describe("Phase 6 startup mapping registration", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("Test 1: Site A generates its configured mapping payload", async () => {
    const config = loadSiteAConfig({
      MANAGEMENT_BASE_URL,
      MANAGER_TO_SITE_A_TOKEN: "manager-test-site-a-token",
      SITE_A_PRINCIPAL_ID: PRINCIPAL_ID,
      SITE_A_TO_MANAGER_TOKEN: "site-a-test-manager-token",
      SITE_A_SEED_PASSWORD: "site-a-phase6-password",
    });
    const bodies: string[] = [];
    await registerServiceMapping(
      {
        authToken: config.detectionAuthToken,
        managementBaseUrl: config.managementBaseUrl,
        principalId: config.principalId,
        serviceId: "site-a",
        localUserId: EXPERIMENT_USER.id,
      },
      { fetchImplementation: captureFetch(bodies) },
    );

    expect(parseBody(bodies[0] ?? "")).toEqual({
      principalId: "principal-001",
      serviceId: "site-a",
      localUserId: "user-a-001",
    });
  });

  it("Test 2: Site B sends its own mapping", async () => {
    const config = loadSiteBConfig({
      MANAGEMENT_BASE_URL,
      MANAGER_TO_SITE_B_TOKEN: "manager-test-site-b-token",
      SITE_B_PRINCIPAL_ID: PRINCIPAL_ID,
      SITE_B_TO_MANAGER_TOKEN: "site-b-test-manager-token",
      SITE_B_SEED_PASSWORD: "site-b-phase6-password",
    });
    const bodies: string[] = [];
    await registerServiceMapping(
      {
        authToken: config.detectionAuthToken,
        managementBaseUrl: config.managementBaseUrl,
        principalId: config.principalId,
        serviceId: SITE_B_DEFINITION.component.id,
        localUserId: SITE_B_DEFINITION.localUserId,
      },
      { fetchImplementation: captureFetch(bodies) },
    );

    expect(parseBody(bodies[0] ?? "")).toEqual({
      principalId: "principal-001",
      serviceId: "site-b",
      localUserId: "user-b-018",
    });
  });

  it("Test 3: Site C sends its own mapping", async () => {
    const config = loadSiteCConfig({
      MANAGEMENT_BASE_URL,
      MANAGER_TO_SITE_C_TOKEN: "manager-test-site-c-token",
      SITE_C_PRINCIPAL_ID: PRINCIPAL_ID,
      SITE_C_TO_MANAGER_TOKEN: "site-c-test-manager-token",
      SITE_C_SEED_PASSWORD: "site-c-phase6-password",
    });
    const bodies: string[] = [];
    await registerServiceMapping(
      {
        authToken: config.detectionAuthToken,
        managementBaseUrl: config.managementBaseUrl,
        principalId: config.principalId,
        serviceId: SITE_C_DEFINITION.component.id,
        localUserId: SITE_C_DEFINITION.localUserId,
      },
      { fetchImplementation: captureFetch(bodies) },
    );

    expect(parseBody(bodies[0] ?? "")).toEqual({
      principalId: "principal-001",
      serviceId: "site-c",
      localUserId: "user-c-105",
    });
  });

  it("Test 4: treats 201 registered as success", async () => {
    const result = await registerServiceMapping(BASE_INPUT, {
      fetchImplementation: () =>
        Promise.resolve(jsonResponse(201, { status: "registered" })),
    });
    expect(result).toEqual({ ok: true, status: "registered", attempts: 1 });
  });

  it("Test 5: treats 200 already_registered as success", async () => {
    const result = await registerServiceMapping(BASE_INPUT, {
      fetchImplementation: () =>
        Promise.resolve(jsonResponse(200, { status: "already_registered" })),
    });
    expect(result).toEqual({
      ok: true,
      status: "already_registered",
      attempts: 1,
    });
  });

  it("Test 6: repeated startup registration leaves one mapping row", async () => {
    const directory = mkdtempSync(join(tmpdir(), "phase6-management-"));
    const context: ManagementContext = initializeManagementContext(
      join(directory, "management.sqlite"),
    );
    const management = await listen(
      createManagementApp(context.mappingService, {
        authenticator: new SiteTokenAuthenticator({
          "site-a": BASE_INPUT.authToken,
        }),
      }),
    );
    cleanups.push(async () => {
      await management.close();
      context.database.close();
      rmSync(directory, { recursive: true, force: true });
    });

    const input = { ...BASE_INPUT, managementBaseUrl: management.baseUrl };
    expect((await registerServiceMapping(input)).status).toBe("registered");
    expect((await registerServiceMapping(input)).status).toBe(
      "already_registered",
    );
    const row = context.database
      .prepare<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM user_service_mappings",
      )
      .get();
    expect(row?.count).toBe(1);
  });

  it("Test 7: retries a stopped Management Server exactly three times", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.reject(new TypeError("fetch failed")),
    );
    const result = await registerServiceMapping(BASE_INPUT, {
      fetchImplementation,
      sleep: NO_DELAY,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ ok: false, status: "unavailable", attempts: 3 });
  });

  it("Test 8: Site HTTP remains healthy after registration exhausts retries", async () => {
    const directory = mkdtempSync(join(tmpdir(), "phase6-site-b-"));
    const context = await initializeResearchSiteContext(
      SITE_B_DEFINITION,
      join(directory, "site-b.sqlite"),
      "site-b-phase6-password",
    );
    const site = await listen(createResearchSiteApp(context));
    cleanups.push(async () => {
      await site.close();
      context.database.close();
      rmSync(directory, { recursive: true, force: true });
    });

    await registerServiceMapping(BASE_INPUT, {
      fetchImplementation: () =>
        Promise.reject(new TypeError("fetch failed")),
      sleep: NO_DELAY,
    });
    const response = await fetch(`${site.baseUrl}/health`);
    expect(response.status).toBe(200);
  });

  it("Test 9: retries HTTP 5xx and then accepts success", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(503, { error: "UNAVAILABLE" }))
      .mockResolvedValueOnce(jsonResponse(500, { error: "UNAVAILABLE" }))
      .mockResolvedValueOnce(jsonResponse(201, { status: "registered" }));
    const result = await registerServiceMapping(BASE_INPUT, {
      fetchImplementation,
      sleep: NO_DELAY,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ ok: true, status: "registered", attempts: 3 });
  });

  it("Test 10: does not retry HTTP 400", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        jsonResponse(400, { error: "INVALID_MAPPING_REQUEST" }),
      ),
    );
    const result = await registerServiceMapping(BASE_INPUT, {
      fetchImplementation,
      sleep: NO_DELAY,
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, status: "rejected", httpStatus: 400 });
  });

  it("Test 11: does not retry HTTP 409", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse(409, { error: "MAPPING_CONFLICT" })),
    );
    const result = await registerServiceMapping(BASE_INPUT, {
      fetchImplementation,
      sleep: NO_DELAY,
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, status: "rejected", httpStatus: 409 });
  });

  it("Test 12: sends a Bearer credential but no Cookie header", async () => {
    let capturedHeaders: RequestInit["headers"];
    let capturedBody = "";
    const fetchImplementation: typeof fetch = (_input, init) => {
      capturedHeaders = init?.headers;
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(jsonResponse(201, { status: "registered" }));
    };
    await registerServiceMapping(BASE_INPUT, {
      fetchImplementation,
    });
    const headers = new Headers(capturedHeaders);
    expect(headers.has("cookie")).toBe(false);
    expect(headers.get("authorization")).toBe(`Bearer ${BASE_INPUT.authToken}`);
    expect(capturedBody).not.toMatch(/cookie|sid_site_/iu);
  });

  it("Test 13: payload contains no password data", async () => {
    expect(await serializedPayload()).not.toMatch(/password|password_hash/iu);
  });

  it("Test 14: payload contains no regular session token or hash", async () => {
    expect(await serializedPayload()).not.toMatch(/sid_site_|session.*token|token.*hash/iu);
  });

  it("Test 15: payload contains no decoy token or hash", async () => {
    expect(await serializedPayload()).not.toMatch(/decoy|token.*hash/iu);
  });

  it("Test 16: payload contains no decoyId or local detection events", async () => {
    const payload = await serializedPayload();
    expect(payload).not.toMatch(/decoyId|local_detection_events/iu);
    expect(Object.keys(parseBody(payload)).sort()).toEqual([
      "localUserId",
      "principalId",
      "serviceId",
    ]);
  });
});
