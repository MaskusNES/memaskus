import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MemoryDb } from "../src/db/connection.js";
import { buildServer } from "../src/server.js";

describe("candidate ingestion API", () => {
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

  it("ingests conversation text and approves a candidate into active memory", async () => {
    const ingest = await app.inject({
      method: "POST",
      url: "/v1/ingest/conversation",
      payload: {
        conversation_id: "conv:test",
        project_id: "project:agent-memory",
        text: "User: Remember that this memory system must be graph-based.\nUser: We decided to use SQLite for the first MVP."
      }
    });

    expect(ingest.statusCode).toBe(201);
    const body = ingest.json();
    expect(body.candidates.length).toBeGreaterThanOrEqual(1);

    const candidateId = body.candidates[0].id;
    const approve = await app.inject({
      method: "POST",
      url: `/v1/candidates/${candidateId}/approve`
    });

    expect(approve.statusCode).toBe(201);

    const recall = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: {
        query: "graph memory system",
        scope: { kind: "project", project_id: "project:agent-memory" },
        include_sources: true
      }
    });

    expect(recall.statusCode).toBe(200);
    expect(recall.json().results[0].sources[0].kind).toBe("conversation");
  });

  it("rejects a candidate without creating active memory", async () => {
    const ingest = await app.inject({
      method: "POST",
      url: "/v1/ingest/conversation",
      payload: {
        project_id: "project:agent-memory",
        text: "User: We should add a graph visualization later."
      }
    });

    const candidateId = ingest.json().candidates[0].id;
    const reject = await app.inject({
      method: "POST",
      url: `/v1/candidates/${candidateId}/reject`
    });

    expect(reject.statusCode).toBe(200);
    expect(reject.json().status).toBe("rejected");

    const recall = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: {
        query: "graph visualization",
        scope: { kind: "project", project_id: "project:agent-memory" }
      }
    });

    expect(recall.json().results).toHaveLength(0);
  });
});
