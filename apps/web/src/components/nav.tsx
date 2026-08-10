'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Wordmark } from '@/components/mark'
import { cn } from '@/lib/cn'

const LINKS = [
  { href: '/chat', label: 'chat' },
  { href: '/dashboard', label: 'dashboard' },
  { href: '/runs', label: 'traces' },
  { href: '/evals', label: 'evals' },
]

/**
 * One bar across both genres.
 *
 * It carries no colours of its own: every value below is inherited from the
 * `[data-genre]` wrapper the layout puts it in, so the same component reads as
 * ruled paper on the product surfaces and as a terminal chrome on the machine
 * ones. That shared bar is what makes the ground flip legible as a *crossing*
 * rather than as a different site.
 *
 * `showAdmin` comes from the layout, a server component, because this is a
 * client component and cannot read the session. The link it hides is not the
 * security boundary — /admin 404s for anyone who is not the operator — but a
 * dead link in everyone's nav is an invitation to probe it.
 */
export function Nav({ showAdmin = false }: { showAdmin?: boolean }) {
  const pathname = usePathname()
  const links = showAdmin ? [...LINKS, { href: '/admin', label: 'operator' }] : LINKS

  return (
    <header className="sticky top-0 z-20 border-b border-current/12 bg-inherit backdrop-blur">
      {/*
       * At 390px the wordmark, the kanji and five links do not fit, and the
       * failure was not a graceful one: the kanji wrapped to three stacked
       * characters and the last link was cut off at the edge. Two things give
       * way. The kanji goes first — `Wordmark` hides it below `sm`, since the
       * latin already identifies the site — and the links then scroll rather
       * than truncate, because an operator on a phone still needs to reach the
       * link that sits last.
       */}
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-6 sm:gap-7">
        <Link href="/" className="shrink-0 no-underline" aria-label="kakeibo, home">
          <Wordmark className="text-[15px]" />
        </Link>
        <nav className="-mx-1 flex min-w-0 items-center gap-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {links.map((link) => {
            const active = pathname.startsWith(link.href)
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'shrink-0 rounded px-2.5 py-1 text-[13px] no-underline transition-opacity',
                  active ? 'opacity-100' : 'opacity-50 hover:opacity-80',
                )}
              >
                <span className={cn(active && 'border-b border-current pb-0.5')}>{link.label}</span>
              </Link>
            )
          })}
        </nav>
      </div>
    </header>
  )
}
