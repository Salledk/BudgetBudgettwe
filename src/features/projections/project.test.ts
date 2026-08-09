import { describe, expect, it } from 'vitest'
import { category, monthlySeries, tx } from '@/test/factories'
import type { ResolvedBudget } from '@/data/types'
import { potAt } from '@/features/budget/pot'
import { detectRecurringCategories, projectMonth, runway } from './project'

const HISTORY = ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02']
const MONTH = '2026-03'

const rent = category({ id: 'rent', name: 'Husleje' })
const groceries = category({ id: 'groceries', name: 'Dagligvarer' })
const salary = category({ id: 'salary', name: 'Løn', kind: 'income' })

function budget(categoryId: string, amountMinor: number): ResolvedBudget {
  return {
    id: `b-${categoryId}`,
    month: MONTH,
    categoryId,
    amountMinor,
    source: 'user',
    inherited: false,
    updatedAt: 1,
    deletedAt: null,
  }
}

/** 15 March 2026 — half way through a 31-day month. */
const MID_MONTH = new Date(2026, 2, 15)

describe('detectRecurringCategories', () => {
  it('recognises a steady monthly bill', () => {
    const txs = monthlySeries('rent', HISTORY.map((m) => [m, 850000] as [string, number]))
    expect(detectRecurringCategories(txs, HISTORY, [rent]).has('rent')).toBe(true)
  })

  it('does not treat erratic spending as recurring', () => {
    const txs = monthlySeries('groceries', [
      ['2025-10', 180000], ['2025-11', 420000], ['2025-12', 260000],
      ['2026-01', 195000], ['2026-02', 380000],
    ])
    expect(detectRecurringCategories(txs, HISTORY, [groceries]).has('groceries')).toBe(false)
  })

  it('does not treat an occasional cost as recurring', () => {
    const txs = monthlySeries('groceries', [['2025-10', 200000], ['2026-02', 200000]])
    expect(detectRecurringCategories(txs, HISTORY, [groceries]).has('groceries')).toBe(false)
  })
})

describe('projectMonth — recurring categories', () => {
  const history = monthlySeries('rent', HISTORY.map((m) => [m, 850000] as [string, number]))

  it('does not extrapolate a bill that has already been paid', () => {
    // Rent paid on the 1st must not project to 8.500 × 15 by mid-month.
    const txs = [...history, tx({ date: '2026-03-01', amountMinor: -850000, categoryId: 'rent', categorySource: 'manual' })]

    const result = projectMonth({
      month: MONTH,
      transactions: txs,
      categories: [rent],
      budgets: new Map([['rent', budget('rent', 850000)]]),
      historyMonths: HISTORY,
      now: MID_MONTH,
    })

    const p = result.categories.find((c) => c.categoryId === 'rent')!
    expect(p.projectedMinor).toBe(850000)
    expect(p.status).toBe('on-track')
    expect(p.recurringSettled).toBe(true)
  })

  it('still expects a bill that has not been paid yet', () => {
    // The month is underway (there is other spending), but rent has not landed.
    const txs = [...history, tx({ date: '2026-03-04', amountMinor: -15000, categoryId: 'groceries', categorySource: 'manual' })]

    const result = projectMonth({
      month: MONTH,
      transactions: txs,
      categories: [rent, groceries],
      budgets: new Map([['rent', budget('rent', 850000)]]),
      historyMonths: HISTORY,
      now: MID_MONTH,
    })

    const p = result.categories.find((c) => c.categoryId === 'rent')!
    expect(p.actualMinor).toBe(0)
    expect(p.projectedMinor).toBe(850000)
    expect(p.recurringSettled).toBe(false)
  })
})

