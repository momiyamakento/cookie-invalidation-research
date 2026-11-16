import { randomUUID } from "node:crypto";

import type { Database } from "better-sqlite3";

export interface MappingIdentity {
  principalId: string;
  serviceId: string;
  localUserId: string;
}

export interface MappingRecord extends MappingIdentity {
  id: string;
  createdAt: string;
}

export type MappingRegistrationResult =
  | { kind: "registered"; mapping: MappingRecord }
  | { kind: "already_registered"; mapping: MappingRecord }
  | { kind: "conflict" };

interface MappingRow {
  id: string;
  principal_id: string;
  service_id: string;
  local_user_id: string;
  created_at: string;
}

function toMappingRecord(row: MappingRow): MappingRecord {
  return {
    id: row.id,
    principalId: row.principal_id,
    serviceId: row.service_id,
    localUserId: row.local_user_id,
    createdAt: row.created_at,
  };
}

export class MappingRepository {
  public constructor(private readonly database: Database) {}

  public register(identity: MappingIdentity): MappingRegistrationResult {
    const registerTransaction = this.database.transaction(
      (): MappingRegistrationResult => {
        const exact = this.findExact(identity);
        if (exact !== undefined) {
          return { kind: "already_registered", mapping: exact };
        }

        if (
          this.findPrincipalByServiceUser(
            identity.serviceId,
            identity.localUserId,
          ) !== undefined ||
          this.findByPrincipalAndService(
            identity.principalId,
            identity.serviceId,
          ) !== undefined
        ) {
          return { kind: "conflict" };
        }

        const mapping: MappingRecord = {
          id: randomUUID(),
          ...identity,
          createdAt: new Date().toISOString(),
        };
        this.database
          .prepare(
            `INSERT INTO user_service_mappings
               (id, principal_id, service_id, local_user_id, created_at)
             VALUES
               (@id, @principalId, @serviceId, @localUserId, @createdAt)`,
          )
          .run(mapping);

        return { kind: "registered", mapping };
      },
    );

    return registerTransaction.immediate();
  }

  public findForPrincipal(principalId: string): MappingRecord[] {
    return this.database
      .prepare<[string], MappingRow>(
        `SELECT id, principal_id, service_id, local_user_id, created_at
         FROM user_service_mappings
         WHERE principal_id = ?
         ORDER BY service_id ASC`,
      )
      .all(principalId)
      .map(toMappingRecord);
  }

  public findPrincipalByServiceUser(
    serviceId: string,
    localUserId: string,
  ): string | undefined {
    const row = this.database
      .prepare<[string, string], { principal_id: string }>(
        `SELECT principal_id
         FROM user_service_mappings
         WHERE service_id = ? AND local_user_id = ?`,
      )
      .get(serviceId, localUserId);

    return row?.principal_id;
  }

  private findExact(identity: MappingIdentity): MappingRecord | undefined {
    const row = this.database
      .prepare<[string, string, string], MappingRow>(
        `SELECT id, principal_id, service_id, local_user_id, created_at
         FROM user_service_mappings
         WHERE principal_id = ? AND service_id = ? AND local_user_id = ?`,
      )
      .get(identity.principalId, identity.serviceId, identity.localUserId);

    return row === undefined ? undefined : toMappingRecord(row);
  }

  private findByPrincipalAndService(
    principalId: string,
    serviceId: string,
  ): MappingRecord | undefined {
    const row = this.database
      .prepare<[string, string], MappingRow>(
        `SELECT id, principal_id, service_id, local_user_id, created_at
         FROM user_service_mappings
         WHERE principal_id = ? AND service_id = ?`,
      )
      .get(principalId, serviceId);

    return row === undefined ? undefined : toMappingRecord(row);
  }
}
