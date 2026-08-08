import { describe, expect, it } from 'vitest'
import { normalizeDate, parseCsv, parseStatement, toCsv } from './csv'

/**
 * CSV parsing (tool 8). Hand-rolled rather than split(',') because bank exports
 * routinely contain merchant names with commas in them, and a naive split
 * corrupts real data silently.
 */

describe('parseCsv', () => {
  it('handles quoted fields containing commas', () => {
    const rows = parseCsv('date,description,amount\n2025-03-01,"SWIGGY, BENGALURU",-450.00\n')
    expect(rows[1]).toEqual(['2025-03-01', 'SWIGGY, BENGALURU', '-450.00'])
  })

  it('handles doubled quotes inside a quoted field', () => {
    const rows = parseCsv('a\n"he said ""hi"""\n')
    expect(rows[1]?.[0]).toBe('he said "hi"')
  })

  it('handles embedded newlines inside quotes', () => {
    const rows = parseCsv('a,b\n"line one\nline two",x\n')
    expect(rows).toHaveLength(2)
    expect(rows[1]?.[0]).toBe('line one\nline two')
  })

  it('handles CRLF line endings', () => {
    const rows = parseCsv('a,b\r\n1,2\r\n')
    expect(rows[1]).toEqual(['1', '2'])
  })

  it('drops blank lines but keeps empty fields', () => {
    const rows = parseCsv('a,b,c\n1,,3\n\n4,5,6\n')
    expect(rows).toHaveLength(3)
    expect(rows[1]).toEqual(['1', '', '3'])
  })

  it('tolerates a missing trailing newline', () => {
    const rows = parseCsv('a,b\n1,2')
    expect(rows[1]).toEqual(['1', '2'])
  })
})

describe('normalizeDate', () => {
  it('passes ISO through', () => {
    expect(normalizeDate('2025-03-15')).toBe('2025-03-15')
  })

  it('reads slashed dates day-first', () => {
    // Indian and European exports are day-first; a US file needs its own preset
    // rather than a guess that silently swaps March and the 3rd.
    expect(normalizeDate('15/03/2025')).toBe('2025-03-15')
    expect(normalizeDate('5-3-2025')).toBe('2025-03-05')
  })

  it('rejects unparseable input rather than inventing a date', () => {
    expect(() => normalizeDate('not a date')).toThrow()
  })
})

describe('parseStatement', () => {
  const generic =
    'date,description,amount\n2025-03-01,SWIGGY ORDER,-450.00\n2025-03-02,SALARY,185000.00\n'

  it('parses the generic preset with signed amounts', () => {
    const { rows, errors } = parseStatement(generic, 'generic')
    expect(errors).toHaveLength(0)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      date: '2025-03-01',
      description: 'SWIGGY ORDER',
      amountMinor: -45000,
    })
    expect(rows[1]?.amountMinor).toBe(18500000)
  })

  it('reads the category column in the sample preset', () => {
    const { rows } = parseStatement(
      'date,description,amount,category\n2025-03-01,DMART,-1200.00,Groceries\n',
      'sample',
    )
    expect(rows[0]?.category).toBe('Groceries')
  })

  it('treats an empty category as absent, which is how the 8% land in Uncategorized', () => {
    const { rows } = parseStatement(
      'date,description,amount,category\n2025-03-01,DMART,-1200.00,\n',
      'sample',
    )
    expect(rows[0]?.category).toBeUndefined()
  })

  it('accepts alternate header names for the generic preset', () => {
    const { rows } = parseStatement(
      'Transaction Date,Narration,Amount\n2025-03-01,UPI PAY,-99.00\n',
      'generic',
    )
    expect(rows[0]?.description).toBe('UPI PAY')
  })

  it('throws with a useful message when a required column is missing', () => {
    expect(() => parseStatement('date,description\n2025-03-01,X\n', 'generic')).toThrow(/amount/)
  })

  it('reports bad rows without failing the whole import', () => {
    const csv =
      'date,description,amount\n' +
      '2025-03-01,GOOD ROW,-100.00\n' +
      'not-a-date,BAD DATE,-100.00\n' +
      '2025-03-03,,-100.00\n' +
      '2025-03-04,ZERO,0.00\n' +
      '2025-03-05,ANOTHER GOOD,-200.00\n'
    const { rows, errors } = parseStatement(csv, 'generic')

    expect(rows).toHaveLength(2)
    expect(errors).toHaveLength(3)
    expect(errors.map((e) => e.lineNumber)).toEqual([3, 4, 5])
  })

  it('survives a merchant name containing a comma', () => {
    const { rows } = parseStatement(
      'date,description,amount\n2025-03-01,"AMAZON, INC ORDER 123",-999.00\n',
      'generic',
    )
    expect(rows[0]?.description).toBe('AMAZON, INC ORDER 123')
    expect(rows[0]?.amountMinor).toBe(-99900)
  })
})

describe('toCsv', () => {
  it('quotes fields that need it and round-trips', () => {
    const csv = toCsv([{ a: 'plain', b: 'has, comma', c: 'has "quote"' }], ['a', 'b', 'c'])
    const parsed = parseCsv(csv)
    expect(parsed[1]).toEqual(['plain', 'has, comma', 'has "quote"'])
  })
})
