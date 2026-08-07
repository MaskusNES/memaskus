# Agent Memory System Specification

## 1. Purpose

This document defines a first version of an agent-independent memory system.
The system stores long-lived knowledge as a graph, exposes a stable API to any
AI agent, and can automatically extract memory candidates from conversations.

The system must not be tied to a specific agent runtime. Codex, Claude Code,
custom assistants, background workers, and future agents should interact with it
through the same external contract.

## 2. Core Principles

1. Agent-independent by default.
   Memory is a separate service, not an internal feature of one assistant.

2. Graph-first knowledge model.
   Facts, decisions, projects, people, tasks, artifacts, and preferences are
   represented as typed nodes connected by typed edges.

3. Source-aware memory.
   Every memory item must have provenance: where it came from, when it was
   created, and why it is believed.

4. Confidence over certainty.
   Extracted knowledge should carry confidence and status instead of being
   treated as automatically true.

5. Human-correctable.
   Users and agents must be able to inspect, update, merge, archive, and delete
   memory.

6. Scoped retrieval.
   Memory can be global, user-specific, project-specific, repository-specific,
   agent-specific, or conversation-specific.

7. Minimal trusted writes.
   Automatic extraction should produce candidates first. Direct durable writes
   should be allowed only for high-confidence, low-risk memory or explicit user
   commands.

## 3. System Shape

```mermaid
flowchart LR
  A["Conversation / Events"] --> B["Ingestion Buffer"]
  B --> C["Extractor"]
  C --> D["Memory Candidates"]
  D --> E["Normalizer"]
  E --> F["Deduplication"]
  F --> G["Validation Policy"]
  G --> H["Graph Memory Store"]
  H --> I["Retrieval API"]
  I --> J["Agents: Codex, Claude Code, Custom Tools"]
  J --> A
```

## 4. Public Interfaces

The memory system should expose several interfaces over the same core service:

- HTTP API for general integrations.
- CLI for local use and debugging.
- MCP server for agent integrations.
- Optional SDKs for TypeScript and Python.

The MCP server should be treated as a thin adapter over the HTTP/domain API, not
as the core memory implementation.

## 5. Memory API Contract

### 5.1 Write Explicit Memory

```http
POST /v1/memories
```

Request:

```json
{
  "type": "Preference",
  "content": "The user prefers concise Russian-language answers.",
  "scope": {
    "kind": "global",
    "user_id": "user:default"
  },
  "source": {
    "kind": "explicit_user_instruction",
    "conversation_id": "conv:2026-06-27"
  },
  "confidence": 0.95,
  "tags": ["style", "language"]
}
```

Response:

```json
{
  "memory_id": "mem_01J...",
  "status": "active"
}
```

### 5.2 Recall Memory

```http
POST /v1/recall
```

Request:

```json
{
  "query": "What should the agent remember about this project?",
  "scope": {
    "project_id": "project:agent-memory",
    "user_id": "user:default"
  },
  "filters": {
    "types": ["Preference", "Decision", "Fact", "Task"],
    "status": ["active"]
  },
  "limit": 10,
  "include_sources": true
}
```

Response:

```json
{
  "results": [
    {
      "memory_id": "mem_01J...",
      "type": "Decision",
      "content": "The memory system should be agent-independent and exposed through HTTP, CLI, and MCP.",
      "confidence": 0.9,
      "relevance": 0.86,
      "source": {
        "conversation_id": "conv:2026-06-27",
        "turn_id": "turn:12"
      }
    }
  ]
}
```

### 5.3 Link Memories

```http
POST /v1/links
```

Request:

```json
{
  "from_id": "mem_01J_A",
  "relation": "APPLIES_TO",
  "to_id": "project:agent-memory",
  "confidence": 0.9,
  "source": {
    "kind": "system_inference"
  }
}
```

### 5.4 Explain Memory

```http
GET /v1/memories/{memory_id}/explain
```

Response:

```json
{
  "memory_id": "mem_01J...",
  "content": "The user wants graph-based memory for AI agents.",
  "why_stored": "Extracted as a durable project requirement from an explicit user statement.",
  "sources": [
    {
      "conversation_id": "conv:2026-06-27",
      "turn_id": "turn:1"
    }
  ],
  "related_memories": ["mem_01J_B", "mem_01J_C"]
}
```

### 5.5 Feedback

```http
POST /v1/memories/{memory_id}/feedback
```

Request:

```json
{
  "rating": "wrong",
  "comment": "This was only true for one task, not globally.",
  "action": "reduce_scope"
}
```

### 5.6 Forget or Archive

```http
POST /v1/memories/{memory_id}/archive
DELETE /v1/memories/{memory_id}
```

Archive keeps provenance and audit history. Delete removes user-visible memory
and should be used for sensitive or explicitly removed information.

## 6. Graph Model

### 6.1 Node Types

#### Person

Represents a user, collaborator, or agent identity.

Required fields:

