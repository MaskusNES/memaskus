import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MemoryDb } from "../src/db/connection.js";
import { openDatabase as previousOpenDatabase } from "./fixtures/previous-release/db/connection.js";
import { buildServer } from "../src/server.js";
import { createMemory, getMemory } from "../src/domain/nodes.js";
import { createSource, listSourcesForNode } from "../src/domain/sources.js";
import { applyMemoryToProfile, getProfileSlot, listProfileSlots } from "../src/domain/profile.js";
import { insertCandidate, type Candidate } from "../src/domain/candidates.js";
import { archiveMemory, forgetMemory, updateMemory } from "../src/domain/memory-lifecycle.js";
import { createLink } from "../src/domain/links.js";
import { semanticNodeSearch } from "../src/domain/semantic-search.js";
import { redactSecrets } from "../src/domain/privacy.js";

const qa = { kind: "project" as const, project_id: "project:qa" };
const runFile = promisify(execFile);

describe("technical audit regressions", () => {
  let db: MemoryDb;
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeEach(async () => { db = openDatabase(":memory:"); app = await buildServer(db); });
  afterEach(async () => { await app.close(); db.close(); });
  function memory(content: string, extra = {}) {
    return createMemory(db, { type: "Fact", content, scope: qa, ...extra });
  }
  function candidate(content: string, extra: Partial<Candidate> = {}) {
    const item: Candidate = { id: `cand_${Math.random().toString(36).slice(2)}`, type: "Fact", content, scope: qa,
      confidence: 0.9, risk: "low", needs_confirmation: false, privacy_level: "normal", status: "pending",
      metadata: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...extra };
    insertCandidate(db, item); return item;
  }
  async function send(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object, status = 200) {
    const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    expect(response.statusCode, response.body).toBe(status); return response.json();
  }

  it("rejects quoted JSON credentials in memories and profile writes; sanitizes sources and public legacy content", async () => {
    for (const key of ["password", "api_key"]) {
      const content = JSON.stringify({ [key]: "synthetic12345678" });
      await send("POST", "/v1/memories", { type: "Fact", content, scope: qa }, 400);
      await send("POST", "/v1/profile/slots", { topic: "qa", content }, 400);
      const slot = await send("POST", "/v1/profile/slots", { topic: "qa", content: "Safe value" }, 201);
      await send("PATCH", `/v1/profile/slots/${slot.id}`, { content }, 400);
      const source = createSource(db, { kind: "manual", content_excerpt: content, title: content });
      expect(JSON.stringify(source)).not.toContain("synthetic12345678");
      const legacy = memory("Safe original");
      db.prepare("UPDATE nodes SET content = ? WHERE id = ?").run(content, legacy.id);
      expect(JSON.stringify(await send("GET", `/v1/memories/${legacy.id}/explain`))).not.toContain("synthetic12345678");
    }
  });

  it.each([true, false])("redacts full and unfinished PEM bodies before source persistence (closed=%s)", async (closed) => {
    const pem = `-----BEGIN PRIVATE KEY-----\nSYNTHETIC_KEY_BODY\n${closed ? "-----END PRIVATE KEY-----\nAllowed tail" : "unfinished body"}`;
    expect(redactSecrets(pem)).not.toContain("SYNTHETIC_KEY_BODY");
    expect(redactSecrets(pem).includes("Allowed tail")).toBe(closed);
    createSource(db, { kind: "manual", title: pem, content_excerpt: pem });
    await send("POST", "/v1/review/conversation", { project_id: "project:qa", text: pem }, 201);
    const sources = db.prepare("SELECT * FROM sources").all();
    expect(JSON.stringify(sources)).not.toContain("SYNTHETIC_KEY_BODY");
    expect(JSON.stringify(sources)).not.toContain("unfinished body");
  });

  it("projects only per-node evidence from mixed and legacy shared sources", async () => {
    for (const kind of ["conversation", "legacy"]) {
      const source = createSource(db, { kind, title: "LOCAL_PRIVATE_FRAGMENT", external_id: "LOCAL_PRIVATE_FRAGMENT",
        content_excerpt: "PUBLIC_EVIDENCE LOCAL_PRIVATE_FRAGMENT PROTECTED_FRAGMENT", metadata: { text: "PROTECTED_FRAGMENT" } });
      const visible = memory("PUBLIC_EVIDENCE", { scope: { kind: "global" } });
      const local = memory("LOCAL_PRIVATE_FRAGMENT");
      const protectedNode = memory("PROTECTED_FRAGMENT", { privacy_level: "sensitive" });
      for (const node of [visible, local, protectedNode]) db.prepare("INSERT INTO node_sources VALUES (?, ?, ?, ?)").run(node.id, source.id, node.id === visible.id ? "PUBLIC_EVIDENCE LOCAL_PRIVATE_FRAGMENT PROTECTED_FRAGMENT" : node.content, node.created_at);
      for (const result of [await send("GET", `/v1/memories/${visible.id}/explain`),
        await send("POST", "/v1/recall", { query: "PUBLIC_EVIDENCE", scope: { kind: "global" }, include_sources: true }),
        await send("GET", "/v1/explorer?q=PUBLIC_EVIDENCE")]) {
        const text = JSON.stringify(result); expect(text).toContain("PUBLIC_EVIDENCE");
        expect(text).not.toContain("LOCAL_PRIVATE_FRAGMENT"); expect(text).not.toContain("PROTECTED_FRAGMENT");
      }
    }
  });

  it.each(["legacy", "manual"])("isolates a %s source shared only with a protected foreign profile slot", async (kind) => {
    const quote = "For new projects choose TypeScript";
    const hidden = "PROFILE_PRIVATE_FRAGMENT";
    const source = createSource(db, { kind, title: hidden, external_id: hidden,
      content_excerpt: `${quote}; ${hidden}`, metadata: { text: hidden } });
    const visible = memory("The user prefers TypeScript", { scope: { kind: "global" } });
    db.prepare("INSERT INTO node_sources VALUES (?, ?, ?, ?)").run(visible.id, source.id, quote, visible.created_at);
    await send("POST", "/v1/profile/slots", { topic: "qa", content: hidden,
      knowledge_scope: "project_local", project_id: "project:foreign", privacy_level: "sensitive",
      source_id: source.id, evidence_text: hidden }, 201);
    for (const result of [await send("GET", `/v1/memories/${visible.id}/explain`),
      await send("POST", "/v1/recall", { query: "TypeScript", scope: { kind: "global" }, include_sources: true }),
      await send("GET", "/v1/explorer?q=TypeScript")]) {
      expect(JSON.stringify(result)).toContain(quote);
      expect(JSON.stringify(result)).not.toContain(hidden);
    }
    // Legacy links may also contain the full mixed excerpt rather than a quote.
    db.prepare("UPDATE node_sources SET evidence_text = ? WHERE node_id = ?").run(`${quote}; ${hidden}`, visible.id);
    const mixed = await send("GET", `/v1/memories/${visible.id}/explain`);
    expect(mixed.evidence[0].evidence_text).toBe(visible.content);
    expect(JSON.stringify(mixed)).not.toContain(hidden);
  });

  it("retains a conversation quote that differs from the normalized memory assertion", async () => {
    const quote = "Для новых проектов выбирай TypeScript";
    const node = memory("Пользователь предпочитает TypeScript", { scope: { kind: "global" },
      source: { kind: "conversation", content_excerpt: quote } });
    const explanation = await send("GET", `/v1/memories/${node.id}/explain`);
    expect(explanation.evidence[0].evidence_text).toBe(quote);
    expect(explanation.sources[0].content_excerpt).toBe(quote);
    const recall = await send("POST", "/v1/recall", { query: "TypeScript", scope: { kind: "global" }, include_sources: true });
    expect(recall.results.find((item: { id: string }) => item.id === node.id).sources[0].content_excerpt).toBe(quote);
  });

  it.each([false, true])("forgets manual history of a former slot owner and retains independent replacement history (legacy=%s)", async (legacy) => {
    const m1 = memory("FORMER_OWNER_ORIGINAL", { type: "Preference", metadata: { profile_sub_topic: "manual-history" } });
    const slot = applyMemoryToProfile(db, m1)!;
    await send("PATCH", `/v1/profile/slots/${slot.id}`, { content: "FORMER_OWNER_MANUAL_EDIT" });
    const manual = db.prepare("SELECT memory_id FROM profile_slot_revisions WHERE next_content = ?").get("FORMER_OWNER_MANUAL_EDIT");
    expect(manual).toEqual({ memory_id: m1.id });
    if (legacy) db.prepare("UPDATE profile_slot_revisions SET memory_id = NULL WHERE next_content = ?").run("FORMER_OWNER_MANUAL_EDIT");
    const m2 = memory("Independent replacement original", { type: "Preference", metadata: { profile_sub_topic: "manual-history" } });
    applyMemoryToProfile(db, m2, { force_replace: true });
    await send("PATCH", `/v1/profile/slots/${slot.id}`, { content: "Independent replacement edited" });
    await send("DELETE", `/v1/memories/${m1.id}`);
    const details = await send("GET", `/v1/profile/slots/${slot.id}`);
    expect(JSON.stringify(details)).not.toContain("FORMER_OWNER");
    expect(getProfileSlot(db, slot.id)).toMatchObject({ status: "active", content: "Independent replacement edited" });
    expect(details.revisions).toEqual(expect.arrayContaining([expect.objectContaining({
      previous_content: m2.content, next_content: "Independent replacement edited", memory_id: m2.id
    })]));
  });

  it.each(["secret", "sensitive"] as const)("keeps %s historical memory and slot values private after downgrade", async (privacy_level) => {
    const old = memory("HISTORICAL_PROTECTED_VALUE", { type: "Preference", privacy_level });
    const slot = applyMemoryToProfile(db, old)!;
    await send("PATCH", `/v1/memories/${old.id}`, { content: "Public replacement", privacy_level: "normal" });
    const explanation = await send("GET", `/v1/memories/${old.id}/explain`);
    const profile = await send("GET", `/v1/profile/slots/${slot.id}`);
    expect(JSON.stringify({ explanation, profile })).not.toContain("HISTORICAL_PROTECTED_VALUE");
    expect(explanation.revisions[0].next_content).toBe("Public replacement");
    expect(profile.revisions[0].next_content).toBe("Public replacement");
  });

  it("forgets every merged candidate and its derivatives while preserving independent evidence", async () => {
    const target = memory("Original value");
    const source = createSource(db, { kind: "conversation", content_excerpt: "FORGOTTEN_ONE FORGOTTEN_TWO Independent evidence" });
    const independent = memory("Independent evidence");
    db.prepare("INSERT INTO node_sources VALUES (?, ?, ?, ?)").run(independent.id, source.id, independent.content, independent.created_at);
    for (const content of ["FORGOTTEN_ONE", "FORGOTTEN_TWO"]) {
      const item = candidate(content, { source_id: source.id });
      await send("POST", `/v1/candidates/${item.id}/merge`, { memory_id: target.id });
    }
    const linked = db.prepare("SELECT metadata_json FROM candidates").all();
    expect(linked.every((row) => JSON.parse((row as { metadata_json: string }).metadata_json).approved_memory_id === target.id)).toBe(true);
    await send("DELETE", `/v1/memories/${target.id}`);
    for (const table of ["candidates", "memory_revisions", "sources"]) expect(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())).not.toMatch(/FORGOTTEN_ONE|FORGOTTEN_TWO/);
    expect((await send("GET", "/v1/candidates?status=merged")).candidates).toEqual([]);
    const explain = await send("GET", `/v1/memories/${independent.id}/explain`);
    expect(explain.evidence[0].evidence_text).toBe("Independent evidence");
    expect(listSourcesForNode(db, independent.id)[0].content_excerpt).toBe("Independent evidence");
  });

  it("forget scrubs legacy mixed evidence of surviving independent owners", async () => {
    const forgotten = memory("Forgotten alpha evidence");
    const independent = memory("Independent beta evidence");
    const mixed = `${forgotten.content}; ${independent.content}`;
    const source = createSource(db, { kind: "manual", content_excerpt: mixed });
    for (const node of [forgotten, independent]) db.prepare("INSERT INTO node_sources VALUES (?, ?, ?, ?)").run(node.id, source.id, mixed, node.created_at);
    await send("DELETE", `/v1/memories/${forgotten.id}`);
    const explain = await send("GET", `/v1/memories/${independent.id}/explain`);
    expect(explain.evidence[0].evidence_text).toBe(independent.content);
    expect(explain.sources[0].content_excerpt).toBe(independent.content);
    expect(JSON.stringify(db.prepare("SELECT * FROM node_sources").all())).not.toContain(forgotten.content);
  });

  it.each(["patch", "archive", "delete"])("%s of a previous owner preserves its replacement slot", async (operation) => {
    const m1 = memory("FORMER_OWNER_VALUE", { type: "Preference", metadata: { profile_sub_topic: "same" } });
    const slot = applyMemoryToProfile(db, m1)!;
    const m2 = memory("Current independent owner", { type: "Preference", metadata: { profile_sub_topic: "same" } });
    applyMemoryToProfile(db, m2, { force_replace: true });
    if (operation === "patch") await send("PATCH", `/v1/memories/${m1.id}`, { content: "Changed former owner" });
    if (operation === "archive") await send("POST", `/v1/memories/${m1.id}/archive`);
    if (operation === "delete") await send("DELETE", `/v1/memories/${m1.id}`);
    expect(getProfileSlot(db, slot.id)).toMatchObject({ status: "active", content: m2.content });
    for (const result of [await send("GET", "/v1/profile?project_id=project:qa"),
      await send("POST", "/v1/profile/context", { project_id: "project:qa" }),
      await send("GET", `/v1/profile/slots/${slot.id}`)]) expect(JSON.stringify(result)).toContain(m2.content);
    if (operation === "delete") expect(JSON.stringify(await send("GET", `/v1/profile/slots/${slot.id}`))).not.toContain("FORMER_OWNER_VALUE");
  });

  function conflict(candidateId: string, memoryId: string, id: string) {
    db.prepare("INSERT INTO candidate_conflicts (id,candidate_id,memory_id,status,reason,question,created_at,updated_at) VALUES (?,?,?,'open','Synthetic conflict','Choose',?,?)")
      .run(id, candidateId, memoryId, new Date().toISOString(), new Date().toISOString());
  }
  it("accept_new replaces all conflicting preference projections", async () => {
    const old = ["first", "second"].map((sub) => memory(`Obsolete ${sub}`, { type: "Preference", metadata: { profile_sub_topic: sub } }));
    old.forEach((node) => applyMemoryToProfile(db, node));
    const item = candidate("Accepted replacement", { type: "Preference", status: "blocked" });
    old.forEach((node, i) => conflict(item.id, node.id, `conflict_${i}`));
    await send("POST", "/v1/conflicts/conflict_0/resolve", { action: "accept_new" });
    expect(listProfileSlots(db, { project_id: "project:qa" }).map((slot) => slot.content)).toEqual(["Accepted replacement"]);
    expect(JSON.stringify(await send("POST", "/v1/profile/context", { project_id: "project:qa" }))).not.toContain("Obsolete");
  });

  it("resolves global conflicts across physical projects while forbidding cross-layer and local cross-project links", async () => {
    const old = memory("Global previous", { metadata: { knowledge_scope: "global" } });
    const item = candidate("Global replacement", { scope: { kind: "project", project_id: "project:qa-other" }, status: "blocked", metadata: { knowledge_scope: "global" } });
    conflict(item.id, old.id, "global_conflict");
    const result = await send("POST", "/v1/conflicts/global_conflict/resolve", { action: "accept_new" });
    const next = getMemory(db, result.memory.id);
    const local = memory("Local boundary");
    const otherLocal = memory("Other local boundary", { scope: { kind: "project", project_id: "project:qa-other" } });
    expect(() => createLink(db, { from_id: next.id, to_id: local.id, relation: "SUPERSEDES" })).toThrow();
    expect(() => createLink(db, { from_id: local.id, to_id: otherLocal.id, relation: "SUPERSEDES" })).toThrow();
    expect(() => updateMemory(db, next.id, { confidence: 0.7 })).not.toThrow();
  });

  it.each(["source_id", "memory_id"])("PATCH invalid %s is HTTP 400 and leaves all profile tables unchanged", async (field) => {
    const slot = await send("POST", "/v1/profile/slots", { topic: "qa", content: "Original slot" }, 201);
    const snapshot = () => JSON.stringify(["profile_slots", "profile_slot_revisions", "profile_slot_sources"].map((t) => db.prepare(`SELECT * FROM ${t}`).all()));
    const before = snapshot();
    await send("PATCH", `/v1/profile/slots/${slot.id}`, { content: "Incorrect mutation", [field]: "missing" }, 400);
    expect(snapshot()).toBe(before);
  });

  it("Explorer searches past 200 using public content and source fields, with full scoped counts and literal wildcards", async () => {
    const old = memory("Unique old 100%_marker", { source: { kind: "manual", title: "Unique_source_lookup", content_excerpt: "Unique_excerpt_lookup" } });
    db.prepare("UPDATE nodes SET updated_at = '2000-01-01' WHERE id = ?").run(old.id);
    for (let i = 0; i < 205; i++) memory(`Recent row ${i}`);
    memory("Foreign unique", { scope: { kind: "project", project_id: "project:qa-other" } });
    const hidden = memory("Never_search_hidden", { privacy_level: "secret" });
    for (const q of ["100%_marker", "Unique_source_lookup", "Unique_excerpt_lookup"]) {
      const result = await send("GET", `/v1/explorer?${new URLSearchParams({ q, project_id: "project:qa", limit: "1" })}`);
      expect(result.items).toHaveLength(1); expect(result.counts.memories).toBe(207);
    }
    expect((await send("GET", "/v1/explorer?project_id=project:qa&q=Never_search_hidden")).items).toEqual([]);
    expect((await send("GET", "/v1/explorer?project_id=project:qa&q=100XXmarker")).items).toEqual([]);
    expect((await send("GET", `/v1/memories/${hidden.id}/explain`)).memory.content).toContain("redacted");
  });

  it("preserves the bounded source counter even when a shared source occurs after the first 200 memories", async () => {
    const source = createSource(db, { kind: "conversation", content_excerpt: "Synthetic shared source" });
    for (let i = 0; i < 201; i++) {
      const node = memory(`Shared source row ${i}`);
      db.prepare("INSERT INTO node_sources VALUES (?, ?, ?, ?)").run(node.id, source.id, node.content, node.created_at);
    }
    const response = await send("GET", "/v1/explorer?project_id=project:qa&limit=1");
    expect(response.counts).toMatchObject({ memories: 201, sources: 200 });
  });

  it("CLI approve/reject traverse the real shared client and Fastify, retaining HTTP errors", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No test listener");
    const env = { ...process.env, MEMORY_API_URL: `http://127.0.0.1:${address.port}`, MEMORY_API_KEY: "" };
    for (const action of ["approve", "reject"]) {
      const item = candidate(`CLI synthetic ${action}`);
      const result = await runFile(process.execPath, ["--import", "tsx", "src/cli/memory-cli.ts", action, item.id], { env });
      expect(JSON.parse(result.stdout)).toBeTruthy();
      expect((db.prepare("SELECT status FROM candidates WHERE id = ?").get(item.id) as { status: string }).status).toBe(action === "approve" ? "approved" : "rejected");
    }
    await expect(runFile(process.execPath, ["--import", "tsx", "src/cli/memory-cli.ts", "approve", "missing"], { env })).rejects.toMatchObject({ stderr: expect.stringContaining("not found") });
  }, 15000);

  it.each(["delete", "archive", "content", "sensitive", "secret"])("delayed embedding cannot persist stale vectors after %s", async (operation) => {
    const node = memory("Embedding race original");
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const provider = { id: "mock", model: "delayed", maxBatchSize: 10, dimensions: 2,
      async embed(texts: string[]) { if (calls++ === 0) { started(); await barrier; } return texts.map(() => [1, 0]); } };
    const search = semanticNodeSearch(db, provider, { query: "race", scope: qa, limit: 10 });
    await waiting;
    if (operation === "delete") forgetMemory(db, node.id);
    else if (operation === "archive") archiveMemory(db, node.id);
    else if (operation === "content") updateMemory(db, node.id, { content: "Replacement vector content" });
    else updateMemory(db, node.id, { privacy_level: operation as "sensitive" | "secret" });
    release(); await search;
    expect(db.prepare("SELECT * FROM memory_embeddings WHERE memory_id = ?").all(node.id)).toEqual([]);
  });

  it.each(["layer", "project"])("rejects incompatible %s transfers atomically; explain/graph/recall remain correct", async (change) => {
    const left = memory("Scope transfer anchor"), right = memory("Scope transfer neighbor");
    createLink(db, { from_id: left.id, to_id: right.id, relation: "RELATED_TO" });
    const before = JSON.stringify(getMemory(db, left.id));
    await send("PATCH", `/v1/memories/${left.id}`, change === "layer" ? { metadata: { knowledge_scope: "global" } } : { scope: { kind: "project", project_id: "project:qa-other" } }, 400);
    expect(JSON.stringify(getMemory(db, left.id))).toBe(before);
    expect(db.prepare("SELECT * FROM memory_revisions WHERE memory_id = ?").all(left.id)).toEqual([]);
    expect((await send("GET", `/v1/memories/${left.id}/explain`)).links.outgoing).toHaveLength(1);
    expect((await send("GET", "/v1/graph?project_id=project:qa")).edges).toHaveLength(1);
    expect((await send("POST", "/v1/recall", { query: "transfer", scope: qa })).results.map((r: { id: string }) => r.id)).toContain(left.id);
    expect((await send("POST", "/v1/recall", { query: "transfer", scope: { kind: "project", project_id: "project:qa-other" } })).results).toEqual([]);
  });
});

