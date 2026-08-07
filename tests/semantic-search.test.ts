import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MemoryDb } from "../src/db/connection.js";
import type { EmbeddingProvider } from "../src/domain/embeddings.js";
import { buildServer } from "../src/server.js";

class ConceptEmbeddingProvider implements EmbeddingProvider {
  readonly id = "test";
  readonly model = "concept-v1";
  readonly dimensions = 3;
  readonly maxBatchSize = 32;
  readonly embeddedTexts: string[] = [];

  async embed(texts: string[]): Promise<number[][]> {
    this.embeddedTexts.push(...texts);
    return texts.map((text) => {
      const normalized = text.toLowerCase();
      if (/automobile|vehicle|transport/u.test(normalized)) {
        return [1, 0, 0];
      }
      if (/orchard|fruit|banana/u.test(normalized)) {
        return [0, 1, 0];
      }
      return [0, 0, 1];
    });
  }
}

describe("semantic memory recall", () => {
  let db: MemoryDb;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let provider: ConceptEmbeddingProvider;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    provider = new ConceptEmbeddingProvider();
    app = await buildServer(db, { embeddingProvider: provider });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  async function createMemory(
    content: string,
    privacyLevel: "normal" | "sensitive" | "secret" = "normal"
  ) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Fact",
        content,
        privacy_level: privacyLevel,
        scope: { kind: "project", project_id: "project:agent-memory" }
      }
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  }

  async function recall(query: string) {
    return app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: {
        query,
        scope: { kind: "project", project_id: "project:agent-memory" }
      }
    });
  }

  it("finds a memory by meaning without lexical overlap and expands its graph", async () => {
    const seedId = await createMemory("Automobile maintenance happens every quarter.");
    const neighborId = await createMemory("The checklist requires an operator signature.");
    const link = await app.inject({
      method: "POST",
      url: "/v1/links",
      payload: { from_id: seedId, to_id: neighborId, relation: "RELATED_TO", confidence: 1 }
    });
    expect(link.statusCode).toBe(201);

    const response = await recall("vehicle servicing");
    const results = response.json().results as Array<{
      id: string;
      retrieval: {
        strategy: string;
        lexical_score: number;
        semantic_score: number;
        semantic_status: string;
        graph_distance: number | null;
      };
    }>;
    expect(results.map((result) => result.id)).toEqual(expect.arrayContaining([seedId, neighborId]));
    const seed = results.find((result) => result.id === seedId)!;
    expect(seed.retrieval.strategy).toBe("semantic_fts5_graph");
    expect(seed.retrieval.lexical_score).toBe(0);
    expect(seed.retrieval.semantic_score).toBeGreaterThan(0.9);
    expect(seed.retrieval.semantic_status).toBe("used");
    expect(results.find((result) => result.id === neighborId)!.retrieval.graph_distance).toBe(1);
  });

  it("never sends sensitive or secret memories to an external embedding provider", async () => {
    await createMemory("Automobile location is restricted to the cellar.", "secret");
    await createMemory("Vehicle access details are private.", "sensitive");
    await createMemory("Routine orchard notes are public.");

    await recall("vehicle servicing");

    expect(provider.embeddedTexts.some((text) => text.includes("restricted to the cellar"))).toBe(false);
    expect(provider.embeddedTexts.some((text) => text.includes("access details are private"))).toBe(false);
  });

  it("degrades to indexed lexical retrieval when the provider fails", async () => {
    await app.close();
    const failingProvider: EmbeddingProvider = {
      id: "failing",
      model: "failure-v1",
      dimensions: 3,
      maxBatchSize: 32,
      async embed() {
        throw new Error("provider unavailable");
      }
    };
    app = await buildServer(db, { embeddingProvider: failingProvider });
    const id = await createMemory("Fallback retrieval remains available.");

    const response = await recall("fallback retrieval");
    const result = response.json().results.find((item: { id: string }) => item.id === id);
    expect(result).toBeDefined();
    expect(result.retrieval.strategy).toBe("fts5_graph");
    expect(result.retrieval.semantic_status).toBe("degraded");
  });

  it("removes the stored vector when a memory is forgotten", async () => {
    const id = await createMemory("Automobile maintenance note for deletion.");
    await recall("vehicle servicing");
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM memory_embeddings WHERE memory_id = ?").get(id) as { count: number })
        .count
    ).toBe(1);

    const removed = await app.inject({ method: "DELETE", url: `/v1/memories/${id}`, payload: {} });
    expect(removed.statusCode).toBe(200);
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM memory_embeddings WHERE memory_id = ?").get(id) as { count: number })
        .count
    ).toBe(0);
  });

  it("invalidates the stored vector when a memory changes or is archived", async () => {
    const id = await createMemory("Automobile maintenance note before correction.");
    await recall("vehicle servicing");

    const corrected = await app.inject({
      method: "PATCH",
      url: `/v1/memories/${id}`,
      payload: { content: "Updated transport maintenance note." }
    });
    expect(corrected.statusCode).toBe(200);
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM memory_embeddings WHERE memory_id = ?").get(id) as { count: number })
        .count
    ).toBe(0);

    await recall("vehicle servicing");
    const archived = await app.inject({ method: "POST", url: `/v1/memories/${id}/archive`, payload: {} });
    expect(archived.statusCode).toBe(200);
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM memory_embeddings WHERE memory_id = ?").get(id) as { count: number })
        .count
    ).toBe(0);
  });
});
