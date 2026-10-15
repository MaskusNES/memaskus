import type { FastifyInstance } from "fastify";
import type { MemoryDb } from "../db/connection.js";
import { exploreMemory } from "../domain/explorer.js";
import { explorerQuerySchema } from "./schemas.js";

export async function registerExplorerRoutes(app: FastifyInstance, db: MemoryDb): Promise<void> {
  app.get("/v1/explorer", async (request) => exploreMemory(db, explorerQuerySchema.parse(request.query)));
}
