import { randomUUID } from "node:crypto";

import type { Database } from "better-sqlite3";

export interface RegularSessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  status: "ACTIVE" | "REVOKED";
  createdAt: string;
  revokedAt: string | null;
}

export interface ActiveSessionUser {
  status: "ACTIVE";
  userId: string;
  username: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  status: "ACTIVE" | "REVOKED";
  created_at: string;
  revoked_at: string | null;
}

interface ActiveSessionRow {
  status: "ACTIVE";
  user_id: string;
  username: string;
}

function toSession(row: SessionRow): RegularSessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    status: row.status,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export class ResearchSessionRepository {
  public constructor(private readonly database: Database) {}

  public create(userId: string, tokenHash: string): void {
    this.database
      .prepare(
        `INSERT INTO sessions
           (id, user_id, token_hash, status, created_at, revoked_at)
         VALUES (?, ?, ?, 'ACTIVE', ?, NULL)`,
      )
      .run(randomUUID(), userId, tokenHash, new Date().toISOString());
  }

  public findActiveWithUser(tokenHash: string): ActiveSessionUser | undefined {
    const row = this.database
      .prepare<[string], ActiveSessionRow>(
        `SELECT sessions.status, users.id AS user_id, users.username
         FROM sessions
         INNER JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = ? AND sessions.status = 'ACTIVE'`,
      )
      .get(tokenHash);

    return row === undefined
      ? undefined
      : { status: row.status, userId: row.user_id, username: row.username };
  }

  public findByTokenHash(tokenHash: string): RegularSessionRecord | undefined {
    const row = this.database
      .prepare<[string], SessionRow>(
        `SELECT id, user_id, token_hash, status, created_at, revoked_at
         FROM sessions WHERE token_hash = ?`,
      )
      .get(tokenHash);
    return row === undefined ? undefined : toSession(row);
  }

  public revokeActiveByTokenHash(tokenHash: string): boolean {
    const result = this.database
      .prepare(
        `UPDATE sessions SET status = 'REVOKED', revoked_at = @revokedAt
         WHERE token_hash = @tokenHash AND status = 'ACTIVE'`,
      )
      .run({ tokenHash, revokedAt: new Date().toISOString() });
    return result.changes === 1;
  }
}
