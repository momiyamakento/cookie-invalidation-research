import Database from "better-sqlite3";
import type { SessionRevocationRequest } from "@cookie-research/protocol";

export type LoadProfile = "light" | "medium" | "heavy";
export interface LoadTiming {
  actualWorkMs: number;
  intentionalDelayMs: number;
  observedDelayMs: number;
}
export const LOAD_PROFILES = {
  light: { sessionCount: 1, grantsPerSession: 0 },
  medium: { sessionCount: 8, grantsPerSession: 4 },
  heavy: { sessionCount: 128, grantsPerSession: 8 },
} as const;
export const LOAD_MODEL_VERSION = "related-sessions-v2";

export function parseLoadProfile(value: string = "light"): LoadProfile {
  if (value !== "light" && value !== "medium" && value !== "heavy") {
    throw new Error("SERVICE_LOAD_PROFILE / --load-profile must be light, medium, or heavy.");
  }
  return value;
}

export function validateServiceDelay(value: number): number {
  // Node timers overflow above this limit and otherwise silently become 1ms.
  if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new Error("--service-delay-ms must be an integer between 0 and 2147483647.");
  }
  return value;
}

/** Independent in-memory state; each row represents a distinct session or grant. */
export function createBenchmarkLoad(profile: Exclude<LoadProfile, "light">) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    INSERT INTO users VALUES ('benchmark-user', 0);
    CREATE TABLE sessions (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, active INTEGER NOT NULL);
    CREATE INDEX sessions_user ON sessions(user_id, active);
    CREATE TABLE grants (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, active INTEGER NOT NULL);
    CREATE INDEX grants_session ON grants(session_id, active);
    CREATE TABLE audit (request_id TEXT, session_id INTEGER, revoked_grants INTEGER);
  `);
  const config = LOAD_PROFILES[profile];
  const seedSession = db.prepare("INSERT INTO sessions VALUES (?, 'benchmark-user', 1)");
  const seedGrant = db.prepare("INSERT INTO grants (session_id, active) VALUES (?, 1)");
  db.transaction(() => {
    for (let id = 1; id <= config.sessionCount; id += 1) {
      seedSession.run(id);
      for (let grant = 0; grant < config.grantsPerSession; grant += 1) seedGrant.run(id);
    }
  })();
  const user = db.prepare("SELECT revision FROM users WHERE id = ?");
  const sessions = db.prepare("SELECT id FROM sessions WHERE user_id = ? AND active = 1 ORDER BY id");
  const grants = db.prepare(`SELECT g.session_id, COUNT(*) AS count FROM grants g
    JOIN sessions s ON s.id = g.session_id WHERE s.user_id = ? AND s.active = 1 AND g.active = 1
    GROUP BY g.session_id`);
  const revokeGrants = db.prepare(`UPDATE grants SET active = 0 WHERE active = 1 AND session_id IN
    (SELECT id FROM sessions WHERE user_id = ? AND active = 1)`);
  const revokeSessions = db.prepare("UPDATE sessions SET active = 0 WHERE user_id = ? AND active = 1");
  const audit = db.prepare("INSERT INTO audit VALUES (?, ?, ?)");
  const revision = db.prepare("UPDATE users SET revision = revision + 1 WHERE id = ?");
  const transaction = db.transaction((request: SessionRevocationRequest) => {
    if (user.get(request.localUserId) === undefined) return undefined;
    const targets = sessions.all(request.localUserId) as Array<{ id: number }>;
    const related = grants.all(request.localUserId) as Array<{ session_id: number; count: number }>;
    const counts = new Map(related.map((row) => [row.session_id, row.count]));
    revokeGrants.run(request.localUserId);
    const count = revokeSessions.run(request.localUserId).changes;
    // One audit record per revoked session, including its revoked authorization count.
    for (const target of targets) audit.run(request.requestId, target.id, counts.get(target.id) ?? 0);
    if (count > 0) revision.run(request.localUserId);
    return count;
  });
  const state = db.prepare(`SELECT
    (SELECT COUNT(*) FROM sessions WHERE active = 1) AS activeSessions,
    (SELECT COUNT(*) FROM grants WHERE active = 1) AS activeGrants,
    (SELECT COUNT(*) FROM audit) AS auditRecords,
    (SELECT COALESCE(SUM(revoked_grants), 0) FROM audit) AS auditedGrants`);
  return {
    revoke(request: SessionRevocationRequest) { return transaction.immediate(request); },
    inspect() { return state.get() as { activeSessions: number; activeGrants: number; auditRecords: number; auditedGrants: number }; },
    get active() { return sessions.get("benchmark-user") !== undefined; },
    reset() {
      db.transaction(() => {
        db.exec("DELETE FROM audit; UPDATE users SET revision = 0; UPDATE sessions SET active = 1; UPDATE grants SET active = 1;");
      })();
    },
    close() { db.close(); },
  };
}
