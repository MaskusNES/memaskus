import type { MemoryDb } from "../db/connection.js";
import { NotFoundError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { nowIso } from "../shared/time.js";
import { createLink, knowledgeScope, metadataKnowledgeScope } from "./links.js";
import { mapNode } from "./mappers.js";
import { upsertProfileSlot } from "./profile.js";
import { assertSafeForStorage } from "./privacy.js";
import { scopeVisibleFrom } from "./scope.js";
import { reviewPreferenceSignalsFromConversation } from "./preference-review.js";
import {
  approveCandidate,
  approveCandidateAfterConflictResolution,
  createConversationSource,
  getCandidate,
  ingestConversation,
  updateCandidateStatus,
  type Candidate,
  type IngestConversationInput
} from "./candidates.js";
import type { MemoryNode, Scope } from "./types.js";
import type { KnowledgeScope, PrivacyLevel, ProfileSlot } from "./types.js";

export type ReviewConversationInput = IngestConversationInput & {
  analysis_mode?: "heuristic" | "agent_supplied";
  agent_analysis?: {
    profile_updates?: Array<{
      user_id?: string;
      topic: string;
      sub_topic?: string;
      content: string;
      confidence?: number;
      knowledge_scope?: KnowledgeScope;
      project_id?: string;
      privacy_level?: PrivacyLevel;
      metadata?: Record<string, unknown>;
      evidence_text?: string;
      reason?: string;
    }>;
    disagreements?: Array<{
      user_text: string;
      assistant_context?: string;
      reason_is_clear: boolean;
      inferred_reason?: string;
      demonstrated_preferences?: Array<
        string | { content: string; confidence?: number; knowledge_scope?: "global" | "project_local"; metadata?: Record<string, unknown> }
      >;
      demonstrated_values?: string[];
      confidence?: number;
      clarification_question?: string;
    }>;
  };
};

export type MemoryConflict = {
  id: string;
  candidate_id: string;
  memory_id: string;
  status: "open" | "resolved";
  reason: string;
  question: string;
  resolution?: string | null;
  created_at: string;
  updated_at: string;
  candidate?: Candidate;
  memory?: MemoryNode;
};

type ConflictRow = {
  id: string;
  candidate_id: string;
  memory_id: string;
  status: "open" | "resolved";
  reason: string;
  question: string;
  resolution: string | null;
  created_at: string;
  updated_at: string;
};

const exclusiveGroups = [
  ["sqlite", "postgres", "postgresql", "neo4j", "kuzudb", "surrealdb", "lancedb"],
  ["fastify", "express", "hono", "koa"],
  ["typescript", "python", "go", "rust"],
  ["manual", "automatic", "autonomous"],
  ["local-first", "server-first"]
];

const overlapStopwords = new Set([
  "about",
  "agent",
  "agents",
  "and",
  "for",
  "into",
  "memory",
  "prefers",
  "preference",
  "the",
  "user",
  "users",
  "when",
  "with"
]);

function mapConflict(row: ConflictRow, candidate?: Candidate, memory?: MemoryNode): MemoryConflict {
  return {
    id: row.id,
    candidate_id: row.candidate_id,
    memory_id: row.memory_id,
    status: row.status,
    reason: row.reason,
    question: row.question,
    resolution: row.resolution,
    created_at: row.created_at,
    updated_at: row.updated_at,
    candidate,
    memory
  };
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}:_-]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length > 2 && !overlapStopwords.has(token))
  );
}

function overlapScore(left: string, right: string): number {
  const leftTokens = tokenize(left);
  if (leftTokens.size === 0) {
    return 0;
  }

  const rightTokens = tokenize(right);
  let matches = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      matches += 1;
    }
  }
  return matches / leftTokens.size;
}

function scopeMatches(memory: MemoryNode, scope: Scope): boolean {
  return scopeVisibleFrom(memory.scope, scope);
}

function groupTerms(text: string, group: string[]): Set<string> {
  const tokens = tokenize(text);
  return new Set(group.filter((term) => tokens.has(term)));
}

function exclusiveTermConflict(left: string, right: string): string | null {
  for (const group of exclusiveGroups) {
    const leftTerms = groupTerms(left, group);
    const rightTerms = groupTerms(right, group);
    const different = [...leftTerms].filter((term) => !rightTerms.has(term));
    const reverseDifferent = [...rightTerms].filter((term) => !leftTerms.has(term));
    if (different.length > 0 && reverseDifferent.length > 0) {
      return `разные взаимоисключающие термины: ${different.join(", ")} vs ${reverseDifferent.join(", ")}`;
    }
  }

  return null;
}

function hasNegation(text: string): boolean {
  return /\b(not|never|no|without|instead of)\b|не |никогда|без |вместо/iu.test(text);
}

function negationConflictThreshold(candidate: Candidate, memory: MemoryNode): number {
  if (candidate.type === "Preference" && memory.type === "Preference") {
    return 0.5;
  }

  return 0.28;
}

