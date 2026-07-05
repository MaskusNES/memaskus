import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MemoryDb } from "../db/connection.js";
import { getGraph } from "../domain/graph.js";

const graphQuerySchema = z.object({
  project_id: z.string().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional()
});

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8"
};

async function sendPublicFile(reply: { type: (value: string) => unknown; send: (value: string) => unknown }, fileName: string) {
  const filePath = path.resolve("public", fileName);
  const extension = path.extname(fileName);
  const content = await fs.readFile(filePath, "utf8");
  reply.type(contentTypes[extension] ?? "text/plain; charset=utf-8");
  return reply.send(content);
}

export async function registerGraphRoutes(app: FastifyInstance, db: MemoryDb): Promise<void> {
  app.get("/v1/graph", async (request) => {
    const query = graphQuerySchema.parse(request.query);
    return getGraph(db, query);
  });

  app.get("/graph", async (_request, reply) => sendPublicFile(reply, "graph.html"));
  app.get("/graph/styles.css", async (_request, reply) => sendPublicFile(reply, "graph.css"));
  app.get("/graph/app.js", async (_request, reply) => sendPublicFile(reply, "graph.js"));
}
