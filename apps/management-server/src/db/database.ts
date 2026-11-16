import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import BetterSqlite3, { type Database } from "better-sqlite3";

import { MANAGEMENT_SCHEMA } from "./schema.js";

export function openManagementDatabase(databasePath: string): Database {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const database = new BetterSqlite3(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");

  if (databasePath !== ":memory:") {
    database.pragma("journal_mode = WAL");
  }

  database.exec(MANAGEMENT_SCHEMA);
  const detectionColumns = database
    .prepare<[], { name: string }>("PRAGMA table_info(detection_events)")
    .all()
    .map(({ name }) => name);
  if (!detectionColumns.includes("completed_at")) {
    database.exec("ALTER TABLE detection_events ADD COLUMN completed_at TEXT");
  }
  if (!detectionColumns.includes("total_duration_ms")) {
    database.exec(
      "ALTER TABLE detection_events ADD COLUMN total_duration_ms INTEGER",
    );
  }
  return database;
}
