import type { MemoryDb } from "../db/connection.js";
import { newId } from "../shared/ids.js";
import { nowIso } from "../shared/time.js";
import { approveCandidate, insertCandidate, updateCandidateStatus, type Candidate } from "./candidates.js";
import { metadataKnowledgeScope, type KnowledgeScope } from "./links.js";
import { contradictionReason, findRelevantMemories, insertConflict, type MemoryConflict } from "./review.js";
import type { MemoryNode, Scope } from "./types.js";

export type DisagreementSignal = {
  id: string;
  user_text: string;
  assistant_context?: string;
  reason_is_clear: boolean;
  inferred_reason?: string;
  demonstrated_preferences: DemonstratedPreference[];
  demonstrated_values: string[];
  confidence?: number;
  clarification_question?: string;
};

export type DemonstratedPreference = {
  content: string;
  confidence?: number;
  knowledge_scope?: KnowledgeScope;
  metadata?: Record<string, unknown>;
};

export type AgentSuppliedPreference = string | DemonstratedPreference;

export type AgentSuppliedDisagreement = {
  user_text: string;
  assistant_context?: string;
  reason_is_clear: boolean;
  inferred_reason?: string;
  demonstrated_preferences?: AgentSuppliedPreference[];
  demonstrated_values?: string[];
  confidence?: number;
  clarification_question?: string;
};

export type PreferenceReviewInput = {
  source_id: string;
  project_id?: string;
  text: string;
  analysis_mode?: "heuristic" | "agent_supplied";
  agent_analysis?: {
    disagreements?: AgentSuppliedDisagreement[];
  };
};

export type PreferenceReviewResult = {
  disagreements: DisagreementSignal[];
  preference_candidates: Candidate[];
  conflict_candidates: MemoryConflict[];
  approved: MemoryNode[];
  blocked: Candidate[];
  conflicts: MemoryConflict[];
  clarification_questions: string[];
  summary: {
    disagreements: number;
    clear_disagreements: number;
    unclear_disagreements: number;
    preference_candidates: number;
    approved_preferences: number;
    blocked_preferences: number;
    preference_conflicts: number;
    preference_conflict_candidates: number;
  };
};

type DialogueTurn = {
  role: "user" | "assistant" | "system";
  text: string;
};

const disagreementPatterns = [
  /\b(no|nope|not really|stop|wait|wrong|incorrect|that is not|this is not|i do not want|don't do)\b/iu,
  /\bwhy\b.*\b(not|unavailable|missing|failed|broken)\b/iu,
  /не[, ]|нет[, ]|стоп|подожди|не так|не то|неверно|неправильно|почему.*(недоступ|нет|не вид|не появ)/iu
];

function parseTurns(text: string): DialogueTurn[] {
  const turns: DialogueTurn[] = [];
  let current: DialogueTurn | null = null;

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
      const role = match[1].toLowerCase() === "user" ? "user" : match[1].toLowerCase() === "system" ? "system" : "assistant";
      current = {
        role,
        text: match[2].trim()
      };
      continue;
    }

    if (current) {
      current.text = `${current.text}\n${line}`;
    }
  }

  if (current) {
    turns.push(current);
  }

  if (turns.length > 0) {
    return turns;
  }

  return text
    .split(/(?<=[.!?])\s+|\r?\n+/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ role: "user", text: line }));
}

function isDisagreement(text: string): boolean {
  return disagreementPatterns.some((pattern) => pattern.test(text));
}