- `id`
- `display_name`
- `kind`: `user`, `agent`, `human_collaborator`

#### Project

Represents a product, repository, workspace, research effort, or long-running
initiative.

Required fields:

- `id`
- `name`
- `description`
- `external_refs`

#### Conversation

Represents a dialogue or work session.

Required fields:

- `id`
- `started_at`
- `ended_at`
- `participants`
- `environment`

#### Fact

Represents a durable claim about the world, a project, or a system.

Required fields:

- `id`
- `claim`
- `scope`
- `confidence`
- `status`

#### Preference

Represents a user or project preference.

Required fields:

- `id`
- `subject_id`
- `preference`
- `scope`
- `confidence`

#### Decision

Represents a choice made during work.

Required fields:

- `id`
- `decision`
- `rationale`
- `alternatives`
- `scope`

#### Task

Represents intended, active, blocked, or completed work.

Required fields:

- `id`
- `title`
- `status`
- `owner`
- `scope`
- `due_at`

#### Artifact

Represents a file, document, URL, commit, PR, issue, dataset, or generated
asset.

Required fields:

- `id`
- `kind`
- `uri`
- `name`
- `checksum`

#### Observation

Represents a lower-confidence extracted note that may later become a Fact,
Preference, or Decision.

Required fields:

- `id`
- `text`
- `source`
- `confidence`

### 6.2 Common Node Fields

All memory nodes should include:

- `id`
- `type`
- `content`
- `created_at`
- `updated_at`
- `created_by`
- `source_refs`
- `confidence`
- `status`: `candidate`, `active`, `superseded`, `archived`, `deleted`
- `scope`
- `privacy_level`: `normal`, `sensitive`, `secret`
- `ttl`
- `embedding_ref`

### 6.3 Edge Types

- `MENTIONED_IN`
- `EXTRACTED_FROM`
- `RELATED_TO`
- `APPLIES_TO`
- `PREFERRED_BY`
- `DECIDED_IN`
- `DEPENDS_ON`
- `BLOCKED_BY`
- `CONTRADICTS`
- `CONFIRMS`
- `SUPERSEDES`
- `DUPLICATE_OF`
- `DERIVED_FROM`
- `USES_ARTIFACT`

### 6.4 Edge Fields

All edges should include:

- `id`
- `from_id`
- `to_id`
- `relation`
- `created_at`
- `source_refs`
- `confidence`
- `status`

## 7. Scoping Model

Memory scope should be explicit. The default scopes are:

- `global`: applies across all work for the user.
- `user`: applies to one user.
- `project`: applies to one project.
- `workspace`: applies to one local workspace or repository.
- `agent`: applies only to one agent identity.
- `conversation`: applies only to one dialogue.

Example:

```json
{
  "kind": "project",
  "user_id": "user:default",
  "project_id": "project:agent-memory"
}
```

Scope can be narrowed by feedback or superseded by more specific memory.

## 8. Ingestion Pipeline

### 8.1 Event Capture

The system receives:

- user messages;
- assistant messages;
- tool calls;
- file edits;
- command results;
- commits, PRs, issues, and external artifacts where available.

Raw events are stored in an append-only event log before memory extraction.

### 8.2 Extraction

The extractor turns raw dialogue into candidate memories.

Candidate types:

- explicit user preference;
- durable project requirement;
- technical decision;
- open task;
- completed task;
- correction;
- fact about a codebase or product;
- relationship between entities.

Candidate example:

```json
{
  "candidate_id": "cand_01J...",
  "type": "Decision",
  "content": "The memory system should use a graph-based knowledge model.",
  "scope": {
    "kind": "project",
    "project_id": "project:agent-memory"
  },
  "confidence": 0.92,
  "evidence": [
    {
      "conversation_id": "conv:2026-06-27",
      "turn_id": "turn:1"
    }
  ],
  "risk": "low",
  "needs_confirmation": false
}
```

### 8.3 Normalization

Normalization should:

- rewrite candidates into canonical short claims;
- detect entity names and aliases;
- attach likely scope;
- attach tags;
- generate embeddings;
- propose graph links.

### 8.4 Deduplication

Deduplication should combine:

- exact text matching;
- embedding similarity;
- graph-neighborhood similarity;
- entity and scope overlap.

Outcomes:

- create a new memory;
- update an existing memory;
- create a `DUPLICATE_OF` edge;
- create a `CONTRADICTS` edge;
- ask for confirmation.

### 8.5 Validation Policy

The validation layer decides whether a candidate can become active memory.

Default policy:

- Explicit user instruction: write immediately.
- Stable project decision: write if confidence is high.
- User preference: write if explicitly stated, otherwise candidate.
- Sensitive personal data: require confirmation.
- Credentials, secrets, private keys: never store as memory content.
- Low-confidence inference: keep as candidate or observation.

## 9. Retrieval Strategy

Retrieval should combine:

