<!-- BEGIN PROJECT_AGENT_MEMORY -->
## Shared agent memory

- Memory project id: `project:REPLACE_WITH_CANONICAL_ID`
- Load global memory and this project's `project_local` context before work.
- Keep global and project-local knowledge as separate graph layers.
- Use the shared `agent_memory` MCP store as the durable source of truth.
- Never store secrets in graph memory or instruction files.
<!-- END PROJECT_AGENT_MEMORY -->
