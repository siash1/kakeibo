#!/usr/bin/env bash
# Bring up the kakeibo Postgres on port 5433.
#
# Preferred path: docker compose (postgres:16-alpine, see docker-compose.yml).
# Fallback path:  a dedicated local cluster in ./.pgdata, used when Docker is not
#                 installed on the machine. Either way DATABASE_URL stays exactly
#                 postgres://kakeibo:kakeibo@localhost:5433/kakeibo — nothing
#                 downstream needs to know which path ran.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGDATA_DIR="$ROOT/.pgdata"
PORT=5433
DB=kakeibo
USER_NAME=kakeibo
PASSWORD=kakeibo

log() { printf '\033[2m[db:up]\033[0m %s\n' "$1"; }

wait_ready() {
  for _ in $(seq 1 40); do
    if pg_isready -h localhost -p "$PORT" -q 2>/dev/null; then return 0; fi
    sleep 0.5
  done
  return 1
}

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  log "docker detected -> docker compose up -d"
  docker compose -f "$ROOT/docker-compose.yml" up -d
  wait_ready || { echo "postgres did not become ready on :$PORT" >&2; exit 1; }
  log "ready on localhost:$PORT (docker, postgres:16)"
  exit 0
fi

log "docker not available -> local cluster fallback in .pgdata"

if ! command -v initdb >/dev/null 2>&1; then
  cat >&2 <<'EOF'
Neither Docker nor local Postgres binaries (initdb/pg_ctl) were found.
Install one of:
  - Docker Desktop / colima, then re-run `pnpm db:up`
  - brew install postgresql@16, then re-run `pnpm db:up`
EOF
  exit 1
fi

if [ ! -d "$PGDATA_DIR" ]; then
  log "initdb -> $PGDATA_DIR"
  PWFILE="$(mktemp)"
  printf '%s' "$PASSWORD" >"$PWFILE"
  initdb -D "$PGDATA_DIR" -U "$USER_NAME" --auth=scram-sha-256 --pwfile="$PWFILE" -E UTF8 >/dev/null
  rm -f "$PWFILE"
fi

if pg_isready -h localhost -p "$PORT" -q 2>/dev/null; then
  log "already listening on :$PORT"
else
  log "pg_ctl start on :$PORT"
  pg_ctl -D "$PGDATA_DIR" -l "$ROOT/.pgdata.log" \
    -o "-p $PORT -k '' -c listen_addresses=localhost" start >/dev/null
  wait_ready || { echo "postgres failed to start; see $ROOT/.pgdata.log" >&2; exit 1; }
fi

if ! PGPASSWORD="$PASSWORD" psql -h localhost -p "$PORT" -U "$USER_NAME" -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='$DB'" 2>/dev/null | grep -q 1; then
  log "createdb $DB"
  PGPASSWORD="$PASSWORD" createdb -h localhost -p "$PORT" -U "$USER_NAME" "$DB"
fi

# The application role. Distinct from the owning role above: app_user does NOT
# own the tables, so row-level security applies to it — which is what makes the
# RLS policies a real backstop rather than decoration.
#
# Created here rather than in a migration for two reasons: roles are
# cluster-level objects rather than schema, and the password must not live in
# git. This one is a local development convenience exactly like the
# kakeibo/kakeibo pair above; production (Neon) creates the role out of band and
# supplies its credentials through APP_DATABASE_URL.
PGPASSWORD="$PASSWORD" psql -h localhost -p "$PORT" -U "$USER_NAME" -d "$DB" -q <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_user';
  END IF;
END
$$;
SQL
log "app_user role ready (row-level security applies to it)"

log "ready on localhost:$PORT (local cluster, $(postgres -V | awk '{print $3}'))"
