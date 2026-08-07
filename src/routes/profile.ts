import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MemoryDb } from "../db/connection.js";
import {
  archiveProfileSlot,
  buildProfileContext,
  ensureUser,
  getProfileSlot,
  listProfileSlotRevisions,
  listProfileSlots,
  patchProfileSlot,
  upsertProfileSlot
} from "../domain/profile.js";
import { publicProfileRevision, publicProfileSlot } from "../domain/privacy.js";

const knowledgeScopeSchema = z.enum(["global", "project_local"]);
const privacyLevelSchema = z.enum(["normal", "sensitive", "secret"]);

const profileQuerySchema = z.object({
  user_id: z.string().optional(),
  project_id: z.string().optional(),
  knowledge_scope: knowledgeScopeSchema.optional(),
  status: z.enum(["active", "archived", "deleted"]).optional(),
  topics: z.union([z.string(), z.array(z.string())]).optional(),
  include_sources: z.coerce.boolean().optional()
});

const userSchema = z.object({
  id: z.string().optional(),
  display_name: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional()
});

const upsertSlotSchema = z.object({
  user_id: z.string().optional(),
  topic: z.string().min(1),
  sub_topic: z.string().min(1).optional(),
  content: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  knowledge_scope: knowledgeScopeSchema.optional(),
  project_id: z.string().optional(),
  privacy_level: privacyLevelSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
  source_id: z.string().optional(),
  evidence_text: z.string().optional(),
  candidate_id: z.string().optional(),
  memory_id: z.string().optional(),
  reason: z.string().optional()
});

const patchSlotSchema = z.object({
  content: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  privacy_level: privacyLevelSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
  source_id: z.string().optional(),
  evidence_text: z.string().optional(),
  candidate_id: z.string().optional(),
  memory_id: z.string().optional(),
  reason: z.string().optional()
});

const archiveSchema = z.object({
  reason: z.string().optional()
});

const contextSchema = z.object({
  user_id: z.string().optional(),
  project_id: z.string().optional(),
  knowledge_scope: knowledgeScopeSchema.optional(),
  topics: z.array(z.string()).optional(),
  max_items: z.number().int().min(1).max(100).optional(),
  max_chars: z.number().int().min(200).max(20000).optional(),
  prefer_topics: z.array(z.string()).optional()
});

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8"
};

function normalizeTopics(input: string | string[] | undefined): string[] | undefined {
  if (!input) {
    return undefined;
  }
  return Array.isArray(input) ? input : input.split(",").map((topic) => topic.trim()).filter(Boolean);
}

async function sendPublicFile(reply: { type: (value: string) => unknown; send: (value: string) => unknown }, fileName: string) {
  const filePath = path.resolve("public", fileName);
  const extension = path.extname(fileName);
  const content = await fs.readFile(filePath, "utf8");
  reply.type(contentTypes[extension] ?? "text/plain; charset=utf-8");
  return reply.send(content);
}

export async function registerProfileRoutes(app: FastifyInstance, db: MemoryDb): Promise<void> {
  app.post("/v1/profile/users", async (request, reply) => {
    const input = userSchema.parse(request.body);
    const user = ensureUser(db, input);
    return reply.code(201).send({ user });
  });

  app.get("/v1/profile", async (request) => {
    const query = profileQuerySchema.parse(request.query);
    return {
      slots: listProfileSlots(db, {
        ...query,
        topics: normalizeTopics(query.topics)
      }).map(publicProfileSlot)
    };
  });

  app.post("/v1/profile/slots", async (request, reply) => {
    const input = upsertSlotSchema.parse(request.body);
    const slot = upsertProfileSlot(db, input);
    return reply.code(201).send({ id: slot.id, slot: publicProfileSlot(slot) });
  });

  app.get("/v1/profile/slots/:id", async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const slot = getProfileSlot(db, params.id);
    return {
      slot: publicProfileSlot(slot),
      revisions: listProfileSlotRevisions(db, params.id).map((revision) =>
        publicProfileRevision(revision, slot.privacy_level)
      )
    };
  });

  app.patch("/v1/profile/slots/:id", async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = patchSlotSchema.parse(request.body);
    return { slot: publicProfileSlot(patchProfileSlot(db, params.id, input)) };
  });

  app.post("/v1/profile/slots/:id/archive", async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = archiveSchema.parse(request.body ?? {});
    return { slot: publicProfileSlot(archiveProfileSlot(db, params.id, input.reason)) };
  });

  app.post("/v1/profile/context", async (request) => {
    const input = contextSchema.parse(request.body ?? {});
    return buildProfileContext(db, input);
  });

  app.get("/profile", async (_request, reply) => sendPublicFile(reply, "profile.html"));
  app.get("/profile/styles.css", async (_request, reply) => sendPublicFile(reply, "profile.css"));
  app.get("/profile/app.js", async (_request, reply) => sendPublicFile(reply, "profile.js"));
}
