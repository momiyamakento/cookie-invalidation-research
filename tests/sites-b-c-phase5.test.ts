import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createResearchSiteApp,
  hashOpaqueToken,
  initializeResearchSiteContext,
  type ResearchSiteContext,
} from "@cookie-research/service-kit";
import { parse as parseCookie } from "cookie";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadSiteBConfig,
  SITE_B_DEFINITION,
} from "../apps/site-b/src/config.js";
import {
  loadSiteCConfig,
  SITE_C_DEFINITION,
} from "../apps/site-c/src/config.js";
import { loadSiteAConfig } from "../apps/site-a/src/config.js";

const SITE_B_PASSWORD = "site-b-correct-test-password";
const SITE_C_PASSWORD = "site-c-correct-test-password";
const PHASE_6_CONFIG = {
  MANAGEMENT_BASE_URL: "http://localhost:4100",
  SITE_A_PRINCIPAL_ID: "principal-001",
  SITE_B_PRINCIPAL_ID: "principal-001",
  SITE_C_PRINCIPAL_ID: "principal-001",
  SITE_A_TO_MANAGER_TOKEN: "site-a-test-manager-token",
  SITE_B_TO_MANAGER_TOKEN: "site-b-test-manager-token",
  SITE_C_TO_MANAGER_TOKEN: "site-c-test-manager-token",
  MANAGER_TO_SITE_A_TOKEN: "manager-test-site-a-token",
  MANAGER_TO_SITE_B_TOKEN: "manager-test-site-b-token",
  MANAGER_TO_SITE_C_TOKEN: "manager-test-site-c-token",
};

function requireCookie(
  headers: string[] | undefined,
  cookieName: string,
): string {
  const header = headers?.find((value) => value.startsWith(`${cookieName}=`));
  if (header === undefined) {
    throw new Error(`${cookieName} was not set`);
  }
  const separator = header.indexOf(";");
  return separator === -1 ? header : header.slice(0, separator);
}

function requireFullCookie(
  headers: string[] | undefined,
  cookieName: string,
): string {
  const header = headers?.find((value) => value.startsWith(`${cookieName}=`));
  if (header === undefined) {
    throw new Error(`${cookieName} was not set`);
  }
  return header;
}

