# Plan D: Public Launch Surfaces and Deploy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the last surfaces kakeibo needs to be public — an unlinked operator sign-in, a privacy page that tells the truth about traces and can delete a visitor's data on the spot, terms, and a Turnstile gate on the anonymous entry point — then deploy to Vercel + Neon.

**Architecture:** Three paper-genre pages built entirely from the existing primitives in `components/ledger.tsx` (no new visual vocabulary), one new verification module in `apps/web/src/lib/`, one new function in the repository module that already holds the admin connection, and a fourth cost-control layer in front of `/api/chat`. Turnstile is verified server-side in `/api/chat` before any model call, and is inert when unconfigured so local development and CI need no key.

**Tech Stack:** Next.js 15 App Router, React 19, Tailwind 4, Better Auth, Drizzle + Postgres, Cloudflare Turnstile, Vitest, Vercel, Neon.

## Global Constraints

- **Branch:** this plan builds on `ui-overhaul`, which must be merged to `main` first. Its pages use `components/ledger.tsx`, `components/exchange.tsx` and the tokens in `globals.css`; none of them exist on `main`.
- **No AI co-author trailers** in any commit, PR body or comment. Author and committer are the repository owner. (CLAUDE.md)
- **Money is integer minor units.** Formatting happens at the display boundary only. (CLAUDE.md rule 4)
- **Every ledger query is owner-scoped**, takes `OwnerId` first, and is added to `packages/ledger/src/isolation.test.ts`. (CLAUDE.md rule 7)
- **Cross-owner reads live only in `packages/ledger/src/repo/admin.ts`** and take an `AdminSession`. Nothing in this plan adds a module to the containment allowlist. (CLAUDE.md rule 10)
- **Dates in hand-written SQL are UTC-anchored.** Never a bare `current_date`. (CLAUDE.md rule 11)
- **Secrets never in git.** `.env` is gitignored; `.env.example` gets the new keys with empty values.
- **Visual system:** `apps/web/DESIGN.md` is normative. Use documented type steps (`display`, `headline`, `title`, `section`, `subhead`, `body`, `action`, `secondary`, `label`, `mono`), `rounded.none`, and no accent colour. Run `node ~/.claude/skills/impeccable/scripts/detect.mjs --json <changed .tsx>` before each commit that touches UI; it must return `[]`.
- **Gate before every commit:** `pnpm lint && pnpm typecheck && pnpm test`. Reset the database first (`pnpm db:reset && pnpm db:seed`) if the web app has been used against it — `safetyPanel` counts confirm decisions across all owners and one real write turns `admin.test.ts` red.

## Out of scope, deliberately

- **Any sign-up page or form.** Nobody can create an account through the UI. `POST /api/auth/sign-up/email` remains reachable at the API level because Better Auth mounts it; Task 2 documents this residual and the owner's mitigation is the sequencing step in Task 10.
- **`/settings`.** Design spec §7 lists it; the owner removed it on 2026-08-10. Its one surviving job — deletion — moves to `/privacy` (Task 5). Record the amendment (Task 1).
- **Google OAuth.** With no visitor sign-in there is no visitor for it to serve. The `GOOGLE_CLIENT_ID` config stays as-is and unset; `emailVerified` is set by hand, once, per Task 10.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `docs/superpowers/specs/2026-08-09-public-launch-design.md` | Amended: §7 surface table, §8 deletion location, §2 entry model |
| `docs/kakeibo_spec.md` | Amended: §16 gains the Turnstile keys |
| `packages/core/src/env.ts` | Two new keys: `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` |
| `apps/web/src/lib/turnstile.ts` | **New.** Server-side token verification; inert when unconfigured |
| `apps/web/src/lib/turnstile.test.ts` | **New.** Unit tests for the verifier, no network |
| `apps/web/src/app/api/chat/route.ts` | Modified: verify the Turnstile token before `consumeQuota` |
| `apps/web/src/app/(paper)/chat/page.tsx` | Modified: obtain and send a Turnstile token on the first turn |
| `apps/web/src/components/turnstile-gate.tsx` | **New.** Client widget; renders nothing when unconfigured |
| `packages/ledger/src/repo/link.ts` | Modified: `deleteAccount(userId)` — one delete, cascade does the rest |
| `packages/ledger/src/repo/link.test.ts` | **New.** Proves the cascade, and that it touches nobody else |
| `packages/ledger/src/testing.ts` | Modified: `makeOwner`, `seedLedgerFor` shared with the isolation suite |
| `apps/web/src/app/api/account/route.ts` | **New.** `DELETE` — deletes the caller's own data |
| `apps/web/src/app/(paper)/privacy/page.tsx` | **New.** The privacy statement + the delete control |
| `apps/web/src/components/delete-everything.tsx` | **New.** Client confirm-then-delete control |
| `apps/web/src/app/(paper)/terms/page.tsx` | **New.** Terms |
| `apps/web/src/app/(paper)/sign-in/page.tsx` | **New.** Unlinked operator door |
| `apps/web/src/components/nav.tsx` | Modified: footer links to `/privacy` and `/terms`; `/sign-in` stays unlinked |
| `apps/web/src/app/(paper)/page.tsx` | Modified: footer gains the legal links |
| `vercel.json` | **New.** Cron for the reaper |
| `apps/web/src/app/api/cron/reap/route.ts` | **New.** Authenticated reaper endpoint |
| `docs/deploy.md` | **New.** The deploy runbook and its ordering requirement |

---

### Task 1: Record the scope amendments before building against them

The design spec still says `/settings` exists and that an account is how you persist. Building the opposite while the spec says otherwise is how the next reader concludes the code is wrong.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-09-public-launch-design.md`
- Modify: `docs/kakeibo_spec.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing in code. Later tasks cite these amendments.

- [ ] **Step 1: Amend the surfaces table (§7)**

In `docs/superpowers/specs/2026-08-09-public-launch-design.md`, find the `/settings` row of the §7 table and replace that single row with nothing, then add this directly beneath the table:

```markdown
*Amended 2026-08-10 (owner).* `/settings` is removed and there is no sign-up
page. Deletion — its one job that survives — moves onto `/privacy`, next to the
sentence that promises it. A single unlinked `/sign-in` exists as the operator's
door to `/admin`; it is email-and-password only, carries no sign-up form, and is
linked from nowhere. The consequence is deliberate and worth stating: no visitor
can create an account, so every visitor is anonymous and the 24-hour reaper
applies to all of them without exception.
```

- [ ] **Step 2: Amend the entry decision (§1 decisions table)**

