import { addMonths, monthOf, type IsoMonth } from '@/lib/dates'
import type { Category, Transaction } from '@/data/types'
import { isTransfer } from '@/features/import/transfers'

/**
 * Sinking-fund handling for expenses that arrive every few months.
 *
 * An annual 6.400 kr insurance premium is not a 6.400 kr problem in January and
 * nothing for the rest of the year. Marking the category periodic spreads the
 * cost: the budget holds the **full amount per period**, roughly a twelfth is
 * set aside each month, and when the bill lands it is charged against the
 * reserve that has been building rather than against that one month.
 *
 * The reserve is derived, never stored. It is fully determined by the
 * transactions and the budget, so storing it would only create something that
 * could drift out of agreement with them.
 */

export const PERIOD_OPTIONS = [
  { months: 1, label: 'Hver måned' },
  { months: 3, label: 'Hvert kvartal' },
  { months: 6, label: 'Hvert halve år' },
  { months: 12, label: 'En gang om året' },
] as const

export function isPeriodic(category: Pick<Category, 'periodMonths'>): boolean {
  const p = category.periodMonths
  return typeof p === 'number' && p > 1
}

/**
 * What to put aside each month to cover one period's bill.
 * `amountMinor` is the full cost per period.
 */
export function monthlySetAside(amountMinor: number, periodMonths: number | null | undefined): number {
  if (!periodMonths || periodMonths <= 1) return amountMinor
  return Math.round(amountMinor / periodMonths)
}

export interface ReserveState {
  /** Saved toward the **next** bill, at the end of `month`. */
  balanceMinor: number
  /** Set aside per month. */
  setAsideMinor: number
  /** Full cost of one period, as budgeted. */
  perPeriodMinor: number
  /** Spent in this category during `month`. */
  spentThisMonthMinor: number
  /** Months accrued toward the next bill. */
  monthsCounted: number
  /** Best guess at when the next bill falls, or null when unknown. */
  nextDueMonth: IsoMonth | null
  /** True when a bill has been paid and the fund is saving for the next one. */
  settledThisPeriod: boolean
  /** What the most recent bill actually cost. */
  lastPaymentMinor: number
  /** How far the last bill exceeded the budgeted per-period amount. */
  shortfallMinor: number
  /** True when the bill is imminent and the reserve will not cover it. */
  behind: boolean
}

/**
 * Reserve balance at the end of `month`, measured **toward the next bill**.
 *
 * Accrual restarts the month after each payment. Carrying a deficit forward
 * instead would mark a category short for the rest of the year purely because
 * the bill happened to fall early — which is the false alarm this whole feature
 * exists to remove. What actually matters is whether the budget covers the bill
 * (`shortfallMinor`) and whether enough is saved before the next one
 * (`behind`).
 */
export function reserveAt(params: {
  month: IsoMonth
  categoryId: string
  perPeriodMinor: number
  periodMonths: number
  transactions: Transaction[]
  /** Explicit first month to accrue from; defaults to the earliest activity. */
  since?: IsoMonth
}): ReserveState {
  const { month, categoryId, perPeriodMinor, periodMonths, transactions } = params
  const setAsideMinor = monthlySetAside(perPeriodMinor, periodMonths)

  const spendByMonth = new Map<IsoMonth, number>()
  for (const t of transactions) {
    if (t.deletedAt !== null || isTransfer(t)) continue
    if (t.categoryId !== categoryId) continue
    const m = monthOf(t.date)
    if (m > month) continue
    spendByMonth.set(m, (spendByMonth.get(m) ?? 0) + Math.abs(t.amountMinor))
  }

  const active = [...spendByMonth.keys()].sort()
  const paidMonths = active.filter((m) => (spendByMonth.get(m) ?? 0) > 0)
  const lastPaid = paidMonths.at(-1) ?? null

  const empty: ReserveState = {
    balanceMinor: 0,
    setAsideMinor,
    perPeriodMinor,
    spentThisMonthMinor: spendByMonth.get(month) ?? 0,
    monthsCounted: 0,
    nextDueMonth: null,
    settledThisPeriod: false,
    lastPaymentMinor: 0,
    shortfallMinor: 0,
    behind: false,
  }

  // Saving restarts after each payment; before the first one it runs from
  // whenever the category became active.
  const start = params.since ?? (lastPaid ? addMonths(lastPaid, 1) : active[0])
  if (!start || start > month) {
    return {
      ...empty,
      lastPaymentMinor: lastPaid ? (spendByMonth.get(lastPaid) ?? 0) : 0,
      nextDueMonth: lastPaid ? addMonths(lastPaid, periodMonths) : null,
      settledThisPeriod: lastPaid !== null,
      shortfallMinor: lastPaid
        ? Math.max(0, (spendByMonth.get(lastPaid) ?? 0) - perPeriodMinor)
        : 0,
    }
  }

  let monthsCounted = 0
  let spentSinceStart = 0
  for (let m = start; m <= month; m = addMonths(m, 1)) {
    monthsCounted++
    spentSinceStart += spendByMonth.get(m) ?? 0
    if (monthsCounted > 600) break // guard against a malformed range
  }

  const balanceMinor = setAsideMinor * monthsCounted - spentSinceStart
  const nextDueMonth = lastPaid ? addMonths(lastPaid, periodMonths) : null
  const lastPaymentMinor = lastPaid ? (spendByMonth.get(lastPaid) ?? 0) : 0

  // Due next month or already overdue, with less saved than the bill will cost.
  const dueSoon = nextDueMonth !== null && addMonths(month, 1) >= nextDueMonth
  const behind = dueSoon && balanceMinor < perPeriodMinor

  return {
    balanceMinor,
    setAsideMinor,
    perPeriodMinor,
    spentThisMonthMinor: spendByMonth.get(month) ?? 0,
    monthsCounted,
    nextDueMonth,
    settledThisPeriod: lastPaid !== null && nextDueMonth !== null && month < nextDueMonth,
    lastPaymentMinor,
    // The budget being too small for the actual bill is the genuinely
    // actionable problem, and it survives across periods.
    shortfallMinor: Math.max(0, lastPaymentMinor - perPeriodMinor),
    behind,
  }
}

/**
 * Infers a billing interval from the months a category was actually paid in.
 *
 * Returns null unless the gaps are consistent — an irregular category is not
 * periodic, and claiming otherwise would produce a confident wrong forecast.
 */
export function inferPeriodMonths(paidMonths: IsoMonth[]): number | null {
  const months = [...new Set(paidMonths)].sort()
  if (months.length < 2) return null

  const gaps: number[] = []
  for (let i = 1; i < months.length; i++) {
    const [ay, am] = months[i - 1].split('-').map(Number)
    const [by, bm] = months[i].split('-').map(Number)
    gaps.push(by * 12 + bm - (ay * 12 + am))
  }

  const first = gaps[0]
  if (first < 2) return null // monthly or denser is not a sinking fund
  // Every gap must agree; one irregular payment disqualifies it.
  if (!gaps.every((g) => g === first)) return null

  // Only intervals that divide a year evenly are offered.
  return [2, 3, 4, 6, 12].includes(first) ? first : null
}

/** Rounds an inferred interval onto the nearest offered option. */
export function nearestPeriodOption(months: number): number {
  return PERIOD_OPTIONS.reduce((best, o) =>
    Math.abs(o.months - months) < Math.abs(best.months - months) ? o : best,
  ).months
}
