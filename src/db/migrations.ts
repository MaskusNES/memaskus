import fs from "node:fs";
import type { MemoryDb } from "./connection.js";
import { nowIso } from "../shared/time.js";

export const CURRENT_SCHEMA_VERSION = 3;

function tableColumns(db: MemoryDb, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function tableExists(db: MemoryDb, table: string): boolean {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
}

function addColumn(db: MemoryDb, table: string, definition: string): void {
  const name = definition.split(/\s+/u)[0];
  if (!tableColumns(db, table).has(name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

function recordMigration(db: MemoryDb, version: number, name: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO schema_migrations (version, name, applied_at)
     VALUES (?, ?, ?)`
  ).run(version, name, nowIso());
  db.pragma(`user_version = ${version}`);
}

export function runMigrations(db: MemoryDb, schemaUrl: URL): void {
  const schema = fs.readFileSync(schemaUrl, "utf8");
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${current} is newer than supported version ${CURRENT_SCHEMA_VERSION}`
    );
  }

  const migrate = db.transaction(() => {
    if (current < 1) {
      if (!tableExists(db, "nodes")) {
        db.exec(schema);
      } else {
        db.exec(
          `CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL
          )`
        );
      }
      recordMigration(db, 1, "initial graph, candidates, conflicts, and profile schema");
    }

    if (current < 2) {
      addColumn(db, "nodes", "scope_conversation_id TEXT");
      addColumn(db, "candidates", "scope_conversation_id TEXT");
      addColumn(db, "candidates", "privacy_level TEXT NOT NULL DEFAULT 'normal'");
      addColumn(db, "candidates", "speaker_role TEXT");
      addColumn(db, "candidates", "turn_id TEXT");
      addColumn(db, "nodes", "knowledge_scope TEXT NOT NULL DEFAULT 'global'");
      addColumn(db, "candidates", "knowledge_scope TEXT NOT NULL DEFAULT 'global'");
      db.exec(schema);
      recordMigration(db, 2, "scope isolation, privacy, speaker provenance, and lifecycle");
    }

    if (current < 3) {
      addColumn(db, "nodes", "knowledge_scope TEXT NOT NULL DEFAULT 'global'");
      addColumn(db, "candidates", "knowledge_scope TEXT NOT NULL DEFAULT 'global'");
      db.exec(`
        UPDATE nodes
        SET knowledge_scope = CASE
          WHEN json_extract(metadata_json, '$.knowledge_scope') IN ('global', 'project_local')
            THEN json_extract(metadata_json, '$.knowledge_scope')
          WHEN scope_kind = 'global' THEN 'global'
          ELSE 'project_local'
        END;
        UPDATE candidates
        SET knowledge_scope = CASE
          WHEN json_extract(metadata_json, '$.knowledge_scope') IN ('global', 'project_local')
            THEN json_extract(metadata_json, '$.knowledge_scope')
          WHEN scope_kind = 'global' THEN 'global'
          ELSE 'project_local'
        END;
      `);
      db.exec(schema);
      recordMigration(db, 3, "canonical knowledge scope");
    }
  });

  migrate();
}
