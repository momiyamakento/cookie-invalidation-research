import type { Database } from "better-sqlite3";

import type { SessionRevocationRequest } from "@cookie-research/protocol";

import type {
  InvalidationRequestRecord,
  SessionRevocationHandler,
  SessionRevocationHandlerResult,
} from "../session-revocation.js";

interface InvalidationRow {
  request_id: string;
  event_id: string;
  user_id: string;
  reason: "DECOY_COOKIE_DETECTED";
  detected_at: string;
  received_at: string;
  revoked_count: number;
}

function toRecord(row: InvalidationRow): InvalidationRequestRecord {
  return {
    requestId: row.request_id,
    eventId: row.event_id,
    localUserId: row.user_id,
    reason: row.reason,
    detectedAt: row.detected_at,
    receivedAt: row.received_at,
    revokedCount: row.revoked_count,
  };
}

function sameRequest(existing: InvalidationRequestRecord, request: SessionRevocationRequest): boolean {
  return existing.requestId === request.requestId && existing.eventId === request.eventId &&
    existing.localUserId === request.localUserId && existing.reason === request.reason &&
    existing.detectedAt === request.detectedAt;
}

/**
 * Default handler for the shared research-site fixture used by Site B and C.
 * It is deliberately separate from the HTTP router so a future service can
 * supply a handler for a different database or session implementation.
 */
export function createResearchSiteSessionRevocationHandler(database: Database): SessionRevocationHandler {
  return (request): SessionRevocationHandlerResult => {
    const transaction = database.transaction((): SessionRevocationHandlerResult => {
      const row = database.prepare<[string], InvalidationRow>(
        `SELECT request_id, event_id, user_id, reason, detected_at, received_at, revoked_count
         FROM invalidation_requests WHERE request_id = ?`,
      ).get(request.requestId);
      if (row !== undefined) {
        const existing = toRecord(row);
        return sameRequest(existing, request)
          ? { kind: "already_processed", record: existing }
          : { kind: "request_id_conflict" };
      }

      const user = database.prepare<[string], { id: string }>("SELECT id FROM users WHERE id = ?")
        .get(request.localUserId);
      if (user === undefined) return { kind: "local_user_not_found" };

      const receivedAt = new Date().toISOString();
      const update = database.prepare(
        `UPDATE sessions SET status = 'REVOKED', revoked_at = @revokedAt
         WHERE user_id = @localUserId AND status = 'ACTIVE'`,
      ).run({ localUserId: request.localUserId, revokedAt: receivedAt });
      const record: InvalidationRequestRecord = { ...request, receivedAt, revokedCount: update.changes };
      database.prepare(
        `INSERT INTO invalidation_requests
           (request_id, event_id, user_id, reason, detected_at, received_at, revoked_count)
         VALUES
           (@requestId, @eventId, @localUserId, @reason, @detectedAt, @receivedAt, @revokedCount)`,
      ).run(record);
      return { kind: "success", record };
    });
    return transaction.immediate();
  };
}
