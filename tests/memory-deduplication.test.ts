import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MemoryDb } from "../src/db/connection.js";
import { approveCandidate, insertCandidate } from "../src/domain/candidates.js";
import { createMemory } from "../src/domain/nodes.js";
import { buildServer } from "../src/server.js";

const scope = { kind: "project", project_id: "project:qa" };
const input = { type: "Fact", content: "Дедупмаркер хранит память", scope };

describe("explicit memory creation deduplication", () => {
  let db: MemoryDb;
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeEach(async () => { db = openDatabase(":memory:"); app = await buildServer(db); });
  afterEach(async () => { await app.close(); db.close(); });
  const post = (overrides = {}) => app.inject({ method: "POST", url: "/v1/memories", payload: { ...input, ...overrides } });

  it("atomically reuses simultaneous POSTs and returns one list/recall result", async () => {
    const responses = await Promise.all(Array.from({ length: 12 }, () => post()));
    expect(responses.filter(r => r.statusCode === 201)).toHaveLength(1);
    expect(responses.filter(r => r.statusCode === 200)).toHaveLength(11);
    const first = responses.find(r => r.statusCode === 201)!.json();
    expect(first).not.toHaveProperty("deduplicated");
    for (const response of responses.filter(r => r.statusCode === 200)) {
      expect(response.json()).toEqual({ ...first, deduplicated: true });
    }
    const list = await app.inject("/v1/memories?scope_kind=project&project_id=project%3Aqa&status=active&q=Дедупмаркер");
    expect(list.json().memories).toHaveLength(1);
    expect(list.json().memories[0].scope).toEqual(scope);
    const recall = await app.inject({ method: "POST", url: "/v1/recall", payload: {
      query: "Дедупмаркер", scope, knowledge_scope: "project_local"
    } });
    expect(recall.json().results.map((r: { id: string }) => r.id)).toEqual([first.id]);
  });

  it("normalizes only case, whitespace and one final ASCII period", async () => {
    const first = (await post()).json();
    for (const content of ["ДЕДУПМАРКЕР ХРАНИТ ПАМЯТЬ", "  Дедупмаркер хранит память  ", "Дедупмаркер\n\t хранит   память", "Дедупмаркер хранит память ."]) {
      expect((await post({ content })).json()).toMatchObject({ id: first.id, deduplicated: true });
    }
    for (const content of ["Дедупмаркер хранит слова", "Дедупмаркер, хранит память", "Дедупмаркер хранит память?", "Дедупмаркер хранит память..", "Дедупмаркер хранит память。", " ", "."]) {
      expect((await post({ content })).statusCode).toBe(201);
    }
    expect((await post({ content: " " })).statusCode).toBe(201);
    expect((await post({ content: "." })).statusCode).toBe(201);
    expect((await app.inject(`/v1/memories/${first.id}/explain`)).json().memory.content).toBe(input.content);
  });

  it("compares effective defaults and recursively unordered, sanitized metadata", async () => {
    const first = (await post()).json();
    expect((await post({ confidence: 0.8, privacy_level: "normal", metadata: { knowledge_scope: "project_local" } })).json().id).toBe(first.id);
    for (const overrides of [{ type: "Decision" }, { confidence: 0.9 }, { privacy_level: "sensitive" }, { metadata: { knowledge_scope: "global" } }, { metadata: { extra: true } }]) {
      expect((await post(overrides)).statusCode).toBe(201);
    }
    const nested = (await post({ metadata: { a: { x: 1, y: [1, 2] }, b: 2, password: "synthetic-value-one" } })).json();
    expect((await post({ metadata: { password: "synthetic-value-two", b: 2, a: { y: [1, 2], x: 1 } } })).json().id).toBe(nested.id);
    expect((await post({ metadata: { a: { x: 1, y: [2, 1] }, b: 2, password: "synthetic-value-one" } })).statusCode).toBe(201);
    const global = (await post({ scope: { kind: "global" } })).json();
    expect((await post({ scope: { kind: "global" }, metadata: { knowledge_scope: "global" } })).json().id).toBe(global.id);
  });

  it("compares every physical scope identity including absent conversation fields", async () => {
    const scopes = [scope, { kind: "project", project_id: "project:other" }, { kind: "global" },
      { kind: "user", user_id: "u" }, { kind: "workspace", workspace_id: "w" }, { kind: "agent", agent_id: "a" },
      { kind: "conversation", conversation_id: "c" },
      ...["user_id", "project_id", "workspace_id", "agent_id"].map(field => ({ kind: "conversation", conversation_id: "c", [field]: "identity" })),
      { kind: "conversation", conversation_id: "other" }];
    const ids = new Set();
    for (const physicalScope of scopes) {
      const first = await post({ scope: physicalScope });
      expect(first.statusCode).toBe(201);
      ids.add(first.json().id);
      expect((await post({ scope: physicalScope })).json().id).toBe(first.json().id);
    }
    expect(ids.size).toBe(scopes.length);
  });

  it.each(["archived", "deleted", "superseded", "candidate"])("does not reuse %s nodes", async status => {
    const first = (await post()).json();
    if (status === "archived") await app.inject({ method: "POST", url: `/v1/memories/${first.id}/archive` });
    else db.prepare("UPDATE nodes SET status = ? WHERE id = ?").run(status, first.id);
    const next = await post();
    expect(next.statusCode).toBe(201);
    expect(next.json().id).not.toBe(first.id);
  });

  it.each(["sensitive", "secret"])("preserves %s response redaction", async privacy_level => {
    const first = (await post({ privacy_level })).json();
    const next = await post({ privacy_level });
    expect(next.statusCode).toBe(200);
    expect(next.json()).toEqual({ ...first, deduplicated: true });
    expect(next.json().memory.content).toBe(`[redacted: ${privacy_level} memory]`);
    expect(next.json().memory.metadata).toEqual({});
  });

  it("adds sanitized provenance without changing memory or related links", async () => {
    await post({ content: "Дедупмаркер хранит память надёжно" });
    const first = (await post({ source: { kind: "manual", title: "first" } })).json();
    const edges = db.prepare("SELECT * FROM edges").all();
    expect(edges.length).toBeGreaterThan(0);
    const next = await post({ source: { kind: "manual", title: "second", content_excerpt: "password=synthetic-secret", metadata: { password: "synthetic-secret" } } });
    expect(next.json().memory).toEqual(first.memory);
    expect(db.prepare("SELECT * FROM edges").all()).toEqual(edges);
    const explanation = (await app.inject(`/v1/memories/${first.id}/explain`)).json();
    expect(explanation.sources).toHaveLength(2);
    expect(JSON.stringify(explanation)).not.toContain("synthetic-secret");
    expect(JSON.stringify(db.prepare("SELECT * FROM node_sources").all())).not.toContain("synthetic-secret");
  });

  it.each([{}, { profile_topic: "qa", profile_sub_topic: "format" }])("does not repeat preference projection (%j)", async metadata => {
    const first = (await post({ type: "Preference", metadata })).json();
    const before = (await app.inject("/v1/profile?knowledge_scope=project_local&project_id=project%3Aqa")).json();
    const slots = db.prepare("SELECT * FROM profile_slots").all();
    expect(slots).toHaveLength(1);
    const revisions = db.prepare("SELECT * FROM profile_slot_revisions").all();
    expect((await post({ type: "Preference", metadata, source: { kind: "manual" } })).json().id).toBe(first.id);
    expect((await app.inject("/v1/profile?knowledge_scope=project_local&project_id=project%3Aqa")).json()).toEqual(before);
    expect(db.prepare("SELECT * FROM profile_slots").all()).toEqual(slots);
    expect(db.prepare("SELECT * FROM profile_slot_revisions").all()).toEqual(revisions);
  });

  it("keeps candidate approval unconditional even when POST would reuse", async () => {
    const candidateId = "candidate:dedup-regression";
    const metadata = { approved_from_candidate_id: candidateId };
    const first = (await post({ metadata })).json();
    insertCandidate(db, {
      id: candidateId, type: input.type, content: input.content, scope: first.memory.scope,
      confidence: 0.8, risk: "low", needs_confirmation: true, privacy_level: "normal",
      status: "pending", metadata: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    });
    expect(approveCandidate(db, candidateId).id).not.toBe(first.id);
    expect(db.prepare("SELECT id FROM nodes WHERE status = 'active'").all()).toHaveLength(2);
  });

  it("rolls back source creation if attaching provenance fails", async () => {
    const first = (await post()).json();
    db.exec(`CREATE TRIGGER reject_evidence BEFORE INSERT ON node_sources
      BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
    expect((await post({ source: { kind: "manual" } })).statusCode).toBe(500);
    expect(db.prepare("SELECT * FROM sources").all()).toHaveLength(0);
    expect((await post()).json().id).toBe(first.id);
  });

  it("keeps low-level creation unconditional and does not merge historical duplicates", async () => {
    const first = createMemory(db, { ...input, scope: { kind: "project", project_id: "project:qa" } });
    const second = createMemory(db, { ...input, scope: first.scope });
    expect(first.id).not.toBe(second.id);
    expect((await post()).statusCode).toBe(200);
    expect(db.prepare("SELECT id FROM nodes WHERE status = 'active'").all()).toHaveLength(2);
  });
});
