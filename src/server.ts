import cors from "@fastify/cors";
import Fastify from "fastify";
import { ZodError } from "zod";
import type { MemoryDb } from "./db/connection.js";
import { NotFoundError, ValidationError } from "./shared/errors.js";
import { registerCandidateRoutes } from "./routes/candidates.js";
import { registerGraphRoutes } from "./routes/graph.js";
import { registerExplorerRoutes } from "./routes/explorer.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerLinkRoutes } from "./routes/links.js";
import { registerMemoryRoutes } from "./routes/memories.js";
import { registerProfileRoutes } from "./routes/profile.js";
import { registerRecallRoutes } from "./routes/recall.js";
import { registerReviewRoutes } from "./routes/review.js";

function isAllowedBrowserOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return true;
  }

  try {
    const url = new URL(origin);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function requestApiKey(headers: Record<string, string | string[] | undefined>): string | undefined {
  const headerValue = headers["x-memory-api-key"];
  if (Array.isArray(headerValue)) {
    return headerValue[0];
  }

  if (headerValue) {
    return headerValue;
  }

  const authorization = headers.authorization;
  const authorizationValue = Array.isArray(authorization) ? authorization[0] : authorization;
  return authorizationValue?.startsWith("Bearer ") ? authorizationValue.slice("Bearer ".length) : undefined;
}

export async function buildServer(db: MemoryDb) {
  const app = Fastify({ logger: true });
  const apiKey = process.env.MEMORY_API_KEY;

  await app.register(cors, {
    origin: (origin, callback) => {
      callback(null, isAllowedBrowserOrigin(origin));
    }
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!apiKey || !request.url.startsWith("/v1/")) {
      return;
    }

    if (requestApiKey(request.headers) === apiKey) {
      return;
    }

    return reply.code(401).send({
      error: "unauthorized",
      message: "A valid MEMORY_API_KEY is required for memory API requests"
    });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "validation_error",
        issues: error.issues
      });
    }

    if (error instanceof NotFoundError) {
      return reply.code(404).send({
        error: "not_found",
        message: error.message
      });
    }

    if (error instanceof ValidationError) {
      return reply.code(400).send({
        error: "validation_error",
        message: error.message
      });
    }

    const requestError = error as { statusCode?: number; message?: string };
    if (
      typeof requestError.statusCode === "number" &&
      requestError.statusCode >= 400 &&
      requestError.statusCode < 500
    ) {
      return reply.code(requestError.statusCode).send({
        error: "request_error",
        message: requestError.message ?? "Invalid request"
      });
    }

    app.log.error(error);
    return reply.code(500).send({
      error: "internal_error",
      message: "Unexpected server error"
    });
  });

  app.get("/health", async () => ({ ok: true }));
  app.get("/ready", async (_request, reply) => {
    try {
      db.prepare("SELECT 1").get();
      const schemaVersion = db.pragma("user_version", { simple: true }) as number;
      return { ok: true, schema_version: schemaVersion };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  await registerMemoryRoutes(app, db);
  await registerProfileRoutes(app, db);
  await registerRecallRoutes(app, db);
  await registerLinkRoutes(app, db);
  await registerIngestRoutes(app, db);
  await registerCandidateRoutes(app, db);
  await registerGraphRoutes(app, db);
  await registerExplorerRoutes(app, db);
  await registerReviewRoutes(app, db);

  return app;
}
