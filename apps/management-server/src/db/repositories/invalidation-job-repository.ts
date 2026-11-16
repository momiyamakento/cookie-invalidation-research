import { randomUUID } from "node:crypto";

import type { Database } from "better-sqlite3";

import type {
  DetectionTarget,
  InvalidationJobStatus,
  ManagedServiceId,
} from "@cookie-research/protocol";

export interface InvalidationJobRecord {
  id: string;
  eventId: string;
  requestId: string;
  targetServiceId: ManagedServiceId;
  targetLocalUserId: string;
  status: InvalidationJobStatus;
  httpStatus: number | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  revokedCount: number | null;
  errorMessage: string | null;
}

interface JobRow {
  id: string;
  event_id: string;
  request_id: string;
  target_service_id: ManagedServiceId;
  target_local_user_id: string;
  status: InvalidationJobStatus;
  http_status: number | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  revoked_count: number | null;
  error_message: string | null;
}

function toRecord(row: JobRow): InvalidationJobRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    requestId: row.request_id,
    targetServiceId: row.target_service_id,
    targetLocalUserId: row.target_local_user_id,
    status: row.status,
    httpStatus: row.http_status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    revokedCount: row.revoked_count,
    errorMessage: row.error_message,
  };
}

export class InvalidationJobRepository {
  public constructor(private readonly database: Database) {}

  public createPending(eventId: string, target: DetectionTarget): InvalidationJobRecord {
    const record: InvalidationJobRecord = {
      id: randomUUID(),
      eventId,
      requestId: randomUUID(),
      targetServiceId: target.serviceId,
      targetLocalUserId: target.localUserId,
      status: "PENDING",
      httpStatus: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      durationMs: null,
      revokedCount: null,
      errorMessage: null,
    };
    this.database.prepare(
      `INSERT INTO invalidation_jobs
         (id, event_id, request_id, target_service_id, target_local_user_id,
          status, http_status, started_at, completed_at, duration_ms,
          revoked_count, error_message)
       VALUES
         (@id, @eventId, @requestId, @targetServiceId, @targetLocalUserId,
          @status, @httpStatus, @startedAt, @completedAt, @durationMs,
          @revokedCount, @errorMessage)`,
    ).run(record);
    return record;
  }

  public findForEvent(eventId: string): InvalidationJobRecord[] {
    return this.database.prepare<[string], JobRow>(
      `SELECT id, event_id, request_id, target_service_id,
              target_local_user_id, status, http_status, started_at,
              completed_at, duration_ms, revoked_count, error_message
       FROM invalidation_jobs WHERE event_id = ?
       ORDER BY target_service_id ASC`,
    ).all(eventId).map(toRecord);
  }

  public complete(
    id: string,
    result: {
      status: "SUCCESS" | "FAILED";
      httpStatus: number | null;
      completedAt: string;
      durationMs: number;
      revokedCount: number | null;
      errorMessage: string | null;
    },
  ): void {
    this.database.prepare(
      `UPDATE invalidation_jobs
       SET status = @status, http_status = @httpStatus,
           completed_at = @completedAt, duration_ms = @durationMs,
           revoked_count = @revokedCount, error_message = @errorMessage
       WHERE id = @id AND status = 'PENDING'`,
    ).run({ id, ...result });
  }
}
