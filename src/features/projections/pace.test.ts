import { describe, expect, it } from 'vitest'
import { tx } from '@/test/factories'
import type { Transaction } from '@/data/types'
import { MIN_MONTHS_FOR_CURVE, isReliable, paceAt, spendCurves } from './pace'

/**
 * Spending shapes, written from the cases that made a straight-line projection
 * useless: a bill paid on the 1st, a weekly shopper judged the day before the
 * last shop, and one big purchase early in the month.
 */

const MONTHS = ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02']

/** Spending on given days of every history month. */
function onDays(categoryId: string, days: Array<[day: number, minor: number]>): Transaction[] {
  return MONTHS.flatMap((month) =>
    days.map(([day, minor]) =>
      tx({
        date: `${month}-${String(day).padStart(2, '0')}`,
        amountMinor: -minor,
        categoryId,
        categorySource: 'manual',
      }),
    ),
  )
}

const curveFor = (txs: Transaction[], id: string) => spendCurves(txs, MONTHS).get(id)!

describe('spendCurves', () => {
  it('learns that a bill lands on the 1st', () => {
    const curve = curveFor(onDays('rent', [[1, 850000]]), 'rent')

    expect(curve.byDay[1]).toBe(1)
    expect(curve.byDay[15]).toBe(1)
    expect(curve.monthsUsed).toBe(5)
  })

  it('learns a weekly rhythm as steps', () => {
    const curve = curveFor(
      onDays('groceries', [[3, 100000], [10, 100000], [17, 100000], [24, 100000]]),
      'groceries',
    )

    // Nothing before the first shop, then a quarter at a time.
    expect(curve.byDay[2]).toBe(0)
    expect(curve.byDay[3]).toBeCloseTo(0.25, 5)
    expect(curve.byDay[17]).toBeCloseTo(0.75, 5)
    // The last quarter is still to come on the 23rd — the case a straight line
    // gets wrong by declaring the month comfortable.
    expect(curve.byDay[23]).toBeCloseTo(0.75, 5)
    expect(curve.byDay[24]).toBe(1)
  })

  it('never goes backwards and always reaches one', () => {
    // A median across months can dip on a single day; a cumulative curve that
    // fell would be reporting spending un-happening.
    const curve = curveFor(
      onDays('groceries', [[5, 50000], [12, 120000], [26, 30000]]),
      'groceries',
    )

    for (let day = 2; day <= 31; day++) {
      expect(curve.byDay[day]).toBeGreaterThanOrEqual(curve.byDay[day - 1])
    }
    expect(curve.byDay[31]).toBe(1)
    expect(Math.min(...curve.byDay)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...curve.byDay)).toBeLessThanOrEqual(1)
  })

  it('ignores months with no spending', () => {
    // Two months of a twice-yearly cost is not evidence of a shape.
    const txs = [
      tx({ date: '2025-10-05', amountMinor: -200000, categoryId: 'gifts', categorySource: 'manual' }),
      tx({ date: '2026-02-05', amountMinor: -200000, categoryId: 'gifts', categorySource: 'manual' }),
    ]
    const curve = curveFor(txs, 'gifts')

    expect(curve.monthsUsed).toBe(2)
    expect(isReliable(curve)).toBe(false)
  })

  it('needs three months before it claims a shape', () => {
    const two = curveFor(onDays('c', [[5, 10000]]).slice(0, 2), 'c')
    expect(isReliable(two)).toBe(false)

    const three = curveFor(onDays('c', [[5, 10000]]).slice(0, MIN_MONTHS_FOR_CURVE), 'c')
    expect(isReliable(three)).toBe(true)
  })

  it('holds at one past the end of a short month', () => {
    // February has no 30th; trailing off there would drag the median down for
    // every other month.
    const curve = curveFor(
      [tx({ date: '2026-02-20', amountMinor: -100000, categoryId: 'c', categorySource: 'manual' })],
      'c',
    )

    expect(curve.byDay[28]).toBe(1)
    expect(curve.byDay[31]).toBe(1)
  })

  it('ignores transfers and uncategorised spending', () => {
    const txs = [
      ...onDays('c', [[10, 100000]]),
      tx({ date: '2026-01-02', amountMinor: -500000, categoryId: null }),
      tx({ date: '2026-01-03', amountMinor: -500000, categoryId: 'c', transferGroupId: 'g' }),
    ]

    expect(curveFor(txs, 'c').byDay[9]).toBe(0)
  })
})

