import request from "supertest";
import { expect, it } from "vitest";
import { startDemoSystem } from "./helpers/demo-system.js";

it.each(["site-a", "site-b", "site-c"])("Cloud Drive accepts arbitrary demo credentials and loses access after a decoy is used on %s", async (source) => {
  const system = await startDemoSystem();
  try {
    const browser = request.agent(system.demo);
    const page = await browser.get("/cloud-drive").expect(200);
    expect(page.text).toContain('type="password"');
    const token = /name="demo-token" content="([a-f0-9]+)"/u.exec(page.text)![1]!;
    const post = (path: string, body = {}) => browser.post(`/demo/api/session/${path}`).set("X-Demo-Token", token).send(body);
    const get = () => browser.get("/demo/api/session/cloud-drive").set("X-Demo-Token", token);
    expect(((await get()).body as { files: string[] }).files).toEqual([]);
    await post("login-site-b", { username: "", password: "" }).expect(400);
    await post("login-site-a", { username: "demo", password: "demo" }).expect(200);
    const automatic = await post("login-automatic").expect(200);
    expect((automatic.body as { services: Array<{ id: string; status: string }> }).services.find((s) => s.id === "site-b")?.status).toBe("signed-out");
    const login = await post("login-site-b", { username: "発表用ユーザー", password: "anything" }).expect(200);
    expect(((await get()).body as { files: string[] }).files).toHaveLength(3);
    expect((await get()).body).toMatchObject({ username: "発表用ユーザー" });
    const site = system.config.sites.find((entry) => entry.id === source)!;
    const directLogin = await fetch(`${site.baseUrl}/login`, { method: "POST", redirect: "manual", body: new URLSearchParams({ username: site.username, password: site.password }) });
    const cookie = directLogin.headers.getSetCookie().find((value) => value.startsWith(`${site.decoyCookie}=`))!.split(";")[0]!;
    await directLogin.body?.cancel();
    const detection = await fetch(`${site.baseUrl}/__research/decoy-use`, { headers: { Cookie: cookie } });
    expect(detection.status).toBe(200);
    await detection.body?.cancel();
    expect((await get()).body).toMatchObject({ status: "signed-out", expired: true, files: [] });
    const b = system.config.sites.find((entry) => entry.id === "site-b")!;
    const stolen = (login.headers["set-cookie"] as unknown as string[]).find((value) => value.startsWith(`${b.sessionCookie}=`))!.split(";")[0]!;
    const replay = await fetch(`${b.baseUrl}/protected`, { headers: { Cookie: stolen } });
    expect(replay.status).toBe(401);
    await replay.body?.cancel();
    await post("reset").expect(200);
    await post("login-site-b", { username: "発表用ユーザー", password: "anything" }).expect(200);
    await post("login-site-a", { username: "demo", password: "demo" }).expect(200);
  } finally { await system.close(); }
}, 30_000);
