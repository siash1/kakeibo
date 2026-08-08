import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatUsd, loadEnv } from '@kakeibo/core'
import { closeDb } from '@kakeibo/ledger'
import { runInjectionSuite } from './injection'
import { renderConsole, renderMarkdown } from './report'
import { loadTasks, repoRoot, runEvals } from './runner'

/**
 * `pnpm eval [--model X] [--filter glob] [--list] [--no-injection]`
 *
 * Writes evals/report/latest.{md,json} (spec 11). Live API calls, so it is
 * never wired into push CI — only workflow_dispatch or a local run.
 */

loadEnv()

interface Args {
  model?: string
  filter?: string
  list: boolean
  injection: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { list: false, injection: true }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--model') args.model = argv[++i]
    else if (arg?.startsWith('--model=')) args.model = arg.slice(8)
    else if (arg === '--filter') args.filter = argv[++i]
    else if (arg?.startsWith('--filter=')) args.filter = arg.slice(9)
    else if (arg === '--list') args.list = true
    else if (arg === '--no-injection') args.injection = false
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: pnpm eval [--model <id>] [--filter <substring|class|tag>] [--list] [--no-injection]',
      )
      process.exit(0)
    }
  }
  return args
}

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`
const green = (text: string) => `\x1b[32m${text}\x1b[0m`
const red = (text: string) => `\x1b[31m${text}\x1b[0m`

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.list) {
    for (const task of loadTasks(args.filter)) {
      console.log(`${task.id.padEnd(36)} ${task.class.padEnd(16)} ${task.tags.join(',')}`)
    }
    await closeDb()
    return
  }

  const tasks = loadTasks(args.filter)
  console.log(
    `kakeibo evals — ${tasks.length} task(s)${args.filter ? ` matching "${args.filter}"` : ''}\n`,
  )

  // The injection suite runs first and its block rate is folded into the
  // report, so the security number and the quality numbers come from one run.
  let injectionBlockRate: number | null = null
  if (args.injection && !args.filter) {
    process.stdout.write(dim('  running injection suite… '))
    const injection = await runInjectionSuite(args.model ? { model: args.model } : {})
    injectionBlockRate = injection.blockRate
    console.log(dim(`block rate ${injection.blockRate.toFixed(0)}%\n`))
  }

  const report = await runEvals({
    ...(args.model ? { model: args.model } : {}),
    ...(args.filter ? { filter: args.filter } : {}),
    injectionBlockRate,
    onProgress: (result, index, total) => {
      const mark = result.passed ? green('pass') : red('FAIL')
      const judge = result.judgeScore === null ? '   ' : `${result.judgeScore.toFixed(1)}/5`
      console.log(
        `  ${String(index + 1).padStart(3)}/${total}  ${mark}  ${result.task.id.padEnd(36)}` +
          ` ${judge}  ${dim(`${(result.latencyMs / 1000).toFixed(1)}s ${formatUsd(result.costUsdEst)}`)}`,
      )
      if (!result.passed) {
        for (const check of result.checks.filter((c) => !c.passed)) {
          console.log(dim(`         ${check.type}: ${check.detail.slice(0, 140)}`))
        }
      }
    },
  })

  console.log(renderConsole(report))

  const reportDir = join(repoRoot(), 'evals', 'report')
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(join(reportDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(reportDir, 'latest.md'), renderMarkdown(report))
  console.log(`\n  wrote evals/report/latest.md and latest.json\n`)

  await closeDb()
  if (report.passRate < 100) process.exitCode = 0 // report, do not gate — see README
}

main().catch(async (error) => {
  console.error('eval run failed:', error instanceof Error ? error.message : error)
  await closeDb()
  process.exit(1)
})
