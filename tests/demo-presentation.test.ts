import request from "supertest";
import { expect, it } from "vitest";
import { startDemoSystem } from "./helpers/demo-system.js";

interface PresentationState {
  cookies: { sid_site_a: string; decoy_site_a: string } | null;
  stolenCookies: { sid_site_a: string; decoy_site_a: string } | null;
  services: Array<{ status: string }>;
  attacker: { status: string; username: string; sameSession: boolean };
  revocation: { complete: boolean; revokedCount: number };
  events: unknown[];
}

it("shares the three presentation pages and completes the real stolen-cookie flow", async () => {
  const system = await startDemoSystem();
  try {
    const browser = request.agent(system.demo);
    const page = await browser.get("/demo").expect(200);
    const token = /name="demo-token" content="([a-f0-9]+)"/u.exec(page.text)![1]!;
    for (const role of ["user", "attacker"]) {
      const result = await browser.get("/demo/" + role).expect(200);
      expect(result.text).toContain('data-role="' + role + '"');
    }
    const post = (path: string, body = {}) => browser.post("/demo/api/" + path).set("X-Demo-Token", token).send(body);
    await post("attacker/steal").expect(409);
    const login = await post("session/login-site-a", { username: "alice-a", password: system.config.sites[0]!.password }).expect(200);
    const loginState = login.body as PresentationState;
    expect(loginState.services.filter((s) => s.status === "logged-in")).toHaveLength(1);
    const remaining = await post("session/login-remaining").expect(200);
    expect((remaining.body as PresentationState).services.every((s) => s.status === "logged-in")).toBe(true);
    const stolen = await post("attacker/steal").expect(200);
    const stolenState = stolen.body as PresentationState;
    expect(stolenState.stolenCookies).toEqual(loginState.cookies);
    await browser.get("/demo/attacker").expect(200);
    const restored = await browser.get("/demo/api/session").set("X-Demo-Token", token).expect(200);
    expect((restored.body as PresentationState).stolenCookies).toEqual(stolenState.stolenCookies);
    const real = "sid_site_a=" + stolenState.stolenCookies!.sid_site_a;
    const attack = await post("attacker/use-cookie", { cookie: real }).expect(200);
    expect((attack.body as PresentationState).attacker).toMatchObject({ status: "success", username: "alice-a", sameSession: true });
    const revoked = await post("attacker/use-cookie", { cookie: "decoy_site_a=" + stolenState.stolenCookies!.decoy_site_a }).expect(200);
    expect((revoked.body as PresentationState).revocation).toMatchObject({ complete: true, revokedCount: 4 });
    const denied = await post("attacker/use-cookie", { cookie: real }).expect(200);
    expect((denied.body as PresentationState).attacker.status).toBe("denied");
    const reset = await post("session/reset").expect(200);
    expect((reset.body as PresentationState).stolenCookies).toBeNull();
    expect((reset.body as PresentationState).events).toEqual([]);
    await post("session/login-site-a", { username: "alice-a", password: system.config.sites[0]!.password }).expect(200);
    await post("session/reset").expect(200);
  } finally { await system.close(); }
}, 30000);
