# Agent Memory MVP Design

## 1. Goal

Build a local-first prototype of an agent-independent memory service.

The MVP should prove that multiple agents can use one shared memory layer through
a stable contract. It should support explicit memory writes, scoped recall,
source-backed explanations, graph links, and basic candidate extraction from
conversation text.

## 2. MVP Scope

### Included

- Local HTTP API.
- SQLite storage.
- Graph-shaped data model using `nodes` and `edges` tables.
- Explicit memory creation.
- Explicit memory linking.
- Scoped recall.
- Source-backed explain endpoint.
- Candidate extraction from pasted conversation text.
- Candidate approval and rejection.
- Minimal CLI for manual testing.

### Not Included Yet

- Autonomous always-on dialogue capture.
- Full MCP integration.
- External vector database.
- Multi-user auth.
- Graph visualization.
- Complex temporal reasoning.
- Production encryption and secrets management.

## 3. Recommended Stack

- Runtime: Node.js.
- Language: TypeScript.
- HTTP framework: Fastify.
- Database: SQLite.
- SQLite library: `better-sqlite3`.
- Validation: Zod.
- Tests: Vitest.
- CLI: Node executable script using the same service layer.

This stack keeps the prototype easy to run locally and easy to wrap with MCP
later.

## 4. Project Structure

```text
agent-memory/
  package.json
  tsconfig.json
  src/
    index.ts
    server.ts
    config.ts
    db/
      connection.ts
      migrations.ts
      schema.sql
    domain/
      nodes.ts
      edges.ts
      recall.ts
      candidates.ts
      ingestion.ts
    routes/
      memories.ts
      recall.ts
      links.ts
      candidates.ts
      ingest.ts
    cli/
      memory-cli.ts
    shared/
      ids.ts
      time.ts
      errors.ts
  tests/
    memory.test.ts
    recall.test.ts
    candidates.test.ts
  data/
    memory.sqlite
```

For the current repository, the prototype can live directly in the root instead
of an `agent-memory/` subfolder unless we expect this repository to contain
multiple packages later.

## 5. Data Model

The MVP uses relational tables that represent graph primitives. A dedicated
graph database can replace this later without changing the public API.

### 5.1 `nodes`

Stores all memory entities.

```sql
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_user_id TEXT,
  scope_project_id TEXT,
  scope_workspace_id TEXT,
  scope_agent_id TEXT,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  privacy_level TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Expected `type` values:

- `Person`
- `Project`
- `Conversation`
- `Fact`
- `Preference`
- `Decision`
- `Task`
- `Artifact`
- `Observation`

Expected `status` values:

- `candidate`
- `active`
- `superseded`
- `archived`
- `deleted`

### 5.2 `edges`

Stores typed graph relationships.

```sql
CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (from_id) REFERENCES nodes(id),
  FOREIGN KEY (to_id) REFERENCES nodes(id)
);
```

Expected `relation` values:

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

### 5.3 `sources`

Stores provenance.

```sql
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  external_id TEXT,
  title TEXT,
  content_excerpt TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

Example source kinds:

- `conversation`
- `user_instruction`
- `tool_result`
- `file`
- `commit`
- `url`
- `manual`

### 5.4 `node_sources`

Connects nodes to evidence.

```sql
CREATE TABLE node_sources (
  node_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  evidence_text TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (node_id, source_id),
  FOREIGN KEY (node_id) REFERENCES nodes(id),
  FOREIGN KEY (source_id) REFERENCES sources(id)
);
```

### 5.5 `candidates`

Stores extracted memory candidates before approval.

```sql
CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_user_id TEXT,
  scope_project_id TEXT,
  scope_workspace_id TEXT,
  scope_agent_id TEXT,
  confidence REAL NOT NULL,
  risk TEXT NOT NULL,
  needs_confirmation INTEGER NOT NULL,
  status TEXT NOT NULL,
  source_id TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_id) REFERENCES sources(id)
);
```

Expected `candidate.status` values:

- `pending`
- `approved`
- `rejected`
- `merged`

## 6. HTTP API

### 6.1 Health

```http
GET /health
```

Response:

```json
{
  "ok": true
}
```

### 6.2 Create Memory

```http
POST /v1/memories
```

Creates an active memory node.

Request:

```json
{
  "type": "Decision",
  "content": "The MVP will use SQLite and a graph-shaped node/edge schema.",
  "scope": {
    "kind": "project",
    "project_id": "project:agent-memory"
  },
  "confidence": 0.95,
  "privacy_level": "normal",
  "source": {
    "kind": "manual",
    "title": "MVP planning"
  },
  "metadata": {
    "tags": ["mvp", "storage"]
  }
}
```

Response:

```json
{
  "id": "node_01J...",
  "status": "active"
}
```

### 6.3 Recall

```http
POST /v1/recall
```

Request:

```json
{
  "query": "What decisions were made for the MVP?",
  "scope": {
    "kind": "project",
    "project_id": "project:agent-memory"
  },
  "types": ["Decision", "Fact", "Preference"],
  "limit": 10,
  "include_sources": true
}
```

Response:

