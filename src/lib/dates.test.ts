import { describe, expect, it } from 'vitest'
import {
  addMonths,
  daysBetween,
  daysInMonth,
  elapsedDaysInMonth,
  guessDateFormat,
  lastCompleteMonths,
  monthRange,
  parseDate,
} from './dates'

describe('parseDate', () => {
  it('parses the formats Danish banks emit', () => {
    expect(parseDate('14-03-2026', 'dd-MM-yyyy')).toBe('2026-03-14')
    expect(parseDate('14.03.2026', 'dd.MM.yyyy')).toBe('2026-03-14')
    expect(parseDate('2026-03-14', 'yyyy-MM-dd')).toBe('2026-03-14')
    expect(parseDate('14/03/2026', 'dd/MM/yyyy')).toBe('2026-03-14')
  })

  it('pads single-digit days and months', () => {
    expect(parseDate('1-3-2026', 'dd-MM-yyyy')).toBe('2026-03-01')
  })

  it('expands two-digit years around the 1970 pivot', () => {
    expect(parseDate('14-03-26', 'dd-MM-yy')).toBe('2026-03-14')
    expect(parseDate('14-03-99', 'dd-MM-yy')).toBe('1999-03-14')
  })

  it('rejects impossible dates rather than rolling them over', () => {
    expect(parseDate('32-01-2026', 'dd-MM-yyyy')).toBeNull()
    expect(parseDate('29-02-2026', 'dd-MM-yyyy')).toBeNull() // 2026 is not a leap year
    expect(parseDate('29-02-2024', 'dd-MM-yyyy')).toBe('2024-02-29')
    expect(parseDate('', 'dd-MM-yyyy')).toBeNull()
    expect(parseDate('not a date')).toBeNull()
  })

  it('converts Excel serial numbers', () => {
    expect(parseDate(45000)).toBe('2023-03-15')
  })

  it('accepts Date objects', () => {
    expect(parseDate(new Date(2026, 2, 14))).toBe('2026-03-14')
  })
})

describe('guessDateFormat', () => {
  it('picks the format that parses the samples', () => {
    expect(guessDateFormat(['14-03-2026', '01-04-2026', '28-02-2026'])).toBe('dd-MM-yyyy')
    expect(guessDateFormat(['2026-03-14', '2026-04-01'])).toBe('yyyy-MM-dd')
  })

  it('prefers day-first for ambiguous dates, matching Danish convention', () => {
    // 03/04/2026 could be 3 April or 4 March; Danish exports mean the former.
    expect(guessDateFormat(['03/04/2026', '05/06/2026'])).toBe('dd/MM/yyyy')
  })

  it('resolves to month-first when day-first is impossible', () => {
    // 13 cannot be a month, so these must be MM/dd.
    expect(guessDateFormat(['12/13/2026', '01/25/2026', '03/30/2026'])).toBe('MM/dd/yyyy')
  })

  it('returns null when most samples do not parse', () => {
    expect(guessDateFormat(['abc', 'def', 'ghi'])).toBeNull()
    expect(guessDateFormat([])).toBeNull()
  })
})

describe('month arithmetic', () => {
  it('adds and subtracts months across year boundaries', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(addMonths('2026-12', 1)).toBe('2027-01')
    expect(addMonths('2026-03', 0)).toBe('2026-03')
    expect(addMonths('2026-06', -12)).toBe('2025-06')
  })

  it('builds inclusive ranges', () => {
    expect(monthRange('2026-01', '2026-03')).toEqual(['2026-01', '2026-02', '2026-03'])
    expect(monthRange('2026-01', '2026-01')).toEqual(['2026-01'])
    // An inverted range yields nothing rather than looping forever.
    expect(monthRange('2026-03', '2026-01')).toEqual([])
  })

  it('knows how long each month is', () => {
    expect(daysInMonth('2026-02')).toBe(28)
    expect(daysInMonth('2024-02')).toBe(29)
    expect(daysInMonth('2026-04')).toBe(30)
    expect(daysInMonth('2026-12')).toBe(31)
  })

  it('lists the complete months before the current one', () => {
    const now = new Date(2026, 6, 15) // 15 July 2026
    expect(lastCompleteMonths(3, now)).toEqual(['2026-04', '2026-05', '2026-06'])
  })
})

describe('elapsedDaysInMonth', () => {
  const now = new Date(2026, 6, 15) // 15 July 2026

  it('returns the day of month for the current month', () => {
    expect(elapsedDaysInMonth('2026-07', now)).toBe(15)
  })

  it('returns the full month for a past month', () => {
    expect(elapsedDaysInMonth('2026-06', now)).toBe(30)
  })

  it('returns zero for a future month', () => {
    expect(elapsedDaysInMonth('2026-08', now)).toBe(0)
  })
})

describe('daysBetween', () => {
  it('counts days, signed', () => {
    expect(daysBetween('2026-03-01', '2026-03-04')).toBe(3)
    expect(daysBetween('2026-03-04', '2026-03-01')).toBe(-3)
    expect(daysBetween('2026-03-01', '2026-03-01')).toBe(0)
  })

  it('spans month and year boundaries', () => {
    expect(daysBetween('2026-02-27', '2026-03-02')).toBe(3)
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1)
  })
})