describe('projectMonth — variable categories', () => {
  /**
   * Weekly shops, which is what makes the difference from a daily average
   * visible. Monthly totals vary so the category is not mistaken for a fixed
   * bill, and each month normalises to its own total, so the shape is a clean
   * quarter per shop.
   */
  const history = [200000, 420000, 260000, 195000, 380000].flatMap((total, i) =>
    [3, 10, 17, 24].map((day) =>
      tx({
        date: `${HISTORY[i]}-${String(day).padStart(2, '0')}`,
        amountMinor: -Math.round(total / 4),
        categoryId: 'groceries',
        categorySource: 'manual',
      }),
    ),
  )
  // Median of the monthly totals above.
  const HISTORICAL_MEDIAN = 260000

  it('counts the shopping still to come rather than averaging by day', () => {
    // Three of four weekly shops done by the 17th, 3.000 kr against a 4.000 kr
    // budget. A daily average would call this 5.470 kr and flag it; the shape
    // knows one shop is left and lands it inside the budget.
    const txs = [
      ...history,
      tx({ date: '2026-03-17', amountMinor: -300000, categoryId: 'groceries', categorySource: 'manual' }),
    ]

    const result = projectMonth({
      month: MONTH,
      transactions: txs,
      categories: [groceries],
      budgets: new Map([['groceries', budget('groceries', 400000)]]),
      historyMonths: HISTORY,
      now: new Date(2026, 2, 17),
    })

    const p = result.categories.find((c) => c.categoryId === 'groceries')!
    expect(p.actualMinor).toBe(300000)
    // 400.000 × 0.75 + 260.000 × 0.25
    expect(p.projectedMinor).toBe(365000)
    expect(p.status).toBe('on-track')
  })

  it('does not extrapolate wildly from the first days of the month', () => {
    // One 800 kr shop on the 2nd would naively project to 12.400 kr.
    const txs = [...history, tx({ date: '2026-03-02', amountMinor: -80000, categoryId: 'groceries', categorySource: 'manual' })]

    const result = projectMonth({
      month: MONTH,
      transactions: txs,
      categories: [groceries],
      budgets: new Map([['groceries', budget('groceries', 280000)]]),
      historyMonths: HISTORY,
      now: new Date(2026, 2, 2),
    })

    const p = result.categories.find((c) => c.categoryId === 'groceries')!
    // Nothing has usually been spent by the 2nd, so this leans on history.
    expect(p.projectedMinor).toBeLessThan(400000)
    expect(p.projectedMinor).toBeGreaterThanOrEqual(HISTORICAL_MEDIAN)
  })

  it('warns before the budget is reached when the pace says it will be', () => {
    // 3.000 kr by the 10th against a 4.000 kr budget: still inside it, but half
    // a month's shopping is usually done by now, so this lands over.
    const txs = [
      ...history,
      tx({ date: '2026-03-10', amountMinor: -300000, categoryId: 'groceries', categorySource: 'manual' }),
    ]

    const result = projectMonth({
      month: MONTH,
      transactions: txs,
      categories: [groceries],
      budgets: new Map([['groceries', budget('groceries', 400000)]]),
      historyMonths: HISTORY,
      now: new Date(2026, 2, 10),
    })

    const p = result.categories.find((c) => c.categoryId === 'groceries')!
    expect(p.actualMinor).toBeLessThan(400000)
    expect(p.status).toBe('at-risk')
    // 400.000 × 0.5 — half a normal month's shopping.
    expect(p.pace!.expectedByNowMinor).toBe(200000)
    expect(p.pace!.aheadMinor).toBe(100000)
    // The warning quotes that pace, not a straight-line landing figure.
    expect(p.message).toContain('du plejer at være på 2.000 kr den 10')
  })

  it('reports a finished month as actuals, not a projection', () => {
    const txs = [...history, tx({ date: '2026-03-10', amountMinor: -150000, categoryId: 'groceries', categorySource: 'manual' })]

    const result = projectMonth({
      month: MONTH,
      transactions: txs,
      categories: [groceries],
      budgets: new Map([['groceries', budget('groceries', 220000)]]),
      historyMonths: HISTORY,
      now: new Date(2026, 5, 1), // June — March is long over
    })

    const p = result.categories.find((c) => c.categoryId === 'groceries')!
    expect(p.projectedMinor).toBe(150000)
    expect(result.isCurrentMonth).toBe(false)
  })
})

