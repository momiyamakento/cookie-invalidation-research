import type { Database } from "better-sqlite3";

import type {
  DetectionNotificationRequest,
  DetectionProcessingStatus,
  ManagedServiceId,
} from "@cookie-research/protocol";

export interface DetectionEventRecord {
  eventId: string;
  sourceServiceId: ManagedServiceId;
  sourceLocalUserId: string;
  principalId: string;
  decoyId: string;
  detectedAt: string;
  receivedAt: string;
  completedAt: string | null;
  totalDurationMs: number | null;
  status: DetectionProcessingStatus;
}

interface DetectionRow {
  event_id: string;
  source_service_id: ManagedServiceId;
  source_local_user_id: string;
  principal_id: string;
  decoy_id: string;
  detected_at: string;
  received_at: string;
  completed_at: string | null;
  total_duration_ms: number | null;
  status: DetectionProcessingStatus;
}

function toRecord(row: DetectionRow): DetectionEventRecord {
  return {
    eventId: row.event_id,
    sourceServiceId: row.source_service_id,
    sourceLocalUserId: row.source_local_user_id,
    principalId: row.principal_id,
    decoyId: row.decoy_id,
    detectedAt: row.detected_at,
    receivedAt: row.received_at,
    completedAt: row.completed_at,
    totalDurationMs: row.total_duration_ms,
    status: row.status,
  };
}

export class DetectionRepository {
  public constructor(private readonly database: Database) {}

  public findByEventId(eventId: string): DetectionEventRecord | undefined {
    const row = this.database
      .prepare<[string], DetectionRow>(
        `SELECT event_id, source_service_id, source_local_user_id,
                principal_id, decoy_id, detected_at, received_at,
                completed_at, total_duration_ms, status
         FROM detection_events WHERE event_id = ?`,
      )
      .get(eventId);
    return row === undefined ? undefined : toRecord(row);
  }

  public insert(
    request: DetectionNotificationRequest,
    principalId: string,
  ): DetectionEventRecord {
    const record: DetectionEventRecord = {
      eventId: request.eventId,
      sourceServiceId: request.serviceId,
      sourceLocalUserId: request.localUserId,
      principalId,
      decoyId: request.decoyId,
      detectedAt: request.detectedAt,
      receivedAt: new Date().toISOString(),
      completedAt: null,
      totalDurationMs: null,
      status: "RESOLVED",
    };
    this.database
      .prepare(
        `INSERT INTO detection_events
           (event_id, source_service_id, source_local_user_id, principal_id,
            decoy_id, detected_at, received_at, completed_at,
            total_duration_ms, status)
         VALUES
           (@eventId, @sourceServiceId, @sourceLocalUserId, @principalId,
            @decoyId, @detectedAt, @receivedAt, @completedAt,
            @totalDurationMs, @status)`,
      )
      .run(record);
    return record;
  }

  public markProcessing(eventId: string): boolean {
    return this.database.prepare(
      `UPDATE detection_events SET status = 'PROCESSING'
       WHERE event_id = ? AND status = 'RESOLVED'`,
    ).run(eventId).changes === 1;
  }

  public complete(
    eventId: string,
    status: "SUCCESS" | "PARTIAL_FAILURE" | "FAILED",
    completedAt: string,
    totalDurationMs: number,
  ): void {
    this.database.prepare(
      `UPDATE detection_events
       SET status = ?, completed_at = ?, total_duration_ms = ?
       WHERE event_id = ? AND status = 'PROCESSING'`,
    ).run(status, completedAt, totalDurationMs, eventId);
  }
}