export function contradictionReason(candidate: Candidate, memory: MemoryNode): string | null {
  const contentOverlap = overlapScore(candidate.content, memory.content);
  const reverseOverlap = overlapScore(memory.content, candidate.content);
  const overlap = Math.max(contentOverlap, reverseOverlap);

  if (candidate.type === memory.type || ["Fact", "Decision", "Preference"].includes(candidate.type)) {
    const termConflict = exclusiveTermConflict(candidate.content, memory.content);
    if (termConflict && overlap >= 0.12) {
      return termConflict;
    }

    if (
      hasNegation(candidate.content) !== hasNegation(memory.content) &&
      overlap >= negationConflictThreshold(candidate, memory)
    ) {
      return "одно утверждение отрицает близко связанную существующую запись памяти";
    }
  }

  return null;
}

export function findRelevantMemories(db: MemoryDb, candidate: Candidate): MemoryNode[] {
  const candidateKnowledgeScope = metadataKnowledgeScope(candidate.metadata, candidate.scope);
  const rows = db
    .prepare("SELECT * FROM nodes WHERE status = 'active' AND knowledge_scope = ?")
    .all(candidateKnowledgeScope);
  return rows
    .map((row) => mapNode(row as never))
    .filter((memory) => candidateKnowledgeScope === "global" || scopeMatches(memory, candidate.scope))
    .filter((memory) => knowledgeScope(memory) === candidateKnowledgeScope)
    .map((memory) => ({
      memory,
      score: Math.max(overlapScore(candidate.content, memory.content), overlapScore(memory.content, candidate.content))
    }))
    .filter((item) => item.score >= 0.12)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((item) => item.memory);
}

function conflictQuestion(candidate: Candidate, memory: MemoryNode): string {
  return [
    `В моей существующей базе знаний сказано: "${memory.content}".`,
    `В ходе этого диалога было сказано: "${candidate.content}".`,
    "Эти утверждения кажутся противоречивыми. Объясни, почему возникло это противоречие, или подтверди, что новая информация точнее старой записи."
  ].join(" ");
}

export function insertConflict(db: MemoryDb, candidate: Candidate, memory: MemoryNode, reason: string): MemoryConflict {
  const now = nowIso();
  const row: ConflictRow = {
    id: newId("conflict"),
    candidate_id: candidate.id,
    memory_id: memory.id,
    status: "open",
    reason,
    question: conflictQuestion(candidate, memory),
    resolution: null,
    created_at: now,
    updated_at: now
  };

  db.prepare(
    `INSERT INTO candidate_conflicts (
      id, candidate_id, memory_id, status, reason, question, resolution, created_at, updated_at
    ) VALUES (
      @id, @candidate_id, @memory_id, @status, @reason, @question, @resolution, @created_at, @updated_at
    )`
  ).run(row);

  return mapConflict(row, candidate, memory);
}

function reviewConversationInternal(db: MemoryDb, input: ReviewConversationInput) {
  const ingested =
    input.analysis_mode === "agent_supplied"
      ? { ...createConversationSource(db, input), candidates: [] }
      : ingestConversation(db, input);
  const preferenceReview = reviewPreferenceSignalsFromConversation(db, {
    source_id: ingested.source_id,
    project_id: input.project_id,
    text: input.text,
    analysis_mode: input.analysis_mode,
    agent_analysis: input.agent_analysis
  });
  const approved: MemoryNode[] = [];
  const blocked: Candidate[] = [];
  const pendingConfirmation: Candidate[] = [];
  const conflicts: MemoryConflict[] = [];
  const profileUpdates: ProfileSlot[] = [];

  const transaction = db.transaction(() => {
    for (const update of input.agent_analysis?.profile_updates ?? []) {
      profileUpdates.push(
        upsertProfileSlot(db, {
          ...update,
          source_id: ingested.source_id,
          evidence_text: update.evidence_text ?? update.content,
          reason: update.reason ?? "agent-supplied profile update from conversation review"
        })
      );
    }

    for (const candidate of ingested.candidates) {
      const relevant = findRelevantMemories(db, candidate);
      const candidateConflicts = relevant.flatMap((memory) => {
        const reason = contradictionReason(candidate, memory);
        return reason ? [insertConflict(db, candidate, memory, reason)] : [];
      });

      if (candidateConflicts.length > 0) {
        const blockedCandidate = updateCandidateStatus(db, candidate.id, "blocked");
        blocked.push(blockedCandidate);
        conflicts.push(...candidateConflicts.map((conflict) => ({ ...conflict, candidate: blockedCandidate })));
      } else if (candidate.needs_confirmation || candidate.risk !== "low") {
        pendingConfirmation.push(candidate);
      } else {
        const memory = approveCandidate(db, candidate.id);
        approved.push(memory);
      }
    }
  });

  transaction();

  return {
    source_id: ingested.source_id,
    preference_review: preferenceReview,
    profile_updates: profileUpdates,
    approved,
    blocked,
    pending_confirmation: pendingConfirmation,
    conflict_candidates: preferenceReview.conflict_candidates,
    conflicts: [...preferenceReview.conflicts, ...conflicts],
    summary: {
      extracted_candidates: ingested.candidates.length,
      approved: approved.length,
      blocked: blocked.length,
      pending_confirmation: pendingConfirmation.length,
      conflicts: conflicts.length,
      preference_disagreements: preferenceReview.summary.disagreements,
      preference_candidates: preferenceReview.summary.preference_candidates,
      approved_preferences: preferenceReview.summary.approved_preferences,
      blocked_preferences: preferenceReview.summary.blocked_preferences,
      preference_conflicts: preferenceReview.summary.preference_conflicts,
      preference_conflict_candidates: preferenceReview.summary.preference_conflict_candidates,
      profile_updates: profileUpdates.length,
      clarification_questions: preferenceReview.clarification_questions.length
    }
  };
}

