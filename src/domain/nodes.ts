import type { MemoryDb } from "../db/connection.js";
import { NotFoundError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { nowIso } from "../shared/time.js";
import { mapNode } from "./mappers.js";
import { assertSafeForStorage, redactSecrets, sanitizeMetadata } from "./privacy.js";
import { createSource, type CreateSourceInput } from "./sources.js";
import type { MemoryNode, PrivacyLevel, Scope } from "./types.js";

export type CreateMemoryInput = {
  type: string;
  content: string;
  scope?: Scope;
  confidence?: number;
  privacy_level?: PrivacyLevel;
  source?: CreateSourceInput;
  metadata?: Record<string, unknown>;
};

function defaultKnowledgeScope(scope: Scope): "global" | "project_local" {
  return scope.kind === "global" ? "global" : "project_local";
}

function normalizeMetadata(metadata: Record<string, unknown> | undefined, scope: Scope): Record<string, unknown> {
  const normalized = sanitizeMetadata(metadata);
  if (normalized.knowledge_scope !== "global" && normalized.knowledge_scope !== "project_local") {
    normalized.knowledge_scope = defaultKnowledgeScope(scope);
  }
  return normalized;
}

export function createMemory(db: MemoryDb, input: CreateMemoryInput): MemoryNode {
  assertSafeForStorage(input.content, "memory content");
  const now = nowIso();
  const scope = input.scope ?? { kind: "global" };
  const metadata = normalizeMetadata(input.metadata, scope);
  const node: MemoryNode = {
    id: newId("node"),
    type: input.type,
    content: input.content,
    scope,
    confidence: input.confidence ?? 0.8,
    status: "active",
    privacy_level: input.privacy_level ?? "normal",
    metadata,
    created_at: now,
    updated_at: now
  };

  const transaction = db.transaction(() => {
    db.prepare(
      `INSERT INTO nodes (
        id, type, content, scope_kind, scope_user_id, scope_project_id,
        scope_workspace_id, scope_agent_id, scope_conversation_id, knowledge_scope, confidence, status, privacy_level,
        metadata_json, created_at, updated_at
      ) VALUES (
        @id, @type, @content, @scope_kind, @scope_user_id, @scope_project_id,
        @scope_workspace_id, @scope_agent_id, @scope_conversation_id, @knowledge_scope, @confidence, @status, @privacy_level,
        @metadata_json, @created_at, @updated_at
      )`
    ).run({
      id: node.id,
      type: node.type,
      content: node.content,
      scope_kind: scope.kind,
      scope_user_id: scope.user_id ?? null,
      scope_project_id: scope.project_id ?? null,
      scope_workspace_id: scope.workspace_id ?? null,
      scope_agent_id: scope.agent_id ?? null,
      scope_conversation_id: scope.conversation_id ?? null,
      knowledge_scope: metadata.knowledge_scope,
      confidence: node.confidence,
      status: node.status,
      privacy_level: node.privacy_level,
      metadata_json: JSON.stringify(node.metadata),
      created_at: node.created_at,
      updated_at: node.updated_at
    });

    if (input.source) {
      const source = createSource(db, input.source);
      db.prepare(
        `INSERT INTO node_sources (node_id, source_id, evidence_text, created_at)
         VALUES (?, ?, ?, ?)`
      ).run(node.id, source.id, redactSecrets(input.source.content_excerpt ?? input.content), now);
    }
  });

  transaction();
  return node;
}

export function getMemory(db: MemoryDb, id: string): MemoryNode {
  const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
  if (!row) {
    throw new NotFoundError(`Memory ${id} was not found`);
  }
  return mapNode(row as never);
}
