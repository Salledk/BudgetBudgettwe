import { describe, expect, it } from 'vitest'
import { category, monthlySeries, tx } from '@/test/factories'
import { SYSTEM_CATEGORY } from '@/data/types'
import { monthlyTotals, suggestBudget } from './suggest'

const MONTHS = ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03']

const rent = category({ id: 'rent', name: 'Husleje' })
const groceries = category({ id: 'groceries', name: 'Dagligvarer' })
const salary = category({ id: 'salary', name: 'Løn', kind: 'income' })
const holiday = category({ id: 'holiday', name: 'Rejser' })

describe('monthlyTotals', () => {
  it('sums per category per month using absolute amounts', () => {
    const txs = monthlySeries('groceries', [['2026-01', 200000], ['2026-02', 250000]])
    const totals = monthlyTotals(txs, MONTHS)

    expect(totals.get('groceries')?.get('2026-01')).toBe(200000)
    expect(totals.get('groceries')?.get('2026-02')).toBe(250000)
  })

  it('excludes transfers, so moving money between accounts is not spending', () => {
    const txs = [
      tx({ date: '2026-01-05', amountMinor: -500000, categoryId: 'groceries', transferGroupId: 'g1' }),
      tx({ date: '2026-01-06', amountMinor: -20000, categoryId: 'groceries', categorySource: 'manual' }),
    ]

    expect(monthlyTotals(txs, MONTHS).get('groceries')?.get('2026-01')).toBe(20000)
  })

  it('excludes soft-deleted transactions', () => {
    const txs = [
      tx({ date: '2026-01-05', amountMinor: -20000, categoryId: 'groceries', deletedAt: 123 }),
      tx({ date: '2026-01-06', amountMinor: -30000, categoryId: 'groceries' }),
    ]

    expect(monthlyTotals(txs, MONTHS).get('groceries')?.get('2026-01')).toBe(30000)
  })

  it('ignores months outside the window', () => {
    const txs = monthlySeries('groceries', [['2025-01', 999900], ['2026-01', 200000]])
    const totals = monthlyTotals(txs, MONTHS)

    expect([...(totals.get('groceries')?.keys() ?? [])]).toEqual(['2026-01'])
  })
})

