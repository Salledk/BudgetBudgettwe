import { describe, expect, it } from 'vitest'
import { monthlySeries } from '@/test/factories'
import { potAt } from './pot'

/**
 * Rollover pots. The case that matters most is the one that replaced the old
 * sinking fund: an annual bill budgeted monthly must have the whole amount
 * available in the month it lands.
 */

const flat = (minor: number) => () => minor

describe('potAt', () => {
  it('carries what is left over into the next month', () => {
    // 1.000 kr a month, 400 kr spent in January.
    const pot = potAt({
      month: '2026-02',
      categoryId: 'c',
      since: '2026-01',
      periodMonths: null,
      budgetFor: flat(100000),
      transactions: monthlySeries('c', [['2026-01', 40000]]),
    })

    expect(pot.carriedInMinor).toBe(60000)
    expect(pot.budgetedMinor).toBe(100000)
    expect(pot.availableMinor).toBe(160000)
  })

  it('carries a shortfall rather than clamping it at zero', () => {
    // Overspending has to be made back, otherwise a category could drift over
    // month after month and the pot would keep reading as though nothing had.
    const pot = potAt({
      month: '2026-02',
      categoryId: 'c',
      since: '2026-01',
      periodMonths: null,
      budgetFor: flat(100000),
      transactions: monthlySeries('c', [['2026-01', 150000]]),
    })

    expect(pot.carriedInMinor).toBe(-50000)
    expect(pot.availableMinor).toBe(50000)
  })

  it('can be in the red overall', () => {
    const pot = potAt({
      month: '2026-02',
      categoryId: 'c',
      since: '2026-01',
      periodMonths: null,
      budgetFor: flat(100000),
      transactions: monthlySeries('c', [['2026-01', 150000], ['2026-02', 200000]]),
    })

    expect(pot.availableMinor).toBe(-150000)
  })

  it('accrues an annual bill and covers it in the month it lands', () => {
    // The test that justifies replacing the periodic mode: a twelfth budgeted
    // every month leaves the full 6.400 kr premium available in month twelve,
    // which is exactly what the old sinking fund produced.
    const setAside = Math.round(640000 / 12)
    const december = potAt({
      month: '2026-12',
      categoryId: 'ins',
      since: '2026-01',
      periodMonths: 12,
      budgetFor: flat(setAside),
      transactions: [],
    })

    expect(december.availableMinor).toBe(setAside * 12)
    expect(december.availableMinor).toBeGreaterThanOrEqual(639996)

    // And paying it does not leave the category in the red.
    const paid = potAt({
      month: '2026-12',
      categoryId: 'ins',
      since: '2026-01',
      periodMonths: 12,
      budgetFor: flat(setAside),
      transactions: monthlySeries('ins', [['2026-12', 639996]]),
    })
    expect(paid.availableMinor).toBe(0)
  })

  it('starts at the month rollover was switched on, not at the first transaction', () => {
    // Accruing from older data would open the pot at a balance nobody ever set
    // aside, out of budgets that were never in force.
    const pot = potAt({
      month: '2026-06',
      categoryId: 'c',
      since: '2026-05',
      periodMonths: null,
      budgetFor: flat(100000),
      transactions: monthlySeries('c', [['2026-01', 0]]),
    })

    expect(pot.carriedInMinor).toBe(100000)
    expect(pot.monthsCounted).toBe(2)
  })

  it('behaves like an ordinary month when it has not started yet', () => {
    const pot = potAt({
      month: '2026-03',
      categoryId: 'c',
      since: '2026-09',
      periodMonths: null,
      budgetFor: flat(100000),
      transactions: monthlySeries('c', [['2026-03', 30000]]),
    })

    expect(pot.carriedInMinor).toBe(0)
    expect(pot.availableMinor).toBe(70000)
  })

  it('follows a budget that changed part-way through', () => {
    const pot = potAt({
      month: '2026-04',
      categoryId: 'c',
      since: '2026-01',
      periodMonths: null,
      // Raised from 1.000 to 2.000 kr in March.
      budgetFor: (m) => (m >= '2026-03' ? 200000 : 100000),
      transactions: [],
    })

    expect(pot.carriedInMinor).toBe(100000 + 100000 + 200000)
    expect(pot.availableMinor).toBe(600000)
  })

  it('honours a month budgeted at zero', () => {
    const pot = potAt({
      month: '2026-03',
      categoryId: 'c',
      since: '2026-01',
      periodMonths: null,
      budgetFor: (m) => (m === '2026-02' ? 0 : 100000),
      transactions: [],
    })

    expect(pot.carriedInMinor).toBe(100000)
  })

  it('ignores spending in other categories', () => {
    const pot = potAt({
      month: '2026-02',
      categoryId: 'c',
      since: '2026-01',
      periodMonths: null,
      budgetFor: flat(100000),
      transactions: monthlySeries('other', [['2026-01', 90000]]),
    })

    expect(pot.availableMinor).toBe(200000)
  })

  it('ignores spending after the month being viewed', () => {
    const pot = potAt({
      month: '2026-02',
      categoryId: 'c',
      since: '2026-01',
      periodMonths: null,
      budgetFor: flat(100000),
      transactions: monthlySeries('c', [['2026-05', 500000]]),
    })

    expect(pot.availableMinor).toBe(200000)
  })
})

describe('the bill-due warning', () => {
  it('flags a bill expected next month that the pot cannot cover', () => {
    const pot = potAt({
      month: '2026-11',
      categoryId: 'ins',
      since: '2026-10',
      periodMonths: 12,
      budgetFor: flat(10000),
      transactions: monthlySeries('ins', [['2025-12', 640000]]),
    })

    expect(pot.nextDueMonth).toBe('2026-12')
    expect(pot.behind).toBe(true)
  })

  it('stays quiet when the pot will cover it', () => {
    const pot = potAt({
      month: '2026-11',
      categoryId: 'ins',
      since: '2026-01',
      periodMonths: 12,
      budgetFor: flat(60000),
      transactions: monthlySeries('ins', [['2025-12', 640000]]),
    })

    expect(pot.behind).toBe(false)
  })

  it('says nothing about timing without an interval', () => {
    // A category saving toward a jacket has no rhythm to predict.
    const pot = potAt({
      month: '2026-11',
      categoryId: 'c',
      since: '2026-01',
      periodMonths: null,
      budgetFor: flat(10000),
      transactions: monthlySeries('c', [['2026-02', 5000]]),
    })

    expect(pot.nextDueMonth).toBeNull()
    expect(pot.behind).toBe(false)
  })
})
