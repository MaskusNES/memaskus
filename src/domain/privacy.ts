import { ValidationError } from "../shared/errors.js";
import type { Candidate } from "./candidates.js";
import type { MemoryConflict } from "./review.js";
import type { MemoryNode, MemoryRevision, ProfileSlot, ProfileSlotRevision, Source } from "./types.js";

const secretPatterns: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/iu,
  /\bsk-[a-z0-9_-]{20,}\b/iu,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[a-z0-9_]{20,}\b/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/u,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret)\s*[:=]\s*["']?[^\s"',;]{8,}/iu
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
  function sanitize(input: unknown): unknown {
    if (typeof input === "string") {
      return redactSecrets(input);
    }
    if (Array.isArray(input)) {
      return input.map(sanitize);
    }
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, sanitize(item)]));
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

export function publicProfileRevision(
  revision: ProfileSlotRevision,
  privacyLevel: ProfileSlot["privacy_level"]
): ProfileSlotRevision {
  return {
    ...revision,
    previous_content:
      revision.previous_content === null || revision.previous_content === undefined
        ? revision.previous_content
        : redactedContent({ content: revision.previous_content, privacy_level: privacyLevel }),
    next_content: redactedContent({ content: revision.next_content, privacy_level: privacyLevel }),
    reason: privacyLevel === "normal" ? revision.reason : "protected profile revision"
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
        : redactedContent({ content: revision.previous_content, privacy_level: privacyLevel }),
    next_content: redactedContent({ content: revision.next_content, privacy_level: privacyLevel }),
    reason:
      privacyLevel === "normal"
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
