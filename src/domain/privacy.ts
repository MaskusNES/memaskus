import type { MemoryNode, Source } from "./types.js";

export function redactedContent(memory: Pick<MemoryNode, "content" | "privacy_level">): string {
  if (memory.privacy_level === "secret") {
    return "[redacted: secret memory]";
  }

  if (memory.privacy_level === "sensitive") {
    return "[redacted: sensitive memory]";
  }

  return memory.content;
}

export function redactSourcesForMemory(
  memory: Pick<MemoryNode, "privacy_level">,
  sources: Source[]
): Source[] {
  if (memory.privacy_level === "normal") {
    return sources;
  }

  return sources.map((source) => ({
    ...source,
    content_excerpt: source.content_excerpt ? redactedContent({ content: source.content_excerpt, privacy_level: memory.privacy_level }) : source.content_excerpt
  }));
}
