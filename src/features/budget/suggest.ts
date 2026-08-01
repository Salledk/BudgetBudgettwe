import { monthOf, type IsoMonth } from '@/lib/dates'
import { coefficientOfVariation, detectOutliers, median, percentile, roundToBudgetFigure, trimmedMean } from '@/lib/stats'
import type { Category, Transaction } from '@/data/types'
import { isTransfer } from '@/features/import/transfers'

/**
 * Derives a suggested monthly budget from spending history.
 *
 * The core problem is that a naive average is wrong in two opposite ways:
 * an annual insurance premium makes one month look catastrophic and eleven
 * months look cheap, while a steady rent payment needs no smoothing at all.
 * So categories are classified first, and each class gets the estimator that
 * suits it.
 */

/** Minimum months of history before a suggestion is worth making. */
export const MIN_MONTHS = 3

/** Whole kroner with Danish grouping, for the plain-language rationales. */
function kr(minor: number): string {
  return `${Math.round(minor / 100).toLocaleString('da-DK')} kr.`
}

export type SpendingPattern = 'recurring' | 'variable' | 'sparse'

export interface CategorySuggestion {
  categoryId: string
  categoryName: string
  pattern: SpendingPattern
  /** The recommended monthly budget, rounded to a human figure. */
  suggestedMinor: number
  /** A more cautious figure (75th percentile) for variable categories. */
  safeMinor: number
  /** Monthly totals used, oldest first — drives the sparkline. */
  history: Array<{ month: IsoMonth; amountMinor: number }>
  medianMinor: number
  minMinor: number
  maxMinor: number
  /** Months in the window where this category saw any activity. */
  monthsPresent: number
  monthsConsidered: number
  /** Large irregular payments held out of the monthly figure. */
  oneOffs: Array<{ month: IsoMonth; amountMinor: number }>
  /** Monthly amount to set aside to cover those one-offs over a year. */
  setAsideMinor: number
  /** Plain-language reason, shown under the suggestion. */
  rationale: string
}

export interface BudgetSuggestion {
  months: IsoMonth[]
  categories: CategorySuggestion[]
  totalSuggestedMinor: number
  totalSetAsideMinor: number
  expectedIncomeMinor: number
  /** Income minus suggested spending. Negative means the budget cannot balance. */
  headroomMinor: number
  hasEnoughHistory: boolean
}

/**
 * Sums expense transactions per category per month.
 * Transfers are excluded — see transfers.ts for why that matters.
 */
export function monthlyTotals(
  transactions: Transaction[],
  months: IsoMonth[],
): Map<string, Map<IsoMonth, number>> {
  const monthSet = new Set(months)
  const out = new Map<string, Map<IsoMonth, number>>()

  for (const tx of transactions) {
    if (tx.deletedAt !== null) continue
    if (isTransfer(tx)) continue
    if (!tx.categoryId) continue

    const month = monthOf(tx.date)
    if (!monthSet.has(month)) continue

    const perMonth = out.get(tx.categoryId) ?? new Map<IsoMonth, number>()
    perMonth.set(month, (perMonth.get(month) ?? 0) + Math.abs(tx.amountMinor))
    out.set(tx.categoryId, perMonth)
  }

  return out
}

