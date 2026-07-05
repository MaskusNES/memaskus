import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MemoryDb } from "../src/db/connection.js";
import { buildServer } from "../src/server.js";

describe("memory API", () => {
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

  it("creates and recalls source-backed memory", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Decision",
        content: "The MVP will use SQLite for local graph-shaped memory.",
        scope: {
          kind: "project",
          project_id: "project:agent-memory"
        },
        confidence: 0.95,
        source: {
          kind: "manual",
          title: "MVP planning"
        }
      }
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json();

    const recallResponse = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: {
        query: "SQLite MVP memory",
        scope: {
          kind: "project",
          project_id: "project:agent-memory"
        },
        include_sources: true
      }
    });

    expect(recallResponse.statusCode).toBe(200);
    const recalled = recallResponse.json();
    expect(recalled.results[0].id).toBe(created.id);
    expect(recalled.results[0].sources[0].title).toBe("MVP planning");
  });

  it("filters recall by knowledge scope", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Preference",
        content: "Пользователь хочет глобальный bootstrap памяти перед задачами.",
        scope: { kind: "global" },
        metadata: { knowledge_scope: "global" }
      }
    });

    await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Preference",
        content: "Пользователь хочет локальный bootstrap памяти внутри проекта.",
        scope: { kind: "project", project_id: "project:agent-memory" },
        metadata: { knowledge_scope: "project_local" }
      }
    });

    const recallResponse = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: {
        query: "bootstrap памяти",
        scope: { kind: "global" },
        knowledge_scope: "global",
        types: ["Preference"]
      }
    });

    expect(recallResponse.statusCode).toBe(200);
    const contents = recallResponse.json().results.map((result: { content: string }) => result.content);
    expect(contents).toContain("Пользователь хочет глобальный bootstrap памяти перед задачами.");
    expect(contents).not.toContain("Пользователь хочет локальный bootstrap памяти внутри проекта.");
  });

  it("infers global knowledge scope from global memory scope", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Preference",
        content: "User prefers reusable workflows across projects.",
        scope: { kind: "global" }
      }
    });

    const recallResponse = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: {
        query: "reusable workflows",
        scope: { kind: "global" },
        knowledge_scope: "global",
        types: ["Preference"]
      }
    });

    expect(recallResponse.statusCode).toBe(200);
    expect(recallResponse.json().results[0].content).toContain("reusable workflows");
  });

  it("does not recall memories without query overlap", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Preference",
        content: "User prefers concise implementation summaries.",
        scope: { kind: "global" },
        confidence: 0.99
      }
    });

    const recallResponse = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: {
        query: "PostgreSQL storage",
        scope: { kind: "global" }
      }
    });

    expect(recallResponse.statusCode).toBe(200);
    expect(recallResponse.json().results).toHaveLength(0);
  });

  it("redacts secret memory content in recall, explain, and graph responses", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Fact",
        content: "The API key is sk-secret-test.",
        scope: { kind: "project", project_id: "project:agent-memory" },
        privacy_level: "secret",
        source: {
          kind: "manual",
          title: "Secret note",
          content_excerpt: "The API key is sk-secret-test."
        }
      }
    });

    const created = createResponse.json();
    const recallResponse = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: {
        query: "API key",
        scope: { kind: "project", project_id: "project:agent-memory" },
        include_sources: true
      }
    });

    expect(recallResponse.json().results[0].content).toBe("[redacted: secret memory]");
    expect(recallResponse.json().results[0].sources[0].content_excerpt).toBe("[redacted: secret memory]");

    const explainResponse = await app.inject({
      method: "GET",
      url: `/v1/memories/${created.id}/explain`
    });
    expect(explainResponse.json().memory.content).toBe("[redacted: secret memory]");
    expect(explainResponse.json().sources[0].content_excerpt).toBe("[redacted: secret memory]");

    const graphResponse = await app.inject({
      method: "GET",
      url: "/v1/graph?project_id=project:agent-memory"
    });
    expect(graphResponse.json().nodes[0].content).toBe("[redacted: secret memory]");
  });

  it("rejects project scope without a project id", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Fact",
        content: "Invalid scope should not be accepted.",
        scope: { kind: "project" }
      }
    });

    expect(response.statusCode).toBe(400);
  });

  it("explains memory and graph links", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Decision",
        content: "The memory service exposes an HTTP API.",
        scope: { kind: "project", project_id: "project:agent-memory" }
      }
    });

    const second = await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Project",
        content: "Agent memory project",
        scope: { kind: "project", project_id: "project:agent-memory" }
      }
    });

    const firstId = first.json().id;
    const secondId = second.json().id;

    const link = await app.inject({
      method: "POST",
      url: "/v1/links",
      payload: {
        from_id: firstId,
        to_id: secondId,
        relation: "APPLIES_TO",
        confidence: 0.9
      }
    });

    expect(link.statusCode).toBe(201);

    const explain = await app.inject({
      method: "GET",
      url: `/v1/memories/${firstId}/explain`
    });

    expect(explain.statusCode).toBe(200);
    expect(explain.json().links.outgoing[0].relation).toBe("APPLIES_TO");
  });
});
