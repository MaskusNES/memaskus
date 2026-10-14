import { Command } from "commander";
import fs from "node:fs/promises";
import { createMemoryHttpClient } from "../shared/http-client.js";

const program = new Command();
const client = createMemoryHttpClient();

async function request(path: string, options: RequestInit = {}) {
  console.log(JSON.stringify(await client.request(path, options), null, 2));
}

program.name("memory").description("CLI for the agent memory service");

program
  .command("remember")
  .description("Create an active memory")
  .argument("<content>", "memory content")
  .option("--type <type>", "memory type", "Fact")
  .option("--project <projectId>", "project scope id")
  .option("--confidence <confidence>", "confidence from 0 to 1", "0.8")
  .action(async (content, options) => {
    await request("/v1/memories", {
      method: "POST",
      body: JSON.stringify({
        type: options.type,
        content,
        scope: options.project ? { kind: "project", project_id: options.project } : { kind: "global" },
        confidence: Number(options.confidence),
        source: {
          kind: "manual",
          title: "CLI memory"
        }
      })
    });
  });

program
  .command("recall")
  .description("Recall memories by query")
  .argument("<query>", "query text")
  .option("--project <projectId>", "project scope id")
  .option("--limit <limit>", "result limit", "10")
  .option("--sources", "include sources")
  .action(async (query, options) => {
    await request("/v1/recall", {
      method: "POST",
      body: JSON.stringify({
        query,
        scope: options.project ? { kind: "project", project_id: options.project } : { kind: "global" },
        limit: Number(options.limit),
        include_sources: Boolean(options.sources)
      })
    });
  });

program
  .command("explain")
  .description("Explain why a memory is stored")
  .argument("<id>", "memory id")
  .action(async (id) => {
    await request(`/v1/memories/${id}/explain`);
  });

program
  .command("link")
  .description("Create a graph link between two memories")
  .argument("<fromId>", "source memory id")
  .argument("<relation>", "relation name")
  .argument("<toId>", "target memory id")
  .option("--confidence <confidence>", "confidence from 0 to 1", "0.8")
  .action(async (fromId, relation, toId, options) => {
    await request("/v1/links", {
      method: "POST",
      body: JSON.stringify({
        from_id: fromId,
        relation,
        to_id: toId,
        confidence: Number(options.confidence)
      })
    });
  });

program
  .command("ingest")
  .description("Ingest a conversation text file and create memory candidates")
  .argument("<file>", "conversation text file")
  .option("--conversation <conversationId>", "external conversation id")
  .option("--project <projectId>", "project scope id")
  .action(async (file, options) => {
    const text = await fs.readFile(file, "utf8");
    await request("/v1/ingest/conversation", {
      method: "POST",
      body: JSON.stringify({
        conversation_id: options.conversation,
        project_id: options.project,
        text
      })
    });
  });

program
  .command("review")
  .description("Review a conversation, auto-approve non-conflicting memories, and block conflicts")
  .argument("<file>", "conversation text file")
  .option("--conversation <conversationId>", "external conversation id")
  .option("--project <projectId>", "project scope id")
  .option("--analysis-mode <mode>", "heuristic or agent_supplied", "heuristic")
  .option("--agent-analysis <file>", "JSON file with agent-supplied disagreement analysis")
  .action(async (file, options) => {
    const text = await fs.readFile(file, "utf8");
    const agentAnalysis = options.agentAnalysis
      ? JSON.parse(await fs.readFile(options.agentAnalysis, "utf8"))
      : undefined;
    await request("/v1/review/conversation", {
      method: "POST",
      body: JSON.stringify({
        conversation_id: options.conversation,
        project_id: options.project,
        text,
        analysis_mode: options.analysisMode,
        agent_analysis: agentAnalysis
      })
    });
  });

program
  .command("candidates")
  .description("List memory candidates")
  .option("--status <status>", "candidate status", "pending")
  .action(async (options) => {
    await request(`/v1/candidates?status=${encodeURIComponent(options.status)}`);
  });

program
  .command("approve")
  .description("Approve a candidate and create active memory")
  .argument("<id>", "candidate id")
  .action(async (id) => {
    await request(`/v1/candidates/${id}/approve`, { method: "POST" });
  });

program
  .command("reject")
  .description("Reject a candidate")
  .argument("<id>", "candidate id")
  .action(async (id) => {
    await request(`/v1/candidates/${id}/reject`, { method: "POST" });
  });

program
  .command("conflicts")
  .description("List memory conflicts")
  .option("--status <status>", "conflict status", "open")
  .action(async (options) => {
    await request(`/v1/conflicts?status=${encodeURIComponent(options.status)}`);
  });

program
  .command("resolve-conflict")
  .description("Resolve a memory conflict")
  .argument("<id>", "conflict id")
  .option("--action <action>", "accept_new, keep_existing, or mark_compatible", "mark_compatible")
  .option("--note <note>", "resolution note")
  .action(async (id, options) => {
    await request(`/v1/conflicts/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify({
        action: options.action,
        note: options.note
      })
    });
  });

await program.parseAsync();
