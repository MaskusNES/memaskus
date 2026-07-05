import type { MemoryDb } from "../db/connection.js";
import { NotFoundError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { nowIso } from "../shared/time.js";
import { mapNode } from "./mappers.js";
import { createRelatedLinksForMemory } from "./links.js";
import { createMemory } from "./nodes.js";
import { createSource } from "./sources.js";
import type { MemoryNode, Scope } from "./types.js";

export type CandidateStatus = "pending" | "blocked" | "approved" | "rejected" | "merged";

export type Candidate = {
  id: string;
  type: string;
  content: string;
  scope: Scope;
  confidence: number;
  risk: "low" | "medium" | "high";
  needs_confirmation: boolean;
  status: CandidateStatus;
  source_id?: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

type CandidateRow = {
  id: string;
  type: string;
  content: string;
  scope_kind: Scope["kind"];
  scope_user_id: string | null;
  scope_project_id: string | null;
  scope_workspace_id: string | null;
  scope_agent_id: string | null;
  confidence: number;
  risk: Candidate["risk"];
  needs_confirmation: 0 | 1;
  status: CandidateStatus;
  source_id: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

export type IngestConversationInput = {
  conversation_id?: string;
  project_id?: string;
  text: string;
};

export function createConversationSource(db: MemoryDb, input: IngestConversationInput): { source_id: string } {
  const source = createSource(db, {
    kind: "conversation",
    external_id: input.conversation_id,
    title: input.conversation_id ?? "Импорт диалога",
    content_excerpt: input.text.slice(0, 500),
    metadata: {
      project_id: input.project_id
    }
  });

  return { source_id: source.id };
}

function mapCandidate(row: CandidateRow): Candidate {
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    scope: {
      kind: row.scope_kind,
      user_id: row.scope_user_id ?? undefined,
      project_id: row.scope_project_id ?? undefined,
      workspace_id: row.scope_workspace_id ?? undefined,
      agent_id: row.scope_agent_id ?? undefined
    },
    confidence: row.confidence,
    risk: row.risk,
    needs_confirmation: row.needs_confirmation === 1,
    status: row.status,
    source_id: row.source_id,
    metadata: JSON.parse(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\r?\n+/u)
    .map((line) => line.replace(/^(user|assistant|system|codex):\s*/iu, "").trim())
    .filter((line) => line.length > 8);
}

function classifySentence(sentence: string): Pick<Candidate, "type" | "confidence" | "risk" | "needs_confirmation"> | null {
  const normalized = sentence.toLowerCase();

  if (/remember that|запомни|важно помнить/u.test(normalized)) {
    return { type: "Fact", confidence: 0.92, risk: "low", needs_confirmation: false };
  }

  if (/i prefer|предпочитаю|мне удобнее|лучше отвечать/u.test(normalized)) {
    return { type: "Preference", confidence: 0.86, risk: "low", needs_confirmation: false };
  }

  if (/we decided|let'?s use|будем использовать|решили|давай использовать|mvp will use/u.test(normalized)) {
    return { type: "Decision", confidence: 0.84, risk: "low", needs_confirmation: false };
  }

  if (/it should|system must|должна|должен|нужно чтобы|требуется/u.test(normalized)) {
    return { type: "Decision", confidence: 0.78, risk: "low", needs_confirmation: true };
  }

  if (/\btodo\b|need to|we should|надо|нужно сделать|следующий шаг/u.test(normalized)) {
    return { type: "Task", confidence: 0.74, risk: "low", needs_confirmation: true };
  }

  return null;
}

export function insertCandidate(db: MemoryDb, candidate: Candidate): void {
  db.prepare(
    `INSERT INTO candidates (
      id, type, content, scope_kind, scope_user_id, scope_project_id,
      scope_workspace_id, scope_agent_id, confidence, risk, needs_confirmation,
      status, source_id, metadata_json, created_at, updated_at
    ) VALUES (
      @id, @type, @content, @scope_kind, @scope_user_id, @scope_project_id,
      @scope_workspace_id, @scope_agent_id, @confidence, @risk, @needs_confirmation,
      @status, @source_id, @metadata_json, @created_at, @updated_at
    )`
  ).run({
    id: candidate.id,
    type: candidate.type,
    content: candidate.content,
    scope_kind: candidate.scope.kind,
    scope_user_id: candidate.scope.user_id ?? null,
    scope_project_id: candidate.scope.project_id ?? null,
    scope_workspace_id: candidate.scope.workspace_id ?? null,
    scope_agent_id: candidate.scope.agent_id ?? null,
    confidence: candidate.confidence,
    risk: candidate.risk,
    needs_confirmation: candidate.needs_confirmation ? 1 : 0,
    status: candidate.status,
    source_id: candidate.source_id ?? null,
    metadata_json: JSON.stringify(candidate.metadata),
    created_at: candidate.created_at,
    updated_at: candidate.updated_at
  });
}

export function updateCandidateStatus(db: MemoryDb, id: string, status: CandidateStatus): Candidate {
  db.prepare("UPDATE candidates SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), id);
  return getCandidate(db, id);
}

export function ingestConversation(db: MemoryDb, input: IngestConversationInput): { source_id: string; candidates: Candidate[] } {
  const source = createConversationSource(db, input);

  const scope: Scope = input.project_id ? { kind: "project", project_id: input.project_id } : { kind: "global" };
  const now = nowIso();
  const candidates = splitSentences(input.text).flatMap((sentence) => {
    const classification = classifySentence(sentence);
    if (!classification) {
      return [];
    }

    return [
      {
        id: newId("cand"),
        type: classification.type,
        content: sentence,
        scope,
        confidence: classification.confidence,
        risk: classification.risk,
        needs_confirmation: classification.needs_confirmation,
        status: "pending" as const,
        source_id: source.source_id,
        metadata: {
          extractor: "deterministic-v0"
        },
        created_at: now,
        updated_at: now
      }
    ];
  });

  const transaction = db.transaction(() => {
    for (const candidate of candidates) {
      insertCandidate(db, candidate);
    }
  });
  transaction();

  return { source_id: source.source_id, candidates };
}

export function listCandidates(db: MemoryDb, status = "pending"): Candidate[] {
  const rows = db
    .prepare("SELECT * FROM candidates WHERE status = ? ORDER BY created_at DESC")
    .all(status);
  return rows.map((row) => mapCandidate(row as CandidateRow));
}

export function getCandidate(db: MemoryDb, id: string): Candidate {
  const row = db.prepare("SELECT * FROM candidates WHERE id = ?").get(id);
  if (!row) {
    throw new NotFoundError(`Candidate ${id} was not found`);
  }
  return mapCandidate(row as CandidateRow);
}

export function approveCandidate(db: MemoryDb, id: string): MemoryNode {
  const candidate = getCandidate(db, id);
  if (candidate.status !== "pending" && candidate.status !== "blocked") {
    throw new ValidationError(`Candidate ${id} is ${candidate.status}, not pending or blocked`);
  }

  let approvedMemory: MemoryNode | undefined;
  const transaction = db.transaction(() => {
    const memory = createMemory(db, {
      type: candidate.type,
      content: candidate.content,
      scope: candidate.scope,
      confidence: candidate.confidence,
      privacy_level: "normal",
      source: undefined,
      metadata: {
        ...candidate.metadata,
        approved_from_candidate_id: candidate.id
      }
    });
    const now = nowIso();

    if (candidate.source_id) {
      db.prepare(
        `INSERT INTO node_sources (node_id, source_id, evidence_text, created_at)
         VALUES (?, ?, ?, ?)`
      ).run(memory.id, candidate.source_id, candidate.content, now);
    }

    db.prepare("UPDATE candidates SET status = 'approved', updated_at = ? WHERE id = ?").run(now, id);
    const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(memory.id);
    approvedMemory = mapNode(row as never);
    createRelatedLinksForMemory(db, approvedMemory);
  });
  transaction();

  if (!approvedMemory) {
    throw new Error(`Candidate ${id} was not approved`);
  }

  return approvedMemory;
}

export function rejectCandidate(db: MemoryDb, id: string): Candidate {
  const candidate = getCandidate(db, id);
  if (candidate.status !== "pending") {
    throw new ValidationError(`Candidate ${id} is ${candidate.status}, not pending`);
  }

  db.prepare("UPDATE candidates SET status = 'rejected', updated_at = ? WHERE id = ?").run(nowIso(), id);
  return getCandidate(db, id);
}
