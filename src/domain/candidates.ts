import type { MemoryDb } from "../db/connection.js";
import { NotFoundError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { nowIso } from "../shared/time.js";
import { mapNode } from "./mappers.js";
import { createRelatedLinksForMemory, knowledgeScope, metadataKnowledgeScope } from "./links.js";
import { createMemory, getMemory } from "./nodes.js";
import { updateMemory } from "./memory-lifecycle.js";
import { applyMemoryToProfile } from "./profile.js";
import { assertSafeForStorage, redactSecrets, sanitizeMetadata } from "./privacy.js";
import { exactScopeMatch } from "./scope.js";
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
  privacy_level: MemoryNode["privacy_level"];
  speaker_role?: "user" | "assistant" | "system";
  turn_id?: string;
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
  scope_conversation_id: string | null;
  knowledge_scope: "global" | "project_local";
  confidence: number;
  risk: Candidate["risk"];
  needs_confirmation: 0 | 1;
  privacy_level: MemoryNode["privacy_level"];
  speaker_role: "user" | "assistant" | "system" | null;
  turn_id: string | null;
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
    content_excerpt: redactSecrets(input.text).slice(0, 500),
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
      agent_id: row.scope_agent_id ?? undefined,
      conversation_id: row.scope_conversation_id ?? undefined
    },
    confidence: row.confidence,
    risk: row.risk,
    needs_confirmation: row.needs_confirmation === 1,
    privacy_level: row.privacy_level,
    speaker_role: row.speaker_role ?? undefined,
    turn_id: row.turn_id ?? undefined,
    status: row.status,
    source_id: row.source_id,
    metadata: { ...JSON.parse(row.metadata_json), knowledge_scope: row.knowledge_scope },
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

type CandidateSentence = {
  text: string;
  speaker_role: "user" | "assistant" | "system";
  turn_id: string;
};

