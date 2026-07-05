import type { MemoryDb } from "../db/connection.js";
import { knowledgeScope, type KnowledgeScope } from "./links.js";
import { mapNode } from "./mappers.js";
import { redactedContent, redactSourcesForMemory } from "./privacy.js";
import { listSourcesForNode } from "./sources.js";
import type { MemoryNode, Scope, Source } from "./types.js";

export type RecallInput = {
  query: string;
  scope?: Scope;
  knowledge_scope?: KnowledgeScope;
  types?: string[];
  limit?: number;
  include_sources?: boolean;
};

export type RecallResult = {
  id: string;
  type: string;
  content: string;
  confidence: number;
  score: number;
  sources?: Source[];
};

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}:_-]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length > 2)
  );
}

function tokenOverlap(query: string, content: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) {
    return 0;
  }

  const contentTokens = tokenize(content);
  let matches = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) {
      matches += 1;
    }
  }
  return matches / queryTokens.size;
}

function recencyBoost(memory: MemoryNode): number {
  const ageMs = Date.now() - new Date(memory.updated_at).getTime();
  const ageDays = Math.max(0, ageMs / 86_400_000);
  return Math.max(0, 1 - ageDays / 30);
}

function scopeMatches(memory: MemoryNode, scope?: Scope): boolean {
  if (!scope || scope.kind === "global") {
    return true;
  }

  if (memory.scope.kind === "global") {
    return true;
  }

  if (memory.scope.kind !== scope.kind) {
    return false;
  }

  return (
    (!scope.user_id || memory.scope.user_id === scope.user_id) &&
    (!scope.project_id || memory.scope.project_id === scope.project_id) &&
    (!scope.workspace_id || memory.scope.workspace_id === scope.workspace_id) &&
    (!scope.agent_id || memory.scope.agent_id === scope.agent_id)
  );
}

export function recall(db: MemoryDb, input: RecallInput): RecallResult[] {
  const rows = db.prepare("SELECT * FROM nodes WHERE status = 'active'").all();
  const requestedTypes = new Set(input.types ?? []);
  const memories = rows
    .map((row) => mapNode(row as never))
    .filter((memory) => requestedTypes.size === 0 || requestedTypes.has(memory.type))
    .filter((memory) => !input.knowledge_scope || knowledgeScope(memory) === input.knowledge_scope)
    .filter((memory) => scopeMatches(memory, input.scope));

  return memories
    .map((memory) => {
      const overlap = tokenOverlap(input.query, memory.content);
      const score = overlap * 0.65 + memory.confidence * 0.25 + recencyBoost(memory) * 0.1;
      return {
        overlap,
        id: memory.id,
        type: memory.type,
        content: redactedContent(memory),
        confidence: memory.confidence,
        score: Number(score.toFixed(4)),
        sources: input.include_sources ? redactSourcesForMemory(memory, listSourcesForNode(db, memory.id)) : undefined
      };
    })
    .filter((result) => result.overlap > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? 10)
    .map(({ overlap: _overlap, ...result }) => result);
}