function inferSignal(userText: string, assistantContext?: string): DisagreementSignal {
  const normalized = userText.toLowerCase();
  const preferences = new Set<string>();
  const values = new Set<string>();
  const reasons: string[] = [];

  if (/mcp|tool|namespace|недоступ|не виж|не появ|подхват|доступ/iu.test(userText)) {
    preferences.add("Пользователь предпочитает считать интеграции рабочими только после проверки, что они реально доступны в активной сессии агента.");
    values.add("операционная достоверность важнее заявленной конфигурации");
    reasons.push("реакция связана с расхождением между заявленной конфигурацией и инструментами, реально видимыми агенту");
  }

  if (/не так|не то|wrong|incorrect|not what|видимо|actually/iu.test(normalized)) {
    preferences.add("Пользователь хочет, чтобы агент четко различал чтение существующей памяти и запись новой памяти, извлеченной из диалога.");
    values.add("точная семантика операций");
    reasons.push("пользователь поправил интерпретацию запрошенной операции с памятью");
  }

  if (/почему|why/iu.test(normalized)) {
    preferences.add("Пользователь ожидает, что агент явно объясняет причины сбоев, а не только предлагает следующие шаги.");
    values.add("прозрачная диагностика");
    reasons.push("пользователь явно спросил, почему предложенный путь не сработал");
  }

  if (/confirm|confirmation|approval|подтвержд/iu.test(normalized) && /write|durable|memory|памят|запис/iu.test(normalized)) {
    preferences.add("Пользователь предпочитает явное подтверждение перед долговременной записью в память.");
    values.add("контроль пользователя над постоянным состоянием");
    reasons.push("пользователь попросил подтверждение перед долговременной записью");
  }

  if (/стоп|stop|не, стоп/iu.test(normalized) && userText.length > 20) {
    preferences.add("Пользователь хочет, чтобы агент останавливался и пересматривал допущения, когда наблюдаемое поведение противоречит плану.");
    values.add("готовность реагировать на исправления");
    reasons.push("пользователь остановил агента, потому что предыдущее объяснение не совпадало с наблюдаемым состоянием");
  }

  const reason_is_clear = preferences.size > 0 && values.size > 0;
  const id = newId("disagree");

  return {
    id,
    user_text: userText,
    assistant_context: assistantContext,
    reason_is_clear,
    inferred_reason: reason_is_clear ? reasons.join("; ") : undefined,
    demonstrated_preferences: [...preferences].map((preference) => ({ content: preference })),
    demonstrated_values: [...values],
    clarification_question: reason_is_clear
      ? undefined
      : `Ты возразил на этот ответ агента: "${assistantContext ?? "(нет контекста ответа агента)"}". Что именно было не так или какое предпочтение стоит запомнить из твоей реакции: "${userText}"?`
  };
}

function extractDisagreements(text: string): DisagreementSignal[] {
  const turns = parseTurns(text);
  const signals: DisagreementSignal[] = [];

  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (turn.role !== "user" || !isDisagreement(turn.text)) {
      continue;
    }

    const previousAssistant = [...turns.slice(0, index)]
      .reverse()
      .find((candidate) => candidate.role === "assistant");
    signals.push(inferSignal(turn.text, previousAssistant?.text));
  }

  return signals;
}

function normalizeAgentSuppliedDisagreements(input: PreferenceReviewInput): DisagreementSignal[] {
  return (input.agent_analysis?.disagreements ?? []).map((signal) => {
    const demonstratedPreferences = normalizeAgentSuppliedPreferences(signal.demonstrated_preferences ?? []);
    const demonstratedValues = signal.demonstrated_values ?? [];
    const reasonIsClear = signal.reason_is_clear && demonstratedPreferences.length > 0 && demonstratedValues.length > 0;

    return {
      id: newId("disagree"),
      user_text: signal.user_text,
      assistant_context: signal.assistant_context,
      reason_is_clear: reasonIsClear,
      inferred_reason: reasonIsClear ? signal.inferred_reason : undefined,
      demonstrated_preferences: reasonIsClear ? demonstratedPreferences : [],
      demonstrated_values: reasonIsClear ? demonstratedValues : [],
      confidence: normalizeConfidence(signal.confidence),
      clarification_question: reasonIsClear
        ? undefined
        : signal.clarification_question ??
          `В диалоге есть неясное возражение пользователя: "${signal.user_text}". Какое предпочтение или ценность нужно запомнить из этой реакции?`
    };
  });
}

function normalizeAgentSuppliedPreferences(preferences: AgentSuppliedPreference[]): DemonstratedPreference[] {
  return preferences
    .map((preference) =>
      typeof preference === "string"
        ? { content: preference }
        : {
            content: preference.content,
            confidence: normalizeConfidence(preference.confidence),
            knowledge_scope: preference.knowledge_scope,
            metadata: preference.metadata
          }
    )
    .filter((preference) => preference.content.trim().length > 0);
}

