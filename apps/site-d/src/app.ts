import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { parse as parseCookie } from "cookie";
import express, { type Express, type Request } from "express";
import type { SessionRevocationHandler } from "@cookie-research/service-kit";
import { createSessionRevocationRouter } from "@cookie-research/service-kit";

const scrypt = promisify(scryptCallback);
export const SITE_D_USER = { id: "member-d-501", username: "diana-d" } as const;
const cookieOptions = { httpOnly: true, sameSite: "lax" as const, path: "/", secure: false };

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
async function passwordHash(password: string): Promise<string> { const salt = randomBytes(16).toString("hex"); const derived = await scrypt(password, salt, 64) as Buffer; return `${salt}:${derived.toString("hex")}`; }
async function passwordMatches(password: string, stored: string): Promise<boolean> { const [salt, expected] = stored.split(":"); if (!salt || !expected) return false; const derived = await scrypt(password, salt, 64) as Buffer; return timingSafeEqual(derived, Buffer.from(expected, "hex")); }
function field(body: unknown, name: string): string | undefined { return typeof body === "object" && body !== null && typeof Reflect.get(body, name) === "string" ? Reflect.get(body, name) as string : undefined; }
function token(request: Request): string | undefined { try { return request.headers.cookie === undefined ? undefined : parseCookie(request.headers.cookie).sid_site_d; } catch { return undefined; } }

export async function createSiteDApp(databasePath: string, seedPassword: string, managerToken: string): Promise<{ app: Express; database: Database.Database; handler: SessionRevocationHandler }> {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.exec(`CREATE TABLE IF NOT EXISTS accounts (account_key TEXT PRIMARY KEY, login_name TEXT NOT NULL UNIQUE, password_digest TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS access_grants (grant_key TEXT PRIMARY KEY, account_key TEXT NOT NULL, secret_digest TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('OPEN','CLOSED')), closed_at TEXT, FOREIGN KEY(account_key) REFERENCES accounts(account_key)) STRICT;
    CREATE TABLE IF NOT EXISTS revocation_log (request_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, account_key TEXT NOT NULL, detected_at TEXT NOT NULL, received_at TEXT NOT NULL, closed_count INTEGER NOT NULL) STRICT;`);
  if (database.prepare("SELECT account_key FROM accounts WHERE account_key = ?").get(SITE_D_USER.id) === undefined) database.prepare("INSERT INTO accounts VALUES (?, ?, ?)").run(SITE_D_USER.id, SITE_D_USER.username, await passwordHash(seedPassword));
  const handler: SessionRevocationHandler = (request) => database.transaction(() => {
    const prior = database.prepare("SELECT * FROM revocation_log WHERE request_id = ?").get(request.requestId) as { event_id: string; account_key: string; detected_at: string; received_at: string; closed_count: number } | undefined;
    if (prior !== undefined) return prior.event_id === request.eventId && prior.account_key === request.localUserId && prior.detected_at === request.detectedAt ? { kind: "already_processed" as const, record: { ...request, receivedAt: prior.received_at, revokedCount: prior.closed_count } } : { kind: "request_id_conflict" as const };
    if (database.prepare("SELECT account_key FROM accounts WHERE account_key = ?").get(request.localUserId) === undefined) return { kind: "local_user_not_found" as const };
    const receivedAt = new Date().toISOString(); const closed = database.prepare("UPDATE access_grants SET state='CLOSED', closed_at=? WHERE account_key=? AND state='OPEN'").run(receivedAt, request.localUserId).changes;
    database.prepare("INSERT INTO revocation_log VALUES (?, ?, ?, ?, ?, ?)").run(request.requestId, request.eventId, request.localUserId, request.detectedAt, receivedAt, closed);
    return { kind: "success" as const, record: { ...request, receivedAt, revokedCount: closed } };
  }).immediate();
  const app = express(); app.disable("x-powered-by"); app.use(express.urlencoded({ extended: false })); app.use("/internal/v1/sessions/revoke", createSessionRevocationRouter(managerToken, handler));
  app.get("/health", (_q, r) => r.json({ status: "ok", service: "site-d" })); app.get("/", (_q, r) => r.redirect("/login"));
  app.get("/login", (_q, r) => r.type("html").send('<h1>Site D</h1><h2>Login</h2><form method="post"><input name="username"><input name="password" type="password"><button>Log in</button></form>'));
  app.post("/login", async (q, r) => { const username = field(q.body, "username")?.trim(); const password = field(q.body, "password"); const account = username === undefined ? undefined : database.prepare("SELECT * FROM accounts WHERE login_name=?").get(username) as { account_key: string; password_digest: string } | undefined; if (account === undefined || password === undefined || !(await passwordMatches(password, account.password_digest))) { r.status(401).type("html").send("Invalid username or password."); return; } const secret = randomBytes(32).toString("base64url"); database.prepare("INSERT INTO access_grants VALUES (?, ?, ?, 'OPEN', NULL)").run(randomUUID(), account.account_key, digest(secret)); r.cookie("sid_site_d", secret, cookieOptions).redirect("/protected"); });
  app.get("/protected", (q, r) => { const value = token(q); const grant = value === undefined ? undefined : database.prepare("SELECT account_key FROM access_grants WHERE secret_digest=? AND state='OPEN'").get(digest(value)); if (grant === undefined) { r.status(401).type("text").send("Unauthorized"); return; } r.type("html").send(`<h1>Site D</h1><p>Logged in as ${SITE_D_USER.username}</p><form method="post" action="/logout"><button>Log out</button></form>`); });
  app.post("/logout", (q, r) => { const value = token(q); if (value !== undefined) database.prepare("UPDATE access_grants SET state='CLOSED', closed_at=? WHERE secret_digest=? AND state='OPEN'").run(new Date().toISOString(), digest(value)); r.clearCookie("sid_site_d", cookieOptions).redirect("/login"); });
  return { app, database, handler };
}
