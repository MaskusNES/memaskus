# Claude Code + Agent Memory

This guide connects Claude Code to a running Agent Memory service through its
stdio MCP adapter.

## Local service

Build and start Agent Memory:

```bash
npm ci
npm run build
npm start
```

Remove an obsolete MCP entry if needed:

```bash
claude mcp remove agent_memory
```

Add the local adapter. Replace the script path with an absolute path:

```bash
claude mcp add --transport stdio --scope user agent_memory -- \
  node /absolute/path/to/memaskus/dist/mcp/server.js
```

The adapter defaults to `http://127.0.0.1:3010`. If the service uses another
address or an API key, provide `MEMORY_API_URL` and `MEMORY_API_KEY` in the MCP
process environment supported by your Claude Code configuration.

Verify:

```bash
claude mcp list
claude mcp get agent_memory
```

Inside Claude Code, `/mcp` should show `agent_memory`.

## Shipped Claude integration

This repository already includes two project-level components:

- [`CLAUDE.md`](CLAUDE.md) — bootstrap, knowledge-layer, write, conflict and
  security policy loaded for work in this repository;
- [`.claude/agents/agent-memory-reviewer.md`](.claude/agents/agent-memory-reviewer.md)
  — a specialized dialogue-review subagent using the shared MCP store.

To make the reviewer available in every Claude Code project:

```bash
mkdir -p ~/.claude/agents
cp .claude/agents/agent-memory-reviewer.md ~/.claude/agents/
```

PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\agents" | Out-Null
Copy-Item -Force .\.claude\agents\agent-memory-reviewer.md "$env:USERPROFILE\.claude\agents\"
```

For another repository, copy and adapt `CLAUDE.md`, especially its stable
project id. Neither file stores durable knowledge; both orchestrate access to the
MCP-backed graph.

## Remote service over SSH

For a service bound to the VPS loopback interface:

```bash
claude mcp add --transport stdio --scope user agent_memory -- \
  ssh -i /path/to/ssh-key -o BatchMode=yes user@memory-host \
  "cd /opt/agent-memory/current && MEMORY_API_URL=http://127.0.0.1:39110 /usr/bin/node dist/mcp/server.js"
```

Use your own host, account and SSH key. Keep credentials outside the repository.

## Suggested instructions

Add project instructions equivalent to:

```text
Before project work, call memory_context for project-local profile context and
memory_recall for relevant facts. Keep global and project-local knowledge
separate. Use memory_remember only for explicit safe requests. For dialogue
review, pass the full relevant dialogue to memory_review_conversation, treat
merely related memories as compatible, and ask the user before resolving a real
contradiction. Never store credentials or secrets.
```

## Suggested prompts

Recall context:

```text
Use agent_memory: load memory_context and memory_recall for this task, then apply
the relevant preferences and project decisions.
```

Review a conversation:

```text
Review this dialogue through memory_review_conversation. Store only durable,
source-backed knowledge. Mark related but non-contradictory memories compatible,
and show real contradictions before resolving them.
```

## Troubleshooting

1. Confirm `/ready` on the HTTP service.
2. Run the configured MCP command manually and inspect stderr.
3. Check `claude mcp list` and `claude mcp get agent_memory`.
4. Use an absolute path to `dist/mcp/server.js`.
5. Rebuild after pulling updates and restart Claude Code after config changes.