describe('suggestBudget', () => {
  it('suggests the median for a fixed monthly bill', () => {
    const txs = monthlySeries('rent', MONTHS.map((m) => [m, 850000] as [string, number]))
    const result = suggestBudget({ transactions: txs, categories: [rent], months: MONTHS })

    const suggestion = result.categories.find((c) => c.categoryId === 'rent')!
    expect(suggestion.pattern).toBe('recurring')
    expect(suggestion.suggestedMinor).toBe(850000)
  })

  it('classifies erratic spending as variable and lands inside its range', () => {
    const txs = monthlySeries('groceries', [
      ['2025-10', 180000], ['2025-11', 420000], ['2025-12', 260000],
      ['2026-01', 195000], ['2026-02', 380000], ['2026-03', 240000],
    ])
    const result = suggestBudget({ transactions: txs, categories: [groceries], months: MONTHS })

    const suggestion = result.categories.find((c) => c.categoryId === 'groceries')!
    expect(suggestion.pattern).toBe('variable')
    expect(suggestion.suggestedMinor).toBeGreaterThan(180000)
    expect(suggestion.suggestedMinor).toBeLessThan(420000)
    // The cautious figure is never below the central one.
    expect(suggestion.safeMinor).toBeGreaterThanOrEqual(suggestion.suggestedMinor)
  })

  it('holds an annual payment out of the monthly figure and provisions for it', () => {
    // Five quiet months and one holiday.
    const txs = monthlySeries('holiday', [
      ['2025-10', 20000], ['2025-11', 25000], ['2025-12', 18000],
      ['2026-01', 22000], ['2026-02', 21000], ['2026-03', 1200000],
    ])
    const result = suggestBudget({ transactions: txs, categories: [holiday], months: MONTHS })

    const suggestion = result.categories.find((c) => c.categoryId === 'holiday')!

    // The monthly figure reflects ordinary months, not the trip.
    expect(suggestion.suggestedMinor).toBeLessThan(50000)
    expect(suggestion.oneOffs).toHaveLength(1)
    expect(suggestion.oneOffs[0].amountMinor).toBe(1200000)
    // The trip is provisioned for rather than forgotten.
    expect(suggestion.setAsideMinor).toBeGreaterThan(0)
  })

  it('spreads a rarely-seen category across the year instead of budgeting it monthly', () => {
    const txs = monthlySeries('holiday', [['2025-12', 600000]])
    const result = suggestBudget({ transactions: txs, categories: [holiday], months: MONTHS })

    const suggestion = result.categories.find((c) => c.categoryId === 'holiday')!
    expect(suggestion.pattern).toBe('sparse')
    expect(suggestion.suggestedMinor).toBeLessThan(600000)
  })

  it('projects income separately rather than budgeting it', () => {
    const txs = [
      ...monthlySeries('rent', MONTHS.map((m) => [m, 850000] as [string, number])),
      ...MONTHS.map((m) =>
        tx({ date: `${m}-25`, amountMinor: 2800000, categoryId: 'salary', categorySource: 'manual' }),
      ),
    ]

    const result = suggestBudget({ transactions: txs, categories: [rent, salary], months: MONTHS })

    expect(result.expectedIncomeMinor).toBe(2800000)
    // Income is not a spending category.
    expect(result.categories.find((c) => c.categoryId === 'salary')).toBeUndefined()
    expect(result.headroomMinor).toBe(2800000 - result.totalSuggestedMinor - result.totalSetAsideMinor)
  })

  it('reports negative headroom when the suggestion exceeds income', () => {
    const txs = [
      ...monthlySeries('rent', MONTHS.map((m) => [m, 1500000] as [string, number])),
      ...MONTHS.map((m) => tx({ date: `${m}-25`, amountMinor: 1000000, categoryId: 'salary', categorySource: 'manual' })),
    ]

    const result = suggestBudget({ transactions: txs, categories: [rent, salary], months: MONTHS })
    expect(result.headroomMinor).toBeLessThan(0)
  })

  it('ignores transfers entirely', () => {
    const transferCategory = category({ id: SYSTEM_CATEGORY.transfer, name: 'Overførsel', kind: 'transfer' })
    const txs = MONTHS.map((m) =>
      tx({ date: `${m}-01`, amountMinor: -500000, categoryId: SYSTEM_CATEGORY.transfer, transferGroupId: `g-${m}` }),
    )

    const result = suggestBudget({ transactions: txs, categories: [transferCategory], months: MONTHS })
    expect(result.categories).toHaveLength(0)
  })

  it('reports insufficient history rather than suggesting from noise', () => {
    const short = ['2026-02', '2026-03']
    const txs = monthlySeries('groceries', [['2026-02', 200000], ['2026-03', 210000]])

    const result = suggestBudget({ transactions: txs, categories: [groceries], months: short })
    expect(result.hasEnoughHistory).toBe(false)
  })

  it('handles no data without throwing', () => {
    const result = suggestBudget({ transactions: [], categories: [groceries], months: MONTHS })
    expect(result.categories).toEqual([])
    expect(result.totalSuggestedMinor).toBe(0)
  })

  it('counts a month with no spending as zero, not as absent', () => {
    // Two months of spending in a six-month window is not a monthly habit.
    const txs = monthlySeries('holiday', [['2026-02', 30000], ['2026-03', 30000]])
    const result = suggestBudget({ transactions: txs, categories: [holiday], months: MONTHS })

    const suggestion = result.categories.find((c) => c.categoryId === 'holiday')!
    expect(suggestion.monthsPresent).toBe(2)
    expect(suggestion.monthsConsidered).toBe(6)
    expect(suggestion.pattern).toBe('sparse')
  })
})