Find the row `| Entry | Anonymous try-it-now; an account only to persist |` and append beneath the table:

```markdown
*Amended 2026-08-10 (owner).* The second half no longer holds: there is no way
to persist, because there is no sign-up. Anonymous try-it-now is the whole entry
model.
```

- [ ] **Step 3: Amend the deletion bullet (§8)**

Replace the `- **Deletion.**` bullet with:

```markdown
- **Deletion.** `/privacy` offers one-click deletion of the visitor's entire
  ledger and their anonymous account, cascading through `owner_id`. It sits on
  the privacy page rather than on a settings page because the control belongs
  beside the promise it honours, and because there is no account to manage.
```

- [ ] **Step 4: Add the Turnstile keys to `docs/kakeibo_spec.md` §16**

After the `ADMIN_EMAILS` line in the §16 `.env.example` block, add:

```
# Turnstile (Plan D). Both empty disables the check entirely, which is the
# normal local and CI state. Set both in production.
TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_KEY=
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-08-09-public-launch-design.md docs/kakeibo_spec.md
git commit -m "Record the scope the owner cut from Plan D

No sign-up, no /settings, one unlinked operator sign-in. The spec said
otherwise in three places, and a plan that contradicts its own spec reads as a
mistake rather than a decision."
```

---

### Task 2: The operator's sign-in page

**Files:**
- Create: `apps/web/src/app/(paper)/sign-in/page.tsx`
- Test: manual — see Step 5. There is no unit test here; the page is a form over `authClient`, and a test that mocks the client would assert the mock.

**Interfaces:**
- Consumes: `authClient` from `@/lib/auth-client` (`signIn.email({ email, password })`).
- Produces: the route `/sign-in`. Nothing imports it.

- [ ] **Step 1: Write the page**

Create `apps/web/src/app/(paper)/sign-in/page.tsx`:

```tsx
'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Mark } from '@/components/ledger'
import { authClient } from '@/lib/auth-client'

/**
 * /sign-in — the operator's door, and nothing else.
 *
 * There is no sign-up form here and no link to this page from anywhere in the
 * app. It exists because `/admin` requires a session that is neither anonymous
 * nor unverified, and Plan C's dashboard is otherwise unreachable from a
 * browser. A visitor has no reason to be here and no way to find it.
 *
 * It is deliberately the plainest page on the site: a heading, two fields, one
 * button. Anything more would be designing a surface for a user who does not
 * exist.
 */
export default function SignInPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    const { error: failure } = await authClient.signIn.email({ email, password })
    setBusy(false)
    if (failure) {
      // Better Auth's message is deliberately vague about which half was wrong.
      // Keep it that way: a precise error here is an account-enumeration oracle.
      setError('That email and password did not match.')
      return
    }
    router.push('/admin')
    router.refresh()
  }

  return (
    <div className="mx-auto max-w-[38ch] py-20">
      <h1 className="font-serif text-[clamp(1.75rem,5vw,2.5rem)] leading-[1.1] tracking-[-0.025em]">
        Sign in
      </h1>
      <p className="mt-3 text-[13px] leading-relaxed text-sumi-600">
        For the operator. kakeibo has no accounts — everyone else uses it
        anonymously, and nothing on the site links here.
      </p>

      <form onSubmit={submit} className="mt-10">
        <label htmlFor="email" className="text-[11px] uppercase tracking-[0.09em] text-sumi-500">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="mt-1 mb-6 block w-full border-b-2 border-rule-strong bg-transparent py-1.5 font-serif text-[17px] text-sumi-900 transition-colors focus:border-sumi-900 focus:outline-none"
        />

        <label htmlFor="password" className="text-[11px] uppercase tracking-[0.09em] text-sumi-500">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-1 block w-full border-b-2 border-rule-strong bg-transparent py-1.5 font-serif text-[17px] text-sumi-900 transition-colors focus:border-sumi-900 focus:outline-none"
        />

        {error ? (
          <div className="mt-6 border-y border-rule py-3">
            <Mark tone="danger">failed</Mark>
            <p className="mt-1 text-[14px] text-sumi-800">{error}</p>
          </div>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="mt-8 bg-sumi-900 px-6 py-2.5 text-[14px] text-paper-50 transition-colors hover:bg-sumi-800 disabled:bg-paper-200 disabled:text-sumi-500"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
```

- [ ] **Step 2: Run the detector**

```bash
cd apps/web && node ~/.claude/skills/impeccable/scripts/detect.mjs --json "src/app/(paper)/sign-in/page.tsx"
```

Expected: `[]`

- [ ] **Step 3: Run the gate**

```bash
pnpm lint && pnpm typecheck
```

Expected: both pass.

- [ ] **Step 4: Verify the page renders**

```bash
PORT=3100 BETTER_AUTH_URL=http://localhost:3100 pnpm dev
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3100/sign-in
```

Expected: `200`

- [ ] **Step 5: Verify it actually signs in, and that /admin opens**

In a browser at `http://localhost:3100/sign-in`, with `ADMIN_EMAILS` set in `.env` to the address you are about to use:

1. Create the account once, by API, because there is no sign-up form:
   ```bash
   curl -s -X POST http://localhost:3100/api/auth/sign-up/email \
     -H 'Content-Type: application/json' \
     -H 'Origin: http://localhost:3100' \
     -d '{"email":"you@example.com","password":"<a real password>","name":"operator"}' | head -c 200
   ```
2. Mark it verified (no mail provider exists):
   ```bash
   psql "$DATABASE_URL" -c "update \"user\" set email_verified = true where email = 'you@example.com'"
   ```
3. Sign in through the page. Expect a redirect to `/admin` and the dashboard rendering rather than a 404.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/src/app/(paper)/sign-in/page.tsx"
git commit -m "Add the operator's door

/admin needs a session that is neither anonymous nor unverified, and with no
sign-up there was no way to get one from a browser — the dashboard Plan C built
was reachable only by POSTing to the auth API by hand.

