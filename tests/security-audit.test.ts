import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initializeManagementContext, type ManagementContext } from "../apps/management-server/src/management-context.js";

describe("Management Server security audit storage", () => {
  let context: ManagementContext | undefined;
  let directory: string | undefined;
  afterEach(() => {
    context?.database.close();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    context = undefined;
    directory = undefined;
  });

  it("stores only the minimum authentication decision metadata", () => {
    directory = mkdtempSync(join(tmpdir(), "security-audit-"));
    context = initializeManagementContext(join(directory, "management.sqlite"));
    const inserted = context.securityAuditRepository.insert({
      occurredAt: "2026-11-16T04:30:00.000Z",
      action: "DETECTION_CREATE",
      authenticatedServiceId: "site-a",
      claimedServiceId: "site-b",
      outcome: "DENIED",
      httpStatus: 403,
    });

    expect(context.securityAuditRepository.findAll()).toEqual([inserted]);
    const sql = context.database.prepare<[], { sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'security_audit_events'",
    ).get()?.sql.toLowerCase() ?? "";
    expect(sql).not.toMatch(/cookie|token|principal|local_user|password|event_id/u);
    expect(sql).toContain("authenticated_service_id");
    expect(sql).toContain("claimed_service_id");
  });
});
