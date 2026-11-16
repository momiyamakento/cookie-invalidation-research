import { Router, type Response, type RequestHandler } from "express";
import { parse as parseCookie } from "cookie";
import type { DemoConfig, DemoSite } from "./config.js";
import { createDemoSessionStore, emptyAttacker, emptyRevocation, type DemoSession } from "./demo-session.js";
import { useDecoy, readRevocation, revocationEvent } from "./demo-revocation.js";

type SiteState = { id: string; status: "logged-in" | "signed-out" | "unknown" | "revoked"; checkedAt: string };
const contextCookie = "demo_session";
const contextOptions = { httpOnly: true, sameSite: "strict" as const, path: "/demo/api" };
const importedSiteCookieOptions = { httpOnly: true, sameSite: "lax" as const, secure: false, path: "/demo/proxy/site-a" };

export function createDemoRouters(config: DemoConfig) {
  const router = Router();
  const attackerRouter = Router();
  const store = createDemoSessionStore();
  const siteA = config.sites.find((site) => site.id === "site-a")!;
  function attackerView(session: DemoSession) {
    const { status, succeededAt, username, sameSession } = session.attacker;
    return { status, succeededAt, username, sameSession };
  }
  function record(session: DemoSession, message: string) {
    session.events.push({ at: new Date().toISOString(), message });
    session.events = session.events.slice(-80);
  }
  async function upstream(site: DemoSite, path: string, init: RequestInit = {}) {
    return await fetch(`${site.baseUrl}${path}`, { ...init, redirect: "manual", signal: AbortSignal.timeout(5000) });
  }
  function auth(session: DemoSession, site: DemoSite) {
    const value = session.cookies[site.id]?.[site.sessionCookie];
    return value === undefined ? "" : `${site.sessionCookie}=${encodeURIComponent(value)}`;
  }
  function importOwnerSession(target: DemoSession, owner: DemoSession) {
    target.username = owner.username;
    target.cookies = Object.fromEntries(Object.entries(owner.cookies).map(([id, jar]) => [id, { ...jar }]));
    if (owner.cookies[siteA.id] === undefined) delete target.stolenCookies;
    else target.stolenCookies = { ...owner.cookies[siteA.id] };
  }
  async function probe(session: DemoSession, site: DemoSite): Promise<SiteState> {
    let status: SiteState["status"] = "unknown";
    try {
      const response = await upstream(site, "/protected", { headers: { Cookie: auth(session, site) } });
      await response.body?.cancel();
      status = response.status === 200 ? "logged-in" : response.status === 401 ? "signed-out" : "unknown";
    } catch { /* A transport failure is not a logout. */ }
    return { id: site.id, status, checkedAt: new Date().toISOString() };
  }
  async function snapshot(session: DemoSession) {
    await readRevocation(config, session);
    const services = await Promise.all(config.sites.map((site) => probe(session, site)));
    const revocation = session.revocation;
    for (const service of services) {
      const definition = config.sites.find((site) => site.id === service.id)!;
      if (service.status === "signed-out" && session.cookies[service.id]?.[definition.sessionCookie] &&
        !revocation.error && revocation.targets.some((target) => target.serviceId === service.id && target.localUserId === definition.localUserId && target.status === "SUCCESS")) {
        service.status = "revoked";
        revocationEvent(session, `${revocation.eventId}:${service.id}:revoked`, `${definition.name.replace("Site", "Service")}の失効を確認（元のCookieで401）`, service.checkedAt);
      }
    }
    if (revocation.attempted && session.attacker.successfulCookie) {
      try {
        const response = await upstream(siteA, "/protected", { method: "GET", headers: { Cookie: `sid_site_a=${session.attacker.successfulCookie}` } });
        await response.body?.cancel();
        session.attacker.status = response.status === 401 ? "revoked" : response.status === 200 ? "success" : "unavailable";
        if (response.status === 401) revocationEvent(session, `${revocation.eventId}:attacker-revoked`, "攻撃者が保持していた本物Cookieもアクセス不可（再使用で401）");
      } catch { session.attacker.status = "unavailable"; }
    }
    const complete = !revocation.error && revocation.managerStatus === "SUCCESS" && revocation.targets.length === config.sites.length &&
      config.sites.every((site) => revocation.targets.some((target) =>
        target.serviceId === site.id && target.localUserId === site.localUserId && target.status === "SUCCESS")) &&
      services.every((site) => site.status === "revoked" || site.status === "signed-out");
    const active = services.find((site) => site.id === "site-a")?.status === "logged-in";
    const username = session.username;
    const profile = username === null ? null : {
      username,
      handle: `@${username.replace(/[^a-zA-Z0-9_]/gu, "_").toLowerCase() || "student"}`,
      email: `${username.replace(/[^a-zA-Z0-9]/gu, ".").toLowerCase() || "student"}@campus.example.jp`,
      bio: "情報工学科。卒業研究とWebセキュリティについて勉強中。",
      timeline: [
        { author: "Campus Library", text: "今週の開館時間を更新しました。" },
        { author: "研究室メンバー", text: "中間発表のリハーサルは金曜日です。" },
        { author: username, text: "実験環境の確認が終わりました。" },
      ],
      messages: [
        { from: "佐藤", text: "明日のゼミ資料、共有フォルダに置いておきました。" },
        { from: "田中", text: "研究室の打ち合わせは14:30からです。" },
      ],
      drafts: ["卒業研究の進捗メモ", "デモ環境完成", "追加評価を実施"],
      saved: "Webセキュリティ演習 — 第6回資料",
    };
    return { username, profile, stolenCookies: session.stolenCookies ?? null, services, events: session.events, attacker: attackerView(session),
      revocation: { ...revocation, complete, revokedCount: services.filter((site) => site.status === "revoked").length },
      hasSession: Object.keys(session.cookies).length > 0,
      cookies: active ? {
        sid_site_a: session.cookies[siteA.id]?.[siteA.sessionCookie] ?? null,
        decoy_site_a: session.cookies[siteA.id]?.[siteA.decoyCookie] ?? null,
      } : null };
  }
  async function checkMapping() {
    const get = async (path: string, serviceId: string): Promise<unknown> => {
      const response = await fetch(`${config.managementBaseUrl}${path}`, {
        headers: { Authorization: `Bearer ${config.managementAuthTokens[serviceId] ?? ""}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("mapping");
      return await response.json();
    };
    let principalId: string | undefined;
    for (const site of config.sites) {
      const identity = await get(`/api/v1/mappings/resolve?serviceId=${encodeURIComponent(site.id)}&localUserId=${encodeURIComponent(site.localUserId)}`, site.id);
      if (typeof identity !== "object" || identity === null || !("principalId" in identity) || typeof identity.principalId !== "string") throw new Error("mapping");
      if (principalId !== undefined && identity.principalId !== principalId) throw new Error("mapping");
      principalId = identity.principalId;
      const mapped = await get(`/api/v1/mappings/${encodeURIComponent(principalId)}`, site.id);
      if (typeof mapped !== "object" || mapped === null || !("services" in mapped) || !Array.isArray(mapped.services)) throw new Error("mapping");
      const services: unknown[] = mapped.services;
      if (services.length !== 1 || !services.some((entry) => typeof entry === "object" && entry !== null &&
          "serviceId" in entry && "localUserId" in entry && entry.serviceId === site.id && entry.localUserId === site.localUserId)) throw new Error("mapping");
    }
  }
  async function loginSite(session: DemoSession, site: DemoSite, username: string, password: string, res: Response) {
    const response = await upstream(site, "/login", { method: "POST", body: new URLSearchParams({ username, password }) });
    const headers = response.headers.getSetCookie();
    await response.body?.cancel();
    if (response.status === 401) return "invalid";
    if (![302, 303].includes(response.status)) return "failed";
    const jar: Record<string, string> = {};
    for (const header of headers) {
      const parsed = parseCookie(header.split(";")[0] ?? "");
      for (const name of [site.sessionCookie, site.decoyCookie]) {
        const value = parsed[name];
        if (value !== undefined) jar[name] = value;
      }
      if ([site.sessionCookie, site.decoyCookie].some((name) => header.startsWith(`${name}=`))) {
        res.append("Set-Cookie", header.replace(/;\s*Path=([^;]*)/iu, (_match, path: string) => `; Path=/demo/proxy/${site.id}${path}`));
      }
    }
    session.cookies[site.id] = jar;
    if (site.id === "site-a") session.username = username;
    const checked = await probe(session, site);
    if (checked.status !== "logged-in") return "failed";
    record(session, `${site.name.replace("Site", "Service")}へログイン（保護ページで確認）`);
    if (site.id === "site-a") {
      if (jar[site.sessionCookie]) record(session, "本物Cookieの発行を確認（ログイン応答）");
      if (jar[site.decoyCookie]) record(session, "囮Cookieの発行を確認（ログイン応答）");
    }
    return jar[site.sessionCookie] && (site.id !== "site-a" || jar[site.decoyCookie]) ? "ok" : "failed";
  }
  const context: RequestHandler = (req, res, next) => {
    const id = parseCookie(req.headers.cookie ?? "")[contextCookie];
    let session = store.get(id);
    if (session === undefined) {
      const created = store.create(); session = created.session;
      res.cookie(contextCookie, created.id, contextOptions);
    }
    res.locals.demoSession = session;
    next();
  };
  router.use(context);
  attackerRouter.use(context);
  attackerRouter.post("/steal", async (_req, res) => {
    const session = res.locals.demoSession as DemoSession;
    if (session.busy) { res.status(409).json({ error: "別画面で処理中です。少し待って再実行してください。" }); return; }
    session.busy = true;
    try {
      if ((await probe(session, siteA)).status !== "logged-in") { res.status(409).json({ error: "先に利用者画面でログインしてください。" }); return; }
      session.stolenCookies = { ...session.cookies[siteA.id] };
      record(session, "攻撃者が利用者のCookieをコピーしました（デモ内の窃取シミュレーション）");
      res.json(await snapshot(session));
    } finally { session.busy = false; }
  });
  attackerRouter.post("/use-cookie", async (req, res) => {
    const session = res.locals.demoSession as DemoSession;
    if (session.busy) { res.status(409).json({ error: "処理中です。少し待ってから再実行してください。" }); return; }
    const body = req.body as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 1 ||
      !("cookie" in body) || typeof body.cookie !== "string" || body.cookie.length > 2048) {
      res.status(400).json({ error: "Cookieを1つだけ入力してください。" }); return;
    }
    const input = body.cookie.trim();
    // A single opaque token or name=value pair only; never accept multiple
    // cookies, header injection, URL parameters, or a caller-selected target.
    const pair = /^(sid_site_a|decoy_site_a)=([A-Za-z0-9_-]+)$/u.exec(input);
    const raw = /^[A-Za-z0-9_-]+$/u.test(input) ? input : null;
    const suppliedDecoy = pair?.[1] === "decoy_site_a" ? pair[2] : raw;
    const decoyOwner = suppliedDecoy === null || suppliedDecoy === undefined ? undefined :
      store.findByCookie(siteA.id, siteA.decoyCookie, suppliedDecoy);
    const isDecoy = pair?.[1] === "decoy_site_a" || decoyOwner !== undefined ||
      (raw !== null && raw === session.cookies[siteA.id]?.[siteA.decoyCookie]);
    if (isDecoy) {
      const decoy = suppliedDecoy;
      if (!decoy || decoyOwner === undefined || decoy !== decoyOwner.cookies[siteA.id]?.[siteA.decoyCookie]) {
        res.status(400).json({ error: "このデモのService Aへログインし、今回発行された囮Cookieを使用してください。" }); return;
      }
      importOwnerSession(session, decoyOwner);
      // Keep the originating browser's revocation state in sync as well.
      // Without this, a separate attacker profile revokes the real sessions
      // but the victim UI has no event id with which to label them "revoked".
      session.revocation = decoyOwner.revocation;
      session.busy = true;
      try {
        // Re-check the mapping before triggering the existing cross-service write.
        await checkMapping();
        await useDecoy(config, decoyOwner, decoy);
        res.json(await snapshot(session));
      } catch { res.status(503).json({ error: "同一利用者の対応付けを確認できません。Managementの接続と設定を確認してください。" }); }
      finally { session.busy = false; }
      return;
    }
    const value = pair?.[1] === "sid_site_a" ? pair[2] : raw;
    if (value === undefined || value === null) {
      session.attacker.status = "invalid";
      res.json({ attacker: attackerView(session), events: session.events }); return;
    }
    session.busy = true;
    try {
      record(session, "攻撃者が入力した本物Cookieを使用（パスワード送信なし）");
      // Deliberately isolated from auth(session, site), req.headers.cookie and
      // the victim's jar. Node fetch has no ambient browser cookie store.
      const response = await upstream(siteA, "/protected", {
        method: "GET", headers: { Cookie: `sid_site_a=${value}` },
      });
      const html = await response.text();
      if (response.status === 200) {
        const owner = store.findByCookie(siteA.id, siteA.sessionCookie, value);
        const sameSession = owner === session;
        if (owner !== undefined) importOwnerSession(session, owner);
        session.attacker.status = "success";
        session.attacker.successfulCookie = value;
        session.attacker.succeededAt = new Date().toISOString();
        session.attacker.sameSession = sameSession;
        res.cookie(siteA.sessionCookie, value, importedSiteCookieOptions);
        // The existing protected response is HTML. Extract text only, never
        // inject its HTML (or its logout form) into the demonstration page.
        const name = /<p>Logged in as ([^<]*)<\/p>/u.exec(html)?.[1];
        session.attacker.username = session.username ?? name?.replace(/&#39;|&quot;|&lt;|&gt;|&amp;/gu,
          (entity) => ({ "&#39;": "'", "&quot;": '"', "&lt;": "<", "&gt;": ">", "&amp;": "&" })[entity] ?? entity) ?? "認証済みユーザー";
        record(session, "Service Aの保護ページへのアクセス成功（HTTP 200）");
        record(session, "攻撃者がパスワードなしで利用者としてアクセス可能であることを確認");
      } else {
        session.attacker.status = response.status === 401 ? "denied" : "unavailable";
        record(session, response.status === 401 ? "このCookieではService Aへアクセスできません（HTTP 401）" : "攻撃者のアクセス結果を確認できませんでした");
      }
    } catch {
      session.attacker.status = "unavailable";
      record(session, "Service Aへ接続できず、攻撃者のアクセス結果を確認できませんでした");
    } finally { session.busy = false; }
    res.json({ attacker: attackerView(session), events: session.events });
  });
  router.get("/", async (_req, res) => {
    const session = res.locals.demoSession as DemoSession;
    if (session.busy) { res.status(409).json({ error: "処理中です。少し待ってから再確認してください。" }); return; }
    session.busy = true;
    try { res.json(await snapshot(session)); } finally { session.busy = false; }
  });
  router.post("/login", async (req, res) => {
    const session = res.locals.demoSession as DemoSession;
    if (session.busy || Object.keys(session.cookies).length) {
      res.status(409).json({ error: "処理中、またはログイン済みです。再ログインする場合はデモをリセットしてください。" }); return;
    }
    const body = req.body as unknown;
    if (typeof body !== "object" || body === null || !("username" in body) || !("password" in body) ||
      typeof body.username !== "string" || typeof body.password !== "string" || body.username.length > 128 || body.password.length > 1024 || !body.password) {
      res.status(400).json({ error: "ユーザー名とパスワードを入力してください。" }); return;
    }
    if (body.username.trim() !== siteA.username) {
      res.status(401).json({ error: "ログインに失敗しました。ユーザー名またはパスワードを確認してください。" }); return;
    }
    session.busy = true;
    try {
      try { await checkMapping(); } catch {
        res.status(503).json({ error: "同一利用者のサービス対応を確認できません。Management ServerとA〜Dの対応付け設定を確認してください。" }); return;
      }
      const result = await loginSite(session, siteA, body.username.trim(), body.password, res);
      if (result === "invalid") {
        record(session, "Service Aへのログインに失敗");
        res.status(401).json({ error: "ログインに失敗しました。ユーザー名またはパスワードを確認してください。" }); return;
      }
      if (result !== "ok") { res.status(502).json({ error: "Service Aのログイン状態を確認できません。接続を確認し、リセットしてから再実行してください。" }); return; }
      const outcomes = await Promise.all(config.sites.filter((site) => site.id !== "site-a").map(async (site) => {
        try {
          if (!site.password) return "failed";
          return await loginSite(session, site, site.username, site.password, res);
        } catch { return "failed"; }
      }));
      const data = await snapshot(session);
      const all = outcomes.every((outcome) => outcome === "ok") && data.services.every((site) => site.status === "logged-in");
      record(session, all ? "4サービスのログイン状態を確認" : "一部サービスにログインできませんでした。状態一覧と設定を確認してください。");
      res.json({ ...data, events: session.events, warning: all ? null : "一部サービスにログインできませんでした。各サービスの接続と設定済みアカウントを確認してください。" });
    } catch {
      res.status(502).json({ error: "サービスへ接続できません。起動状態を確認し、必要に応じてリセットしてください。" });
    } finally { session.busy = false; }
  });
  // Presentation flow: keep the original /login endpoint above for the
  // Phase 1–3 API contract, but let the dashboard show Site A and B–D as two
  // understandable, separate actions.
  router.post("/login-site-a", async (req, res) => {
    const session = res.locals.demoSession as DemoSession;
    if (session.busy || session.cookies[siteA.id]) {
      res.status(409).json({ error: "処理中、またはログイン済みです。再ログインする場合はデモを最初からやり直してください。" }); return;
    }
    const body = req.body as unknown;
    if (typeof body !== "object" || body === null || !("username" in body) || !("password" in body) ||
      typeof body.username !== "string" || typeof body.password !== "string" || !body.password || body.username.length > 128 || body.password.length > 1024 || !body.username.trim()) {
      res.status(400).json({ error: "ユーザー名とパスワードを入力してください。" }); return;
    }
    session.busy = true;
    try {
      await checkMapping();
      const result = await loginSite(session, siteA, siteA.username, siteA.password, res);
      session.username = body.username.trim();
      if (result === "invalid") { res.status(401).json({ error: "ログインに失敗しました。ユーザー名またはパスワードを確認してください。" }); return; }
      if (result !== "ok") { res.status(502).json({ error: "Service Aのログイン状態を確認できません。接続を確認してください。" }); return; }
      res.json(await snapshot(session));
    } catch { res.status(502).json({ error: "Service AまたはManagement Serverへ接続できません。起動状態を確認してください。" }); }
    finally { session.busy = false; }
  });
  router.post("/login-site-b", async (req, res) => {
    const session = res.locals.demoSession as DemoSession;
    const site = config.sites.find((entry) => entry.id === "site-b")!;
    if (session.busy || session.cookies[site.id]) {
      res.status(409).json({ error: "ログイン済み、または処理中です。失効後はCampus SNSでデモをリセットしてください。" }); return;
    }
    const body = req.body as unknown;
    if (typeof body !== "object" || body === null || !("username" in body) || !("password" in body) ||
      typeof body.username !== "string" || typeof body.password !== "string" || !body.username.trim() || !body.password || body.username.length > 128 || body.password.length > 1024) {
      res.status(400).json({ error: "ユーザー名とパスワードを入力してください。" }); return;
    }
    session.busy = true;
    try {
      await checkMapping();
      const result = await loginSite(session, site, site.username, site.password, res);
      if (result === "invalid") { res.status(401).json({ error: "ユーザー名またはパスワードが違います。" }); return; }
      if (result !== "ok") { res.status(502).json({ error: "Cloud Driveのログイン状態を確認できません。" }); return; }
      session.driveUsername = body.username.trim();
      res.json(await snapshot(session));
    } catch { res.status(502).json({ error: "Cloud DriveまたはManagement Serverへ接続できません。" }); }
    finally { session.busy = false; }
  });
  router.get("/cloud-drive", async (_req, res) => {
    const session = res.locals.demoSession as DemoSession;
    const site = config.sites.find((entry) => entry.id === "site-b")!;
    const status = await probe(session, site);
    res.json({ username: status.status === "logged-in" ? session.driveUsername ?? "ゲスト" : null, status: status.status, expired: status.status === "signed-out" && Boolean(session.cookies[site.id]),
      files: status.status === "logged-in" ? ["中間発表資料.pdf", "実験結果.csv", "研究メモ.docx"] : [] });
  });
  router.post(["/login-remaining", "/login-automatic"], async (req, res) => {
    const session = res.locals.demoSession as DemoSession;
    const automaticSites = config.sites.filter((site) => site.id !== "site-a" && (req.path !== "/login-automatic" || site.id !== "site-b"));
    if (session.busy || !session.cookies[siteA.id]?.[siteA.sessionCookie]) {
      res.status(409).json({ error: "先にService Aへログインしてください。" }); return;
    }
    if (automaticSites.every((site) => session.cookies[site.id])) {
      res.status(409).json({ error: "残りのサービスはすでにログイン済みです。" }); return;
    }
    session.busy = true;
    try {
      const outcomes = await Promise.all(automaticSites.map(async (site) => {
        if (session.cookies[site.id]) return "ok";
        if (!site.password) return "failed";
        try { return await loginSite(session, site, site.username, site.password, res); } catch { return "failed"; }
      }));
      const data = await snapshot(session);
      const all = outcomes.every((outcome) => outcome === "ok") && data.services.filter((site) => automaticSites.some((entry) => entry.id === site.id)).every((site) => site.status === "logged-in");
      record(session, all ? "自動ログイン対象サービスのログインを確認" : "一部サービスにログインできませんでした。状態一覧と設定を確認してください。");
      res.json({ ...data, events: session.events, warning: all ? null : "一部サービスにログインできませんでした。各サービスの接続と設定を確認してください。" });
    } finally { session.busy = false; }
  });
  router.post("/reset", async (_req, res) => {
    const session = res.locals.demoSession as DemoSession;
    if (session.busy) { res.status(409).json({ error: "処理中です。完了してからリセットしてください。" }); return; }
    session.busy = true;
    try {
      const outcomes = await Promise.all(config.sites.map(async (site) => {
        if (!session.cookies[site.id]) return true;
        try {
          const response = await upstream(site, "/logout", { method: "POST", headers: { Cookie: auth(session, site) } });
          await response.body?.cancel();
          if (![302, 303].includes(response.status) || (await probe(session, site)).status !== "signed-out") return false;
          delete session.cookies[site.id];
          for (const [name, path] of [[site.sessionCookie, "/"], [site.decoyCookie, "/__research/decoy-use"]]) {
            res.clearCookie(name!, { httpOnly: true, sameSite: "lax", path: `/demo/proxy/${site.id}${path!}` });
          }
          return true;
        } catch { return false; }
      }));
      if (outcomes.some((ok) => !ok)) {
        res.status(502).json({ error: "一部のセッションを終了できません。接続を確認してもう一度リセットしてください。" }); return;
      }
      session.username = null; session.cookies = {}; session.events = []; session.attacker = emptyAttacker(); session.revocation = emptyRevocation();
      delete session.stolenCookies;
      delete session.driveUsername;
      res.json(await snapshot(session));
    } finally { session.busy = false; }
  });
  return { session: router, attacker: attackerRouter };
}
