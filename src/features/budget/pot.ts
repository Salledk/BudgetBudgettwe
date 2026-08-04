import { addMonths, monthOf, type IsoMonth } from '@/lib/dates'
import type { Transaction } from '@/data/types'
import { isTransfer } from '@/features/import/transfers'

/**
 * Rollover pots: a category where unspent budget stays put instead of expiring
 * at month end.
 *
 * This replaced a separate sinking-fund mode for periodic bills, because a pot
 * subsumes it. Budgeting a twelfth of a 6.400 kr premium every month and not
 * touching it leaves exactly 6.400 kr available when the bill lands — the same
 * answer the old reserve gave, reached without the budget field having to mean
 * something different on those rows. It also covers saving toward something
 * with no billing interval at all, which the old mode could not express.
 *
 * The balance is derived from budgets and transactions, never stored: storing
 * it would only create a second number that could disagree with them.
 */

export interface PotState {
  /** Balance carried into the start of `month`. */
  carriedInMinor: number
  /** Budget in force for `month`. */
  budgetedMinor: number
  /** Spent in this category during `month`. */
  spentMinor: number
  /** What is left to spend: carried in + budgeted − spent. May be negative. */
  availableMinor: number
  /** Months accrued, counting `month` itself. */
  monthsCounted: number
  /** Best guess at when the next bill falls, or null when there is no rhythm. */
  nextDueMonth: IsoMonth | null
  /** True when a bill is imminent and the pot will not cover it. */
  behind: boolean
}

/** Guard against a malformed range walking forever. */
const MAX_MONTHS = 600

export function potAt(params: {
  month: IsoMonth
  categoryId: string
  /** First month to accrue from — when rollover was switched on. */
  since: IsoMonth
  /** Expected billing interval, used only for the "bill due" warning. */
  periodMonths: number | null
  /** Resolved budget for a given month. */
  budgetFor: (month: IsoMonth) => number
  transactions: Transaction[]
}): PotState {
  const { month, categoryId, since, periodMonths, budgetFor, transactions } = params

  const spendByMonth = new Map<IsoMonth, number>()
  for (const t of transactions) {
    if (t.deletedAt !== null || isTransfer(t)) continue
    if (t.categoryId !== categoryId) continue
    const m = monthOf(t.date)
    if (m > month) continue
    spendByMonth.set(m, (spendByMonth.get(m) ?? 0) + Math.abs(t.amountMinor))
  }

  const budgetedMinor = budgetFor(month)
  const spentMinor = spendByMonth.get(month) ?? 0

  // Rollover switched on later than the month being viewed: nothing has
  // accrued yet, and the month behaves like an ordinary one.
  if (since > month) {
    return {
      carriedInMinor: 0,
      budgetedMinor,
      spentMinor,
      availableMinor: budgetedMinor - spentMinor,
      monthsCounted: 0,
      nextDueMonth: null,
      behind: false,
    }
  }

  let carriedInMinor = 0
  let monthsCounted = 0
  for (let m = since; m < month && monthsCounted < MAX_MONTHS; m = addMonths(m, 1)) {
    // A shortfall is carried rather than clamped: overspending has to be made
    // back, otherwise a category could drift over month after month and the
    // pot would keep reading as though nothing had happened.
    carriedInMinor += budgetFor(m) - (spendByMonth.get(m) ?? 0)
    monthsCounted++
  }

  const availableMinor = carriedInMinor + budgetedMinor - spentMinor

  const paidMonths = [...spendByMonth.keys()].filter((m) => (spendByMonth.get(m) ?? 0) > 0).sort()
  const lastPaid = paidMonths.at(-1) ?? null
  const nextDueMonth = periodMonths && lastPaid ? addMonths(lastPaid, periodMonths) : null

  // Due next month or already overdue, with less in the pot than the bill is
  // expected to cost.
  const expectedBillMinor = lastPaid ? (spendByMonth.get(lastPaid) ?? 0) : 0
  const dueSoon = nextDueMonth !== null && addMonths(month, 1) >= nextDueMonth
  const behind = dueSoon && availableMinor < expectedBillMinor

  return {
    carriedInMinor,
    budgetedMinor,
    spentMinor,
    availableMinor,
    monthsCounted: monthsCounted + 1,
    nextDueMonth,
    behind,
  }
}
