import { currentMonth, daysInMonth, elapsedDaysInMonth, monthOf, type IsoMonth } from '@/lib/dates'
import { median } from '@/lib/stats'
import type { Category, ResolvedBudget, Transaction } from '@/data/types'
import { isTransfer } from '@/features/import/transfers'
import { monthlyTotals } from '@/features/budget/suggest'
import type { PotState } from '@/features/budget/pot'
import { paceAt, spendCurves, type PaceCurve, type PaceState } from './pace'

/**
 * Where the current month will land, per category and overall.
 *
 * The naive projection — scale spending so far by days-remaining — is badly
 * wrong for fixed bills: rent paid on the 1st would project to 8.500 × 30
 * by the end of the month. So recurring categories are projected as "what has
 * already happened, plus any bill still expected", and only genuinely variable
 * categories are pro-rated by day.
 */

export type ProjectionStatus = 'on-track' | 'at-risk' | 'over' | 'no-budget'

export interface CategoryProjection {
  categoryId: string
  categoryName: string
  icon: string
  color: string
  budgetMinor: number | null
  actualMinor: number
  projectedMinor: number
  remainingMinor: number | null
  status: ProjectionStatus
  /** True when the bill for a recurring category has already been paid. */
  recurringSettled: boolean
  isRecurring: boolean
  /**
   * Pot state for a category that rolls over. When set, `remainingMinor` is
   * what is actually available — the balance carried in plus this month's
   * budget, less what has been spent — rather than budget-minus-spend.
   */
  pot: PotState | null
  /**
   * Where this month stands against the category's usual rhythm. Null for a
   * fixed bill, which has no pace to be ahead of, and for a category whose
   * history is too thin to claim a shape.
   */
  pace: PaceState | null
  /** Plain-language line shown in the alerts list. */
  message: string | null
}

export interface MonthProjection {
  month: IsoMonth
  daysElapsed: number
  daysTotal: number
  isCurrentMonth: boolean
  /** False when nothing has been imported for this month yet. */
  hasActivity: boolean

  incomeMinor: number
  expenseMinor: number
  projectedIncomeMinor: number
  projectedExpenseMinor: number
  projectedNetMinor: number
  /**
   * Typical monthly income from history, independent of this month's activity.
   * Budget screens compare against this — asking "can I afford this budget?"
   * is a question about a normal month, not about how far into this one we are.
   */
  historicalIncomeMinor: number

  budgetTotalMinor: number
  /** Sum of projected spend across categories that have a budget. */
  projectedBudgetedMinor: number

  categories: CategoryProjection[]
  alerts: CategoryProjection[]
  uncategorisedCount: number
  uncategorisedMinor: number
}

/** Fraction of budget above which a category is flagged before it is exceeded. */
export const AT_RISK_THRESHOLD = 1.0
export const OVER_THRESHOLD = 1.1

