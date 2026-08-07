import type { MemoryDb } from "../db/connection.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { knowledgeScope } from "./links.js";
import { mapEdge, mapNode } from "./mappers.js";
import { redactedContent, redactSourcesForMemory } from "./privacy.js";
import { memoryVisibilitySqlParts, scopeVisibleFrom } from "./scope.js";
import { indexedNodeSearch, tokenOverlap } from "./search.js";
import { semanticNodeSearch } from "./semantic-search.js";
import { listSourcesForNode } from "./sources.js";
import type { Edge, KnowledgeScope, MemoryNode, Scope, Source } from "./types.js";

const GRAPH_MAX_DEPTH = 2;
const GRAPH_HOP_DECAY = 0.7;
const MAX_INDEXED_SEEDS = 250;
const TRAVERSABLE_RELATIONS = ["RELATED_TO", "SUPPORTS", "DEPENDS_ON", "ABOUT"] as const;

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
  retrieval: {
    strategy: "semantic_fts5_graph" | "semantic_token_graph" | "fts5_graph" | "token_graph";
    lexical_score: number;
    semantic_score: number;
    semantic_status: "disabled" | "used" | "degraded";
    graph_score: number;
    graph_distance: number | null;
    feedback_score: number;
  };
  sources?: Source[];
};

export type RecallOptions = {
  embeddingProvider?: EmbeddingProvider;
  semanticMaxScan?: number;
  semanticMinScore?: number;
  onSemanticError?: (error: unknown) => void;
};

function recencyBoost(memory: MemoryNode): number {
  const ageMs = Date.now() - new Date(memory.updated_at).getTime();
  const ageDays = Math.max(0, ageMs / 86_400_000);
  return Math.max(0, 1 - ageDays / 30);
}

type GraphSignal = {
  distance: number;
  strength: number;
};

function feedbackSignals(db: MemoryDb): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT memory_id,
              SUM(CASE rating
                    WHEN 'correct' THEN 1.0
                    WHEN 'wrong' THEN -2.0
                    WHEN 'outdated' THEN -2.0
                    WHEN 'too_broad' THEN -0.5
                    WHEN 'too_narrow' THEN -0.5
                    ELSE 0
                  END) AS signal
       FROM memory_feedback
       GROUP BY memory_id`
    )
    .all() as Array<{ memory_id: string; signal: number }>;
  return new Map(rows.map((row) => [row.memory_id, Math.max(-1, Math.min(1, row.signal / 2))]));
}

function isVisible(memory: MemoryNode, input: RecallInput): boolean {
  return (
    (!input.knowledge_scope || knowledgeScope(memory) === input.knowledge_scope) &&
    (input.knowledge_scope === "global" || scopeVisibleFrom(memory.scope, input.scope))
  );
}

function loadVisibleMemories(db: MemoryDb, input: RecallInput): MemoryNode[] {
  const visibility = memoryVisibilitySqlParts(input.scope, input.knowledge_scope);
  return db
    .prepare(`SELECT * FROM nodes WHERE status = 'active' AND ${visibility.clause}`)
    .all(...visibility.params)
    .map((row) => mapNode(row as never))
    .filter((memory) => isVisible(memory, input));
}

function loadVisibleMemoriesById(db: MemoryDb, ids: Iterable<string>, input: RecallInput): MemoryNode[] {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) {
    return [];
  }
  const visibility = memoryVisibilitySqlParts(input.scope, input.knowledge_scope);
  const placeholders = uniqueIds.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT * FROM nodes
       WHERE status = 'active'
         AND ${visibility.clause}
         AND id IN (${placeholders})`
    )
    .all(...visibility.params, ...uniqueIds)
    .map((row) => mapNode(row as never))
    .filter((memory) => isVisible(memory, input));
}

