import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createMemoryHttpClient, jsonToolResult, type MemoryHttpClient } from "./http-client.js";
import type { Scope } from "../domain/types.js";

const scopeInputSchema = z.union([
  z.object({ kind: z.literal("global") }).strict(),
  z.object({ kind: z.literal("user"), user_id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("project"), project_id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("workspace"), workspace_id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("agent"), agent_id: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("conversation"),
      conversation_id: z.string().min(1),
      user_id: z.string().min(1).optional(),
      project_id: z.string().min(1).optional(),
      workspace_id: z.string().min(1).optional(),
      agent_id: z.string().min(1).optional()
    })
    .strict(),
  z.object({ project_id: z.string().min(1) }).strict(),
  z.object({ conversation_id: z.string().min(1) }).strict()
]);

function normalizeScope(scope?: z.infer<typeof scopeInputSchema>): Scope {
  if (!scope) {
    return { kind: "global" };
  }

  if (!("kind" in scope) && "project_id" in scope) {
    return { kind: "project", project_id: scope.project_id };
  }

  if (!("kind" in scope) && "conversation_id" in scope) {
    return { kind: "conversation", conversation_id: scope.conversation_id };
  }

  return scope as Scope;
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
        scope: scopeInputSchema.optional(),
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
        scope: scopeInputSchema.optional(),
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
            profile_updates: z
              .array(
                z.object({
                  user_id: z.string().optional(),
                  topic: z.string().min(1),
                  sub_topic: z.string().optional(),
                  content: z.string().min(1),
                  confidence: z.number().min(0).max(1).optional(),
                  knowledge_scope: z.enum(["global", "project_local"]).optional(),
                  project_id: z.string().optional(),
                  privacy_level: z.enum(["normal", "sensitive", "secret"]).optional(),
                  metadata: z.record(z.unknown()).optional(),
                  evidence_text: z.string().optional(),
                  reason: z.string().optional()
                })
              )
              .optional(),
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
    "memory_list",
    {
      title: "List Memories",
      description: "List and search memories in a safe explicit scope.",
      inputSchema: {
        query: z.string().optional(),
        status: z.enum(["candidate", "active", "superseded", "archived", "deleted"]).optional(),
        types: z.array(z.string()).optional(),
        scope: scopeInputSchema.optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input) => {
      const scope = normalizeScope(input.scope);
      const params = new URLSearchParams();
      if (input.query) params.set("q", input.query);
      if (input.status) params.set("status", input.status);
      if (input.types?.length) params.set("types", input.types.join(","));
      params.set("scope_kind", scope.kind);
      if (scope.user_id) params.set("user_id", scope.user_id);
      if (scope.project_id) params.set("project_id", scope.project_id);
      if (scope.workspace_id) params.set("workspace_id", scope.workspace_id);
      if (scope.agent_id) params.set("agent_id", scope.agent_id);
      if (scope.conversation_id) params.set("conversation_id", scope.conversation_id);
      if (input.limit) params.set("limit", String(input.limit));
      if (input.offset) params.set("offset", String(input.offset));
      return jsonToolResult(await client.request(`/v1/memories?${params.toString()}`));
    }
  );

  server.registerTool(
    "memory_update",
    {
      title: "Correct Memory",
      description: "Correct an active memory, optionally narrowing its scope, and preserve a revision.",
      inputSchema: {
        id: z.string().min(1),
        content: z.string().min(1).optional(),
        scope: scopeInputSchema.optional(),
        confidence: z.number().min(0).max(1).optional(),
        privacy_level: z.enum(["normal", "sensitive", "secret"]).optional(),
        metadata: z.record(z.unknown()).optional(),
        reason: z.string().min(1)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ id, ...input }) =>
      jsonToolResult(
        await client.request(`/v1/memories/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({
            ...input,
            scope: input.scope ? normalizeScope(input.scope) : undefined
          })
        })
      )
  );

  server.registerTool(
    "memory_feedback",
    {
      title: "Memory Feedback",
      description: "Record whether a memory is correct, wrong, outdated, or scoped too broadly or narrowly.",
      inputSchema: {
        id: z.string().min(1),
        rating: z.enum(["correct", "wrong", "outdated", "too_broad", "too_narrow"]),
        comment: z.string().optional(),
        action: z.string().optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ id, ...input }) =>
      jsonToolResult(
        await client.request(`/v1/memories/${encodeURIComponent(id)}/feedback`, {
          method: "POST",
          body: JSON.stringify(input)
        })
      )
  );

  server.registerTool(
    "memory_archive",
    {
      title: "Archive Memory",
      description: "Archive a memory while preserving its audit history.",
      inputSchema: { id: z.string().min(1), reason: z.string().optional() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input) =>
      jsonToolResult(
        await client.request(`/v1/memories/${encodeURIComponent(input.id)}/archive`, {
          method: "POST",
          body: JSON.stringify({ reason: input.reason })
        })
      )
  );

  server.registerTool(
    "memory_delete",
    {
      title: "Forget Memory",
      description: "Delete user-visible memory content and its direct evidence links.",
      inputSchema: { id: z.string().min(1), reason: z.string().optional() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input) =>
      jsonToolResult(
        await client.request(`/v1/memories/${encodeURIComponent(input.id)}`, {
          method: "DELETE",
          body: JSON.stringify({ reason: input.reason })
        })
      )
  );

  server.registerTool(
    "memory_get_profile",
    {
      title: "Get User Profile",
      description: "Return active mutable user profile slots. Use this for stable user preferences and opinions.",
      inputSchema: {
        user_id: z.string().optional(),
        project_id: z.string().optional(),
        knowledge_scope: z.enum(["global", "project_local"]).optional(),
        topics: z.array(z.string()).optional()
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
      if (input.user_id) {
        params.set("user_id", input.user_id);
      }
      if (input.project_id) {
        params.set("project_id", input.project_id);
      }
      if (input.knowledge_scope) {
        params.set("knowledge_scope", input.knowledge_scope);
      }
      for (const topic of input.topics ?? []) {
        params.append("topics", topic);
      }
      const suffix = params.toString() ? `?${params.toString()}` : "";
      return jsonToolResult(await client.request(`/v1/profile${suffix}`));
    }
  );

  server.registerTool(
    "memory_context",
    {
      title: "Build Memory Context",
      description:
        "Return prompt-ready mutable user profile context. Prefer this over broad recall when bootstrapping future sessions.",
      inputSchema: {
        user_id: z.string().optional(),
        project_id: z.string().optional(),
        knowledge_scope: z.enum(["global", "project_local"]).optional(),
        topics: z.array(z.string()).optional(),
        prefer_topics: z.array(z.string()).optional(),
        max_items: z.number().int().min(1).max(100).optional(),
        max_chars: z.number().int().min(200).max(20000).optional()
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
        await client.request("/v1/profile/context", {
          method: "POST",
          body: JSON.stringify(input)
        })
      )
  );

  server.registerTool(
    "memory_update_profile",
    {
      title: "Update User Profile",
      description:
        "Create or update one mutable user profile slot. Use for explicit user preferences or after conflict resolution.",
      inputSchema: {
        user_id: z.string().optional(),
        topic: z.string().min(1),
        sub_topic: z.string().optional(),
        content: z.string().min(1),
        confidence: z.number().min(0).max(1).optional(),
        knowledge_scope: z.enum(["global", "project_local"]).optional(),
        project_id: z.string().optional(),
        privacy_level: z.enum(["normal", "sensitive", "secret"]).optional(),
        metadata: z.record(z.unknown()).optional(),
        reason: z.string().optional()
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
        await client.request("/v1/profile/slots", {
          method: "POST",
          body: JSON.stringify(input)
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
    "memory_list_candidates",
    {
      title: "List Memory Candidates",
      description: "List candidate memories awaiting review or blocked by conflicts.",
      inputSchema: {
        statuses: z.array(z.enum(["pending", "blocked", "approved", "rejected", "merged"])).optional()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input) => {
      const statuses = input.statuses?.length ? input.statuses : ["pending", "blocked"];
      const params = new URLSearchParams({ status: statuses.join(",") });
      return jsonToolResult(await client.request(`/v1/candidates?${params.toString()}`));
    }
  );

  server.registerTool(
    "memory_approve_candidate",
    {
      title: "Approve Memory Candidate",
      description: "Approve one pending candidate as active memory.",
      inputSchema: { id: z.string().min(1) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input) =>
      jsonToolResult(
        await client.request(`/v1/candidates/${encodeURIComponent(input.id)}/approve`, {
          method: "POST",
          body: "{}"
        })
      )
  );

  server.registerTool(
    "memory_reject_candidate",
    {
      title: "Reject Memory Candidate",
      description: "Reject one pending candidate.",
      inputSchema: { id: z.string().min(1) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input) =>
      jsonToolResult(
        await client.request(`/v1/candidates/${encodeURIComponent(input.id)}/reject`, {
          method: "POST",
          body: "{}"
        })
      )
  );

  server.registerTool(
    "memory_merge_candidate",
    {
      title: "Merge Memory Candidate",
      description: "Merge a candidate into an existing memory and preserve a revision.",
      inputSchema: { id: z.string().min(1), memory_id: z.string().min(1) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input) =>
      jsonToolResult(
        await client.request(`/v1/candidates/${encodeURIComponent(input.id)}/merge`, {
          method: "POST",
          body: JSON.stringify({ memory_id: input.memory_id })
        })
      )
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
  const client = createMemoryHttpClient();
  const server = createMemoryMcpServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMemoryMcpServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