export function projectMonth(params: {
  month: IsoMonth
  transactions: Transaction[]
  categories: Category[]
  budgets: Map<string, ResolvedBudget>
  /**
   * Pot state per category that rolls over. Computed outside — a pot spans
   * every month since it was opened, and this function deliberately sees only
   * one month's budgets.
   */
  pots?: Map<string, PotState>
  /** Months of history used to decide recurring vs variable. */
  historyMonths: IsoMonth[]
  now?: Date
}): MonthProjection {
  const { month, transactions, categories, budgets, historyMonths } = params
  const pots = params.pots ?? new Map<string, PotState>()
  const now = params.now ?? new Date()

  const isCurrentMonth = month === currentMonth(now)
  const daysTotal = daysInMonth(month)
  const daysElapsed = Math.max(1, Math.min(elapsedDaysInMonth(month, now), daysTotal))

  const byId = new Map(categories.map((c) => [c.id, c]))
  const monthTx = transactions.filter((t) => t.deletedAt === null && monthOf(t.date) === month)

  /**
   * Nothing imported for this month yet. Projecting here would produce a
   * confident-looking forecast built entirely from other months — an expected
   * income with no expenses beside it, which reads as a surplus that does not
   * exist. Better to report zeros and let the UI say the month is empty.
   */
  const hasActivity = monthTx.length > 0
  const shouldProject = isCurrentMonth && hasActivity

  // Which categories behave like fixed bills, judged on prior months.
  const recurring = detectRecurringCategories(transactions, historyMonths, categories)

  let incomeMinor = 0
  let expenseMinor = 0
  let uncategorisedCount = 0
  let uncategorisedMinor = 0

  const actualByCategory = new Map<string, number>()

  for (const tx of monthTx) {
    if (isTransfer(tx)) continue

    if (tx.amountMinor > 0) incomeMinor += tx.amountMinor
    else expenseMinor += Math.abs(tx.amountMinor)

    if (!tx.categoryId) {
      uncategorisedCount++
      uncategorisedMinor += Math.abs(tx.amountMinor)
      continue
    }
    const category = byId.get(tx.categoryId)
    if (!category || category.kind === 'income') continue

    actualByCategory.set(tx.categoryId, (actualByCategory.get(tx.categoryId) ?? 0) + Math.abs(tx.amountMinor))
  }

  // Historical medians, used to estimate what a recurring bill will still cost
  // if it has not been paid yet this month.
  const history = monthlyTotals(transactions, historyMonths)

  // When within a month each category usually spends. Judging against this
  // instead of a daily average is what stops one early shop reading as a
  // disaster and a weekly shopper reading as safe the day before a shop.
  const curves = spendCurves(transactions, historyMonths)

  const projections: CategoryProjection[] = []

  const relevantIds = new Set<string>([...actualByCategory.keys(), ...budgets.keys()])

  for (const categoryId of relevantIds) {
    const category = byId.get(categoryId)
    if (!category || category.kind === 'transfer' || category.kind === 'income') continue

    const actualMinor = actualByCategory.get(categoryId) ?? 0
    const budget = budgets.get(categoryId)
    const rawBudgetMinor = budget ? budget.amountMinor : null

    /*
     * A category that rolls over is judged against what is actually in the pot,
     * not against this month's budget alone. Spending 6.400 kr in the month an
     * annual premium lands is not overspending if eleven months of budget have
     * been accumulating for it.
     */
    const pot = pots.get(categoryId)
    if (pot) {
      /*
       * Two distinct problems, and neither is "spent a lot this month":
       *  - the pot is empty and now owes money, which carries into next month
       *  - a bill is expected shortly and the pot will not cover it
       * Anything else is a pot quietly doing its job.
       */
      const status: ProjectionStatus =
        pot.availableMinor < 0 ? 'over' : pot.behind ? 'at-risk' : 'on-track'

      const message =
        pot.availableMinor < 0
          ? `${category.name}: ${krLabel(-pot.availableMinor)} mere brugt end der stod — beløbet mangler næste måned.`
          : pot.behind
            ? `${category.name}: regning forventes snart, men der står kun ${krLabel(pot.availableMinor)} i kategorien.`
            : null

      projections.push({
        categoryId,
        categoryName: category.name,
        icon: category.icon,
        color: category.color,
        budgetMinor: pot.budgetedMinor,
        actualMinor,
        projectedMinor: pot.budgetedMinor,
        remainingMinor: pot.availableMinor,
        status,
        // A pot spans months, so "already settled this month" says nothing
        // useful about it.
        recurringSettled: false,
        isRecurring: recurring.has(categoryId),
        pot,
        pace: null,
        message,
      })
      continue
    }

    const budgetMinor = rawBudgetMinor
    const isRecurring = recurring.has(categoryId)

    const historicalMedian = medianOf(history.get(categoryId), historyMonths)

    const { projectedMinor, pace } = projectCategory({
      actualMinor,
      isRecurring,
      historicalMedian,
      budgetMinor,
      curve: curves.get(categoryId),
      daysElapsed,
      daysTotal,
      shouldProject,
    })

    const status = statusFor(actualMinor, projectedMinor, budgetMinor)

    projections.push({
      categoryId,
      categoryName: category.name,
      icon: category.icon,
      color: category.color,
      budgetMinor,
      actualMinor,
      projectedMinor,
      remainingMinor: budgetMinor === null ? null : budgetMinor - actualMinor,
      status,
      recurringSettled: isRecurring && actualMinor > 0,
      isRecurring,
      pot: null,
      pace,
      message: messageFor(category.name, actualMinor, projectedMinor, budgetMinor, status, pace),
    })
  }

  projections.sort((a, b) => severity(b.status) - severity(a.status) || b.projectedMinor - a.projectedMinor)

  const projectedExpenseMinor = shouldProject
    ? projections.reduce((sum, p) => sum + p.projectedMinor, 0) +
      // Uncategorised spending still counts toward the month's total.
      scaleToMonth(uncategorisedMinor, daysElapsed, daysTotal)
    : expenseMinor

  const historicalIncomeMinor = medianIncome(transactions, historyMonths, categories)

  // Assume the usual salary still to come, but only once the month has begun
  // producing data — otherwise this is income with no expenses beside it.
  const projectedIncomeMinor = shouldProject ? Math.max(incomeMinor, historicalIncomeMinor) : incomeMinor

  const budgetTotalMinor = [...budgets.values()].reduce((sum, b) => sum + b.amountMinor, 0)
  const projectedBudgetedMinor = projections
    .filter((p) => p.budgetMinor !== null)
    .reduce((sum, p) => sum + p.projectedMinor, 0)

  return {
    month,
    daysElapsed,
    daysTotal,
    isCurrentMonth,
    hasActivity,
    incomeMinor,
    expenseMinor,
    projectedIncomeMinor,
    projectedExpenseMinor,
    projectedNetMinor: projectedIncomeMinor - projectedExpenseMinor,
    historicalIncomeMinor,
    budgetTotalMinor,
    projectedBudgetedMinor,
    categories: projections,
    alerts: projections.filter((p) => p.status === 'over' || p.status === 'at-risk'),
    uncategorisedCount,
    uncategorisedMinor,
  }
}

