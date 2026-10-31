import type { MemoryDb } from "../db/connection.js";
import { ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { nowIso } from "../shared/time.js";
import { mapNode } from "./mappers.js";
import { linkScopesCompatible, metadataKnowledgeScope } from "./links.js";
import { getMemory } from "./nodes.js";
import { archiveProfileForMemory, synchronizeProfileForMemory } from "./profile.js";
import { assertSafeForStorage, redactSecrets, replacementMetadata, protectHistoricalValue } from "./privacy.js";
import { scopeSqlParts } from "./scope.js";
import { hasAttestedNodeEvidence } from "./sources.js";
import type {
  MemoryFeedback,
  MemoryNode,
  MemoryRevision,
  PrivacyLevel,
  Scope
} from "./types.js";

export type MemoryListQuery = {
  query?: string;
  scope?: Scope;
  types?: string[];
  status?: MemoryNode["status"];
  limit?: number;
  offset?: number;
};

export type UpdateMemoryInput = {
  content?: string;
  scope?: Scope;
  confidence?: number;
  privacy_level?: PrivacyLevel;
  metadata?: Record<string, unknown>;
  reason?: string;
};

type RevisionRow = {
  previous_privacy_level: PrivacyLevel;
  next_privacy_level: PrivacyLevel;
  id: string;
  memory_id: string;
  previous_content: string | null;
  next_content: string;
  previous_scope_json: string | null;
  next_scope_json: string;
  reason: string | null;
  created_at: string;
};

type FeedbackRow = {
  id: string;
  memory_id: string;
  rating: MemoryFeedback["rating"];
  comment: string | null;
  action: string | null;
  created_at: string;
};

function mapRevision(row: RevisionRow): MemoryRevision {
  return {
    id: row.id,
    memory_id: row.memory_id,
    previous_privacy_level: row.previous_privacy_level,
    next_privacy_level: row.next_privacy_level,
    previous_content: row.previous_content,
    next_content: row.next_content,
    previous_scope: row.previous_scope_json ? JSON.parse(row.previous_scope_json) : null,
    next_scope: JSON.parse(row.next_scope_json),
    reason: row.reason,
    created_at: row.created_at
  };
}

function insertRevision(
  db: MemoryDb,
  existing: MemoryNode,
  next: Pick<MemoryNode, "content" | "scope" | "privacy_level">,
  reason: string
): MemoryRevision {
  const revision: MemoryRevision = {
    id: newId("mem_rev"),
    memory_id: existing.id,
    previous_privacy_level: existing.privacy_level,
    next_privacy_level: next.privacy_level,
    previous_content: existing.content,
    next_content: next.content,
    previous_scope: existing.scope,
    next_scope: next.scope,
    reason: redactSecrets(reason),
    created_at: nowIso()
  };
  db.prepare(
    `INSERT INTO memory_revisions (
      id, memory_id, previous_content, next_content, previous_scope_json, next_scope_json, reason, created_at, previous_privacy_level, next_privacy_level
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    revision.id,
    revision.memory_id,
    revision.previous_content,
    revision.next_content,
    JSON.stringify(revision.previous_scope),
    JSON.stringify(revision.next_scope),
    revision.reason,
    revision.created_at,
    revision.previous_privacy_level,
    revision.next_privacy_level
  );
  return revision;
}

export function listMemories(db: MemoryDb, input: MemoryListQuery = {}) {
  const status = input.status ?? "active";
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  const offset = Math.max(0, input.offset ?? 0);
  const scope = scopeSqlParts(input.scope);
  const params: unknown[] = [status, ...scope.params];
  const clauses = ["status = ?", scope.clause];

  if (input.types?.length) {
    clauses.push(`type IN (${input.types.map(() => "?").join(", ")})`);
    params.push(...input.types);
  }
  if (input.query?.trim()) {
    clauses.push("(js_lower(content) LIKE ? OR js_lower(type) LIKE ? OR js_lower(id) LIKE ?)");
    const query = `%${input.query.trim().toLowerCase()}%`;
    params.push(query, query, query);
  }

  const rows = db
    .prepare(
      `SELECT * FROM nodes
       WHERE ${clauses.join(" AND ")}
       ORDER BY updated_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);
  const count = db
    .prepare(`SELECT COUNT(*) AS count FROM nodes WHERE ${clauses.join(" AND ")}`)
    .get(...params) as { count: number };
  return {
    memories: rows.map((row) => mapNode(row as never)),
    total: count.count,
    limit,
    offset
  };
}

export function updateMemory(db: MemoryDb, id: string, input: UpdateMemoryInput): MemoryNode {
  const existing = getMemory(db, id);
  if (existing.status !== "active") {
    throw new ValidationError(`Memory ${id} is ${existing.status}, not active`);
  }
  if (input.content !== undefined) {
    assertSafeForStorage(input.content, "memory content");
  }
  const nextContent = input.content ?? existing.content;
  const nextScope = input.scope ?? existing.scope;
  const nextMetadata = replacementMetadata(db, existing.metadata, input.metadata, existing.privacy_level !== "normal", input.privacy_level ?? existing.privacy_level);
  const nextKnowledgeScope = metadataKnowledgeScope(nextMetadata, nextScope);
  nextMetadata.knowledge_scope = nextKnowledgeScope;
  const now = nowIso();

  const transaction = db.transaction(() => {
    const proposed = { ...existing, scope: nextScope, metadata: nextMetadata };
    const edges = db.prepare("SELECT from_id, to_id, relation FROM edges WHERE status = 'active' AND (from_id = ? OR to_id = ?)").all(id, id) as Array<{ from_id: string; to_id: string; relation: string }>;
    for (const edge of edges) {
      const other = getMemory(db, edge.from_id === id ? edge.to_id : edge.from_id);
      if (!linkScopesCompatible(proposed, other, edge.relation)) {
        throw new ValidationError("Scope change would invalidate active links");
      }
    }
    insertRevision(db, existing, { content: nextContent, scope: nextScope, privacy_level: input.privacy_level ?? existing.privacy_level }, input.reason ?? "memory corrected");
    protectHistoricalValue(db, "memory_revisions", id, existing.content, input.privacy_level ?? existing.privacy_level);
    db.prepare(
      `UPDATE nodes SET
         content = ?, scope_kind = ?, scope_user_id = ?, scope_project_id = ?,
         scope_workspace_id = ?, scope_agent_id = ?, scope_conversation_id = ?,
         knowledge_scope = ?, confidence = ?, privacy_level = ?, metadata_json = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      nextContent,
      nextScope.kind,
      nextScope.user_id ?? null,
      nextScope.project_id ?? null,
      nextScope.workspace_id ?? null,
      nextScope.agent_id ?? null,
      nextScope.conversation_id ?? null,
      nextKnowledgeScope,
      input.confidence ?? existing.confidence,
      input.privacy_level ?? existing.privacy_level,
      JSON.stringify(nextMetadata),
      now,
      id
    );
    db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(id);
    synchronizeProfileForMemory(db, getMemory(db, id), input.reason ?? "memory corrected");
  });
  transaction();
  return getMemory(db, id);
}

export function archiveMemory(db: MemoryDb, id: string, reason = "memory archived"): MemoryNode {
  const existing = getMemory(db, id);
  if (existing.status !== "active") {
    return existing;
  }
  const transaction = db.transaction(() => {
    insertRevision(db, existing, existing, reason);
    db.prepare("UPDATE nodes SET status = 'archived', updated_at = ? WHERE id = ?").run(nowIso(), id);
    db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(id);
    archiveProfileForMemory(db, id, reason);
  });
  transaction();
  return getMemory(db, id);
}

export function forgetMemory(db: MemoryDb, id: string, _reason = "deleted by user"): MemoryNode {
  const existing = getMemory(db, id);
  if (existing.status === "deleted") {
    return existing;
  }
  const tombstone = "[deleted by user]";
  const now = nowIso();
  const transaction = db.transaction(() => {
    const candidateRows = db
      .prepare(
        `SELECT DISTINCT id, source_id FROM candidates
         WHERE json_extract(metadata_json, '$.approved_memory_id') = ?
            OR id = json_extract((SELECT metadata_json FROM nodes WHERE id = ?), '$.approved_from_candidate_id')
            OR id IN (SELECT candidate_id FROM candidate_conflicts WHERE memory_id = ?)`
      )
      .all(id, id, id) as Array<{ id: string; source_id: string | null }>;
    const candidateIds = candidateRows.map((row) => row.id);
    const forgottenValues = new Set([existing.content, ...candidateRows.map((row) =>
      (db.prepare("SELECT content FROM candidates WHERE id = ?").get(row.id) as { content: string }).content)]);
    const historical = db.prepare("SELECT previous_content, next_content FROM memory_revisions WHERE memory_id = ?").all(id) as Array<{ previous_content: string | null; next_content: string }>;
    historical.forEach((revision) => { if (revision.previous_content) forgottenValues.add(revision.previous_content); forgottenValues.add(revision.next_content); });
    const sourceRows = db.prepare("SELECT source_id FROM node_sources WHERE node_id = ?").all(id) as Array<{ source_id: string }>;
    const sourceIds = new Set([
      ...sourceRows.map((row) => row.source_id),
      ...candidateRows.flatMap((row) => (row.source_id ? [row.source_id] : []))
    ]);

    db.prepare(
      `UPDATE edges
       SET status = 'deleted', metadata_json = '{}', updated_at = ?
       WHERE from_id = ? OR to_id = ?`
    ).run(now, id, id);
    db.prepare("DELETE FROM node_sources WHERE node_id = ?").run(id);

    for (const candidateId of candidateIds) {
      db.prepare(
        `UPDATE candidates
         SET content = ?, status = 'rejected', source_id = NULL, metadata_json = '{}', updated_at = ?
         WHERE id = ?`
      ).run(tombstone, now, candidateId);
      db.prepare(
        `UPDATE candidate_conflicts
         SET status = 'resolved', reason = ?, question = ?, resolution = ?, updated_at = ?
         WHERE candidate_id = ?`
      ).run(tombstone, tombstone, "Forgotten with related memory.", now, candidateId);
    }

    db.prepare(
      `UPDATE candidate_conflicts
       SET status = 'resolved', reason = ?, question = ?, resolution = ?, updated_at = ?
       WHERE memory_id = ?`
    ).run(tombstone, tombstone, "Forgotten with related memory.", now, id);

    const slotRows = db
      .prepare(
        `SELECT DISTINCT ps.id
         FROM profile_slots ps
         LEFT JOIN profile_slot_revisions revision ON revision.slot_id = ps.id
         WHERE json_extract(ps.metadata_json, '$.source_memory_id') = ?
            OR revision.memory_id = ?
            OR revision.candidate_id IN (${candidateIds.length > 0 ? candidateIds.map(() => "?").join(",") : "NULL"})`
      )
      .all(id, id, ...candidateIds) as Array<{ id: string }>;
    for (const slot of slotRows) {
      // NULL memory_id in legacy manual revisions inherits the preceding owner.
      // On replacement, previous_content still belongs to the outgoing owner.
      const revisions = db.prepare(`SELECT memory_id, previous_content, next_content
        FROM profile_slot_revisions WHERE slot_id = ? ORDER BY rowid`)
        .all(slot.id) as Array<{ memory_id: string | null; previous_content: string | null; next_content: string }>;
      let owner: string | null = null;
      for (const revision of revisions) {
        if (owner === id && revision.previous_content) forgottenValues.add(revision.previous_content);
        owner = revision.memory_id ?? owner;
        if (owner === id) forgottenValues.add(revision.next_content);
      }
      const historicalSources = db.prepare("SELECT source_id FROM profile_slot_revisions WHERE slot_id = ? AND memory_id = ? AND source_id IS NOT NULL")
        .all(slot.id, id) as Array<{ source_id: string }>;
      historicalSources.forEach((row) => sourceIds.add(row.source_id));
      for (const value of forgottenValues) {
        db.prepare("UPDATE profile_slot_revisions SET previous_content = ?, reason = ? WHERE slot_id = ? AND previous_content = ?").run(tombstone, tombstone, slot.id, value);
        db.prepare("UPDATE profile_slot_revisions SET next_content = ?, reason = ? WHERE slot_id = ? AND next_content = ?").run(tombstone, tombstone, slot.id, value);
        db.prepare("UPDATE profile_slot_sources SET evidence_text = ? WHERE slot_id = ? AND evidence_text = ?").run(tombstone, slot.id, value);
      }
      const current = db.prepare("SELECT metadata_json FROM profile_slots WHERE id = ?").get(slot.id) as { metadata_json: string };
      if (JSON.parse(current.metadata_json).source_memory_id !== id) {
        db.prepare(`UPDATE profile_slot_revisions SET previous_content = ?, next_content = ?, reason = ?
          WHERE slot_id = ? AND memory_id = ?`).run(tombstone, tombstone, tombstone, slot.id, id);
        continue;
      }
      const slotSourceRows = db
        .prepare("SELECT source_id FROM profile_slot_sources WHERE slot_id = ?")
        .all(slot.id) as Array<{ source_id: string }>;
      for (const row of slotSourceRows) {
        sourceIds.add(row.source_id);
      }
      db.prepare(
        `UPDATE profile_slots
         SET topic = 'deleted', sub_topic = 'memory', content = ?, status = 'deleted',
             metadata_json = '{}', updated_at = ?
         WHERE id = ?`
      ).run(tombstone, now, slot.id);
      db.prepare("UPDATE profile_slot_sources SET evidence_text = ? WHERE slot_id = ?").run(tombstone, slot.id);
      db.prepare(
        `UPDATE profile_slot_revisions
         SET previous_content = ?, next_content = ?, reason = ?
         WHERE slot_id = ?`
      ).run(tombstone, tombstone, tombstone, slot.id);
    }

    for (const sourceId of sourceIds) {
      // Legacy evidence can duplicate a complete shared conversation. Rebuild
      // contaminated surviving links only when the quote lacks valid provenance.
      const evidenceRows = db.prepare("SELECT node_id, evidence_text FROM node_sources WHERE source_id = ?")
        .all(sourceId) as Array<{ node_id: string; evidence_text: string | null }>;
      for (const row of evidenceRows) {
        if (hasAttestedNodeEvidence(db, row.node_id, sourceId, row.evidence_text)) continue;
        const evidence = row.evidence_text;
        if (evidence && [...forgottenValues].some((value) => evidence.includes(value))) {
          db.prepare(`UPDATE node_sources SET evidence_text = (SELECT content FROM nodes WHERE id = node_id)
            WHERE node_id = ? AND source_id = ?`).run(row.node_id, sourceId);
        }
      }
      for (const value of forgottenValues) {
        db.prepare(`UPDATE profile_slot_sources SET evidence_text = (SELECT content FROM profile_slots WHERE id = slot_id)
          WHERE source_id = ? AND evidence_text != ? AND instr(evidence_text, ?) > 0`).run(sourceId, tombstone, value);
      }
      const remaining = db.prepare(`SELECT ns.node_id, ns.evidence_text FROM node_sources ns JOIN nodes n ON n.id = ns.node_id
        WHERE ns.source_id = ? AND n.status != 'deleted'
        UNION ALL SELECT NULL, pss.evidence_text FROM profile_slot_sources pss JOIN profile_slots ps ON ps.id = pss.slot_id
        WHERE pss.source_id = ? AND ps.status != 'deleted'`).all(sourceId, sourceId) as Array<{ node_id: string | null; evidence_text: string | null }>;
      const retained = remaining.filter((row) => (row.node_id !== null
        && hasAttestedNodeEvidence(db, row.node_id, sourceId, row.evidence_text))
        || ![...forgottenValues].some((forgotten) => row.evidence_text?.includes(forgotten)))
        .map((row) => row.evidence_text).filter((value): value is string => Boolean(value && value !== tombstone));
      db.prepare(
        `UPDATE sources
         SET external_id = NULL, title = ?, content_excerpt = ?, metadata_json = '{}'
         WHERE id = ?`
      ).run(retained.length ? "Shared evidence" : tombstone, retained.length ? retained.join("\n") : tombstone, sourceId);
    }

    db.prepare(
      `UPDATE nodes
       SET content = ?, status = 'deleted', metadata_json = ?, updated_at = ?
       WHERE id = ?`
    ).run(tombstone, JSON.stringify({ deletion_reason: "user_request" }), now, id);
    db.prepare(
      "UPDATE memory_revisions SET previous_content = ?, next_content = ?, reason = ? WHERE memory_id = ?"
    ).run(tombstone, tombstone, tombstone, id);
    db.prepare("UPDATE memory_feedback SET comment = NULL, action = NULL WHERE memory_id = ?").run(id);
    db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(id);
  });
  transaction();
  return getMemory(db, id);
}

export function addMemoryFeedback(
  db: MemoryDb,
  memoryId: string,
  input: Omit<MemoryFeedback, "id" | "memory_id" | "created_at">
): MemoryFeedback {
  getMemory(db, memoryId);
  if (input.comment) {
    assertSafeForStorage(input.comment, "feedback comment");
  }
  const feedback: MemoryFeedback = {
    id: newId("feedback"),
    memory_id: memoryId,
    rating: input.rating,
    comment: input.comment ?? null,
    action: input.action ? redactSecrets(input.action) : null,
    created_at: nowIso()
  };
  db.prepare(
    "INSERT INTO memory_feedback (id, memory_id, rating, comment, action, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    feedback.id,
    feedback.memory_id,
    feedback.rating,
    feedback.comment,
    feedback.action,
    feedback.created_at
  );
  return feedback;
}

export function listMemoryRevisions(db: MemoryDb, memoryId: string): MemoryRevision[] {
  getMemory(db, memoryId);
  return (
    db.prepare("SELECT * FROM memory_revisions WHERE memory_id = ? ORDER BY created_at DESC").all(memoryId) as RevisionRow[]
  ).map(mapRevision);
}

export function listMemoryFeedback(db: MemoryDb, memoryId: string): MemoryFeedback[] {
  getMemory(db, memoryId);
  return (
    db.prepare("SELECT * FROM memory_feedback WHERE memory_id = ? ORDER BY created_at DESC").all(memoryId) as FeedbackRow[]
  ).map((row) => ({ ...row }));
}
