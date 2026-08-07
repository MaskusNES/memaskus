import type { MemoryDb } from "../db/connection.js";
import { listEdgesForNode } from "./links.js";
import { getMemory } from "./nodes.js";
import { publicMemory, redactedContent, redactSourcesForMemory } from "./privacy.js";
import { listSourceEvidenceForNode, listSourcesForNode } from "./sources.js";

export function explainMemory(db: MemoryDb, id: string) {
  const memory = getMemory(db, id);
  const sources = redactSourcesForMemory(memory, listSourcesForNode(db, id));
  const links = listEdgesForNode(db, id);
  const evidence = listSourceEvidenceForNode(db, id).map((item) => ({
    ...item,
    evidence_text: item.evidence_text
      ? redactedContent({ content: item.evidence_text, privacy_level: memory.privacy_level })
      : null
  }));

  return {
    memory: publicMemory(memory),
    why_stored:
      sources.length > 0
        ? "Stored as source-backed memory from the attached evidence."
        : "Stored as explicit memory without attached source evidence.",
    sources,
    evidence,
    links
  };
}
