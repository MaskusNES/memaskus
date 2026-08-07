<!-- BEGIN AGENT_MEMORY_POLICY -->
# Shared Agent Memory Policy

The durable source of truth for cross-session knowledge is the shared
`agent_memory` MCP service. Do not use this file, local notes, or a provider's
built-in memory as a substitute for the graph store.

## Bootstrap before work

At the start of every user task, if the `agent_memory` MCP server is available:

1. Recall global preferences, facts, and decisions with `memory_recall` using:
   - `scope.kind: "global"`
   - `knowledge_scope: "global"`
   - types `Preference`, `Fact`, and `Decision`
   - query `global user preferences facts operating rules`
   - a broad limit such as 50
2. Apply the returned global context silently unless the user asks what was
   loaded.
3. If the current workspace has a stable project id, separately load relevant
   project memory with `memory_context`, `memory_get_profile`, or
   `memory_recall`, using `knowledge_scope: "project_local"`.
4. Never create links, compatibility resolutions, or conflict resolutions
   between the `global` and `project_local` layers.

Tool names may be prefixed by OpenCode with the MCP server name, for example
`agent_memory_memory_recall`. Select tools by their catalog descriptions when
the exact rendered name differs.

If the MCP server is unavailable, say so briefly and continue without claiming
that memory was loaded or updated.

## Stable project identity

Before writing project-local memory, determine a stable project id in this order:

1. An explicit `Memory project id` in the project's `AGENTS.md`.
2. A canonical id based on the Git remote, such as
   `project:github.com/owner/repository`.
3. A focused question to the user.

Do not silently save project-specific knowledge as global memory when a stable
project id is unknown.

## Reading and writing are separate

- Reading uses `memory_context`, `memory_get_profile`, or `memory_recall`.
- Use `memory_remember` only for an explicit, safe user instruction to remember
  a durable fact or decision.
- Use `memory_update_profile` for an explicit stable preference when direct
  profile maintenance is appropriate.
- When the user asks to save, ingest, remember, or review a dialogue, invoke the
  `agent-memory-reviewer` subagent and give it the full relevant conversation
  with `User:` and `Assistant:` role labels.
- Prefer `memory_review_conversation` with `analysis_mode: "agent_supplied"`.
- Do not automatically persist every conversation or one-off remark.

## Conflict policy

- The current agent performs semantic analysis and assigns scope and confidence.
- Related but non-contradictory candidates may be marked compatible.
- Real contradictions must be shown to the user.
- Use `accept_new` or `keep_existing` only after the user chooses.
- If evidence is unclear, ask a focused question and leave the candidate
  unresolved.

## Security

- Never store passwords, tokens, API keys, private keys, session cookies,
  credentials, or other secrets in graph memory, instruction files, prompts, or
  review payloads.
- Redact secrets from source text before durable ingestion when possible.
- Keep secrets in a secret manager or environment variables.
- If a secret was exposed to an agent context, recommend rotation.

## Response after memory operations

Report only what matters: what was loaded or stored, remaining clarification
questions, compatible candidates resolved, and real conflicts needing user
input. Never claim memory was fully updated while unresolved conflicts remain.
<!-- END AGENT_MEMORY_POLICY -->
