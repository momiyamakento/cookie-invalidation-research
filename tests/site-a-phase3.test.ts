import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseCookie } from "cookie";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSiteAApp,
  DECOY_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "../apps/site-a/src/app.js";
import { hashDecoyToken } from "../apps/site-a/src/security/decoy-token.js";
import {
  EXPERIMENT_USER,
  initializeSiteAContext,
  type SiteAContext,
} from "../apps/site-a/src/site-a-context.js";

const TEST_PASSWORD = "correct horse battery staple";

function requireCookie(
  headers: string[] | undefined,
  cookieName: string,
): string {
  const cookie = headers?.find((header) =>
    header.startsWith(`${cookieName}=`),
  );
  if (cookie === undefined) {
    throw new Error(`${cookieName} was not set`);
  }

  const separator = cookie.indexOf(";");
  return separator === -1 ? cookie : cookie.slice(0, separator);
}

function requireFullCookieHeader(
  headers: string[] | undefined,
  cookieName: string,
): string {
  const cookie = headers?.find((header) =>
    header.startsWith(`${cookieName}=`),
  );
  if (cookie === undefined) {
    throw new Error(`${cookieName} was not set`);
  }

  return cookie;
}

function tokenFromCookie(cookie: string, cookieName: string): string {
  const token = parseCookie(cookie)[cookieName];
  if (token === undefined) {
    throw new Error(`${cookieName} has no value`);
  }

  return token;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object response");
  }

  return parsed as Record<string, unknown>;
}

