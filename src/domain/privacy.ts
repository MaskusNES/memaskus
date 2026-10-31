import type { MemoryDb } from "../db/connection.js";
import { ValidationError } from "../shared/errors.js";
import type { Candidate } from "./candidates.js";
import type { MemoryConflict } from "./review.js";
import type { MemoryNode, MemoryRevision, ProfileSlot, ProfileSlotRevision, Source } from "./types.js";

const secretPatterns: RegExp[] = [
  /-----BEGIN ((?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/iu,
  /\bsk-[a-z0-9_-]{20,}\b/iu,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[a-z0-9_]{20,}\b/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/u,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret)["']?\s*[:=]\s*["']?[^\s"',;]{8,}/iu
];

export function containsSecret(value: string): boolean {
  return secretPatterns.some((pattern) => pattern.test(value));
}

export function redactSecrets(value: string): string {
  let result = value;
  for (const pattern of secretPatterns) {
    result = result.replace(new RegExp(pattern.source, `${pattern.flags}g`), "[redacted: credential]");
  }
  return result;
}

export function assertSafeForStorage(value: string, field = "content"): void {
  if (containsSecret(value)) {
    throw new ValidationError(`${field} appears to contain a credential or private key and cannot be stored`);
  }
}

export function sanitizeMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
  const protectedKey = /(?:api[_-]?key|access[_-]?token|auth[_-]?token|authorization|password|passwd|secret|credential|private[_-]?key|session|cookie)/iu;
  function sanitize(input: unknown, key?: string): unknown {
    if (key && protectedKey.test(key)) {
      return "[redacted: credential]";
    }
    if (typeof input === "string") {
      return redactSecrets(input);
    }
    if (Array.isArray(input)) {
      return input.map((item) => sanitize(item));
    }
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).map(([entryKey, item]) => [entryKey, sanitize(item, entryKey)]));
    }
    return input;
  }

  return sanitize(value ?? {}) as Record<string, unknown>;
}

export function redactedContent(memory: Pick<MemoryNode, "content" | "privacy_level">): string {
  if (memory.privacy_level === "secret") {
    return "[redacted: secret memory]";
  }

  if (memory.privacy_level === "sensitive") {
    return "[redacted: sensitive memory]";
  }

  return redactSecrets(memory.content);
}

export function publicMemory(memory: MemoryNode): MemoryNode {
  return {
    ...memory,
    content: redactedContent(memory),
    metadata: memory.privacy_level === "normal" ? sanitizeMetadata(memory.metadata) : {}
  };
}

export function publicCandidate(candidate: Candidate): Candidate {
  return {
    ...candidate,
    content: redactedContent(candidate),
    metadata: candidate.privacy_level === "normal" ? sanitizeMetadata(candidate.metadata) : {}
  };
}

export function publicProfileSlot(slot: ProfileSlot): ProfileSlot {
  return {
    ...slot,
    content: redactedContent(slot),
    metadata: slot.privacy_level === "normal" ? sanitizeMetadata(slot.metadata) : {}
  };
}

function historyPrivacy(current: MemoryNode["privacy_level"], historical?: MemoryNode["privacy_level"]): MemoryNode["privacy_level"] {
  return current === "normal" ? historical ?? "secret" : current;
}

export function publicProfileRevision(
  revision: ProfileSlotRevision,
  privacyLevel: ProfileSlot["privacy_level"]
): ProfileSlotRevision {
  return {
    ...revision,
    previous_content:
      revision.previous_content === null || revision.previous_content === undefined
        ? revision.previous_content
        : redactedContent({ content: revision.previous_content, privacy_level: historyPrivacy(privacyLevel, revision.previous_privacy_level) }),
    next_content: redactedContent({ content: revision.next_content, privacy_level: historyPrivacy(privacyLevel, revision.next_privacy_level) }),
    reason: historyPrivacy(privacyLevel, revision.previous_privacy_level) === "normal" && revision.next_privacy_level === "normal" ? (revision.reason ? redactSecrets(revision.reason) : revision.reason) : "protected profile revision"
  };
}

