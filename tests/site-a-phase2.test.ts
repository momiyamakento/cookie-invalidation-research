import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseCookie } from "cookie";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSiteAApp,
  SESSION_COOKIE_NAME,
} from "../apps/site-a/src/app.js";
import {
  EXPERIMENT_USER,
  initializeSiteAContext,
  type SiteAContext,
} from "../apps/site-a/src/site-a-context.js";
import { hashSessionToken } from "../apps/site-a/src/security/session-token.js";

const TEST_PASSWORD = "correct horse battery staple";

function requireSessionCookie(headers: string[] | undefined): string {
  const cookie = headers?.find((header) =>
    header.startsWith(`${SESSION_COOKIE_NAME}=`),
  );
  if (cookie === undefined) {
    throw new Error("sid_site_a was not set");
  }

  const separator = cookie.indexOf(";");
  return separator === -1 ? cookie : cookie.slice(0, separator);
}

function tokenFromCookie(cookie: string): string {
  const token = parseCookie(cookie)[SESSION_COOKIE_NAME];
  if (token === undefined) {
    throw new Error("sid_site_a has no value");
  }

  return token;
}

describe("Site A Phase 2 regular sessions", () => {
  let context: SiteAContext;
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "site-a-phase2-"));
    context = await initializeSiteAContext(
      join(temporaryDirectory, "site-a.sqlite"),
      TEST_PASSWORD,
    );
  });

  afterEach(() => {
    context.database.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it("Test 1: seeds the experiment user exactly once", async () => {
    const seeded = context.userRepository.findById(EXPERIMENT_USER.id);
    expect(seeded?.username).toBe(EXPERIMENT_USER.username);
    expect(seeded?.passwordHash).not.toBe(TEST_PASSWORD);
    expect(seeded?.passwordHash.startsWith("scrypt$")).toBe(true);

    context.database.close();
    context = await initializeSiteAContext(
      join(temporaryDirectory, "site-a.sqlite"),
      TEST_PASSWORD,
    );
    const row = context.database
      .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM users")
      .get();
    expect(row?.count).toBe(1);
  });

  it("creates the users/sessions schema with foreign keys enabled", () => {
    const tables = context.database
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map(({ name }) => name);

    expect(tables).toContain("users");
    expect(tables).toContain("sessions");
    expect(
      context.database.pragma("foreign_keys", { simple: true }),
    ).toBe(1);
  });

  it("Test 2: accepts the correct username and password", async () => {
    const response = await request(createSiteAApp(context))
      .post("/login")
      .type("form")
      .send({ username: EXPERIMENT_USER.username, password: TEST_PASSWORD });

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/protected");
  });

  it("Test 3: rejects an incorrect password with a generic message", async () => {
    const response = await request(createSiteAApp(context))
      .post("/login")
      .type("form")
      .send({ username: EXPERIMENT_USER.username, password: "wrong-password" });

    expect(response.status).toBe(401);
    expect(response.text).toContain("Invalid username or password.");
    expect(response.get("Set-Cookie")).toBeUndefined();
  });

  it("Test 4: issues sid_site_a with the required attributes", async () => {
    const response = await request(createSiteAApp(context))
      .post("/login")
      .type("form")
      .send({ username: EXPERIMENT_USER.username, password: TEST_PASSWORD });
    const headers = response.get("Set-Cookie");
    const sessionHeader = headers?.find((header) =>
      header.startsWith(`${SESSION_COOKIE_NAME}=`),
    );

    expect(sessionHeader).toContain("HttpOnly");
    expect(sessionHeader).toContain("SameSite=Lax");
    expect(sessionHeader).toContain("Path=/");
    expect(sessionHeader).not.toContain("Secure");
  });

  it("Test 5: stores only the SHA-256 token hash in SQLite", async () => {
    const response = await request(createSiteAApp(context))
      .post("/login")
      .type("form")
      .send({ username: EXPERIMENT_USER.username, password: TEST_PASSWORD });
    const cookie = requireSessionCookie(response.get("Set-Cookie"));
    const token = tokenFromCookie(cookie);
    const row = context.database
      .prepare<[], { token_hash: string }>(
        "SELECT token_hash FROM sessions ORDER BY created_at DESC LIMIT 1",
      )
      .get();

    expect(row?.token_hash).toBe(hashSessionToken(token));
    expect(row?.token_hash).not.toBe(token);
    expect(row?.token_hash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("Test 6: allows an ACTIVE session to access /protected", async () => {
    const app = createSiteAApp(context);
    const login = await request(app).post("/login").type("form").send({
      username: EXPERIMENT_USER.username,
      password: TEST_PASSWORD,
    });
    const cookie = requireSessionCookie(login.get("Set-Cookie"));
    const response = await request(app).get("/protected").set("Cookie", cookie);

    expect(response.status).toBe(200);
    expect(response.text).toContain("Logged in as alice-a");
    expect(response.text).toContain("local user id: user-a-001");
    expect(response.text).toContain("session status: ACTIVE");
  });

  it("Test 7: rejects /protected without a cookie", async () => {
    const response = await request(createSiteAApp(context)).get("/protected");
    expect(response.status).toBe(401);
  });

  it("Test 8: rejects /protected with a random fake cookie", async () => {
    const response = await request(createSiteAApp(context))
      .get("/protected")
      .set("Cookie", `${SESSION_COOKIE_NAME}=not-a-real-session-token`);
    expect(response.status).toBe(401);
  });

  it("Test 9: changes the server-side session from ACTIVE to REVOKED on logout", async () => {
    const app = createSiteAApp(context);
    const login = await request(app).post("/login").type("form").send({
      username: EXPERIMENT_USER.username,
      password: TEST_PASSWORD,
    });
    const cookie = requireSessionCookie(login.get("Set-Cookie"));
    const tokenHash = hashSessionToken(tokenFromCookie(cookie));
    const response = await request(app).post("/logout").set("Cookie", cookie);
    const session = context.sessionRepository.findByTokenHash(tokenHash);

    expect(response.status).toBe(303);
    expect(response.get("Set-Cookie")?.join(";")).toContain(
      `${SESSION_COOKIE_NAME}=`,
    );
    expect(session?.status).toBe("REVOKED");
    expect(session?.revokedAt).not.toBeNull();
  });

  it("Test 10: rejects the exact pre-logout cookie after server-side revocation", async () => {
    const app = createSiteAApp(context);
    const login = await request(app).post("/login").type("form").send({
      username: EXPERIMENT_USER.username,
      password: TEST_PASSWORD,
    });
    const stolenCookie = requireSessionCookie(login.get("Set-Cookie"));

    expect(
      (await request(app).get("/protected").set("Cookie", stolenCookie)).status,
    ).toBe(200);
    await request(app).post("/logout").set("Cookie", stolenCookie).expect(303);
    expect(
      (await request(app).get("/protected").set("Cookie", stolenCookie)).status,
    ).toBe(401);
  });

  it("keeps the Phase 1 health check", async () => {
    const response = await request(createSiteAApp(context)).get("/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", service: "site-a" });
  });
});
