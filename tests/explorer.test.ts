import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MemoryDb } from "../src/db/connection.js";
import { buildServer } from "../src/server.js";
import { insertCandidate, type Candidate } from "../src/domain/candidates.js";
import { insertConflict } from "../src/domain/review.js";
import { getMemory } from "../src/domain/nodes.js";
import { listSourcesForNode } from "../src/domain/sources.js";

describe("explorer search", () => {
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

  async function create(content: string, extra: Record<string, unknown> = {}) {
    const response = await app.inject({
      method: "POST", url: "/v1/memories",
      payload: { type: "Fact", content, scope: { kind: "project", project_id: "project:qa" }, ...extra }
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  }
  async function explore(q?: string, limit = 200, project_id = "project:qa") {
    const params = new URLSearchParams({ limit: String(limit), project_id });
    if (q !== undefined) params.set("q", q);
    const response = await app.inject({ method: "GET", url: `/v1/explorer?${params}` });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  it("searches old memories and sources independently, with unfiltered counts and the original browse window", async () => {
    const old = await create("СтаринныйМаркер Ёлка MixedCase 50% a_b", {
      source: { kind: "manual", title: "УникальныйЗаголовок", content_excerpt: "УникальнаяВыдержка" }
    });
    db.prepare("UPDATE nodes SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(old);
    const ids = [];
    for (let i = 0; i < 205; i++) {
      const id = await create(`filler ${i}`);
      db.prepare("UPDATE nodes SET updated_at = ? WHERE id = ?")
        .run(new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString(), id);
      ids.push(id);
    }
    await create("global marker", { scope: { kind: "global" } });
    await create("foreign", { scope: { kind: "project", project_id: "project:other" } });
    const list = await app.inject({
      method: "GET", url: "/v1/memories?scope_kind=project&project_id=project:qa&status=active"
    });
    expect(list.json().total).toBe(207);
    for (const q of [undefined, "", "   ", "старинныймаркер", "absent"]) {
      for (const limit of [1, 17, 200]) {
        expect((await explore(q, limit)).counts.memories).toBe(list.json().total);
      }
    }
    const browse = await explore();
    expect(browse.items.map((item: { id: string }) => item.id))
      .toEqual([expect.any(String), ...ids.slice(-199).reverse()]);
    expect(browse.items.some((item: { id: string }) => item.id === old)).toBe(false);
    for (const q of ["СТАРИННЫЙМАРКЕР", "ЁЛКА", "mixedcase", old.toUpperCase(), "50%", "a_b"]) {
      expect((await explore(q)).items).toEqual([expect.objectContaining({ kind: "memory", id: old })]);
    }
    for (const q of ["уникальныйзаголовок", "УНИКАЛЬНАЯВЫДЕРЖКА"]) {
      expect((await explore(q)).items).toEqual([expect.objectContaining({ kind: "source" })]);
    }
    for (const q of ["a%b", "a_b_missing", "старинный%маркер", "старинный_маркер"]) {
      expect((await explore(q)).items).toEqual([]);
    }
    for (const q of ["FACT", "MEMORY", "ACTIVE"]) {
      expect((await explore(q)).items).toHaveLength(200);
      // The old match can legitimately be excluded by the shared final limit.
      expect((await explore(q)).items.some((item: { id: string }) => item.id === old)).toBe(false);
    }
    expect((await explore("global marker")).items).toHaveLength(1);
    expect((await explore("foreign")).items).toEqual([]);
    expect((await explore("старинныймаркер", 200, "")).items).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/memory" })).statusCode).toBe(200);
  });

  it("deduplicates shared sources before search, counts and limits independently of parent text", async () => {
    const parent = await create("first parent", {
      scope: { kind: "global" },
      source: { kind: "manual", title: "source-only marker", content_excerpt: "unique excerpt" }
    });
    const source = listSourcesForNode(db, parent)[0]!;
    for (let i = 0; i < 3; i++) {
      const id = await create(`other parent ${i}`, { scope: { kind: "global" } });
      db.prepare("INSERT INTO node_sources (node_id, source_id, created_at) VALUES (?, ?, ?)")
        .run(id, source.id, source.created_at);
    }
    const other = await create("separate parent", {
      source: { kind: "manual", title: "source-only marker second" }
    });
    const otherSource = listSourcesForNode(db, other)[0]!;
    db.prepare("UPDATE sources SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(otherSource.id);
    for (const q of [undefined, "source-only marker", "unique excerpt", source.id]) {
      const result = await explore(q);
      expect(result.items.filter((item: { id: string }) => item.id === source.id))
        .toEqual([expect.objectContaining({ kind: "source", data: source })]);
      expect(result.counts.sources).toBe(2);
    }
    expect((await explore("source-only marker", 2)).items.map((item: { id: string }) => item.id))
      .toEqual([source.id, otherSource.id]);

    const protectedParent = await create("protected parent", { privacy_level: "secret" });
    db.prepare("INSERT INTO node_sources (node_id, source_id, created_at) VALUES (?, ?, ?)")
      .run(protectedParent, source.id, source.created_at);
    for (const updatedAt of ["1999-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z"]) {
      db.prepare("UPDATE nodes SET updated_at = ? WHERE id = ?").run(updatedAt, protectedParent);
      expect((await explore("unique excerpt")).items)
        .toEqual([expect.objectContaining({ kind: "source", data: source })]);
    }
  });

  it("matches type, kind, status and literal percent/underscore on public fields", async () => {
    const id = await create("literal 10% and a_b");
    await create("literal 10X and axb", { type: "Decision" });
    for (const q of ["fAcT", "10%", "a_b"]) {
      expect((await explore(q)).items).toEqual([expect.objectContaining({ id })]);
    }
    for (const q of ["MeMoRy", "AcTiVe"]) expect((await explore(q)).items).toHaveLength(2);
  });

  it("excludes inactive/foreign memories and their sources and searches only redacted content", async () => {
    for (const status of ["archived", "deleted"]) {
      const id = await create(`excluded-${status}`, { source: { kind: "manual", title: `excluded-source-${status}` } });
      db.prepare("UPDATE nodes SET status = ? WHERE id = ?").run(status, id);
    }
    await create("excluded-foreign", {
      scope: { kind: "project", project_id: "project:other" },
      source: { kind: "manual", title: "excluded-source-foreign" }
    });
    for (const privacy_level of ["sensitive", "secret"]) {
      const id = await create(`hidden-${privacy_level}`, {
        privacy_level, source: { kind: "manual", title: "hidden-title", content_excerpt: "hidden-excerpt" }
      });
      expect((await explore(id)).items[0].data).toMatchObject({
        content: `[redacted: ${privacy_level} memory]`, metadata: {}
      });
    }
    for (const q of ["excluded", "hidden"]) expect((await explore(q)).items).toEqual([]);
    const sources = (await explore("protected source")).items;
    expect(sources).toHaveLength(2);
    for (const source of sources) {
      expect(source.data).toMatchObject({ title: "[redacted: protected source]", external_id: null, metadata: {} });
      expect(source.content).toMatch(/^\[redacted:/);
    }
    expect((await explore()).counts.memories).toBe(2);
  });

  it("combines all item types before sorting and applying the shared limit", async () => {
    const memoryId = await create("sharedmarker memory", {
      source: { kind: "manual", title: "sharedmarker source" }
    });
    const candidate: Candidate = {
      id: "candidate_fixture", type: "Fact", content: "sharedmarker candidate",
      scope: { kind: "project", project_id: "project:qa" }, confidence: 0.9,
      risk: "low", needs_confirmation: false, privacy_level: "normal",
      status: "pending", metadata: {}, created_at: "2025-01-03T00:00:00.000Z",
      updated_at: "2025-01-03T00:00:00.000Z"
    };
    insertCandidate(db, candidate);
    insertConflict(db, candidate, getMemory(db, memoryId), "fixture");
    const profile = await app.inject({
      method: "POST", url: "/v1/profile/slots",
      payload: { topic: "product", sub_topic: "language", content: "sharedmarker profile", knowledge_scope: "global" }
    });
    expect(profile.statusCode).toBe(201);
    for (const [table, day] of [["nodes", "01"], ["sources", "02"], ["candidate_conflicts", "04"], ["profile_slots", "05"]]) {
      const column = table === "sources" ? "created_at" : "updated_at";
      db.prepare(`UPDATE ${table} SET ${column} = ?`).run(`2025-01-${day}T00:00:00.000Z`);
    }
    const all = (await explore("SHAREDMARKER")).items;
    expect(all.map((item: { kind: string }) => item.kind)).toEqual(["profile", "conflict", "candidate", "source", "memory"]);
    for (const limit of [1, 3, 5]) expect((await explore("sharedmarker", limit)).items).toEqual(all.slice(0, limit));
    for (const item of all) {
      for (const q of [item.id.toUpperCase(), item.kind.toUpperCase(), item.title.toUpperCase(), item.status.toUpperCase()]) {
        expect((await explore(q)).items).toContainEqual(item);
      }
    }
  });
});
