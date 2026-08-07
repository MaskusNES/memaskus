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
    expect(explanation.json().evidence[0].evidence_text).toContain("first design");

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

  it("forgets candidate, conflict, graph, source, profile, and revision lineage", async () => {
    const canary = "ERASE_ME_42F8A9";
    const ingested = await app.inject({
      method: "POST",
      url: "/v1/ingest/conversation",
      payload: {
        conversation_id: "conv:forget-lineage",
        project_id: "project:forget-lineage",
        text: `User: I prefer alphabetically sorted catalog entries tagged ${canary}.`
      }
    });
    const candidateId = ingested.json().candidates[0].id as string;
    const approved = await app.inject({
      method: "POST",
      url: `/v1/candidates/${candidateId}/approve`
    });
    expect(approved.statusCode, approved.body).toBe(201);
    const memoryId = approved.json().id as string;

    const other = await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Preference",
        content: "Other preference.",
        scope: { kind: "project", project_id: "project:forget-lineage" }
      }
    });
    const linked = await app.inject({
      method: "POST",
      url: "/v1/links",
      payload: {
        from_id: memoryId,
        to_id: other.json().id,
        relation: "RELATED_TO",
        metadata: { evidence: canary }
      }
    });
    expect(linked.statusCode).toBe(201);
    await app.inject({
      method: "PATCH",
      url: `/v1/memories/${memoryId}`,
      payload: { reason: `Correction ${canary}`, confidence: 0.93 }
    });
    await app.inject({
      method: "POST",
      url: `/v1/memories/${memoryId}/feedback`,
      payload: { rating: "correct", comment: canary, action: canary }
    });
    db.prepare(
      `INSERT INTO candidate_conflicts
       (id, candidate_id, memory_id, status, reason, question, resolution, created_at, updated_at)
       VALUES ('conflict_forget', ?, ?, 'resolved', ?, ?, ?, datetime('now'), datetime('now'))`
    ).run(candidateId, memoryId, canary, canary, canary);

    const forgotten = await app.inject({
      method: "DELETE",
      url: `/v1/memories/${memoryId}`,
      payload: { reason: `User supplied reason ${canary}` }
    });
    expect(forgotten.statusCode).toBe(200);

    const tables = [
      "nodes",
      "edges",
      "sources",
      "node_sources",
      "candidates",
      "candidate_conflicts",
      "profile_slots",
      "profile_slot_sources",
      "profile_slot_revisions",
      "memory_revisions",
      "memory_feedback"
    ];
    for (const table of tables) {
      expect(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()), table).not.toContain(canary);
    }
  });

  it("uses user feedback as a retrieval ranking signal", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: { type: "Fact", content: "Quartz cache policy reference.", scope: { kind: "global" } }
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: { type: "Fact", content: "Quartz cache policy reference.", scope: { kind: "global" } }
    });
    await app.inject({
      method: "POST",
      url: `/v1/memories/${first.json().id}/feedback`,
      payload: { rating: "wrong" }
    });

    const recall = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: { query: "Quartz cache policy", scope: { kind: "global" } }
    });
    expect(recall.json().results[0].id).toBe(second.json().id);
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
