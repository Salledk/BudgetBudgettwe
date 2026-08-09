import { daysInMonth, monthOf, type IsoMonth } from '@/lib/dates'
import { median } from '@/lib/stats'
import type { Transaction } from '@/data/types'
import { isTransfer } from '@/features/import/transfers'

/**
 * When within a month a category's spending actually happens.
 *
 * Judging a month by "spent ÷ days elapsed × days in month" assumes money
 * leaves the account at a constant daily rate, and almost nothing does: rent is
 * all of it on the 1st, groceries arrive in weekly steps, a holiday is one
 * lump. That assumption made a single big shop on the 3rd read as a catastrophe
 * and a weekly shopper on the 29th read as comfortable, one day before the last
 * shop of the month.
 *
 * So the shape is learned per category from the user's own history instead.
 * "Ahead or behind" then means ahead or behind *their* normal rhythm for that
 * category, which is the only comparison that answers the question honestly.
 */

/** Below this many contributing months, the shape is guesswork and is not claimed. */
export const MIN_MONTHS_FOR_CURVE = 3

/** Longest month, so every curve is indexable by any day-of-month. */
const MAX_DAY = 31

export interface PaceCurve {
  /**
   * Cumulative fraction of a normal month's total spent by the **end** of each
   * day. Indexed by day-of-month, so `byDay[14]` is "by the 14th". Index 0 is
   * unused and always 0.
   */
  byDay: number[]
  /** History months that contributed. Months with no spend are not evidence. */
  monthsUsed: number
}

/** A curve that claims nothing, for a category with too little history. */
function emptyCurve(monthsUsed = 0): PaceCurve {
  return { byDay: new Array<number>(MAX_DAY + 1).fill(0), monthsUsed }
}

export function isReliable(curve: PaceCurve): boolean {
  return curve.monthsUsed >= MIN_MONTHS_FOR_CURVE
}

/**
 * Cumulative spend shape per category, in one pass over the transactions —
 * deliberately mirroring `monthlyTotals` in `suggest.ts`, which answers the
 * same question about whole months.
 */
export function spendCurves(
  transactions: Transaction[],
  months: IsoMonth[],
): Map<string, PaceCurve> {
  const monthSet = new Set(months)

  // categoryId → month → day-of-month → spend on that day
  const byCategory = new Map<string, Map<IsoMonth, number[]>>()

  for (const tx of transactions) {
    if (tx.deletedAt !== null) continue
    if (isTransfer(tx)) continue
    if (!tx.categoryId) continue

    const month = monthOf(tx.date)
    if (!monthSet.has(month)) continue

    const day = Number(tx.date.slice(8, 10))
    if (!Number.isFinite(day) || day < 1 || day > MAX_DAY) continue

    const perMonth = byCategory.get(tx.categoryId) ?? new Map<IsoMonth, number[]>()
    const perDay = perMonth.get(month) ?? new Array<number>(MAX_DAY + 1).fill(0)
    perDay[day] += Math.abs(tx.amountMinor)
    perMonth.set(month, perDay)
    byCategory.set(tx.categoryId, perMonth)
  }

  const out = new Map<string, PaceCurve>()

  for (const [categoryId, perMonth] of byCategory) {
    // One normalised cumulative curve per month that actually saw spending.
    const curves: number[][] = []

    for (const [month, perDay] of perMonth) {
      const total = perDay.reduce((sum, v) => sum + v, 0)
      if (total <= 0) continue

      const lastDay = daysInMonth(month)
      const cumulative = new Array<number>(MAX_DAY + 1).fill(0)
      let running = 0
      for (let day = 1; day <= MAX_DAY; day++) {
        running += perDay[day] ?? 0
        // Past the end of a short month nothing more can happen, so the curve
        // holds at 1 rather than trailing off and dragging the median down.
        cumulative[day] = day >= lastDay ? 1 : running / total
      }
      curves.push(cumulative)
    }

    if (curves.length === 0) {
      out.set(categoryId, emptyCurve())
      continue
    }

    const byDay = new Array<number>(MAX_DAY + 1).fill(0)
    for (let day = 1; day <= MAX_DAY; day++) {
      byDay[day] = median(curves.map((c) => c[day]))
    }

    out.set(categoryId, { byDay: tidy(byDay), monthsUsed: curves.length })
  }

  return out
}

/**
 * A per-day median across months can dip — the median of several months can
 * fall on day 12 and rise again on day 13 — and a cumulative curve that goes
 * backwards would be reporting spending un-happening. Clamped to [0,1], forced
 * non-decreasing, and ending at 1 so a full month always accounts for itself.
 */
function tidy(byDay: number[]): number[] {
  const out = byDay.slice()
  let highest = 0
  for (let day = 1; day <= MAX_DAY; day++) {
    highest = Math.max(highest, Math.min(1, Math.max(0, out[day])))
    out[day] = highest
  }
  out[MAX_DAY] = 1
  return out
}

export interface PaceState {
  /** Where a normal month, scaled to this budget, would stand by now. */
  expectedByNowMinor: number
  actualMinor: number
  /** actual − expected. Positive is ahead of the usual pace. */
  aheadMinor: number
  /** Where the month lands if the rest follows the usual shape. */
  projectedMinor: number
  /** Day the reading was taken, for wording it. */
  day: number
  /** False when the history is too thin to claim a shape at all. */
  reliable: boolean
}

export function paceAt(params: {
  curve: PaceCurve
  budgetMinor: number
  actualMinor: number
  day: number
  /** Typical month total, used where this month has not yet revealed itself. */
  historicalMedianMinor: number
}): PaceState {
  const { curve, budgetMinor, actualMinor, historicalMedianMinor } = params
  const day = Math.max(1, Math.min(MAX_DAY, params.day))
  const reliable = isReliable(curve)

  if (!reliable) {
    return {
      expectedByNowMinor: 0,
      actualMinor,
      aheadMinor: 0,
      projectedMinor: historicalMedianMinor || actualMinor,
      day,
      reliable: false,
    }
  }

  const fraction = curve.byDay[day] ?? 0
  const expectedByNowMinor = Math.round(budgetMinor * fraction)

  /*
   * What this month implies, weighted by how much of a normal month has
   * actually happened yet.
   *
   * The old code reached for this with a hard-coded "blend for the first ten
   * days"; weighting by the curve itself is the same instinct measured against
   * the category rather than the calendar. It is also what defuses the day-3
   * explosion: after one early shop the fraction is small, so most of the
   * weight still sits on history.
   */
  const implied = fraction > 0 ? actualMinor / fraction : historicalMedianMinor
  const projectedMinor = Math.round(implied * fraction + historicalMedianMinor * (1 - fraction))

  return {
    expectedByNowMinor,
    actualMinor,
    aheadMinor: actualMinor - expectedByNowMinor,
    // Never forecast less than has already been spent.
    projectedMinor: Math.max(projectedMinor, actualMinor),
    day,
    reliable: true,
  }
}
