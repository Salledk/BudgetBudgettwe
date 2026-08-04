import { describe, expect, it } from 'vitest'
import { INFERABLE_PERIODS, PERIOD_OPTIONS, inferPeriodMonths, isPeriodic, monthlySetAside } from './periodic'

describe('monthlySetAside', () => {
  it('divides a period cost across its months', () => {
    expect(monthlySetAside(640000, 12)).toBe(53333)
    expect(monthlySetAside(300000, 3)).toBe(100000)
  })

  it('leaves a monthly cost alone', () => {
    expect(monthlySetAside(85000, 1)).toBe(85000)
    expect(monthlySetAside(85000, null)).toBe(85000)
  })
})

describe('isPeriodic', () => {
  it('needs an interval longer than a month', () => {
    expect(isPeriodic({ periodMonths: 12 })).toBe(true)
    expect(isPeriodic({ periodMonths: 3 })).toBe(true)
    expect(isPeriodic({ periodMonths: 1 })).toBe(false)
    expect(isPeriodic({ periodMonths: null })).toBe(false)
    // Records written before the field existed read back undefined.
    expect(isPeriodic({ periodMonths: undefined as unknown as null })).toBe(false)
  })
})

describe('inferPeriodMonths', () => {
  it('recognises a yearly rhythm', () => {
    expect(inferPeriodMonths(['2024-01', '2025-01', '2026-01'])).toBe(12)
  })

  it('recognises a quarterly rhythm', () => {
    expect(inferPeriodMonths(['2026-01', '2026-04', '2026-07', '2026-10'])).toBe(3)
  })

  it('refuses an irregular rhythm', () => {
    // A guess here would reshape the budget around a pattern that is not there.
    expect(inferPeriodMonths(['2026-01', '2026-04', '2026-11'])).toBeNull()
  })

  it('refuses monthly spending', () => {
    expect(inferPeriodMonths(['2026-01', '2026-02', '2026-03'])).toBeNull()
  })

  it('needs at least two payments to see a gap', () => {
    expect(inferPeriodMonths(['2026-01'])).toBeNull()
    expect(inferPeriodMonths([])).toBeNull()
  })

  it('refuses an interval that does not divide the year', () => {
    expect(inferPeriodMonths(['2026-01', '2026-08', '2027-03'])).toBeNull()
  })
})

describe('PERIOD_OPTIONS', () => {
  it('offers every interval inference can produce', () => {
    // It did not once: inference could return 2 or 4 while the picker offered
    // only 1, 3, 6 and 12, so a bi-monthly category was flagged as periodic
    // and yet showed an interval nobody could select or correct.
    const offered = PERIOD_OPTIONS.map((o) => o.months)
    for (const months of INFERABLE_PERIODS) {
      expect(offered).toContain(months)
    }
  })
})
