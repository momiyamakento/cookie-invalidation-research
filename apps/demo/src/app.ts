import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import express, { type Response } from "express";
import { parse as parseCookie } from "cookie";
import type { DemoConfig } from "./config.js";
import { createEvaluationRouter, type Executor } from "./evaluation.js";
import { createDemoRouters } from "./demo-routes.js";

/** An allowlisted same-origin bridge. Research servers retain all state and logic. */
export function createDemoApp(config: DemoConfig, evaluationExecutor?: Executor) {
  const app = express();
  const csrfToken = randomBytes(32).toString("hex");
  app.disable("x-powered-by");
  app.set("view engine", "ejs");
  app.set("views", fileURLToPath(new URL("./views", import.meta.url)));
  app.use((req, res, next) => {
    if (!["localhost", "127.0.0.1", "[::1]"].includes(req.hostname)) { res.sendStatus(403); return; }
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    next();
  });
  const render = (view: "victim" | "attacker") => (_req: express.Request, res: express.Response) => {
    res.set("Cache-Control", "no-store").render(view, { csrfToken });
  };
  app.get("/", (req, res) => res.redirect(req.socket.localPort === config.attackerPort ? "/attacker" : "/victim"));
  app.get("/victim", render("victim"));
  app.get("/cloud-drive", (_req, res) => res.render("cloud-drive", { csrfToken }));
  app.get("/attacker", render("attacker"));
  app.get("/demo", render("victim"));
  app.get("/demo/dashboard", render("victim"));
  app.get("/demo/user", render("victim"));
  app.get("/demo/attacker", render("attacker"));
  app.get("/demo/evaluation", (_req, res) => res.render("evaluation", { csrfToken }));
  const demoRouters = createDemoRouters(config);
  for (const [path, router] of Object.entries(demoRouters)) app.use(`/demo/api/${path}`, (req, res, next) => {
    if (req.header("X-Demo-Token") !== csrfToken || req.header("Sec-Fetch-Site") === "cross-site") {
      res.status(403).json({ error: "デモ画面を再読み込みしてください。" }); return;
    }
    next();
  }, express.json({ limit: "8kb", strict: true }), router);
  app.use("/demo/api/evaluations", (req, res, next) => {
    if (req.header("X-Demo-Token") !== csrfToken || req.header("Sec-Fetch-Site") === "cross-site") {
      res.status(403).json({ error: "デモ画面を再読み込みしてください。" }); return;
    }
    next();
  }, express.json({ limit: "2kb", strict: true }), createEvaluationRouter(evaluationExecutor));
  app.use("/demo/assets", express.static(fileURLToPath(new URL("../public", import.meta.url))));
  app.use("/demo/proxy", (req, res, next) => {
    const localProtectedPage = req.method === "GET" && req.path === "/site-a/protected";
    if (!localProtectedPage && (req.header("X-Demo-Token") !== csrfToken || req.header("Sec-Fetch-Site") === "cross-site")) {
      res.status(403).json({ error: "デモ画面を再読み込みしてください。" }); return;
    }
    next();
  });
  async function forward(res: Response, url: string, init: RequestInit, cookiePrefix?: string) {
    try {
      const upstream = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(15_000) });
      if (cookiePrefix !== undefined) {
        const cookies = upstream.headers.getSetCookie().map((cookie) => cookie.replace(/;\s*Path=([^;]*)/iu, (_match, path: string) => `; Path=${cookiePrefix}${path}`));
        if (cookies.length) res.setHeader("Set-Cookie", cookies);
      }
      // Login/logout redirect bodies are not needed by fetch; cookies are preserved.
      if ([302, 303].includes(upstream.status)) { await upstream.body?.cancel(); res.sendStatus(204); return; }
      const body = await upstream.text();
      res.status(upstream.status).type(upstream.headers.get("content-type") ?? "text/plain").send(body);
    } catch {
      res.status(502).json({ error: "接続できません。対象サーバーの起動状態を確認してください。" });
    }
  }
  app.all(/^\/demo\/proxy\/(site-[abcd])(\/.*)$/u, async (req, res) => {
    const site = config.sites.find((s) => s.id === req.params[0]);
    const path = req.params[1] ?? "";
    if (site === undefined || !(["GET /health", "GET /protected", "POST /login", "POST /logout"].includes(`${req.method} ${path}`) || (site.id === "site-a" && req.method === "GET" && path === "/__research/decoy-use"))) { res.sendStatus(404); return; }
    const parsed = parseCookie(req.headers.cookie ?? "");
    const cookieNames = path === "/__research/decoy-use" ? [site.decoyCookie] : [site.sessionCookie];
    const cookies = cookieNames.filter((name) => parsed[name] !== undefined).map((name) => `${name}=${encodeURIComponent(parsed[name]!)}`).join("; ");
    const init: RequestInit = { method: req.method, headers: { Cookie: cookies } };
    if (path === "/login") {
      if (!site.password) { res.status(503).json({ error: `${site.name} のSEED_PASSWORDが未設定です。` }); return; }
      init.body = new URLSearchParams({ username: site.username, password: site.password });
    }
    await forward(res, `${site.baseUrl}${path}`, init, `/demo/proxy/${site.id}`);
  });
  app.get(/^\/demo\/proxy\/management(\/.*)$/u, async (req, res) => {
    const path = req.params[0] ?? "";
    if (!(path === "/health" || /^\/api\/v1\/detections\/[0-9a-f-]{36}$/iu.test(path) || path === "/api/v1/mappings/resolve" || /^\/api\/v1\/mappings\/[a-z0-9_-]+$/iu.test(path))) { res.sendStatus(404); return; }
    const query = new URLSearchParams();
    if (path === "/api/v1/mappings/resolve") {
      query.set("serviceId", "site-a"); query.set("localUserId", "user-a-001");
    }
    const init: RequestInit = { method: "GET" };
    if (path !== "/health") {
      init.headers = { Authorization: `Bearer ${config.managementAuthTokens["site-a"] ?? ""}` };
    }
    await forward(res, `${config.managementBaseUrl}${path}${query.size ? `?${query.toString()}` : ""}`, init);
  });
  return app;
}
