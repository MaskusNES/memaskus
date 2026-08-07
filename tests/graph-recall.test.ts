import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MemoryDb } from "../src/db/connection.js";
import { buildServer } from "../src/server.js";

describe("graph-aware recall", () => {
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

  async function createMemory(type: string, content: string, projectId = "project:agent-memory") {
    const response = await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type,
        content,
        scope: { kind: "project", project_id: projectId },
        confidence: 0.8
      }
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  }

  async function createLink(fromId: string, toId: string) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/links",
      payload: {
        from_id: fromId,
        to_id: toId,
        relation: "RELATED_TO",
        confidence: 1
      }
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  }

  it("returns connected memories up to two hops and attenuates their scores", async () => {
    const seedId = await createMemory("Project", "Orchid migration uses PostgreSQL.");
    const oneHopId = await createMemory("Decision", "Nightly snapshots are mandatory.");
    const twoHopId = await createMemory("Fact", "Recovery drills happen quarterly.");
    const unrelatedId = await createMemory("Fact", "Blue invoices require manual approval.");
    await createLink(seedId, oneHopId);
    await createLink(oneHopId, twoHopId);

    const response = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: {
        query: "Orchid PostgreSQL",
        scope: { kind: "project", project_id: "project:agent-memory" }
      }
    });

    expect(response.statusCode).toBe(200);
    const results = response.json().results as Array<{ id: string; score: number }>;
    const ids = results.map((result) => result.id);
    expect(ids).toEqual(expect.arrayContaining([seedId, oneHopId, twoHopId]));
    expect(ids).not.toContain(unrelatedId);
    expect(results.find((result) => result.id === oneHopId)!.score).toBeGreaterThan(
      results.find((result) => result.id === twoHopId)!.score
    );
  });

  it("can use a lexical seed of another type while filtering returned types", async () => {
    const seedId = await createMemory("Project", "Juniper rollout targets the billing service.");
    const decisionId = await createMemory("Decision", "Run the change after the weekly backup.");
    await createLink(seedId, decisionId);

    const response = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: {
        query: "Juniper billing",
        scope: { kind: "project", project_id: "project:agent-memory" },
        types: ["Decision"]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results.map((result: { id: string }) => result.id)).toEqual([decisionId]);
  });

  it("does not traverse links to memories outside the requested scope", async () => {
    const visibleId = await createMemory("Project", "Cedar migration uses SQLite.", "project:visible");
    const hiddenId = await createMemory("Decision", "Keep three encrypted replicas.", "project:hidden");
    await createLink(visibleId, hiddenId);

    const response = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: {
        query: "Cedar SQLite",
        scope: { kind: "project", project_id: "project:visible" }
      }
    });

    expect(response.statusCode).toBe(200);
    const ids = response.json().results.map((result: { id: string }) => result.id);
    expect(ids).toContain(visibleId);
    expect(ids).not.toContain(hiddenId);
  });

  it("ignores inactive edges", async () => {
    const seedId = await createMemory("Project", "Maple deployment uses containers.");
    const neighborId = await createMemory("Decision", "Rollback requires an operator review.");
    const edgeId = await createLink(seedId, neighborId);
    db.prepare("UPDATE edges SET status = 'deleted' WHERE id = ?").run(edgeId);

    const response = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: {
        query: "Maple containers",
        scope: { kind: "project", project_id: "project:agent-memory" }
      }
    });

    const ids = response.json().results.map((result: { id: string }) => result.id);
    expect(ids).toContain(seedId);
    expect(ids).not.toContain(neighborId);
  });
});