Deliberately the plainest page on the site, and linked from nowhere. The error
message stays vague about which half was wrong, because a precise one is an
account-enumeration oracle on the only account that exists."
```

---

### Task 3: Deleting an account, which is the whole of "delete everything"

CLAUDE.md rule 7 already settles the mechanism: *"Deleting a user is the whole
implementation of both the anonymous reaper and 'delete everything'."* Every
`owner_id` references `"user"(id) on delete cascade`, so one delete removes the
ledger, the conversation, the traces and the suspended turns with it. Do not
build a second deletion path that has to be kept in step with `OWNED`.

`link.ts` already holds the RLS-bypassing connection and is already named in
`admin-containment.test.ts`'s allowlist, so this adds no entry to it. It has to
be the admin connection: `app_user` has **no privileges at all** on `"user"`.

**Files:**
- Modify: `packages/ledger/src/repo/link.ts`
- Test: `packages/ledger/src/repo/link.test.ts` (create if absent)

**Interfaces:**
- Consumes: `adminDb` from `../db`, `user` from `../auth-schema`, `eq` from `drizzle-orm`.
- Produces: `deleteAccount(userId: string): Promise<boolean>` — deletes exactly that
  user row and returns whether one was removed. Task 4 calls it.

- [ ] **Step 1: Write the failing test**

Create or extend `packages/ledger/src/repo/link.test.ts`:

```ts
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { user } from '../auth-schema'
import { adminDb, closeDb } from '../db'
import { asOwnerId } from '../owner'
import { deleteAccount } from './link'
import { searchTransactions } from './transactions'
import { ensureSeedAccounts } from './accounts'
import { makeOwner, resetOwners, seedLedgerFor } from '../testing'

afterAll(async () => {
  await closeDb()
})

describe('deleteAccount', () => {
  it('takes the ledger with it, and touches nobody else', async () => {
    // The cascade is the feature. If this ever fails it means an owner_id
    // somewhere lost its `on delete cascade`, and the visitor-facing promise
    // on /privacy silently became false.
    const mine = await makeOwner()
    const theirs = await makeOwner()
    await seedLedgerFor(mine)
    await seedLedgerFor(theirs)

    expect((await searchTransactions(mine, { limit: 500 })).length).toBeGreaterThan(0)

    expect(await deleteAccount(mine)).toBe(true)

    const survivors = await adminDb().select().from(user).where(eq(user.id, mine))
    expect(survivors).toHaveLength(0)
    expect((await searchTransactions(mine, { limit: 500 })).length).toBe(0)
    expect((await searchTransactions(theirs, { limit: 500 })).length).toBeGreaterThan(0)

    // Deleting a user who is already gone is not an error; the reaper and a
    // double-clicked button both do it.
    expect(await deleteAccount(mine)).toBe(false)

    await resetOwners(theirs)
  })
})
```

`makeOwner` and `seedLedgerFor` may not exist in `packages/ledger/src/testing.ts`.
If they do not, add them there — `makeOwner()` inserts a row into `"user"` with
`gen_random_uuid()` and returns `asOwnerId(id)`; `seedLedgerFor(owner)` does what
`isolation.test.ts`'s local `seedLedger` already does. Export both, and have
`isolation.test.ts` use `seedLedgerFor` rather than keeping its own copy.

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm vitest run packages/ledger/src/repo/link.test.ts
```

Expected: FAIL — `deleteAccount` is not exported.

- [ ] **Step 3: Implement it**

In `packages/ledger/src/repo/link.ts`, add the `user` import from `../auth-schema`
and append:

```ts
/**
 * Delete one account, and with it everything that account owned.
 *
 * This is the entire implementation of "delete everything" (CLAUDE.md rule 7).
 * Every `owner_id` references `"user"(id) on delete cascade`, so the ledger,
 * the conversation, the traces and any suspended turn go with the row — which
 * is why there is deliberately no second deletion path here to fall out of step
 * with `OWNED`.
 *
 * `adminDb()` and not the app connection: `app_user` has no privileges at all
 * on `"user"`, which is the same reason Better Auth is configured against the
 * admin pool. `link.ts` is already on the containment allowlist, so this adds
 * no new module to it.
 *
 * Returns false when the row was already gone. A visitor double-clicking the
 * button and the nightly reaper racing it are both ordinary, not errors.
 */
export async function deleteAccount(userId: string): Promise<boolean> {
  const removed = await adminDb()
    .delete(user)
    .where(eq(user.id, userId))
    .returning({ id: user.id })
  return removed.length > 0
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm db:reset && pnpm db:seed
pnpm vitest run packages/ledger/src/repo/link.test.ts
```

Expected: PASS

- [ ] **Step 5: Confirm the containment test still holds**

```bash
pnpm vitest run packages/ledger/src/admin-containment.test.ts
```

Expected: PASS with no allowlist change. If it fails, you have added `adminDb()`
to a module that is not on the list — move the function into `link.ts` rather
than adding an entry.

- [ ] **Step 6: Full gate and commit**

```bash
pnpm db:reset && pnpm db:seed && pnpm lint && pnpm typecheck && pnpm test
git add packages/ledger/src/repo/link.ts packages/ledger/src/repo/link.test.ts packages/ledger/src/testing.ts packages/ledger/src/isolation.test.ts
git commit -m "Delete an account by deleting the account

Rule 7 already settled this: deleting the user row is the whole implementation
of both the reaper and delete-everything, because every owner_id cascades from
it. A second deletion path walking OWNED would be one table behind the schema
the first time someone adds a table and forgets.

The test asserts the cascade rather than the delete — if it ever fails it means
an owner_id lost its on-delete-cascade and the promise on /privacy quietly
became false."
```

---

### Task 4: The deletion endpoint

**Files:**
- Create: `apps/web/src/app/api/account/route.ts`

**Interfaces:**
- Consumes: `auth` from `@/lib/auth`; `deleteAccount` from `@kakeibo/ledger` (Task 3).
- Produces: `DELETE /api/account` → `200 {"deleted": true|false}` or `401`. Task 6 calls it.

- [ ] **Step 1: Write the route**

Create `apps/web/src/app/api/account/route.ts`:

```ts
import { deleteAccount } from '@kakeibo/ledger'
import { auth } from '@/lib/auth'

/**
 * DELETE /api/account — the visitor erases themselves.
 *
 * One statement does all of it: deleting the `"user"` row cascades through
 * every `owner_id` and takes the ledger, the conversation, the traces and any
 * suspended turn with it (CLAUDE.md rule 7).
 *
 * It reads the session directly rather than going through `resolveOwner`,
 * which signs an anonymous visitor in when there is none. A DELETE that
 * silently creates an account and then deletes it would return a cheerful 200
 * having touched nothing of the caller's.
 *
 * The session cookie is left pointing at a row that no longer exists, which
 * Better Auth treats as signed out on the next request — so the visitor lands
 * back where a first-time visitor lands, which is the correct end state.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) return Response.json({ error: 'no session' }, { status: 401 })

  const deleted = await deleteAccount(session.user.id)
  return Response.json({ deleted })
}
```

- [ ] **Step 2: Verify the unauthenticated case**

