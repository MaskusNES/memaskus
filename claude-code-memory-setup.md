# Claude Code shared agent_memory setup

This project already owns the shared memory store:

- HTTP memory service: `http://127.0.0.1:3010`
- SQLite database: `data/memory.sqlite`
- MCP stdio adapter: `npm run mcp`
- Claude subagent file: `.claude/agents/agent-memory-reviewer.md`

The intended architecture is:

```text
Codex / Claude Code / other agents
        |
        v
agent_memory MCP stdio adapter
        |
        v
http://127.0.0.1:3010
        |
        v
data/memory.sqlite
```

So Claude and Codex do not maintain separate memories. They talk to the same MCP service and the same SQLite graph.

## 1. Start the shared memory HTTP service

Run this from `C:\Users\Aorus\OneDrive\Документы\memaskus`:

```powershell
npm run dev
```

Check:

```powershell
curl.exe -s http://127.0.0.1:3010/health
```

Expected:

```json
{"ok":true}
```

## 2. Add the MCP server to Claude Code globally

Run this in PowerShell:

```powershell
claude mcp add --transport stdio --env MEMORY_API_URL=http://127.0.0.1:3010 --scope user agent_memory -- npm.cmd --prefix "C:\Users\Aorus\OneDrive\Документы\memaskus" run mcp
```

Then verify:

```powershell
claude mcp list
claude mcp get agent_memory
```

Inside Claude Code, `/mcp` should show `agent_memory`.

## 3. Install the Claude subagent globally

Project-level copy already exists here:

```text
C:\Users\Aorus\OneDrive\Документы\memaskus\.claude\agents\agent-memory-reviewer.md
```

For every Claude Code project, copy it to:

```text
C:\Users\Aorus\.claude\agents\agent-memory-reviewer.md
```

Create the folder if needed:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\agents"
Copy-Item -LiteralPath "C:\Users\Aorus\OneDrive\Документы\memaskus\.claude\agents\agent-memory-reviewer.md" -Destination "$env:USERPROFILE\.claude\agents\agent-memory-reviewer.md" -Force
```

Restart Claude Code if this is the first time `~/.claude/agents` was created.

## 4. Prompts to use in Claude Code

Check availability:

```text
Какие MCP tools тебе доступны? Есть ли agent_memory? Видишь ли subagent agent-memory-reviewer?
```

Save current dialogue:

```text
Воспользуйся agent-memory-reviewer: проанализируй текущий диалог и сохрани долговременные знания в agent_memory для project_id project:agent-memory. Если найдешь реальные конфликты, явно покажи их мне перед записью. Если конфликт-кандидат не является настоящим противоречием, отметь его compatible.
```

Recall shared memory:

```text
Воспользуйся agent_memory: вызови memory_recall по project_id project:agent-memory и проверь, что мы решили про storage.
```

Review a pasted dialogue:

```text
Воспользуйся agent-memory-reviewer для этого диалога. Сохраняй durable memory content на русском. Сначала покажи мне реальные конфликты, если они есть.

<сюда вставить диалог>
```

## 5. If Claude cannot see the tool

1. Make sure `npm run dev` is running and `/health` returns `{"ok":true}`.
2. Run `claude mcp list`.
3. If `agent_memory` is missing, run the `claude mcp add ...` command again.
4. If the agent file was just created, restart Claude Code.
5. In Claude Code, run `/mcp` and approve/trust the server if prompted.