describe('projectMonth — status and alerts', () => {
  const budgets = new Map([['groceries', budget('groceries', 200000)]])

  it('flags a category that is already over budget', () => {
    const txs = [tx({ date: '2026-03-05', amountMinor: -250000, categoryId: 'groceries', categorySource: 'manual' })]

    const result = projectMonth({
      month: MONTH, transactions: txs, categories: [groceries], budgets, historyMonths: HISTORY, now: MID_MONTH,
    })

    const p = result.categories.find((c) => c.categoryId === 'groceries')!
    expect(p.status).toBe('over')
    expect(p.remainingMinor).toBe(-50000)
    expect(p.message).toContain('over')
    expect(result.alerts).toHaveLength(1)
  })

  it('leaves a comfortable category alone', () => {
    const txs = [tx({ date: '2026-03-05', amountMinor: -20000, categoryId: 'groceries', categorySource: 'manual' })]

    const result = projectMonth({
      month: MONTH, transactions: txs, categories: [groceries], budgets, historyMonths: HISTORY, now: MID_MONTH,
    })

    expect(result.categories.find((c) => c.categoryId === 'groceries')!.status).toBe('on-track')
    expect(result.alerts).toHaveLength(0)
  })

  it('marks a category with no budget rather than judging it', () => {
    const txs = [tx({ date: '2026-03-05', amountMinor: -20000, categoryId: 'groceries', categorySource: 'manual' })]

    const result = projectMonth({
      month: MONTH, transactions: txs, categories: [groceries], budgets: new Map(), historyMonths: HISTORY, now: MID_MONTH,
    })

    const p = result.categories.find((c) => c.categoryId === 'groceries')!
    expect(p.status).toBe('no-budget')
    expect(p.message).toBeNull()
  })

  it('sorts the most severe problems first', () => {
    const other = category({ id: 'other', name: 'Andet' })
    const txs = [
      tx({ date: '2026-03-05', amountMinor: -20000, categoryId: 'groceries', categorySource: 'manual' }),
      tx({ date: '2026-03-05', amountMinor: -500000, categoryId: 'other', categorySource: 'manual' }),
    ]

    const result = projectMonth({
      month: MONTH,
      transactions: txs,
      categories: [groceries, other],
      budgets: new Map([['groceries', budget('groceries', 200000)], ['other', budget('other', 100000)]]),
      historyMonths: HISTORY,
      now: MID_MONTH,
    })

    expect(result.categories[0].categoryId).toBe('other')
  })
})

