import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MemoryDb } from "../db/connection.js";
import { approveCandidate, listCandidates, rejectCandidate } from "../domain/candidates.js";

export async function registerCandidateRoutes(app: FastifyInstance, db: MemoryDb): Promise<void> {
  app.get("/v1/candidates", async (request) => {
    const query = z.object({ status: z.string().optional() }).parse(request.query);
    return { candidates: listCandidates(db, query.status ?? "pending") };
  });

  app.post("/v1/candidates/:id/approve", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const memory = approveCandidate(db, params.id);
    return reply.code(201).send({ id: memory.id, status: memory.status, memory });
  });

  app.post("/v1/candidates/:id/reject", async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    return rejectCandidate(db, params.id);
  });
}
