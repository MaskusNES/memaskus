# Claude Code Shared Agent Memory Setup

The shared memory now lives on the VPS:

- VPS host: `root@89.125.130.230`
- HTTP memory service: `http://127.0.0.1:39110`, private to the VPS
- SQLite database: `/var/lib/agent-memory/memory.sqlite`
- MCP stdio adapter: `/opt/agent-memory/current/dist/mcp/server.js`, launched over SSH
- Claude subagent file in this repo: `.claude/agents/agent-memory-reviewer.md`

Claude and Codex should not run local memory services. They should connect to the same remote MCP command over SSH.

## 1. Add Remote MCP To Claude Code

If an old local MCP entry exists, remove it first:

```powershell
claude mcp remove agent_memory
```

Then add the remote MCP server globally:

```powershell
claude mcp add --transport stdio --scope user agent_memory -- ssh.exe -i "$env:USERPROFILE\.ssh\codex_deploy_ed25519" -o BatchMode=yes -o StrictHostKeyChecking=accept-new root@89.125.130.230 "cd /opt/agent-memory/current && MEMORY_API_URL=http://127.0.0.1:39110 /usr/bin/node dist/mcp/server.js"
```

Verify:

```powershell
claude mcp list
claude mcp get agent_memory
```

Inside Claude Code, `/mcp` should show `agent_memory`.

## 2. Install The Claude Subagent

Project-level copy:

```text
C:\Users\Aorus\OneDrive\Документы\memaskus\.claude\agents\agent-memory-reviewer.md
```

Global Claude Code copy:

```text
C:\Users\Aorus\.claude\agents\agent-memory-reviewer.md
```

Install or refresh it:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\agents"
Copy-Item -LiteralPath "C:\Users\Aorus\OneDrive\Документы\memaskus\.claude\agents\agent-memory-reviewer.md" -Destination "$env:USERPROFILE\.claude\agents\agent-memory-reviewer.md" -Force
```

Restart Claude Code if this is the first time `~/.claude/agents` was created.

## 3. Visual UI

The profile UI is available through an SSH tunnel:

```powershell
ssh -i "$env:USERPROFILE\.ssh\codex_deploy_ed25519" -N -L 3010:127.0.0.1:39110 root@89.125.130.230
```

Open:

```text
http://127.0.0.1:3010/profile
```

If local `3010` is busy, use `3011` locally:

```powershell
ssh -i "$env:USERPROFILE\.ssh\codex_deploy_ed25519" -N -L 3012:127.0.0.1:39110 root@89.125.130.230
```

Then open `http://127.0.0.1:3012/profile`.

## 4. Prompts To Use In Claude Code

Check availability:

```text
Какие MCP tools тебе доступны? Есть ли agent_memory? Видишь ли subagent agent-memory-reviewer?
```

Save current dialogue:

```text
Воспользуйся agent-memory-reviewer: проанализируй текущий диалог и сохрани долговременные знания в agent_memory. Если найдешь реальные конфликты, явно покажи их мне перед записью. Если конфликт-кандидат не является настоящим противоречием, отметь его compatible.
```

Recall shared memory:

```text
Воспользуйся agent_memory: вызови memory_context и memory_get_profile для текущей задачи, затем учти найденные предпочтения пользователя.
```

Review pasted dialogue:

```text
Воспользуйся agent-memory-reviewer для этого диалога. Сохраняй durable memory content на русском. Сначала покажи мне реальные конфликты, если они есть.

<сюда вставить диалог>
```

## 5. If Claude Cannot See The Tool

1. Check SSH access:

```powershell
ssh -i "$env:USERPROFILE\.ssh\codex_deploy_ed25519" -o BatchMode=yes root@89.125.130.230 "systemctl is-active agent-memory"
```

2. Run:

```powershell
claude mcp list
claude mcp get agent_memory
```

3. If `agent_memory` is missing, run the `claude mcp add ...` command again.
4. If the agent file was just created, restart Claude Code.
5. In Claude Code, run `/mcp` and approve/trust the server if prompted.
