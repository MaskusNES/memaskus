import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MemoryDb } from "../db/connection.js";
import { listConflicts, resolveConflict, reviewConversation } from "../domain/review.js";

const reviewConversationSchema = z.object({
  conversation_id: z.string().optional(),
  project_id: z.string().optional(),
  text: z.string().min(1),
  analysis_mode: z.enum(["heuristic", "agent_supplied"]).optional(),
  agent_analysis: z
    .object({
      disagreements: z
        .array(
          z.object({
            user_text: z.string().min(1),
            assistant_context: z.string().optional(),
            reason_is_clear: z.boolean(),
            inferred_reason: z.string().optional(),
            demonstrated_preferences: z
              .array(
                z.union([
                  z.string().min(1),
                  z.object({
                    content: z.string().min(1),
                    confidence: z.number().min(0).max(1).optional(),
                    knowledge_scope: z.enum(["global", "project_local"]).optional(),
                    metadata: z.record(z.unknown()).optional()
                  })
                ])
              )
              .optional(),
            demonstrated_values: z.array(z.string().min(1)).optional(),
            confidence: z.number().min(0).max(1).optional(),
            clarification_question: z.string().optional()
          })
        )
        .optional()
    })
    .optional()
});

const resolveConflictSchema = z.object({
  action: z.enum(["accept_new", "keep_existing", "mark_compatible"]),
  note: z.string().optional()
});

export async function registerReviewRoutes(app: FastifyInstance, db: MemoryDb): Promise<void> {
  app.post("/v1/review/conversation", async (request, reply) => {
    const input = reviewConversationSchema.parse(request.body);
    const result = reviewConversation(db, input);
    return reply.code(201).send(result);
  });

  app.get("/v1/conflicts", async (request) => {
    const query = z.object({ status: z.string().optional() }).parse(request.query);
    return { conflicts: listConflicts(db, query.status ?? "open") };
  });

  app.post("/v1/conflicts/:id/resolve", async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = resolveConflictSchema.parse(request.body);
    return resolveConflict(db, params.id, input);
  });
}
