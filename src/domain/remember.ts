import { isDeepStrictEqual } from "node:util";
import type { MemoryDb } from "../db/connection.js";
import { nowIso } from "../shared/time.js";
import { createRelatedLinksForMemory } from "./links.js";
import { mapNode } from "./mappers.js";
import { createMemory, getMemory, normalizeMemoryMetadata, type CreateMemoryInput } from "./nodes.js";
import { assertSafeForStorage, redactSecrets } from "./privacy.js";
import { applyMemoryToProfile, synchronizeProfileForMemory } from "./profile.js";
import { createSource } from "./sources.js";

function contentKey(content: string): string {
  return content.toLowerCase().trim().replace(/\s+/gu, " ").replace(/\.$/u, "").trim();
}

function mergeMetadata(existing: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> | null {
  const { tags: oldTags, ...oldRest } = existing;
  const { tags: newTags, ...newRest } = incoming;
  if (!isDeepStrictEqual(oldRest, newRest)) return null;
  const stringTags = (value: unknown): value is string[] | undefined =>
    value === undefined || (Array.isArray(value) && value.every(tag => typeof tag === "string"));
  if (!stringTags(oldTags) || !stringTags(newTags)) {
    return isDeepStrictEqual(oldTags, newTags) ? existing : null;
  }
  if (oldTags === undefined && newTags === undefined) return existing;
  return { ...oldRest, tags: [...new Set([...(oldTags ?? []), ...(newTags ?? [])])] };
}

// Only explicit POST creation reuses nodes. Candidate approval still uses createMemory.
export function createOrReuseMemory(db: MemoryDb, input: CreateMemoryInput) {
  assertSafeForStorage(input.content, "memory content");
  const scope = input.scope ?? { kind: "global" };
  const metadata = normalizeMemoryMetadata(input.metadata, scope);
  const key = contentKey(input.content);
  return db.transaction(() => {
    // IS compares missing identity fields as NULL too; visibility filters are too broad here.
    const rows = key ? db.prepare(`SELECT * FROM nodes
      WHERE status = 'active' AND type = ? AND scope_kind = ?
        AND scope_user_id IS ? AND scope_project_id IS ? AND scope_workspace_id IS ?
        AND scope_agent_id IS ? AND scope_conversation_id IS ?
        AND knowledge_scope = ?
      ORDER BY created_at, id`).all(
      input.type, scope.kind, scope.user_id ?? null, scope.project_id ?? null,
      scope.workspace_id ?? null, scope.agent_id ?? null, scope.conversation_id ?? null,
      metadata.knowledge_scope
    ) : [];
    for (const row of rows) {
      const memory = mapNode(row as never);
      if (contentKey(memory.content) !== key) continue;
      const mergedMetadata = mergeMetadata(normalizeMemoryMetadata(memory.metadata, memory.scope), metadata);
      if (!mergedMetadata) continue;
      const confidence = Math.max(memory.confidence, input.confidence ?? 0.8);
      const levels = { normal: 0, sensitive: 1, secret: 2 };
      const incomingPrivacy = input.privacy_level ?? "normal";
      const privacy = levels[incomingPrivacy] > levels[memory.privacy_level] ? incomingPrivacy : memory.privacy_level;
      const changed = confidence !== memory.confidence || privacy !== memory.privacy_level ||
        !isDeepStrictEqual(memory.metadata, mergedMetadata);
      if (changed) {
        db.prepare(`UPDATE nodes SET confidence = ?, privacy_level = ?, metadata_json = ?, updated_at = ?
          WHERE id = ?`).run(confidence, privacy, JSON.stringify(mergedMetadata), nowIso(), memory.id);
      }
      if (input.source) {
        const source = createSource(db, input.source);
        db.prepare(`INSERT INTO node_sources (node_id, source_id, evidence_text, created_at)
          VALUES (?, ?, ?, ?)`).run(
          memory.id, source.id, redactSecrets(input.source.content_excerpt ?? input.content), nowIso()
        );
      }
      const updated = changed ? getMemory(db, memory.id) : memory;
      if (changed) synchronizeProfileForMemory(db, updated, "compatible memory repeated");
      return { memory: updated, deduplicated: true };
    }
    const memory = createMemory(db, input);
    createRelatedLinksForMemory(db, memory);
    applyMemoryToProfile(db, memory);
    return { memory, deduplicated: false };
  // Acquire the write lock before lookup, including across separate service connections.
  }).immediate();
}
