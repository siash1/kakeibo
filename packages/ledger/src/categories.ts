/** The seeded chart of accounts (spec 7). */

export const EXPENSE_CATEGORIES = [
  'Groceries',
  'Dining',
  'Transport',
  'Rent',
  'Utilities',
  'Subscriptions',
  'Shopping',
  'Health',
  'Entertainment',
  'Travel',
  'Fees',
  'Uncategorized',
] as const

export const INCOME_CATEGORIES = ['Salary', 'Interest', 'Other Income'] as const

export const ASSET_ACCOUNTS = ['Checking'] as const
export const LIABILITY_ACCOUNTS = ['Credit Card'] as const
export const EQUITY_ACCOUNTS = ['Opening Balances'] as const

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]
export type IncomeCategory = (typeof INCOME_CATEGORIES)[number]

/**
 * Where an import lands when no rule matches. Not a real category — a
 * transaction sitting here is an unanswered question.
 */
export const UNCATEGORIZED = 'Uncategorized'

export const ALL_CATEGORIES: string[] = [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES]

export const ALL_ACCOUNT_NAMES: string[] = [
  ...ASSET_ACCOUNTS,
  ...LIABILITY_ACCOUNTS,
  ...EXPENSE_CATEGORIES,
  ...INCOME_CATEGORIES,
  ...EQUITY_ACCOUNTS,
]

export interface SeedAccount {
  name: string
  type: 'asset' | 'liability' | 'income' | 'expense' | 'equity'
}

export const SEED_ACCOUNTS: SeedAccount[] = [
  ...ASSET_ACCOUNTS.map((name) => ({ name, type: 'asset' as const })),
  ...LIABILITY_ACCOUNTS.map((name) => ({ name, type: 'liability' as const })),
  ...EXPENSE_CATEGORIES.map((name) => ({ name, type: 'expense' as const })),
  ...INCOME_CATEGORIES.map((name) => ({ name, type: 'income' as const })),
  ...EQUITY_ACCOUNTS.map((name) => ({ name, type: 'equity' as const })),
]

/** Case-insensitive lookup so "groceries" from the model resolves to "Groceries". */
export function normalizeCategory(input: string): string | undefined {
  const needle = input.trim().toLowerCase()
  return ALL_ACCOUNT_NAMES.find((name) => name.toLowerCase() === needle)
}