function splitSentences(text: string): CandidateSentence[] {
  const turns: Array<{ role: CandidateSentence["speaker_role"]; text: string }> = [];
  let current: { role: CandidateSentence["speaker_role"]; text: string } | null = null;

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = /^(user|assistant|system|codex)\s*:\s*(.*)$/iu.exec(line);
    if (match) {
      if (current) {
        turns.push(current);
      }
      const label = match[1].toLowerCase();
      current = {
        role: label === "user" ? "user" : label === "system" ? "system" : "assistant",
        text: match[2].trim()
      };
    } else if (current) {
      current.text = `${current.text}\n${line}`;
    } else {
      current = { role: "user", text: line };
    }
  }
  if (current) {
    turns.push(current);
  }

  return turns.flatMap((turn, turnIndex) =>
    turn.text
      .split(/(?<=[.!?])\s+|\r?\n+/u)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 8)
      .map((sentence, sentenceIndex) => ({
        text: sentence,
        speaker_role: turn.role,
        turn_id: `turn:${turnIndex + 1}:${sentenceIndex + 1}`
      }))
  );
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
  assertSafeForStorage(candidate.content, "candidate content");
  const metadata = sanitizeMetadata(candidate.metadata);
  db.prepare(
    `INSERT INTO candidates (
      id, type, content, scope_kind, scope_user_id, scope_project_id,
      scope_workspace_id, scope_agent_id, scope_conversation_id, knowledge_scope, confidence, risk, needs_confirmation,
      privacy_level, speaker_role, turn_id, status, source_id, metadata_json, created_at, updated_at
    ) VALUES (
      @id, @type, @content, @scope_kind, @scope_user_id, @scope_project_id,
      @scope_workspace_id, @scope_agent_id, @scope_conversation_id, @knowledge_scope, @confidence, @risk, @needs_confirmation,
      @privacy_level, @speaker_role, @turn_id, @status, @source_id, @metadata_json, @created_at, @updated_at
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
    scope_conversation_id: candidate.scope.conversation_id ?? null,
    knowledge_scope: metadataKnowledgeScope(metadata, candidate.scope),
    confidence: candidate.confidence,
    risk: candidate.risk,
    needs_confirmation: candidate.needs_confirmation ? 1 : 0,
    privacy_level: candidate.privacy_level,
    speaker_role: candidate.speaker_role ?? null,
    turn_id: candidate.turn_id ?? null,
    status: candidate.status,
    source_id: candidate.source_id ?? null,
    metadata_json: JSON.stringify(metadata),
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

  const scope: Scope = input.project_id
    ? { kind: "project", project_id: input.project_id }
    : input.conversation_id
      ? { kind: "conversation", conversation_id: input.conversation_id }
      : { kind: "global" };
  const now = nowIso();
  const candidates = splitSentences(redactSecrets(input.text)).flatMap((sentence) => {
    if (sentence.speaker_role !== "user") {
      return [];
    }
    const classification = classifySentence(sentence.text);
    if (!classification) {
      return [];
    }

    return [
      {
        id: newId("cand"),
        type: classification.type,
        content: sentence.text,
        scope,
        confidence: classification.confidence,
        risk: classification.risk,
        needs_confirmation: classification.needs_confirmation,
        privacy_level: "normal" as const,
        speaker_role: sentence.speaker_role,
        turn_id: sentence.turn_id,
        status: "pending" as const,
        source_id: source.source_id,
        metadata: sanitizeMetadata({
          extractor: "deterministic-v0"
        }),
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

export function listCandidatesByStatuses(db: MemoryDb, statuses: CandidateStatus[]): Candidate[] {
  const normalized = statuses.length > 0 ? [...new Set(statuses)] : ["pending"];
  const rows = db
    .prepare(
      `SELECT * FROM candidates
       WHERE status IN (${normalized.map(() => "?").join(", ")})
       ORDER BY created_at DESC`
    )
    .all(...normalized);
  return rows.map((row) => mapCandidate(row as CandidateRow));
}

export function getCandidate(db: MemoryDb, id: string): Candidate {
  const row = db.prepare("SELECT * FROM candidates WHERE id = ?").get(id);
  if (!row) {
    throw new NotFoundError(`Candidate ${id} was not found`);
  }
  return mapCandidate(row as CandidateRow);
}

function approveCandidateWithStatuses(db: MemoryDb, id: string, allowedStatuses: CandidateStatus[]): MemoryNode {
  const candidate = getCandidate(db, id);
  if (!allowedStatuses.includes(candidate.status)) {
    throw new ValidationError(`Candidate ${id} is ${candidate.status}, not ${allowedStatuses.join(" or ")}`);
  }
  const replacementMemoryIds = allowedStatuses.includes("blocked")
    ? (
        db
          .prepare("SELECT memory_id FROM candidate_conflicts WHERE candidate_id = ? AND status = 'open'")
          .all(candidate.id) as Array<{ memory_id: string }>
      ).map((row) => row.memory_id)
    : [];

  let approvedMemory: MemoryNode | undefined;
  const transaction = db.transaction(() => {
    const memory = createMemory(db, {
      type: candidate.type,
      content: candidate.content,
      scope: candidate.scope,
      confidence: candidate.confidence,
      privacy_level: candidate.privacy_level,
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
    applyMemoryToProfile(db, approvedMemory, {
      candidate_id: candidate.id,
      force_replace: allowedStatuses.includes("blocked"),
      replace_memory_ids: replacementMemoryIds
    });
  });
  transaction();

  if (!approvedMemory) {
    throw new Error(`Candidate ${id} was not approved`);
  }

  return approvedMemory;
}

export function approveCandidate(db: MemoryDb, id: string): MemoryNode {
  return approveCandidateWithStatuses(db, id, ["pending"]);
}

/** Only conflict resolution may promote a blocked candidate. */
export function approveCandidateAfterConflictResolution(db: MemoryDb, id: string): MemoryNode {
  return approveCandidateWithStatuses(db, id, ["blocked"]);
}

export function rejectCandidate(db: MemoryDb, id: string): Candidate {
  const candidate = getCandidate(db, id);
  if (candidate.status !== "pending") {
    throw new ValidationError(`Candidate ${id} is ${candidate.status}, not pending`);
  }

  db.prepare("UPDATE candidates SET status = 'rejected', updated_at = ? WHERE id = ?").run(nowIso(), id);
  return getCandidate(db, id);
}

export function patchCandidate(
  db: MemoryDb,
  id: string,
  input: {
    type?: string;
    content?: string;
    scope?: Scope;
    confidence?: number;
    privacy_level?: MemoryNode["privacy_level"];
    metadata?: Record<string, unknown>;
  }
): Candidate {
  const candidate = getCandidate(db, id);
  if (candidate.status !== "pending") {
    throw new ValidationError(`Candidate ${id} is ${candidate.status}, not pending`);
  }
  if (input.content !== undefined) {
    assertSafeForStorage(input.content, "candidate content");
  }
  const scope = input.scope ?? candidate.scope;
  const metadata = input.metadata ? { ...candidate.metadata, ...sanitizeMetadata(input.metadata) } : candidate.metadata;
  const canonicalKnowledgeScope = metadataKnowledgeScope(metadata, scope);
  metadata.knowledge_scope = canonicalKnowledgeScope;
  db.prepare(
    `UPDATE candidates SET
       type = ?, content = ?, scope_kind = ?, scope_user_id = ?, scope_project_id = ?,
       scope_workspace_id = ?, scope_agent_id = ?, scope_conversation_id = ?,
       knowledge_scope = ?, confidence = ?, privacy_level = ?, metadata_json = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    input.type ?? candidate.type,
    input.content ?? candidate.content,
    scope.kind,
    scope.user_id ?? null,
    scope.project_id ?? null,
    scope.workspace_id ?? null,
    scope.agent_id ?? null,
    scope.conversation_id ?? null,
    canonicalKnowledgeScope,
    input.confidence ?? candidate.confidence,
    input.privacy_level ?? candidate.privacy_level,
    JSON.stringify(metadata),
    nowIso(),
    id
  );
  return getCandidate(db, id);
}

