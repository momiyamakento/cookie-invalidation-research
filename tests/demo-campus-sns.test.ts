import request from "supertest";
import { expect, it } from "vitest";
import { startDemoSystem } from "./helpers/demo-system.js";

interface DemoState {
  profile: null | { username: string; handle: string; messages: unknown[]; drafts: unknown[] };
  stolenCookies: null | { sid_site_a: string; decoy_site_a: string };
  attacker: { status: string };
  revocation: { complete: boolean; managerStatus: string; revokedCount: number };
  services: Array<{ status: string }>;
}

it("accepts an arbitrary demo identity and completes the Campus SNS presentation flow", async () => {
  const system = await startDemoSystem();
  try {
    const browser = request.agent(system.demo);
    const victim = await browser.get("/victim").expect(200);
    for (const content of ["中間発表資料.pdf", "実験結果.csv", "研究メモ.docx", "ワイヤレスイヤホン", "デモ用住所", "情報セキュリティ", "進捗報告書"]) {
      expect(victim.text).toContain(content);
    }
    const token = /name="demo-token" content="([a-f0-9]+)"/u.exec(victim.text)![1]!;
    await browser.get("/attacker").expect(200);
    const post = (path: string, body = {}) => browser
      .post(`/demo/api/${path}`)
      .set("X-Demo-Token", token)
      .send(body);

    const login = await post("session/login-site-a", {
      username: "kento-presentation",
      password: "chosen-for-this-demo",
    }).expect(200);
    const loggedIn = login.body as DemoState;
    expect(loggedIn.profile).toMatchObject({
      username: "kento-presentation",
      handle: "@kento_presentation",
    });
    expect(loggedIn.profile?.messages).toHaveLength(2);
    expect(loggedIn.profile?.drafts).toHaveLength(3);

    await post("session/login-remaining").expect(200);
    const stolen = await post("attacker/steal").expect(200);
    const stolenState = stolen.body as DemoState;
    const realCookie = stolenState.stolenCookies!.sid_site_a;
    const decoyCookie = stolenState.stolenCookies!.decoy_site_a;

    const intrusion = await post("attacker/use-cookie", { cookie: realCookie }).expect(200);
    expect((intrusion.body as DemoState).attacker.status).toBe("success");

    const detection = await post("attacker/use-cookie", { cookie: decoyCookie }).expect(200);
    const detectedState = detection.body as DemoState;
    expect(detectedState.revocation).toMatchObject({ complete: true, managerStatus: "SUCCESS", revokedCount: 4 });
    expect(detectedState.services.every((service) => service.status === "revoked")).toBe(true);

    const expired = await post("attacker/use-cookie", { cookie: realCookie }).expect(200);
    expect((expired.body as DemoState).attacker.status).toBe("denied");
    const reset = await post("session/reset").expect(200);
    expect(reset.body as DemoState).toMatchObject({ profile: null, stolenCookies: null });
  } finally {
    await system.close();
  }
}, 30_000);

it("reproduces a stolen localhost session in a separate browser cookie jar", async () => {
  const system = await startDemoSystem();
  try {
    const victimBrowser = request.agent(system.demo);
    const victimPage = await victimBrowser.get("/victim").expect(200);
    const victimToken = /name="demo-token" content="([a-f0-9]+)"/u.exec(victimPage.text)![1]!;
    const victimPost = (path: string, body = {}) => victimBrowser.post(`/demo/api/${path}`).set("X-Demo-Token", victimToken).send(body);
    const victimGet = (path: string) => victimBrowser.get(`/demo/api/${path}`).set("X-Demo-Token", victimToken);
    await victimPost("session/login-site-a", { username: "separate-profile", password: "demo-password" }).expect(200);
    await victimPost("session/login-remaining").expect(200);
    const stolen = await victimPost("attacker/steal").expect(200);
    const tokens = (stolen.body as DemoState).stolenCookies!;

    const attackerBrowser = request.agent(system.demo);
    const attackerPage = await attackerBrowser.get("/attacker").expect(200);
    const attackerToken = /name="demo-token" content="([a-f0-9]+)"/u.exec(attackerPage.text)![1]!;
    const attackerPost = (path: string, body = {}) => attackerBrowser.post(`/demo/api/${path}`).set("X-Demo-Token", attackerToken).send(body);

    const imported = await attackerPost("attacker/use-cookie", { cookie: `sid_site_a=${tokens.sid_site_a}` }).expect(200);
    expect((imported.body as DemoState).attacker.status).toBe("success");
    expect(String(imported.headers["set-cookie"])).toContain("sid_site_a=");
    await attackerBrowser.get("/demo/proxy/site-a/protected").expect(200);

    const detected = await attackerPost("attacker/use-cookie", { cookie: `decoy_site_a=${tokens.decoy_site_a}` }).expect(200);
    expect((detected.body as DemoState).revocation).toMatchObject({ complete: true, revokedCount: 4 });
    const victimAfterDetection = await victimGet("session").expect(200);
    expect((victimAfterDetection.body as DemoState).services.every((service) => service.status === "revoked")).toBe(true);
    await attackerBrowser.get("/demo/proxy/site-a/protected").expect(401);
  } finally {
    await system.close();
  }
}, 30_000);
