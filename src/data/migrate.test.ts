import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import * as repo from './repo'
import { migrateBudgetModel } from './migrate'
import { BUDGET_MODEL_VERSION, DEFAULT_BUDGET_MONTH, type Transaction } from './types'
import { newId } from '@/lib/id'

/**
 * Conversion from periodic categories to rollover pots.
 *
 * The delicate part is that it rewrites budget *amounts*: a periodic category's
 * budget used to hold a whole period's cost, and now holds a monthly one. Doing
 * that twice would quietly divide a budget into nothing.
 */

async function reset() {
  await db.delete()
  await db.open()
  await repo.ensureSeeded()
}

async function categoryId(name: string): Promise<string> {
  return (await repo.listCategories()).find((c) => c.name === name)!.id
}

/** Puts the database back into the shape the old model left behind. */
async function asOldModel(name: string, periodMonths: number, wholeBillMinor: number) {
  const id = await categoryId(name)
  await repo.updateCategory(id, { periodMonths, rollover: false, rolloverSince: null })
  await repo.setDefaultBudget(id, wholeBillMinor)
  await repo.updateSettings({ budgetModelVersion: 1 })
  return id
}

function payment(categoryId: string, month: string, minor: number): Transaction {
  return {
    id: newId(),
    accountId: 'acc',
    date: `${month}-14`,
    postedDate: null,
    amountMinor: -minor,
    rawText: 'FORSIKRING',
    merchantKey: 'forsikring',
    counterparty: null,
    balanceAfterMinor: null,
    categoryId,
    categorySource: 'manual',
    transferGroupId: null,
    importBatchId: 'batch',
    dedupHash: newId(),
    dedupKeys: [],
    externalId: null,
    notes: null,
    reviewed: true,
    updatedAt: Date.now(),
    deletedAt: null,
  }
}

beforeEach(reset)

describe('migrateBudgetModel', () => {
  it('turns a periodic category into one that rolls over', async () => {
    const id = await asOldModel('Forsikring', 12, 640000)
    await repo.putTransactions([payment(id, '2026-01', 640000)])

    expect(await migrateBudgetModel()).toBe(true)

    const c = (await repo.listCategories()).find((x) => x.id === id)!
    expect(c.rollover).toBe(true)
    // Accrual restarts after the last payment, as the old reserve did.
    expect(c.rolloverSince).toBe('2026-02')
    expect(c.periodMonths).toBe(12)
  })

  it('divides the budget into a monthly amount', async () => {
    // 6.400 kr a year was stored whole; budgets are monthly now.
    const id = await asOldModel('Forsikring', 12, 640000)

    await migrateBudgetModel()

    const budgets = await repo.listBudgets(DEFAULT_BUDGET_MONTH)
    expect(budgets.find((b) => b.categoryId === id)!.amountMinor).toBe(53333)
  })

  it('divides month overrides too', async () => {
    const id = await asOldModel('Forsikring', 4, 200000)
    await repo.setBudget('2026-03', id, 240000)
    await repo.updateSettings({ budgetModelVersion: 1 })

    await migrateBudgetModel()

    const march = await repo.budgetMap('2026-03')
    expect(march.get(id)!.amountMinor).toBe(60000)
  })

  it('does nothing the second time', async () => {
    const id = await asOldModel('Forsikring', 12, 640000)
    await migrateBudgetModel()

    expect(await migrateBudgetModel()).toBe(false)

    const budgets = await repo.listBudgets(DEFAULT_BUDGET_MONTH)
    expect(budgets.find((b) => b.categoryId === id)!.amountMinor).toBe(53333)
  })

  it('opens the pot now when the category was never paid', async () => {
    const id = await asOldModel('Forsikring', 12, 640000)

    await migrateBudgetModel()

    const c = (await repo.listCategories()).find((x) => x.id === id)!
    expect(c.rollover).toBe(true)
    // Nothing to restart after, so nothing is backdated.
    expect(c.rolloverSince).toMatch(/^\d{4}-\d{2}$/)
  })

  it('leaves an ordinary category alone', async () => {
    await asOldModel('Forsikring', 12, 640000)
    const groceries = await categoryId('Dagligvarer')
    await repo.setDefaultBudget(groceries, 300000)
    await repo.updateSettings({ budgetModelVersion: 1 })

    await migrateBudgetModel()

    const c = (await repo.listCategories()).find((x) => x.id === groceries)!
    expect(c.rollover).toBe(false)
    expect(c.rolloverSince).toBeNull()

    const budgets = await repo.listBudgets(DEFAULT_BUDGET_MONTH)
    expect(budgets.find((b) => b.categoryId === groceries)!.amountMinor).toBe(300000)
  })

  it('records the model version so a later start skips it', async () => {
    await asOldModel('Forsikring', 12, 640000)
    await migrateBudgetModel()

    expect((await repo.getSettings()).budgetModelVersion).toBe(BUDGET_MODEL_VERSION)
  })

  it('is skipped entirely on a fresh database', async () => {
    // Seeding writes the current version, so there is nothing to convert.
    expect(await migrateBudgetModel()).toBe(false)
  })
})
