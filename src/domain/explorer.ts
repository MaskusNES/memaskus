import type { MemoryDb } from "../db/connection.js";
import { listCandidatesByStatuses } from "./candidates.js";
import { mapNode } from "./mappers.js";
import {
  publicCandidate,
  publicConflict,
  publicMemory,
  publicProfileSlot,
  redactSourcesForMemory
} from "./privacy.js";
import { listProfileSlots } from "./profile.js";
import { listConflicts } from "./review.js";
import { scopeSqlParts, scopeVisibleFrom } from "./scope.js";
import { listSourcesForNode } from "./sources.js";
import type { Scope, Source } from "./types.js";

function matches(query: string, ...values: unknown[]): boolean {
  if (!query) {
    return true;
  }
  return values.some((value) => String(value ?? "").toLowerCase().includes(query));
}

export function exploreMemory(db: MemoryDb, input: { q?: string; project_id?: string; limit?: number }) {
  const query = input.q?.trim().toLowerCase() ?? "";
  const limit = input.limit ?? 100;
  const scope: Scope = input.project_id
    ? { kind: "project", project_id: input.project_id }
    : { kind: "global" };

  const visibility = scopeSqlParts(scope);
  const where = `status = 'active' AND ${visibility.clause}`;
  const total = db.prepare(`SELECT COUNT(*) AS count FROM nodes WHERE ${where}`)
    .get(...visibility.params) as { count: number };
  // Keep the browsing window, but search every visible active memory and source.
  // Match only public projections below: raw SQL text matching would leak hidden content.
  const memories = db.prepare(`SELECT * FROM nodes WHERE ${where} ORDER BY updated_at DESC LIMIT ?`)
    .all(...visibility.params, query ? -1 : 200)
    .map((row) => publicMemory(mapNode(row as never)));
  const candidates = listCandidatesByStatuses(db, ["pending", "blocked"])
    .filter((candidate) => scopeVisibleFrom(candidate.scope, scope))
    .map(publicCandidate);
  const conflicts = [...listConflicts(db, "open"), ...listConflicts(db, "resolved")]
    .filter((conflict) => !conflict.candidate || scopeVisibleFrom(conflict.candidate.scope, scope))
    .map(publicConflict);
  const profiles = listProfileSlots(db, { project_id: input.project_id }).map(publicProfileSlot);

  const sources = new Map<string, Source>();
  for (const memory of memories) {
    for (const source of redactSourcesForMemory(memory, listSourcesForNode(db, memory.id))) {
      // A shared source is one item. Preserve its public projection when any
      // visible parent permits it, regardless of parent ordering.
      if (!sources.has(source.id) || memory.privacy_level === "normal") {
        sources.set(source.id, source);
      }
    }
  }
  const sourceItems = [...sources.values()].map((source) => ({
      kind: "source" as const,
      id: source.id,
      title: source.title ?? source.external_id ?? source.kind,
      content: source.content_excerpt ?? "",
      status: source.kind,
      updated_at: source.created_at,
      data: source
    }));

  const items = [
    ...memories.map((memory) => ({
      kind: "memory" as const,
      id: memory.id,
      title: typeof memory.metadata.title === "string" && memory.metadata.title ? memory.metadata.title : memory.type,
      content: memory.content,
      status: memory.status,
      updated_at: memory.updated_at,
      data: memory
    })),
    ...profiles.map((slot) => ({
      kind: "profile" as const,
      id: slot.id,
      title: `${slot.topic}/${slot.sub_topic}`,
      content: slot.content,
      status: slot.status,
      updated_at: slot.updated_at,
      data: slot
    })),
    ...candidates.map((candidate) => ({
      kind: "candidate" as const,
      id: candidate.id,
      title: candidate.type,
      content: candidate.content,
      status: candidate.status,
      updated_at: candidate.updated_at,
      data: candidate
    })),
    ...conflicts.map((conflict) => ({
      kind: "conflict" as const,
      id: conflict.id,
      title: "Memory conflict",
      content: `${conflict.memory?.content ?? ""} ↔ ${conflict.candidate?.content ?? ""}`,
      status: conflict.status,
      updated_at: conflict.updated_at,
      data: conflict
    })),
    ...sourceItems
  ]
    .filter((item) => matches(query, item.id, item.kind, item.title, item.content, item.status,
      item.kind === "memory" ? item.data.type : undefined))
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
    .slice(0, limit);

  return {
    items,
    counts: {
      memories: total.count,
      profiles: profiles.length,
      candidates: candidates.length,
      conflicts: conflicts.length,
      sources: sourceItems.length
    }
  };
}
