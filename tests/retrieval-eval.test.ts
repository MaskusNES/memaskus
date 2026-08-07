import { describe, expect, it } from "vitest";
import { evaluateRetrieval, type RetrievalEvalCase } from "../src/domain/retrieval-eval.js";

describe("retrieval evaluation metrics", () => {
  it("computes hit rate, recall, reciprocal rank, and nDCG", async () => {
    const cases: RetrievalEvalCase[] = [
      { id: "first", query: "first", expected_ids: ["a"] },
      { id: "second", query: "second", expected_ids: ["b", "c"] }
    ];
    const rankings = new Map([
      ["first", ["x", "a", "b"]],
      ["second", ["z"]]
    ]);

    const metrics = await evaluateRetrieval(
      cases,
      async (testCase) => rankings.get(testCase.id ?? "") ?? [],
      3
    );

    expect(metrics).toEqual({
      cases: 2,
      k: 3,
      hit_rate_at_k: 0.5,
      recall_at_k: 0.5,
      mean_reciprocal_rank: 0.25,
      ndcg_at_k: 0.3155
    });
  });

  it("returns zeroed metrics for an empty dataset", async () => {
    await expect(evaluateRetrieval([], async () => [], 5)).resolves.toEqual({
      cases: 0,
      k: 5,
      hit_rate_at_k: 0,
      recall_at_k: 0,
      mean_reciprocal_rank: 0,
      ndcg_at_k: 0
    });
  });
});
