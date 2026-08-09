'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/cn'

const LINKS = [
  { href: '/', label: 'chat' },
  { href: '/runs', label: 'traces' },
  { href: '/evals', label: 'evals' },
]

/**
 * `showAdmin` comes from the layout, a server component, because `Nav` is a
 * client component and cannot read the session itself. The link this hides is
 * not the security boundary — `/admin` 404s for anyone who is not the
 * operator regardless — but a dead link in everyone's nav is an invitation to
 * probe it.
 */
export function Nav({ showAdmin = false }: { showAdmin?: boolean }) {
  const pathname = usePathname()
  const links = showAdmin ? [...LINKS, { href: '/admin', label: 'operator' }] : LINKS
  return (
    <header className="sticky top-0 z-20 border-b border-ink-800 bg-ink-950/85 backdrop-blur">
      <div className="mx-auto flex h-12 max-w-6xl items-center gap-6 px-5">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-semibold tracking-tight text-ink-100">
            kakeibo
          </span>
          <span className="text-[11px] text-ink-500">家計簿</span>
        </Link>
        <nav className="flex items-center gap-1">
          {links.map((link) => {
            const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href)
            return (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  'rounded px-2.5 py-1 font-mono text-xs transition-colors',
                  active ? 'bg-ink-850 text-accent' : 'text-ink-500 hover:text-ink-300',
                )}
              >
                {link.label}
              </Link>
            )
          })}
        </nav>
      </div>
    </header>
  )
}
