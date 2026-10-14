import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MemoryDb } from "../src/db/connection.js";
import { buildServer } from "../src/server.js";

describe("memory list search", () => {
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

  async function create(content = "Проверка Регистра Кириллицы", type = "Fact", projectId = "project:qa") {
    const response = await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: { type, content, scope: { kind: "project", project_id: projectId }, source: { kind: "manual" } }
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  }

  async function search(q: string, options: Record<string, string> = {}) {
    const params = new URLSearchParams({ scope_kind: "project", project_id: "project:qa", q, ...options });
    const response = await app.inject({ method: "GET", url: `/v1/memories?${params}` });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  it("matches Cyrillic and Latin case variants, substrings, type, id, and LIKE patterns", async () => {
    const id = await create("Проверка Регистра Кириллицы MixedCase Ёлка");
    for (const query of [
      "регистра", "РЕГИСТРА", "РеГиСтРа", "ПРОВЕРКА", "гистр", "  РЕГИСТРА  ",
      "mixedcase", "MIXEDCASE", "mIxEdCaSe", "ёлка", "ЁЛКА", "FACT", "fAcT",
      id.toUpperCase(), id.slice(2).toUpperCase(), "РЕГ%СТРА", "РЕГ_СТРА", "%", "_"
    ]) {
      const result = await search(query);
      expect(result.total, query).toBe(1);
      expect(result.memories.map((memory: { id: string }) => memory.id), query).toEqual([id]);
    }
    expect((await search("несуществующая подстрока")).total).toBe(0);
  });

  it("combines search with type, project scope and active/archived status", async () => {
    const id = await create();
    await create("Проверка Регистра Кириллицы", "Fact", "project:other");
    expect((await search("РЕГИСТРА", { types: "Fact" })).memories.map((m: { id: string }) => m.id)).toEqual([id]);
    expect((await search("РЕГИСТРА", { types: "Decision" })).total).toBe(0);
    expect((await search("РЕГИСТРА", { project_id: "project:absent" })).total).toBe(0);
    expect((await search("РЕГИСТРА", { scope_kind: "global", project_id: "" })).total).toBe(0);
    expect((await search("РЕГИСТРА", { status: "archived" })).total).toBe(0);
    const archived = await app.inject({ method: "POST", url: `/v1/memories/${id}/archive`, payload: {} });
    expect(archived.statusCode).toBe(200);
    expect((await search("РЕГИСТРА", { status: "active" })).total).toBe(0);
    expect((await search("РЕГИСТРА", { status: "archived", types: "Fact" })).memories.map((m: { id: string }) => m.id)).toEqual([id]);
  });

  it("counts all matches before pagination and excludes nonmatching rows", async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const id = await create(`Проверка Регистра Кириллицы ${i}`);
      db.prepare("UPDATE nodes SET updated_at = ? WHERE id = ?").run(`2026-01-0${i + 1}T00:00:00.000Z`, id);
      ids.push(id);
    }
    await create("Другая запись");
    await create("Проверка Регистра Кириллицы", "Decision");
    await create("Проверка Регистра Кириллицы", "Fact", "project:other");
    for (let offset = 0; offset <= ids.length; offset++) {
      const page = await search("ГИСТР", { types: "Fact", status: "active", limit: "1", offset: String(offset) });
      expect(page).toMatchObject({ total: 3, limit: 1, offset });
      expect(page.memories.map((m: { id: string }) => m.id)).toEqual(offset < ids.length ? [ids[2 - offset]] : []);
    }
  });

  it("preserves Explorer Cyrillic search used by the memory UI", async () => {
    const id = await create();
    const response = await app.inject({ method: "GET", url: `/v1/explorer?${new URLSearchParams({ project_id: "project:qa", q: "регистра" })}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "memory", id })]));
    expect((await app.inject({ method: "GET", url: "/memory" })).statusCode).toBe(200);
  });
});
