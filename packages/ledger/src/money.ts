/**
 * Money handling (spec 4: integer minor units everywhere, never floats).
 *
 * Every amount that crosses a boundary — DB column, tool argument, tool result,
 * CSV row — is an integer count of the currency's smallest unit. Floats appear
 * in exactly one place: the moment a human reads a number, in `formatMinor`.
 */

export const CURRENCY_DECIMALS: Record<string, number> = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0, // The yen has no minor unit; 100 JPY is 100, not 10000.
}

export const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
}

export function decimalsFor(currency: string): number {
  return CURRENCY_DECIMALS[currency.toUpperCase()] ?? 2
}

/**
 * Parses a decimal string ("1,234.56", "-89.10", "(45.00)") into minor units.
 *
 * Deliberately string-based: `Math.round(parseFloat("1234.565") * 100)` is 123456
 * on some inputs and 123457 on others depending on the binary representation,
 * and a ledger that is off by a paise on some rows is worse than one that
 * refuses to parse.
 */
export function parseMinor(input: string, currency = 'INR'): number {
  const decimals = decimalsFor(currency)
  let text = input.trim().replace(/[,\s]/g, '')

  // Accounting-style negatives: (45.00) means -45.00
  let negative = false
  if (/^\(.*\)$/.test(text)) {
    negative = true
    text = text.slice(1, -1)
  }
  // Strip a leading currency symbol or code.
  text = text.replace(/^[₹$€£¥]/, '').replace(/^(INR|USD|EUR|GBP|JPY)\s*/i, '')
  if (text.startsWith('-')) {
    negative = !negative
    text = text.slice(1)
  } else if (text.startsWith('+')) {
    text = text.slice(1)
  }

  if (!/^\d*(\.\d*)?$/.test(text) || text === '' || text === '.') {
    throw new Error(`Cannot parse "${input}" as an amount`)
  }

  const [wholePart = '0', fracPart = ''] = text.split('.')
  const frac = fracPart.padEnd(decimals, '0').slice(0, decimals)
  // Round rather than truncate when the input carries more precision than the
  // currency has, e.g. an FX-converted row with 4 decimal places.
  const extra = fracPart.slice(decimals)
  const roundUp = extra.length > 0 && Number(extra[0]) >= 5

  const minor = Number(wholePart) * 10 ** decimals + Number(frac || '0') + (roundUp ? 1 : 0)
  return negative ? -minor : minor
}

/** Minor units -> a plain decimal string, no symbol. */
export function minorToDecimalString(minor: number, currency = 'INR'): string {
  const decimals = decimalsFor(currency)
  const negative = minor < 0
  const abs = Math.abs(Math.trunc(minor))
  const divisor = 10 ** decimals
  const whole = Math.floor(abs / divisor)
  const frac = abs % divisor
  const body = decimals === 0 ? String(whole) : `${whole}.${String(frac).padStart(decimals, '0')}`
  return negative ? `-${body}` : body
}

/** Minor units -> display string with symbol and thousands separators. */
export function formatMinor(minor: number, currency = 'INR'): string {
  const decimals = decimalsFor(currency)
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} `
  const negative = minor < 0
  const abs = Math.abs(Math.trunc(minor))
  const divisor = 10 ** decimals
  const whole = Math.floor(abs / divisor)
  const frac = abs % divisor

  // Indian grouping for INR (12,34,567), Western grouping otherwise.
  const grouped =
    currency.toUpperCase() === 'INR' ? groupIndian(whole) : whole.toLocaleString('en-US')
  const body = decimals === 0 ? grouped : `${grouped}.${String(frac).padStart(decimals, '0')}`
  return `${negative ? '-' : ''}${symbol}${body}`
}

function groupIndian(value: number): string {
  const text = String(value)
  if (text.length <= 3) return text
  const last3 = text.slice(-3)
  const rest = text.slice(0, -3)
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`
}

/** Sums minor amounts. Named so the zero-sum assertions read as intent. */
export function sumMinor(amounts: number[]): number {
  return amounts.reduce((total, amount) => total + amount, 0)
}
