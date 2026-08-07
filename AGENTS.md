# Agent Memory Project Instructions

This repository implements the shared, agent-independent `agent_memory` service.
The durable source of truth is the MCP-backed graph store, not `AGENTS.md`, local
notes, or a model-specific memory feature.

## Project identity and bootstrap

- Use `project_id: "project:agent-memory"` for project-local knowledge.
- Before project work, load global memory with `memory_recall` using
  `scope.kind: "global"` and `knowledge_scope: "global"`.
- Then load relevant project memory with `memory_context` or `memory_recall`
  using `knowledge_scope: "project_local"` and the project id above.
- Use `memory_get_profile` for mutable user preferences when relevant.
- Keep `global` and `project_local` as separate graph layers.
- If MCP is unavailable, state that briefly and do not claim memory was loaded.

## Memory writes

- Reading memory and writing dialogue-derived memory are separate operations.
- Use `memory_remember` only for an explicit, safe user instruction to remember.
- When asked to save or review a dialogue, use the global
  `agent-memory-reviewer` skill and call `memory_review_conversation` with the
  full relevant dialogue and `analysis_mode: "agent_supplied"`.
- The current agent performs semantic analysis, assigns confidence and
  `knowledge_scope`, and writes durable memory content in Russian unless the user
  asks otherwise.
- Mark merely related conflict candidates compatible. Show real contradictions
  to the user and use `accept_new` or `keep_existing` only after the user chooses.
- Never store credentials, tokens, passwords, private keys, session cookies, or
  other secrets in graph memory, instruction files, or review payloads.

## Responsibility boundary

- Agents interpret conversation meaning and decide what is durable.
- The memory service stores sources and graph data, enforces scope and lifecycle,
  maintains profile slots and revisions, ranks recall, and gates conflicts.
- Instruction files only orchestrate those operations; they are not memory.
