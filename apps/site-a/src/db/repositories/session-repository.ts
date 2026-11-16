import { randomUUID } from "node:crypto";

import type { Database } from "better-sqlite3";

export type SessionStatus = "ACTIVE" | "REVOKED";

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  status: SessionStatus;
  createdAt: string;
  revokedAt: string | null;
}

export interface AuthenticatedSession {
  sessionId: string;
  status: "ACTIVE";
  userId: string;
  username: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  status: SessionStatus;
  created_at: string;
  revoked_at: string | null;
}

interface AuthenticatedSessionRow {
  session_id: string;
  status: "ACTIVE";
  user_id: string;
  username: string;
}

function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    status: row.status,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export class SessionRepository {
  public constructor(private readonly database: Database) {}

  public create(userId: string, tokenHash: string): SessionRecord {
    const session: SessionRecord = {
      id: randomUUID(),
      userId,
      tokenHash,
      status: "ACTIVE",
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };

    this.database
      .prepare(
        `INSERT INTO sessions
           (id, user_id, token_hash, status, created_at, revoked_at)
         VALUES
           (@id, @userId, @tokenHash, @status, @createdAt, @revokedAt)`,
      )
      .run(session);

    return session;
  }

  public findActiveWithUser(tokenHash: string): AuthenticatedSession | undefined {
    const row = this.database
      .prepare<[string], AuthenticatedSessionRow>(
        `SELECT
           sessions.id AS session_id,
           sessions.status AS status,
           users.id AS user_id,
           users.username AS username
         FROM sessions
         INNER JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = ? AND sessions.status = 'ACTIVE'`,
      )
      .get(tokenHash);

    if (row === undefined) {
      return undefined;
    }

    return {
      sessionId: row.session_id,
      status: row.status,
      userId: row.user_id,
      username: row.username,
    };
  }

  public findByTokenHash(tokenHash: string): SessionRecord | undefined {
    const row = this.database
      .prepare<[string], SessionRow>(
        `SELECT id, user_id, token_hash, status, created_at, revoked_at
         FROM sessions
         WHERE token_hash = ?`,
      )
      .get(tokenHash);

    return row === undefined ? undefined : toSessionRecord(row);
  }

  public revokeActiveByTokenHash(tokenHash: string): boolean {
    const result = this.database
      .prepare(
        `UPDATE sessions
         SET status = 'REVOKED', revoked_at = @revokedAt
         WHERE token_hash = @tokenHash AND status = 'ACTIVE'`,
      )
      .run({ tokenHash, revokedAt: new Date().toISOString() });

    return result.changes === 1;
  }
}
