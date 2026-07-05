import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MemoryDb } from "../db/connection.js";
import { explainMemory } from "../domain/explain.js";
import { createRelatedLinksForMemory } from "../domain/links.js";
import { createMemory } from "../domain/nodes.js";
import { sourceSchema, scopeSchema } from "./schemas.js";

const createMemorySchema = z.object({
  type: z.string().min(1),
  content: z.string().min(1),
  scope: scopeSchema,
  confidence: z.number().min(0).max(1).optional(),
  privacy_level: z.enum(["normal", "sensitive", "secret"]).optional(),
  source: sourceSchema,
  metadata: z.record(z.unknown()).optional()
});

export async function registerMemoryRoutes(app: FastifyInstance, db: MemoryDb): Promise<void> {
  app.post("/v1/memories", async (request, reply) => {
    const input = createMemorySchema.parse(request.body);
    const memory = createMemory(db, input);
    createRelatedLinksForMemory(db, memory);
    return reply.code(201).send({ id: memory.id, status: memory.status, memory });
  });

  app.get("/v1/memories/:id/explain", async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    return explainMemory(db, params.id);
  });
}