```json
{
  "results": [
    {
      "id": "node_01J...",
      "type": "Decision",
      "content": "The MVP will use SQLite and a graph-shaped node/edge schema.",
      "confidence": 0.95,
      "score": 0.82,
      "sources": [
        {
          "id": "src_01J...",
          "kind": "manual",
          "title": "MVP planning"
        }
      ]
    }
  ]
}
```

### 6.4 Create Link

```http
POST /v1/links
```

Request:

```json
{
  "from_id": "node_01J_A",
  "relation": "APPLIES_TO",
  "to_id": "node_01J_B",
  "confidence": 0.9,
  "metadata": {}
}
```

### 6.5 Explain Memory

```http
GET /v1/memories/:id/explain
```

Returns content, source evidence, incoming links, outgoing links, and a simple
reason why the memory is stored.

### 6.6 Ingest Conversation

```http
POST /v1/ingest/conversation
```

Creates a source record and extracts pending candidates.

Request:

```json
{
  "conversation_id": "conv:2026-06-27",
  "project_id": "project:agent-memory",
  "text": "User: I want graph-based memory for AI agents..."
}
```

Response:

```json
{
  "source_id": "src_01J...",
  "candidates": [
    {
      "id": "cand_01J...",
      "type": "Decision",
      "content": "The memory system should store knowledge as a graph.",
      "confidence": 0.9,
      "needs_confirmation": false
    }
  ]
}
```

### 6.7 Candidate Review

```http
GET /v1/candidates?status=pending
POST /v1/candidates/:id/approve
POST /v1/candidates/:id/reject
```

Approval creates or updates an active memory node.

## 7. Recall Algorithm v0

The first recall implementation can be intentionally simple:

1. Filter active nodes by scope.
2. Filter by requested types.
3. Compute lexical score using case-insensitive token overlap between query and
   node content.
4. Add confidence as a ranking signal.
5. Add small recency boost.
6. Return top `limit` results with sources.

Score formula:

```text
score = token_overlap * 0.65 + confidence * 0.25 + recency_boost * 0.10
```

This can later be replaced with embeddings and graph-neighborhood scoring.

## 8. Candidate Extraction v0

The first extractor should be deterministic and conservative.

It can scan conversation text for:

- explicit preference phrases;
- decision phrases;
- requirement phrases;
- task phrases.

Examples:

- `I want ...` -> possible `Fact` or `Decision`.
- `It should ...` -> possible `Decision`.
- `Let's use ...` -> possible `Decision`.
- `Remember that ...` -> high-confidence explicit memory.
- `TODO`, `need to`, `we should` -> possible `Task`.

This is not meant to be intelligent yet. It creates enough structure to test the
candidate review workflow. LLM extraction can be added behind the same
`extractCandidates(text, scope)` interface later.

## 9. Service Layer

Suggested domain functions:

```ts
createMemory(input): MemoryNode
recall(input): RecallResult[]
createLink(input): Edge
explainMemory(id): MemoryExplanation
ingestConversation(input): Candidate[]
listCandidates(filter): Candidate[]
approveCandidate(id): MemoryNode
rejectCandidate(id): Candidate
```

Routes should stay thin and call these domain functions.

## 10. CLI

Minimal CLI commands:

```bash
memory remember --type Decision --project agent-memory "Use SQLite for MVP"
memory recall --project agent-memory "MVP decisions"
memory ingest --project agent-memory ./conversation.txt
memory candidates
memory approve cand_01J...
memory explain node_01J...
```

The CLI can call the HTTP API, or it can use the domain layer directly. For the
MVP, calling HTTP keeps behavior closer to real agent usage.

## 11. MCP Adapter Plan

After the HTTP MVP works, add an MCP server exposing:

- `memory.remember`
- `memory.recall`
- `memory.link`
- `memory.explain`
- `memory.ingest_conversation`
- `memory.list_candidates`
- `memory.approve_candidate`
- `memory.reject_candidate`

The MCP adapter should not own business logic. It should validate inputs and
call the HTTP API.

## 12. Test Plan

Minimum tests:

1. Creates a memory and recalls it by keyword.
2. Does not recall archived or deleted memory.
3. Respects project scope.
4. Creates and explains memory with source evidence.
5. Creates a link between two memories.
6. Ingests conversation text and creates pending candidates.
7. Approves a candidate and creates an active memory.
8. Rejects a candidate and keeps it out of recall.

## 13. Build Order

1. Initialize TypeScript project.
2. Add SQLite schema and migrations.
3. Implement memory creation.
4. Implement recall v0.
5. Implement source-backed explain.
6. Implement links.
7. Implement candidate ingestion.
8. Implement candidate review.
9. Add CLI.
10. Add MCP adapter.

## 14. First Prototype Acceptance Criteria

The prototype is useful when this flow works:

1. Start local server.
2. Add a memory about the project through HTTP or CLI.
3. Recall that memory from a query.
4. Explain where the memory came from.
5. Ingest a short conversation.
6. Review extracted candidates.
7. Approve one candidate.
8. Recall the approved candidate.

At that point, the core loop is real enough to connect an agent.