describe("rollback-compatible additive migration", () => {
  it("upgrades populated v5 data without row loss, conservatively protects legacy history and reopens with unchanged previous loader", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memaskus-rollback-"));
    const file = path.join(directory, "legacy.sqlite");
    try {
      const previous = previousOpenDatabase(file);
      const now = new Date().toISOString();
      previous.prepare(`INSERT INTO nodes (id,type,content,scope_kind,confidence,status,privacy_level,metadata_json,created_at,updated_at)
        VALUES ('legacy','Fact','Legacy value','global',0.8,'active','normal','{}',?,?)`).run(now, now);
      previous.prepare(`INSERT INTO memory_revisions (id,memory_id,previous_content,next_content,next_scope_json,created_at)
        VALUES ('legacy_revision','legacy','Legacy private history','Legacy value','{"kind":"global"}',?)`).run(now);
      const counts = previous.prepare("SELECT count(*) AS count FROM nodes").get(); previous.close();
      const upgraded = openDatabase(file);
      expect(upgraded.prepare("SELECT count(*) AS count FROM nodes").get()).toEqual(counts);
      expect(upgraded.prepare("SELECT previous_privacy_level,next_privacy_level FROM memory_revisions").get()).toEqual({ previous_privacy_level: "secret", next_privacy_level: "secret" });
      expect(upgraded.pragma("user_version", { simple: true })).toBe(5);
      expect(upgraded.prepare("SELECT version FROM schema_migrations WHERE version = 6").get()).toBeTruthy();
      upgraded.close();
      const rollback = previousOpenDatabase(file);
      expect(rollback.prepare("SELECT content FROM nodes WHERE id='legacy'").get()).toEqual({ content: "Legacy value" });
      expect(rollback.prepare("SELECT count(*) AS count FROM memory_revisions").get()).toEqual({ count: 1 });
      rollback.close();
      const reopened = openDatabase(file); reopened.close();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
