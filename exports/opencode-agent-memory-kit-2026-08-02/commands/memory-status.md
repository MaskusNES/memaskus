---
description: Check shared agent_memory availability and load global/project context without writing
---

Perform a read-only memory check:

1. Confirm that the `agent_memory` MCP tools are available.
2. Call `memory_recall` for global preferences, facts, and decisions using
   `scope.kind: "global"`, `knowledge_scope: "global"`, and a broad limit.
3. If the current project has a stable memory project id, call `memory_context`
   and `memory_get_profile` for its `project_local` layer.
4. Report connection status, result counts, and the project id used.
5. Do not create, update, resolve, archive, or delete any memory.

Optional project id or diagnostic note:

$ARGUMENTS
