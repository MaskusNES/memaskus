import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MemoryDb } from "../src/db/connection.js";
import { buildServer } from "../src/server.js";

describe("memory lifecycle and control center", () => {
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

  it("lists, corrects, explains, rates, and archives memory", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Decision",
        content: "The service uses the first design.",
        scope: { kind: "project", project_id: "project:agent-memory" },
        source: { kind: "manual", title: "Initial design" }
      }
    });
    const id = created.json().id;

    const list = await app.inject({
      method: "GET",
      url: "/v1/memories?scope_kind=project&project_id=project%3Aagent-memory&q=first"
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ total: 1 });

    const corrected = await app.inject({
      method: "PATCH",
      url: `/v1/memories/${id}`,
      payload: {
        content: "The service uses the corrected design.",
        confidence: 0.97,
        reason: "User correction"
      }
    });
    expect(corrected.json().memory.content).toBe("The service uses the corrected design.");

    const feedback = await app.inject({
      method: "POST",
      url: `/v1/memories/${id}/feedback`,
      payload: { rating: "correct", comment: "Confirmed by the user." }
    });
    expect(feedback.statusCode).toBe(201);

    const explanation = await app.inject({ method: "GET", url: `/v1/memories/${id}/explain` });
    expect(explanation.json().revisions).toHaveLength(1);
    expect(explanation.json().feedback).toHaveLength(1);
    expect(explanation.json().sources[0].title).toBe("Initial design");

    await app.inject({
      method: "POST",
      url: `/v1/memories/${id}/archive`,
      payload: { reason: "No longer active" }
    });
    const recall = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: {
        query: "corrected design",
        scope: { kind: "project", project_id: "project:agent-memory" }
      }
    });
    expect(recall.json().results).toHaveLength(0);
  });

  it("forgets content, revisions, and direct evidence", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Preference",
        content: "A preference that must disappear.",
        scope: { kind: "global" },
        source: { kind: "manual", title: "Forget test" }
      }
    });
    const id = created.json().id;
    await app.inject({
      method: "PATCH",
      url: `/v1/memories/${id}`,
      payload: { content: "An updated preference that must disappear.", reason: "update before delete" }
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/memories/${id}`,
      payload: { reason: "user requested forget" }
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().memory).toMatchObject({ status: "deleted", content: "[deleted by user]" });
    expect((db.prepare("SELECT COUNT(*) AS count FROM node_sources WHERE node_id = ?").get(id) as { count: number }).count).toBe(0);
    expect(
      (db.prepare("SELECT GROUP_CONCAT(next_content) AS content FROM memory_revisions WHERE memory_id = ?").get(id) as {
        content: string;
      }).content
    ).not.toContain("preference");
  });

  it("serves the unified review and explorer workspace", async () => {
    const response = await app.inject({ method: "GET", url: "/memory" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Review Inbox");
    expect(response.body).toContain("Conflict resolution");
    expect(response.body).toContain("Explorer");

    await app.inject({
      method: "POST",
      url: "/v1/profile/slots",
      payload: {
        topic: "product",
        sub_topic: "language",
        content: "The interface uses Russian.",
        knowledge_scope: "global"
      }
    });
    const explorer = await app.inject({
      method: "GET",
      url: "/v1/explorer?q=Russian&project_id=project%3Aagent-memory"
    });
    expect(explorer.statusCode).toBe(200);
    expect(explorer.json().items[0]).toMatchObject({ kind: "profile", content: "The interface uses Russian." });
  });
});