```bash
curl -s -X DELETE http://localhost:3100/api/account -w "\n%{http_code}\n"
```

Expected: `{"error":"no session"}` and `401`.

- [ ] **Step 3: Verify the authenticated case end to end**

At `http://localhost:3100/chat`, ask one question so a ledger exists, then in
devtools:

```js
await fetch('/api/account', { method: 'DELETE' }).then((r) => r.json())
```

Expected: `{ deleted: true }`. Reload `/dashboard`; expect the signed-out empty
state, not a populated ledger.

- [ ] **Step 4: Gate and commit**

```bash
pnpm lint && pnpm typecheck
git add apps/web/src/app/api/account/route.ts
git commit -m "Add the endpoint that erases a visitor

One statement: the user row goes and every owner_id cascades from it.

It reads the session directly instead of resolveOwner, which mints an anonymous
user when there is none — a DELETE that quietly creates an account and deletes
it would return a cheerful 200 having touched nothing the caller owned."
```

---

### Task 5: The privacy page

**Files:**
- Create: `apps/web/src/app/(paper)/privacy/page.tsx`

**Interfaces:**
- Consumes: `Section` from `@/components/ledger`; `DeleteEverything` from `@/components/delete-everything` (Task 6).
- Produces: the route `/privacy`. Task 7 links to it.

Build Task 6 first if you prefer a compiling tree at every step; the import below expects it.

- [ ] **Step 1: Write the page**

Create `apps/web/src/app/(paper)/privacy/page.tsx`:

```tsx
import { DeleteEverything } from '@/components/delete-everything'
import { Section } from '@/components/ledger'

/**
 * /privacy — what is stored, for how long, and who can read it.
 *
 * Design spec §9.6 is the obligation this page exists to discharge: trace
 * payloads contain tool arguments and results, so an operator reading a trace
 * is reading that visitor's ledger contents. That sentence is not buried, and
 * it is not softened.
 *
 * The delete control lives here rather than on a settings page because there is
 * no account to have settings for, and because a promise and the button that
 * honours it belong on the same page.
 */
export const metadata = { title: 'Privacy' }

export default function PrivacyPage() {
  return (
    <div className="max-w-[68ch]">
      <header className="border-b border-sumi-900 pb-6">
        <h1 className="font-serif text-[clamp(1.75rem,5vw,2.5rem)] leading-[1.1] tracking-[-0.025em]">
          Privacy
        </h1>
        <p className="mt-3 text-[15px] leading-[1.6] text-sumi-600">
          kakeibo is a demonstration of a piece of engineering, not a financial
          service. This page says exactly what it keeps and who can see it.
        </p>
      </header>

      <Section title="What you get when you arrive">
        <p className="text-[15px] leading-[1.7] text-sumi-900">
          A copy of a 352-transaction synthetic ledger, generated for this
          project and belonging to nobody. It is created the first time you ask
          the agent something or open the dashboard, not when you load a page,
          so visiting costs nothing. You are signed in anonymously to hold it —
          there are no accounts here and no way to make one.
        </p>
      </Section>

      <Section title="What is stored">
        <ul className="space-y-3 text-[15px] leading-[1.7] text-sumi-900">
          <li>Your copy of the ledger, and anything you change in it.</li>
          <li>
            Your conversation with the agent, so a reload picks the thread up
            rather than starting a second one.
          </li>
          <li>
            A trace of every model call and tool call in that conversation —
            what was asked, which tools ran, what they returned, and what it
            cost.
          </li>
          <li>
            An approximate city-level location derived from your request&rsquo;s
            IP address, for operational analytics. No browser location prompt is
            ever shown, and nothing about the site behaves differently because
            of it.
          </li>
          <li>
            A salted hash of your IP address, used to count messages per day
            against the site&rsquo;s cost ceiling. The address itself is never
            written down.
          </li>
        </ul>
      </Section>

      <Section title="Who can read it">
        <p className="text-[15px] leading-[1.7] text-sumi-900">
          The operator can. Traces contain the arguments and results of every
          tool call, which means a trace of your conversation contains the
          contents of your ledger — the merchants, the amounts, the dates. An
          operator reading a trace to debug the agent is reading your data. That
          is a real consequence of building the thing this way, and it is stated
          here rather than buried in the architecture.
        </p>
        <p className="mt-4 text-[15px] leading-[1.7] text-sumi-900">
          Nothing is shared with anyone else. Prompts and tool results go to
          Google&rsquo;s Gemini API to be answered, and to nowhere else.
        </p>
      </Section>

      <Section title="If you upload a real statement">
        <p className="text-[15px] leading-[1.7] text-sumi-900">
          You may, and the raw CSV is never written to disk or to the database —
          it is parsed in memory and only the derived rows are stored. Those rows
          are deleted with everything else after 24 hours. Given the paragraph
          above about traces, uploading a real statement is not advised.
        </p>
      </Section>

      <Section
        title="How long it lasts"
        note="Twenty-four hours from when your session was created, swept nightly. There is no way to extend it, because there is no account to attach it to."
      >
        <DeleteEverything />
      </Section>

      <footer className="mt-16 border-t border-rule pt-4 text-[12px] leading-relaxed text-sumi-500">
        The source is public at{' '}
        <a href="https://github.com/siash1/kakeibo">github.com/siash1/kakeibo</a>
        , including everything described here.
      </footer>
    </div>
  )
}
```

- [ ] **Step 2: Detector, then gate**

```bash
cd apps/web && node ~/.claude/skills/impeccable/scripts/detect.mjs --json "src/app/(paper)/privacy/page.tsx"
cd ../.. && pnpm lint && pnpm typecheck
```

Expected: `[]`, then both pass.

- [ ] **Step 3: Verify it renders**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3100/privacy
```

Expected: `200`

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(paper)/privacy/page.tsx"
git commit -m "Say plainly that an operator reading a trace reads your ledger

Design spec 9.6 is an obligation, not a disclosure to bury: trace payloads carry
tool arguments and results, so debugging the agent means reading a visitor's
merchants and amounts. It gets its own section and its own sentence.

Deletion lives on this page because there is no account to have settings for,
and a promise belongs on the same page as the button that honours it."
```

---

### Task 6: The delete-everything control

**Files:**
- Create: `apps/web/src/components/delete-everything.tsx`

**Interfaces:**
- Consumes: `DELETE /api/account` (Task 4).
- Produces: `<DeleteEverything />`, a default-exported-free named export used by Task 5.

- [ ] **Step 1: Write the component**