function projectCategory(p: {
  actualMinor: number
  isRecurring: boolean
  historicalMedian: number
  budgetMinor: number | null
  curve: PaceCurve | undefined
  daysElapsed: number
  daysTotal: number
  shouldProject: boolean
}): { projectedMinor: number; pace: PaceState | null } {
  // A finished — or not-yet-started — month is not a projection.
  if (!p.shouldProject) return { projectedMinor: p.actualMinor, pace: null }

  if (p.isRecurring) {
    // A fixed bill has no pace to be ahead of: it has either landed or it has
    // not, and pro-rating it was never the question.
    const projectedMinor =
      p.actualMinor > 0
        ? p.actualMinor // The bill has landed — nothing more is expected.
        : p.historicalMedian || p.budgetMinor || 0
    return { projectedMinor, pace: null }
  }

  // Variable: judge against how this category usually spends across a month.
  if (p.curve && p.budgetMinor !== null && p.budgetMinor > 0) {
    const pace = paceAt({
      curve: p.curve,
      budgetMinor: p.budgetMinor,
      actualMinor: p.actualMinor,
      day: p.daysElapsed,
      historicalMedianMinor: p.historicalMedian,
    })
    if (pace.reliable) return { projectedMinor: pace.projectedMinor, pace }
  }

  /*
   * Too little history to know the shape. Rather than assert a straight line —
   * the assumption this whole module exists to remove — lean on what a normal
   * month costs, and only fall back to extrapolation when there is no history
   * at all to lean on.
   */
  if (p.historicalMedian > 0) {
    return { projectedMinor: Math.max(p.historicalMedian, p.actualMinor), pace: null }
  }

  return {
    projectedMinor: scaleToMonth(p.actualMinor, p.daysElapsed, p.daysTotal),
    pace: null,
  }
}

function scaleToMonth(amount: number, daysElapsed: number, daysTotal: number): number {
  if (daysElapsed <= 0) return 0
  return Math.round((amount / daysElapsed) * daysTotal)
}

function statusFor(actualMinor: number, projectedMinor: number, budgetMinor: number | null): ProjectionStatus {
  if (budgetMinor === null || budgetMinor === 0) return 'no-budget'
  if (actualMinor > budgetMinor) return 'over'
  if (projectedMinor > budgetMinor * OVER_THRESHOLD) return 'over'
  if (projectedMinor > budgetMinor * AT_RISK_THRESHOLD) return 'at-risk'
  return 'on-track'
}

function severity(status: ProjectionStatus): number {
  switch (status) {
    case 'over':
      return 3
    case 'at-risk':
      return 2
    case 'on-track':
      return 1
    default:
      return 0
  }
}

