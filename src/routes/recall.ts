import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MemoryDb } from "../db/connection.js";
import type { EmbeddingProvider } from "../domain/embeddings.js";
import { recall } from "../domain/recall.js";
import { scopeSchema } from "./schemas.js";

const recallSchema = z.object({
  query: z.string().min(1),
  scope: scopeSchema,
  knowledge_scope: z.enum(["global", "project_local"]).optional(),
  types: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  include_sources: z.boolean().optional()
});

export async function registerRecallRoutes(
  app: FastifyInstance,
  db: MemoryDb,
  embeddingProvider?: EmbeddingProvider
): Promise<void> {
  app.post("/v1/recall", async (request) => {
    const input = recallSchema.parse(request.body);
    return {
      results: await recall(db, input, {
        embeddingProvider,
        onSemanticError: (error) => app.log.warn({ err: error }, "semantic recall degraded to local retrieval")
      })
    };
  });
}