Create `apps/web/src/components/delete-everything.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { Mark } from '@/components/ledger'

/**
 * Erase everything, with one confirmation step and no modal.
 *
 * The confirmation is a second button rather than a dialog because the action
 * is irreversible but not dangerous to anyone else, and a modal for a
 * two-second decision is the interruption the craft floor refuses. The armed
 * state says what will go, in the visitor's terms, before it goes.
 */
export function DeleteEverything() {
  const [armed, setArmed] = useState(false)
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'failed'>('idle')

  async function erase() {
    setState('working')
    try {
      const response = await fetch('/api/account', { method: 'DELETE' })
      if (!response.ok) throw new Error(String(response.status))
      setState('done')
    } catch {
      setState('failed')
    }
  }

  if (state === 'done') {
    return (
      <div className="border-y border-rule py-4">
        <Mark tone="ok">deleted</Mark>
        <p className="mt-1 text-[15px] leading-relaxed text-sumi-900">
          Your ledger, your conversation and your traces are gone, and so is the
          anonymous account that held them. Opening the chat again starts you
          over with a fresh copy of the synthetic ledger.
        </p>
      </div>
    )
  }

  return (
    <div className="border-y border-rule py-4">
      {armed ? (
        <>
          <p className="text-[15px] leading-relaxed text-sumi-900">
            This deletes your ledger, your conversation, every trace of it, and
            the anonymous account holding them. It cannot be undone.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            <button
              type="button"
              onClick={erase}
              disabled={state === 'working'}
              className="bg-sumi-900 px-5 py-2 text-[14px] text-paper-50 transition-colors hover:bg-sumi-800 disabled:bg-paper-200 disabled:text-sumi-500"
            >
              {state === 'working' ? 'Deleting…' : 'Delete it all'}
            </button>
            <button
              type="button"
              onClick={() => setArmed(false)}
              className="border border-sumi-900 px-5 py-2 text-[14px] text-sumi-900 transition-colors hover:bg-paper-200"
            >
              Keep it
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setArmed(true)}
          className="border border-sumi-900 px-5 py-2 text-[14px] text-sumi-900 transition-colors hover:bg-paper-200"
        >
          Delete everything now
        </button>
      )}

      {state === 'failed' ? (
        <div className="mt-4">
          <Mark tone="danger">failed</Mark>
          <p className="mt-1 text-[14px] text-sumi-800">
            Nothing was deleted. Reload and try again; if it keeps failing, your
            data is still removed automatically within 24 hours.
          </p>
        </div>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 2: Detector and gate**

```bash
cd apps/web && node ~/.claude/skills/impeccable/scripts/detect.mjs --json "src/components/delete-everything.tsx"
cd ../.. && pnpm lint && pnpm typecheck
```

Expected: `[]`, then both pass.

- [ ] **Step 3: Verify all four states by hand**

At `http://localhost:3100/privacy`, after asking the agent one question so a ledger exists:

1. Idle — one outlined button.
2. Armed — the sentence naming what goes, plus Delete/Keep.
3. Keep — returns to idle, nothing deleted (check `/dashboard` still has data).
4. Delete — the done state; `/dashboard` shows its empty state.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/delete-everything.tsx
git commit -m "Add the delete control, armed by a second button rather than a modal

Irreversible, but not dangerous to anyone else, and a modal for a two-second
decision is the interruption the craft floor refuses. The armed state names what
is about to go in the visitor's terms rather than asking them to confirm an
abstraction."
```

---

### Task 7: The terms page and the legal links

**Files:**
- Create: `apps/web/src/app/(paper)/terms/page.tsx`
- Modify: `apps/web/src/app/(paper)/page.tsx` (footer)

**Interfaces:**
- Consumes: `Section` from `@/components/ledger`.
- Produces: the route `/terms`.

- [ ] **Step 1: Write the page**

Create `apps/web/src/app/(paper)/terms/page.tsx`:

```tsx
import { Section } from '@/components/ledger'

/**
 * /terms — short, because the honest version is short.
 *
 * This is a portfolio piece with no payment, no account and no promise of
 * availability. Terms written to sound like a company's would be the only
 * dishonest page on a site whose entire argument is that its claims are
 * checkable.
 */
export const metadata = { title: 'Terms' }

export default function TermsPage() {
  return (
    <div className="max-w-[68ch]">
      <header className="border-b border-sumi-900 pb-6">
        <h1 className="font-serif text-[clamp(1.75rem,5vw,2.5rem)] leading-[1.1] tracking-[-0.025em]">
          Terms
        </h1>
        <p className="mt-3 text-[15px] leading-[1.6] text-sumi-600">
          Short, because the honest version is short.
        </p>
      </header>

      <Section title="What this is">
        <p className="text-[15px] leading-[1.7] text-sumi-900">
          A demonstration of an AI agent built on a double-entry ledger, run by
          one person as a portfolio piece. It is not a financial service, not
          advice, and not a product. Nothing it tells you about money should be
          acted on.
        </p>
      </Section>

      <Section title="What it costs, and what that buys you">
        <p className="text-[15px] leading-[1.7] text-sumi-900">
          Nothing, and correspondingly little. Every model call is billed to one
          person&rsquo;s card against a fixed monthly ceiling. When the ceiling
          is reached, live chat stops until the next day and the site says so.
          There is no uptime commitment and no support.
        </p>
      </Section>

      <Section title="Your data">
        <p className="text-[15px] leading-[1.7] text-sumi-900">
          Deleted automatically within 24 hours, or immediately if you ask.{' '}
          <a href="/privacy">The privacy page</a> describes what is stored and
          who can read it — including the part where the operator can see your
          ledger contents in a diagnostic trace. Please read it before uploading
          anything real.
        </p>
      </Section>

      <Section title="Liability">
        <p className="text-[15px] leading-[1.7] text-sumi-900">
          Provided as-is, with no warranty of any kind. The source is MIT
          licensed and public; if something here matters to you, read it.
        </p>
      </Section>
    </div>
  )
}
```

- [ ] **Step 2: Add the legal links to the landing footer**

In `apps/web/src/app/(paper)/page.tsx`, inside the `<nav aria-label="The machine room">` list, after the GitHub `<li>`, add:

```tsx
<li>
  <Link href="/privacy">Privacy</Link>
</li>
<li>
  <Link href="/terms">Terms</Link>
