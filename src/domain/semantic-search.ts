import { createHash } from "node:crypto";
import type { MemoryDb } from "../db/connection.js";
import { nowIso } from "../shared/time.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { mapNode } from "./mappers.js";
import { redactSecrets } from "./privacy.js";
import { memoryVisibilitySqlParts } from "./scope.js";
import type { KnowledgeScope, MemoryNode, Scope } from "./types.js";

export type SemanticSearchHit = {
  id: string;
  score: number;
};

export type SemanticSearchResult = {
  hits: SemanticSearchHit[];
  indexed: number;
};

const synchronizationTasks = new WeakMap<MemoryDb, Map<string, Promise<number>>>();

function embeddingText(memory: MemoryNode): string {
  return `${memory.type}\n${memory.content}`;
}

function contentHash(memory: MemoryNode): string {
  return createHash("sha256").update(embeddingText(memory), "utf8").digest("hex");
}

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new Error("Embedding provider returned a zero or invalid vector");
  }
  return vector.map((value) => value / magnitude);
}

function vectorToBlob(vector: number[]): Buffer {
  const buffer = Buffer.allocUnsafe(vector.length * Float32Array.BYTES_PER_ELEMENT);
  vector.forEach((value, index) => buffer.writeFloatLE(value, index * Float32Array.BYTES_PER_ELEMENT));
  return buffer;
}

function blobToVector(blob: Buffer, dimensions: number): number[] {
  if (blob.length !== dimensions * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error("Stored embedding dimensions do not match its vector payload");
  }
  return Array.from({ length: dimensions }, (_, index) =>
    blob.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT)
  );
}

function dotProduct(left: number[], right: number[]): number {
  if (left.length !== right.length) {
    return Number.NEGATIVE_INFINITY;
  }
  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    score += left[index] * right[index];
  }
  return score;
}

async function synchronizeVisibleEmbeddingsInternal(
  db: MemoryDb,
  provider: EmbeddingProvider,
  input: { scope?: Scope; knowledge_scope?: KnowledgeScope; maxScan: number }
): Promise<number> {
  if (!Number.isInteger(provider.maxBatchSize) || provider.maxBatchSize <= 0) {
    throw new Error("Embedding provider maxBatchSize must be a positive integer");
  }
  const visibility = memoryVisibilitySqlParts(input.scope, input.knowledge_scope, "n.");
  const rows = db
    .prepare(
      `SELECT n.*, embedding.content_hash AS embedding_hash, embedding.dimensions AS embedding_dimensions
       FROM nodes n
       LEFT JOIN memory_embeddings embedding
         ON embedding.memory_id = n.id AND embedding.provider = ? AND embedding.model = ?
       WHERE n.status = 'active'
         AND n.privacy_level = 'normal'
         AND ${visibility.clause}
       ORDER BY n.updated_at DESC
       LIMIT ?`
    )
    .all(provider.id, provider.model, ...visibility.params, input.maxScan + 1) as Array<
    Record<string, unknown> & { embedding_hash: string | null; embedding_dimensions: number | null }
  >;
  if (rows.length > input.maxScan) {
    throw new Error(`Semantic scan limit of ${input.maxScan} visible memories was exceeded`);
  }

  const stale = rows
    .map((row) => ({
      memory: mapNode(row as never),
      embeddingHash: row.embedding_hash,
      embeddingDimensions: row.embedding_dimensions
    }))
    .filter(
      ({ memory, embeddingHash, embeddingDimensions }) =>
        embeddingHash !== contentHash(memory) ||
        Boolean(provider.dimensions && embeddingDimensions !== provider.dimensions)
    );

  for (let offset = 0; offset < stale.length; offset += provider.maxBatchSize) {
    const batch = stale.slice(offset, offset + provider.maxBatchSize);
    const vectors = await provider.embed(batch.map(({ memory }) => embeddingText(memory)));
    if (vectors.length !== batch.length) {
      throw new Error("Embedding provider returned an unexpected batch size");
    }
    const normalized = vectors.map(normalizeVector);
    const dimensions = normalized[0]?.length ?? 0;
    if (dimensions === 0 || normalized.some((vector) => vector.length !== dimensions)) {
      throw new Error("Embedding provider returned inconsistent dimensions");
    }
    if (provider.dimensions && dimensions !== provider.dimensions) {
      throw new Error(
        `Embedding provider returned ${dimensions} dimensions; configured ${provider.dimensions}`
      );
    }

    db.transaction(() => {
      const upsert = db.prepare(
        `INSERT INTO memory_embeddings
           (memory_id, provider, model, dimensions, content_hash, vector_blob, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(memory_id, provider, model) DO UPDATE SET
           dimensions = excluded.dimensions,
           content_hash = excluded.content_hash,
           vector_blob = excluded.vector_blob,
           updated_at = excluded.updated_at`
      );
      batch.forEach(({ memory }, index) => {
        upsert.run(
          memory.id,
          provider.id,
          provider.model,
          dimensions,
          contentHash(memory),
          vectorToBlob(normalized[index]),
          nowIso()
        );
      });
    })();
  }
  return stale.length;
}

