import { createInterface, type Interface } from 'node:readline'
import {
  type CanonicalMessage,
  type ConfirmRequest,
  ContextManager,
  createAdapter,
  env,
  formatUsd,
  loadEnv,
  runTurn,
} from '@kakeibo/core'
import {
  closeDb,
  createRegistry,
  DbMemoryStore,
  DbTracer,
  DEV_OWNER_ID,
  KNOWN_CATEGORIES,
} from '@kakeibo/ledger'

/**
 * The CLI (spec 14) — Phase 1's interface and still the fastest way to drive
 * the loop. Streams text as it arrives, prints tool calls dimly so they read as
 * machinery rather than content, prompts y/n on write-tier tools, and lets
 * Ctrl+C abort the turn in flight without killing the session.
 */

loadEnv()

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`
const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`
const red = (text: string) => `\x1b[31m${text}\x1b[0m`

interface Flags {
  model?: string
  stream: boolean
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { stream: true }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--model') {
      flags.model = argv[++i]
    } else if (arg?.startsWith('--model=')) {
      flags.model = arg.slice('--model='.length)
    } else if (arg === '--no-stream') {
      flags.stream = false
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: pnpm cli [--model <id>] [--no-stream]')
      process.exit(0)
    }
  }
  return flags
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))
  const config = env()
  const model = flags.model ?? config.AGENT_MODEL

  const adapter = createAdapter()
  // One fixed owner until Plan B introduces sessions; this is the single
  // line each surface has to change then.
  const owner = DEV_OWNER_ID
  const registry = createRegistry(owner)
  const tracer = new DbTracer(owner)
  const memory = new DbMemoryStore(owner)
  const contextManager = new ContextManager()

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  })
  const lines = new LineReader(rl)

  console.log(bold('kakeibo') + dim(' — personal finance agent'))
  console.log(dim(`  model ${model} · ${registry.list().length} tools · ${config.GEMINI_AUTH}`))
  console.log(dim('  Ctrl+C aborts a turn, Ctrl+D or /exit quits, /help for commands'))
  console.log()

  let history: CanonicalMessage[] = []
  let controller: AbortController | undefined

  // Ctrl+C aborts the turn in flight. Only when nothing is running does it quit
  // — killing the process mid-turn would lose the trace row for that turn.
  process.on('SIGINT', () => {
    if (controller && !controller.signal.aborted) {
      controller.abort()
      process.stdout.write(`\n${yellow('aborted')}\n`)
    } else {
      rl.close()
    }
  })

  const confirm = async (request: ConfirmRequest): Promise<boolean> => {
    process.stdout.write(`\n${yellow('confirm')} ${request.summary}\n  ${dim('[y/N]')} `)
    const answer = await lines.next()
    if (answer === null) {
      // stdin ended while a write was pending. Denying is the only safe reading
      // of "no answer" for a tool that changes the ledger.
      process.stdout.write(`${dim('(no input — denied)')}\n`)
      return false
    }
    if (!process.stdin.isTTY) process.stdout.write(`${answer}\n`)
    return /^y(es)?$/i.test(answer.trim())
  }

  for (;;) {
    process.stdout.write(`${bold('>')} `)
    const line = await lines.next()
    if (line === null) break // Ctrl+D or end of piped input
    if (!process.stdin.isTTY) process.stdout.write(`${line}\n`)
    const input = line.trim()
    if (!input) continue
    if (input === '/exit' || input === '/quit') break
    if (input === '/help') {
      printHelp(registry.names())
      continue
    }
    if (input === '/reset') {
      history = []
      console.log(dim('  conversation cleared'))
      continue
    }
    if (input === '/history') {
      console.log(dim(`  ${history.length} messages in the window`))
      continue
    }

    controller = new AbortController()
    let streamed = false

    const result = await runTurn({
      userMessage: input,
      history,
      adapter,
      registry,
      tracer,
      model,
      summarizerModel: config.SUMMARIZER_MODEL,
      channel: 'cli',
      // The CLI's decider is in this process, so it can simply block.
      confirmPolicy: { mode: 'inline', confirm },
      memory,
      knownCategories: KNOWN_CATEGORIES,
      contextManager,
      signal: controller.signal,
      ...(flags.stream
        ? {
            onText: (delta: string) => {
              streamed = true
              process.stdout.write(delta)
            },
          }
        : {}),
      onToolCall: ({ name, args, tier }) => {
        if (streamed) process.stdout.write('\n')
        streamed = false
        const rendered = JSON.stringify(args)
        process.stdout.write(
          dim(`  ${tier === 'write' ? '✎' : '→'} ${name} ${truncate(rendered, 100)}\n`),
        )
      },
      onToolResult: ({ name, summary, isError }) => {
        const mark = isError ? red('  ✗') : dim('  ✓')
        process.stdout.write(`${mark} ${dim(`${name} ${truncate(oneLine(summary), 90)}`)}\n`)
      },
    })

    controller = undefined

    if (!flags.stream || !streamed) {
      if (result.text) console.log(result.text)
    }
    process.stdout.write('\n')

    if (result.status !== 'ok' && result.errorMessage) {
      console.log(red(`  ${result.status}: ${result.errorMessage}`))
    }

    const cached =
      result.usage.inputTokens > 0
        ? Math.round((result.usage.cachedTokens / result.usage.inputTokens) * 100)
        : 0
    console.log(
      dim(
        `  ${(result.latencyMs / 1000).toFixed(1)}s · ${result.usage.inputTokens} in` +
          ` (${cached}% cached) · ${result.usage.outputTokens} out · ${formatUsd(result.costUsdEst)}` +
          ` · ${result.iterations} iteration(s) · run ${result.runId.slice(0, 8)}`,
      ),
    )
    console.log()

    history = result.history
  }

  rl.close()
  await closeDb()
  console.log(dim('bye'))
}

/**
 * A line queue over readline.
 *
 * `rl.question` is not enough here: the loop reads a line, then a *nested*
 * confirmation may need to read another one mid-turn. With piped stdin the
 * stream reaches EOF while the turn is still running, and any question issued
 * after that throws "readline was closed". Buffering lines as they arrive makes
 * the CLI behave identically whether a human is typing or a script is piping,
 * which is what makes scripted demos and fixture recording possible.
 */
class LineReader {
  private readonly queue: string[] = []
  private readonly waiters: ((line: string | null) => void)[] = []
  private closed = false

  constructor(rl: Interface) {
    rl.on('line', (line: string) => {
      const waiter = this.waiters.shift()
      if (waiter) waiter(line)
      else this.queue.push(line)
    })
    rl.on('close', () => {
      this.closed = true
      while (this.waiters.length > 0) this.waiters.shift()?.(null)
    })
  }

  next(): Promise<string | null> {
    const buffered = this.queue.shift()
    if (buffered !== undefined) return Promise.resolve(buffered)
    if (this.closed) return Promise.resolve(null)
    return new Promise((resolve) => this.waiters.push(resolve))
  }
}

function printHelp(toolNames: string[]): void {
  console.log(dim('  /help     this'))
  console.log(dim('  /reset    clear the conversation window'))
  console.log(dim('  /history  how many messages are in the window'))
  console.log(dim('  /exit     quit'))
  console.log(dim(`  tools: ${toolNames.join(', ')}`))
  console.log()
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

main().catch(async (error) => {
  console.error(red(`\nfatal: ${error instanceof Error ? error.message : String(error)}`))
  await closeDb()
  process.exit(1)
})
