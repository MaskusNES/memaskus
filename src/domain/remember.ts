import { isDeepStrictEqual } from "node:util";
import type { MemoryDb } from "../db/connection.js";
import { nowIso } from "../shared/time.js";
import { createRelatedLinksForMemory } from "./links.js";
import { mapNode } from "./mappers.js";
import { createMemory, memoryInputMetadata, normalizeMemoryMetadata, type CreateMemoryInput } from "./nodes.js";
import { assertSafeForStorage, redactSecrets } from "./privacy.js";
import { applyMemoryToProfile } from "./profile.js";
import { createSource } from "./sources.js";

function contentKey(content: string): string {
  return content.toLowerCase().trim().replace(/\s+/gu, " ").replace(/\.$/u, "").trim();
}

// Only explicit POST creation reuses nodes. Candidate approval still uses createMemory.
export function createOrReuseMemory(db: MemoryDb, input: CreateMemoryInput) {
  assertSafeForStorage(input.content, "memory content");
  const scope = input.scope ?? { kind: "global" };
  const metadata = memoryInputMetadata(input, scope);
  const key = contentKey(input.content);
  return db.transaction(() => {
    // IS compares missing identity fields as NULL too; visibility filters are too broad here.
    const rows = key ? db.prepare(`SELECT * FROM nodes
      WHERE status = 'active' AND type = ? AND scope_kind = ?
        AND scope_user_id IS ? AND scope_project_id IS ? AND scope_workspace_id IS ?
        AND scope_agent_id IS ? AND scope_conversation_id IS ?
        AND knowledge_scope = ? AND confidence = ? AND privacy_level = ?
      ORDER BY created_at, id`).all(
      input.type, scope.kind, scope.user_id ?? null, scope.project_id ?? null,
      scope.workspace_id ?? null, scope.agent_id ?? null, scope.conversation_id ?? null,
      metadata.knowledge_scope, input.confidence ?? 0.8, input.privacy_level ?? "normal"
    ) : [];
    for (const row of rows) {
      const memory = mapNode(row as never);
      if (contentKey(memory.content) !== key ||
          !isDeepStrictEqual(normalizeMemoryMetadata(memory.metadata, memory.scope), metadata)) continue;
      if (input.source) {
        const source = createSource(db, input.source);
        db.prepare(`INSERT INTO node_sources (node_id, source_id, evidence_text, created_at)
          VALUES (?, ?, ?, ?)`).run(
          memory.id, source.id, redactSecrets(input.source.content_excerpt ?? input.content), nowIso()
        );
      }
      return { memory, deduplicated: true };
    }
    const memory = createMemory(db, input);
    createRelatedLinksForMemory(db, memory);
    applyMemoryToProfile(db, memory);
    return { memory, deduplicated: false };
  // Acquire the write lock before lookup, including across separate service connections.
  }).immediate();
}
