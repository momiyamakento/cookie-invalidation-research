import { randomBytes, createHash } from "node:crypto";
import express from "express";
import { parse } from "cookie";
import type { Database } from "better-sqlite3";
import { createSessionRevocationRouter, deriveBenchmarkToken } from "@cookie-research/service-kit";
import type { BenchmarkServiceId } from "@cookie-research/protocol";
import { openResearchSiteDatabase } from "../../packages/service-kit/src/research-site/database.js";
import { ResearchSessionRepository } from "../../packages/service-kit/src/research-site/repositories/session-repository.js";
import { createResearchSiteSessionRevocationHandler } from "../../packages/service-kit/src/research-site/session-revocation-handler.js";
import type { Session } from "./concurrent-types.js";

export function createConcurrentFixture(serviceId: BenchmarkServiceId, secret: string) {
  let db: Database | undefined;
  let locked = false;
  let repo: ResearchSessionRepository | undefined;
  const records: Array<{ requestId: string; eventId: string; localUserId: string; durationMs: number; kind: string; changed: number }> = [];
  const app = express();
  app.use((_q, r, next) => { r.set("Cache-Control", "no-store"); next(); });
  app.get("/health", (_q, r) => r.json({ serviceId }));
  app.get("/protected", (q, r) => {
    const token = parse(q.headers.cookie ?? "").sid;
    const user = token && repo ? repo.findActiveWithUser(createHash("sha256").update(token).digest("hex")) : undefined;
    r.status(user ? 200 : 401).json({ localUserId: user?.userId ?? null });
  });
  app.use("/internal/v1/sessions/revoke", createSessionRevocationRouter(deriveBenchmarkToken(secret, serviceId), (request) => {
    if (!db) throw new Error("Fixture not initialized");
    locked = true;
    const start = performance.now();
    const result = createResearchSiteSessionRevocationHandler(db)(request);
    // Shared SQLite handler is synchronous, although the public handler type permits promises.
    if (result instanceof Promise) throw new Error("Expected synchronous SQLite handler");
    if (records.length >= 10000) throw new Error("Fixture record limit");
    records.push({ requestId: request.requestId, eventId: request.eventId, localUserId: request.localUserId,
      durationMs: performance.now() - start, kind: result.kind,
      changed: result.kind === "success" ? result.record.revokedCount : 0 });
    return result;
  }));
  return {
    app,
    reset(path: string, users: Array<{ principalId: string; localUserId: string }>): Omit<Session, "baseUrl">[] {
      if (locked) throw new Error("Finish trial before reset");
      db?.close(); db = openResearchSiteDatabase(path); repo = new ResearchSessionRepository(db); records.length = 0;
      const sessions: Omit<Session, "baseUrl">[] = [];
      db.transaction(() => {
        for (const user of users) {
          db!.prepare("INSERT INTO users VALUES (?, ?, ?, ?)").run(user.localUserId, user.localUserId, "evaluation-no-login", new Date().toISOString());
          for (let k = 0; k < 2; k++) {
            const token = randomBytes(32).toString("base64url");
            const hash = createHash("sha256").update(token).digest("hex");
            repo!.create(user.localUserId, hash);
            sessions.push({ ...user, serviceId, sessionId: repo!.findByTokenHash(hash)!.id, cookie: `sid=${token}` });
          }
        }
      })();
      return sessions;
    },
    finish() {
      locked = false;
      db?.pragma("wal_checkpoint(TRUNCATE)");
      return { records: [...records], sessions: db?.prepare("SELECT id,user_id,status FROM sessions ORDER BY id").all() ?? [] };
    },
    close() { db?.close(); db = undefined; },
  };
}
