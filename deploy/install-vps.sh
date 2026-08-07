#!/usr/bin/env bash
set -euo pipefail

id -u agent-memory >/dev/null 2>&1 || useradd --system --home /var/lib/agent-memory --shell /usr/sbin/nologin agent-memory
install -d -m 700 -o agent-memory -g agent-memory /var/lib/agent-memory /var/backups/agent-memory
mkdir -p /opt/agent-memory/releases
chown agent-memory:agent-memory /var/lib/agent-memory

systemctl stop agent-memory 2>/dev/null || true

ts="$(date +%Y%m%d-%H%M%S)"

if [ -d /opt/agent-memory/current ]; then
  mv /opt/agent-memory/current "/opt/agent-memory/releases/current-$ts"
fi

mkdir -p /opt/agent-memory/current
tar -xzf /tmp/agent-memory-deploy.tgz -C /opt/agent-memory/current

cd /opt/agent-memory/current
npm ci --omit=dev

if [ -f /var/lib/agent-memory/memory.sqlite ]; then
  node dist/cli/backup-database.js backup \
    /var/lib/agent-memory/memory.sqlite "/var/backups/agent-memory/memory.sqlite.$ts"
  chown agent-memory:agent-memory /var/lib/agent-memory/memory.sqlite "/var/backups/agent-memory/memory.sqlite.$ts"
  chmod 600 /var/lib/agent-memory/memory.sqlite "/var/backups/agent-memory/memory.sqlite.$ts"
fi

cp deploy/agent-memory.service /etc/systemd/system/agent-memory.service
systemctl daemon-reload
systemctl enable --now agent-memory

systemctl status agent-memory --no-pager -l
find /var/backups/agent-memory -maxdepth 1 -type f -name 'memory.sqlite.*' -mtime +30 -delete