describe("Site A Phase 3 decoy detector", () => {
  let context: SiteAContext;
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "site-a-phase3-"));
    context = await initializeSiteAContext(
      join(temporaryDirectory, "site-a.sqlite"),
      TEST_PASSWORD,
    );
  });

  afterEach(() => {
    context.database.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  async function login() {
    const app = createSiteAApp(context);
    const response = await request(app).post("/login").type("form").send({
      username: EXPERIMENT_USER.username,
      password: TEST_PASSWORD,
    });

    return { app, response };
  }

  it("Test 1: issues both the regular and decoy cookies on login", async () => {
    const { response } = await login();
    const headers = response.get("Set-Cookie");

    expect(requireCookie(headers, SESSION_COOKIE_NAME)).toContain(
      `${SESSION_COOKIE_NAME}=`,
    );
    expect(requireCookie(headers, DECOY_COOKIE_NAME)).toContain(
      `${DECOY_COOKIE_NAME}=`,
    );
  });

  it("Test 2: scopes the decoy cookie to the research endpoint", async () => {
    const { response } = await login();
    const header = requireFullCookieHeader(
      response.get("Set-Cookie"),
      DECOY_COOKIE_NAME,
    );

    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/__research/decoy-use");
    expect(header).not.toContain("Secure");
  });

  it("Test 3: creates an ISSUED decoy_sessions row on login", async () => {
    const { response } = await login();
    const cookie = requireCookie(response.get("Set-Cookie"), DECOY_COOKIE_NAME);
    const token = tokenFromCookie(cookie, DECOY_COOKIE_NAME);
    const decoy = context.decoyRepository.findByTokenHash(
      hashDecoyToken(token),
    );

    expect(decoy?.status).toBe("ISSUED");
    expect(decoy?.usedAt).toBeNull();
    expect(decoy?.userId).toBe(EXPERIMENT_USER.id);
  });

  it("Test 4: stores only the SHA-256 decoy token hash", async () => {
    const { response } = await login();
    const cookie = requireCookie(response.get("Set-Cookie"), DECOY_COOKIE_NAME);
    const token = tokenFromCookie(cookie, DECOY_COOKIE_NAME);
    const decoy = context.decoyRepository.findByTokenHash(
      hashDecoyToken(token),
    );

    expect(decoy?.tokenHash).toBe(hashDecoyToken(token));
    expect(decoy?.tokenHash).not.toBe(token);
    expect(decoy?.tokenHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("Test 5: keeps decoyId separate from the cookie token", async () => {
    const { response } = await login();
    const cookie = requireCookie(response.get("Set-Cookie"), DECOY_COOKIE_NAME);
    const token = tokenFromCookie(cookie, DECOY_COOKIE_NAME);
    const decoy = context.decoyRepository.findByTokenHash(
      hashDecoyToken(token),
    );

    expect(decoy?.decoyId).not.toBe(token);
    expect(decoy?.decoyId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("Test 6: normal /protected use leaves the decoy ISSUED", async () => {
    const app = createSiteAApp(context);
    const agent = request.agent(app);
    await agent.post("/login").type("form").send({
      username: EXPERIMENT_USER.username,
      password: TEST_PASSWORD,
    });
    await agent.get("/protected").expect(200);

    const row = context.database
      .prepare<[], { status: string; used_at: string | null }>(
        "SELECT status, used_at FROM decoy_sessions LIMIT 1",
      )
      .get();
    expect(row).toEqual({ status: "ISSUED", used_at: null });
    expect(context.decoyRepository.countDetectionEvents()).toBe(0);
  });

  it("Test 7: detects a valid decoy and changes ISSUED to USED", async () => {
    const { app, response } = await login();
    const cookie = requireCookie(response.get("Set-Cookie"), DECOY_COOKIE_NAME);
    const token = tokenFromCookie(cookie, DECOY_COOKIE_NAME);
    const detection = await request(app)
      .get("/__research/decoy-use")
      .set("Cookie", cookie);
    const decoy = context.decoyRepository.findByTokenHash(
      hashDecoyToken(token),
    );

    expect(detection.status).toBe(200);
    expect(parseJsonObject(detection.text).detected).toBe(true);
    expect(decoy?.status).toBe("USED");
  });

  it("Test 8: records used_at on first valid use", async () => {
    const { app, response } = await login();
    const cookie = requireCookie(response.get("Set-Cookie"), DECOY_COOKIE_NAME);
    const token = tokenFromCookie(cookie, DECOY_COOKIE_NAME);
    await request(app).get("/__research/decoy-use").set("Cookie", cookie);

    expect(
      context.decoyRepository.findByTokenHash(hashDecoyToken(token))?.usedAt,
    ).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it("Test 9: returns and stores the required detection event fields", async () => {
    const { app, response } = await login();
    const cookie = requireCookie(response.get("Set-Cookie"), DECOY_COOKIE_NAME);
    const detection = await request(app)
      .get("/__research/decoy-use")
      .set("Cookie", cookie);
    const body = parseJsonObject(detection.text);

    expect(body).toMatchObject({
      detected: true,
      serviceId: "site-a",
      localUserId: "user-a-001",
      status: "detected",
    });
    expect(body.eventId).toEqual(expect.any(String));
    expect(body.decoyId).toEqual(expect.any(String));
    expect(body.detectedAt).toEqual(expect.any(String));
    expect(context.decoyRepository.countDetectionEvents()).toBe(1);
    expect(
      context.decoyRepository.findEventByDecoyId(String(body.decoyId))?.eventId,
    ).toBe(body.eventId);
  });

  it("Test 10: never exposes either cookie token in the event", async () => {
    const { app, response } = await login();
    const decoyCookie = requireCookie(
      response.get("Set-Cookie"),
      DECOY_COOKIE_NAME,
    );
    const sessionCookie = requireCookie(
      response.get("Set-Cookie"),
      SESSION_COOKIE_NAME,
    );
    const decoyToken = tokenFromCookie(decoyCookie, DECOY_COOKIE_NAME);
    const sessionToken = tokenFromCookie(sessionCookie, SESSION_COOKIE_NAME);
    const detection = await request(app)
      .get("/__research/decoy-use")
      .set("Cookie", decoyCookie);

    expect(detection.text).not.toContain(decoyToken);
    expect(detection.text).not.toContain(sessionToken);
    expect(Object.keys(parseJsonObject(detection.text))).not.toContain("token");
  });

  it("Test 11: reuses the saved event without duplicate detection", async () => {
    const { app, response } = await login();
    const cookie = requireCookie(response.get("Set-Cookie"), DECOY_COOKIE_NAME);
    const first = await request(app)
      .get("/__research/decoy-use")
      .set("Cookie", cookie);
    const second = await request(app)
      .get("/__research/decoy-use")
      .set("Cookie", cookie);
    const firstBody = parseJsonObject(first.text);
    const secondBody = parseJsonObject(second.text);

    expect(firstBody.status).toBe("detected");
    expect(secondBody.status).toBe("already_detected");
    expect(secondBody.detected).toBe(false);
    expect(secondBody.eventId).toBe(firstBody.eventId);
    expect(context.decoyRepository.countDetectionEvents()).toBe(1);
  });

  it("Test 12: rejects a fake decoy cookie", async () => {
    const response = await request(createSiteAApp(context))
      .get("/__research/decoy-use")
      .set("Cookie", `${DECOY_COOKIE_NAME}=fake-decoy-token`);

    expect(response.status).toBe(404);
    expect(parseJsonObject(response.text).detected).toBe(false);
    expect(context.decoyRepository.countDetectionEvents()).toBe(0);
  });

  it("Test 13: rejects a request with no decoy cookie", async () => {
    const response = await request(createSiteAApp(context)).get(
      "/__research/decoy-use",
    );

    expect(response.status).toBe(400);
    expect(parseJsonObject(response.text).detected).toBe(false);
    expect(context.decoyRepository.countDetectionEvents()).toBe(0);
  });

  it("Test 14: never authenticates /protected with only a decoy cookie", async () => {
    const { app, response } = await login();
    const decoyCookie = requireCookie(
      response.get("Set-Cookie"),
      DECOY_COOKIE_NAME,
    );

    await request(app).get("/protected").set("Cookie", decoyCookie).expect(401);
  });

  it("Test 15: still rejects a regular cookie after logout", async () => {
    const { app, response } = await login();
    const sessionCookie = requireCookie(
      response.get("Set-Cookie"),
      SESSION_COOKIE_NAME,
    );

    await request(app).get("/protected").set("Cookie", sessionCookie).expect(200);
    await request(app).post("/logout").set("Cookie", sessionCookie).expect(303);
    await request(app).get("/protected").set("Cookie", sessionCookie).expect(401);
  });

  it("does not link the research endpoint from normal pages", async () => {
    const app = createSiteAApp(context);
    const loginPage = await request(app).get("/login");
    expect(loginPage.text).not.toContain("/__research/decoy-use");

    const login = await request(app).post("/login").type("form").send({
      username: EXPERIMENT_USER.username,
      password: TEST_PASSWORD,
    });
    const sessionCookie = requireCookie(
      login.get("Set-Cookie"),
      SESSION_COOKIE_NAME,
    );
    const protectedPage = await request(app)
      .get("/protected")
      .set("Cookie", sessionCookie);
    expect(protectedPage.text).not.toContain("/__research/decoy-use");
  });
});
