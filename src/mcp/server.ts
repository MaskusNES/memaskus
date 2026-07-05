import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createMemoryHttpClient, jsonToolResult, type MemoryHttpClient } from "./http-client.js";

const scopeSchema = {
  kind: z.enum(["global", "user", "project", "workspace", "agent", "conversation"]).optional(),
  user_id: z.string().optional(),
  project_id: z.string().optional(),
  workspace_id: z.string().optional(),
  agent_id: z.string().optional()
};

function normalizeScope(scope?: {
  kind?: "global" | "user" | "project" | "workspace" | "agent" | "conversation";
  user_id?: string;
  project_id?: string;
  workspace_id?: string;
  agent_id?: string;
}) {
  if (!scope) {
    return { kind: "global" };
  }

  if (!scope.kind && scope.project_id) {
    return { ...scope, kind: "project" };
  }

  return { ...scope, kind: scope.kind ?? "global" };
}

export function createMemoryMcpServer(client: MemoryHttpClient): McpServer {
  const server = new McpServer(
    {
      name: "agent-memory",
      version: "0.1.0"
    },
    {
      instructions:
        "Use this server to recall, store, review, and resolve graph memory for agent conversations. Review full dialogue text before durable writes when possible."
    }
  );

  server.registerTool(
    "memory_recall",
    {
      title: "Recall Memory",
      description: "Recall source-backed memories by query and optional scope.",
      inputSchema: {
        query: z.string().min(1),
        scope: z.object(scopeSchema).optional(),
        knowledge_scope: z.enum(["global", "project_local"]).optional(),
        types: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        include_sources: z.boolean().optional()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input) =>
      jsonToolResult(
        await client.request("/v1/recall", {
          method: "POST",
          body: JSON.stringify({
            ...input,
            scope: normalizeScope(input.scope)
          })
        })
      )
  );

  server.registerTool(
    "memory_remember",
    {
      title: "Remember",
      description: "Create one explicit active memory node. Prefer Russian for durable memory content unless the user explicitly asks for another language.",
      inputSchema: {
        type: z.string().min(1),
        content: z.string().min(1),
        scope: z.object(scopeSchema).optional(),
        confidence: z.number().min(0).max(1).optional(),
        privacy_level: z.enum(["normal", "sensitive", "secret"]).optional(),
        metadata: z.record(z.unknown()).optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input) =>
      jsonToolResult(
        await client.request("/v1/memories", {
          method: "POST",
          body: JSON.stringify({
            ...input,
            scope: normalizeScope(input.scope),
            source: {
              kind: "mcp",
              title: "Явная запись памяти через MCP"
            }
          })
        })
      )
  );

  server.registerTool(
    "memory_review_conversation",
    {
      title: "Review Conversation",
      description:
        "Save dialogue as a source, accept agent-supplied user-pushback analysis by default, return related graph memories as conflict_candidates for agent review, auto-store only non-conflicting or compatible memory, and return real contradictions for user resolution. Durable memory content in agent_analysis should be written in Russian unless the user explicitly asks for another language. Pass analysis_mode='heuristic' only for local fallback extraction.",
      inputSchema: {
        text: z.string().min(1),
        conversation_id: z.string().optional(),
        project_id: z.string().optional(),
        analysis_mode: z.enum(["heuristic", "agent_supplied"]).optional(),
        agent_analysis: z
          .object({
            disagreements: z
              .array(
                z.object({
                  user_text: z.string().min(1),
                  assistant_context: z.string().optional(),
                  reason_is_clear: z.boolean(),
                  inferred_reason: z.string().optional(),
                  demonstrated_preferences: z
                    .array(
                      z.union([
                        z.string().min(1),
                        z.object({
                          content: z.string().min(1),
                          confidence: z.number().min(0).max(1).optional(),
                          knowledge_scope: z.enum(["global", "project_local"]).optional(),
                          metadata: z.record(z.unknown()).optional()
                        })
                      ])
                    )
                    .optional(),
                  demonstrated_values: z.array(z.string().min(1)).optional(),
                  confidence: z.number().min(0).max(1).optional(),
                  clarification_question: z.string().optional()
                })
              )
              .optional()
          })
          .optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input) =>
      jsonToolResult(
        await client.request("/v1/review/conversation", {
          method: "POST",
          body: JSON.stringify({
            ...input,
            analysis_mode: input.analysis_mode ?? "agent_supplied"
          })
        })
      )
  );

  server.registerTool(
    "memory_list_conflicts",
    {
      title: "List Conflicts",
      description: "List open or resolved memory conflicts.",
      inputSchema: {
        status: z.enum(["open", "resolved"]).optional()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input) => {
      const params = new URLSearchParams();
      params.set("status", input.status ?? "open");
      return jsonToolResult(await client.request(`/v1/conflicts?${params.toString()}`));
    }
  );

  server.registerTool(
    "memory_resolve_conflict",
    {
      title: "Resolve Conflict",
      description: "Resolve a memory conflict after user clarification.",
      inputSchema: {
        id: z.string().min(1),
        action: z.enum(["accept_new", "keep_existing", "mark_compatible"]),
        note: z.string().optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input) =>
      jsonToolResult(
        await client.request(`/v1/conflicts/${encodeURIComponent(input.id)}/resolve`, {
          method: "POST",
          body: JSON.stringify({
            action: input.action,
            note: input.note
          })
        })
      )
  );

  server.registerTool(
    "memory_explain",
    {
      title: "Explain Memory",
      description: "Explain a memory by source evidence and graph links.",
      inputSchema: {
        id: z.string().min(1)
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input) => jsonToolResult(await client.request(`/v1/memories/${encodeURIComponent(input.id)}/explain`))
  );

  server.registerTool(
    "memory_graph",
    {
      title: "Graph Snapshot",
      description: "Return graph nodes and edges for optional project scope.",
      inputSchema: {
        project_id: z.string().optional(),
        status: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input) => {
      const params = new URLSearchParams();
      if (input.project_id) {
        params.set("project_id", input.project_id);
      }
      if (input.status) {
        params.set("status", input.status);
      }
      if (input.limit) {
        params.set("limit", String(input.limit));
      }

      const suffix = params.toString() ? `?${params.toString()}` : "";
      return jsonToolResult(await client.request(`/v1/graph${suffix}`));
    }
  );

  return server;
}

export async function runMemoryMcpServer(): Promise<void> {
  const baseUrl = process.env.MEMORY_API_URL ?? "http://127.0.0.1:3010";
  const client = createMemoryHttpClient(baseUrl);
  const server = createMemoryMcpServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runMemoryMcpServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
