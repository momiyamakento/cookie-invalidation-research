import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startDemoSystem } from "./helpers/demo-system.js";

interface DemoState {
  cookies: { sid_site_a: string; decoy_site_a: string } | null;
  attacker: { status: string; succeededAt: string | null; sameSession: boolean; username: string | null };
  events: Array<{ message: string }>;
  services: Array<{ status: string }>;
}
describe("Phase 2 isolated real-cookie access", () => {
  let system: Awaited<ReturnType<typeof startDemoSystem>>;
  let token: string;
  beforeAll(async () => {
    system = await startDemoSystem();
    const page = await request(system.demo).get("/demo");
    token = /name="demo-token" content="([a-f0-9]+)"/u.exec(page.text)![1]!;
  }, 20000);
  afterAll(async () => { await system?.close(); });

  async function login() {
    const browser = request.agent(system.demo);
    const response = await browser.post("/demo/api/session/login").set("X-Demo-Token", token)
      .send({ username: "alice-a", password: system.config.sites[0]!.password }).expect(200);
    return { browser, data: response.body as DemoState };
  }
  function detectionCount() {
    return (system.manager.database.prepare("SELECT COUNT(*) AS n FROM detection_events").get() as { n: number }).n;
  }

  it("sends only the supplied Cookie to the fixed protected page, restores success and preserves all four sessions", async () => {
    const { browser, data } = await login();
    const cookie = `sid_site_a=${data.cookies!.sid_site_a}`;
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      const attack = await browser.post("/demo/api/attacker/use-cookie").set("X-Demo-Token", token)
        .set("Cookie", "sid_site_a=unrelated-browser-cookie; decoy_site_a=unrelated-decoy")
        .send({ cookie }).expect(200);
      expect(spy).toHaveBeenCalledTimes(1);
      const [url, init] = spy.mock.calls[0]!;
      expect(url).toBe(`${system.config.sites[0]!.baseUrl}/protected`);
      expect(init?.method).toBe("GET"); expect(init?.body).toBeUndefined();
      expect(init?.headers).toEqual({ Cookie: cookie });
      expect(init?.redirect).toBe("manual");
      expect((attack.body as DemoState).attacker).toMatchObject({ status: "success", username: "alice-a", sameSession: true });
      expect(attack.text).not.toContain(data.cookies!.sid_site_a);
      expect(attack.text).not.toContain(system.config.sites[0]!.password);
    } finally { spy.mockRestore(); }
    await browser.get("/demo").expect(200);
    const restored = await browser.get("/demo/api/session").set("X-Demo-Token", token).expect(200);
    const result = restored.body as DemoState;
    expect(result.attacker.status).toBe("success"); expect(result.attacker.succeededAt).toBeTruthy();
    expect(result.services.every((site) => site.status === "logged-in")).toBe(true);
    expect(result.events.some((event) => event.message.includes("HTTP 200"))).toBe(true);
    expect(JSON.stringify(result.events)).not.toContain(data.cookies!.sid_site_a);
    expect(detectionCount()).toBe(0);
    const reset = await browser.post("/demo/api/session/reset").set("X-Demo-Token", token).send({}).expect(200);
    expect((reset.body as DemoState).attacker).toEqual({ status: "idle", succeededAt: null, username: null, sameSession: false });
    expect((reset.body as DemoState).events).toEqual([]);
    const stale = await browser.post("/demo/api/attacker/use-cookie").set("X-Demo-Token", token).send({ cookie }).expect(200);
    expect((stale.body as DemoState).attacker.status).toBe("denied");
    await browser.post("/demo/api/session/login").set("X-Demo-Token", token)
      .send({ username: "alice-a", password: system.config.sites[0]!.password }).expect(200);
    await browser.post("/demo/api/session/reset").set("X-Demo-Token", token).send({}).expect(200);
  });

  it("rejects a wrong cookie via real 401 even while the victim is authenticated; supports current raw token", async () => {
    const { browser, data } = await login();
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      const wrong = await browser.post("/demo/api/attacker/use-cookie").set("X-Demo-Token", token)
        .send({ cookie: "sid_site_a=does-not-exist" }).expect(200);
      expect((wrong.body as DemoState).attacker.status).toBe("denied");
      expect(spy.mock.calls[0]?.[1]?.headers).toEqual({ Cookie: "sid_site_a=does-not-exist" });
    } finally { spy.mockRestore(); }
    const raw = await browser.post("/demo/api/attacker/use-cookie").set("X-Demo-Token", token)
      .send({ cookie: data.cookies!.sid_site_a }).expect(200);
    expect((raw.body as DemoState).attacker.status).toBe("success");
    await browser.post("/demo/api/session/reset").set("X-Demo-Token", token).send({}).expect(200);
  });

  it("never calls any upstream for foreign decoys, malformed input or rejected requests", async () => {
    const { browser } = await login();
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      await browser.post("/demo/api/attacker/use-cookie").set("X-Demo-Token", token).send({ cookie: "decoy_site_a=unknown" }).expect(400);
      for (const cookie of ["", "other=value", "sid_site_a=x; decoy_site_a=y", "sid_site_a=x\r\nAuthorization: secret", "https://example.com"]) {
        const response = await browser.post("/demo/api/attacker/use-cookie").set("X-Demo-Token", token).send({ cookie }).expect(200);
        expect((response.body as DemoState).attacker.status).toBe("invalid");
      }
      await browser.post("/demo/api/attacker/use-cookie").set("X-Demo-Token", token).send({ cookie: "sid_site_a=x", url: "http://example.com" }).expect(400);
      await browser.post("/demo/api/attacker/use-cookie").send({ cookie: "sid_site_a=x" }).expect(403);
      await browser.post("/demo/api/attacker/use-cookie").set("X-Demo-Token", token).set("Sec-Fetch-Site", "cross-site").send({ cookie: "sid_site_a=x" }).expect(403);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
    expect(detectionCount()).toBe(0);
    const state = await browser.get("/demo/api/session").set("X-Demo-Token", token).expect(200);
    expect((state.body as DemoState).services.every((site) => site.status === "logged-in")).toBe(true);
    await browser.post("/demo/api/session/reset").set("X-Demo-Token", token).send({}).expect(200);
  });

  it("uses only a pasted named cookie in a separate browser context and distinguishes connection failure", async () => {
    const { browser, data } = await login();
    const attacker = request.agent(system.demo);
    const response = await attacker.post("/demo/api/attacker/use-cookie").set("X-Demo-Token", token)
      .send({ cookie: `sid_site_a=${data.cookies!.sid_site_a}` }).expect(200);
    expect((response.body as DemoState).attacker).toMatchObject({ status: "success", username: "alice-a", sameSession: false });
    const originalUrl = system.config.sites[0]!.baseUrl;
    system.config.sites[0]!.baseUrl = "http://127.0.0.1:1";
    try {
      const failed = await attacker.post("/demo/api/attacker/use-cookie").set("X-Demo-Token", token)
        .send({ cookie: `sid_site_a=${data.cookies!.sid_site_a}` }).expect(200);
      expect((failed.body as DemoState).attacker.status).toBe("unavailable");
    } finally { system.config.sites[0]!.baseUrl = originalUrl; }
    await browser.post("/demo/api/session/reset").set("X-Demo-Token", token).send({}).expect(200);
    await attacker.post("/demo/api/session/reset").set("X-Demo-Token", token).send({}).expect(200);
  });
});
