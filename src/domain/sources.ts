import type { MemoryDb } from "../db/connection.js";
import { newId } from "../shared/ids.js";
import { nowIso } from "../shared/time.js";
import { mapSource } from "./mappers.js";
import { redactSecrets, sanitizeMetadata } from "./privacy.js";
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
    external_id: input.external_id ? redactSecrets(input.external_id) : null,
    title: input.title ? redactSecrets(input.title) : null,
    content_excerpt: input.content_excerpt ? redactSecrets(input.content_excerpt) : null,
    metadata: sanitizeMetadata(input.metadata),
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

// A source can have owners in all three stores, including profile-only owners.
function hasOtherSourceOwners(db: MemoryDb, nodeId: string, sourceId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM node_sources WHERE source_id = ? AND node_id != ?
    UNION ALL SELECT 1 FROM candidates WHERE source_id = ?
    UNION ALL SELECT 1 FROM profile_slot_sources WHERE source_id = ? LIMIT 1`)
    .get(sourceId, nodeId, sourceId, sourceId));
}

// Legacy node_sources links do not attest that a quote belongs exclusively to
// this node. A shared excerpt may paraphrase other owners, so comparing their
// literal content cannot establish isolation. Project the allowed assertion
// whenever ownership is ambiguous; keep quotes for sources with a single owner.
export function sourceEvidenceForNode(db: MemoryDb, nodeId: string, sourceId: string, evidence: string | null): string | null {
  if (!hasOtherSourceOwners(db, nodeId, sourceId)) return evidence;
  const node = db.prepare("SELECT content FROM nodes WHERE id = ?").get(nodeId) as { content: string };
  return redactSecrets(node.content);
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

  const protectedHistory = db.prepare(`SELECT 1 FROM memory_revisions
    WHERE memory_id = ? AND (previous_privacy_level != 'normal' OR next_privacy_level != 'normal') LIMIT 1`).get(nodeId);
  return rows.map((row) => {
    const source = mapSource(row as never);
    const shared = source.kind === "conversation" || hasOtherSourceOwners(db, nodeId, source.id);
    if (!shared && !protectedHistory) return source;
    const evidence = db.prepare("SELECT evidence_text FROM node_sources WHERE node_id = ? AND source_id = ?").get(nodeId, source.id) as { evidence_text: string | null };
    return {
      ...source,
      title: "[redacted: shared source]",
      external_id: null,
      content_excerpt: protectedHistory ? "[redacted: protected source]" : redactSecrets(sourceEvidenceForNode(db, nodeId, source.id, evidence.evidence_text) ?? ""),
      metadata: {}
    };
  });
}

export function listSourceEvidenceForNode(
  db: MemoryDb,
  nodeId: string
): Array<{ source_id: string; evidence_text: string | null }> {
  const rows = db
    .prepare(
      `SELECT source_id, evidence_text
       FROM node_sources
       WHERE node_id = ?
       ORDER BY created_at DESC`
    )
    .all(nodeId) as Array<{ source_id: string; evidence_text: string | null }>;
  return rows.map((row) => ({ ...row, evidence_text: sourceEvidenceForNode(db, nodeId, row.source_id, row.evidence_text) }));
}
