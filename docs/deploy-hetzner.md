# Deploying kakeibo to a Hetzner box

The alternative to `docs/deploy.md`, which is the Vercel + Neon route. This one
is what actually runs at **https://kakeibo.co.in**: one Hetzner CX-class server,
Postgres in a container beside the app, Caddy in front for TLS, systemd for the
process and the nightly sweep.

It is a **shared** box — another project (`japcar`) runs on :3001 with its own
Postgres and Redis containers. Everything below is written so that nothing
kakeibo does touches it.

## What differs from Vercel, and why each one matters

| | Vercel | Here |
| --- | --- | --- |
| Cron | `vercel.json` | a systemd timer; `vercel.json` is inert |
| Geolocation | `x-vercel-ip-*` headers | a local MMDB file (§5) — the headers do not exist |
| `X-Forwarded-For` | overwritten at the edge, unspoofable | **you must overwrite it yourself** (§4) |
| Build | on their builders | on the box; needs ~1 GB free |
| TLS | automatic | Caddy, automatic once DNS resolves |

## 1. The two orderings that are not optional

**The operator's address.** Identical to `docs/deploy.md` §1 and it applies
here unchanged: deploy with `ADMIN_EMAILS` empty, register your own account
against the production database, mark `email_verified` by hand, *then* set
`ADMIN_EMAILS` and restart. Doing it the other way round leaves a window in
which anyone can claim the address, and nothing here can send a password reset.

**The database role.** Create the container, create `app_user`, **then**
migrate. The RLS grants live inside `packages/ledger/drizzle/0002_rls.sql`,
which does `GRANT ... TO app_user` and fails outright if the role does not exist
yet.

## 2. The database

Its own container, its own volume, published **on localhost only**:

```bash
docker run -d --name kakeibo-postgres --restart unless-stopped \
  -e POSTGRES_USER=kakeibo -e POSTGRES_PASSWORD="$PGPW" -e POSTGRES_DB=kakeibo \
  -p 127.0.0.1:5434:5432 \
  -v kakeibo_pgdata:/var/lib/postgresql/data \
  postgres:16-alpine
```

`127.0.0.1:` is the load-bearing part. **Docker's published ports bypass ufw
entirely** — it writes its own iptables rules — so `-p 5434:5432` would put
Postgres on the public internet no matter what `ufw status` claims. The
neighbouring project on this host demonstrates the failure mode: its Postgres
and Redis are reachable from anywhere while ufw shows only 22 and 3001 open.

Then the role, before any migration:

```sql
create role app_user with login password '<generated>';
```

```bash
DATABASE_URL=... pnpm db:migrate
APP_DATABASE_URL=... pnpm vitest run packages/ledger/src/rls.test.ts   # expect 6/6
```

Run that test. **If `APP_DATABASE_URL` is empty the backstop is silently
inert** — the app falls back to the owning role, nothing fails, and the second
line of defence simply is not there.

There is no `pnpm db:seed` in production. The demo ledger is generated in-process
per visitor by `ensureLedger`; seeding would only create a fixed dev owner.

## 3. Layout, and where `.env` lives

```
/opt/kakeibo/.env          the environment, 0600, outside the deploy directory
/opt/kakeibo/app/          the repository
/opt/kakeibo/app/.env      → symlink to ../.env
/opt/kakeibo/geoip/        the MMDB city database (§5)
```

The symlink is not decoration. `tests/setup.ts` loads `.env` from the
**repository root** and then falls back to a default `DATABASE_URL` on port
5433 — which on this host is the *neighbouring project's* Postgres. Without the
symlink, running any test on the server points it at the wrong database and
fails with `28P01`. It failed exactly that way once; the symlink is the fix.

Keeping the real file one level up means an `rsync --delete` of the deploy
directory can never remove it.

## 4. Caddy

```
kakeibo.co.in {
	reverse_proxy 127.0.0.1:3002 {
		flush_interval -1
		header_up X-Forwarded-For {remote_host}
		header_up X-Real-IP {remote_host}
	}
}

www.kakeibo.co.in {
	redir https://kakeibo.co.in{uri} permanent
}
```

Two lines carry the weight.

**`flush_interval -1`** — `/api/chat` is Server-Sent Events. A buffering proxy
delivers the whole turn at once at the end, which looks like a slow site rather
than a broken one and is therefore easy to miss. Verify by timing the events:
they should arrive spread across the turn, not bunched at its end.

**`header_up X-Forwarded-For {remote_host}`** — overwrite, never append. Caddy's
default appends the peer to whatever the client sent, and `requestIpHash` reads
the **leftmost** entry, so an appended header lets a visitor forge their per-IP
quota bucket and walk past layer 3 of the cost ceiling. nginx has the same trap:
use `proxy_set_header X-Forwarded-For $remote_addr`, never
`$proxy_add_x_forwarded_for`.

To verify: send a request with `X-Forwarded-For: 1.2.3.4`, then compare the key
stored in `rate_limits` against `hashIp('1.2.3.4')`. They must differ.

Open the ports first — `ufw allow 80/tcp && ufw allow 443/tcp` — and point DNS
at the box before reloading Caddy, or ACME fails. A single A record: a parked or
forwarded record left behind by the registrar round-robins the challenge to a
server that knows nothing about it.

