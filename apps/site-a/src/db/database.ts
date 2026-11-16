import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import BetterSqlite3, { type Database } from "better-sqlite3";

import { SITE_A_SCHEMA } from "./schema.js";

export function openSiteADatabase(databasePath: string): Database {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const database = new BetterSqlite3(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");

  if (databasePath !== ":memory:") {
    database.pragma("journal_mode = WAL");
  }

  database.exec(SITE_A_SCHEMA);
  return database;
}
