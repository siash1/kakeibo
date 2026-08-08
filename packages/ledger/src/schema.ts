import {
  bigint,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * The ledger schema (spec 7).
 *
 * Money is `bigint` minor units — paise, not rupees — read back as a JS number.
 * That is safe here and not a fudge: 2^53 paise is about ₹90 trillion, so the
 * only way to overflow is to stop being a personal finance app. What it buys is
 * that amounts survive JSON round-trips into tool results and the web UI without
 * BigInt serialisation ceremony at every boundary.
 *
 * There are no triggers. The zero-sum invariant on postings is enforced in the
 * repository layer, which is the single insert path, and asserted by a vitest
 * invariant test. A trigger would be a second source of truth that the tests
 * could not see.
 */

export const accountTypeEnum = pgEnum('account_type', [
  'asset',
  'liability',
  'income',
  'expense',
  'equity',
])

export const memorySourceEnum = pgEnum('memory_source', ['user_stated', 'agent_inferred'])

export const runStatusEnum = pgEnum('run_status', ['ok', 'error', 'blocked', 'aborted'])

export const channelEnum = pgEnum('channel', ['cli', 'web', 'mcp', 'eval'])

export const traceEventTypeEnum = pgEnum('trace_event_type', [
  'model_call',
  'tool_call',
  'confirm',
  'summary_eviction',
  'error',
])

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  type: accountTypeEnum('type').notNull(),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const importBatches = pgTable('import_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  filename: text('filename').notNull(),
  rowCount: integer('row_count').notNull(),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
})

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    date: date('date').notNull(),
    /** Cleaned description shown to the user. */
    description: text('description').notNull(),
    /** Exactly what the CSV contained, never rewritten — the audit trail. */
    rawDescription: text('raw_description').notNull(),
    importBatchId: uuid('import_batch_id').references(() => importBatches.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('transactions_date_idx').on(table.date)],
)

export const postings = pgTable(
  'postings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('INR'),
  },
  (table) => [
    index('postings_transaction_idx').on(table.transactionId),
    index('postings_account_idx').on(table.accountId),
  ],
)

export const rules = pgTable('rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Case-insensitive substring matched against the raw description. */
  pattern: text('pattern').notNull(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  priority: integer('priority').notNull().default(100),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const budgets = pgTable(
  'budgets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** YYYY-MM */
    month: char('month', { length: 7 }).notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  },
  (table) => [unique('budgets_account_month_key').on(table.accountId, table.month)],
)

export const memories = pgTable('memories', {
  id: uuid('id').primaryKey().defaultRandom(),
  content: text('content').notNull(),
  category: text('category').notNull(),
  source: memorySourceEnum('source').notNull().default('user_stated'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const traceRuns = pgTable(
  'trace_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    status: runStatusEnum('status').notNull().default('ok'),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cachedTokens: bigint('cached_tokens', { mode: 'number' }).notNull().default(0),
    costUsdEst: numeric('cost_usd_est', { precision: 10, scale: 6 }).notNull().default('0'),
    latencyMs: integer('latency_ms').notNull().default(0),
    channel: channelEnum('channel').notNull(),
  },
  (table) => [index('trace_runs_started_idx').on(table.startedAt)],
)

export const traceEvents = pgTable(
  'trace_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => traceRuns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: traceEventTypeEnum('type').notNull(),
    payload: jsonb('payload').notNull(),
    latencyMs: integer('latency_ms'),
    inputTokens: bigint('input_tokens', { mode: 'number' }),
    outputTokens: bigint('output_tokens', { mode: 'number' }),
    cachedTokens: bigint('cached_tokens', { mode: 'number' }),
    thoughtSummary: text('thought_summary'),
  },
  (table) => [index('trace_events_run_idx').on(table.runId, table.seq)],
)

export type Account = typeof accounts.$inferSelect
export type Transaction = typeof transactions.$inferSelect
export type Posting = typeof postings.$inferSelect
export type Rule = typeof rules.$inferSelect
export type Budget = typeof budgets.$inferSelect
export type MemoryRow = typeof memories.$inferSelect
export type ImportBatch = typeof importBatches.$inferSelect
export type TraceRun = typeof traceRuns.$inferSelect
export type TraceEvent = typeof traceEvents.$inferSelect
