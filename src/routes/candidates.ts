import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MemoryDb } from "../db/connection.js";
import {
  approveCandidate,
  listCandidatesByStatuses,
  mergeCandidate,
  patchCandidate,
  rejectCandidate
} from "../domain/candidates.js";
import { publicCandidate, publicMemory } from "../domain/privacy.js";
import { scopeSchema } from "./schemas.js";

const candidateStatusSchema = z.enum(["pending", "blocked", "approved", "rejected", "merged"]);
const patchCandidateSchema = z.object({
  type: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  scope: scopeSchema,
  confidence: z.number().min(0).max(1).optional(),
  privacy_level: z.enum(["normal", "sensitive", "secret"]).optional(),
  metadata: z.record(z.unknown()).optional()
});

export async function registerCandidateRoutes(app: FastifyInstance, db: MemoryDb): Promise<void> {
  app.get("/v1/candidates", async (request) => {
    const query = z.object({ status: z.string().optional() }).parse(request.query);
    const statuses = (query.status ?? "pending")
      .split(",")
      .map((status) => candidateStatusSchema.parse(status.trim()));
    return { candidates: listCandidatesByStatuses(db, statuses).map(publicCandidate) };
  });

  app.patch("/v1/candidates/:id", async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = patchCandidateSchema.parse(request.body);
    return { candidate: publicCandidate(patchCandidate(db, params.id, input)) };
  });

  app.post("/v1/candidates/:id/approve", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const memory = approveCandidate(db, params.id);
    return reply.code(201).send({ id: memory.id, status: memory.status, memory: publicMemory(memory) });
  });

  app.post("/v1/candidates/:id/reject", async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    return publicCandidate(rejectCandidate(db, params.id));
  });

  app.post("/v1/candidates/:id/merge", async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = z.object({ memory_id: z.string().min(1) }).parse(request.body);
    const result = mergeCandidate(db, params.id, input.memory_id);
    return {
      candidate: publicCandidate(result.candidate),
      memory: publicMemory(result.memory)
    };
  });
}
