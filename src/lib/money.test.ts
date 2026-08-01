import { describe, expect, it } from 'vitest'
import { formatMoney, parseAmount, ratio, sumMinor } from './money'

describe('parseAmount', () => {
  it('parses Danish formatting', () => {
    expect(parseAmount('1.234,56')).toBe(123456)
    expect(parseAmount('-1.234,56')).toBe(-123456)
    expect(parseAmount('0,50')).toBe(50)
    expect(parseAmount('1.000.000,00')).toBe(100000000)
  })

  it('parses en-US formatting, since some exports emit it', () => {
    expect(parseAmount('1,234.56')).toBe(123456)
    expect(parseAmount('1234.56')).toBe(123456)
  })

  it('strips currency markers and whitespace', () => {
    expect(parseAmount('1.234,56 kr.')).toBe(123456)
    expect(parseAmount('DKK 1.234,56')).toBe(123456)
    expect(parseAmount('1 234,56')).toBe(123456)
    expect(parseAmount('1 234,56')).toBe(123456)
  })

  it('handles the several ways exports write a negative', () => {
    expect(parseAmount('(1.234,56)')).toBe(-123456)
    expect(parseAmount('1.234,56-')).toBe(-123456)
    expect(parseAmount('−1.234,56')).toBe(-123456) // unicode minus
    expect(parseAmount('+1.234,56')).toBe(123456)
  })

  it('disambiguates a single separator by digit grouping', () => {
    // Three digits after a single separator reads as a thousands group.
    expect(parseAmount('1,234')).toBe(123400)
    expect(parseAmount('1.234')).toBe(123400)
    // Two digits reads as a decimal.
    expect(parseAmount('1,23')).toBe(123)
    expect(parseAmount('1.23')).toBe(123)
  })

  it('honours an explicit separator over the heuristic', () => {
    // With ',' forced as the decimal point, "1,234" is 1.234 kr → 123 øre,
    // not the 1.234 kr the grouping heuristic would infer.
    expect(parseAmount('1,234', { decimalSeparator: ',' })).toBe(123)
    expect(parseAmount('1.234', { decimalSeparator: '.' })).toBe(123)
    expect(parseAmount('1,23', { decimalSeparator: ',' })).toBe(123)
  })

  it('reads four leading digits as ruling out a thousands separator', () => {
    // A grouped number never has four digits before its first separator,
    // so the comma here must be a decimal point.
    expect(parseAmount('1234,565')).toBe(123457)
    expect(parseAmount('1234.565')).toBe(123457)
  })

  it('rejects values that are not amounts', () => {
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('   ')).toBeNull()
    expect(parseAmount('abc')).toBeNull()
    expect(parseAmount(null)).toBeNull()
    expect(parseAmount(undefined)).toBeNull()
    expect(parseAmount('1.2.3,4,5')).toBeNull()
  })

  it('accepts numbers directly, as XLSX supplies them', () => {
    expect(parseAmount(1234.56)).toBe(123456)
    expect(parseAmount(-99)).toBe(-9900)
    expect(parseAmount(Number.NaN)).toBeNull()
  })

  it('does not drift on values that float multiplication would round wrongly', () => {
    // 1234.565 * 100 is 123456.49999999999 in IEEE 754; naive rounding loses an øre.
    expect(parseAmount('1234,565', { decimalSeparator: ',' })).toBe(123457)
    expect(parseAmount('0,07')).toBe(7)
    expect(parseAmount('1122,33')).toBe(112233)
    expect(parseAmount('8,29')).toBe(829)
  })
})

describe('formatMoney', () => {
  it('formats minor units as Danish currency', () => {
    // Intl uses a non-breaking space before the currency symbol.
    expect(formatMoney(123456).replace(/ /g, ' ')).toBe('1.234,56 kr.')
    expect(formatMoney(-5000).replace(/ /g, ' ')).toBe('-50,00 kr.')
  })

  it('round-trips through parseAmount', () => {
    for (const minor of [0, 1, -1, 99, 123456, -987654321]) {
      const formatted = formatMoney(minor).replace(/ /g, ' ')
      expect(parseAmount(formatted)).toBe(minor)
    }
  })
})

describe('sumMinor and ratio', () => {
  it('sums without float drift', () => {
    expect(sumMinor([10, 20, 30])).toBe(60)
    expect(sumMinor([])).toBe(0)
  })

  it('returns null rather than dividing by a zero budget', () => {
    expect(ratio(100, 0)).toBeNull()
    expect(ratio(50, 100)).toBe(0.5)
  })
})