function normalizeConfidence(confidence: number | undefined): number | undefined {
  if (confidence === undefined) {
    return undefined;
  }

  if (Number.isNaN(confidence)) {
    return undefined;
  }

  return Math.min(1, Math.max(0, confidence));
}

function inferredPreferenceConfidence(signal: DisagreementSignal, preference: DemonstratedPreference): number {
  if (preference.confidence !== undefined) {
    return preference.confidence;
  }

  if (signal.confidence !== undefined) {
    return signal.confidence;
  }

  const userText = signal.user_text.toLowerCase();
  const content = preference.content.toLowerCase();
  let confidence = 0.66;
  if (signal.assistant_context) {
    confidence += 0.03;
  }
  if (signal.inferred_reason && signal.inferred_reason.length > 60) {
    confidence += 0.04;
  }
  if (signal.inferred_reason && signal.inferred_reason.length > 140) {
    confidence += 0.02;
  }
  confidence += Math.min(0.07, signal.demonstrated_values.length * 0.02);

  if (/предпоч|хочу|нужно|долж|важно|давай|let'?s|i want|i prefer|must|should/iu.test(userText)) {
    confidence += 0.04;
  } else if (/can we|можно|почему|why|did you|ты все/iu.test(userText)) {
    confidence += 0.02;
  }

  if (/предпочитает|предпочитаю|prefers|prefer/iu.test(content)) {
    confidence += 0.04;
  } else if (/хочет|ожидает|wants|expects/iu.test(content)) {
    confidence += 0.03;
  } else if (/допускает|подходит|accepts|comfortable/iu.test(content)) {
    confidence += 0.01;
  }

  if (/явн|обязательн|перед запись|conflict|конфликт|confirmation|подтвержд/iu.test(content)) {
    confidence += 0.03;
  }

  if (signal.demonstrated_preferences.length > 1) {
    confidence -= Math.min(0.04, (signal.demonstrated_preferences.length - 1) * 0.015);
  }

  return Number(Math.min(0.94, Math.max(0.55, confidence)).toFixed(2));
}

function confidenceSource(signal: DisagreementSignal, preference: DemonstratedPreference): string {
  if (preference.confidence !== undefined) {
    return "agent_supplied_preference";
  }

  if (signal.confidence !== undefined) {
    return "agent_supplied_disagreement";
  }

  return "fallback_inferred";
}

function inferPreferenceKnowledgeScope(signal: DisagreementSignal, preference: DemonstratedPreference): KnowledgeScope {
  if (preference.knowledge_scope) {
    return preference.knowledge_scope;
  }

  const text = `${signal.user_text}\n${signal.assistant_context ?? ""}\n${preference.content}`.toLowerCase();
  const projectLocalHints =
    /agent_memory|memory_review|memory review|mcp|graph|sqlite|schema|project:|памят|граф|сущност|ребр|диалог/iu;
  if (projectLocalHints.test(text)) {
    return "project_local";
  }

  const globalHints =
    /all projects|any project|across projects|global|subscription|active chat agent|codex skill|workflow|presentation|slide|format|formatting|все проекты|любого проекта|глобальн|подписк|активн.*чат|codex skill|скилл|workflow|презентац|слайд|формат/iu;
  if (globalHints.test(text)) {
    return "global";
  }

  return metadataKnowledgeScope(preference.metadata ?? {});
}

function makePreferenceCandidates(
  signals: DisagreementSignal[],
  sourceId: string,
  scope: Scope,
  analysisProvider: "heuristic" | "agent_supplied"
): Candidate[] {
  const now = nowIso();
  return signals.flatMap((signal) =>
    signal.demonstrated_preferences.map((preference) => ({
      id: newId("cand"),
      type: "Preference",
      content: preference.content,
      scope,
      confidence: inferredPreferenceConfidence(signal, preference),
      risk: "low" as const,
      needs_confirmation: false,
      status: "pending" as const,
      source_id: sourceId,
      metadata: {
        ...(preference.metadata ?? {}),
        extractor: analysisProvider === "agent_supplied" ? "agent_supplied" : "preference-heuristic-v0",
        disagreement_id: signal.id,
        disagreement_text: signal.user_text,
        inferred_reason: signal.inferred_reason,
        demonstrated_values: signal.demonstrated_values,
        knowledge_scope: inferPreferenceKnowledgeScope(signal, preference),
        analysis_provider: analysisProvider === "agent_supplied" ? "agent_supplied" : "preference-heuristic-v0",
        confidence_source: confidenceSource(signal, preference)
      },
      created_at: now,
      updated_at: now
    }))
  );
}