1. Graph traversal.
2. Semantic vector search.
3. Keyword search.
4. Scope filtering.
5. Recency and confidence ranking.

The retrieval API should return compact, source-backed memory snippets that can
fit into an agent context window.

Retrieval ranking inputs:

- query similarity;
- graph distance to active project/conversation;
- confidence;
- freshness;
- source reliability;
- user feedback;
- task relevance;
- privacy permissions.

## 10. Storage Architecture Options

### Option A: SQLite + KuzuDB + Vector Index

Good for local-first MVP.

- SQLite: event log, audit metadata, simple tables.
- KuzuDB: embedded graph store.
- LanceDB, sqlite-vec, or similar: vector search.

Pros:

- local-first;
- simple deployment;
- good for desktop agents.

Cons:

- fewer managed hosting options;
- more custom integration work.

### Option B: PostgreSQL + pgvector + Graph Tables

Good for server MVP.

- PostgreSQL: source of truth.
- pgvector: embeddings.
- relational tables for nodes and edges.

Pros:

- one database;
- easy to host;
- strong ecosystem.

Cons:

- graph queries require more manual modeling;
- less natural than a dedicated graph database.

### Option C: Neo4j + Vector Store

Good for graph-heavy exploration.

Pros:

- excellent graph querying;
- visual graph exploration.

Cons:

- heavier dependency;
- less ideal for small local-first deployments.

Recommended MVP path: start with PostgreSQL + pgvector if server deployment is
the priority, or SQLite + KuzuDB if local-first agent tooling is the priority.

## 11. MCP Tools

The MCP adapter should expose tools similar to:

- `memory.remember`
- `memory.recall`
- `memory.search`
- `memory.link`
- `memory.explain`
- `memory.feedback`
- `memory.archive`
- `memory.delete`
- `memory.list_candidates`
- `memory.approve_candidate`
- `memory.reject_candidate`

Example `memory.recall` tool input:

```json
{
  "query": "What are the current design decisions for the memory system?",
  "scope": {
    "project_id": "project:agent-memory"
  },
  "limit": 8
}
```

## 12. Privacy and Safety Rules

1. Do not store secrets.
   API keys, passwords, tokens, private keys, and recovery codes must be
   redacted or rejected.

2. Sensitive memory requires explicit policy.
   Personal, legal, financial, medical, and identity-related memories should be
   opt-in or confirmation-gated.

3. Every memory must be inspectable.
   A user must be able to ask: "Why do you remember this?"

4. Every memory must be correctable.
   A user must be able to mark memory as wrong, outdated, too broad, or too
   narrow.

5. Deletion must be real enough for user trust.
   Deleted memory should not be returned by recall. Raw event retention should
   have a separate, explicit policy.

## 13. MVP Definition

The first useful prototype should include:

1. A local HTTP API.
2. A graph-shaped node and edge schema.
3. Manual memory creation.
4. Manual recall with scope filtering.
5. Source-backed explanations.
6. Candidate extraction from pasted conversation text.
7. Candidate approval and rejection.
8. MCP adapter for agent access.

The MVP does not need:

- fully autonomous memory writing;
- perfect entity resolution;
- multi-user enterprise permissions;
- complex temporal reasoning;
- full graph visualization.

## 14. Suggested Implementation Milestones

### Milestone 1: Contract and Schema

Deliverables:

- OpenAPI draft.
- Node and edge schema.
- Scope model.
- Candidate schema.

### Milestone 2: Local Memory Service

Deliverables:

- `POST /v1/memories`
- `POST /v1/recall`
- `GET /v1/memories/{id}/explain`
- storage migrations;
- basic tests.

### Milestone 3: Graph Links and Search

Deliverables:

- explicit linking;
- graph traversal recall;
- semantic search;
- source-backed ranking.

### Milestone 4: Conversation Ingestion

Deliverables:

- event log;
- extraction prompt or local extractor;
- candidate list;
- approval/rejection workflow.

### Milestone 5: MCP Integration

Deliverables:

- MCP server;
- tools for remember, recall, explain, feedback;
- integration test with at least one agent.

## 15. Open Design Questions

1. Should the first version be local-first or server-first?
2. Should automatic extraction run after every dialogue, on demand, or in the
   background?
3. Should users approve all extracted memories at first?
4. Which graph store should be used for the MVP?
5. How long should raw conversations be retained?
6. Should memory be shared across all agents by default, or should every agent
   have its own namespace?
7. How should the system distinguish durable preference from one-time
   instruction?
8. Should the graph be directly queryable by agents, or only through safe recall
   tools?

## 16. Recommended Next Step

Build a small local prototype with:

- TypeScript service;
- SQLite or PostgreSQL storage;
- simple `nodes` and `edges` tables;
- HTTP API;
- MCP adapter;
- manual memory commands first;
- extraction from pasted conversation text second.

The first prototype should prove one thing: different agents can store and
retrieve the same source-backed project memory through one stable contract.