async function synchronizeVisibleEmbeddings(
  db: MemoryDb,
  provider: EmbeddingProvider,
  input: { scope?: Scope; knowledge_scope?: KnowledgeScope; maxScan: number }
): Promise<number> {
  const tasks = synchronizationTasks.get(db) ?? new Map<string, Promise<number>>();
  synchronizationTasks.set(db, tasks);
  const key = `${provider.id}\u0000${provider.model}\u0000${input.knowledge_scope ?? "visible"}\u0000${JSON.stringify(input.scope ?? {})}`;
  const running = tasks.get(key);
  if (running) {
    return running;
  }
  const task = synchronizeVisibleEmbeddingsInternal(db, provider, input).finally(() => tasks.delete(key));
  tasks.set(key, task);
  return task;
}

export async function semanticNodeSearch(
  db: MemoryDb,
  provider: EmbeddingProvider,
  input: {
    query: string;
    scope?: Scope;
    knowledge_scope?: KnowledgeScope;
    limit: number;
    maxScan?: number;
    minScore?: number;
  }
): Promise<SemanticSearchResult> {
  const maxScan = Math.min(50_000, Math.max(1, input.maxScan ?? 5_000));
  const indexed = await synchronizeVisibleEmbeddings(db, provider, {
    scope: input.scope,
    knowledge_scope: input.knowledge_scope,
    maxScan
  });
  const queryVectors = await provider.embed([redactSecrets(input.query)]);
  const queryVector = normalizeVector(queryVectors[0] ?? []);
  if (provider.dimensions && queryVector.length !== provider.dimensions) {
    throw new Error(
      `Embedding provider returned ${queryVector.length} query dimensions; configured ${provider.dimensions}`
    );
  }

  const visibility = memoryVisibilitySqlParts(input.scope, input.knowledge_scope, "n.");
  const rows = db
    .prepare(
      `SELECT embedding.memory_id, embedding.dimensions, embedding.vector_blob
       FROM memory_embeddings embedding
       JOIN nodes n ON n.id = embedding.memory_id
       WHERE embedding.provider = ?
         AND embedding.model = ?
         AND n.status = 'active'
         AND n.privacy_level = 'normal'
         AND ${visibility.clause}
       LIMIT ?`
    )
    .all(provider.id, provider.model, ...visibility.params, maxScan) as Array<{
    memory_id: string;
    dimensions: number;
    vector_blob: Buffer;
  }>;

  const minScore = Math.max(-1, Math.min(1, input.minScore ?? 0.35));
  return {
    indexed,
    hits: rows
      .map((row) => ({
        id: row.memory_id,
        score: dotProduct(queryVector, blobToVector(row.vector_blob, row.dimensions))
      }))
      .filter((hit) => Number.isFinite(hit.score) && hit.score >= minScore)
      .sort((left, right) => right.score - left.score)
      .slice(0, input.limit)
      .map((hit) => ({ ...hit, score: Number(hit.score.toFixed(4)) }))
  };
}