</li>
```

- [ ] **Step 3: Detector and gate**

```bash
cd apps/web && node ~/.claude/skills/impeccable/scripts/detect.mjs --json "src/app/(paper)/terms/page.tsx" "src/app/(paper)/page.tsx"
cd ../.. && pnpm lint && pnpm typecheck
```

Expected: `[]`, then both pass.

- [ ] **Step 4: Verify both routes and the links**

```bash
for p in /terms /privacy; do printf "%s %s\n" "$p" "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3100$p)"; done
curl -s http://localhost:3100/ | grep -o 'href="/\(privacy\|terms\)"' | sort -u
```

Expected: `200` for both, and both hrefs present on the landing.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/(paper)/terms/page.tsx" "apps/web/src/app/(paper)/page.tsx"
git commit -m "Add terms, and link the legal pages from the landing

Four short sections. Terms written to sound like a company's would be the only
dishonest page on a site whose whole argument is that its claims are checkable —
there is no payment, no account and no availability promise to write about."
```

---

### Task 8: Turnstile verification, server side

**Files:**
- Modify: `packages/core/src/env.ts`
- Create: `apps/web/src/lib/turnstile.ts`
- Test: `apps/web/src/lib/turnstile.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `env()` from `@kakeibo/core/env`.
- Produces:
  - `turnstileConfigured(): boolean`
  - `verifyTurnstile(token: string | undefined, ip?: string): Promise<boolean>` — resolves `true` when unconfigured.

- [ ] **Step 1: Add the two env keys**

In `packages/core/src/env.ts`, after `RATE_LIMIT_SALT`, add:

```ts
  /**
   * Turnstile (spec §5, layer 4). Both empty disables the check completely,
   * which is the correct local and CI state: a challenge nobody can solve
   * headlessly would make every test that posts a chat message fail for a
   * reason unrelated to what it is testing.
   */
  TURNSTILE_SITE_KEY: z.string().default(''),
  TURNSTILE_SECRET_KEY: z.string().default(''),
```

Add the same two keys, with empty values and the same comment condensed to one line, to `.env.example`.

- [ ] **Step 2: Write the failing tests**

Create `apps/web/src/lib/turnstile.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { turnstileConfigured, verifyTurnstile } from './turnstile'

