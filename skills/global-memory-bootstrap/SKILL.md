---
name: global-memory-bootstrap
description: Load global agent_memory context before handling a request. Use at the start of every task when the agent_memory MCP tools are available, before planning or implementation, so durable global preferences, facts and operating rules are present in working context.
---

# Global Memory Bootstrap

## Goal

Load the user's global graph-memory layer before task-specific work and apply it
as durable context.

## Workflow

1. Call `memory_recall` with:
   - `knowledge_scope: "global"`;
   - `scope.kind: "global"`;
   - a broad query such as `global user preferences facts operating rules`;
   - types `Preference`, `Fact` and `Decision`;
   - a sufficiently high limit;
   - sources disabled unless provenance is needed for the task.
2. Read the returned nodes and silently apply relevant preferences, facts and
   operating rules.
3. Do not link global memories to project-local memories.
4. Follow the repository's `AGENTS.md` for project-specific recall and project id.
5. If `agent_memory` is unavailable, say so briefly and do not claim memory was
   loaded.

## Recommended call

```json
{
  "query": "global user preferences facts operating rules",
  "scope": { "kind": "global" },
  "knowledge_scope": "global",
  "types": ["Preference", "Fact", "Decision"],
  "limit": 50,
  "include_sources": false
}
```

Apply especially:

- output and communication preferences;
- stable user facts and work context;
- cross-project operating rules;
- memory and conflict-handling preferences.
