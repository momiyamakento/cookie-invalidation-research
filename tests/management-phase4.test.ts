import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createManagementApp } from "../apps/management-server/src/app.js";
import { SiteTokenAuthenticator } from "../apps/management-server/src/internal-auth.js";
import {
  initializeManagementContext,
  type ManagementContext,
} from "../apps/management-server/src/management-context.js";

const SITE_A_MAPPING = {
  principalId: "principal-001",
  serviceId: "site-a",
  localUserId: "user-a-001",
} as const;
const SITE_TOKENS = {
  "site-a": "phase4-site-a-token",
  "site-b": "phase4-site-b-token",
  "site-c": "phase4-site-c-token",
  "site-d": "phase4-site-d-token",
} as const;

function managementApp(context: ManagementContext) {
  return createManagementApp(context.mappingService, {
    authenticator: new SiteTokenAuthenticator(SITE_TOKENS),
  });
}

function bearer(serviceId: string): string {
  const token = SITE_TOKENS[serviceId as keyof typeof SITE_TOKENS];
  if (token === undefined) throw new Error(`Missing test token for ${serviceId}`);
  return `Bearer ${token}`;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object response");
  }

  return parsed as Record<string, unknown>;
}

describe("Management Server Phase 4 mappings", () => {
  let context: ManagementContext;
  let databasePath: string;
  let temporaryDirectory: string;

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "management-phase4-"));
    databasePath = join(temporaryDirectory, "management.sqlite");
    context = initializeManagementContext(databasePath);
  });

  afterEach(() => {
    context.database.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it("Test 1: creates the services table on initialization", () => {
    const row = context.database
      .prepare<[string], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("services");

    expect(row?.name).toBe("services");
    expect(context.database.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("Test 2: seeds site-a through site-d without duplicates", () => {
    expect(context.serviceRepository.findAll()).toMatchObject([
      { id: "site-a", name: "Site A", baseUrl: "http://localhost:3101" },
      { id: "site-b", name: "Site B", baseUrl: "http://localhost:3102" },
      { id: "site-c", name: "Site C", baseUrl: "http://localhost:3103" },
      { id: "site-d", name: "Site D", baseUrl: "http://localhost:3104" },
    ]);

    context.database.close();
    context = initializeManagementContext(databasePath);
    expect(context.serviceRepository.findAll()).toHaveLength(4);
  });

  it("Test 3: creates the user_service_mappings table", () => {
    const row = context.database
      .prepare<[string], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("user_service_mappings");

    expect(row?.name).toBe("user_service_mappings");
  });

  it("Test 4: registers a valid mapping", async () => {
    const response = await request(managementApp(context))
      .post("/api/v1/mappings")
      .set("Authorization", bearer("site-a"))
      .send(SITE_A_MAPPING);

    expect(response.status).toBe(201);
    expect(parseJsonObject(response.text)).toEqual({
      ...SITE_A_MAPPING,
      status: "registered",
    });
  });

  it("Test 5: treats an identical registration as idempotent", async () => {
    const app = managementApp(context);
    await request(app).post("/api/v1/mappings").set("Authorization", bearer("site-a")).send(SITE_A_MAPPING).expect(201);
    const second = await request(app)
      .post("/api/v1/mappings")
      .set("Authorization", bearer("site-a"))
      .send(SITE_A_MAPPING);
    const count = context.database
      .prepare<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM user_service_mappings",
      )
      .get();

    expect(second.status).toBe(200);
    expect(parseJsonObject(second.text).status).toBe("already_registered");
    expect(count?.count).toBe(1);
  });

  it("Test 6: rejects one service user assigned to another principal", async () => {
    const app = managementApp(context);
    await request(app).post("/api/v1/mappings").set("Authorization", bearer("site-a")).send(SITE_A_MAPPING).expect(201);
    const response = await request(app).post("/api/v1/mappings").set("Authorization", bearer("site-a")).send({
      ...SITE_A_MAPPING,
      principalId: "principal-002",
    });

    expect(response.status).toBe(409);
    expect(parseJsonObject(response.text).error).toBe("MAPPING_CONFLICT");
  });

  it("Test 7: rejects another local user for the same principal and service", async () => {
    const app = managementApp(context);
    await request(app).post("/api/v1/mappings").set("Authorization", bearer("site-a")).send(SITE_A_MAPPING).expect(201);
    const response = await request(app).post("/api/v1/mappings").set("Authorization", bearer("site-a")).send({
      ...SITE_A_MAPPING,
      localUserId: "user-a-999",
    });

    expect(response.status).toBe(409);
    expect(parseJsonObject(response.text).error).toBe("MAPPING_CONFLICT");
  });

  it("Test 8: rejects an unknown service", async () => {
    const response = await request(managementApp(context))
      .post("/api/v1/mappings")
      .set("Authorization", bearer("site-a"))
      .send({ ...SITE_A_MAPPING, serviceId: "site-unknown" });

    expect(response.status).toBe(403);
    expect(parseJsonObject(response.text).error).toBe("SERVICE_ID_MISMATCH");
  });

  it("Test 9: returns mappings by principalId", async () => {
    const app = managementApp(context);
    await request(app).post("/api/v1/mappings").set("Authorization", bearer("site-a")).send(SITE_A_MAPPING).expect(201);
    const response = await request(app).get(
      "/api/v1/mappings/principal-001",
    ).set("Authorization", bearer("site-a"));

    expect(response.status).toBe(200);
    expect(parseJsonObject(response.text)).toEqual({
      principalId: "principal-001",
      services: [{ serviceId: "site-a", localUserId: "user-a-001" }],
    });
  });

  it("Test 10: returns only the caller's own service mapping", async () => {
    const app = managementApp(context);
    const mappings = [
      { ...SITE_A_MAPPING, serviceId: "site-c", localUserId: "user-c-105" },
      SITE_A_MAPPING,
      { ...SITE_A_MAPPING, serviceId: "site-b", localUserId: "user-b-018" },
    ];
    for (const mapping of mappings) {
      await request(app).post("/api/v1/mappings").set("Authorization", bearer(mapping.serviceId)).send(mapping).expect(201);
    }

    const response = await request(app).get(
      "/api/v1/mappings/principal-001",
    ).set("Authorization", bearer("site-a"));
    expect(parseJsonObject(response.text).services).toEqual([
      { serviceId: "site-a", localUserId: "user-a-001" },
    ]);
  });

  it("Test 11: resolves serviceId and localUserId to principalId", async () => {
    const app = managementApp(context);
    await request(app).post("/api/v1/mappings").set("Authorization", bearer("site-a")).send(SITE_A_MAPPING).expect(201);
    const response = await request(app).get(
      "/api/v1/mappings/resolve?serviceId=site-a&localUserId=user-a-001",
    ).set("Authorization", bearer("site-a"));

    expect(response.status).toBe(200);
    expect(parseJsonObject(response.text)).toEqual({
      serviceId: "site-a",
      localUserId: "user-a-001",
      principalId: "principal-001",
    });
    expect(
      context.mappingService.findPrincipalByServiceUser(
        "site-a",
        "user-a-001",
      ),
    ).toBe("principal-001");
  });

  it("Test 12: returns 404 for an unresolved service user", async () => {
    const response = await request(managementApp(context))
      .get("/api/v1/mappings/resolve?serviceId=site-a&localUserId=unknown")
      .set("Authorization", bearer("site-a"));

    expect(response.status).toBe(404);
    expect(parseJsonObject(response.text).error).toBe(
      "USER_MAPPING_NOT_FOUND",
    );
  });

  it("Test 13: returns 404 for a principal with no mappings", async () => {
    const response = await request(managementApp(context))
      .get("/api/v1/mappings/principal-999")
      .set("Authorization", bearer("site-a"));

    expect(response.status).toBe(404);
    expect(parseJsonObject(response.text).error).toBe(
      "USER_MAPPING_NOT_FOUND",
    );
  });

  it("Test 14: stores no cookie, password or session token fields", () => {
    const schema = context.database
      .prepare<[], { sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map(({ sql }) => sql.toLowerCase())
      .join("\n");

    expect(schema).not.toMatch(/password|cookie|token_hash|session_token/u);
    expect(schema).toContain("principal_id");
    expect(schema).toContain("local_user_id");
    expect(schema).toContain("base_url");
  });

  it("Test 15: keeps the Management Server health check", async () => {
    const response = await request(
      managementApp(context),
    ).get("/health");

    expect(response.status).toBe(200);
    expect(parseJsonObject(response.text)).toEqual({
      status: "ok",
      service: "management-server",
    });
  });

  it("validates empty mapping fields before repository access", async () => {
    const response = await request(managementApp(context))
      .post("/api/v1/mappings")
      .set("Authorization", bearer("site-a"))
      .send({ principalId: " ", serviceId: "site-a", localUserId: "" });

    expect(response.status).toBe(400);
    expect(parseJsonObject(response.text).error).toBe(
      "INVALID_MAPPING_REQUEST",
    );
  });

  it("rejects an unauthenticated mapping registration", async () => {
    const response = await request(managementApp(context))
      .post("/api/v1/mappings")
      .send(SITE_A_MAPPING);

    expect(response.status).toBe(401);
    expect(parseJsonObject(response.text).error).toBe("UNAUTHORIZED");
  });

  it("rejects a service attempting to register another service's mapping", async () => {
    const response = await request(managementApp(context))
      .post("/api/v1/mappings")
      .set("Authorization", bearer("site-b"))
      .send(SITE_A_MAPPING);

    expect(response.status).toBe(403);
    expect(parseJsonObject(response.text).error).toBe("SERVICE_ID_MISMATCH");
  });
});
