import type { MemoryDb } from "../db/connection.js";
import { knowledgeScope, type KnowledgeScope } from "./links.js";
import { mapEdge, mapNode } from "./mappers.js";
import { redactedContent, redactSourcesForMemory } from "./privacy.js";
import { scopeSqlParts, scopeVisibleFrom } from "./scope.js";
import { listSourcesForNode } from "./sources.js";
import type { Edge, MemoryNode, Scope, Source } from "./types.js";

const GRAPH_MAX_DEPTH = 2;
const GRAPH_HOP_DECAY = 0.7;
const GRAPH_SCORE_WEIGHT = 0.25;

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

type GraphSignal = {
  distance: number;
  strength: number;
};

type GraphNeighbor = {
  id: string;
  confidence: number;
};

function graphAdjacency(db: MemoryDb, memories: MemoryNode[]): Map<string, GraphNeighbor[]> {
  const memoriesById = new Map(memories.map((memory) => [memory.id, memory]));
  const adjacency = new Map<string, GraphNeighbor[]>();
  const edges = db
    .prepare("SELECT * FROM edges WHERE status = 'active'")
    .all()
    .map((row) => mapEdge(row as never));

  const connect = (fromId: string, toId: string, edge: Edge) => {
    const neighbors = adjacency.get(fromId) ?? [];
    neighbors.push({
      id: toId,
      confidence: Math.max(0, Math.min(1, edge.confidence))
    });
    adjacency.set(fromId, neighbors);
  };

  for (const edge of edges) {
    const from = memoriesById.get(edge.from_id);
    const to = memoriesById.get(edge.to_id);
    if (!from || !to || knowledgeScope(from) !== knowledgeScope(to)) {
      continue;
    }

    // Retrieval treats relations as semantic connectivity. Direction remains
    // available through memory_explain, but either endpoint can lead to the other.
    connect(edge.from_id, edge.to_id, edge);
    connect(edge.to_id, edge.from_id, edge);
  }

  return adjacency;
}

function graphSignals(
  db: MemoryDb,
  memories: MemoryNode[],
  overlaps: Map<string, number>
): Map<string, GraphSignal> {
  const adjacency = graphAdjacency(db, memories);
  const signals = new Map<string, GraphSignal>();

  for (const [seedId, overlap] of overlaps) {
    if (overlap <= 0) {
      continue;
    }

    const bestForSeed = new Map<string, number>([[seedId, overlap]]);
    let frontier = new Map<string, number>([[seedId, overlap]]);

    for (let distance = 1; distance <= GRAPH_MAX_DEPTH && frontier.size > 0; distance += 1) {
      const nextFrontier = new Map<string, number>();

      for (const [nodeId, strength] of frontier) {
        for (const neighbor of adjacency.get(nodeId) ?? []) {
          if (neighbor.id === seedId) {
            continue;
          }

          const nextStrength = strength * neighbor.confidence * GRAPH_HOP_DECAY;
          if (nextStrength <= (bestForSeed.get(neighbor.id) ?? 0)) {
            continue;
          }

          bestForSeed.set(neighbor.id, nextStrength);
          nextFrontier.set(neighbor.id, Math.max(nextFrontier.get(neighbor.id) ?? 0, nextStrength));

          const current = signals.get(neighbor.id);
          if (!current || nextStrength > current.strength) {
            signals.set(neighbor.id, { distance, strength: nextStrength });
          }
        }
      }

      frontier = nextFrontier;
    }
  }

  return signals;
}

export function recall(db: MemoryDb, input: RecallInput): RecallResult[] {
  const scopeFilter = scopeSqlParts(input.scope);
  const rows = db
    .prepare(`SELECT * FROM nodes WHERE status = 'active' AND ${scopeFilter.clause}`)
    .all(...scopeFilter.params);
  const memories = rows
    .map((row) => mapNode(row as never))
    .filter((memory) => !input.knowledge_scope || knowledgeScope(memory) === input.knowledge_scope)
    .filter((memory) => scopeVisibleFrom(memory.scope, input.scope));

  const requestedTypes = new Set(input.types ?? []);
  const overlaps = new Map(memories.map((memory) => [memory.id, tokenOverlap(input.query, memory.content)]));
  const graphMatches = graphSignals(db, memories, overlaps);

  return memories
    .filter((memory) => requestedTypes.size === 0 || requestedTypes.has(memory.type))
    .map((memory) => {
      const overlap = overlaps.get(memory.id) ?? 0;
      const graphMatch = graphMatches.get(memory.id);
      const score = Math.min(
        1,
        overlap * 0.65 +
          memory.confidence * 0.25 +
          recencyBoost(memory) * 0.1 +
          (graphMatch?.strength ?? 0) * GRAPH_SCORE_WEIGHT
      );
      return {
        overlap,
        graphMatch,
        id: memory.id,
        type: memory.type,
        content: redactedContent(memory),
        confidence: memory.confidence,
        score: Number(score.toFixed(4)),
        sources: input.include_sources ? redactSourcesForMemory(memory, listSourcesForNode(db, memory.id)) : undefined
      };
    })
    .filter((result) => result.overlap > 0 || result.graphMatch)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? 10)
    .map(({ overlap: _overlap, graphMatch: _graphMatch, ...result }) => result);
}
