import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MemoryDb } from "../src/db/connection.js";
import { buildServer } from "../src/server.js";

describe("graph API and view", () => {
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

  it("returns graph nodes and edges for the selected project", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Decision",
        content: "Graph visualization should show memory links.",
        scope: { kind: "project", project_id: "project:agent-memory" }
      }
    });

    const second = await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Project",
        content: "Agent memory",
        scope: { kind: "project", project_id: "project:agent-memory" }
      }
    });

    await app.inject({
      method: "POST",
      url: "/v1/links",
      payload: {
        from_id: first.json().id,
        to_id: second.json().id,
        relation: "APPLIES_TO"
      }
    });

    const graph = await app.inject({
      method: "GET",
      url: "/v1/graph?project_id=project:agent-memory"
    });

    expect(graph.statusCode).toBe(200);
    expect(graph.json().nodes).toHaveLength(2);
    expect(graph.json().nodes[0].display_id).toMatch(/^N-[a-z0-9]{6}$/);
    expect(graph.json().edges[0].display_id).toMatch(/^E-[a-z0-9]{6}$/);
    expect(graph.json().edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relation: "APPLIES_TO" })
      ])
    );
  });

  it("auto-links related memories created during review", async () => {
    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        project_id: "project:agent-memory",
        analysis_mode: "heuristic",
        text: [
          "User: Remember that the sample catalog should show related books.",
          "User: We decided that the sample catalog should connect related book entries."
        ].join("\n")
      }
    });

    expect(review.statusCode).toBe(201);
    expect(review.json().summary).toMatchObject({
      approved: 2
    });

    const graph = await app.inject({
      method: "GET",
      url: "/v1/graph?project_id=project:agent-memory"
    });

    expect(graph.json().nodes).toHaveLength(2);
    expect(graph.json().edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: "RELATED_TO"
        })
      ])
    );
  });

  it("keeps global and project-local memories in separate subgraphs", async () => {
    const globalMemory = await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Preference",
        content: "Demo user prefers ISO date formatting across all projects.",
        scope: { kind: "project", project_id: "project:agent-memory" },
        metadata: {
          knowledge_scope: "global"
        }
      }
    });

    const localMemory = await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Preference",
        content: "Demo project uses ISO date formatting in generated archives.",
        scope: { kind: "project", project_id: "project:agent-memory" },
        metadata: {
          knowledge_scope: "project_local"
        }
      }
    });

    const manualLink = await app.inject({
      method: "POST",
      url: "/v1/links",
      payload: {
        from_id: globalMemory.json().id,
        to_id: localMemory.json().id,
        relation: "RELATED_TO"
      }
    });

    expect(manualLink.statusCode).toBe(400);

    const graph = await app.inject({
      method: "GET",
      url: "/v1/graph?project_id=project:agent-memory"
    });

    expect(graph.json().nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ knowledge_scope: "global" }),
        expect.objectContaining({ knowledge_scope: "project_local" })
      ])
    );
    expect(graph.json().edges).toHaveLength(0);
  });

  it("serves the graph view", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/graph"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Agent Memory Graph");
  });
});
