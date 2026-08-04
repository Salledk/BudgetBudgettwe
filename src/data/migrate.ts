import { addMonths, monthOf } from '@/lib/dates'
import { db } from './db'
import { SETTINGS_ID } from './repo'
import { BUDGET_MODEL_VERSION, type Budget, type Category } from './types'

/**
 * One-time conversion from periodic categories to rollover pots.
 *
 * Under the old model a periodic category's budget held a **whole period's**
 * cost — 6.400 kr on a yearly premium — and a reserve was accrued against it.
 * Budgets are now always monthly amounts, so those rows have to be divided by
 * the interval or every migrated category would read as wildly overbudgeted.
 *
 * Guarded by `settings.budgetModelVersion` rather than by inspecting the data,
 * because a converted category is indistinguishable from one the user set up by
 * hand — running twice would divide the budgets a second time.
 */
export async function migrateBudgetModel(): Promise<boolean> {
  const settings = await db.settings.get(SETTINGS_ID)
  if (!settings) return false
  if ((settings.budgetModelVersion ?? 1) >= BUDGET_MODEL_VERSION) return false

  const ts = Date.now()

  await db.transaction('rw', db.categories, db.budgets, db.transactions, db.settings, async () => {
    const categories = await db.categories.toArray()
    const budgets = await db.budgets.toArray()
    const transactions = await db.transactions.toArray()

    // Last month each category was actually paid, so accrual can restart there
    // — the same rule the old reserve used, keeping migrated categories
    // behaving as they did rather than resetting them to zero.
    const lastPaid = new Map<string, string>()
    for (const t of transactions) {
      if (t.deletedAt !== null || !t.categoryId || t.amountMinor >= 0) continue
      const m = monthOf(t.date)
      const seen = lastPaid.get(t.categoryId)
      if (!seen || m > seen) lastPaid.set(t.categoryId, m)
    }

    const nextCategories: Category[] = []
    const nextBudgets: Budget[] = []

    for (const c of categories) {
      const period = c.periodMonths ?? null
      const wasPeriodic = typeof period === 'number' && period > 1

      if (!wasPeriodic) {
        if (c.rollover === undefined) {
          nextCategories.push({ ...c, rollover: false, rolloverSince: null, updatedAt: ts })
        }
        continue
      }

      const paid = lastPaid.get(c.id)
      nextCategories.push({
        ...c,
        rollover: true,
        // No payment on record means there is nothing to restart after, so the
        // pot opens now rather than backdating a balance nobody accrued.
        rolloverSince: paid ? addMonths(paid, 1) : monthOf(new Date().toISOString().slice(0, 10)),
        updatedAt: ts,
      })

      for (const b of budgets) {
        if (b.categoryId !== c.id || b.deletedAt !== null) continue
        nextBudgets.push({ ...b, amountMinor: Math.round(b.amountMinor / period), updatedAt: ts })
      }
    }

    if (nextCategories.length > 0) await db.categories.bulkPut(nextCategories)
    if (nextBudgets.length > 0) await db.budgets.bulkPut(nextBudgets)

    await db.settings.put({ ...settings, budgetModelVersion: BUDGET_MODEL_VERSION, updatedAt: ts })
  })

  return true
}
