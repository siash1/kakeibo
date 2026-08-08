import { describe, expect, it } from 'vitest'
import { formatMinor, minorToDecimalString, parseMinor } from './money'

/** Money is integer minor units everywhere (spec 4). */

describe('parseMinor', () => {
  it('parses plain decimals', () => {
    expect(parseMinor('1234.56')).toBe(123456)
    expect(parseMinor('0.01')).toBe(1)
    expect(parseMinor('100')).toBe(10000)
  })

  it('parses negatives, including accounting parentheses', () => {
    expect(parseMinor('-89.10')).toBe(-8910)
    expect(parseMinor('(45.00)')).toBe(-4500)
    expect(parseMinor('(-45.00)')).toBe(4500)
  })

  it('ignores thousands separators, currency symbols and codes', () => {
    expect(parseMinor('1,234.56')).toBe(123456)
    expect(parseMinor('₹1,23,456.78')).toBe(12345678)
    expect(parseMinor('INR 500.00')).toBe(50000)
    expect(parseMinor('$12.34', 'USD')).toBe(1234)
  })

  it('respects a currency with no minor unit', () => {
    expect(parseMinor('1500', 'JPY')).toBe(1500)
    expect(parseMinor('1,500', 'JPY')).toBe(1500)
  })

  it('is string-based, so no float rounding creeps in', () => {
    // The float route (parseFloat * 100) gets some of these wrong.
    expect(parseMinor('1234.565')).toBe(123457)
    expect(parseMinor('0.29')).toBe(29)
    expect(parseMinor('19.99')).toBe(1999)
    expect(parseMinor('8.20')).toBe(820)
    for (let cents = 0; cents < 100; cents++) {
      const text = `1.${String(cents).padStart(2, '0')}`
      expect(parseMinor(text)).toBe(100 + cents)
    }
  })

  it('rejects things that are not amounts', () => {
    expect(() => parseMinor('')).toThrow()
    expect(() => parseMinor('abc')).toThrow()
    expect(() => parseMinor('1.2.3')).toThrow()
  })
})

describe('formatMinor', () => {
  it('uses Indian digit grouping for INR', () => {
    expect(formatMinor(12345678)).toBe('₹1,23,456.78')
    expect(formatMinor(100000)).toBe('₹1,000.00')
    expect(formatMinor(2335000)).toBe('₹23,350.00')
  })

  it('uses Western grouping for other currencies', () => {
    expect(formatMinor(12345678, 'USD')).toBe('$123,456.78')
    expect(formatMinor(150000, 'EUR')).toBe('€1,500.00')
    // Same minor amount, different grouping convention per currency.
    expect(formatMinor(12345678, 'INR')).toBe('₹1,23,456.78')
  })

  it('formats a zero-decimal currency without a fraction', () => {
    expect(formatMinor(1500, 'JPY')).toBe('¥1,500')
  })

  it('keeps the sign outside the symbol', () => {
    expect(formatMinor(-450000)).toBe('-₹4,500.00')
  })
})

describe('minorToDecimalString', () => {
  it('round-trips through parseMinor', () => {
    for (const minor of [0, 1, 99, 100, 123456, -8910, 18500000]) {
      expect(parseMinor(minorToDecimalString(minor))).toBe(minor)
    }
  })

  it('emits no symbol or grouping, which is what a CSV wants', () => {
    expect(minorToDecimalString(12345678)).toBe('123456.78')
    expect(minorToDecimalString(-8910)).toBe('-89.10')
  })
})
