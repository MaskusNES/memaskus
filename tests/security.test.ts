import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MemoryDb } from "../src/db/connection.js";
import { buildServer } from "../src/server.js";

describe("HTTP API security controls", () => {
  let db: MemoryDb;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let previousApiKey: string | undefined;

  beforeEach(async () => {
    previousApiKey = process.env.MEMORY_API_KEY;
    process.env.MEMORY_API_KEY = "test-key";
    db = openDatabase(":memory:");
    app = await buildServer(db);
  });

  afterEach(async () => {
    await app.close();
    db.close();
    if (previousApiKey === undefined) {
      delete process.env.MEMORY_API_KEY;
    } else {
      process.env.MEMORY_API_KEY = previousApiKey;
    }
  });

  it("requires the configured API key for write requests", async () => {
    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Fact",
        content: "Unauthorized write should fail.",
        scope: { kind: "global" }
      }
    });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({
      method: "POST",
      url: "/v1/memories",
      headers: {
        "x-memory-api-key": "test-key"
      },
      payload: {
        type: "Fact",
        content: "Authorized write should pass.",
        scope: { kind: "global" }
      }
    });
    expect(authorized.statusCode).toBe(201);
  });
});
