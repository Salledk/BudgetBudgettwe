import type { IsoMonth } from '@/lib/dates'
import type { Category } from '@/data/types'

/**
 * How often a bill arrives, and what that works out to per month.
 *
 * This used to be a budgeting mode of its own — a periodic category's budget
 * held a whole period's cost and a reserve was accrued against it. Rollover
 * pots (`pot.ts`) do that job more generally, so the interval is now only a
 * hint: it says when the next bill is expected, which is what lets the app warn
 * that a pot will fall short. It no longer changes what a budget amount means.
 */

/**
 * Every interval `inferPeriodMonths` can return must appear here. It did not
 * once: inference could produce 2 or 4 while the picker offered only 1, 3, 6
 * and 12, so a bi-monthly category was flagged periodic yet showed no interval
 * anyone could select.
 */
export const PERIOD_OPTIONS = [
  { months: 1, label: 'Hver måned' },
  { months: 2, label: 'Hver 2. måned' },
  { months: 3, label: 'Hvert kvartal' },
  { months: 4, label: 'Hver 4. måned' },
  { months: 6, label: 'Hvert halve år' },
  { months: 12, label: 'En gang om året' },
] as const

/** Intervals inference is allowed to produce — all of them selectable above. */
export const INFERABLE_PERIODS = [2, 3, 4, 6, 12]

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
  return INFERABLE_PERIODS.includes(first) ? first : null
}
