import type { MemoryDb } from "../db/connection.js";
import { ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { nowIso } from "../shared/time.js";
import { mapNode } from "./mappers.js";
import { getMemory } from "./nodes.js";
import { assertSafeForStorage, redactSecrets, sanitizeMetadata } from "./privacy.js";
import { scopeSqlParts } from "./scope.js";
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
  next: Pick<MemoryNode, "content" | "scope">,
  reason: string
): MemoryRevision {
  const revision: MemoryRevision = {
    id: newId("mem_rev"),
    memory_id: existing.id,
    previous_content: existing.content,
    next_content: next.content,
    previous_scope: existing.scope,
    next_scope: next.scope,
    reason: redactSecrets(reason),
    created_at: nowIso()
  };
  db.prepare(
    `INSERT INTO memory_revisions (
      id, memory_id, previous_content, next_content, previous_scope_json, next_scope_json, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    revision.id,
    revision.memory_id,
    revision.previous_content,
    revision.next_content,
    JSON.stringify(revision.previous_scope),
    JSON.stringify(revision.next_scope),
    revision.reason,
    revision.created_at
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
    clauses.push("(LOWER(content) LIKE ? OR LOWER(type) LIKE ? OR LOWER(id) LIKE ?)");
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
  const nextMetadata = input.metadata
    ? { ...existing.metadata, ...sanitizeMetadata(input.metadata) }
    : existing.metadata;
  const now = nowIso();

  const transaction = db.transaction(() => {
    insertRevision(db, existing, { content: nextContent, scope: nextScope }, input.reason ?? "memory corrected");
    db.prepare(
      `UPDATE nodes SET
         content = ?, scope_kind = ?, scope_user_id = ?, scope_project_id = ?,
         scope_workspace_id = ?, scope_agent_id = ?, scope_conversation_id = ?,
         confidence = ?, privacy_level = ?, metadata_json = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      nextContent,
      nextScope.kind,
      nextScope.user_id ?? null,
      nextScope.project_id ?? null,
      nextScope.workspace_id ?? null,
      nextScope.agent_id ?? null,
      nextScope.conversation_id ?? null,
      input.confidence ?? existing.confidence,
      input.privacy_level ?? existing.privacy_level,
      JSON.stringify(nextMetadata),
      now,
      id
    );
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
  });
  transaction();
  return getMemory(db, id);
}

export function forgetMemory(db: MemoryDb, id: string, reason = "deleted by user"): MemoryNode {
  const existing = getMemory(db, id);
  if (existing.status === "deleted") {
    return existing;
  }
  const tombstone = "[deleted by user]";
  const now = nowIso();
  const transaction = db.transaction(() => {
    db.prepare("UPDATE edges SET status = 'deleted', updated_at = ? WHERE from_id = ? OR to_id = ?").run(now, id, id);
    const sourceRows = db.prepare("SELECT source_id FROM node_sources WHERE node_id = ?").all(id) as Array<{ source_id: string }>;
    db.prepare("DELETE FROM node_sources WHERE node_id = ?").run(id);
    for (const source of sourceRows) {
      db.prepare(
        `DELETE FROM sources
         WHERE id = ? AND NOT EXISTS (SELECT 1 FROM node_sources WHERE source_id = ?)
                      AND NOT EXISTS (SELECT 1 FROM profile_slot_sources WHERE source_id = ?)
                      AND NOT EXISTS (SELECT 1 FROM profile_slot_revisions WHERE source_id = ?)
                      AND NOT EXISTS (SELECT 1 FROM candidates WHERE source_id = ?)`
      ).run(source.source_id, source.source_id, source.source_id, source.source_id, source.source_id);
    }

    const slots = db.prepare("SELECT id, metadata_json FROM profile_slots WHERE status = 'active'").all() as Array<{
      id: string;
      metadata_json: string;
    }>;
    for (const slot of slots) {
      const metadata = JSON.parse(slot.metadata_json) as Record<string, unknown>;
      if (metadata.source_memory_id === id) {
        db.prepare(
          "UPDATE profile_slots SET content = ?, status = 'deleted', metadata_json = ?, updated_at = ? WHERE id = ?"
        ).run(tombstone, JSON.stringify({ deleted_from_memory_id: id }), now, slot.id);
        db.prepare(
          "UPDATE profile_slot_revisions SET previous_content = ?, next_content = ? WHERE slot_id = ?"
        ).run(tombstone, tombstone, slot.id);
      }
    }

    db.prepare(
      `UPDATE nodes
       SET content = ?, status = 'deleted', metadata_json = ?, updated_at = ?
       WHERE id = ?`
    ).run(tombstone, JSON.stringify({ deletion_reason: reason }), now, id);
    db.prepare(
      "UPDATE memory_revisions SET previous_content = ?, next_content = ? WHERE memory_id = ?"
    ).run(tombstone, tombstone, id);
    db.prepare("UPDATE memory_feedback SET comment = NULL WHERE memory_id = ?").run(id);
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