function frontierEdges(db: MemoryDb, ids: string[]): Edge[] {
  if (ids.length === 0) {
    return [];
  }
  const relationPlaceholders = TRAVERSABLE_RELATIONS.map(() => "?").join(", ");
  const idPlaceholders = ids.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT * FROM edges
       WHERE status = 'active'
         AND UPPER(relation) IN (${relationPlaceholders})
         AND (from_id IN (${idPlaceholders}) OR to_id IN (${idPlaceholders}))`
    )
    .all(...TRAVERSABLE_RELATIONS, ...ids, ...ids)
    .map((row) => mapEdge(row as never));
}

function expandGraph(
  db: MemoryDb,
  input: RecallInput,
  seeds: MemoryNode[],
  seedStrengths: Map<string, number>
): { memories: Map<string, MemoryNode>; signals: Map<string, GraphSignal> } {
  const memories = new Map(seeds.map((memory) => [memory.id, memory]));
  const bestStrength = new Map(seedStrengths);
  const signals = new Map<string, GraphSignal>();
  let frontier = new Map(seedStrengths);

  for (let distance = 1; distance <= GRAPH_MAX_DEPTH && frontier.size > 0; distance += 1) {
    const edges = frontierEdges(db, [...frontier.keys()]);
    const neighborIds = new Set<string>();
    for (const edge of edges) {
      neighborIds.add(edge.from_id);
      neighborIds.add(edge.to_id);
    }
    for (const memory of loadVisibleMemoriesById(db, neighborIds, input)) {
      memories.set(memory.id, memory);
    }

    const nextFrontier = new Map<string, number>();
    const consider = (fromId: string, toId: string, edge: Edge) => {
      const strength = frontier.get(fromId);
      const from = memories.get(fromId);
      const to = memories.get(toId);
      if (strength === undefined || !from || !to || knowledgeScope(from) !== knowledgeScope(to)) {
        return;
      }

      const nextStrength = strength * Math.max(0, Math.min(1, edge.confidence)) * GRAPH_HOP_DECAY;
      if (nextStrength <= (bestStrength.get(toId) ?? 0)) {
        return;
      }
      bestStrength.set(toId, nextStrength);
      nextFrontier.set(toId, Math.max(nextFrontier.get(toId) ?? 0, nextStrength));
      const current = signals.get(toId);
      if (!current || nextStrength > current.strength) {
        signals.set(toId, { distance, strength: nextStrength });
      }
    };

    for (const edge of edges) {
      consider(edge.from_id, edge.to_id, edge);
      consider(edge.to_id, edge.from_id, edge);
    }
    frontier = nextFrontier;
  }

  return { memories, signals };
}

function lexicalSeeds(
  db: MemoryDb,
  input: RecallInput
): {
  strategy: "fts5_graph" | "token_graph";
  memories: MemoryNode[];
  strengths: Map<string, number>;
} {
  const requestedLimit = Math.min(100, Math.max(1, input.limit ?? 10));
  const indexed = indexedNodeSearch(db, {
    query: input.query,
    scope: input.scope,
    knowledge_scope: input.knowledge_scope,
    limit: Math.min(MAX_INDEXED_SEEDS, Math.max(50, requestedLimit * 10))
  });

  if (indexed.available) {
    const indexedScores = new Map(indexed.hits.map((hit) => [hit.id, hit.score]));
    const memories = loadVisibleMemoriesById(db, indexedScores.keys(), input);
    const strengths = new Map(
      memories.map((memory) => {
        const overlap = tokenOverlap(input.query, `${memory.type} ${memory.content}`);
        const indexedScore = indexedScores.get(memory.id) ?? 0;
        return [memory.id, Math.min(1, indexedScore * 0.75 + overlap * 0.25)] as const;
      })
    );
    return { strategy: "fts5_graph", memories, strengths };
  }

  const visible = loadVisibleMemories(db, input);
  const strengths = new Map<string, number>();
  for (const memory of visible) {
    const overlap = tokenOverlap(input.query, `${memory.type} ${memory.content}`);
    if (overlap > 0) {
      strengths.set(memory.id, overlap);
    }
  }
  return {
    strategy: "token_graph",
    memories: visible.filter((memory) => strengths.has(memory.id)),
    strengths
  };
}

export async function recall(
  db: MemoryDb,
  input: RecallInput,
  options: RecallOptions = {}
): Promise<RecallResult[]> {
  const lexical = lexicalSeeds(db, input);
  const semanticScores = new Map<string, number>();
  let semanticStatus: RecallResult["retrieval"]["semantic_status"] = "disabled";
  if (options.embeddingProvider) {
    try {
      const semantic = await semanticNodeSearch(db, options.embeddingProvider, {
        query: input.query,
        scope: input.scope,
        knowledge_scope: input.knowledge_scope,
        limit: MAX_INDEXED_SEEDS,
        maxScan: options.semanticMaxScan,
        minScore: options.semanticMinScore
      });
      semantic.hits.forEach((hit) => semanticScores.set(hit.id, hit.score));
      semanticStatus = "used";
    } catch (error) {
      semanticStatus = "degraded";
      options.onSemanticError?.(error);
    }
  }

  const seedIds = new Set([...lexical.strengths.keys(), ...semanticScores.keys()]);
  if (seedIds.size === 0) {
    return [];
  }

  const seedMemories = loadVisibleMemoriesById(db, seedIds, input);
  const graphSeedStrengths = new Map(
    seedMemories.map((memory) => [
      memory.id,
      Math.max(lexical.strengths.get(memory.id) ?? 0, semanticScores.get(memory.id) ?? 0)
    ])
  );

  const expanded = expandGraph(db, input, seedMemories, graphSeedStrengths);
  const requestedTypes = new Set(input.types ?? []);
  const feedback = feedbackSignals(db);
  const strategy: RecallResult["retrieval"]["strategy"] =
    semanticStatus === "used"
      ? lexical.strategy === "fts5_graph"
        ? "semantic_fts5_graph"
        : "semantic_token_graph"
      : lexical.strategy;

  return [...expanded.memories.values()]
    .filter((memory) => requestedTypes.size === 0 || requestedTypes.has(memory.type))
    .map((memory) => {
      const lexicalScore = lexical.strengths.get(memory.id) ?? 0;
      const semanticScore = semanticScores.get(memory.id) ?? 0;
      const graphMatch = expanded.signals.get(memory.id);
      const feedbackScore = feedback.get(memory.id) ?? 0;
      const score =
        semanticStatus === "used"
          ? Math.min(
              1,
              lexicalScore * 0.31 +
                semanticScore * 0.31 +
                memory.confidence * 0.13 +
                recencyBoost(memory) * 0.04 +
                (graphMatch?.strength ?? 0) * 0.16 +
                feedbackScore * 0.05
            )
          : Math.min(
              1,
              lexicalScore * 0.57 +
                memory.confidence * 0.14 +
                recencyBoost(memory) * 0.04 +
                (graphMatch?.strength ?? 0) * 0.2 +
                feedbackScore * 0.05
            );
      return {
        id: memory.id,
        type: memory.type,
        content: redactedContent(memory),
        confidence: memory.confidence,
        score: Number(score.toFixed(4)),
        retrieval: {
          strategy,
          lexical_score: Number(lexicalScore.toFixed(4)),
          semantic_score: Number(semanticScore.toFixed(4)),
          semantic_status: semanticStatus,
          graph_score: Number((graphMatch?.strength ?? 0).toFixed(4)),
          graph_distance: graphMatch?.distance ?? null,
          feedback_score: Number(feedbackScore.toFixed(4))
        },
        memory
      };
    })
    .filter(
      (result) =>
        result.retrieval.lexical_score > 0 ||
        result.retrieval.semantic_score > 0 ||
        result.retrieval.graph_score > 0
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? 10)
    .map(({ memory, ...result }) => ({
      ...result,
      sources: input.include_sources
        ? redactSourcesForMemory(memory, listSourcesForNode(db, memory.id))
        : undefined
    }));
}
