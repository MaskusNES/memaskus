import type { MemoryDb } from "../db/connection.js";
import { newId } from "../shared/ids.js";
import { nowIso } from "../shared/time.js";
import { mapSource } from "./mappers.js";
import type { Source } from "./types.js";

export type CreateSourceInput = {
  kind: string;
  external_id?: string | null;
  title?: string | null;
  content_excerpt?: string | null;
  metadata?: Record<string, unknown>;
};

export function createSource(db: MemoryDb, input: CreateSourceInput): Source {
  const source: Source = {
    id: newId("src"),
    kind: input.kind,
    external_id: input.external_id ?? null,
    title: input.title ?? null,
    content_excerpt: input.content_excerpt ?? null,
    metadata: input.metadata ?? {},
    created_at: nowIso()
  };

  db.prepare(
    `INSERT INTO sources (id, kind, external_id, title, content_excerpt, metadata_json, created_at)
     VALUES (@id, @kind, @external_id, @title, @content_excerpt, @metadata_json, @created_at)`
  ).run({
    ...source,
    metadata_json: JSON.stringify(source.metadata)
  });

  return source;
}

export function listSourcesForNode(db: MemoryDb, nodeId: string): Source[] {
  const rows = db
    .prepare(
      `SELECT s.*
       FROM sources s
       JOIN node_sources ns ON ns.source_id = s.id
       WHERE ns.node_id = ?
       ORDER BY s.created_at DESC`
    )
    .all(nodeId);

  return rows.map((row) => mapSource(row as never));
}
