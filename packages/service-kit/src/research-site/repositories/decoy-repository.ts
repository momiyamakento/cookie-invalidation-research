import { randomUUID } from "node:crypto";

import type { Database } from "better-sqlite3";

export interface DecoyRecord {
  decoyId: string;
  userId: string;
  tokenHash: string;
  status: "ISSUED" | "USED";
  issuedAt: string;
  usedAt: string | null;
}

export interface LocalDetectionEvent {
  eventId: string;
  userId: string;
  decoyId: string;
  detectedAt: string;
}

export type DetectionOutcome =
  | { kind: "detected"; event: LocalDetectionEvent }
  | { kind: "already_detected"; event: LocalDetectionEvent }
  | { kind: "not_found" };

interface DecoyRow {
  decoy_id: string;
  user_id: string;
  token_hash: string;
  status: "ISSUED" | "USED";
  issued_at: string;
  used_at: string | null;
}

interface EventRow {
  event_id: string;
  user_id: string;
  decoy_id: string;
  detected_at: string;
}

function toDecoy(row: DecoyRow): DecoyRecord {
  return {
    decoyId: row.decoy_id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    status: row.status,
    issuedAt: row.issued_at,
    usedAt: row.used_at,
  };
}

function toEvent(row: EventRow): LocalDetectionEvent {
  return {
    eventId: row.event_id,
    userId: row.user_id,
    decoyId: row.decoy_id,
    detectedAt: row.detected_at,
  };
}

export class ResearchDecoyRepository {
  public constructor(private readonly database: Database) {}

  public create(userId: string, tokenHash: string): void {
    this.database
      .prepare(
        `INSERT INTO decoy_sessions
           (id, decoy_id, user_id, token_hash, status, issued_at, used_at)
         VALUES (?, ?, ?, ?, 'ISSUED', ?, NULL)`,
      )
      .run(
        randomUUID(),
        randomUUID(),
        userId,
        tokenHash,
        new Date().toISOString(),
      );
  }

  public findByTokenHash(tokenHash: string): DecoyRecord | undefined {
    const row = this.database
      .prepare<[string], DecoyRow>(
        `SELECT decoy_id, user_id, token_hash, status, issued_at, used_at
         FROM decoy_sessions WHERE token_hash = ?`,
      )
      .get(tokenHash);
    return row === undefined ? undefined : toDecoy(row);
  }

  public countEvents(): number {
    return (
      this.database
        .prepare<[], { count: number }>(
          "SELECT COUNT(*) AS count FROM local_detection_events",
        )
        .get()?.count ?? 0
    );
  }

  public detectFirstUse(tokenHash: string): DetectionOutcome {
    const detect = this.database.transaction(
      (hash: string): DetectionOutcome => {
        const decoy = this.findByTokenHash(hash);
        if (decoy === undefined) {
          return { kind: "not_found" };
        }

        if (decoy.status === "USED") {
          const row = this.database
            .prepare<[string], EventRow>(
              `SELECT event_id, user_id, decoy_id, detected_at
               FROM local_detection_events WHERE decoy_id = ?`,
            )
            .get(decoy.decoyId);
          if (row === undefined) {
            throw new Error(`USED decoy ${decoy.decoyId} has no event.`);
          }

          return { kind: "already_detected", event: toEvent(row) };
        }

        const event: LocalDetectionEvent = {
          eventId: randomUUID(),
          userId: decoy.userId,
          decoyId: decoy.decoyId,
          detectedAt: new Date().toISOString(),
        };
        const update = this.database
          .prepare(
            `UPDATE decoy_sessions SET status = 'USED', used_at = @detectedAt
             WHERE token_hash = @tokenHash AND status = 'ISSUED'`,
          )
          .run({ tokenHash: hash, detectedAt: event.detectedAt });
        if (update.changes !== 1) {
          throw new Error("Decoy state changed during detection.");
        }

        this.database
          .prepare(
            `INSERT INTO local_detection_events
               (event_id, user_id, decoy_id, detected_at)
             VALUES (@eventId, @userId, @decoyId, @detectedAt)`,
          )
          .run(event);
        return { kind: "detected", event };
      },
    );

    return detect.immediate(tokenHash);
  }
}