## 5. The visitor map

There is no edge here, so `x-vercel-ip-*` never arrives and every `geo_*` column
would stay null. `requestGeo` falls back to a local MMDB lookup.

**Not** a hosted geolocation API: `/privacy` promises that nothing about a
visitor goes anywhere but Google's Gemini API, and posting every address to a
vendor would make that page a lie in exchange for a dot on an operator-only map.

The file is [DB-IP's free city database](https://db-ip.com/db/download/ip-to-city-lite),
CC BY 4.0, no account required, refreshed monthly. `/privacy` carries the
attribution the licence requires.

```bash
install -d /opt/kakeibo/geoip
curl -fsSL "https://download.db-ip.com/free/dbip-city-lite-$(date -u +%Y-%m).mmdb.gz" \
  | gunzip > /opt/kakeibo/geoip/dbip-city-lite.mmdb
```

Set `GEOIP_DB_PATH=/opt/kakeibo/geoip/dbip-city-lite.mmdb`. Empty disables the
lookup, which is correct locally, in CI, and on Vercel. A missing or corrupt
file costs the map its dots and nothing else — it never fails a turn.

A `kakeibo-geoip.timer` refreshes it monthly. The database is loaded into memory
once per process, so a refresh takes effect on the next restart.

## 6. systemd

`kakeibo.service` runs `pnpm start` in `apps/web` with
`EnvironmentFile=/opt/kakeibo/.env` and `NODE_ENV=production`, on `PORT=3002`.

`kakeibo-reap.timer` fires `kakeibo-reap.service` at 03:17 UTC, which curls
`/api/cron/reap` with the `CRON_SECRET` bearer. **This is the only thing that
enforces the 24-hour retention `/privacy` promises.** Without it the reaper never
runs and anonymous ledgers accumulate forever.

03:17 rather than midnight because every cron on every host fires at midnight
and the sweep does not care when it runs.

## 7. Deploying a change

```bash
rsync -az --delete \
  --exclude node_modules --exclude .next --exclude .git --exclude .env \
  --exclude .worktrees --exclude 'data/private' \
  --exclude .pgdata --exclude .pgdata.log --exclude '*.tsbuildinfo' \
  --exclude dist --exclude 'evals/report/runs' --exclude .brand-out \
  ./ root@<host>:/opt/kakeibo/app/

ssh root@<host> '
  cd /opt/kakeibo/app
  pnpm install --frozen-lockfile
  pnpm db:migrate                       # no-op when there is nothing new
  NODE_OPTIONS=--max-old-space-size=2560 pnpm --filter @kakeibo/web build
  systemctl restart kakeibo.service
'
```

`--exclude .env` is required: it both protects the symlink from `--delete` and
stops a local `.env` from overwriting production's.

**rsync does not read `.gitignore`**, so every generated path has to be named
here or it ships. `.pgdata` is the one that matters: `scripts/db-up.sh` falls
back to a local Postgres cluster in `.pgdata/` when Docker is unavailable, so
deploying from a machine without Docker rsyncs ~73 MB of live database files
into the deploy directory. The first version of this list did not mention it
because the original deploy ran from a Docker host, where the directory never
exists. Dry-run first and read the deletions:

```bash
rsync -az --delete --dry-run --itemize-changes … | grep '^\*deleting'
```

Anything listed there that is not a file you meant to remove is a sign the
exclude list is missing something.

**`NEXT_PUBLIC_TURNSTILE_SITE_KEY` is inlined at build time.** Changing it in
the environment does nothing until the app is rebuilt. Every other variable here
is read at runtime and needs only a restart.

## 8. Environment

Everything in `docs/deploy.md`'s table applies, with these differences:

| Variable | Value here |
| --- | --- |
| `DATABASE_URL` | `postgres://kakeibo:…@127.0.0.1:5434/kakeibo` |
| `APP_DATABASE_URL` | same host, as `app_user` — **empty means RLS is inert** |
| `BETTER_AUTH_URL` | `https://kakeibo.co.in` — must match the origin exactly or every mutating auth call fails CSRF |
| `PORT` | `3002` — 3000 and 3001 are taken on this host |
| `GEMINI_AUTH` | `apikey`. Vertex would need a service-account JSON; ADC does not exist on a server |
| `GEOIP_DB_PATH` | `/opt/kakeibo/geoip/dbip-city-lite.mmdb` |
| `CRON_SECRET` | generated locally; the systemd timer reads it from this same file |
| `ALLOW_DESTRUCTIVE_RESET` | **unset**, so `db:reset` and `pnpm eval` refuse to touch production |

## 9. Verifying a deploy

- Every route answers, `/admin` 404s while `ADMIN_EMAILS` is empty.
- `curl -o /dev/null -w '%{http_code}' https://<host>/api/cron/reap` → `404`
  without the bearer, `200` with it.
- One live turn returns a real answer with a tool call and a cost.
- The events of that turn arrive spread over its duration (§4).
- A forged `X-Forwarded-For` does not change the `rate_limits` key (§4).
- `packages/ledger/src/rls.test.ts` passes 6/6 against production (§2).
- Ask the agent to import a path outside `data/` and confirm it is refused —
  that confinement is the only thing between a public chat box and the process's
  environment.
