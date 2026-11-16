import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startDemoSystem } from "./helpers/demo-system.js";

interface State {
  cookies: { sid_site_a: string; decoy_site_a: string } | null;
  attacker: { status: string; succeededAt: string | null };
  services: Array<{ id: string; status: string }>;
  events: Array<{ message: string; key?: string }>;
  revocation: { eventId: string | null; complete: boolean; revokedCount: number; notification: string; error: string | null; managerStatus: string; totalDurationMs: number };
}
describe("Phase 3 real detection and coordinated revocation", () => {
  let system: Awaited<ReturnType<typeof startDemoSystem>>;
  let csrf: string;
  beforeAll(async () => {
    system = await startDemoSystem();
    const page = await request(system.demo).get("/demo");
    csrf = /name="demo-token" content="([a-f0-9]+)"/u.exec(page.text)![1]!;
  }, 20000);
  afterAll(async () => { await system?.close(); });
  async function setup() {
    const browser = request.agent(system.demo);
    const login = await browser.post("/demo/api/session/login").set("X-Demo-Token", csrf)
      .send({ username: "alice-a", password: system.config.sites[0]!.password }).expect(200);
    const cookies = (login.body as State).cookies!;
    await browser.post("/demo/api/attacker/use-cookie").set("X-Demo-Token", csrf).send({ cookie: `sid_site_a=${cookies.sid_site_a}` }).expect(200);
    return { browser, cookies };
  }
  it("revokes A–D and the retained attacker cookie; restores, deduplicates, resets and repeats", async () => {
    const ids: string[] = [];
    for (let round = 0; round < 2; round += 1) {
      const { browser, cookies } = await setup();
      const response = await browser.post("/demo/api/attacker/use-cookie").set("X-Demo-Token", csrf)
        .send({ cookie: round ? cookies.decoy_site_a : `decoy_site_a=${cookies.decoy_site_a}` }).expect(200);
      const state = response.body as State;
      expect(state.revocation).toMatchObject({ complete: true, revokedCount: 4, managerStatus: "SUCCESS", notification: "notified", error: null });
      expect(state.revocation.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(state.services.every((site) => site.status === "revoked")).toBe(true);
      expect(state.attacker.status).toBe("revoked"); expect(state.cookies).toBeNull();
      // The presentation retains stolenCookies for the explicit replay demo;
      // the victim's active-cookie view must disappear after revocation.
      expect(state.cookies).toBeNull();
      ids.push(state.revocation.eventId!);
      await browser.get("/demo").expect(200);
      const refresh = await browser.get("/demo/api/session").set("X-Demo-Token", csrf).expect(200);
      expect((refresh.body as State).revocation.complete).toBe(true);
      expect((refresh.body as State).attacker.status).toBe("revoked");
      expect((refresh.body as State).events).toHaveLength(state.events.length);
      const duplicate = await browser.post("/demo/api/attacker/use-cookie").set("X-Demo-Token", csrf).send({ cookie: `decoy_site_a=${cookies.decoy_site_a}` }).expect(200);
      expect((duplicate.body as State).revocation.eventId).toBe(state.revocation.eventId);
      expect((duplicate.body as State).events).toHaveLength(state.events.length);
      const reset = await browser.post("/demo/api/session/reset").set("X-Demo-Token", csrf).send({}).expect(200);
      expect((reset.body as State).revocation.eventId).toBeNull(); expect((reset.body as State).attacker.status).toBe("idle");
      expect((reset.body as State).events).toEqual([]);
      await browser.post("/demo/api/attacker/use-cookie").set("X-Demo-Token", csrf).send({ cookie: `decoy_site_a=${cookies.decoy_site_a}` }).expect(400);
    }
    expect(new Set(ids).size).toBe(2);
  }, 20000);

  it.each([false, true])("revokes all services with only A logged in locally (B also local: %s)", async (loginB) => {
    // Other browser sessions must be revoked even when their sites were never
    // opened in the browser that issued the decoy.
    const other = await setup();
    const victim = request.agent(system.demo);
    const attacker = request.agent(system.demo);
    const login = await victim.post("/demo/api/session/login-site-a").set("X-Demo-Token", csrf)
      .send({ username: "alice-a", password: system.config.sites[0]!.password }).expect(200);
    const cookies = (login.body as State).cookies!;
    if (loginB) await victim.post("/demo/api/session/login-site-b").set("X-Demo-Token", csrf)
      .send({ username: "alice-b", password: system.config.sites[1]!.password }).expect(200);
    await attacker.post("/demo/api/attacker/use-cookie").set("X-Demo-Token", csrf)
      .send({ cookie: cookies.sid_site_a }).expect(200);
    const result = await attacker.post("/demo/api/attacker/use-cookie").set("X-Demo-Token", csrf)
      .send({ cookie: loginB ? cookies.decoy_site_a : `decoy_site_a=${cookies.decoy_site_a}` }).expect(200);
    const state = result.body as State;
    expect(state.revocation).toMatchObject({ complete: true, revokedCount: loginB ? 2 : 1, managerStatus: "SUCCESS", error: null });
    expect(state.attacker.status).toBe("revoked");
    expect(state.services.filter((site) => site.status === "signed-out")).toHaveLength(loginB ? 2 : 3);
    const refreshed = await victim.get("/demo/api/session").set("X-Demo-Token", csrf).expect(200);
    expect((refreshed.body as State).revocation.complete).toBe(true);
    const otherState = await other.browser.get("/demo/api/session").set("X-Demo-Token", csrf).expect(200);
    expect((otherState.body as State).services.every((site) => site.status === "signed-out")).toBe(true);
    await victim.post("/demo/api/session/reset").set("X-Demo-Token", csrf).send({}).expect(200);
    await other.browser.post("/demo/api/session/reset").set("X-Demo-Token", csrf).send({}).expect(200);
  });

  it("reports a real notification failure and recovers through explicit idempotent resubmission", async () => {
    const { browser, cookies } = await setup();
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const address = url instanceof Request ? url.url : url.toString();
      if (address.endsWith("/api/v1/detections") && init?.method === "POST") return new Response('{"error":"UNAUTHORIZED"}', { status: 401 });
      return await realFetch(url, init);
    });
    let eventId: string | null;
    try {
      const response = await browser.post("/demo/api/attacker/use-cookie").set("X-Demo-Token", csrf).send({ cookie: `decoy_site_a=${cookies.decoy_site_a}` }).expect(200);
      const state = response.body as State; eventId = state.revocation.eventId;
      expect(eventId).toBeTruthy(); expect(state.revocation.notification).toBe("failed"); expect(state.revocation.complete).toBe(false);
      expect(state.revocation.error).toBeTruthy(); expect(state.services.every((site) => site.status === "logged-in")).toBe(true);
      expect(state.attacker.status).toBe("success");
    } finally { spy.mockRestore(); }
    const response = await browser.post("/demo/api/attacker/use-cookie").set("X-Demo-Token", csrf).send({ cookie: `decoy_site_a=${cookies.decoy_site_a}` }).expect(200);
    expect((response.body as State).revocation.eventId).toBe(eventId);
    expect((response.body as State).revocation.complete).toBe(true);
    await browser.post("/demo/api/session/reset").set("X-Demo-Token", csrf).send({}).expect(200);
  });

  it("preserves partial failures and distinguishes an inaccessible Site from a revoked session", async () => {
    const { browser, cookies } = await setup();
    const b = system.config.sites[1]!;
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const address = url instanceof Request ? url.url : url.toString();
      if (address === `${b.baseUrl}/internal/v1/sessions/revoke`) return new Response("Unauthorized", { status: 401 });
      return await realFetch(url, init);
    });
    try {
      const response = await browser.post("/demo/api/attacker/use-cookie").set("X-Demo-Token", csrf).send({ cookie: `decoy_site_a=${cookies.decoy_site_a}` }).expect(200);
      const state = response.body as State;
      expect(state.revocation).toMatchObject({ complete: false, revokedCount: 3, managerStatus: "PARTIAL_FAILURE" });
      expect(state.services.find((site) => site.id === b.id)?.status).toBe("logged-in");
      expect(state.attacker.status).toBe("revoked");
    } finally { spy.mockRestore(); }
    const oldUrl = b.baseUrl; b.baseUrl = "http://127.0.0.1:1";
    try {
      const response = await browser.get("/demo/api/session").set("X-Demo-Token", csrf).expect(200);
      expect((response.body as State).services.find((site) => site.id === b.id)?.status).toBe("unknown");
      expect((response.body as State).revocation.complete).toBe(false);
      await browser.post("/demo/api/session/reset").set("X-Demo-Token", csrf).send({}).expect(502);
    } finally { b.baseUrl = oldUrl; }
    await browser.post("/demo/api/session/reset").set("X-Demo-Token", csrf).send({}).expect(200);
  });
});
