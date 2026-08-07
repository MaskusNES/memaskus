import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MemoryDb } from "../src/db/connection.js";
import { buildServer } from "../src/server.js";

describe("scope, privacy, and review hardening", () => {
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

  it("keeps global recall isolated from project-local memory", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: { type: "Fact", content: "Global scope probe.", scope: { kind: "global" } }
    });
    await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Fact",
        content: "Project scope probe.",
        scope: { kind: "project", project_id: "project:private" }
      }
    });

    const globalRecall = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: { query: "scope probe", scope: { kind: "global" } }
    });
    expect(globalRecall.json().results.map((item: { content: string }) => item.content)).toEqual([
      "Global scope probe."
    ]);

    const projectRecall = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: { query: "scope probe", scope: { kind: "project", project_id: "project:private" } }
    });
    expect(projectRecall.json().results.map((item: { content: string }) => item.content).sort()).toEqual(
      ["Global scope probe.", "Project scope probe."].sort()
    );
  });

  it("isolates individual conversation scopes", async () => {
    for (const conversationId of ["conv:one", "conv:two"]) {
      await app.inject({
        method: "POST",
        url: "/v1/memories",
        payload: {
          type: "Fact",
          content: `Conversation probe ${conversationId}.`,
          scope: { kind: "conversation", conversation_id: conversationId }
        }
      });
    }
    const recall = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: {
        query: "conversation probe",
        scope: { kind: "conversation", conversation_id: "conv:one" }
      }
    });
    expect(recall.json().results.map((item: { content: string }) => item.content)).toEqual([
      "Conversation probe conv:one."
    ]);
  });

  it("keeps confirmation-gated user candidates pending and ignores assistant claims", async () => {
    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        analysis_mode: "heuristic",
        project_id: "project:agent-memory",
        text: [
          "Assistant: We decided to replace the database immediately.",
          "User: We should evaluate the migration tomorrow."
        ].join("\n")
      }
    });

    expect(review.statusCode).toBe(201);
    expect(review.json().summary).toMatchObject({
      extracted_candidates: 1,
      approved: 0,
      pending_confirmation: 1
    });
    expect(review.json().pending_confirmation[0]).toMatchObject({
      speaker_role: "user",
      needs_confirmation: true,
      status: "pending"
    });
  });

  it("rejects credentials before persistence and redacts protected profile responses", async () => {
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Fact",
        content: "api_key=abcdefghijklmnop",
        scope: { kind: "global" }
      }
    });
    expect(rejected.statusCode).toBe(400);
    expect((db.prepare("SELECT COUNT(*) AS count FROM nodes").get() as { count: number }).count).toBe(0);

    const created = await app.inject({
      method: "POST",
      url: "/v1/profile/slots",
      payload: {
        topic: "security",
        sub_topic: "private_note",
        content: "Protected personal note",
        privacy_level: "secret",
        knowledge_scope: "global",
        metadata: { private_context: "Metadata private detail" },
        reason: "Private revision reason"
      }
    });
    const slotId = created.json().id;
    const profile = await app.inject({ method: "GET", url: "/v1/profile?knowledge_scope=global" });
    const detail = await app.inject({ method: "GET", url: `/v1/profile/slots/${slotId}` });
    const context = await app.inject({
      method: "POST",
      url: "/v1/profile/context",
      payload: { knowledge_scope: "global" }
    });
    expect(profile.json().slots[0].content).toBe("[redacted: secret memory]");
    expect(detail.json().slot.content).toBe("[redacted: secret memory]");
    expect(detail.json().revisions[0].next_content).toBe("[redacted: secret memory]");
    expect(context.json().slots[0].content).toBe("[redacted: secret memory]");
    expect(JSON.stringify({ profile: profile.json(), detail: detail.json(), context: context.json() })).not.toContain(
      "Protected personal note"
    );
    expect(JSON.stringify({ profile: profile.json(), detail: detail.json(), context: context.json() })).not.toContain(
      "Metadata private detail"
    );

    await app.inject({
      method: "POST",
      url: "/v1/ingest/conversation",
      payload: {
        conversation_id: "conv:credential-redaction",
        text: "User: Remember that api_key=abcdefghijklmnop."
      }
    });
    const source = db
      .prepare("SELECT content_excerpt FROM sources WHERE external_id = 'conv:credential-redaction'")
      .get() as { content_excerpt: string };
    expect(source.content_excerpt).toContain("[redacted: credential]");
    expect(source.content_excerpt).not.toContain("abcdefghijklmnop");
  });

  it("does not let weaker profile evidence replace content or lower privacy", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/profile/slots",
      payload: {
        topic: "security",
        sub_topic: "policy",
        content: "High confidence policy",
        confidence: 0.99,
        privacy_level: "secret",
        knowledge_scope: "global"
      }
    });
    await app.inject({
      method: "POST",
      url: "/v1/profile/slots",
      payload: {
        topic: "security",
        sub_topic: "policy",
        content: "Weak replacement",
        confidence: 0.2,
        knowledge_scope: "global"
      }
    });
    const row = db.prepare("SELECT content, confidence, privacy_level FROM profile_slots").get() as {
      content: string;
      confidence: number;
      privacy_level: string;
    };
    expect(row).toEqual({
      content: "High confidence policy",
      confidence: 0.99,
      privacy_level: "secret"
    });
  });

  it("redacts credential-shaped metadata keys and reports database readiness", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Fact",
        content: "Metadata hardening probe.",
        scope: { kind: "global" },
        metadata: { api_key: "short-value", nested: { session_cookie: "also-short" } }
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().memory.metadata).toEqual({
      api_key: "[redacted: credential]",
      nested: { session_cookie: "[redacted: credential]" },
      knowledge_scope: "global"
    });

    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ ok: true, schema_version: 3 });
  });

  it("rejects candidate merges across type, exact scope, or knowledge layer", async () => {
    const target = await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Fact",
        content: "Existing project A fact.",
        scope: { kind: "project", project_id: "project:a" }
      }
    });

    async function ingest(text: string, projectId: string) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/ingest/conversation",
        payload: { project_id: projectId, text: `User: ${text}` }
      });
      return response.json().candidates[0].id as string;
    }

    const wrongProject = await ingest("Remember that project B uses a queue.", "project:b");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/candidates/${wrongProject}/merge`,
          payload: { memory_id: target.json().id }
        })
      ).statusCode
    ).toBe(400);

    const wrongType = await ingest("We decided to replace the queue.", "project:a");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/candidates/${wrongType}/merge`,
          payload: { memory_id: target.json().id }
        })
      ).statusCode
    ).toBe(400);

    const wrongLayer = await ingest("Remember that project A uses another queue.", "project:a");
    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/candidates/${wrongLayer}`,
      payload: { metadata: { knowledge_scope: "global" } }
    });
    expect(patched.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/candidates/${wrongLayer}/merge`,
          payload: { memory_id: target.json().id }
        })
      ).statusCode
    ).toBe(400);
  });

  it("retrieves globally classified knowledge even when it originated in a project", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Preference",
        content: "Always keep explanations concise.",
        scope: { kind: "project", project_id: "project:origin" },
        metadata: { knowledge_scope: "global" }
      }
    });

    const recall = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: {
        query: "concise explanations",
        scope: { kind: "global" },
        knowledge_scope: "global"
      }
    });
    expect(recall.statusCode).toBe(200);
    expect(recall.json().results.map((item: { id: string }) => item.id)).toContain(created.json().id);
  });
});

