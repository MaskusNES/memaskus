import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MemoryDb } from "../db/connection.js";
import { ingestConversation } from "../domain/candidates.js";

const ingestConversationSchema = z.object({
  conversation_id: z.string().optional(),
  project_id: z.string().optional(),
  text: z.string().min(1)
});

export async function registerIngestRoutes(app: FastifyInstance, db: MemoryDb): Promise<void> {
  app.post("/v1/ingest/conversation", async (request, reply) => {
    const input = ingestConversationSchema.parse(request.body);
    const result = ingestConversation(db, input);
    return reply.code(201).send(result);
  });
}
