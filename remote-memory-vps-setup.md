# Remote Agent Memory VPS Setup

## Target State

- Code: `/opt/agent-memory/current`
- Database: `/var/lib/agent-memory/memory.sqlite`
- Backend: `agent-memory.service`
- Backend bind: `127.0.0.1:39110` on the VPS only
- MCP: launched remotely over SSH as stdio
- Local autostart: none

## Deploy Or Update VPS

From the repo root on Windows:

```powershell
npm test
npm run build
tar -czf tmp\agent-memory-deploy.tgz --exclude=.git --exclude=node_modules --exclude=data --exclude=tmp .
scp -i "$env:USERPROFILE\.ssh\codex_deploy_ed25519" tmp\agent-memory-deploy.tgz root@89.125.130.230:/tmp/agent-memory-deploy.tgz
```

Then on the VPS:

```bash
mkdir -p /opt/agent-memory/releases /var/lib/agent-memory /var/backups/agent-memory
systemctl stop agent-memory 2>/dev/null || true
ts=$(date +%Y%m%d-%H%M%S)
if [ -d /opt/agent-memory/current ]; then mv /opt/agent-memory/current /opt/agent-memory/releases/current-$ts; fi
mkdir -p /opt/agent-memory/current
tar -xzf /tmp/agent-memory-deploy.tgz -C /opt/agent-memory/current
if [ -f /var/lib/agent-memory/memory.sqlite ]; then cp /var/lib/agent-memory/memory.sqlite /var/backups/agent-memory/memory.sqlite.$ts; fi
cd /opt/agent-memory/current
npm ci --omit=dev
cp deploy/agent-memory.service /etc/systemd/system/agent-memory.service
systemctl daemon-reload
systemctl enable --now agent-memory
systemctl status agent-memory --no-pager -l
```

The deploy never uploads or replaces the live database. The service applies versioned
schema migrations when it starts. Use `deploy/restore-backup.sh` explicitly when a
database restore is required.

## Verify

```bash
curl -s http://127.0.0.1:39110/health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:39110/profile
systemctl is-active agent-memory
```

## Local Client Command

All clients should launch MCP through SSH:

```powershell
ssh.exe -i "$env:USERPROFILE\.ssh\codex_deploy_ed25519" -o BatchMode=yes -o StrictHostKeyChecking=accept-new root@89.125.130.230 "cd /opt/agent-memory/current && MEMORY_API_URL=http://127.0.0.1:39110 /usr/bin/node dist/mcp/server.js"
```

## Remove Old Local Autostart

```powershell
Unregister-ScheduledTask -TaskName AgentMemoryService -Confirm:$false
```

There should be no local listener on `127.0.0.1:3010` unless you intentionally opened an SSH tunnel to the VPS.
