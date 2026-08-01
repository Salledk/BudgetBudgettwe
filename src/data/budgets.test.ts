import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import * as repo from './repo'
import { DEFAULT_BUDGET_MONTH } from './types'

/**
 * Resolution of the standing budget against per-month overrides. The subtle
 * case is an override of zero, which must mean "nothing this month" rather
 * than "fall back to the standard".
 */

async function reset() {
  await db.delete()
  await db.open()
  await repo.ensureSeeded()
}

async function categoryId(name: string): Promise<string> {
  const cats = await repo.listCategories()
  return cats.find((c) => c.name === name)!.id
}

beforeEach(reset)

describe('default budgets', () => {
  it('applies the standard to every month', async () => {
    const groceries = await categoryId('Dagligvarer')
    await repo.setDefaultBudget(groceries, 300000)

    for (const month of ['2026-01', '2026-07', '2027-03']) {
      const map = await repo.budgetMap(month)
      expect(map.get(groceries)?.amountMinor).toBe(300000)
      expect(map.get(groceries)?.inherited).toBe(true)
      // The resolved row reports the month asked for, not the sentinel.
      expect(map.get(groceries)?.month).toBe(month)
    }
  })

  it('lets one month override without touching the others', async () => {
    const groceries = await categoryId('Dagligvarer')
    await repo.setDefaultBudget(groceries, 300000)
    await repo.setBudget('2026-07', groceries, 450000)

    const july = await repo.budgetMap('2026-07')
    expect(july.get(groceries)?.amountMinor).toBe(450000)
    expect(july.get(groceries)?.inherited).toBe(false)

    const august = await repo.budgetMap('2026-08')
    expect(august.get(groceries)?.amountMinor).toBe(300000)
    expect(august.get(groceries)?.inherited).toBe(true)
  })

  it('treats an override of zero as a deliberate nothing', async () => {
    const holiday = await categoryId('Rejser & ferie')
    await repo.setDefaultBudget(holiday, 100000)
    await repo.setBudget('2026-07', holiday, 0)

    const july = await repo.budgetMap('2026-07')
    expect(july.get(holiday)?.amountMinor).toBe(0)
    expect(july.get(holiday)?.inherited).toBe(false)
  })

  it('reverts to the standard when the override is removed', async () => {
    const groceries = await categoryId('Dagligvarer')
    await repo.setDefaultBudget(groceries, 300000)
    await repo.setBudget('2026-07', groceries, 450000)
    await repo.deleteBudget('2026-07', groceries)

    const july = await repo.budgetMap('2026-07')
    expect(july.get(groceries)?.amountMinor).toBe(300000)
    expect(july.get(groceries)?.inherited).toBe(true)
  })

  it('removes the standard entirely when deleted', async () => {
    const groceries = await categoryId('Dagligvarer')
    await repo.setDefaultBudget(groceries, 300000)
    await repo.deleteDefaultBudget(groceries)

    expect((await repo.budgetMap('2026-07')).has(groceries)).toBe(false)
  })

  it('keeps one standing row per category', async () => {
    const groceries = await categoryId('Dagligvarer')
    await repo.setDefaultBudget(groceries, 300000)
    await repo.setDefaultBudget(groceries, 320000)

    const defaults = await repo.listDefaultBudgets()
    expect(defaults.filter((b) => b.categoryId === groceries)).toHaveLength(1)
    expect(defaults.find((b) => b.categoryId === groceries)?.amountMinor).toBe(320000)
  })
})

describe('sentinel containment', () => {
  it('never returns the standing rows as a real month', async () => {
    const groceries = await categoryId('Dagligvarer')
    await repo.setDefaultBudget(groceries, 300000)

    expect(await repo.listBudgets('2026-07')).toHaveLength(0)
    expect(await repo.listBudgets(DEFAULT_BUDGET_MONTH as never)).toHaveLength(1)
  })

  it('never offers the sentinel as a month to copy forward', async () => {
    const groceries = await categoryId('Dagligvarer')
    await repo.setDefaultBudget(groceries, 300000)

    // Only a default exists, so there is no earlier real month.
    expect(await repo.latestBudgetedMonth('2026-07')).toBeNull()

    await repo.setBudget('2026-05', groceries, 250000)
    expect(await repo.latestBudgetedMonth('2026-07')).toBe('2026-05')
  })

  it('reports whether a month overrides the standard', async () => {
    const groceries = await categoryId('Dagligvarer')
    await repo.setDefaultBudget(groceries, 300000)

    expect(await repo.hasMonthOverride('2026-07', groceries)).toBe(false)
    await repo.setBudget('2026-07', groceries, 450000)
    expect(await repo.hasMonthOverride('2026-07', groceries)).toBe(true)
  })
})
