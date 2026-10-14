#!/usr/bin/env bash
set -Eeuo pipefail

# Prepare the complete release before touching the running service.
archive="${1:-/tmp/agent-memory-deploy.tgz}"
test -f "$archive"
command -v curl >/dev/null
command -v flock >/dev/null
exec 9>/run/lock/agent-memory-deploy.lock
flock -n 9 || { echo 'Another deployment is running' >&2; exit 1; }

id -u agent-memory >/dev/null 2>&1 || useradd --system --home /var/lib/agent-memory --shell /usr/sbin/nologin agent-memory
install -d -m 700 -o agent-memory -g agent-memory /var/lib/agent-memory /var/backups/agent-memory
mkdir -p /opt/agent-memory/releases
release="$(mktemp -d /opt/agent-memory/releases/release-XXXXXXXX)"
chmod 755 "$release"
tar -xzf "$archive" -C "$release"
test -f "$release/dist/index.js"
test -f "$release/dist/cli/backup-database.js"
test -f "$release/deploy/agent-memory.service"
(cd "$release" && npm ci --omit=dev)
node -e 'new (require(process.argv[1]))(":memory:").close()' "$release/node_modules/better-sqlite3"

previous="$release.previous"
backup="/var/backups/agent-memory/memory.sqlite.$(basename "$release")"
unit=/etc/systemd/system/agent-memory.service
had_unit=false
was_active=false
stopped=false
switched=false
if [ -f "$unit" ]; then
  cp -p "$unit" "$release.previous.service"
  had_unit=true
fi
if systemctl is-active --quiet agent-memory; then was_active=true; fi

rollback() {
  status=$?
  trap - ERR INT TERM
  set +e
  if "$switched"; then
    systemctl stop agent-memory
    mv /opt/agent-memory/current "$release.failed"
  fi
  if [ -d "$previous" ]; then mv "$previous" /opt/agent-memory/current; fi
  if "$had_unit"; then cp -p "$release.previous.service" "$unit"; fi
  systemctl daemon-reload
  if "$stopped" && "$was_active"; then systemctl start agent-memory; fi
  echo "Deployment failed. Previous release restored when available; database backup: $backup" >&2
  echo 'Database is not automatically rewound: preserve writes and use restore-backup.sh if needed.' >&2
  exit "${status:-1}"
}
trap rollback ERR
trap 'false' INT TERM

if systemctl cat agent-memory >/dev/null 2>&1; then systemctl stop agent-memory; fi
stopped=true
if [ -f /var/lib/agent-memory/memory.sqlite ]; then
  node "$release/dist/cli/backup-database.js" backup /var/lib/agent-memory/memory.sqlite "$backup"
  chown agent-memory:agent-memory "$backup"
  chmod 600 "$backup"
fi
if [ -e /opt/agent-memory/current ]; then mv /opt/agent-memory/current "$previous"; fi
mv "$release" /opt/agent-memory/current
switched=true
cp /opt/agent-memory/current/deploy/agent-memory.service "$unit"
systemctl daemon-reload
systemctl enable --now agent-memory

ready=false
for attempt in {1..30}; do
  if curl --fail --silent --max-time 2 "${MEMORY_READY_URL:-http://127.0.0.1:39110/ready}" >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
"$ready"
systemctl is-active --quiet agent-memory
trap - ERR INT TERM
echo "Deployment ready. Previous release: $previous; database backup: $backup"
