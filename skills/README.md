# Agent Memory Skills

These skills teach Codex when and how to use the `agent_memory` MCP tools. They
do not contain memory themselves and do not replace the HTTP/MCP service.

## Included skills

### `global-memory-bootstrap`

Loads durable global preferences, facts and operating rules before task work.
Project-specific recall remains controlled by the repository's `AGENTS.md`.

### `agent-memory-reviewer`

Reviews a full current or finished dialogue, extracts durable knowledge,
assigns confidence and knowledge scope, and safely writes it through
`memory_review_conversation`. Related memories are marked compatible; real
contradictions are shown to the user before resolution.

## Install for Codex

The `agent_memory` MCP server must be configured first. Then copy both folders to
the personal Codex skills directory.

Linux or macOS:

```bash
mkdir -p ~/.codex/skills
cp -R skills/global-memory-bootstrap ~/.codex/skills/
cp -R skills/agent-memory-reviewer ~/.codex/skills/
```

PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.codex\skills" | Out-Null
Copy-Item -Recurse -Force .\skills\global-memory-bootstrap "$env:USERPROFILE\.codex\skills\"
Copy-Item -Recurse -Force .\skills\agent-memory-reviewer "$env:USERPROFILE\.codex\skills\"
```

Restart Codex after the initial installation. When re-copying an updated skill,
remove or replace only that exact skill directory; do not delete the whole
personal skills directory.

## Project instructions

The repository's [AGENTS.md](../AGENTS.md) provides the project id, project-local
bootstrap and write policy. Copy and adapt it when enabling Agent Memory in
another repository.
