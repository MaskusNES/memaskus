import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MemoryDb } from "../db/connection.js";
import { getFileDescriptor, readFileBytes, storeFile } from "../domain/files.js";
import { ValidationError } from "../shared/errors.js";
import { publicMemory } from "../domain/privacy.js";
import { scopeSchema } from "./schemas.js";

export const FILES_BODY_LIMIT = 16 * 1024 * 1024;

const createFileSchema = z.object({
  content_base64: z.string().min(1),
  filename: z.string().min(1).max(300),
  description: z.string().min(1).max(2000),
  mime_type: z.string().min(1).max(200).optional(),
  scope: scopeSchema,
  confidence: z.number().min(0).max(1).optional(),
  privacy_level: z.enum(["normal", "sensitive", "secret"]).optional(),
  metadata: z.record(z.unknown()).optional(),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/u, "sha256 must be a 64-character hex string").optional()
});

const paramsSchema = z.object({ id: z.string().min(1) });

export function decodeBase64(value: string): Buffer {
  const compact = value.replace(/\s+/gu, "");
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(compact)) {
    throw new ValidationError("content_base64 is not valid base64");
  }
  const bytes = Buffer.from(compact, "base64");
  if (bytes.toString("base64") !== compact) {
    throw new ValidationError("content_base64 is not valid base64");
  }
  return bytes;
}

export async function registerFileRoutes(app: FastifyInstance, db: MemoryDb, filesDir: string): Promise<void> {
  app.post("/v1/files", { bodyLimit: FILES_BODY_LIMIT }, async (request, reply) => {
    const input = createFileSchema.parse(request.body);
    const bytes = decodeBase64(input.content_base64);
    const { file, memory } = storeFile(db, filesDir, {
      bytes,
      originalName: input.filename,
      description: input.description,
      mimeType: input.mime_type,
      scope: input.scope,
      confidence: input.confidence,
      metadata: input.metadata,
      privacyLevel: input.privacy_level,
      expectedSha256: input.sha256
    });
    return reply.code(201).send({ file, memory: publicMemory(memory) });
  });

  app.get("/v1/files/:id", async (request) => {
    const params = paramsSchema.parse(request.params);
    return { file: getFileDescriptor(db, params.id) };
  });

  app.get("/v1/files/:id/content", async (request, reply) => {
    const params = paramsSchema.parse(request.params);
    const { bytes, descriptor } = readFileBytes(db, filesDir, params.id);
    reply.header(
      "content-disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(descriptor.original_name)}`
    );
    return reply.type(descriptor.mime_type).send(bytes);
  });
}