describe('projectMonth — month totals', () => {
  it('excludes transfers from income and expense', () => {
    const txs = [
      tx({ date: '2026-03-01', amountMinor: -500000, transferGroupId: 'g1' }),
      tx({ date: '2026-03-01', amountMinor: 500000, transferGroupId: 'g1', accountId: 'acc-2' }),
      tx({ date: '2026-03-05', amountMinor: -20000, categoryId: 'groceries', categorySource: 'manual' }),
      tx({ date: '2026-03-25', amountMinor: 2800000, categoryId: 'salary', categorySource: 'manual' }),
    ]

    const result = projectMonth({
      month: MONTH, transactions: txs, categories: [groceries, salary], budgets: new Map(), historyMonths: HISTORY, now: MID_MONTH,
    })

    expect(result.expenseMinor).toBe(20000)
    expect(result.incomeMinor).toBe(2800000)
  })

  it('counts uncategorised spending toward the month', () => {
    const txs = [tx({ date: '2026-03-05', amountMinor: -45000, categoryId: null })]

    const result = projectMonth({
      month: MONTH, transactions: txs, categories: [], budgets: new Map(), historyMonths: HISTORY, now: MID_MONTH,
    })

    expect(result.uncategorisedCount).toBe(1)
    expect(result.uncategorisedMinor).toBe(45000)
    expect(result.expenseMinor).toBe(45000)
  })

  it('ignores transactions from other months', () => {
    const txs = [
      tx({ date: '2026-02-28', amountMinor: -99000, categoryId: 'groceries', categorySource: 'manual' }),
      tx({ date: '2026-03-05', amountMinor: -20000, categoryId: 'groceries', categorySource: 'manual' }),
    ]

    const result = projectMonth({
      month: MONTH, transactions: txs, categories: [groceries], budgets: new Map(), historyMonths: HISTORY, now: MID_MONTH,
    })

    expect(result.expenseMinor).toBe(20000)
  })

  it('does not forecast a month that has no transactions yet', () => {
    // Salary and rent exist in history but nothing has been imported for March.
    // Projecting here would show expected income with no expenses beside it,
    // which reads as a surplus the user does not have.
    const history = [
      ...monthlySeries('rent', HISTORY.map((m) => [m, 850000] as [string, number])),
      ...HISTORY.map((m) => tx({ date: `${m}-25`, amountMinor: 2800000, categoryId: 'salary', categorySource: 'manual' })),
    ]

    const result = projectMonth({
      month: MONTH,
      transactions: history,
      categories: [rent, salary],
      budgets: new Map([['rent', budget('rent', 850000)]]),
      historyMonths: HISTORY,
      now: MID_MONTH,
    })

    expect(result.hasActivity).toBe(false)
    expect(result.projectedIncomeMinor).toBe(0)
    expect(result.projectedExpenseMinor).toBe(0)
    expect(result.projectedNetMinor).toBe(0)
    expect(result.categories.find((c) => c.categoryId === 'rent')!.projectedMinor).toBe(0)
  })

  it('forecasts as soon as the month has any activity', () => {
    const history = [
      ...monthlySeries('rent', HISTORY.map((m) => [m, 850000] as [string, number])),
      ...HISTORY.map((m) => tx({ date: `${m}-25`, amountMinor: 2800000, categoryId: 'salary', categorySource: 'manual' })),
    ]
    const txs = [...history, tx({ date: '2026-03-03', amountMinor: -20000, categoryId: 'groceries', categorySource: 'manual' })]

    const result = projectMonth({
      month: MONTH,
      transactions: txs,
      categories: [rent, salary, groceries],
      budgets: new Map([['rent', budget('rent', 850000)]]),
      historyMonths: HISTORY,
      now: MID_MONTH,
    })

    expect(result.hasActivity).toBe(true)
    // Salary has not landed yet this month but is still expected.
    expect(result.projectedIncomeMinor).toBe(2800000)
    // Rent has not been paid yet either, and is still due.
    expect(result.categories.find((c) => c.categoryId === 'rent')!.projectedMinor).toBe(850000)
  })

  it('reports day position within the month', () => {
    const result = projectMonth({
      month: MONTH, transactions: [], categories: [], budgets: new Map(), historyMonths: HISTORY, now: MID_MONTH,
    })

    expect(result.daysElapsed).toBe(15)
    expect(result.daysTotal).toBe(31)
    expect(result.isCurrentMonth).toBe(true)
  })
})

