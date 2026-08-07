import type { KnowledgeScope, Scope } from "./types.js";

export type RetrievalEvalCase = {
  id?: string;
  query: string;
  scope?: Scope;
  knowledge_scope?: KnowledgeScope;
  types?: string[];
  expected_ids: string[];
};

export type RetrievalEvalMetrics = {
  cases: number;
  k: number;
  hit_rate_at_k: number;
  recall_at_k: number;
  mean_reciprocal_rank: number;
  ndcg_at_k: number;
};

function round(value: number): number {
  return Number(value.toFixed(4));
}

function discountedGain(rankedIds: string[], expected: Set<string>): number {
  return rankedIds.reduce(
    (score, id, index) => score + (expected.has(id) ? 1 / Math.log2(index + 2) : 0),
    0
  );
}

export async function evaluateRetrieval(
  cases: RetrievalEvalCase[],
  retrieve: (testCase: RetrievalEvalCase, k: number) => Promise<string[]>,
  k = 10
): Promise<RetrievalEvalMetrics> {
  if (!Number.isInteger(k) || k <= 0) {
    throw new Error("Evaluation k must be a positive integer");
  }
  if (cases.length === 0) {
    return {
      cases: 0,
      k,
      hit_rate_at_k: 0,
      recall_at_k: 0,
      mean_reciprocal_rank: 0,
      ndcg_at_k: 0
    };
  }

  let hits = 0;
  let recall = 0;
  let reciprocalRank = 0;
  let ndcg = 0;
  for (const testCase of cases) {
    const expected = new Set(testCase.expected_ids);
    if (expected.size === 0) {
      throw new Error(`Evaluation case ${testCase.id ?? testCase.query} has no expected_ids`);
    }
    const ranked = [...new Set(await retrieve(testCase, k))].slice(0, k);
    const relevant = ranked.filter((id) => expected.has(id));
    if (relevant.length > 0) {
      hits += 1;
      reciprocalRank += 1 / (ranked.findIndex((id) => expected.has(id)) + 1);
    }
    recall += new Set(relevant).size / expected.size;
    const idealLength = Math.min(expected.size, k);
    const ideal = Array.from({ length: idealLength }, (_, index) => 1 / Math.log2(index + 2)).reduce(
      (sum, value) => sum + value,
      0
    );
    ndcg += ideal > 0 ? discountedGain(ranked, expected) / ideal : 0;
  }

  return {
    cases: cases.length,
    k,
    hit_rate_at_k: round(hits / cases.length),
    recall_at_k: round(recall / cases.length),
    mean_reciprocal_rank: round(reciprocalRank / cases.length),
    ndcg_at_k: round(ndcg / cases.length)
  };
}
