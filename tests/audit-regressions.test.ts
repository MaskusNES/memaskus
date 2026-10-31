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

  it.each(["sensitive", "secret"] as const)("drops inherited protected metadata but accepts new public metadata (%s)", async (privacy_level) => {
    const hidden = "OLD_PROTECTED_METADATA_TEXT";
    const node = await send("POST", "/v1/memories", { type: "Preference", content: hidden, scope: qa,
      privacy_level, metadata: { disagreement_text: hidden, nested: { text: hidden } } }, 201);
    const projected = listProfileSlots(db, { project_id: qa.project_id, knowledge_scope: "project_local" })[0];
    const standalone = await send("POST", "/v1/profile/slots", { topic: "standalone", content: hidden,
      privacy_level, knowledge_scope: "project_local", project_id: qa.project_id,
      metadata: { disagreement_text: hidden, nested: [hidden] } }, 201);
    for (const [url, supplied] of [[`/v1/memories/${node.id}`, undefined],
      [`/v1/profile/slots/${standalone.id}`, { disagreement_text: "New permitted metadata" }]] as const) {
      const response = await send("PATCH", url, { content: "New public value", privacy_level: "normal", ...(supplied ? { metadata: supplied } : {}) });
      expect(JSON.stringify(response)).not.toContain(hidden);
    }
    const details = await send("GET", `/v1/profile/slots/${standalone.id}`);
    expect(details.slot.metadata.disagreement_text).toBe("New permitted metadata");
    expect(getProfileSlot(db, projected.id).metadata.source_memory_id).toBe(node.id);
    for (const result of [await send("GET", `/v1/memories/${node.id}/explain`),
      await send("GET", `/v1/profile/slots/${projected.id}`), details,
      await send("GET", "/v1/profile?project_id=project:qa"),
      await send("POST", "/v1/profile/context", { project_id: qa.project_id })]) {
      expect(JSON.stringify(result)).not.toContain(hidden);
    }
  });

  it.each(["sensitive", "secret"] as const)("reclassifies historical copies without losing rows (%s)", async (privacy_level) => {
    const hidden = "RECLASSIFIED_ORIGINAL_VALUE";
    const node = await send("POST", "/v1/memories", { type: "Preference", content: hidden, scope: qa }, 201);
    const projected = listProfileSlots(db, { project_id: qa.project_id, knowledge_scope: "project_local" })[0];
    const standalone = await send("POST", "/v1/profile/slots", { topic: "history", content: hidden,
      knowledge_scope: "project_local", project_id: qa.project_id }, 201);
    // Create earlier normal revisions containing the value on both sides.
    await send("PATCH", `/v1/memories/${node.id}`, { confidence: 0.85 });
    await send("PATCH", `/v1/profile/slots/${standalone.id}`, { reason: "Record evidence" });
    const snapshot = (table: string) => db.prepare(`SELECT id FROM ${table} ORDER BY id`).all();
    const before = [snapshot("memory_revisions"), snapshot("profile_slot_revisions")];
    for (const url of [`/v1/memories/${node.id}`, `/v1/profile/slots/${standalone.id}`]) {
      await send("PATCH", url, { privacy_level });
      await send("PATCH", url, { content: "PUBLIC_REPLACEMENT_VALUE", privacy_level: "normal" });
    }
    for (const [index, table] of ["memory_revisions", "profile_slot_revisions"].entries()) {
      expect(snapshot(table)).toEqual(expect.arrayContaining(before[index]));
      const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
      for (const row of rows) for (const side of ["previous", "next"]) {
        if (row[`${side}_content`] === hidden) expect(row[`${side}_privacy_level`]).toBe(privacy_level);
      }
    }
    for (const result of [await send("GET", `/v1/memories/${node.id}/explain`),
      await send("GET", `/v1/profile/slots/${projected.id}`),
      await send("GET", `/v1/profile/slots/${standalone.id}`),
      await send("GET", "/v1/profile?project_id=project:qa"),
      await send("POST", "/v1/profile/context", { project_id: qa.project_id })]) {
      expect(JSON.stringify(result)).not.toContain(hidden);
    }
  });

  it("never weakens secret historical classifications during later sensitive reclassification", async () => {
    const node = await send("POST", "/v1/memories", { type: "Preference", content: "Same protected value", scope: qa }, 201);
    const standalone = await send("POST", "/v1/profile/slots", { topic: "stronger-history", content: "Same protected value" }, 201);
    for (const url of [`/v1/memories/${node.id}`, `/v1/profile/slots/${standalone.id}`]) {
      await send("PATCH", url, { privacy_level: "secret", reason: "Classify" });
      await send("PATCH", url, { privacy_level: "normal", reason: "Temporarily public" });
    }
    const snapshots = ["memory_revisions", "profile_slot_revisions"].map((table) =>
      db.prepare(`SELECT id, previous_privacy_level, next_privacy_level FROM ${table}`).all() as Array<Record<string, string>>);
    await send("PATCH", `/v1/memories/${node.id}`, { privacy_level: "sensitive" });
    await send("PATCH", `/v1/profile/slots/${standalone.id}`, { privacy_level: "sensitive" });
    for (const [index, table] of ["memory_revisions", "profile_slot_revisions"].entries()) {
      for (const row of snapshots[index]) {
        const current = db.prepare(`SELECT previous_privacy_level, next_privacy_level FROM ${table} WHERE id = ?`).get(row.id) as Record<string, string>;
        for (const side of ["previous_privacy_level", "next_privacy_level"]) if (row[side] === "secret") expect(current[side]).toBe("secret");
      }
    }
  });

  it("does not treat user-supplied originating candidate metadata as evidence provenance", async () => {
    const hidden = "LEGACY_AMBIGUOUS_QUOTE";
    const source = createSource(db, { kind: "conversation", content_excerpt: hidden });
    const origin = candidate("Normalized public assertion", { source_id: source.id, status: "approved", scope: { kind: "global" } });
    const node = memory(origin.content, { scope: { kind: "global" }, metadata: { approved_from_candidate_id: origin.id, evidence_verified: true } });
    db.prepare("INSERT INTO node_sources VALUES (?, ?, ?, ?)").run(node.id, source.id, hidden, node.created_at);
    expect((await send("GET", `/v1/memories/${node.id}/explain`)).evidence[0].evidence_text).toBe(node.content);
    expect(JSON.stringify(await send("GET", `/v1/memories/${node.id}/explain`))).not.toContain(hidden);
  });

  it.each(["Fact", "Preference"])("retains engine-bound distinct quotes on a mixed source for %s", async (type) => {
    const quote = "UniquePermittedQuote for TypeScript projects";
    const hidden = "FOREIGN_PROTECTED_TRANSCRIPT";
    const node = await send("POST", "/v1/memories", { type, content: "The user chooses TypeScript", scope: { kind: "global" },
      source: { kind: "conversation", content_excerpt: quote } }, 201);
    const source = db.prepare("SELECT source_id FROM node_sources WHERE node_id = ?").get(node.id) as { source_id: string };
    const foreign = memory(hidden, { privacy_level: "secret", scope: { kind: "project", project_id: "project:foreign" } });
    db.prepare("INSERT INTO node_sources VALUES (?, ?, ?, ?)").run(foreign.id, source.source_id, hidden, foreign.created_at);
    db.prepare("UPDATE sources SET content_excerpt = ?, title = ?, metadata_json = ? WHERE id = ?")
      .run(`${quote}; ${hidden}`, hidden, JSON.stringify({ text: hidden }), source.source_id);
    const explanation = await send("GET", `/v1/memories/${node.id}/explain`);
    expect(explanation.evidence[0].evidence_text).toBe(quote);
    expect(explanation.sources[0].content_excerpt).toBe(quote);
    const recalled = await send("POST", "/v1/recall", { query: "TypeScript", scope: { kind: "global" }, include_sources: true });
    expect(recalled.results.find((r: { id: string }) => r.id === node.id).sources[0].content_excerpt).toBe(quote);
    const explorer = await send("GET", "/v1/explorer?q=UniquePermittedQuote");
    expect(explorer.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "source", content: quote })]));
    expect(JSON.stringify([explanation, recalled, explorer])).not.toContain(hidden);
    // User metadata cannot attest altered legacy evidence, even if it embeds provenance-shaped fields.
    db.prepare("UPDATE node_sources SET evidence_text = ? WHERE node_id = ?").run(`${quote}; ${hidden}`, node.id);
    await send("PATCH", `/v1/memories/${node.id}`, { metadata: { evidence_verified: true, evidence_digest: "forged" } });
    expect(JSON.stringify(await send("GET", `/v1/memories/${node.id}/explain`))).not.toContain(hidden);
    expect(db.prepare("SELECT evidence_text FROM node_sources WHERE node_id = ?").get(node.id)).toEqual({ evidence_text: `${quote}; ${hidden}` });
  });

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

  it.each([true, false])("redacts PEM before splitting unlabelled review text (closed=%s)", async (closed) => {
    const result = await send("POST", "/v1/review/conversation", {
      project_id: "project:qa", analysis_mode: "heuristic",
      text: `No, keep the existing approach.\n-----BEGIN PRIVATE KEY-----\nNo, SYNTHETIC_PEM_BODY\n${closed ? "-----END PRIVATE KEY-----" : "UNFINISHED_PEM_BODY"}`
    }, 201);
    expect(result.preference_review.disagreements).toHaveLength(1);
    expect(result.preference_review.disagreements[0].user_text).toBe("No, keep the existing approach.");
    expect(result.preference_review.clarification_questions).toHaveLength(1);
    const response = JSON.stringify(result);
    const persisted = db.serialize().toString("utf8");
    expect(persisted).toContain("No, keep the existing approach.");
    for (const fragment of ["SYNTHETIC_PEM_BODY", "UNFINISHED_PEM_BODY", "-----BEGIN", "-----END"]) {
      expect(response).not.toContain(fragment);
      expect(persisted).not.toContain(fragment);
    }
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

  it.each([
    '"password": "synthetic12345678"',
    'api_key=synthetic12345678',
    '-----BEGIN PRIVATE KEY-----\nSYNTHETIC_KEY_BODY\n-----END PRIVATE KEY-----',
    '-----BEGIN PRIVATE KEY-----\nSYNTHETIC_KEY_BODY\nunfinished body'
  ])("redacts the entire review response after disagreement containing %s", async (secret) => {
    const result = await send("POST", "/v1/review/conversation", {
      project_id: "project:qa", analysis_mode: "heuristic",
      text: `assistant: Try this approach.\nuser: No, this is wrong. ${secret}`
    }, 201);
    expect(result.preference_review.disagreements).toHaveLength(1);
    expect(result.preference_review.clarification_questions).toHaveLength(1);
    expect(result.preference_review.clarification_questions[0]).toContain("[redacted: credential]");
    const serialized = JSON.stringify(result);
    for (const fragment of ["synthetic12345678", "SYNTHETIC_KEY_BODY", "unfinished body", "-----BEGIN", "-----END"]) {
      expect(serialized).not.toContain(fragment);
    }
  });

  it.each([{ kind: "global" as const }, qa])("retains normal Preference source fields through its own projection in %j", async (scope) => {
    const title = "UniquePreferenceSourceTitle";
    const quote = "UniquePreferenceQuote: for new projects choose TypeScript";
    const node = await send("POST", "/v1/memories", { type: "Preference", content: "The user prefers TypeScript",
      scope, source: { kind: "manual", title, content_excerpt: quote } }, 201);
    const explanation = await send("GET", `/v1/memories/${node.id}/explain`);
    expect(explanation.sources[0]).toMatchObject({ title, content_excerpt: quote });
    expect(explanation.evidence[0].evidence_text).toBe(quote);
    const recall = await send("POST", "/v1/recall", { query: "TypeScript", scope, include_sources: true });
    expect(recall.results.find((item: { id: string }) => item.id === node.id).sources[0]).toMatchObject({ title, content_excerpt: quote });
    for (const q of [title, "UniquePreferenceQuote"]) {
      const result = await send("GET", `/v1/explorer?${new URLSearchParams({ q, ...(scope.kind === "project" ? { project_id: scope.project_id } : {}) })}`);
      expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({
        kind: "source", id: explanation.sources[0].id, title, content: quote
      })]));
    }
  });

  it("recognizes an approved originating candidate and its own profile projection", async () => {
    const source = createSource(db, { kind: "manual", title: "ApprovedSourceTitle", content_excerpt: "Approved differing quote" });
    const item = candidate("The user prefers TypeScript", { type: "Preference", source_id: source.id });
    const node = await send("POST", `/v1/candidates/${item.id}/approve`, {}, 201);
    const explanation = await send("GET", `/v1/memories/${node.id}/explain`);
    expect(explanation.sources[0]).toMatchObject({ title: source.title, content_excerpt: source.content_excerpt });
    const recall = await send("POST", "/v1/recall", { query: "TypeScript", scope: qa, include_sources: true });
    expect(recall.results.find((result: { id: string }) => result.id === node.id).sources[0].title).toBe(source.title);
  });

  it.each(["independent candidate", "candidate privacy", "candidate layer", "candidate scope", "slot provenance", "slot privacy", "slot layer", "slot scope", "slot history"])(
    "keeps source protection for %s despite originating links", async (owner) => {
      const hidden = "ProtectedSourceFragment";
      const source = createSource(db, { kind: "manual", title: hidden, content_excerpt: hidden });
      const item = candidate("The user prefers TypeScript", { type: "Preference", source_id: source.id });
      const node = await send("POST", `/v1/candidates/${item.id}/approve`, {}, 201);
      const slot = listProfileSlots(db, { knowledge_scope: "project_local", project_id: "project:qa" })[0];
      if (owner === "independent candidate") candidate("Independent assertion", { source_id: source.id });
      if (owner === "candidate privacy") db.prepare("UPDATE candidates SET privacy_level = 'sensitive' WHERE id = ?").run(item.id);
      if (owner === "candidate layer") db.prepare("UPDATE candidates SET knowledge_scope = 'global' WHERE id = ?").run(item.id);
      if (owner === "candidate scope") db.prepare("UPDATE candidates SET scope_project_id = 'project:foreign' WHERE id = ?").run(item.id);
      if (owner === "slot provenance") db.prepare("UPDATE profile_slots SET metadata_json = '{}' WHERE id = ?").run(slot.id);
      if (owner === "slot privacy") db.prepare("UPDATE profile_slots SET privacy_level = 'sensitive' WHERE id = ?").run(slot.id);
      if (owner === "slot layer") db.prepare("UPDATE profile_slots SET knowledge_scope = 'global' WHERE id = ?").run(slot.id);
      if (owner === "slot scope") db.prepare("UPDATE profile_slots SET scope_project_id = 'project:foreign' WHERE id = ?").run(slot.id);
      if (owner === "slot history") db.prepare("UPDATE profile_slot_revisions SET previous_privacy_level = 'secret' WHERE slot_id = ?").run(slot.id);
      for (const response of [await send("GET", `/v1/memories/${node.id}/explain`),
        await send("POST", "/v1/recall", { query: "TypeScript", scope: qa, include_sources: true })]) {
        expect(JSON.stringify(response)).not.toContain(hidden);
      }
      expect((await send("GET", `/v1/explorer?project_id=project:qa&q=${hidden}`)).items).toEqual([]);
    }
  );

  it.each(["legacy", "manual"])("conservatively projects a %s source shared only with a protected foreign profile slot", async (kind) => {
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
      expect(JSON.stringify(result)).toContain(visible.content);
      expect(JSON.stringify(result)).not.toContain(hidden);
    }
    // Legacy links may also contain the full mixed excerpt rather than a quote.
    db.prepare("UPDATE node_sources SET evidence_text = ? WHERE node_id = ?").run(`${quote}; ${hidden}`, visible.id);
    const mixed = await send("GET", `/v1/memories/${visible.id}/explain`);
    expect(mixed.evidence[0].evidence_text).toBe(visible.content);
    expect(JSON.stringify(mixed)).not.toContain(hidden);
  });

  it.each([null, "A separate normalized evidence summary"])("isolates paraphrased shared evidence with foreign evidence=%s", async (foreignEvidence) => {
    const localQuote = "Deploy the unreleased orchard service on the private cedar host";
    const protectedQuote = "My health appointment is scheduled for next Thursday";
    const visible = memory("PUBLIC_PARAPHRASE_EVIDENCE", { scope: { kind: "global" } });
    const local = memory("The orchard project uses cedar infrastructure", {
      scope: { kind: "project", project_id: "project:foreign" }
    });
    const protectedNode = memory("The user has a medical visit next week", {
      scope: { kind: "global" }, privacy_level: "sensitive"
    });
    const mixed = `${visible.content}; ${localQuote}; ${protectedQuote}`;
    const source = createSource(db, { kind: "legacy", content_excerpt: mixed });
    for (const node of [visible, local, protectedNode]) {
      db.prepare("INSERT INTO node_sources VALUES (?, ?, ?, ?)")
        .run(node.id, source.id, node.id === visible.id ? mixed : foreignEvidence, node.created_at);
    }
    for (const result of [await send("GET", `/v1/memories/${visible.id}/explain`),
      await send("POST", "/v1/recall", { query: visible.content, scope: { kind: "global" }, include_sources: true }),
      await send("GET", `/v1/explorer?q=${visible.content}`)]) {
      const serialized = JSON.stringify(result);
      expect(serialized).toContain(visible.content);
      expect(serialized).not.toContain(localQuote);
      expect(serialized).not.toContain(protectedQuote);
    }
    const explanation = await send("GET", `/v1/memories/${visible.id}/explain`);
    expect(explanation.evidence[0].evidence_text).toBe(visible.content);
    expect(explanation.sources[0].content_excerpt).toBe(visible.content);
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

  it("forgetting a rejected projection author preserves the replacement owner's history and evidence", async () => {
    const metadata = { profile_sub_topic: "rejected-owner" };
    const m1 = memory("FORMER_REJECTED_VALUE", { type: "Preference", confidence: 0.6, metadata,
      source: { kind: "manual", content_excerpt: "FORMER_REJECTED_VALUE" } });
    const slot = applyMemoryToProfile(db, m1)!;
    const m2 = memory("Independent replacement value", { type: "Preference", confidence: 0.95, metadata,
      source: { kind: "manual", content_excerpt: "Independent replacement evidence" } });
    applyMemoryToProfile(db, m2);
    applyMemoryToProfile(db, m1);
    expect(getProfileSlot(db, slot.id)).toMatchObject({ content: m2.content, metadata: { source_memory_id: m2.id } });
    const latest = db.prepare("SELECT memory_id, previous_content, next_content FROM profile_slot_revisions WHERE slot_id = ? ORDER BY rowid DESC LIMIT 1").get(slot.id);
    expect(latest).toEqual({ memory_id: m2.id, previous_content: m2.content, next_content: m2.content });
    const replacementSource = listSourcesForNode(db, m2.id)[0];
    await send("DELETE", `/v1/memories/${m1.id}`);
    const details = await send("GET", `/v1/profile/slots/${slot.id}`);
    expect(getProfileSlot(db, slot.id)).toMatchObject({ status: "active", content: m2.content, metadata: { source_memory_id: m2.id } });
    expect(details.revisions).toEqual(expect.arrayContaining([expect.objectContaining({
      memory_id: m2.id, previous_content: m2.content, next_content: m2.content
    })]));
    expect(JSON.stringify(details)).not.toContain(m1.content);
    expect(db.prepare("SELECT evidence_text FROM profile_slot_sources WHERE slot_id = ? AND source_id = ?").get(slot.id, replacementSource.id))
      .toEqual({ evidence_text: m2.content });
    const explanation = await send("GET", `/v1/memories/${m2.id}/explain`);
    // The surviving quote now has engine-bound provenance and remains permitted.
    expect(explanation.evidence[0].evidence_text).toBe("Independent replacement evidence");
    expect(JSON.stringify(explanation)).not.toContain(m1.content);
    expect(db.prepare("SELECT evidence_text FROM node_sources WHERE node_id = ? AND source_id = ?").get(m2.id, replacementSource.id))
      .toEqual({ evidence_text: "Independent replacement evidence" });
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
      const bound = createMemory(upgraded, { type: "Fact", content: "New bound value", source: { kind: "manual", content_excerpt: "Bound quote" } });
      expect(upgraded.prepare("SELECT count(*) AS count FROM node_source_provenance").get()).toEqual({ count: 1 });
      expect(upgraded.prepare("SELECT version FROM schema_migrations WHERE version = 7").get()).toBeTruthy();
      upgraded.close();
      const rollback = previousOpenDatabase(file);
      expect(rollback.prepare("SELECT content FROM nodes WHERE id='legacy'").get()).toEqual({ content: "Legacy value" });
      expect(rollback.prepare("SELECT count(*) AS count FROM memory_revisions").get()).toEqual({ count: 1 });
      expect(rollback.prepare("SELECT evidence_text FROM node_sources WHERE node_id = ?").get(bound.id)).toEqual({ evidence_text: "Bound quote" });
      rollback.close();
      const reopened = openDatabase(file); reopened.close();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
