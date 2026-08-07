import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MemoryDb } from "../src/db/connection.js";
import { createMemoryHttpClient } from "../src/mcp/http-client.js";
import { createMemoryMcpServer } from "../src/mcp/server.js";
import { buildServer } from "../src/server.js";

function toolResult<T>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  return (result.structuredContent as { result: T }).result;
}

describe("MCP memory adapter", () => {
  let db: MemoryDb;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let baseUrl: string;
  let client: Client;
  let mcpServer: ReturnType<typeof createMemoryMcpServer>;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    app = await buildServer(db);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    mcpServer = createMemoryMcpServer(createMemoryHttpClient(baseUrl));
    client = new Client({ name: "test-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await mcpServer.close();
    await app.close();
    db.close();
  });

  it("lists memory tools", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);

    expect(names).toContain("memory_recall");
    expect(names).toContain("memory_remember");
    expect(names).toContain("memory_review_conversation");
    expect(names).toContain("memory_resolve_conflict");
    expect(names).toContain("memory_get_profile");
    expect(names).toContain("memory_context");
    expect(names).toContain("memory_update_profile");
    expect(names).toContain("memory_list");
    expect(names).toContain("memory_update");
    expect(names).toContain("memory_feedback");
    expect(names).toContain("memory_archive");
    expect(names).toContain("memory_delete");
    expect(names).toContain("memory_list_candidates");
    expect(names).toContain("memory_approve_candidate");
    expect(names).toContain("memory_reject_candidate");
    expect(names).toContain("memory_merge_candidate");
  });

  it("remembers and recalls memory through MCP tools", async () => {
    await client.callTool({
      name: "memory_remember",
      arguments: {
        type: "Decision",
        content: "The MCP adapter stores explicit memories through the HTTP service.",
        scope: {
          project_id: "project:agent-memory"
        },
        confidence: 0.9
      }
    });

    const recall = await client.callTool({
      name: "memory_recall",
      arguments: {
        query: "MCP adapter HTTP service",
        scope: {
          project_id: "project:agent-memory"
        }
      }
    });

    expect(JSON.stringify(recall)).toContain("MCP adapter stores explicit memories");
  });

  it("reviews conversation and resolves conflicts through MCP", async () => {
    await client.callTool({
      name: "memory_remember",
      arguments: {
        type: "Decision",
        content: "The MVP will use SQLite as storage.",
        scope: {
          project_id: "project:agent-memory"
        },
        confidence: 0.95
      }
    });

    const review = await client.callTool({
      name: "memory_review_conversation",
      arguments: {
        conversation_id: "conv:mcp-test",
        project_id: "project:agent-memory",
        analysis_mode: "heuristic",
        text: "User: We decided to use PostgreSQL as storage."
      }
    });

    const reviewBody = toolResult<{
      conflicts: Array<{ id: string }>;
      summary: { blocked: number; conflicts: number };
    }>(review);

    expect(JSON.stringify(review)).toContain("кажутся противоречивыми");
    expect(JSON.stringify(review)).toContain("blocked");
    expect(reviewBody.summary).toMatchObject({ blocked: 1, conflicts: 1 });

    const resolution = await client.callTool({
      name: "memory_resolve_conflict",
      arguments: {
        id: reviewBody.conflicts[0].id,
        action: "accept_new",
        note: "The database choice changed during planning."
      }
    });

    expect(JSON.stringify(resolution)).toContain("approved");

    const recall = await client.callTool({
      name: "memory_recall",
      arguments: {
        query: "PostgreSQL storage",
        scope: {
          project_id: "project:agent-memory"
        }
      }
    });

    expect(JSON.stringify(recall)).toContain("We decided to use PostgreSQL as storage.");
  });

  it("defaults MCP preference review to agent-supplied analysis", async () => {
    const review = await client.callTool({
      name: "memory_review_conversation",
      arguments: {
        conversation_id: "conv:mcp-agent-supplied-default",
        project_id: "project:agent-memory",
        text: [
          "Assistant: The MCP is configured, so it should be available now.",
          "User: No, I still do not see the agent_memory tool. Why is it unavailable?"
        ].join("\n")
      }
    });

    const reviewBody = toolResult<{
      preference_review: {
        summary: {
          disagreements: number;
          preference_candidates: number;
        };
      };
    }>(review);

    expect(reviewBody.preference_review.summary).toMatchObject({
      disagreements: 0,
      preference_candidates: 0
    });
  });

  it("updates and reads mutable profile context through MCP", async () => {
    await client.callTool({
      name: "memory_update_profile",
      arguments: {
        topic: "github",
        sub_topic: "repository_visibility",
        content: "GitHub repositories should be private by default.",
        confidence: 0.98,
        knowledge_scope: "global"
      }
    });

    const profile = await client.callTool({
      name: "memory_get_profile",
      arguments: {
        knowledge_scope: "global",
        topics: ["github"]
      }
    });

    expect(JSON.stringify(profile)).toContain("private by default");

    const context = await client.callTool({
      name: "memory_context",
      arguments: {
        prefer_topics: ["github"]
      }
    });

    expect(JSON.stringify(context)).toContain("User profile memory");
    expect(JSON.stringify(context)).toContain("private by default");
  });
});
