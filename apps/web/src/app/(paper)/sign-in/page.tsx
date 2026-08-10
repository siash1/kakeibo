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
 * nor unverified, and Plan C's dashboard is otherwise reachable only by POSTing
 * to the auth API by hand. A visitor has no reason to be here and no way to
 * find it.
 *
 * It is deliberately the plainest page on the site: a heading, two fields, one
 * button. Anything more would be designing a surface for a user who does not
 * exist. The fields are the composer's writing line — a rule under a
 * borderless serif field — because that is this system's only input, and a
 * boxed field here would be the one four-sided border on a product surface.
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
      // Better Auth's own message is deliberately vague about which half was
      // wrong. Keep it that way: a precise error here is an account-enumeration
      // oracle on the only account that exists.
      setError('That email and password did not match.')
      return
    }
    // Signing in while holding an anonymous session fires Better Auth's link
    // hook, which repoints that visitor's ledger before the anonymous user is
    // deleted. refresh() is what makes the server-rendered nav notice.
    router.push('/admin')
    router.refresh()
  }

  return (
    <div className="mx-auto max-w-[42ch] py-16">
      <h1 className="font-serif text-[clamp(1.75rem,5vw,2.5rem)] leading-[1.1] tracking-[-0.025em]">
        Sign in
      </h1>
      <p className="mt-3 text-[13px] leading-[1.5] text-sumi-600">
        For the operator. kakeibo has no accounts. Everyone else uses it anonymously, and nothing on
        the site links here.
      </p>

      <form onSubmit={submit} className="mt-12 border-t border-sumi-900 pt-8">
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
          className="mt-1 mb-8 block w-full border-b-2 border-rule-strong bg-transparent py-1 font-serif text-[clamp(1.125rem,3vw,1.375rem)] text-sumi-900 transition-colors focus:border-sumi-900 focus:outline-none"
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
          className="mt-1 block w-full border-b-2 border-rule-strong bg-transparent py-1 font-serif text-[clamp(1.125rem,3vw,1.375rem)] text-sumi-900 transition-colors focus:border-sumi-900 focus:outline-none"
        />

        {error ? (
          <div className="mt-8 border-y border-rule py-3">
            <Mark tone="danger">failed</Mark>
            <p className="mt-1 text-[14px] leading-[1.4] text-sumi-800">{error}</p>
          </div>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="mt-10 bg-sumi-900 px-6 py-2.5 text-[14px] text-paper-50 transition-colors hover:bg-sumi-800 disabled:bg-paper-200 disabled:text-sumi-500"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
