import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MemoryDb } from "../db/connection.js";
import { createLink } from "../domain/links.js";

const createLinkSchema = z.object({
  from_id: z.string().min(1),
  to_id: z.string().min(1),
  relation: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  metadata: z.record(z.unknown()).optional()
});

export async function registerLinkRoutes(app: FastifyInstance, db: MemoryDb): Promise<void> {
  app.post("/v1/links", async (request, reply) => {
    const input = createLinkSchema.parse(request.body);
    const edge = createLink(db, input);
    return reply.code(201).send(edge);
  });
}