function cookieToken(cookie: string, cookieName: string): string {
  const token = parseCookie(cookie)[cookieName];
  if (token === undefined) {
    throw new Error(`${cookieName} has no token`);
  }
  return token;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function login(
  context: ResearchSiteContext,
  username: string,
  password: string,
) {
  const app = createResearchSiteApp(context);
  const response = await request(app)
    .post("/login")
    .type("form")
    .send({ username, password });
  return { app, response };
}

describe("Phase 5 independent Site B and Site C", () => {
  let siteB: ResearchSiteContext;
  let siteC: ResearchSiteContext;
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "sites-b-c-phase5-"));
    siteB = await initializeResearchSiteContext(
      SITE_B_DEFINITION,
      join(temporaryDirectory, "site-b.sqlite"),
      SITE_B_PASSWORD,
    );
    siteC = await initializeResearchSiteContext(
      SITE_C_DEFINITION,
      join(temporaryDirectory, "site-c.sqlite"),
      SITE_C_PASSWORD,
    );
  });

  afterEach(() => {
    siteB.database.close();
    siteC.database.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it("Checks 1-2: configures three different production database paths", () => {
    const paths = [
      loadSiteAConfig({
        ...PHASE_6_CONFIG,
        SITE_A_SEED_PASSWORD: "site-a-test-password",
      }).databasePath,
      loadSiteBConfig({
        ...PHASE_6_CONFIG,
        SITE_B_SEED_PASSWORD: SITE_B_PASSWORD,
      }).databasePath,
      loadSiteCConfig({
        ...PHASE_6_CONFIG,
        SITE_C_SEED_PASSWORD: SITE_C_PASSWORD,
      }).databasePath,
    ];

    expect(new Set(paths).size).toBe(3);
    expect(paths[0]).toMatch(/site-a[\\/]data[\\/]site-a\.sqlite$/u);
    expect(paths[1]).toMatch(/site-b[\\/]data[\\/]site-b\.sqlite$/u);
    expect(paths[2]).toMatch(/site-c[\\/]data[\\/]site-c\.sqlite$/u);
  });

  it("Checks 3-4: seeds independent Site B and Site C users", () => {
    expect(siteB.userRepository.findById("user-b-018")).toMatchObject({
      id: "user-b-018",
      username: "alice-b",
    });
    expect(siteC.userRepository.findById("user-c-105")).toMatchObject({
      id: "user-c-105",
      username: "alice-c",
    });
    expect(siteB.userRepository.findById("user-c-105")).toBeUndefined();
    expect(siteC.userRepository.findById("user-b-018")).toBeUndefined();
  });

  it("Checks 5-6: logs in to Site B and Site C independently", async () => {
    expect((await login(siteB, "alice-b", SITE_B_PASSWORD)).response.status).toBe(
      302,
    );
    expect((await login(siteC, "alice-c", SITE_C_PASSWORD)).response.status).toBe(
      302,
    );
    expect((await login(siteB, "alice-c", SITE_C_PASSWORD)).response.status).toBe(
      401,
    );
  });

  it("Checks 7-8: issues only each service's regular cookie name", async () => {
    const bHeaders = (await login(siteB, "alice-b", SITE_B_PASSWORD)).response.get(
      "Set-Cookie",
    );
    const cHeaders = (await login(siteC, "alice-c", SITE_C_PASSWORD)).response.get(
      "Set-Cookie",
    );

    expect(requireCookie(bHeaders, "sid_site_b")).toContain("sid_site_b=");
    expect(requireCookie(cHeaders, "sid_site_c")).toContain("sid_site_c=");
    expect(bHeaders?.join(";")).not.toContain("sid_site_a=");
    expect(cHeaders?.join(";")).not.toContain("sid_site_a=");
  });

  it("Checks 9-10: stores regular token hashes, never token bodies", async () => {
    for (const [context, username, password, cookieName] of [
      [siteB, "alice-b", SITE_B_PASSWORD, "sid_site_b"],
      [siteC, "alice-c", SITE_C_PASSWORD, "sid_site_c"],
    ] as const) {
      const { response } = await login(context, username, password);
      const cookie = requireCookie(response.get("Set-Cookie"), cookieName);
      const token = cookieToken(cookie, cookieName);
      const session = context.sessionRepository.findByTokenHash(
        hashOpaqueToken(token),
      );
      expect(session?.tokenHash).toBe(hashOpaqueToken(token));
      expect(session?.tokenHash).not.toBe(token);
      expect(session?.tokenHash).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("Checks 11-12: authenticates each ACTIVE regular session", async () => {
    for (const [context, username, password, cookieName, expectedUser] of [
      [siteB, "alice-b", SITE_B_PASSWORD, "sid_site_b", "user-b-018"],
      [siteC, "alice-c", SITE_C_PASSWORD, "sid_site_c", "user-c-105"],
    ] as const) {
      const { app, response } = await login(context, username, password);
      const cookie = requireCookie(response.get("Set-Cookie"), cookieName);
      const protectedResponse = await request(app)
        .get("/protected")
        .set("Cookie", cookie);
      expect(protectedResponse.status).toBe(200);
      expect(protectedResponse.text).toContain(expectedUser);
    }
  });

  it("Checks 13-14: ignores every other service's regular cookie", async () => {
    await request(createResearchSiteApp(siteB))
      .get("/protected")
      .set("Cookie", "sid_site_a=foreign-token")
      .expect(401);
    await request(createResearchSiteApp(siteC))
      .get("/protected")
      .set("Cookie", "sid_site_a=foreign-token; sid_site_b=foreign-token")
      .expect(401);
  });

  it("Checks 15-18: logout revokes sessions and rejects copied cookies", async () => {
    for (const [context, username, password, cookieName] of [
      [siteB, "alice-b", SITE_B_PASSWORD, "sid_site_b"],
      [siteC, "alice-c", SITE_C_PASSWORD, "sid_site_c"],
    ] as const) {
      const { app, response } = await login(context, username, password);
      const copiedCookie = requireCookie(response.get("Set-Cookie"), cookieName);
      const token = cookieToken(copiedCookie, cookieName);
      await request(app).post("/logout").set("Cookie", copiedCookie).expect(303);
      expect(
        context.sessionRepository.findByTokenHash(hashOpaqueToken(token)),
      ).toMatchObject({ status: "REVOKED" });
      await request(app)
        .get("/protected")
        .set("Cookie", copiedCookie)
        .expect(401);
    }
  });

  it("Checks 19-20: issues correctly scoped Site B/C decoy cookies", async () => {
    for (const [context, username, password, cookieName] of [
      [siteB, "alice-b", SITE_B_PASSWORD, "decoy_site_b"],
      [siteC, "alice-c", SITE_C_PASSWORD, "decoy_site_c"],
    ] as const) {
      const { response } = await login(context, username, password);
      const header = requireFullCookie(response.get("Set-Cookie"), cookieName);
      expect(header).toContain("HttpOnly");
      expect(header).toContain("SameSite=Lax");
      expect(header).toContain("Path=/__research/decoy-use");
      expect(header).not.toContain("Secure");
    }
  });

  it("Checks 21-22: creates ISSUED decoy sessions in each DB", async () => {
    for (const [context, username, password, cookieName] of [
      [siteB, "alice-b", SITE_B_PASSWORD, "decoy_site_b"],
      [siteC, "alice-c", SITE_C_PASSWORD, "decoy_site_c"],
    ] as const) {
      const { response } = await login(context, username, password);
      const token = cookieToken(
        requireCookie(response.get("Set-Cookie"), cookieName),
        cookieName,
      );
      expect(
        context.decoyRepository.findByTokenHash(hashOpaqueToken(token)),
      ).toMatchObject({ status: "ISSUED", usedAt: null });
    }
  });

  it("Checks 23-24: normal protected access never uses either decoy", async () => {
    for (const [context, username, password] of [
      [siteB, "alice-b", SITE_B_PASSWORD],
      [siteC, "alice-c", SITE_C_PASSWORD],
    ] as const) {
      const app = createResearchSiteApp(context);
      const agent = request.agent(app);
      await agent.post("/login").type("form").send({ username, password });
      await agent.get("/protected").expect(200);
      const row = context.database
        .prepare<[], { status: string }>(
          "SELECT status FROM decoy_sessions ORDER BY issued_at DESC LIMIT 1",
        )
        .get();
      expect(row?.status).toBe("ISSUED");
      expect(context.decoyRepository.countEvents()).toBe(0);
    }
  });

  it("Checks 25-27: detects each valid decoy only in its own DB", async () => {
    for (const [context, username, password, cookieName, serviceId] of [
      [siteB, "alice-b", SITE_B_PASSWORD, "decoy_site_b", "site-b"],
      [siteC, "alice-c", SITE_C_PASSWORD, "decoy_site_c", "site-c"],
    ] as const) {
      const { app, response } = await login(context, username, password);
      const cookie = requireCookie(response.get("Set-Cookie"), cookieName);
      const detection = await request(app)
        .get("/__research/decoy-use")
        .set("Cookie", cookie);
      const body = parseJsonObject(detection.text);
      expect(body).toMatchObject({
        detected: true,
        serviceId,
        localUserId: context.definition.localUserId,
        status: "detected",
      });
      expect(context.decoyRepository.countEvents()).toBe(1);
      expect(
        context.decoyRepository.findByTokenHash(
          hashOpaqueToken(cookieToken(cookie, cookieName)),
        ),
      ).toMatchObject({ status: "USED" });
    }
  });

  it("Check 28: never includes regular or decoy token bodies in events", async () => {
    for (const [context, username, password, sidName, decoyName] of [
      [siteB, "alice-b", SITE_B_PASSWORD, "sid_site_b", "decoy_site_b"],
      [siteC, "alice-c", SITE_C_PASSWORD, "sid_site_c", "decoy_site_c"],
    ] as const) {
      const { app, response } = await login(context, username, password);
      const sid = requireCookie(response.get("Set-Cookie"), sidName);
      const decoy = requireCookie(response.get("Set-Cookie"), decoyName);
      const detection = await request(app)
        .get("/__research/decoy-use")
        .set("Cookie", decoy);
      expect(detection.text).not.toContain(cookieToken(sid, sidName));
      expect(detection.text).not.toContain(cookieToken(decoy, decoyName));
    }
  });

  it("Check 29: does not duplicate events for repeated decoy use", async () => {
    for (const [context, username, password, cookieName] of [
      [siteB, "alice-b", SITE_B_PASSWORD, "decoy_site_b"],
      [siteC, "alice-c", SITE_C_PASSWORD, "decoy_site_c"],
    ] as const) {
      const { app, response } = await login(context, username, password);
      const cookie = requireCookie(response.get("Set-Cookie"), cookieName);
      const first = parseJsonObject(
        (await request(app).get("/__research/decoy-use").set("Cookie", cookie))
          .text,
      );
      const second = parseJsonObject(
        (await request(app).get("/__research/decoy-use").set("Cookie", cookie))
          .text,
      );
      expect(second.status).toBe("already_detected");
      expect(second.eventId).toBe(first.eventId);
      expect(context.decoyRepository.countEvents()).toBe(1);
    }
  });

  it("Checks 30-31: rejects cross-service decoy cookies", async () => {
    const bLogin = await login(siteB, "alice-b", SITE_B_PASSWORD);
    const cLogin = await login(siteC, "alice-c", SITE_C_PASSWORD);
    const bToken = cookieToken(
      requireCookie(bLogin.response.get("Set-Cookie"), "decoy_site_b"),
      "decoy_site_b",
    );
    const cToken = cookieToken(
      requireCookie(cLogin.response.get("Set-Cookie"), "decoy_site_c"),
      "decoy_site_c",
    );

    await request(cLogin.app)
      .get("/__research/decoy-use")
      .set("Cookie", `decoy_site_c=${bToken}`)
      .expect(404);
    await request(bLogin.app)
      .get("/__research/decoy-use")
      .set("Cookie", `decoy_site_b=${cToken}`)
      .expect(404);
  });

  it("Check 32: keeps regular sessions ACTIVE after decoy detection", async () => {
    for (const [context, username, password, sidName, decoyName] of [
      [siteB, "alice-b", SITE_B_PASSWORD, "sid_site_b", "decoy_site_b"],
      [siteC, "alice-c", SITE_C_PASSWORD, "sid_site_c", "decoy_site_c"],
    ] as const) {
      const { app, response } = await login(context, username, password);
      const sid = requireCookie(response.get("Set-Cookie"), sidName);
      const decoy = requireCookie(response.get("Set-Cookie"), decoyName);
      await request(app).get("/__research/decoy-use").set("Cookie", decoy);
      expect(
        context.sessionRepository.findByTokenHash(
          hashOpaqueToken(cookieToken(sid, sidName)),
        ),
      ).toMatchObject({ status: "ACTIVE" });
    }
  });
});