describe('projectMonth — categories that roll over', () => {
  // 6.400 kr a year, budgeted as a twelfth each month and paid in January.
  const setAside = Math.round(640000 / 12)
  const insurance = category({
    id: 'ins',
    name: 'Forsikring',
    periodMonths: 12,
    rollover: true,
    rolloverSince: '2026-01',
  })
  const budgets = new Map([['ins', budget('ins', setAside)]])
  const paid = monthlySeries('ins', [['2026-01', 640000]])

  const potFor = (month: string, transactions = paid) =>
    new Map([
      [
        'ins',
        potAt({
          month,
          categoryId: 'ins',
          since: '2026-01',
          periodMonths: 12,
          budgetFor: () => setAside,
          transactions,
        }),
      ],
    ])

  it('reports what is in the pot rather than budget minus spend', () => {
    const result = projectMonth({
      month: MONTH, transactions: [], categories: [insurance], budgets,
      pots: potFor(MONTH, []), historyMonths: HISTORY, now: MID_MONTH,
    })

    const p = result.categories.find((c) => c.categoryId === 'ins')!
    expect(p.pot).not.toBeNull()
    expect(p.budgetMinor).toBe(setAside)
    expect(p.remainingMinor).toBe(p.pot!.availableMinor)
  })

  it('does not flag the month the bill lands once the pot has filled', () => {
    // The whole point: an annual premium is not a catastrophe in December when
    // eleven months of budget have been accumulating for it.
    const result = projectMonth({
      month: '2026-12',
      transactions: monthlySeries('ins', [['2026-12', 639996]]),
      categories: [insurance],
      budgets,
      pots: potFor('2026-12', monthlySeries('ins', [['2026-12', 639996]])),
      historyMonths: HISTORY,
      now: new Date(2026, 11, 20),
    })

    const p = result.categories.find((c) => c.categoryId === 'ins')!
    expect(p.actualMinor).toBe(639996)
    expect(p.status).not.toBe('over')
    expect(result.alerts).toHaveLength(0)
  })

  it('stays quiet while the pot is filling', () => {
    for (const month of ['2026-03', '2026-06', '2026-09']) {
      const result = projectMonth({
        month, transactions: [], categories: [insurance], budgets,
        pots: potFor(month, []), historyMonths: HISTORY, now: MID_MONTH,
      })
      expect(result.categories.find((c) => c.categoryId === 'ins')!.status).toBe('on-track')
    }
  })

  it('flags a pot that has been spent into the red', () => {
    // Paid in January, long before a twelfth a month could cover it.
    const result = projectMonth({
      month: '2026-01', transactions: paid, categories: [insurance], budgets,
      pots: potFor('2026-01'), historyMonths: HISTORY, now: new Date(2026, 0, 20),
    })

    const p = result.categories.find((c) => c.categoryId === 'ins')!
    expect(p.status).toBe('over')
    expect(p.message).toContain('mangler næste måned')
  })

  it('warns when the next bill is close and the pot is short', () => {
    const thin = new Map([
      ['ins', potAt({
        month: '2026-11', categoryId: 'ins', since: '2026-10', periodMonths: 12,
        budgetFor: () => 10000, transactions: monthlySeries('ins', [['2025-12', 640000]]),
      })],
    ])

    const result = projectMonth({
      month: '2026-11', transactions: [], categories: [insurance], budgets,
      pots: thin, historyMonths: HISTORY, now: new Date(2026, 10, 15),
    })

    const p = result.categories.find((c) => c.categoryId === 'ins')!
    expect(p.status).toBe('at-risk')
    expect(p.message).toContain('regning forventes snart')
  })

  it('leaves a category without a pot on the ordinary path', () => {
    const ordinary = category({ id: 'ins', name: 'Forsikring' })
    const result = projectMonth({
      month: MONTH, transactions: paid, categories: [ordinary], budgets, historyMonths: HISTORY, now: MID_MONTH,
    })

    expect(result.categories.find((c) => c.categoryId === 'ins')!.pot).toBeNull()
  })
})

describe('runway', () => {
  it('estimates days until the account is empty', () => {
    // 5.000 kr left, 3.000 kr projected shortfall over 15 remaining days.
    expect(runway({ balanceMinor: 500000, projectedNetMinor: -300000, daysRemaining: 15 })).toBe(25)
  })

  it('returns null when income covers spending', () => {
    expect(runway({ balanceMinor: 500000, projectedNetMinor: 100000, daysRemaining: 15 })).toBeNull()
  })

  it('returns null when the balance is unknown or already gone', () => {
    expect(runway({ balanceMinor: null, projectedNetMinor: -300000, daysRemaining: 15 })).toBeNull()
    expect(runway({ balanceMinor: -100, projectedNetMinor: -300000, daysRemaining: 15 })).toBeNull()
  })

  it('returns null at the end of the month rather than dividing by zero', () => {
    expect(runway({ balanceMinor: 500000, projectedNetMinor: -300000, daysRemaining: 0 })).toBeNull()
  })
})
