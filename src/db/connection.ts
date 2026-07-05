import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type MemoryDb = Database.Database;

export function openDatabase(databasePath: string): MemoryDb {
  const dir = path.dirname(databasePath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(databasePath);
  const schemaPath = new URL("./schema.sql", import.meta.url);
  const schema = fs.readFileSync(schemaPath, "utf8");
  db.pragma("foreign_keys = ON");
  db.exec(schema);
  return db;
}
