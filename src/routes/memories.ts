import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MemoryDb } from "../db/connection.js";
import { explainMemory } from "../domain/explain.js";
import { createRelatedLinksForMemory } from "../domain/links.js";
import {
  addMemoryFeedback,
  archiveMemory,
  forgetMemory,
  listMemories,
  listMemoryFeedback,
  listMemoryRevisions,
  updateMemory
} from "../domain/memory-lifecycle.js";
import { createMemory } from "../domain/nodes.js";
import { publicMemory, publicMemoryRevision } from "../domain/privacy.js";
import type { Scope } from "../domain/types.js";
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

const memoryStatusSchema = z.enum(["candidate", "active", "superseded", "archived", "deleted"]);
const memoryQuerySchema = z.object({
  q: z.string().optional(),
  status: memoryStatusSchema.optional(),
  types: z.string().optional(),
  scope_kind: z.enum(["global", "user", "project", "workspace", "agent", "conversation"]).optional(),
  user_id: z.string().optional(),
  project_id: z.string().optional(),
  workspace_id: z.string().optional(),
  agent_id: z.string().optional(),
  conversation_id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional()
});
const updateMemorySchema = z.object({
  content: z.string().min(1).optional(),
  scope: scopeSchema,
  confidence: z.number().min(0).max(1).optional(),
  privacy_level: z.enum(["normal", "sensitive", "secret"]).optional(),
  metadata: z.record(z.unknown()).optional(),
  reason: z.string().min(1).optional()
});
const feedbackSchema = z.object({
  rating: z.enum(["correct", "wrong", "outdated", "too_broad", "too_narrow"]),
  comment: z.string().optional(),
  action: z.string().optional()
});
const reasonSchema = z.object({ reason: z.string().optional() });

function scopeFromQuery(query: z.infer<typeof memoryQuerySchema>): Scope | undefined {
  if (!query.scope_kind) {
    return undefined;
  }
  const identityByKind = {
    global: {},
    user: { user_id: query.user_id },
    project: { project_id: query.project_id },
    workspace: { workspace_id: query.workspace_id },
    agent: { agent_id: query.agent_id },
    conversation: {
      conversation_id: query.conversation_id,
      user_id: query.user_id,
      project_id: query.project_id,
      workspace_id: query.workspace_id,
      agent_id: query.agent_id
    }
  } as const;
  return scopeSchema.parse({ kind: query.scope_kind, ...identityByKind[query.scope_kind] });
}

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8"
};

async function sendPublicFile(
  reply: { type: (value: string) => unknown; send: (value: string) => unknown },
  fileName: string
) {
  const filePath = path.resolve("public", fileName);
  const extension = path.extname(fileName);
  const content = await fs.readFile(filePath, "utf8");
  reply.type(contentTypes[extension] ?? "text/plain; charset=utf-8");
  return reply.send(content);
}

export async function registerMemoryRoutes(app: FastifyInstance, db: MemoryDb): Promise<void> {
  app.get("/v1/memories", async (request) => {
    const query = memoryQuerySchema.parse(request.query);
    const result = listMemories(db, {
      query: query.q,
      status: query.status,
      types: query.types?.split(",").map((type) => type.trim()).filter(Boolean),
      scope: scopeFromQuery(query),
      limit: query.limit,
      offset: query.offset
    });
    return { ...result, memories: result.memories.map(publicMemory) };
  });

  app.post("/v1/memories", async (request, reply) => {
    const input = createMemorySchema.parse(request.body);
    const memory = createMemory(db, input);
    createRelatedLinksForMemory(db, memory);
    return reply.code(201).send({ id: memory.id, status: memory.status, memory: publicMemory(memory) });
  });

  app.get("/v1/memories/:id/explain", async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const explanation = explainMemory(db, params.id);
    return {
      ...explanation,
      revisions: listMemoryRevisions(db, params.id).map((revision) =>
        publicMemoryRevision(revision, explanation.memory.privacy_level)
      ),
      feedback: listMemoryFeedback(db, params.id)
    };
  });

  app.patch("/v1/memories/:id", async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = updateMemorySchema.parse(request.body);
    return { memory: publicMemory(updateMemory(db, params.id, input)) };
  });

  app.post("/v1/memories/:id/feedback", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = feedbackSchema.parse(request.body);
    return reply.code(201).send({ feedback: addMemoryFeedback(db, params.id, input) });
  });

  app.post("/v1/memories/:id/archive", async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = reasonSchema.parse(request.body ?? {});
    return { memory: publicMemory(archiveMemory(db, params.id, input.reason)) };
  });

  app.delete("/v1/memories/:id", async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = reasonSchema.parse(request.body ?? {});
    return { memory: publicMemory(forgetMemory(db, params.id, input.reason)) };
  });

  app.get("/", async (_request, reply) => reply.redirect("/memory"));
  app.get("/memory", async (_request, reply) => sendPublicFile(reply, "memory.html"));
  app.get("/memory/styles.css", async (_request, reply) => sendPublicFile(reply, "memory.css"));
  app.get("/memory/app.js", async (_request, reply) => sendPublicFile(reply, "memory.js"));
}
