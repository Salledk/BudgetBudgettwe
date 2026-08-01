import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { currentMonth, lastCompleteMonths, monthOf, type IsoMonth } from '@/lib/dates'
import * as repo from '@/data/repo'
import type { Account, Budget, Category, Settings, Transaction } from '@/data/types'

/**
 * Loads everything once and keeps it in memory.
 *
 * A personal budget spans a few thousand transactions at most — small enough
 * that holding it all in state and recomputing derived values is simpler and
 * faster than re-querying IndexedDB on every filter change.
 */

interface AppData {
  loading: boolean
  accounts: Account[]
  categories: Category[]
  transactions: Transaction[]
  budgets: Map<string, Budget>
  settings: Settings | null
  month: IsoMonth
  setMonth: (m: IsoMonth) => void
  /** Complete months before the current one, used for suggestions and projections. */
  historyMonths: IsoMonth[]
  refresh: () => Promise<void>
  categoriesById: Map<string, Category>
  accountsById: Map<string, Account>
}

const Ctx = createContext<AppData | null>(null)

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [budgets, setBudgets] = useState<Map<string, Budget>>(new Map())
  const [settings, setSettings] = useState<Settings | null>(null)
  const [month, setMonth] = useState<IsoMonth>(() => currentMonth())

  const load = useCallback(async (targetMonth: IsoMonth) => {
    await repo.ensureSeeded()
    const [a, c, t, b, s] = await Promise.all([
      repo.listAccounts(),
      repo.listCategories(),
      repo.listTransactions(),
      repo.budgetMap(targetMonth),
      repo.getSettings(),
    ])
    setAccounts(a)
    setCategories(c)
    setTransactions(t)
    setBudgets(b)
    setSettings(s)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load(month)
  }, [load, month])

  const refresh = useCallback(async () => {
    await load(month)
  }, [load, month])

  /**
   * The months budget suggestions and projections learn from.
   *
   * Anchored to the months that actually contain data rather than to the last
   * N calendar months. Statements are uploaded in batches, often weeks late, so
   * a window fixed to today would frequently be mostly empty — and the app
   * would refuse to suggest a budget while sitting on a year of history.
   */
  const historyMonths = useMemo(() => {
    const lookback = settings?.lookbackMonths ?? 6
    const thisMonth = currentMonth()
    const withData = [
      ...new Set(transactions.filter((t) => t.deletedAt === null).map((t) => monthOf(t.date))),
    ]
      // The current month is still in progress and would drag every average down.
      .filter((m) => m < thisMonth)
      .sort()

    if (withData.length === 0) return lastCompleteMonths(lookback)
    return withData.slice(-lookback)
  }, [transactions, settings?.lookbackMonths])

  const categoriesById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])
  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])

  const value = useMemo(
    () => ({
      loading,
      accounts,
      categories,
      transactions,
      budgets,
      settings,
      month,
      setMonth,
      historyMonths,
      refresh,
      categoriesById,
      accountsById,
    }),
    [loading, accounts, categories, transactions, budgets, settings, month, historyMonths, refresh, categoriesById, accountsById],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAppData(): AppData {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAppData must be used inside AppDataProvider')
  return ctx
}

/** Running balance per account, derived from opening balance plus transactions. */
export function useAccountBalances(): Map<string, number> {
  const { accounts, transactions } = useAppData()
  return useMemo(() => {
    const out = new Map<string, number>()
    for (const a of accounts) out.set(a.id, a.openingBalanceMinor)
    for (const t of transactions) {
      if (t.deletedAt !== null) continue
      out.set(t.accountId, (out.get(t.accountId) ?? 0) + t.amountMinor)
    }
    // A bank-reported balance beats a derived one when the import supplied it.
    for (const a of accounts) {
      const latest = transactions
        .filter((t) => t.accountId === a.id && t.deletedAt === null && t.balanceAfterMinor !== null)
        .sort((x, y) => y.date.localeCompare(x.date) || y.id.localeCompare(x.id))[0]
      if (latest?.balanceAfterMinor != null) out.set(a.id, latest.balanceAfterMinor)
    }
    return out
  }, [accounts, transactions])
}
