import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoSystem } from "./helpers/demo-system.js";

interface Snapshot {
  username: string | null;
  hasSession: boolean;
  cookies: { sid_site_a: string; decoy_site_a: string } | null;
  services: Array<{ id: string; status: string }>;
  events: Array<{ at: string; message: string }>;
  warning?: string;
}
describe("Phase 1: real user login, visible cookies and safe reset", () => {
  let system: Awaited<ReturnType<typeof startDemoSystem>>;
  let token: string;
  beforeAll(async () => {
    system = await startDemoSystem();
    const page = await request(system.demo).get("/demo");
    token = /name="demo-token" content="([a-f0-9]+)"/u.exec(page.text)![1]!;
  }, 20000);
  afterAll(async () => { await system?.close(); });

  it("authenticates, displays real HttpOnly cookies, restores, resets and repeats without detections", async () => {
    const browser = request.agent(system.demo);
    const initial = await browser.get("/demo/api/session").set("X-Demo-Token", token).expect(200);
    expect((initial.body as Snapshot).services.every((s) => s.status === "signed-out")).toBe(true);
    const oldTokens: string[] = [];
    for (let round = 0; round < 2; round += 1) {
      const login = await browser.post("/demo/api/session/login").set("X-Demo-Token", token)
        .send({ username: "alice-a", password: system.config.sites[0]!.password }).expect(200);
      const data = login.body as Snapshot;
      expect(data.username).toBe("alice-a"); expect(data.hasSession).toBe(true);
      expect(data.services.every((s) => s.status === "logged-in")).toBe(true);
      expect(data.cookies?.sid_site_a).toMatch(/^[A-Za-z0-9_-]+$/u);
      expect(data.cookies?.decoy_site_a).toMatch(/^[A-Za-z0-9_-]+$/u);
      expect(data.cookies?.sid_site_a).not.toBe(data.cookies?.decoy_site_a);
      const headers = login.headers["set-cookie"] as unknown as string[];
      for (const [name, value] of Object.entries(data.cookies!)) {
        expect(headers.some((header) => header.startsWith(`${name}=${value};`) && header.includes("HttpOnly"))).toBe(true);
      }
      expect(data.events).toHaveLength(7);
      expect(data.events.every((event) => Number.isFinite(Date.parse(event.at)))).toBe(true);
      expect(JSON.stringify(data.events)).not.toContain(data.cookies!.sid_site_a);
      const originalCookies = headers.map((header) => header.split(";")[0]!);
      for (const site of system.config.sites) {
        await request(system.demo).get(`/demo/proxy/${site.id}/protected`).set("X-Demo-Token", token)
          .set("Cookie", originalCookies).expect(200);
      }
      // Reloading the page retains only the opaque context cookie, then re-probes the Sites.
      await browser.get("/demo").expect(200);
      const restored = await browser.get("/demo/api/session").set("X-Demo-Token", token).expect(200);
      expect((restored.body as Snapshot).cookies).toEqual(data.cookies);
      expect((restored.body as Snapshot).services.every((s) => s.status === "logged-in")).toBe(true);
      await browser.post("/demo/api/session/login").set("X-Demo-Token", token)
        .send({ username: "alice-a", password: system.config.sites[0]!.password }).expect(409);
      oldTokens.push(data.cookies!.sid_site_a);
      const reset = await browser.post("/demo/api/session/reset").set("X-Demo-Token", token).send({}).expect(200);
      expect((reset.body as Snapshot).cookies).toBeNull(); expect((reset.body as Snapshot).events).toEqual([]);
      expect((reset.body as Snapshot).hasSession).toBe(false);
      for (const site of system.config.sites) {
        await request(system.demo).get(`/demo/proxy/${site.id}/protected`).set("X-Demo-Token", token)
          .set("Cookie", originalCookies).expect(401);
      }
    }
    expect(new Set(oldTokens).size).toBe(2);
    const detections = system.manager.database.prepare("SELECT COUNT(*) AS count FROM detection_events").get() as { count: number };
    expect(detections.count).toBe(0);
    const mapping = await request(system.demo).get("/demo/proxy/management/api/v1/mappings/demo-principal-001").set("X-Demo-Token", token).expect(200);
    expect((mapping.body as { services: unknown[] }).services).toEqual([
      { serviceId: "site-a", localUserId: "user-a-001" },
    ]);
  }, 20000);

  it("rejects wrong credentials without creating sessions or exposing credentials", async () => {
    const browser = request.agent(system.demo);
    const result = await browser.post("/demo/api/session/login").set("X-Demo-Token", token)
      .send({ username: "alice-a", password: "incorrect-password" }).expect(401);
    expect(result.text).toContain("ユーザー名またはパスワード"); expect(result.text).not.toContain("incorrect-password");
    const state = await browser.get("/demo/api/session").set("X-Demo-Token", token).expect(200);
    expect((state.body as Snapshot).cookies).toBeNull();
    expect((state.body as Snapshot).services.every((s) => s.status === "signed-out")).toBe(true);
  });

  it("isolates browser contexts and protects new endpoints", async () => {
    const first = request.agent(system.demo); const second = request.agent(system.demo);
    await first.post("/demo/api/session/login").set("X-Demo-Token", token)
      .send({ username: "alice-a", password: system.config.sites[0]!.password }).expect(200);
    const other = await second.get("/demo/api/session").set("X-Demo-Token", token).expect(200);
    expect((other.body as Snapshot).cookies).toBeNull(); expect((other.body as Snapshot).hasSession).toBe(false);
    await request(system.demo).get("/demo/api/session").expect(403);
    await first.post("/demo/api/session/reset").set("X-Demo-Token", token).set("Sec-Fetch-Site", "cross-site").send({}).expect(403);
    await first.post("/demo/api/session/reset").set("X-Demo-Token", token).send({}).expect(200);
    await request(system.demo).get("/demo/evaluation").expect(200);
  });

  it("reports partial login and unreachable services, retaining reset information for retry", async () => {
    const browser = request.agent(system.demo);
    const site = system.config.sites[2]!;
    const baseUrl = site.baseUrl;
    site.baseUrl = "http://127.0.0.1:1";
    try {
      const response = await browser.post("/demo/api/session/login").set("X-Demo-Token", token)
        .send({ username: "alice-a", password: system.config.sites[0]!.password }).expect(200);
      const data = response.body as Snapshot;
      expect(data.warning).toBeTruthy();
      expect(data.services.find((s) => s.id === "site-c")?.status).toBe("unknown");
      expect(data.services.find((s) => s.id === "site-a")?.status).toBe("logged-in");
    } finally { site.baseUrl = baseUrl; }
    const a = system.config.sites[0]!; const aUrl = a.baseUrl;
    a.baseUrl = "http://127.0.0.1:1";
    try {
      await browser.post("/demo/api/session/reset").set("X-Demo-Token", token).send({}).expect(502);
      const state = await browser.get("/demo/api/session").set("X-Demo-Token", token).expect(200);
      expect((state.body as Snapshot).hasSession).toBe(true);
    } finally { a.baseUrl = aUrl; }
    await browser.post("/demo/api/session/reset").set("X-Demo-Token", token).send({}).expect(200);
  }, 15000);
});
