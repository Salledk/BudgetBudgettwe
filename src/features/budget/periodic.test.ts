import { describe, expect, it } from 'vitest'
import { monthlySeries, tx } from '@/test/factories'
import { inferPeriodMonths, isPeriodic, monthlySetAside, reserveAt } from './periodic'

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

describe('reserveAt', () => {
  const base = { categoryId: 'ins', perPeriodMinor: 640000, periodMonths: 12 }

  it('starts saving again from the month after a payment', () => {
    // Paid in January; February and March build toward next January.
    const txs = monthlySeries('ins', [['2026-01', 640000]])

    const r = reserveAt({ ...base, month: '2026-04', transactions: txs })

    expect(r.setAsideMinor).toBe(53333)
    expect(r.monthsCounted).toBe(3) // Feb, Mar, Apr
    expect(r.balanceMinor).toBe(53333 * 3)
  })

  it('does not carry a deficit forward from a bill already paid', () => {
    // Paying the whole premium up front must not leave the category looking
    // short for the rest of the year — it is paid, and the fund is refilling.
    const txs = monthlySeries('ins', [['2026-01', 640000]])

    for (const month of ['2026-02', '2026-06', '2026-11']) {
      const r = reserveAt({ ...base, month, transactions: txs })
      expect(r.balanceMinor).toBeGreaterThan(0)
      expect(r.shortfallMinor).toBe(0)
    }
  })

  it('grows steadily toward the next bill', () => {
    const txs = monthlySeries('ins', [['2026-01', 640000]])

    const early = reserveAt({ ...base, month: '2026-03', transactions: txs })
    const later = reserveAt({ ...base, month: '2026-11', transactions: txs })

    expect(later.balanceMinor).toBeGreaterThan(early.balanceMinor)
  })

  it('reports a shortfall when the bill outgrew the budget', () => {
    // Budgeted 6.400, actually billed 7.200.
    const txs = monthlySeries('ins', [['2026-01', 720000]])
    const r = reserveAt({ ...base, month: '2026-05', transactions: txs })

    expect(r.lastPaymentMinor).toBe(720000)
    expect(r.shortfallMinor).toBe(80000)
  })

  it('flags being behind only when the bill is nearly due', () => {
    const txs = monthlySeries('ins', [['2026-01', 640000]])

    // Mid-year there is plenty of time left to keep saving.
    expect(reserveAt({ ...base, month: '2026-06', transactions: txs }).behind).toBe(false)
    // By December the January bill is imminent and the fund is still short.
    expect(reserveAt({ ...base, month: '2026-12', transactions: txs }).behind).toBe(true)
  })

  it('projects the next due month one interval on from the last payment', () => {
    const txs = monthlySeries('ins', [['2026-01', 640000]])
    const r = reserveAt({ ...base, month: '2026-06', transactions: txs })

    expect(r.nextDueMonth).toBe('2027-01')
    expect(r.settledThisPeriod).toBe(true)
  })

  it('reports no activity cleanly', () => {
    const r = reserveAt({ ...base, month: '2026-06', transactions: [] })

    expect(r.balanceMinor).toBe(0)
    expect(r.monthsCounted).toBe(0)
    expect(r.nextDueMonth).toBeNull()
  })

  it('ignores transfers and deleted rows', () => {
    const txs = [
      tx({ date: '2026-01-10', amountMinor: -640000, categoryId: 'ins', transferGroupId: 'g1' }),
      tx({ date: '2026-01-11', amountMinor: -640000, categoryId: 'ins', deletedAt: 1 }),
      tx({ date: '2026-01-12', amountMinor: -10000, categoryId: 'ins', categorySource: 'manual' }),
    ]
    const r = reserveAt({ ...base, month: '2026-01', transactions: txs })

    expect(r.spentThisMonthMinor).toBe(10000)
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