function krLabel(minor: number): string {
  return `${Math.round(minor / 100).toLocaleString('da-DK')} kr`
}

/**
 * The warning line in the alerts list.
 *
 * It used to say "lander omkring 5.600 kr" from a straight-line extrapolation
 * — a number derived from an assumption the user does not spend by. Where the
 * category's rhythm is known the comparison is against that rhythm, and the
 * figure quoted is something that actually happened in past months. Where it is
 * not known, the line states facts and forecasts nothing.
 */
function messageFor(
  name: string,
  actualMinor: number,
  projectedMinor: number,
  budgetMinor: number | null,
  status: ProjectionStatus,
  pace: PaceState | null,
): string | null {
  if (budgetMinor === null || status === 'no-budget' || status === 'on-track') return null

  const kr = krLabel

  if (actualMinor > budgetMinor) {
    return `${name}: ${kr(actualMinor)} brugt af ${kr(budgetMinor)} — allerede ${kr(actualMinor - budgetMinor)} over.`
  }

  if (pace?.reliable) {
    return `${name}: ${kr(actualMinor)} brugt — du plejer at være på ${kr(pace.expectedByNowMinor)} den ${pace.day}. Lander omkring ${kr(projectedMinor)}.`
  }

  return `${name}: ${kr(actualMinor)} af ${kr(budgetMinor)} brugt.`
}

function medianOf(perMonth: Map<IsoMonth, number> | undefined, months: IsoMonth[]): number {
  if (!perMonth) return 0
  const values = months.map((m) => perMonth.get(m) ?? 0).filter((v) => v > 0)
  return values.length === 0 ? 0 : median(values)
}

function medianIncome(transactions: Transaction[], months: IsoMonth[], categories: Category[]): number {
  const incomeIds = new Set(categories.filter((c) => c.kind === 'income').map((c) => c.id))
  const monthSet = new Set(months)
  const perMonth = new Map<IsoMonth, number>()

  for (const tx of transactions) {
    if (tx.deletedAt !== null || isTransfer(tx)) continue
    if (tx.amountMinor <= 0) continue
    if (tx.categoryId && !incomeIds.has(tx.categoryId)) continue
    const m = monthOf(tx.date)
    if (!monthSet.has(m)) continue
    perMonth.set(m, (perMonth.get(m) ?? 0) + tx.amountMinor)
  }

  const values = [...perMonth.values()].filter((v) => v > 0)
  return values.length === 0 ? 0 : median(values)
}

/**
 * Identifies categories that behave like fixed bills: present in most months
 * with a consistent amount. Reuses the same presence + spread reasoning as the
 * budget suggester so the two never disagree about what "recurring" means.
 */
export function detectRecurringCategories(
  transactions: Transaction[],
  months: IsoMonth[],
  categories: Category[],
): Set<string> {
  const out = new Set<string>()
  if (months.length < 2) return out

  const totals = monthlyTotals(transactions, months)
  const byId = new Map(categories.map((c) => [c.id, c]))

  for (const [categoryId, perMonth] of totals) {
    const category = byId.get(categoryId)
    if (!category || category.kind !== 'expense') continue

    const values = months.map((m) => perMonth.get(m) ?? 0)
    const present = values.filter((v) => v > 0)
    if (present.length / months.length < 0.8) continue

    const m = median(present)
    if (m === 0) continue
    // Every month within ±25% of the median reads as a fixed bill.
    const consistent = present.every((v) => Math.abs(v - m) / m < 0.25)
    if (consistent) out.add(categoryId)
  }

  return out
}

/**
 * Days until the spending account runs dry at the current burn rate.
 * Returns null when the balance is unknown or spending is not outpacing income.
 */
export function runway(params: {
  balanceMinor: number | null
  projectedNetMinor: number
  daysRemaining: number
}): number | null {
  const { balanceMinor, projectedNetMinor, daysRemaining } = params
  if (balanceMinor === null || balanceMinor <= 0) return null
  if (projectedNetMinor >= 0 || daysRemaining <= 0) return null

  const dailyBurn = Math.abs(projectedNetMinor) / Math.max(daysRemaining, 1)
  if (dailyBurn <= 0) return null
  return Math.floor(balanceMinor / dailyBurn)
}
