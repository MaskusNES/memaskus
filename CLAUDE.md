# Agent Memory Project Instructions

This repository implements the shared, agent-independent `agent_memory` service.
The durable source of truth is the MCP-backed memory store, not this file and not
Claude's built-in or local notes.

## Project identity

- Use `project_id: "project:agent-memory"` for project-local memory.
- Treat `global` and `project_local` as separate knowledge layers.
- Do not create links or resolve conflicts across those two layers.

## Bootstrap before project work

When the `agent_memory` MCP server is available:

1. Load global preferences, facts, and decisions with `memory_recall`, using
   `scope.kind: "global"` and `knowledge_scope: "global"`.
2. Load relevant project knowledge with `memory_context` or `memory_recall`, using
   `project_id: "project:agent-memory"` and `knowledge_scope: "project_local"`.
3. Load mutable project profile preferences with `memory_get_profile` when they
   are relevant to the task.
4. Apply returned context silently unless the user asks what was loaded.

If the MCP server is unavailable, say so briefly and continue without claiming
that memory was loaded or updated.

## Reading and writing are different operations

- Reading uses `memory_context`, `memory_get_profile`, or `memory_recall`.
- Explicit user instructions to remember a fact may use `memory_remember`.
- Dialogue-derived knowledge must use the `agent-memory-reviewer` subagent and
  `memory_review_conversation` with `analysis_mode: "agent_supplied"`.
- MCP does not receive the conversation automatically. Pass the full relevant
  dialogue with `User:` and `Assistant:` role labels.

## Dialogue review policy

The reviewing agent performs semantic analysis before calling MCP. It should:

1. Identify durable facts, decisions, preferences, corrections, and user
   pushback; omit one-off remarks.
2. Write durable memory content in Russian unless the user requests otherwise.
3. Assign calibrated confidence and the correct `knowledge_scope`.
4. Ask a focused question instead of inventing meaning when evidence is unclear.
5. Inspect every returned conflict candidate.
6. Mark related but non-contradictory candidates as compatible.
7. Show real contradictions to the user and resolve them with `accept_new` or
   `keep_existing` only after the user chooses.

## Security

- Never store credentials, tokens, passwords, private keys, session cookies, or
  other secrets in memory, `CLAUDE.md`, source files, or dialogue-review payloads.
- Keep credentials in an appropriate secret manager or environment variables.
- Archive keeps audit history; use deletion for sensitive information the user
  explicitly wants removed.

## Boundary of responsibility

- Claude/Codex: understand the dialogue, select durable knowledge, assign scope
  and confidence, and involve the user in real contradictions.
- `agent_memory`: persist sources and graph records, filter by scope, maintain
  profile slots and revisions, rank recall, and gate conflicts.
- `CLAUDE.md`/`AGENTS.md`: define orchestration only; never serve as a knowledge
  database.
