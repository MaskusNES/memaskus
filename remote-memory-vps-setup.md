# Remote Agent Memory VPS Setup

This guide installs Agent Memory as a private systemd service on a Linux VPS.
It assumes a Debian/Ubuntu-like host, Node.js 22+, npm, systemd and root access
for the installation steps.

## Target layout

```text
/opt/agent-memory/current                 application release
/opt/agent-memory/releases                previous releases
/var/lib/agent-memory/memory.sqlite       durable database
/var/backups/agent-memory                 verified backups
/etc/agent-memory.env                     optional secrets and configuration
127.0.0.1:39110                           private HTTP listener
```

The application release and durable database are deliberately separated. A code
deployment must never upload or replace the live SQLite file.

## 1. Build a release archive

From the repository root:

```bash
npm ci
npm test
npm run build
tar -czf /tmp/agent-memory-deploy.tgz \
  package.json package-lock.json dist public deploy scripts \
  README.md AGENTS.md CLAUDE.md mcp-setup.md
```

PowerShell users can create an equivalent archive with `tar.exe`.

## 2. Upload

Replace the placeholders with your own host and account:

```bash
scp -i /path/to/ssh-key /tmp/agent-memory-deploy.tgz admin@memory-host:/tmp/agent-memory-deploy.tgz
ssh -i /path/to/ssh-key admin@memory-host
```

## 3. Install or update

For a first install, extract the archive temporarily so the bundled script is
available, then run it as root:

```bash
mkdir -p /tmp/agent-memory-installer
tar -xzf /tmp/agent-memory-deploy.tgz -C /tmp/agent-memory-installer
bash /tmp/agent-memory-installer/deploy/install-vps.sh
```

For later updates, extract the new archive to the installer directory again.
Always run the installer shipped with the **new** release:

```bash
bash /tmp/agent-memory-installer/deploy/install-vps.sh
```

The script:

- creates an unprivileged `agent-memory` service account;
- installs production dependencies in a staged release before stopping the service;
- serializes deployments with a lock and preserves the previous application release;
- creates a verified backup before updating an existing database;
- installs the hardened systemd unit;
- starts the service and applies schema migrations on startup;
- waits for `/ready` before declaring success;
- restores the previous release and unit on failure, retaining all database writes.

Backups are retained until explicitly removed. Automatic rollback only restores
code, not the database: schema rollback requires a deliberate restore of the
verified backup. Test migrations on a database copy before deploying.
Set `MEMORY_READY_URL` when overriding the service host or port.

## 4. Optional environment file

Create `/etc/agent-memory.env` with mode `0600` when authentication or semantic
recall is required:

```dotenv
MEMORY_API_KEY=<long-random-secret>
MEMORY_EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=<from-a-secret-store>
MEMORY_EMBEDDING_MODEL=text-embedding-3-small
```

Do not put this file inside the application release.

## 5. Verify

```bash
systemctl is-active agent-memory
systemctl status agent-memory --no-pager -l
curl -s http://127.0.0.1:39110/health
curl -s http://127.0.0.1:39110/ready
journalctl -u agent-memory -n 100 --no-pager
```

## 6. Connect MCP over SSH

Configure the client to run an SSH command equivalent to:

```bash
ssh -i /path/to/ssh-key -o BatchMode=yes user@memory-host \
  "/usr/bin/node /opt/agent-memory/current/scripts/mcp-vps.mjs"
```

If `MEMORY_API_KEY` is enabled, expose it to the remote MCP process through a
protected server-side wrapper or environment file. Do not place it directly in
a shared client config.

## Restore a backup

List and verify the chosen backup first:

```bash
ls -lh /var/backups/agent-memory
/opt/agent-memory/current/deploy/restore-backup.sh \
  /var/backups/agent-memory/memory.sqlite.TIMESTAMP
```

The restore script accepts only files inside `/var/backups/agent-memory`, creates
a pre-restore backup, verifies both source and staged database, and restarts the
service.

## Network guidance

Keep port `39110` bound to loopback and connect through SSH whenever practical.
For a network API, add TLS termination, firewall rules, request limits and a
unique API key. The built-in service is not a public multi-tenant gateway.
