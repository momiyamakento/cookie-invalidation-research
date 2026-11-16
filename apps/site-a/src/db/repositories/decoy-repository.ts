import { randomUUID } from "node:crypto";

import type { Database } from "better-sqlite3";

export type DecoySessionStatus = "ISSUED" | "USED";

export interface DecoySessionRecord {
  id: string;
  decoyId: string;
  userId: string;
  tokenHash: string;
  status: DecoySessionStatus;
  issuedAt: string;
  usedAt: string | null;
}

export interface LocalDetectionEvent {
  eventId: string;
  userId: string;
  decoyId: string;
  detectedAt: string;
}

export type DecoyDetectionOutcome =
  | { kind: "detected"; event: LocalDetectionEvent }
  | { kind: "already_detected"; event: LocalDetectionEvent }
  | { kind: "not_found" };

interface DecoySessionRow {
  id: string;
  decoy_id: string;
  user_id: string;
  token_hash: string;
  status: DecoySessionStatus;
  issued_at: string;
  used_at: string | null;
}

interface LocalDetectionEventRow {
  event_id: string;
  user_id: string;
  decoy_id: string;
  detected_at: string;
}

function toDecoySessionRecord(row: DecoySessionRow): DecoySessionRecord {
  return {
    id: row.id,
    decoyId: row.decoy_id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    status: row.status,
    issuedAt: row.issued_at,
    usedAt: row.used_at,
  };
}

function toLocalDetectionEvent(
  row: LocalDetectionEventRow,
): LocalDetectionEvent {
  return {
    eventId: row.event_id,
    userId: row.user_id,
    decoyId: row.decoy_id,
    detectedAt: row.detected_at,
  };
}

export class DecoyRepository {
  public constructor(private readonly database: Database) {}

  public create(userId: string, tokenHash: string): DecoySessionRecord {
    const decoySession: DecoySessionRecord = {
      id: randomUUID(),
      decoyId: randomUUID(),
      userId,
      tokenHash,
      status: "ISSUED",
      issuedAt: new Date().toISOString(),
      usedAt: null,
    };

    this.database
      .prepare(
        `INSERT INTO decoy_sessions
           (id, decoy_id, user_id, token_hash, status, issued_at, used_at)
         VALUES
           (@id, @decoyId, @userId, @tokenHash, @status, @issuedAt, @usedAt)`,
      )
      .run(decoySession);

    return decoySession;
  }

  public findByTokenHash(tokenHash: string): DecoySessionRecord | undefined {
    const row = this.database
      .prepare<[string], DecoySessionRow>(
        `SELECT id, decoy_id, user_id, token_hash, status, issued_at, used_at
         FROM decoy_sessions
         WHERE token_hash = ?`,
      )
      .get(tokenHash);

    return row === undefined ? undefined : toDecoySessionRecord(row);
  }

  public findEventByDecoyId(
    decoyId: string,
  ): LocalDetectionEvent | undefined {
    const row = this.database
      .prepare<[string], LocalDetectionEventRow>(
        `SELECT event_id, user_id, decoy_id, detected_at
         FROM local_detection_events
         WHERE decoy_id = ?`,
      )
      .get(decoyId);

    return row === undefined ? undefined : toLocalDetectionEvent(row);
  }

  public countDetectionEvents(): number {
    const row = this.database
      .prepare<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM local_detection_events",
      )
      .get();

    return row?.count ?? 0;
  }

  public detectFirstUse(tokenHash: string): DecoyDetectionOutcome {
    const detect = this.database.transaction(
      (hash: string): DecoyDetectionOutcome => {
        const decoySession = this.findByTokenHash(hash);
        if (decoySession === undefined) {
          return { kind: "not_found" };
        }

        if (decoySession.status === "USED") {
          const existingEvent = this.findEventByDecoyId(decoySession.decoyId);
          if (existingEvent === undefined) {
            throw new Error(
              `USED decoy ${decoySession.decoyId} has no detection event.`,
            );
          }

          return { kind: "already_detected", event: existingEvent };
        }

        const event: LocalDetectionEvent = {
          eventId: randomUUID(),
          userId: decoySession.userId,
          decoyId: decoySession.decoyId,
          detectedAt: new Date().toISOString(),
        };
        const update = this.database
          .prepare(
            `UPDATE decoy_sessions
             SET status = 'USED', used_at = @detectedAt
             WHERE token_hash = @tokenHash AND status = 'ISSUED'`,
          )
          .run({ tokenHash: hash, detectedAt: event.detectedAt });

        if (update.changes !== 1) {
          throw new Error("Decoy session state changed during detection.");
        }

        this.database
          .prepare(
            `INSERT INTO local_detection_events
               (event_id, user_id, decoy_id, detected_at)
             VALUES
               (@eventId, @userId, @decoyId, @detectedAt)`,
          )
          .run(event);

        return { kind: "detected", event };
      },
    );

    return detect.immediate(tokenHash);
  }
}