function preferenceConflictReason(candidate: Candidate, memory: MemoryNode): string | null {
  const genericReason = contradictionReason(candidate, memory);
  if (genericReason) {
    return genericReason;
  }

  if (memory.type !== "Preference") {
    return null;
  }

  const combined = `${candidate.content}\n${memory.content}`.toLowerCase();
  if (/concise|brief|short|кратк/iu.test(combined) && /detailed|thorough|подробн/iu.test(combined)) {
    return "напряжение предпочтений: краткость vs подробность";
  }

  if (/automatic|autonomous|автомат/iu.test(combined) && /manual|confirm|approval|подтвержд|ручн/iu.test(combined)) {
    return "напряжение предпочтений: автоматическое действие vs ручное подтверждение";
  }

  return null;
}

function potentialConflictReason(candidate: Candidate, memory: MemoryNode): string {
  const heuristicReason = preferenceConflictReason(candidate, memory);
  if (heuristicReason) {
    return `кандидат на потенциальный конфликт: ${heuristicReason}`;
  }

  return "кандидат на потенциальный конфликт: семантически связанная запись памяти требует проверки агентом";
}

export function reviewPreferenceSignalsFromConversation(db: MemoryDb, input: PreferenceReviewInput): PreferenceReviewResult {
  const scope: Scope = input.project_id ? { kind: "project", project_id: input.project_id } : { kind: "global" };
  const disagreements =
    input.analysis_mode === "agent_supplied" ? normalizeAgentSuppliedDisagreements(input) : extractDisagreements(input.text);
  const clearDisagreements = disagreements.filter((signal) => signal.reason_is_clear);
  const clarificationQuestions = disagreements
    .filter((signal) => !signal.reason_is_clear && signal.clarification_question)
    .map((signal) => signal.clarification_question as string);
  const preferenceCandidates = makePreferenceCandidates(
    clearDisagreements,
    input.source_id,
    scope,
    input.analysis_mode === "agent_supplied" ? "agent_supplied" : "heuristic"
  );
  const approved: MemoryNode[] = [];
  const blocked: Candidate[] = [];
  const conflicts: MemoryConflict[] = [];
  const conflictCandidates: MemoryConflict[] = [];
  const useAgentConflictReview = input.analysis_mode === "agent_supplied";

  const transaction = db.transaction(() => {
    for (const candidate of preferenceCandidates) {
      insertCandidate(db, candidate);
      const relevant = findRelevantMemories(db, candidate);
      const candidateConflicts = useAgentConflictReview
        ? relevant.map((memory) => insertConflict(db, candidate, memory, potentialConflictReason(candidate, memory)))
        : relevant.flatMap((memory) => {
            const reason = preferenceConflictReason(candidate, memory);
            return reason ? [insertConflict(db, candidate, memory, reason)] : [];
          });

      if (candidateConflicts.length > 0) {
        const blockedCandidate = updateCandidateStatus(db, candidate.id, "blocked");
        blocked.push(blockedCandidate);
        const mappedConflicts = candidateConflicts.map((conflict) => ({ ...conflict, candidate: blockedCandidate }));
        if (useAgentConflictReview) {
          conflictCandidates.push(...mappedConflicts);
        } else {
          conflicts.push(...mappedConflicts);
        }
      } else {
        approved.push(approveCandidate(db, candidate.id));
      }
    }
  });

  transaction();

  return {
    disagreements,
    preference_candidates: preferenceCandidates,
    conflict_candidates: conflictCandidates,
    approved,
    blocked,
    conflicts,
    clarification_questions: clarificationQuestions,
    summary: {
      disagreements: disagreements.length,
      clear_disagreements: clearDisagreements.length,
      unclear_disagreements: disagreements.length - clearDisagreements.length,
      preference_candidates: preferenceCandidates.length,
      approved_preferences: approved.length,
      blocked_preferences: blocked.length,
      preference_conflicts: conflicts.length,
      preference_conflict_candidates: conflictCandidates.length
    }
  };
}