export function publicMemoryRevision(
  revision: MemoryRevision,
  privacyLevel: MemoryNode["privacy_level"]
): MemoryRevision {
  return {
    ...revision,
    previous_content:
      revision.previous_content === null || revision.previous_content === undefined
        ? revision.previous_content
        : redactedContent({ content: revision.previous_content, privacy_level: historyPrivacy(privacyLevel, revision.previous_privacy_level) }),
    next_content: redactedContent({ content: revision.next_content, privacy_level: historyPrivacy(privacyLevel, revision.next_privacy_level) }),
    reason:
      historyPrivacy(privacyLevel, revision.previous_privacy_level) === "normal" && revision.next_privacy_level === "normal"
        ? revision.reason
          ? redactSecrets(revision.reason)
          : revision.reason
        : "protected memory revision"
  };
}

export function publicConflict(conflict: MemoryConflict): MemoryConflict {
  const privateConflict =
    Boolean(conflict.memory && conflict.memory.privacy_level !== "normal") ||
    Boolean(conflict.candidate && conflict.candidate.privacy_level !== "normal");
  return {
    ...conflict,
    reason: privateConflict ? "Potential conflict with protected memory." : redactSecrets(conflict.reason),
    question: privateConflict
      ? "Protected memories appear to conflict. Review their scopes and choose which version should remain active."
      : redactSecrets(conflict.question),
    resolution: conflict.resolution ? redactSecrets(conflict.resolution) : conflict.resolution,
    candidate: conflict.candidate ? publicCandidate(conflict.candidate) : conflict.candidate,
    memory: conflict.memory ? publicMemory(conflict.memory) : conflict.memory
  };
}

export function redactSourcesForMemory(
  memory: Pick<MemoryNode, "privacy_level">,
  sources: Source[]
): Source[] {
  return sources.map((source) => ({
    ...source,
    title:
      memory.privacy_level === "normal"
        ? source.title
          ? redactSecrets(source.title)
          : source.title
        : "[redacted: protected source]",
    external_id:
      memory.privacy_level === "normal"
        ? source.external_id
          ? redactSecrets(source.external_id)
          : source.external_id
        : null,
    content_excerpt: source.content_excerpt
      ? memory.privacy_level === "normal"
        ? redactSecrets(source.content_excerpt)
        : redactedContent({ content: source.content_excerpt, privacy_level: memory.privacy_level })
      : source.content_excerpt,
    metadata: memory.privacy_level === "normal" ? sanitizeMetadata(source.metadata) : {}
  }));
}

// A downgrade starts a new public metadata payload. Only validated internal
// identities survive; arbitrary text from the protected payload never does.
export function replacementMetadata(db: MemoryDb, existing: Record<string, unknown>, supplied: Record<string, unknown> | undefined, wasProtected: boolean, nextPrivacy: MemoryNode["privacy_level"]): Record<string, unknown> {
  if (!wasProtected || nextPrivacy !== "normal") return { ...existing, ...sanitizeMetadata(supplied) };
  const retained: Record<string, unknown> = {};
  if (existing.knowledge_scope === "global" || existing.knowledge_scope === "project_local") retained.knowledge_scope = existing.knowledge_scope;
  for (const [key, table] of [["source_memory_id", "nodes"], ["approved_from_candidate_id", "candidates"], ["merged_candidate_id", "candidates"]]) {
    const id = existing[key];
    if (typeof id === "string" && db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) retained[key] = id;
  }
  if (retained.source_memory_id && existing.projected_from_memory === true) retained.projected_from_memory = true;
  return { ...retained, ...sanitizeMetadata(supplied) };
}

// Reclassification applies to every historical copy of this value, including
// the escalation revision. Preserve rows and never weaken an earlier label.
export function protectHistoricalValue(db: MemoryDb, table: "memory_revisions" | "profile_slot_revisions", id: string, value: string, privacy: MemoryNode["privacy_level"]): void {
  if (privacy === "normal") return;
  const owner = table === "memory_revisions" ? "memory_id" : "slot_id";
  for (const side of ["previous", "next"]) {
    db.prepare(`UPDATE ${table} SET ${side}_privacy_level = ?
      WHERE ${owner} = ? AND ${side}_content = ?
      AND (${side}_privacy_level = 'normal' OR (${side}_privacy_level = 'sensitive' AND ? = 'secret'))`).run(privacy, id, value, privacy);
  }
}
