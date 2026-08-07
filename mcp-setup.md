# MCP Setup

The memory system is hosted on the VPS. Local clients should not start the HTTP service or a local MCP process.

## Architecture

```text
Codex / Claude Code / other MCP clients
        |
        | stdio over SSH
        v
VPS: /opt/agent-memory/current/dist/mcp/server.js
        |
        | http://127.0.0.1:39110, private to VPS
        v
VPS: agent-memory systemd service
        |
        v
VPS: /var/lib/agent-memory/memory.sqlite
```

The HTTP service is bound to `127.0.0.1:39110` on the VPS. Do not expose it publicly.

## Codex MCP Config

Use SSH as the MCP command:

```toml
[mcp_servers.agent_memory]
command = 'C:\Windows\System32\OpenSSH\ssh.exe'
args = ['-i', 'C:\Users\Aorus\.ssh\codex_deploy_ed25519', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', 'root@89.125.130.230', 'cd /opt/agent-memory/current && MEMORY_API_URL=http://127.0.0.1:39110 /usr/bin/node dist/mcp/server.js']
cwd = 'C:\Users\Aorus'
enabled = true
startup_timeout_sec = 30
tool_timeout_sec = 120
default_tools_approval_mode = "prompt"
```

Restart Codex after changing MCP config.

## Visual Profile UI

Open the UI through an SSH tunnel:

```powershell
ssh -i "$env:USERPROFILE\.ssh\codex_deploy_ed25519" -N -L 3010:127.0.0.1:39110 root@89.125.130.230
```

Then open:

```text
http://127.0.0.1:3010/profile
```

If local port `3010` is busy, use another local port:

```powershell
ssh -i "$env:USERPROFILE\.ssh\codex_deploy_ed25519" -N -L 3012:127.0.0.1:39110 root@89.125.130.230
```

Then open `http://127.0.0.1:3012/profile`.

## Tools

- `memory_context`
- `memory_list`
- `memory_recall`
- `memory_remember`
- `memory_update`
- `memory_feedback`
- `memory_archive`
- `memory_delete`
- `memory_review_conversation`
- `memory_list_candidates`
- `memory_approve_candidate`
- `memory_reject_candidate`
- `memory_merge_candidate`
- `memory_get_profile`
- `memory_update_profile`
- `memory_list_conflicts`
- `memory_resolve_conflict`
- `memory_explain`
- `memory_graph`

## Notes

MCP does not automatically receive a client's whole conversation history. The client or agent must pass dialogue text into `memory_review_conversation`.

Durable user preferences should be written to the mutable profile layer, not only appended as event memories. Old profile slots can be updated, archived, or superseded when better information appears.
