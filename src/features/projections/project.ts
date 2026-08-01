import { currentMonth, daysInMonth, elapsedDaysInMonth, monthOf, type IsoMonth } from '@/lib/dates'
import { median } from '@/lib/stats'
import type { Category, ResolvedBudget, Transaction } from '@/data/types'
import { isTransfer } from '@/features/import/transfers'
import { monthlyTotals } from '@/features/budget/suggest'
import { isPeriodic, reserveAt, type ReserveState } from '@/features/budget/periodic'

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
   * Sinking-fund state for a periodic category. When set, `budgetMinor` is the
   * monthly set-aside and `remainingMinor` is the reserve balance rather than
   * budget-minus-spend.
   */
  periodic: ReserveState | null
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
  /** Months of history used to decide recurring vs variable. */
  historyMonths: IsoMonth[]
  now?: Date
}): MonthProjection {
  const { month, transactions, categories, budgets, historyMonths } = params
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

  const projections: CategoryProjection[] = []

  const relevantIds = new Set<string>([...actualByCategory.keys(), ...budgets.keys()])

  for (const categoryId of relevantIds) {
    const category = byId.get(categoryId)
    if (!category || category.kind === 'transfer' || category.kind === 'income') continue

    const actualMinor = actualByCategory.get(categoryId) ?? 0
    const budget = budgets.get(categoryId)
    const rawBudgetMinor = budget ? budget.amountMinor : null

    /*
     * A periodic category is judged against what it should be putting aside
     * each month, not against the whole periodic bill. Comparing a month's
     * spending to a full annual premium would call eleven months a triumph and
     * the twelfth a catastrophe, which is exactly the distortion this exists to
     * remove.
     */
    if (isPeriodic(category) && rawBudgetMinor !== null) {
      const periodMonths = category.periodMonths as number
      const reserve = reserveAt({
        month,
        categoryId,
        perPeriodMinor: rawBudgetMinor,
        periodMonths,
        transactions,
      })

      /*
       * Two distinct problems, and neither is "spent a lot this month":
       *  - the budget is smaller than the bill actually turned out to be
       *  - the bill is nearly due and not enough has been set aside
       * Anything else is a fund quietly doing its job.
       */
      const status: ProjectionStatus =
        reserve.shortfallMinor > 0 ? 'over' : reserve.behind ? 'at-risk' : 'on-track'

      const message =
        reserve.shortfallMinor > 0
          ? `${category.name}: regningen var ${krLabel(reserve.lastPaymentMinor)} — ${krLabel(reserve.shortfallMinor)} mere end budgetteret.`
          : reserve.behind
            ? `${category.name}: regning forventes snart, men der er kun sat ${krLabel(reserve.balanceMinor)} af ${krLabel(reserve.perPeriodMinor)} til side.`
            : null

      projections.push({
        categoryId,
        categoryName: category.name,
        icon: category.icon,
        color: category.color,
        budgetMinor: reserve.setAsideMinor,
        actualMinor,
        projectedMinor: reserve.setAsideMinor,
        remainingMinor: reserve.balanceMinor,
        status,
        recurringSettled: reserve.settledThisPeriod,
        isRecurring: true,
        periodic: reserve,
        message,
      })
      continue
    }

    const budgetMinor = rawBudgetMinor
    const isRecurring = recurring.has(categoryId)

    const historicalMedian = medianOf(history.get(categoryId), historyMonths)

    const projectedMinor = projectCategory({
      actualMinor,
      isRecurring,
      historicalMedian,
      budgetMinor,
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
      periodic: null,
      message: messageFor(category.name, actualMinor, projectedMinor, budgetMinor, status),
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
  daysElapsed: number
  daysTotal: number
  shouldProject: boolean
}): number {
  // A finished — or not-yet-started — month is not a projection.
  if (!p.shouldProject) return p.actualMinor

  if (p.isRecurring) {
    // The bill has landed — nothing more is expected this month.
    if (p.actualMinor > 0) return p.actualMinor
    // Not yet paid. Expect the usual amount, or the budget if there's no history.
    return p.historicalMedian || p.budgetMinor || 0
  }

  // Variable: extrapolate the daily rate over the rest of the month.
  const projected = scaleToMonth(p.actualMinor, p.daysElapsed, p.daysTotal)

  // Very early in the month a couple of purchases extrapolate absurdly
  // (one 800 kr shop on the 2nd → 12.000 kr). Blend toward the historical
  // median until enough of the month has passed for the rate to mean something.
  if (p.daysElapsed < 10 && p.historicalMedian > 0) {
    const weight = p.daysElapsed / 10
    return Math.round(projected * weight + p.historicalMedian * (1 - weight))
  }

  return projected
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

function messageFor(
  name: string,
  actualMinor: number,
  projectedMinor: number,
  budgetMinor: number | null,
  status: ProjectionStatus,
): string | null {
  if (budgetMinor === null || status === 'no-budget' || status === 'on-track') return null

  const kr = (minor: number) => `${Math.round(minor / 100).toLocaleString('da-DK')} kr`

  if (actualMinor > budgetMinor) {
    return `${name}: ${kr(actualMinor)} brugt af ${kr(budgetMinor)} — allerede ${kr(actualMinor - budgetMinor)} over.`
  }
  return `${name}: ${kr(actualMinor)} af ${kr(budgetMinor)} — lander omkring ${kr(projectedMinor)}, ca. ${kr(projectedMinor - budgetMinor)} over.`
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
