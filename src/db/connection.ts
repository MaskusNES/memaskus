import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "./migrations.js";

export type MemoryDb = Database.Database;

export function openDatabase(databasePath: string): MemoryDb {
  const dir = path.dirname(databasePath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(databasePath);
  // SQLite's built-in LOWER only folds ASCII; match JavaScript query normalization.
  db.function("js_lower", { deterministic: true }, (value) =>
    typeof value === "string" ? value.toLowerCase() : null
  );
  const schemaPath = new URL("./schema.sql", import.meta.url);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  try {
    runMigrations(db, schemaPath);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
