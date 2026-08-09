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
import { user } from './auth-schema'

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

/**
 * Owner of the row: always a Better Auth `user.id`, anonymous visitors
 * included — they are users who have not attached credentials yet.
 *
 * The cascade is load-bearing rather than tidiness. Deleting a user is the
 * whole implementation of two features: the 24-hour anonymous reaper, and the
 * "delete everything" action on /settings. Without it each of them would need
 * its own list of owner-scoped tables, and the table someone forgets to add is
 * a row that outlives the account that owned it.
 */
const ownerId = () =>
  uuid('owner_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' })

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

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
    // NOT globally unique any more: every owner has their own "Groceries".
    name: text('name').notNull(),
    type: accountTypeEnum('type').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('INR'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('accounts_owner_name_key').on(table.ownerId, table.name)],
)

export const importBatches = pgTable('import_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: ownerId(),
  filename: text('filename').notNull(),
  rowCount: integer('row_count').notNull(),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
})

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
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
  (table) => [index('transactions_owner_date_idx').on(table.ownerId, table.date)],
)

export const postings = pgTable(
  'postings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
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
    index('postings_owner_transaction_idx').on(table.ownerId, table.transactionId),
    index('postings_owner_account_idx').on(table.ownerId, table.accountId),
  ],
)

export const rules = pgTable('rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: ownerId(),
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
    ownerId: ownerId(),
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
  ownerId: ownerId(),
  content: text('content').notNull(),
  category: text('category').notNull(),
  source: memorySourceEnum('source').notNull().default('user_stated'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const traceRuns = pgTable(
  'trace_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
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
  (table) => [index('trace_runs_owner_started_idx').on(table.ownerId, table.startedAt)],
)

export const traceEvents = pgTable(
  'trace_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
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
  (table) => [index('trace_events_owner_run_idx').on(table.ownerId, table.runId, table.seq)],
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
