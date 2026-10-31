import { createHash } from "node:crypto";
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

// Candidate approval and profile projection create additional links for the
// same assertion. Exempt only explicit, compatible provenance; an independent
// owner (even one with identical content) still makes the source ambiguous.
function hasOtherSourceOwners(db: MemoryDb, nodeId: string, sourceId: string): boolean {
  return Boolean(db.prepare(`WITH node AS (SELECT * FROM nodes WHERE id = @nodeId),
    origin AS (
      SELECT c.id FROM candidates c, node n
      JOIN node_source_provenance provenance ON provenance.node_id = n.id AND provenance.source_id = @sourceId
      WHERE c.id = provenance.originating_candidate_id
        AND c.id = json_extract(n.metadata_json, '$.approved_from_candidate_id')
        AND c.status = 'approved' AND c.privacy_level = 'normal' AND n.privacy_level = 'normal'
        AND c.knowledge_scope = n.knowledge_scope AND c.scope_kind = n.scope_kind
        AND c.scope_user_id IS n.scope_user_id AND c.scope_project_id IS n.scope_project_id
        AND c.scope_workspace_id IS n.scope_workspace_id AND c.scope_agent_id IS n.scope_agent_id
        AND c.scope_conversation_id IS n.scope_conversation_id
    )
    SELECT 1 FROM node_sources WHERE source_id = @sourceId AND node_id != @nodeId
    UNION ALL SELECT 1 FROM candidates WHERE source_id = @sourceId AND id NOT IN (SELECT id FROM origin)
    UNION ALL SELECT 1 FROM profile_slot_sources pss
      JOIN profile_slots ps ON ps.id = pss.slot_id JOIN node n
      WHERE pss.source_id = @sourceId AND NOT (
        n.privacy_level = 'normal' AND ps.privacy_level = 'normal' AND ps.status = 'active'
        AND ps.knowledge_scope = n.knowledge_scope
        AND ps.scope_project_id IS CASE WHEN n.knowledge_scope = 'project_local' THEN n.scope_project_id ELSE NULL END
        AND n.scope_kind IN ('global', 'project', 'user')
        AND ps.user_id = COALESCE(n.scope_user_id, 'default')
        AND json_extract(ps.metadata_json, '$.projected_from_memory') IS 1
        AND json_extract(ps.metadata_json, '$.source_memory_id') IS n.id
        AND EXISTS (SELECT 1 FROM profile_slot_revisions r
          WHERE r.slot_id = ps.id AND r.source_id = @sourceId AND r.memory_id = n.id)
        AND NOT EXISTS (SELECT 1 FROM profile_slot_revisions r WHERE r.slot_id = ps.id
          AND (r.previous_privacy_level != 'normal' OR r.next_privacy_level != 'normal'
            OR r.memory_id IS NOT n.id
            OR (r.source_id = @sourceId AND r.candidate_id IS NOT NULL
              AND r.candidate_id NOT IN (SELECT id FROM origin))))
      ) LIMIT 1`).get({ nodeId, sourceId }));
}

// Called only after engine-controlled writes binding explicit evidence to a node.
// A digest binds the attestation to the exact stored quote without duplicating it.
export function attestNodeEvidence(db: MemoryDb, nodeId: string, sourceId: string, originatingCandidateId?: string): void {
  const row = db.prepare("SELECT evidence_text FROM node_sources WHERE node_id = ? AND source_id = ?").get(nodeId, sourceId) as { evidence_text: string | null };
  if (row.evidence_text === null) return;
  db.prepare(`INSERT OR REPLACE INTO node_source_provenance (node_id, source_id, evidence_digest, originating_candidate_id) VALUES (?, ?, ?, ?)`)
    .run(nodeId, sourceId, createHash("sha256").update(row.evidence_text).digest("hex"), originatingCandidateId ?? null);
}

export function hasAttestedNodeEvidence(db: MemoryDb, nodeId: string, sourceId: string, evidence: string | null): boolean {
  const provenance = db.prepare("SELECT evidence_digest FROM node_source_provenance WHERE node_id = ? AND source_id = ?").get(nodeId, sourceId) as { evidence_digest: string } | undefined;
  return evidence !== null && provenance?.evidence_digest === createHash("sha256").update(evidence).digest("hex");
}

export function sourceEvidenceForNode(db: MemoryDb, nodeId: string, sourceId: string, evidence: string | null): string | null {
  if (hasAttestedNodeEvidence(db, nodeId, sourceId, evidence)) return evidence;
  // Legacy shared transcripts have no trustworthy per-node attribution.
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

// Ownership and quote integrity are engine-controlled; caller metadata is never proof.
export function profileEvidenceProvenance(db: MemoryDb, slotId: string, sourceId: string, evidence: string | null):
  { memory_id: string | null; candidate_id: string | null } | undefined {
  const row = db.prepare(`SELECT evidence_digest, memory_id, candidate_id FROM profile_source_provenance
    WHERE slot_id = ? AND source_id = ?`).get(slotId, sourceId) as
    { evidence_digest: string; memory_id: string | null; candidate_id: string | null } | undefined;
  return evidence !== null && row?.evidence_digest === createHash("sha256").update(evidence).digest("hex") ? row : undefined;
}
