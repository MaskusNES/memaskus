import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MemoryDb } from "../db/connection.js";
import { listConflicts, resolveConflict, reviewConversation } from "../domain/review.js";
import {
  publicCandidate,
  publicConflict,
  publicMemory,
  publicProfileSlot
} from "../domain/privacy.js";
import { redactSecrets } from "../domain/privacy.js";

const reviewConversationSchema = z.object({
  conversation_id: z.string().optional(),
  project_id: z.string().optional(),
  text: z.string().min(1),
  analysis_mode: z.enum(["heuristic", "agent_supplied"]).optional(),
  agent_analysis: z
    .object({
      profile_updates: z
        .array(
          z.object({
            user_id: z.string().optional(),
            topic: z.string().min(1),
            sub_topic: z.string().min(1).optional(),
            content: z.string().min(1),
            confidence: z.number().min(0).max(1).optional(),
            knowledge_scope: z.enum(["global", "project_local"]).optional(),
            project_id: z.string().optional(),
            privacy_level: z.enum(["normal", "sensitive", "secret"]).optional(),
            metadata: z.record(z.unknown()).optional(),
            evidence_text: z.string().optional(),
            reason: z.string().optional()
          })
        )
        .optional(),
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
    return reply.code(201).send({
      ...result,
      profile_updates: result.profile_updates.map(publicProfileSlot),
      approved: result.approved.map(publicMemory),
      blocked: result.blocked.map(publicCandidate),
      pending_confirmation: result.pending_confirmation.map(publicCandidate),
      conflict_candidates: result.conflict_candidates.map(publicConflict),
      conflicts: result.conflicts.map(publicConflict),
      preference_review: {
        ...result.preference_review,
        disagreements: result.preference_review.disagreements.map((item) => ({
          ...item,
          user_text: redactSecrets(item.user_text),
          assistant_context: item.assistant_context ? redactSecrets(item.assistant_context) : item.assistant_context,
          inferred_reason: item.inferred_reason ? redactSecrets(item.inferred_reason) : item.inferred_reason,
          demonstrated_preferences: item.demonstrated_preferences.map((preference) => ({
            ...preference,
            content: redactSecrets(preference.content)
          })),
          demonstrated_values: item.demonstrated_values.map(redactSecrets),
          clarification_question: item.clarification_question
            ? redactSecrets(item.clarification_question)
            : item.clarification_question
        })),
        preference_candidates: result.preference_review.preference_candidates.map(publicCandidate),
        approved: result.preference_review.approved.map(publicMemory),
        blocked: result.preference_review.blocked.map(publicCandidate),
        conflict_candidates: result.preference_review.conflict_candidates.map(publicConflict),
        conflicts: result.preference_review.conflicts.map(publicConflict)
      }
    });
  });

  app.get("/v1/conflicts", async (request) => {
    const query = z.object({ status: z.string().optional() }).parse(request.query);
    return { conflicts: listConflicts(db, query.status ?? "open").map(publicConflict) };
  });

  app.post("/v1/conflicts/:id/resolve", async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = resolveConflictSchema.parse(request.body);
    const result = resolveConflict(db, params.id, input);
    return {
      ...result,
      conflict: publicConflict(result.conflict),
      candidate: publicCandidate(result.candidate),
      memory: result.memory ? publicMemory(result.memory) : result.memory
    };
  });
}
