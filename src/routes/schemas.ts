import { z } from "zod";

export const scopeSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("global") }).strict(),
    z.object({ kind: z.literal("user"), user_id: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("project"), project_id: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("workspace"), workspace_id: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("agent"), agent_id: z.string().min(1) }).strict(),
    z
      .object({
        kind: z.literal("conversation"),
        conversation_id: z.string().min(1),
        user_id: z.string().min(1).optional(),
        project_id: z.string().min(1).optional(),
        workspace_id: z.string().min(1).optional(),
        agent_id: z.string().min(1).optional()
      })
      .strict()
  ])
  .optional();

export const sourceSchema = z
  .object({
    kind: z.string().min(1),
    external_id: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    content_excerpt: z.string().nullable().optional(),
    metadata: z.record(z.unknown()).optional()
  })
  .optional();

export const createMemorySchema = z.object({
  title: z.string().nullable().optional(),
  type: z.string().min(1),
  content: z.string().min(1),
  scope: scopeSchema,
  confidence: z.number().min(0).max(1).optional(),
  privacy_level: z.enum(["normal", "sensitive", "secret"]).optional(),
  source: sourceSchema,
  metadata: z.record(z.unknown()).optional()
});

export const explorerQuerySchema = z.object({
  q: z.string().optional(),
  project_id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
});
