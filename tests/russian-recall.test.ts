import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type MemoryDb } from "../src/db/connection.js";
import { buildServer } from "../src/server.js";
import type { Scope } from "../src/domain/types.js";
import { tokenOverlap } from "../src/domain/search.js";

const scope: Scope = { kind: "project", project_id: "project:qa" };

describe.each([true, false])("Russian recall (FTS=%s)", (fts) => {
  let db: MemoryDb;
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    if (!fts) db.exec(`
      DROP TRIGGER nodes_fts_after_insert;
      DROP TRIGGER nodes_fts_after_update;
      DROP TRIGGER nodes_fts_after_delete;
      DROP TABLE nodes_fts;
    `);
    app = await buildServer(db);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
    db.close();
  });

  async function create(content: string, physicalScope: Scope = scope, layer = "project_local") {
    const response = await app.inject({ method: "POST", url: "/v1/memories", payload: {
      type: "Fact", content, scope: physicalScope, confidence: 0.8,
      metadata: { knowledge_scope: layer }
    } });
    expect(response.statusCode).toBe(201);
    // The HTTP API can auto-link records. Remove those links so recall must
    // independently seed every record in these lexical-search fixtures.
    db.exec("DELETE FROM edges");
    return response.json().id as string;
  }

  async function query(query: string, layer: string | undefined = "project_local") {
    const response = await app.inject({ method: "POST", url: "/v1/recall", payload: {
      query, scope, knowledge_scope: layer, limit: 100
    } });
    expect(response.statusCode).toBe(200);
    const results = response.json().results as Array<{
      id: string; score: number; confidence: number;
      retrieval: { strategy: string; graph_score: number; feedback_score: number; lexical_score: number };
    }>;
    for (const result of results) expect(result.retrieval.strategy).toBe(fts ? "fts5_graph" : "token_graph");
    return results;
  }

  it("seeds the isolated phrase from singular queries", async () => {
    const id = await create("Задачи и решения по проекту");
    for (const text of ["задача", "решение", "задача решение"]) {
      expect((await query(text)).map(item => item.id)).toEqual([id]);
    }
  });

  it.each([
    ["задача", "задачи", "задачу", "задачами"],
    ["решение", "решения", "решению", "решениями"]
  ])("retrieves every isolated form for %s and its variants", async (...forms) => {
    const ids = [];
    for (const form of forms) ids.push(await create(form));
    for (const form of forms) {
      expect((await query(form)).map(item => item.id).sort()).toEqual([...ids].sort());
    }
  });

  it("matches е/ё both ways in the original, unmodified index", async () => {
    const ids = [await create("ёлка"), await create("елка")];
    // These rows are indexed with their original spelling; no rewrite or rebuild.
    const before = db.prepare("SELECT content FROM nodes ORDER BY content").all();
    for (const text of ["ёлка", "елка", "ЁЛКА"]) {
      expect((await query(text)).map(item => item.id).sort()).toEqual([...ids].sort());
    }
    expect(db.prepare("SELECT content FROM nodes ORDER BY content").all()).toEqual(before);
  });

  it("keeps exact matches above stem matches with equal nonlexical signals", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const stem = await create("задачи");
    const exact = await create("задача");
    expect(db.prepare("SELECT DISTINCT updated_at, confidence FROM nodes").all()).toHaveLength(1);
    expect(db.prepare("SELECT * FROM edges").all()).toHaveLength(0);
    expect(db.prepare("SELECT * FROM memory_feedback").all()).toHaveLength(0);
    const results = await query("задача");
    expect(results.map(item => item.id)).toEqual([exact, stem]);
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    for (const result of results) {
      expect(result.confidence).toBe(0.8);
      expect(result.retrieval.graph_score).toBe(0);
      expect(result.retrieval.feedback_score).toBe(0);
    }
  });

  it("does not broaden short words to unrelated stems", async () => {
    await create("код");
    await create("доза");
    for (const text of ["кот", "дом", "да", "а", "!!!"]) expect(await query(text)).toEqual([]);
  });

  it("preserves layer, project and lifecycle visibility", async () => {
    const active = await create("задачи");
    await create("задачу", { kind: "project", project_id: "project:other" });
    const global = await create("задачами", scope, "global");
    const physicalGlobal = await create("задачами", { kind: "global" }, "global");
    const archived = await create("задача");
    expect((await app.inject({ method: "POST", url: `/v1/memories/${archived}/archive`, payload: {} })).statusCode).toBe(200);
    // Archive first so POST creates a separate record instead of reusing an active duplicate.
    const deleted = await create("задача");
    expect(deleted).not.toBe(archived);
    expect((await app.inject({ method: "DELETE", url: `/v1/memories/${deleted}`, payload: {} })).statusCode).toBe(200);
    expect((await query("задача")).map(item => item.id)).toEqual([active]);
    // Omitting knowledge_scope retains the existing physical-scope behavior.
    const response = await app.inject({ method: "POST", url: "/v1/recall", payload: { query: "задача", scope, limit: 100 } });
    expect(response.json().results.map((item: { id: string }) => item.id).sort()).toEqual([active, global, physicalGlobal].sort());
  });
});

it("retains the exact overlap signal and discounts normalized matches", () => {
  expect(tokenOverlap("задача", "задача")).toBe(1);
  expect(tokenOverlap("задача", "задачами")).toBe(0.75);
  expect(tokenOverlap("ёлка", "елка")).toBe(0.75);
  expect(tokenOverlap("container", "containerized")).toBe(0);
});