export function reviewConversation(db: MemoryDb, input: ReviewConversationInput) {
  return db.transaction(() => reviewConversationInternal(db, input))();
}

export function listConflicts(db: MemoryDb, status = "open"): MemoryConflict[] {
  const rows = db
    .prepare("SELECT * FROM candidate_conflicts WHERE status = ? ORDER BY created_at DESC")
    .all(status) as ConflictRow[];

  return rows.map((row) => {
    const candidate = getCandidate(db, row.candidate_id);
    const memoryRow = db.prepare("SELECT * FROM nodes WHERE id = ?").get(row.memory_id);
    const memory = memoryRow ? mapNode(memoryRow as never) : undefined;
    return mapConflict(row, candidate, memory);
  });
}

export function getConflict(db: MemoryDb, id: string): MemoryConflict {
  const row = db.prepare("SELECT * FROM candidate_conflicts WHERE id = ?").get(id) as ConflictRow | undefined;
  if (!row) {
    throw new NotFoundError(`Conflict ${id} was not found`);
  }

  const candidate = getCandidate(db, row.candidate_id);
  const memoryRow = db.prepare("SELECT * FROM nodes WHERE id = ?").get(row.memory_id);
  const memory = memoryRow ? mapNode(memoryRow as never) : undefined;
  return mapConflict(row, candidate, memory);
}

export function resolveConflict(
  db: MemoryDb,
  id: string,
  input: { action: "accept_new" | "keep_existing" | "mark_compatible"; note?: string }
) {
  if (input.note) {
    assertSafeForStorage(input.note, "conflict resolution note");
  }
  const conflict = getConflict(db, id);
  if (conflict.status !== "open") {
    throw new ValidationError(`Conflict ${id} is already ${conflict.status}`);
  }

  const now = nowIso();
  const candidate = getCandidate(db, conflict.candidate_id);
  let memory: MemoryNode | null = null;

  const transaction = db.transaction(() => {
    const openRows = db
      .prepare("SELECT * FROM candidate_conflicts WHERE candidate_id = ? AND status = 'open'")
      .all(candidate.id) as ConflictRow[];

    if (input.action === "keep_existing") {
      db.prepare("UPDATE candidates SET status = 'rejected', updated_at = ? WHERE id = ?").run(now, candidate.id);
      for (const row of openRows) {
        db.prepare(
          "UPDATE candidate_conflicts SET status = 'resolved', resolution = ?, updated_at = ? WHERE id = ?"
        ).run(input.note ?? "Kept existing memory and rejected the new candidate.", now, row.id);
      }
      return;
    }

    if (input.action === "accept_new") {
      memory = approveCandidateAfterConflictResolution(db, candidate.id);
      for (const row of openRows) {
        db.prepare("UPDATE nodes SET status = 'superseded', updated_at = ? WHERE id = ?").run(now, row.memory_id);
        createLink(db, {
          from_id: memory.id,
          to_id: row.memory_id,
          relation: "SUPERSEDES",
          confidence: candidate.confidence,
          metadata: {
            conflict_id: row.id
          }
        });
        db.prepare(
          "UPDATE candidate_conflicts SET status = 'resolved', resolution = ?, updated_at = ? WHERE id = ?"
        ).run(input.note ?? "Accepted new information as more correct.", now, row.id);
      }
      return;
    }

    db.prepare(
      "UPDATE candidate_conflicts SET status = 'resolved', resolution = ?, updated_at = ? WHERE id = ?"
    ).run(input.note ?? "Marked as compatible after review.", now, id);

    const remainingOpen = db
      .prepare("SELECT COUNT(*) as count FROM candidate_conflicts WHERE candidate_id = ? AND status = 'open'")
      .get(candidate.id) as { count: number };

    if (remainingOpen.count === 0) {
      memory = approveCandidateAfterConflictResolution(db, candidate.id);
    }
  });

  transaction();

  return {
    conflict: getConflict(db, id),
    candidate: getCandidate(db, candidate.id),
    memory
  };
}