afterEach(() => {
  delete process.env.TURNSTILE_SECRET_KEY
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('turnstile', () => {
  it('is inert when unconfigured, and says so', async () => {
    // The important half: with no secret set, an absent token still passes.
    // Otherwise every local run and every CI run fails on a challenge that
    // cannot be solved without a browser.
    expect(turnstileConfigured()).toBe(false)
    await expect(verifyTurnstile(undefined)).resolves.toBe(true)
  })

  it('rejects a missing token once configured', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secret'
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await expect(verifyTurnstile(undefined)).resolves.toBe(false)
    // No token means no reason to ask Cloudflare.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('passes a token Cloudflare accepts', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secret'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) }),
    )
    await expect(verifyTurnstile('good-token')).resolves.toBe(true)
  })

  it('fails closed when Cloudflare rejects or errors', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secret'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: false }) }),
    )
    await expect(verifyTurnstile('bad-token')).resolves.toBe(false)

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    await expect(verifyTurnstile('any-token')).resolves.toBe(false)
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

```bash
pnpm vitest run apps/web/src/lib/turnstile.test.ts
```

Expected: FAIL — cannot resolve `./turnstile`.

- [ ] **Step 4: Implement it**

Create `apps/web/src/lib/turnstile.ts`:

```ts
import { env } from '@kakeibo/core/env'

/**
 * Cloudflare Turnstile, layer 4 of the cost ceiling (design spec §5).
 *
 * The first three layers count what a visitor already spent. This one is the
 * only layer that costs an attacker anything *before* they spend the owner's
 * money, which is why it sits in front of the model call rather than beside it.
 *
 * Unconfigured means disabled, deliberately. A challenge cannot be solved by a
 * headless test or a local `pnpm dev` without a real site key, so requiring one
 * would turn every chat test into a failure about Cloudflare. Production sets
 * both keys; nothing else does.
 *
 * It fails closed once configured: a network error talking to Cloudflare
 * rejects the turn. The alternative — treating an unreachable verifier as a
 * pass — makes the layer removable by anyone who can make one request fail.
 */

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export function turnstileConfigured(): boolean {
  return env().TURNSTILE_SECRET_KEY !== ''
}

export async function verifyTurnstile(
  token: string | undefined,
  ip?: string | undefined,
): Promise<boolean> {
  const secret = env().TURNSTILE_SECRET_KEY
  if (secret === '') return true
  if (!token) return false

  const body = new URLSearchParams({ secret, response: token })
  if (ip) body.set('remoteip', ip)

  try {
    const response = await fetch(VERIFY_URL, { method: 'POST', body })
    if (!response.ok) return false
    const result = (await response.json()) as { success?: boolean }
    return result.success === true
  } catch {
    return false
  }
}
```

Note: `env()` caches. The tests set `process.env` before the first call in each case; if `env()` proves to be memoised across tests, import and call `resetEnvCache()` from `@kakeibo/core/env` in the `afterEach`, exactly as `admin.test.ts` does.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm vitest run apps/web/src/lib/turnstile.test.ts
```

Expected: 4 passed.

- [ ] **Step 6: Gate and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add packages/core/src/env.ts apps/web/src/lib/turnstile.ts apps/web/src/lib/turnstile.test.ts .env.example
git commit -m "Verify Turnstile tokens, and disable the check when unconfigured

Layer 4 of the cost ceiling, and the only layer that costs an attacker anything
before it costs the owner anything — so it goes in front of the model call.

Unconfigured means disabled on purpose: a challenge cannot be solved headlessly,
so requiring one would turn every chat test into a failure about Cloudflare.
Once configured it fails closed, including on a network error, because treating
an unreachable verifier as a pass makes the layer removable by anyone who can
break one request."
```

---

### Task 9: Wire Turnstile into the chat entry point

**Files:**
- Create: `apps/web/src/components/turnstile-gate.tsx`
- Modify: `apps/web/src/app/api/chat/route.ts`
- Modify: `apps/web/src/app/(paper)/chat/page.tsx`

**Interfaces:**
- Consumes: `verifyTurnstile`, `turnstileConfigured` (Task 8); `requestIpHash` is *not* used here — Turnstile wants the address, not a hash, and we do not have the raw address after `requestIpHash`. Read `x-forwarded-for` directly and pass its leftmost entry.
- Produces: `<TurnstileGate onToken={(t: string) => void} />`.

- [ ] **Step 1: Gate the API route**

In `apps/web/src/app/api/chat/route.ts`, change the body parse to accept the token and verify before `consumeQuota`:

```ts
  const body = (await request.json()) as {
    message?: string
    conversationId?: string
    turnstileToken?: string
  }
  const message = body.message?.trim()
  if (!message) return Response.json({ error: 'message is required' }, { status: 400 })

  // Before the owner is resolved and long before a model is called: this layer
  // exists to stop automated traffic from spending the budget at all, and
  // resolving an owner first would mint an anonymous user per bot request.
  const address = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (!(await verifyTurnstile(body.turnstileToken, address))) {
    return Response.json({ error: 'Verification failed. Reload and try again.' }, { status: 403 })
  }
```

Add the import:

```ts
import { verifyTurnstile } from '@/lib/turnstile'
```

- [ ] **Step 2: Write the widget**

Create `apps/web/src/components/turnstile-gate.tsx`:

```tsx
'use client'

import Script from 'next/script'
import { useEffect, useRef } from 'react'

/**
 * The Turnstile widget, or nothing at all.
 *
 * Renders nothing when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is absent, which is the
 * local and CI state — the server-side check is inert in exactly the same
 * condition, so the two halves cannot disagree about whether the gate is on.
 *
 * Managed mode, so most visitors see a checkbox for a moment and nothing else.
 * The token is short-lived and single-use: the callback hands each fresh one
 * upward and the page sends the newest with its next turn.
 */
declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, options: Record<string, unknown>) => string
      reset: (id?: string) => void
    }
  }
}

export function TurnstileGate({ onToken }: { onToken: (token: string) => void }) {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
  const holder = useRef<HTMLDivElement>(null)
  const widget = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!siteKey || !holder.current || widget.current) return
    const render = () => {
      if (!window.turnstile || !holder.current || widget.current) return
      widget.current = window.turnstile.render(holder.current, {
        sitekey: siteKey,
        callback: onToken,
        'error-callback': () => window.turnstile?.reset(widget.current),
        'expired-callback': () => window.turnstile?.reset(widget.current),
      })
    }
    render()
    const timer = setInterval(render, 200)
    return () => clearInterval(timer)
  }, [siteKey, onToken])

  if (!siteKey) return null

  return (
    <>
      <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" strategy="lazyOnload" />
      <div ref={holder} className="mt-6" />
    </>
  )
}
```

- [ ] **Step 3: Send the token from the chat page**

In `apps/web/src/app/(paper)/chat/page.tsx`:

Add the import and a ref beside `conversationId`:

```tsx
import { TurnstileGate } from '@/components/turnstile-gate'
```

```tsx
  /** Newest Turnstile token. Single-use; the widget refreshes it after each. */
  const turnstileToken = useRef<string | undefined>(undefined)
```

Include it in the `/api/chat` body:

```tsx
            body: JSON.stringify({
              message: text,
              conversationId: conversationId.current,
              turnstileToken: turnstileToken.current,
            }),
```

Handle 403 inside `consume`, next to the existing 503 branch:

```tsx
      if (response.status === 403) {
        setLimited('Verification failed. Reload the page and try again.')
        return
      }
```

Render the widget in `Opening`, after the closing `</p>` of the "The last one writes" paragraph. Pass the setter down as a prop:

```tsx
        <TurnstileGate
          onToken={(token) => {
            turnstileToken.current = token
          }}
        />
```

`Opening` takes `onPick` today; add `onToken: (token: string) => void` to its props and pass `(token) => { turnstileToken.current = token }` from `ChatPage`.

- [ ] **Step 4: Add the public key to `.env.example`**

```
# Exposed to the browser on purpose: a Turnstile site key is public.
NEXT_PUBLIC_TURNSTILE_SITE_KEY=
```

- [ ] **Step 5: Verify the unconfigured path still works**

With no Turnstile keys set:

```bash
pnpm db:reset && pnpm db:seed && pnpm lint && pnpm typecheck && pnpm test
```

Then in a browser at `/chat`, click a suggestion. Expect a normal answer and **no widget rendered** — `document.querySelector('iframe[src*="challenges.cloudflare.com"]')` should be `null`.

- [ ] **Step 6: Verify the configured path rejects a missing token**

```bash
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA \
  PORT=3100 BETTER_AUTH_URL=http://localhost:3100 pnpm dev
```

(`1x0000...AA` is Cloudflare's documented always-passes test secret; pair it with site key `1x00000000000000000000AA` for a widget that always passes.)

```bash
curl -s -X POST http://localhost:3100/api/chat \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:3100' \
  -d '{"message":"hello"}' -w "\n%{http_code}\n"
```

Expected: the verification error and `403` — no model call made.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/turnstile-gate.tsx apps/web/src/app/api/chat/route.ts "apps/web/src/app/(paper)/chat/page.tsx" .env.example
git commit -m "Put the Turnstile check in front of the model call

It runs before the owner is resolved, not after: resolving first would mint an
anonymous user for every bot request, which is a row in the user table per
attempt and a reaper's problem later.

The widget renders only when the public site key is set, and the server check is
inert on exactly the same condition, so the two halves cannot disagree about
whether the gate is on. Verified both ways with Cloudflare's always-passes test
keys."
```

---

### Task 10: Deploy to Vercel and Neon

**Files:**
- Create: `vercel.json`
- Create: `apps/web/src/app/api/cron/reap/route.ts`
- Create: `docs/deploy.md`

**Interfaces:**
- Consumes: `reap` from `@kakeibo/ledger`.
- Produces: `GET /api/cron/reap`, called by Vercel Cron.

**This task needs the owner.** It cannot be completed by an agent alone: it requires a Neon project, a Vercel project, and a Cloudflare Turnstile site. Do Steps 1–3 first, then hand over.

- [ ] **Step 1: Write the cron endpoint**

Create `apps/web/src/app/api/cron/reap/route.ts`:

```ts
import { reap } from '@kakeibo/ledger'
import { env } from '@kakeibo/core/env'

/**
 * GET /api/cron/reap — the nightly sweep, on a schedule Vercel owns.
 *
 * Authenticated by `CRON_SECRET`, which Vercel sends as a bearer token on every
 * cron invocation. Without the check this is an unauthenticated endpoint that
 * deletes rows, reachable by anyone who guesses the path.
 *
 * It returns the counts so a failed sweep is visible in Vercel's log rather
 * than silent.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'not found' }, { status: 404 })
  }
  const result = await reap()
  return Response.json(result)
}
```

Add `CRON_SECRET` to `.env.example` with an empty value and a one-line comment saying Vercel sets it.

- [ ] **Step 2: Write `vercel.json`**

```json
{
  "crons": [{ "path": "/api/cron/reap", "schedule": "17 3 * * *" }]
}
```

03:17 UTC rather than midnight: every cron on the platform fires at midnight, and the sweep does not care when it runs.

- [ ] **Step 3: Gate and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add vercel.json apps/web/src/app/api/cron/reap/route.ts .env.example
git commit -m "Add the nightly reaper endpoint and its schedule

Authenticated with CRON_SECRET, which Vercel sends as a bearer token: without
the check this is an unauthenticated endpoint that deletes rows and is reachable
by anyone who guesses the path. It returns its counts so a failed sweep shows up
in the log instead of passing quietly."
```

- [ ] **Step 4: Write the runbook**

Create `docs/deploy.md` containing the ordering requirement below, verbatim, plus the environment variable table. The ordering is the part that matters and must not be reordered:

```markdown
# Deploying kakeibo

## The order is not optional

`/admin` is gated on an email in `ADMIN_EMAILS` whose `email_verified` is true.
No mail provider is configured, so nothing sets that column automatically, and
`POST /api/auth/sign-up/email` is reachable at the API level even though no
sign-up page exists. Whoever registers the allowlisted address first owns it,
and the owner's address is in every commit header of a public repository.

Therefore:

1. Deploy with `ADMIN_EMAILS` **empty**. `/admin` 404s for everyone, including
   you. This is correct and temporary.
2. Register your own account against the production database, by API:
   `POST /api/auth/sign-up/email` with a matching `Origin` header.
3. Mark it verified, by hand, once:
   `update "user" set email_verified = true where email = '<you>';`
4. Set `ADMIN_EMAILS` to that address and redeploy.
5. Confirm `/admin` opens for you and 404s in a private window.
6. Only now announce the site.

Doing 4 before 2 leaves a window in which anyone can claim the address.
```

Then the variables:

| Variable | Value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Neon pooled connection string | Owns the tables |
| `APP_DATABASE_URL` | Neon connection as `app_user` | **If empty, RLS is silently inert** |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` | |
| `BETTER_AUTH_URL` | the deployed origin | Must match, or every mutating auth call fails CSRF |
| `RATE_LIMIT_SALT` | `openssl rand -hex 16` | Empty in production makes the IP hashes a rainbow-table lookup |
| `ADMIN_EMAILS` | empty at first | See the ordering above |
| `TURNSTILE_SITE_KEY` / `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | from Cloudflare | Same value; one is server-side, one is exposed |
| `TURNSTILE_SECRET_KEY` | from Cloudflare | |
| `GLOBAL_DAILY_BUDGET_USD` | `0.667` | |
| `ALLOW_DESTRUCTIVE_RESET` | **unset** | Leave it unset so `pnpm eval` cannot touch production |
| `GEMINI_AUTH` / `GCP_PROJECT_ID` | as local | Vertex needs a service account on Vercel, not ADC |

- [ ] **Step 5 (owner): create the infrastructure**

1. Neon, **in this order**: create the project, then create the `app_user`
   role, *then* run `DATABASE_URL=<neon> pnpm db:migrate`. The order matters —
   `scripts/db-up.sh` only creates the role, and the grants live in the
   migration `packages/ledger/drizzle/0002_rls.sql`, which does
   `GRANT ... TO app_user` and fails outright if that role does not yet exist.
   Then set `APP_DATABASE_URL` to its connection string and confirm RLS is live:
   `APP_DATABASE_URL=<neon app_user> pnpm vitest run packages/ledger/src/rls.test.ts`.
2. Cloudflare: create a Turnstile site for the deployed hostname; take both keys.
3. Vercel: import the repository, set every variable in the table, deploy.

- [ ] **Step 6 (owner): verify the deploy before announcing**

- `/` and `/chat` load; a question gets an answer.
- The Turnstile widget appears and a turn succeeds.
- `/runs/[id]` opens for that turn.
- `/privacy` deletes everything and `/dashboard` returns to its empty state.
- `/admin` 404s while `ADMIN_EMAILS` is empty.
- Steps 2–5 of the ordering above, in order.
- `curl -s -o /dev/null -w '%{http_code}' <origin>/api/cron/reap` → `404`
  without the bearer token.

- [ ] **Step 7: Commit the runbook**

```bash
git add docs/deploy.md
git commit -m "Write the deploy runbook, ordering first

The ordering is the whole document. /admin is gated on a verified email, nothing
sets email_verified automatically, and the sign-up API is reachable even though
no sign-up page exists — so setting ADMIN_EMAILS before registering the address
leaves a window in which anyone can claim it. Everything else is a table."
```

---

## Self-Review

**Spec coverage.** §5 layer 4 (Turnstile) → Tasks 8–9. §7 surfaces: `/privacy`, `/terms` → Tasks 5, 7; `/settings` → removed, amendment in Task 1; `/sign-in` → Task 2 (not in the spec's table; added by Task 1's amendment). §8 deletion → Tasks 3, 4, 6. §8 privacy page contents (what is stored, retention, §9.6 trace disclosure, §9.5 geolocation) → Task 5, all four present. §10 deploy → Task 10.

**Gaps found and closed while reviewing.** Four, all from checking the codebase
rather than trusting the draft:

- Task 3 originally added a second, owner-scoped deletion path walking `OWNED`.
  CLAUDE.md rule 7 already settles the mechanism — deleting the user row cascades
  — so the parallel path would have been one table behind the schema the first
  time someone added a table. Replaced with `deleteAccount`.
- Task 4 called `auth.api.deleteUser`, which Better Auth does not expose unless
  `user.deleteUser.enabled` is set, and which has no defined behaviour for an
  anonymous account with no password. Gone with the rewrite.
- Task 4 originally used `resolveOwner`, which signs an anonymous visitor in when
  there is none: a DELETE that mints an account and deletes it, returning 200.
- Task 9 passed `requestIpHash` to Turnstile, which is a salted hash and not an
  address. Corrected to read `x-forwarded-for` directly.
- Task 10 told the owner to run migrations and then create `app_user`. The grants
  are *in* migration `0002_rls.sql`, so the role has to exist first or the
  migration fails.

**Type consistency.** `deleteAccount(userId: string): Promise<boolean>` is defined in Task 3 and consumed in Task 4. `verifyTurnstile(token, ip?)` and `turnstileConfigured()` are defined in Task 8 and consumed in Task 9. `<DeleteEverything />` is defined in Task 6 and consumed in Task 5 — build 6 before 5 for a compiling tree.

**Ordering.** 1 → 2 → 3 → 4 → 6 → 5 → 7 → 8 → 9 → 10. Tasks 2 and 7 are independent of the deletion chain and can be reordered freely; 10 is last and needs the owner.