describe('paceAt', () => {
  const rent = () => curveFor(onDays('rent', [[1, 850000]]), 'rent')
  const weekly = () =>
    curveFor(onDays('groceries', [[3, 100000], [10, 100000], [17, 100000], [24, 100000]]), 'groceries')

  it('does not call a bill paid on the 1st overspent by mid-month', () => {
    // A straight line projected this at fifteen times the rent.
    const pace = paceAt({
      curve: rent(),
      budgetMinor: 850000,
      actualMinor: 850000,
      day: 15,
      historicalMedianMinor: 850000,
    })

    expect(pace.expectedByNowMinor).toBe(850000)
    expect(pace.aheadMinor).toBe(0)
    expect(pace.projectedMinor).toBe(850000)
  })

  it('expects the last weekly shop still to come on the 23rd', () => {
    // Three shops done, 3.000 kr spent against a 4.000 kr budget. A straight
    // line says this month lands comfortably under; the shape knows better.
    const pace = paceAt({
      curve: weekly(),
      budgetMinor: 400000,
      actualMinor: 300000,
      day: 23,
      historicalMedianMinor: 400000,
    })

    expect(pace.expectedByNowMinor).toBe(300000)
    expect(pace.aheadMinor).toBe(0)
    expect(pace.projectedMinor).toBe(400000)
  })

  it('does not explode from one big shop early in the month', () => {
    // 800 kr on the 3rd. Linear projected 12.400 kr.
    const pace = paceAt({
      curve: weekly(),
      budgetMinor: 280000,
      actualMinor: 80000,
      day: 3,
      historicalMedianMinor: 280000,
    })

    expect(pace.projectedMinor).toBeLessThan(400000)
  })

  it('reports being genuinely ahead of the usual pace', () => {
    // Twice the usual by the 10th.
    const pace = paceAt({
      curve: weekly(),
      budgetMinor: 400000,
      actualMinor: 400000,
      day: 10,
      historicalMedianMinor: 400000,
    })

    expect(pace.expectedByNowMinor).toBe(200000)
    expect(pace.aheadMinor).toBe(200000)
    expect(pace.projectedMinor).toBeGreaterThan(400000)
  })

  it('reports being behind it', () => {
    const pace = paceAt({
      curve: weekly(),
      budgetMinor: 400000,
      actualMinor: 100000,
      day: 17,
      historicalMedianMinor: 400000,
    })

    expect(pace.expectedByNowMinor).toBe(300000)
    expect(pace.aheadMinor).toBe(-200000)
  })

  it('never forecasts less than has already been spent', () => {
    const pace = paceAt({
      curve: weekly(),
      budgetMinor: 400000,
      actualMinor: 900000,
      day: 30,
      historicalMedianMinor: 100000,
    })

    expect(pace.projectedMinor).toBeGreaterThanOrEqual(900000)
  })

  it('claims nothing when the history is too thin', () => {
    const thin = curveFor(
      [tx({ date: '2026-01-05', amountMinor: -100000, categoryId: 'c', categorySource: 'manual' })],
      'c',
    )

    const pace = paceAt({
      curve: thin,
      budgetMinor: 400000,
      actualMinor: 150000,
      day: 15,
      historicalMedianMinor: 380000,
    })

    expect(pace.reliable).toBe(false)
    expect(pace.aheadMinor).toBe(0)
    // Falls back to what a normal month costs rather than to a straight line.
    expect(pace.projectedMinor).toBe(380000)
  })
})
