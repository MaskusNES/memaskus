#!/usr/bin/env bash
set -euo pipefail

backup="${1:-}"
backup_root="/var/backups/agent-memory"

if [ -z "$backup" ]; then
  echo "Usage: $0 /var/backups/agent-memory/memory.sqlite.TIMESTAMP" >&2
  exit 2
fi

resolved="$(realpath "$backup")"
case "$resolved" in
  "$backup_root"/memory.sqlite.*) ;;
  *)
    echo "Refusing to restore a file outside $backup_root" >&2
    exit 2
    ;;
esac

test -f "$resolved"
systemctl stop agent-memory
if [ -f /var/lib/agent-memory/memory.sqlite ]; then
  cp /var/lib/agent-memory/memory.sqlite "/var/backups/agent-memory/memory.sqlite.before-restore-$(date +%Y%m%d-%H%M%S)"
fi
install -o agent-memory -g agent-memory -m 600 "$resolved" /var/lib/agent-memory/memory.sqlite
systemctl start agent-memory
systemctl is-active --quiet agent-memory
echo "Restored $resolved"
