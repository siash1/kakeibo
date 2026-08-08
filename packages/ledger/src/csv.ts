import { parseMinor } from './money'

/**
 * CSV import (tool 8).
 *
 * Column mapping is configuration, not something the model guesses (spec 9).
 * Two presets ship: `generic` for {date,description,amount} with signed amounts,
 * and `sample` for the seed generator's own output. Letting an LLM infer which
 * column is the amount is a fun demo and a terrible idea in a ledger.
 *
 * The parser is hand-rolled and RFC 4180-ish on purpose — quoted fields,
 * embedded commas, doubled quotes, CRLF. Bank exports contain merchant names
 * with commas in them often enough that a `split(',')` import silently corrupts
 * real data.
 */

export type MappingPreset = 'generic' | 'sample'

export interface ParsedRow {
  date: string
  description: string
  amountMinor: number
  /** Present in the `sample` preset: the generator's ground-truth category. */
  category?: string
  lineNumber: number
}

export interface ParseResult {
  rows: ParsedRow[]
  errors: { lineNumber: number; message: string; raw: string }[]
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\r') {
      // swallow; the \n that follows ends the record
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((cell) => cell.trim().length > 0))
}

const PRESET_COLUMNS: Record<
  MappingPreset,
  { date: string[]; description: string[]; amount: string[]; category?: string[] }
> = {
  generic: {
    date: ['date', 'transaction date', 'txn date', 'value date'],
    description: ['description', 'narration', 'particulars', 'details', 'merchant'],
    amount: ['amount', 'amt', 'value'],
  },
  sample: {
    date: ['date'],
    description: ['description'],
    amount: ['amount'],
    category: ['category'],
  },
}

export function parseStatement(text: string, preset: MappingPreset, currency = 'INR'): ParseResult {
  const table = parseCsv(text)
  if (table.length === 0) return { rows: [], errors: [] }

  const header = table[0]!.map((h) => h.trim().toLowerCase())
  const spec = PRESET_COLUMNS[preset]

  const dateIndex = findColumn(header, spec.date)
  const descriptionIndex = findColumn(header, spec.description)
  const amountIndex = findColumn(header, spec.amount)
  const categoryIndex = spec.category ? findColumn(header, spec.category) : -1

  const missing = [
    dateIndex < 0 ? 'date' : null,
    descriptionIndex < 0 ? 'description' : null,
    amountIndex < 0 ? 'amount' : null,
  ].filter(Boolean)

  if (missing.length > 0) {
    throw new Error(
      `CSV is missing required column(s): ${missing.join(', ')}. ` +
        `Header was: ${header.join(', ')}. Preset "${preset}" expects ${JSON.stringify(spec)}.`,
    )
  }

  const rows: ParsedRow[] = []
  const errors: ParseResult['errors'] = []

  for (let i = 1; i < table.length; i++) {
    const cells = table[i]!
    const lineNumber = i + 1
    try {
      const date = normalizeDate(cells[dateIndex]?.trim() ?? '')
      const description = (cells[descriptionIndex] ?? '').trim()
      const amountMinor = parseMinor(cells[amountIndex] ?? '', currency)
      if (!description) throw new Error('empty description')
      if (amountMinor === 0) throw new Error('zero amount')

      const category = categoryIndex >= 0 ? (cells[categoryIndex] ?? '').trim() : undefined
      rows.push({
        date,
        description,
        amountMinor,
        ...(category ? { category } : {}),
        lineNumber,
      })
    } catch (error) {
      // A bad row is reported, not fatal. A 400-row statement with three
      // malformed lines should import 397 rows and tell you about the three.
      errors.push({
        lineNumber,
        message: error instanceof Error ? error.message : String(error),
        raw: cells.join(','),
      })
    }
  }

  return { rows, errors }
}

function findColumn(header: string[], candidates: string[]): number {
  for (const candidate of candidates) {
    const index = header.indexOf(candidate)
    if (index >= 0) return index
  }
  return -1
}

/** Accepts ISO, DD/MM/YYYY and DD-MM-YYYY; emits ISO. */
export function normalizeDate(input: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input

  const slash = input.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (slash) {
    const [, day, month, year] = slash
    // Day-first. Indian and European bank exports both use it, and the seed data
    // is Indian; a US-style file would need its own preset rather than a guess.
    return `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`
  }

  const parsed = Date.parse(input)
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10)

  throw new Error(`Cannot parse "${input}" as a date`)
}

export function toCsv(rows: Record<string, string | number>[], columns: string[]): string {
  const quote = (value: string | number): string => {
    const text = String(value)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines = [columns.join(',')]
  for (const row of rows) {
    lines.push(columns.map((column) => quote(row[column] ?? '')).join(','))
  }
  return `${lines.join('\n')}\n`
}
