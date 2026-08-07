import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MemoryDb } from "../src/db/connection.js";
import { buildServer } from "../src/server.js";

describe("conversation review with conflict handling", () => {
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

  it("auto-approves non-conflicting candidates", async () => {
    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        conversation_id: "conv:safe",
        project_id: "project:agent-memory",
        text: "User: Remember that the sample catalog stores a publication year for each book."
      }
    });

    expect(review.statusCode).toBe(201);
    expect(review.json().summary).toMatchObject({
      extracted_candidates: 1,
      approved: 1,
      blocked: 0,
      conflicts: 0
    });

    const recall = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: {
        query: "sample catalog publication year",
        scope: { kind: "project", project_id: "project:agent-memory" }
      }
    });

    expect(recall.json().results[0].content).toContain("publication year");
  });

  it("blocks conflicting candidates until the user accepts the new information", async () => {
    const existing = await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Decision",
        content: "The demo formatter will use Python for implementation.",
        scope: { kind: "project", project_id: "project:agent-memory" },
        confidence: 0.95
      }
    });

    const oldMemoryId = existing.json().id;

    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        conversation_id: "conv:conflict",
        project_id: "project:agent-memory",
        text: "User: We decided to use Rust for the demo formatter implementation."
      }
    });

    expect(review.statusCode).toBe(201);
    const reviewBody = review.json();
    expect(reviewBody.summary).toMatchObject({
      extracted_candidates: 1,
      approved: 0,
      blocked: 1,
      conflicts: 1
    });

    const conflict = reviewBody.conflicts[0];
    expect(conflict.memory_id).toBe(oldMemoryId);
    expect(conflict.question).toContain("В моей существующей базе знаний сказано");
    expect(conflict.question).toContain("В ходе этого диалога было сказано");
    expect(conflict.question).toContain("кажутся противоречивыми");

    const recallBeforeResolution = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: {
        query: "Rust demo formatter implementation",
        scope: { kind: "project", project_id: "project:agent-memory" }
      }
    });
    expect(recallBeforeResolution.json().results.map((result: { content: string }) => result.content)).not.toContain(
      "We decided to use Rust for the demo formatter implementation."
    );

    const bypassAttempt = await app.inject({
      method: "POST",
      url: `/v1/candidates/${conflict.candidate_id}/approve`
    });
    expect(bypassAttempt.statusCode).toBe(400);
    expect(
      (db.prepare("SELECT status FROM candidates WHERE id = ?").get(conflict.candidate_id) as { status: string }).status
    ).toBe("blocked");

    const resolution = await app.inject({
      method: "POST",
      url: `/v1/conflicts/${conflict.id}/resolve`,
      payload: {
        action: "accept_new",
        note: "The implementation language changed during planning."
      }
    });

    expect(resolution.statusCode).toBe(200);
    expect(resolution.json().candidate.status).toBe("approved");

    const recallAfterResolution = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: {
        query: "Rust demo formatter implementation",
        scope: { kind: "project", project_id: "project:agent-memory" }
      }
    });
    expect(recallAfterResolution.json().results[0].content).toBe("We decided to use Rust for the demo formatter implementation.");

    const sqliteRecall = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: {
        query: "Python formatter implementation",
        scope: { kind: "project", project_id: "project:agent-memory" }
      }
    });
    expect(sqliteRecall.json().results.map((result: { id: string }) => result.id)).not.toContain(oldMemoryId);
  });

  it("keeps existing memory when the user rejects the new conflicting candidate", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Decision",
        content: "The demo formatter will use Python for implementation.",
        scope: { kind: "project", project_id: "project:agent-memory" },
        confidence: 0.95
      }
    });

    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        project_id: "project:agent-memory",
        text: "User: We decided to use Rust for the demo formatter implementation."
      }
    });

    const conflict = review.json().conflicts[0];
    const resolution = await app.inject({
      method: "POST",
      url: `/v1/conflicts/${conflict.id}/resolve`,
      payload: {
        action: "keep_existing",
        note: "The user clarified that Rust was only an example."
      }
    });

    expect(resolution.statusCode).toBe(200);
    expect(resolution.json().candidate.status).toBe("rejected");

    const recall = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: {
        query: "Python formatter implementation",
        scope: { kind: "project", project_id: "project:agent-memory" }
      }
    });
    expect(recall.json().results[0].content).toBe("The demo formatter will use Python for implementation.");
  });
});
