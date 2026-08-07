import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MemoryDb } from "../src/db/connection.js";
import { buildServer } from "../src/server.js";

describe("hybrid indexed recall", () => {
  let db: MemoryDb;
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    app = await buildServer(db);
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  async function createMemory(type: string, content: string) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type,
        content,
        scope: { kind: "project", project_id: "project:agent-memory" },
        confidence: 0.8
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

  it("uses the FTS5 prefix index when exact token overlap is absent", async () => {
    const id = await createMemory("Fact", "Containerized workers process the durable queue.");

    const response = await recall("container");

    expect(response.statusCode).toBe(200);
    const result = response.json().results.find((item: { id: string }) => item.id === id);
    expect(result).toBeDefined();
    expect(result.retrieval.strategy).toBe("fts5_graph");
    expect(result.retrieval.lexical_score).toBeGreaterThan(0);
  });

  it("expands the graph from an indexed lexical seed", async () => {
    const seedId = await createMemory("Project", "Containerized workers run the Polaris importer.");
    const neighborId = await createMemory("Decision", "Recovery drills remain mandatory every quarter.");
    const link = await app.inject({
      method: "POST",
      url: "/v1/links",
      payload: {
        from_id: seedId,
        to_id: neighborId,
        relation: "RELATED_TO",
        confidence: 1
      }
    });
    expect(link.statusCode).toBe(201);

    const response = await recall("container");
    const results = response.json().results as Array<{
      id: string;
      retrieval: { graph_distance: number | null; graph_score: number };
    }>;

    expect(results.map((item) => item.id)).toEqual(expect.arrayContaining([seedId, neighborId]));
    const neighbor = results.find((item) => item.id === neighborId)!;
    expect(neighbor.retrieval.graph_distance).toBe(1);
    expect(neighbor.retrieval.graph_score).toBeGreaterThan(0);
  });

  it("keeps the index synchronized after edits and excludes archived memories", async () => {
    const id = await createMemory("Fact", "Orchid scheduler owns the nightly export.");
    const update = await app.inject({
      method: "PATCH",
      url: `/v1/memories/${id}`,
      payload: { content: "Juniper scheduler owns the nightly export." }
    });
    expect(update.statusCode).toBe(200);

    expect((await recall("Orchid")).json().results).toHaveLength(0);
    expect((await recall("Juniper")).json().results.map((item: { id: string }) => item.id)).toContain(id);

    const archive = await app.inject({ method: "POST", url: `/v1/memories/${id}/archive`, payload: {} });
    expect(archive.statusCode).toBe(200);
    expect((await recall("Juniper")).json().results).toHaveLength(0);
  });

  it("falls back to token retrieval when FTS5 is unavailable", async () => {
    db.exec(`
      DROP TRIGGER nodes_fts_after_insert;
      DROP TRIGGER nodes_fts_after_update;
      DROP TRIGGER nodes_fts_after_delete;
      DROP TABLE nodes_fts;
    `);
    const id = await createMemory("Fact", "Fallback retrieval keeps local memory usable.");

    const response = await recall("fallback retrieval");
    const result = response.json().results.find((item: { id: string }) => item.id === id);

    expect(result).toBeDefined();
    expect(result.retrieval.strategy).toBe("token_graph");
  });
});