describe("database migrations", () => {
  it("upgrades a legacy schema without replacing its data", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-migration-"));
    const databasePath = path.join(directory, "legacy.sqlite");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL, scope_kind TEXT NOT NULL,
        scope_user_id TEXT, scope_project_id TEXT, scope_workspace_id TEXT, scope_agent_id TEXT,
        confidence REAL NOT NULL, status TEXT NOT NULL, privacy_level TEXT NOT NULL,
        metadata_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE candidates (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL, scope_kind TEXT NOT NULL,
        scope_user_id TEXT, scope_project_id TEXT, scope_workspace_id TEXT, scope_agent_id TEXT,
        confidence REAL NOT NULL, risk TEXT NOT NULL, needs_confirmation INTEGER NOT NULL,
        status TEXT NOT NULL, source_id TEXT, metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO nodes VALUES (
        'node_legacy', 'Fact', 'Legacy content', 'global', NULL, NULL, NULL, NULL,
        0.9, 'active', 'normal', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    const migrated = openDatabase(databasePath);
    expect(migrated.pragma("user_version", { simple: true })).toBe(3);
    expect((migrated.prepare("SELECT content FROM nodes WHERE id = 'node_legacy'").get() as { content: string }).content).toBe(
      "Legacy content"
    );
    const candidateColumns = migrated.prepare("PRAGMA table_info(candidates)").all() as Array<{ name: string }>;
    expect(candidateColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["scope_conversation_id", "knowledge_scope", "privacy_level", "speaker_role", "turn_id"])
    );
    migrated.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("fails fast when the database was created by a newer service version", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-future-"));
    const databasePath = path.join(directory, "future.sqlite");
    const future = new Database(databasePath);
    future.pragma("user_version = 999");
    future.close();

    expect(() => openDatabase(databasePath)).toThrow(/newer than supported version 3/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
