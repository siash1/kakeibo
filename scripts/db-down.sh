#!/usr/bin/env bash
# Stop whichever Postgres `scripts/db-up.sh` started.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 &&
   docker compose -f "$ROOT/docker-compose.yml" ps -q postgres 2>/dev/null | grep -q .; then
  docker compose -f "$ROOT/docker-compose.yml" down
  exit 0
fi

if [ -d "$ROOT/.pgdata" ]; then
  pg_ctl -D "$ROOT/.pgdata" stop -m fast >/dev/null 2>&1 || true
fi
echo "[db:down] stopped"
