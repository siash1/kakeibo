# Deploying kakeibo

Vercel for the app, Neon for Postgres, Cloudflare for Turnstile. Two of the
three steps have an order that is not optional; both are below, first.

## The order is not optional (1): the operator's address

`/admin` is gated on an email in `ADMIN_EMAILS` whose `email_verified` is true.
No mail provider is configured, so nothing sets that column automatically, and
`POST /api/auth/sign-up/email` is reachable at the API level even though no
sign-up page exists. Whoever registers the allowlisted address first owns it,
and the owner's address is in every commit header of a public repository.

Therefore:

1. Deploy with `ADMIN_EMAILS` **empty**. `/admin` 404s for everyone, including
   you. This is correct and temporary.
2. Register your own account against the production database, by API:

   ```bash
   curl -s -X POST https://<origin>/api/auth/sign-up/email \
     -H 'Content-Type: application/json' \
     -H 'Origin: https://<origin>' \
     -d '{"email":"<you>","password":"<a real password>","name":"operator"}'
   ```

   The `Origin` header is required: Better Auth rejects a mutating call whose
   origin does not match `BETTER_AUTH_URL`, and `curl` sends none by default.
3. Mark it verified, by hand, once:

   ```sql
   update "user" set email_verified = true where email = '<you>';
   ```

4. Set `ADMIN_EMAILS` to that address and redeploy.
5. Confirm `/admin` opens for you and 404s in a private window.
6. Only now announce the site.

Doing 4 before 2 leaves a window in which anyone can claim the address.

## The order is not optional (2): the Neon role

Create the project, then create the `app_user` role, **then** migrate.
`scripts/db-up.sh` only creates the role locally; the grants live in the
migration `packages/ledger/drizzle/0002_rls.sql`, which does
`GRANT ... TO app_user` and fails outright if the role does not exist yet.

```sql
-- against the Neon project, as the owning role
create role app_user with login password '<a generated password>';
```

```bash
DATABASE_URL='<neon owner connection>' pnpm db:migrate
```

Then confirm row-level security is actually live, rather than assuming it:

```bash
DATABASE_URL='<neon owner connection>' \
APP_DATABASE_URL='<neon app_user connection>' \
  pnpm vitest run packages/ledger/src/rls.test.ts
```

**If `APP_DATABASE_URL` ends up empty, the backstop is silently inert** — the
app falls back to the owning connection, which is not subject to the policies.
Nothing fails; the second line of defence just is not there.

## Environment variables

| Variable | Value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Neon pooled connection string | Owns the tables. Migrations, seeding and `adminDb()` |
| `APP_DATABASE_URL` | Neon connection as `app_user` | **If empty, RLS is silently inert** |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` | Signs session cookies. Never share one between environments |
| `BETTER_AUTH_URL` | the deployed origin | Must match, or every mutating auth call fails CSRF |
| `RATE_LIMIT_SALT` | `openssl rand -hex 16` | Empty in production makes the stored IP hashes a rainbow-table lookup of the IPv4 space |
| `ADMIN_EMAILS` | empty at first | See the ordering above |
| `TURNSTILE_SITE_KEY` | from Cloudflare | |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | the same value | Public by design; this is the one the browser reads |
| `TURNSTILE_SECRET_KEY` | from Cloudflare | Empty disables the check on both halves at once |
| `CRON_SECRET` | Vercel generates it | Sent as a bearer token on every cron invocation. Empty disables the check on an endpoint that deletes rows |
| `GLOBAL_DAILY_BUDGET_USD` | `0.667` | $20/month, about 148 live turns a day |
| `ANON_DAILY_MESSAGE_QUOTA` | `8` | Every visitor is anonymous — there is no sign-up |
| `IP_DAILY_MESSAGE_QUOTA` | `20` | Deliberately above the per-owner quota: offices and carriers share addresses |
| `ALLOW_DESTRUCTIVE_RESET` | **unset** | Leave it unset so `pnpm eval` and `db:reset` cannot touch production |
| `GEMINI_AUTH` / `GCP_PROJECT_ID` | as local | Vertex needs a service account on Vercel, not ADC |
| `AGENT_MODEL` / `SUMMARIZER_MODEL` / `JUDGE_MODEL` | as local | Re-resolve with `pnpm check:providers` before deploying |

## Cloudflare

Create a Turnstile site for the deployed hostname and take both keys. Managed
mode; the widget is rendered `interaction-only`, so most visitors see nothing.

Until both `TURNSTILE_SECRET_KEY` and `NEXT_PUBLIC_TURNSTILE_SITE_KEY` are set,
the gate is off on the server and invisible on the client — deliberately the
same condition on both sides, so they cannot disagree about whether it is on.

## Vercel

Import the repository, set every variable in the table, deploy. `vercel.json`
registers one cron: `/api/cron/reap` at 03:17 UTC. That is the nightly sweep
that keeps the 24-hour retention promise; without it, nothing deletes an
anonymous visitor's ledger.

03:17 rather than midnight because every cron on the platform fires at midnight
and the sweep does not care when it runs.

## Before announcing

- `/` and `/chat` load; a question gets an answer.
- The Turnstile widget lets a turn through, and a **second** turn works too — a
  token is single-use, so a stale one shows up as a 403 on the second question
  and nowhere else.
- `/runs/[id]` opens for that turn.
- `/privacy` deletes everything, and `/dashboard` returns to its empty state.
- `/terms` and `/privacy` are linked from the landing.
- `/sign-in` exists and is linked from nowhere.
- `/admin` 404s while `ADMIN_EMAILS` is empty; then steps 2–5 of the ordering
  above, in order.
- `curl -s -o /dev/null -w '%{http_code}' https://<origin>/api/cron/reap` → `404`
  without the bearer token, `200` with it.
- Ask the agent to import a file outside `data/` — for instance
  `/proc/self/environ` — and confirm it is refused. That confinement is the
  only thing standing between a public chat box and the process's environment.
