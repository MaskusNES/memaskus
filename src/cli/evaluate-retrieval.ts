import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { openDatabase } from "../db/connection.js";
import { createEmbeddingProviderFromEnv } from "../domain/embeddings.js";
import { recall } from "../domain/recall.js";
import { evaluateRetrieval } from "../domain/retrieval-eval.js";
import { scopeSchema } from "../routes/schemas.js";

const evalCaseSchema = z.object({
  id: z.string().min(1).optional(),
  query: z.string().min(1),
  scope: scopeSchema,
  knowledge_scope: z.enum(["global", "project_local"]).optional(),
  types: z.array(z.string().min(1)).optional(),
  expected_ids: z.array(z.string().min(1)).min(1)
});

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("limit must be a positive integer");
  }
  return parsed;
}

const program = new Command()
  .name("evaluate-retrieval")
  .requiredOption("--dataset <path>", "JSON file with retrieval evaluation cases")
  .option("--db <path>", "SQLite database path", process.env.MEMORY_DB_PATH ?? path.resolve("data", "memory.sqlite"))
  .option("-k, --limit <number>", "retrieval cutoff", positiveInteger, 10)
  .parse();

const options = program.opts<{ dataset: string; db: string; limit: number }>();
const cases = z.array(evalCaseSchema).parse(JSON.parse(await fs.readFile(path.resolve(options.dataset), "utf8")));
const db = openDatabase(path.resolve(options.db));
try {
  const embeddingProvider = createEmbeddingProviderFromEnv();
  const metrics = await evaluateRetrieval(
    cases,
    async (testCase, k) =>
      (
        await recall(
          db,
          {
            query: testCase.query,
            scope: testCase.scope,
            knowledge_scope: testCase.knowledge_scope,
            types: testCase.types,
            limit: k
          },
          { embeddingProvider }
        )
      ).map((result) => result.id),
    options.limit
  );
  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
} finally {
  db.close();
}
