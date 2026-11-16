import type { Database } from "better-sqlite3";
import { isBenchmarkServiceId, type BenchmarkServiceId } from "@cookie-research/protocol";

export interface ServiceRecord {
  id: string;
  name: string;
  baseUrl: string;
  createdAt: string;
}

interface ServiceRow {
  id: string;
  name: string;
  base_url: string;
  created_at: string;
}

const SEEDED_SERVICES = [
  { id: "site-a", name: "Site A", baseUrl: "http://localhost:3101" },
  { id: "site-b", name: "Site B", baseUrl: "http://localhost:3102" },
  { id: "site-c", name: "Site C", baseUrl: "http://localhost:3103" },
  { id: "site-d", name: "Site D", baseUrl: "http://localhost:3104" },
] as const;

function toServiceRecord(row: ServiceRow): ServiceRecord {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    createdAt: row.created_at,
  };
}

export class ServiceRepository {
  public constructor(private readonly database: Database) {}

  public seedFixedServices(): void {
    const seed = this.database.transaction(() => {
      const statement = this.database.prepare(
        `INSERT INTO services (id, name, base_url, created_at)
         VALUES (@id, @name, @baseUrl, @createdAt)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           base_url = excluded.base_url`,
      );
      const createdAt = new Date().toISOString();

      for (const service of SEEDED_SERVICES) {
        statement.run({ ...service, createdAt });
      }
    });

    seed.immediate();
  }

  public findById(id: string): ServiceRecord | undefined {
    const row = this.database
      .prepare<[string], ServiceRow>(
        `SELECT id, name, base_url, created_at
         FROM services
         WHERE id = ?`,
      )
      .get(id);

    return row === undefined ? undefined : toServiceRecord(row);
  }

  /** Registers an evaluation-only service. Fixed services are seeded separately. */
  public registerBenchmark(
    id: BenchmarkServiceId,
    baseUrl: string,
  ): ServiceRecord {
    if (!isBenchmarkServiceId(id)) throw new Error("Invalid benchmark service ID.");
    const normalizedBaseUrl = new URL(baseUrl).toString().replace(/\/$/u, "");
    const record: ServiceRecord = {
      id,
      name: `Benchmark ${id.slice("benchmark-".length)}`,
      baseUrl: normalizedBaseUrl,
      createdAt: new Date().toISOString(),
    };
    this.database.prepare(
      `INSERT INTO services (id, name, base_url, created_at)
       VALUES (@id, @name, @baseUrl, @createdAt)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url`,
    ).run(record);
    return this.findById(id) ?? record;
  }

  public findAll(): ServiceRecord[] {
    return this.database
      .prepare<[], ServiceRow>(
        `SELECT id, name, base_url, created_at
         FROM services
         ORDER BY id ASC`,
      )
      .all()
      .map(toServiceRecord);
  }
}
