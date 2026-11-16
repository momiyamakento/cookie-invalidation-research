import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoSystem } from "./helpers/demo-system.js";
import { createDemoApp } from "../apps/demo/src/app.js";
import { loadDemoConfig } from "../apps/demo/src/config.js";

function cookieValues(response: { headers: Record<string, unknown> }): string[] {
  const values = response.headers["set-cookie"];
  return Array.isArray(values) ? (values as string[]).map((value) => value.split(";")[0]!) : [];
}

describe("demo dashboard with the real A/B/C/D and Management servers", () => {
  let system: Awaited<ReturnType<typeof startDemoSystem>>;
  let token: string;
  beforeAll(async () => {
    system = await startDemoSystem();
    const page = await request(system.demo).get("/demo").expect(200);
    token = /name="demo-token" content="([a-f0-9]+)"/u.exec(page.text)![1]!;
  }, 20000);
  afterAll(async () => { await system?.close(); });

  it("renders a single EJS dashboard with all controls and no passwords", async () => {
    const page = await request(system.demo).get("/demo").expect(200);
    for (const text of ["全体ダッシュボード", "Site A", "Site B", "Site C", "Site D", "デモを最初から", "利用者", "攻撃者", "実験の記録を見る", "/demo/user", "/demo/attacker"]) expect(page.text).toContain(text);
    expect(page.text).not.toContain(system.config.sites[0]!.password);
    expect(page.headers["cache-control"]).toBe("no-store");
    await request(system.demo).get("/demo/assets/demo.js").expect(200);
    await request(system.demo).get("/demo/assets/demo.css").expect(200);
  });

  it("rejects cross-site requests, missing tokens, unknown routes and Management writes", async () => {
    await request(system.demo).get("/demo").set("Host", "evil.example").expect(403);
    await request(system.demo).post("/demo/proxy/site-a/login").expect(403);
    await request(system.demo).get("/demo/proxy/site-a/__research/decoy-use").expect(403);
    await request(system.demo).post("/demo/proxy/site-a/login").set("X-Demo-Token", token).set("Sec-Fetch-Site", "cross-site").expect(403);
    await request(system.demo).get("/demo/proxy/site-a/arbitrary").set("X-Demo-Token", token).expect(404);
    await request(system.demo).post("/demo/proxy/management/api/v1/detections").set("X-Demo-Token", token).expect(404);
  });

  it("logs in, detects the real decoy, revokes all four sessions, logs out and repeats", async () => {
    const eventIds: string[] = [];
    for (let round = 0; round < 2; round += 1) {
      const cookies = new Map<string, string[]>();
      for (const site of system.config.sites) {
        const prefix = `/demo/proxy/${site.id}`;
        await request(system.demo).get(`${prefix}/protected`).set("X-Demo-Token", token).expect(401);
        const login = await request(system.demo).post(`${prefix}/login`).set("X-Demo-Token", token).expect(204);
        const headers = login.headers["set-cookie"] as unknown as string[];
        expect(headers.some((h) => h.startsWith(`${site.sessionCookie}=`) && h.includes(`Path=${prefix}/`) && h.includes("HttpOnly"))).toBe(true);
        if (site.id === "site-a") expect(headers.some((h) => h.startsWith("decoy_site_a=") && h.includes(`Path=${prefix}/__research/decoy-use`))).toBe(true);
        cookies.set(site.id, cookieValues(login));
        await request(system.demo).get(`${prefix}/protected`).set("X-Demo-Token", token).set("Cookie", cookies.get(site.id)!).expect(200);
      }
      const detectionResponse = await request(system.demo).get("/demo/proxy/site-a/__research/decoy-use").set("X-Demo-Token", token).set("Cookie", cookies.get("site-a")!).expect(200);
      const detection = detectionResponse.body as { eventId: string; detected: boolean; notificationStatus: string; detectedAt: string };
      expect(detection.detected).toBe(true); expect(detection.notificationStatus).toBe("notified"); eventIds.push(detection.eventId);
      const snapshot = await request(system.demo).get(`/demo/proxy/management/api/v1/detections/${detection.eventId}`).set("X-Demo-Token", token).expect(200);
      const result = snapshot.body as { status: string; receivedAt: string; completedAt: string; totalDurationMs: number; invalidation: { targets: Array<{ serviceId: string; status: string; revokedCount: number }> } };
      expect(result.status).toBe("SUCCESS"); expect(result.invalidation.targets).toHaveLength(4);
      expect(result.invalidation.targets.every((t) => t.status === "SUCCESS" && t.revokedCount === 1)).toBe(true);
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(Date.parse(detection.detectedAt)).toBeLessThanOrEqual(Date.parse(result.receivedAt));
      expect(Date.parse(result.receivedAt)).toBeLessThanOrEqual(Date.parse(result.completedAt));
      for (const site of system.config.sites) {
        await request(system.demo).get(`/demo/proxy/${site.id}/protected`).set("X-Demo-Token", token).set("Cookie", cookies.get(site.id)!).expect(401);
        await request(system.demo).post(`/demo/proxy/${site.id}/logout`).set("X-Demo-Token", token).set("Cookie", cookies.get(site.id)!).expect(204);
      }
    }
    expect(new Set(eventIds).size).toBe(2);
  }, 20000);

  it("reset logs out active sessions through the existing logout routes", async () => {
    for (const site of system.config.sites) {
      const prefix = `/demo/proxy/${site.id}`;
      const login = await request(system.demo).post(`${prefix}/login`).set("X-Demo-Token", token).expect(204);
      const cookies = cookieValues(login);
      const logout = await request(system.demo).post(`${prefix}/logout`).set("X-Demo-Token", token).set("Cookie", cookies).expect(204);
      expect((logout.headers["set-cookie"] as unknown as string[]).some((h) => h.includes(`Path=${prefix}/`))).toBe(true);
      // Reuse the original cookie to verify server-side revocation, not just cookie deletion.
      await request(system.demo).get(`${prefix}/protected`).set("X-Demo-Token", token).set("Cookie", cookies).expect(401);
    }
  }, 10000);

  it("returns an actionable failure when credentials are absent", async () => {
    const app = createDemoApp(loadDemoConfig({}));
    const page = await request(app).get("/demo");
    const csrf = /name="demo-token" content="([a-f0-9]+)"/u.exec(page.text)![1]!;
    await request(app).post("/demo/proxy/site-d/login").set("X-Demo-Token", csrf).expect(503);
  });
});
