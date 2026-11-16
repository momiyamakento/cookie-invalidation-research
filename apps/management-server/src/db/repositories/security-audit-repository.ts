import { randomUUID } from "node:crypto";

import type { Database } from "better-sqlite3";

export type SecurityAuditAction =
  | "MAPPING_REGISTER"
  | "MAPPING_RESOLVE"
  | "MAPPING_READ"
  | "DETECTION_CREATE"
  | "DETECTION_READ";
export type SecurityAuditOutcome = "ALLOWED" | "DENIED";

export interface SecurityAuditInput {
  occurredAt: string;
  action: SecurityAuditAction;
  authenticatedServiceId: string | null;
  claimedServiceId: string | null;
  outcome: SecurityAuditOutcome;
  httpStatus: number;
}

export interface SecurityAuditRecord extends SecurityAuditInput {
  id: string;
}

interface SecurityAuditRow {
  id: string;
  occurred_at: string;
  action: SecurityAuditAction;
  authenticated_service_id: string | null;
  claimed_service_id: string | null;
  outcome: SecurityAuditOutcome;
  http_status: number;
}

function record(row: SecurityAuditRow): SecurityAuditRecord {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    action: row.action,
    authenticatedServiceId: row.authenticated_service_id,
    claimedServiceId: row.claimed_service_id,
    outcome: row.outcome,
    httpStatus: row.http_status,
  };
}

export class SecurityAuditRepository {
  public constructor(private readonly database: Database) {}

  public insert(input: SecurityAuditInput): SecurityAuditRecord {
    const value: SecurityAuditRecord = { id: randomUUID(), ...input };
    this.database.prepare(
      `INSERT INTO security_audit_events
         (id, occurred_at, action, authenticated_service_id,
          claimed_service_id, outcome, http_status)
       VALUES
         (@id, @occurredAt, @action, @authenticatedServiceId,
          @claimedServiceId, @outcome, @httpStatus)`,
    ).run(value);
    return value;
  }

  public findAll(): SecurityAuditRecord[] {
    return this.database.prepare<[], SecurityAuditRow>(
      `SELECT id, occurred_at, action, authenticated_service_id,
              claimed_service_id, outcome, http_status
       FROM security_audit_events ORDER BY occurred_at, id`,
    ).all().map(record);
  }
}