export function mergeCandidate(db: MemoryDb, id: string, memoryId: string): { candidate: Candidate; memory: MemoryNode } {
  const candidate = getCandidate(db, id);
  if (candidate.status !== "pending" && candidate.status !== "blocked") {
    throw new ValidationError(`Candidate ${id} is ${candidate.status}, not pending or blocked`);
  }
  const existing = getMemory(db, memoryId);
  if (existing.status !== "active") {
    throw new ValidationError(`Memory ${memoryId} is ${existing.status}, not active`);
  }
  if (candidate.type !== existing.type) {
    throw new ValidationError(`Candidate type ${candidate.type} does not match memory type ${existing.type}`);
  }
  if (!exactScopeMatch(candidate.scope, existing.scope) || !exactScopeMatch(existing.scope, candidate.scope)) {
    throw new ValidationError(`Candidate ${id} and memory ${memoryId} have different scopes`);
  }
  if (metadataKnowledgeScope(candidate.metadata, candidate.scope) !== knowledgeScope(existing)) {
    throw new ValidationError(`Candidate ${id} and memory ${memoryId} have different knowledge scopes`);
  }
  if (candidate.status === "blocked") {
    const matchingConflict = db
      .prepare(
        `SELECT 1 FROM candidate_conflicts
         WHERE candidate_id = ? AND memory_id = ? AND status = 'open'`
      )
      .get(candidate.id, memoryId);
    if (!matchingConflict) {
      throw new ValidationError(`Blocked candidate ${id} can only be merged into a conflicting memory`);
    }
  }
  const privacyRank = { normal: 0, sensitive: 1, secret: 2 } as const;
  const privacy =
    privacyRank[candidate.privacy_level] > privacyRank[existing.privacy_level]
      ? candidate.privacy_level
      : existing.privacy_level;
  let memory: MemoryNode | undefined;
  const transaction = db.transaction(() => {
    memory = updateMemory(db, memoryId, {
      content: candidate.content,
      confidence: Math.max(existing.confidence, candidate.confidence),
      privacy_level: privacy,
      metadata: {
        ...candidate.metadata,
        merged_candidate_id: candidate.id
      },
      reason: `merged candidate ${candidate.id}`
    });
    if (candidate.source_id) {
      db.prepare(
        `INSERT OR IGNORE INTO node_sources (node_id, source_id, evidence_text, created_at)
         VALUES (?, ?, ?, ?)`
      ).run(memoryId, candidate.source_id, redactSecrets(candidate.content), nowIso());
    }
    db.prepare("UPDATE candidates SET status = 'merged', updated_at = ? WHERE id = ?").run(nowIso(), id);
    db.prepare(
      `UPDATE candidate_conflicts
       SET status = 'resolved', resolution = ?, updated_at = ?
       WHERE candidate_id = ? AND status = 'open'`
    ).run(`Merged into memory ${memoryId}.`, nowIso(), id);
  });
  transaction();
  if (!memory) {
    throw new Error(`Candidate ${id} was not merged`);
  }
  return { candidate: getCandidate(db, id), memory };
}
