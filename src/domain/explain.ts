import type { MemoryDb } from "../db/connection.js";
import { listEdgesForNode } from "./links.js";
import { getMemory } from "./nodes.js";
import { publicMemory, redactSourcesForMemory } from "./privacy.js";
import { listSourcesForNode } from "./sources.js";

export function explainMemory(db: MemoryDb, id: string) {
  const memory = getMemory(db, id);
  const sources = redactSourcesForMemory(memory, listSourcesForNode(db, id));
  const links = listEdgesForNode(db, id);

  return {
    memory: publicMemory(memory),
    why_stored:
      sources.length > 0
        ? "Stored as source-backed memory from the attached evidence."
        : "Stored as explicit memory without attached source evidence.",
    sources,
    links
  };
}
