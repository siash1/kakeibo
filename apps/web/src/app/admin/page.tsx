import {
  budgetPanel,
  healthPanel,
  mapPanel,
  recentRuns,
  safetyPanel,
  toolsPanel,
  trafficPanel,
  usersPanel,
} from '@kakeibo/ledger'
import { notFound } from 'next/navigation'
import { adminSession } from '@/lib/admin'
import { OperatorActions } from './actions'
import { Budget, Health, RecentRuns, Safety, Tools, Traffic, Users } from './panels'
import { WorldMap } from './world-map'

/**
 * The operator dashboard (spec §9).
 *
 * Terminal genre, matching the trace viewer: this is not a product page and the
 * warm editorial direction in Phase 2 does not apply to it.
 *
 * Budget is first and largest because it is the number that can hurt.
 */

export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  const session = await adminSession()
  // 404, not 403. A 403 confirms the route exists.
  if (!session) notFound()

  const [budget, traffic, health, safety, tools, runs, users, points] = await Promise.all([
    budgetPanel(session),
    trafficPanel(session),
    healthPanel(session),
    safetyPanel(session),
    toolsPanel(session),
    recentRuns(session, 100),
    usersPanel(session, 200),
    mapPanel(session),
  ])

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-lg text-ink-100">Operator</h1>
          <p className="mt-1 text-xs text-ink-500">
            Every owner, unscoped. Trace payloads include ledger contents — see the privacy page.
          </p>
        </div>
        <span className="font-mono text-[11px] text-ink-500">{session.email}</span>
      </div>

      <Budget panel={budget} />
      <OperatorActions paused={budget.state === 'paused'} />
      <div className="grid gap-5 lg:grid-cols-2">
        <Traffic panel={traffic} />
        <Health panel={health} />
        <Safety panel={safety} />
        <Tools stats={tools} />
      </div>
      <WorldMap points={points} />
      <RecentRuns runs={runs} />
      <Users users={users} />
    </div>
  )
}
