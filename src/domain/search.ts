import type { MemoryDb } from "../db/connection.js";
import { memoryVisibilitySqlParts } from "./scope.js";
import type { KnowledgeScope, Scope } from "./types.js";

const MAX_QUERY_TOKENS = 16;
const MAX_RUSSIAN_VARIANTS = 8;
const MIN_RUSSIAN_STEM_LENGTH = 3;

function normalizeRussian(token: string): string {
  return token.replace(/ё/g, "е");
}

// Deliberately limited noun endings, not a general morphological analyzer.
// Longest endings go first; short words never acquire a broad stem prefix.
function russianStem(token: string): string {
  const normalized = normalizeRussian(token);
  if (!/^[а-я]+$/u.test(normalized) || normalized.length < 4) return normalized;
  const stem = normalized.replace(/(?:ами|ями|ах|ях|ам|ям|ой|ей|ою|ею|ом|ем|а|я|ы|и|у|ю|е|о)$/u, "");
  return stem.length >= MIN_RUSSIAN_STEM_LENGTH ? stem : normalized;
}

function russianVariants(token: string): string[] {
  if (!/^[а-яё]+$/u.test(token)) return [token];
  // Keep the original even when the combinatorial е/ё expansion hits its cap.
  const variants = new Set([token, normalizeRussian(token)]);
  for (let index = 0; index < token.length && variants.size < MAX_RUSSIAN_VARIANTS; index += 1) {
    if (token[index] !== "е" && token[index] !== "ё") continue;
    for (const variant of [...variants]) {
      variants.add(`${variant.slice(0, index)}ё${variant.slice(index + 1)}`);
      if (variants.size >= MAX_RUSSIAN_VARIANTS) break;
    }
  }
  return [...variants];
}

export type IndexedSearchHit = {
  id: string;
  score: number;
};

export type IndexedSearchResult = {
  available: boolean;
  hits: IndexedSearchHit[];
};

export function searchTokens(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length > 1)
    )
  ];
}

export function tokenOverlap(query: string, content: string): number {
  const queryTokens = searchTokens(query).slice(0, MAX_QUERY_TOKENS);
  if (queryTokens.length === 0) {
    return 0;
  }

  const contentTokens = new Set(searchTokens(content));
  const normalizedContent = new Set([...contentTokens].map(russianStem));
  let matches = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) {
      matches += 1;
    } else if (normalizedContent.has(russianStem(token))) {
      matches += 0.75;
    }
  }
  return matches / queryTokens.length;
}

function searchIndexExists(db: MemoryDb): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'nodes_fts'").get()
  );
}

function ftsQuery(query: string): string | null {
  const tokens = searchTokens(query).slice(0, MAX_QUERY_TOKENS);
  if (tokens.length === 0) {
    return null;
  }
  // Tokens are produced from letters and digits only, so quoting them removes
  // FTS operator semantics while the suffix enables useful prefix matching.
  const variants = new Set<string>();
  for (const token of tokens) {
    for (const variant of russianVariants(token)) variants.add(variant);
    const stem = russianStem(token);
    if (stem !== normalizeRussian(token)) {
      for (const variant of russianVariants(stem)) variants.add(variant);
    }
  }
  return [...variants].map((token) => `"${token}"*`).join(" OR ");
}

export function indexedNodeSearch(
  db: MemoryDb,
  input: {
    query: string;
    scope?: Scope;
    knowledge_scope?: KnowledgeScope;
    limit: number;
  }
): IndexedSearchResult {
  if (!searchIndexExists(db)) {
    return { available: false, hits: [] };
  }

  const match = ftsQuery(input.query);
  if (!match) {
    return { available: true, hits: [] };
  }

  const visibility = memoryVisibilitySqlParts(input.scope, input.knowledge_scope, "n.");
  try {
    const rows = db
      .prepare(
        `SELECT n.id, bm25(nodes_fts, 0.0, 1.0, 0.25) AS rank
         FROM nodes_fts
         JOIN nodes n ON n.id = nodes_fts.id
         WHERE nodes_fts MATCH ?
           AND n.status = 'active'
           AND ${visibility.clause}
         ORDER BY rank ASC
         LIMIT ?`
      )
      .all(match, ...visibility.params, input.limit) as Array<{ id: string; rank: number }>;

    const relevance = rows.map((row) => Math.max(0, -row.rank));
    const strongest = Math.max(...relevance, 0);
    return {
      available: true,
      hits: rows.map((row, index) => {
        const normalized = strongest > 0 ? relevance[index] / strongest : 1;
        const rankSignal = 1 / (1 + index * 0.08);
        return {
          id: row.id,
          score: Number((normalized * 0.85 + rankSignal * 0.15).toFixed(4))
        };
      })
    };
  } catch (error) {
    if (error instanceof Error && /(?:no such table|no such module):?\s*(?:nodes_fts|fts5)/iu.test(error.message)) {
      return { available: false, hits: [] };
    }
    throw error;
  }
}
