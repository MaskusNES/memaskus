import type { MemoryDb } from "../db/connection.js";
import { ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { nowIso } from "../shared/time.js";
import { mapEdge, mapNode } from "./mappers.js";
import { getMemory } from "./nodes.js";
import { sanitizeMetadata } from "./privacy.js";
import { exactScopeMatch } from "./scope.js";
import type { Edge, MemoryNode, Scope } from "./types.js";

export type CreateLinkInput = {
  from_id: string;
  to_id: string;
  relation: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
};

export type KnowledgeScope = "global" | "project_local";

export function metadataKnowledgeScope(metadata: Record<string, unknown>, scope?: Scope): KnowledgeScope {
  const value = metadata.knowledge_scope ?? metadata.memory_layer;
  if (value === "global" || value === "project_local") {
    return value;
  }

  return scope?.kind === "global" ? "global" : "project_local";
}

export function knowledgeScope(memory: MemoryNode): KnowledgeScope {
  return metadataKnowledgeScope(memory.metadata, memory.scope);
}

export function createLink(db: MemoryDb, input: CreateLinkInput): Edge {
  const from = getMemory(db, input.from_id);
  const to = getMemory(db, input.to_id);

  if (knowledgeScope(from) !== knowledgeScope(to)) {
    throw new ValidationError(
      `Cannot link ${knowledgeScope(from)} memory ${from.id} to ${knowledgeScope(to)} memory ${to.id}`
    );
  }

  const now = nowIso();
  const edge: Edge = {
    id: newId("edge"),
    from_id: input.from_id,
    to_id: input.to_id,
    relation: input.relation,
    confidence: input.confidence ?? 0.8,
    status: "active",
    metadata: sanitizeMetadata(input.metadata),
    created_at: now,
    updated_at: now
  };

  db.prepare(
    `INSERT INTO edges (
      id, from_id, to_id, relation, confidence, status, metadata_json, created_at, updated_at
    ) VALUES (
      @id, @from_id, @to_id, @relation, @confidence, @status, @metadata_json, @created_at, @updated_at
    )`
  ).run({
    ...edge,
    metadata_json: JSON.stringify(edge.metadata)
  });

  return edge;
}

function tokenize(text: string): Set<string> {
  const stopWords = new Set([
    "пользователь",
    "предпочитает",
    "предпочитаю",
    "хочет",
    "чтобы",
    "который",
    "которые",
    "после",
    "перед",
    "только",
    "вместо",
    "агента",
    "агентов",
    "диалога",
    "памяти",
    "запись",
    "записи",
    "новой",
    "существующей",
    "user",
    "prefers",
    "wants",
    "should",
    "memory",
    "agent",
    "agents"
  ]);

  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_:-]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length > 3 && !stopWords.has(token))
  );
}

function overlapScore(left: string, right: string): number {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return shared / Math.min(leftTokens.size, rightTokens.size);
}

function scopeMatches(left: Scope, right: Scope): boolean {
  if (left.kind === "global" || right.kind === "global") {
    return true;
  }
  return exactScopeMatch(left, right);
}

function linkExists(db: MemoryDb, fromId: string, toId: string, relation: string): boolean {
  const row = db
    .prepare(
      `SELECT id FROM edges
       WHERE status = 'active'
         AND relation = ?
         AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))
       LIMIT 1`
    )
    .get(relation, fromId, toId, toId, fromId);
  return Boolean(row);
}

export function createRelatedLinksForMemory(
  db: MemoryDb,
  memory: MemoryNode,
  options: { threshold?: number; limit?: number } = {}
): Edge[] {
  const threshold = options.threshold ?? 0.18;
  const limit = options.limit ?? 5;
  const rows = db.prepare("SELECT * FROM nodes WHERE status = 'active' AND id != ? ORDER BY updated_at DESC LIMIT 200").all(memory.id);
  const related = rows
    .map((row) => mapNode(row as never))
    .filter((candidate) => scopeMatches(memory.scope, candidate.scope))
    .filter((candidate) => knowledgeScope(memory) === knowledgeScope(candidate))
    .map((candidate) => ({
      memory: candidate,
      score: Math.max(overlapScore(memory.content, candidate.content), overlapScore(candidate.content, memory.content))
    }))
    .filter((item) => item.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return related.flatMap((item) => {
    if (linkExists(db, memory.id, item.memory.id, "RELATED_TO")) {
      return [];
    }

    return [
      createLink(db, {
        from_id: memory.id,
        to_id: item.memory.id,
        relation: "RELATED_TO",
        confidence: Number(Math.min(0.95, Math.max(0.55, item.score)).toFixed(2)),
        metadata: {
          linker: "token-overlap-v0",
          score: Number(item.score.toFixed(3))
        }
      })
    ];
  });
}

export function listEdgesForNode(db: MemoryDb, nodeId: string): { incoming: Edge[]; outgoing: Edge[] } {
  const incoming = db.prepare("SELECT * FROM edges WHERE to_id = ? AND status = 'active'").all(nodeId);
  const outgoing = db.prepare("SELECT * FROM edges WHERE from_id = ? AND status = 'active'").all(nodeId);
  return {
    incoming: incoming.map((row) => mapEdge(row as never)),
    outgoing: outgoing.map((row) => mapEdge(row as never))
  };
}
