import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MemoryDb } from "../db/connection.js";
import { listCandidatesByStatuses } from "../domain/candidates.js";
import { listMemories } from "../domain/memory-lifecycle.js";
import {
  publicCandidate,
  publicConflict,
  publicMemory,
  publicProfileSlot,
  redactSourcesForMemory
} from "../domain/privacy.js";
import { listProfileSlots } from "../domain/profile.js";
import { listConflicts } from "../domain/review.js";
import { scopeVisibleFrom } from "../domain/scope.js";
import { listSourcesForNode } from "../domain/sources.js";
import type { Scope } from "../domain/types.js";

const querySchema = z.object({
  q: z.string().optional(),
  project_id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
});

function matches(query: string, ...values: unknown[]): boolean {
  if (!query) {
    return true;
  }
  return values.some((value) => String(value ?? "").toLowerCase().includes(query));
}

export async function registerExplorerRoutes(app: FastifyInstance, db: MemoryDb): Promise<void> {
  app.get("/v1/explorer", async (request) => {
    const input = querySchema.parse(request.query);
    const query = input.q?.trim().toLowerCase() ?? "";
    const limit = input.limit ?? 100;
    const scope: Scope = input.project_id
      ? { kind: "project", project_id: input.project_id }
      : { kind: "global" };

    const memories = listMemories(db, { scope, status: "active", limit: 200 }).memories.map(publicMemory);
    const candidates = listCandidatesByStatuses(db, ["pending", "blocked"])
      .filter((candidate) => scopeVisibleFrom(candidate.scope, scope))
      .map(publicCandidate);
    const conflicts = [...listConflicts(db, "open"), ...listConflicts(db, "resolved")]
      .filter((conflict) => !conflict.candidate || scopeVisibleFrom(conflict.candidate.scope, scope))
      .map(publicConflict);
    const profiles = listProfileSlots(db, { project_id: input.project_id }).map(publicProfileSlot);

    const sourceItems = memories.flatMap((memory) =>
      redactSourcesForMemory(memory, listSourcesForNode(db, memory.id)).map((source) => ({
        kind: "source" as const,
        id: source.id,
        title: source.title ?? source.external_id ?? source.kind,
        content: source.content_excerpt ?? "",
        status: source.kind,
        updated_at: source.created_at,
        data: source
      }))
    );

    const items = [
      ...memories.map((memory) => ({
        kind: "memory" as const,
        id: memory.id,
        title: memory.type,
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
      .filter((item) => matches(query, item.id, item.kind, item.title, item.content, item.status))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .slice(0, limit);

    return {
      items,
      counts: {
        memories: memories.length,
        profiles: profiles.length,
        candidates: candidates.length,
        conflicts: conflicts.length,
        sources: sourceItems.length
      }
    };
  });
}
