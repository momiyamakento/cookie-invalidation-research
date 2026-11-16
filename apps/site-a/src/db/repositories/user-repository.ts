import type { Database } from "better-sqlite3";

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
}

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
}

function toUserRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
  };
}

export class UserRepository {
  public constructor(private readonly database: Database) {}

  public findByUsername(username: string): UserRecord | undefined {
    const row = this.database
      .prepare<[string], UserRow>(
        `SELECT id, username, password_hash, created_at
         FROM users
         WHERE username = ?`,
      )
      .get(username);

    return row === undefined ? undefined : toUserRecord(row);
  }

  public findById(id: string): UserRecord | undefined {
    const row = this.database
      .prepare<[string], UserRow>(
        `SELECT id, username, password_hash, created_at
         FROM users
         WHERE id = ?`,
      )
      .get(id);

    return row === undefined ? undefined : toUserRecord(row);
  }

  public insertIfAbsent(user: UserRecord): boolean {
    const result = this.database
      .prepare(
        `INSERT INTO users (id, username, password_hash, created_at)
         VALUES (@id, @username, @passwordHash, @createdAt)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(user);

    return result.changes === 1;
  }
}