export function suggestBudget(params: {
  transactions: Transaction[]
  categories: Category[]
  months: IsoMonth[]
}): BudgetSuggestion {
  const { transactions, categories, months } = params
  const totals = monthlyTotals(transactions, months)
  const byId = new Map(categories.map((c) => [c.id, c]))

  const suggestions: CategorySuggestion[] = []
  let expectedIncomeMinor = 0

  for (const [categoryId, perMonth] of totals) {
    const category = byId.get(categoryId)
    if (!category) continue
    if (category.kind === 'transfer') continue

    // Zero-fill so a month with no spending counts as 0 rather than vanishing —
    // otherwise a category bought twice a year looks like a monthly habit.
    const history = months.map((m) => ({ month: m, amountMinor: perMonth.get(m) ?? 0 }))
    const values = history.map((h) => h.amountMinor)
    const present = values.filter((v) => v > 0)

    if (present.length === 0) continue

    if (category.kind === 'income') {
      // Income is projected, not budgeted. Median resists a bonus month.
      expectedIncomeMinor += median(present)
      continue
    }

    suggestions.push(buildSuggestion(category, history, present, months.length))
  }

  suggestions.sort((a, b) => b.suggestedMinor - a.suggestedMinor)

  const totalSuggestedMinor = suggestions.reduce((sum, s) => sum + s.suggestedMinor, 0)
  const totalSetAsideMinor = suggestions.reduce((sum, s) => sum + s.setAsideMinor, 0)

  return {
    months,
    categories: suggestions,
    totalSuggestedMinor,
    totalSetAsideMinor,
    expectedIncomeMinor,
    headroomMinor: expectedIncomeMinor - totalSuggestedMinor - totalSetAsideMinor,
    hasEnoughHistory: months.length >= MIN_MONTHS,
  }
}

function buildSuggestion(
  category: Category,
  history: Array<{ month: IsoMonth; amountMinor: number }>,
  present: number[],
  monthsConsidered: number,
): CategorySuggestion {
  const presenceRatio = present.length / monthsConsidered
  const { normal, outliers } = detectOutliers(present)

  const oneOffs = history.filter((h) => outliers.includes(h.amountMinor) && h.amountMinor > 0)

  // Spread is measured on the de-spiked values; otherwise a single annual
  // payment would make a perfectly steady subscription look erratic.
  const cov = coefficientOfVariation(normal)

  let pattern: SpendingPattern
  let suggestedRaw: number
  let rationale: string

  if (presenceRatio < 0.5) {
    // Shows up rarely — budgeting a monthly figure for it would be noise.
    // The estimate is the rate observed across the window: we cannot tell from
    // this data whether a single payment is annual, semi-annual or a one-off,
    // so the wording claims only what was actually measured.
    pattern = 'sparse'
    suggestedRaw = Math.round(present.reduce((a, b) => a + b, 0) / monthsConsidered)
    rationale = `Uregelmæssig — set i ${present.length} af ${monthsConsidered} måneder. Forslaget er forbruget fordelt jævnt over perioden.`
  } else if (presenceRatio >= 0.8 && cov < 0.15) {
    // A fixed bill. The median is the right answer; smoothing adds nothing.
    pattern = 'recurring'
    suggestedRaw = median(normal)
    rationale = 'Fast udgift — samme beløb hver måned.'
  } else {
    pattern = 'variable'
    // Trimmed mean over de-spiked months: resists both an unusually quiet
    // month and an unusually expensive one.
    suggestedRaw = trimmedMean(normal)
    // kr() already ends in a period, which doubles as the sentence stop.
    rationale = `Varierer mellem ${kr(Math.min(...normal))} og ${kr(Math.max(...normal))}`
  }

  // Annual irregulars spread across 12 months, so the holiday and the car
  // service are provisioned for instead of arriving as a surprise.
  const oneOffTotal = oneOffs.reduce((sum, o) => sum + o.amountMinor, 0)
  const setAsideMinor = oneOffs.length > 0 ? roundToBudgetFigure(Math.round(oneOffTotal / 12)) : 0

  if (oneOffs.length > 0) {
    rationale += ` ${oneOffs.length} stor${oneOffs.length > 1 ? 'e' : ''} enkeltbetaling${oneOffs.length > 1 ? 'er' : ''} er holdt udenfor.`
  }

  return {
    categoryId: category.id,
    categoryName: category.name,
    pattern,
    suggestedMinor: roundToBudgetFigure(suggestedRaw),
    safeMinor: roundToBudgetFigure(percentile(normal, 0.75)),
    history,
    medianMinor: median(present),
    minMinor: Math.min(...present),
    maxMinor: Math.max(...present),
    monthsPresent: present.length,
    monthsConsidered,
    oneOffs,
    setAsideMinor,
    rationale,
  }
}
