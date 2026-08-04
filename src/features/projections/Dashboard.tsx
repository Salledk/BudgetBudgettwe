import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { formatMoneyRounded, formatMoney } from '@/lib/money'
import { formatMonthLabel } from '@/lib/dates'
import { useAccountBalances, useAppData } from '@/app/useAppData'
import { Banner, Empty, MonthPicker, ProgressBar, Screen, Spinner } from '@/app/components'
import { projectMonth, runway } from './project'

export function Dashboard() {
  const { loading, transactions, categories, budgets, pots, month, setMonth, historyMonths, accounts } = useAppData()
  const balances = useAccountBalances()

  const projection = useMemo(
    () => projectMonth({ month, transactions, categories, budgets, pots, historyMonths }),
    [month, transactions, categories, budgets, historyMonths],
  )

  const spendingBalance = useMemo(() => {
    const spending = accounts.find((a) => a.kind === 'spending') ?? accounts[0]
    return spending ? (balances.get(spending.id) ?? null) : null
  }, [accounts, balances])

  const daysRemaining = projection.daysTotal - projection.daysElapsed
  const daysLeft = runway({
    balanceMinor: spendingBalance,
    projectedNetMinor: projection.projectedNetMinor,
    daysRemaining,
  })

  if (loading) return <Screen title="Overblik"><Spinner /></Screen>

  if (transactions.length === 0) {
    return (
      <Screen title="Overblik">
        <Empty
          icon="📥"
          title="Ingen transaktioner endnu"
          body="Upload et kontoudtog for at komme i gang. Alt bliver på din enhed."
          action={
            <Link to="/import" className="btn-primary mt-2">
              Importér kontoudtog
            </Link>
          }
        />
      </Screen>
    )
  }

  const budgeted = projection.budgetTotalMinor
  const spent = projection.categories
    .filter((c) => c.budgetMinor !== null)
    .reduce((sum, c) => sum + c.actualMinor, 0)

  // Nothing imported for this month. Showing projected figures here would be
  // a forecast built entirely from other months, which reads as fact.
  if (!projection.hasActivity) {
    return (
      <Screen title="Overblik" action={<MonthPicker month={month} onChange={setMonth} />}>
        <Empty
          icon="🗓️"
          title={`Ingen transaktioner i ${formatMonthLabel(month)}`}
          body="Importér kontoudtoget for denne måned, så viser jeg forbrug og prognose."
          action={
            <Link to="/import" className="btn-primary mt-2">
              Importér kontoudtog
            </Link>
          }
        />
        <section className="card">
          <h2 className="mb-3 font-semibold">Konti</h2>
          <ul className="space-y-2">
            {accounts.map((a) => (
              <li key={a.id} className="flex items-center justify-between text-sm">
                <span>{a.name}</span>
                <span className="tnum font-semibold">{formatMoney(balances.get(a.id) ?? 0)}</span>
              </li>
            ))}
          </ul>
        </section>
      </Screen>
    )
  }

  return (
    <Screen title="Overblik" action={<MonthPicker month={month} onChange={setMonth} />}>
      {projection.uncategorisedCount > 0 && (
        <Banner
          tone="warn"
          action={
            <Link to="/transactions?filter=uncategorised" className="btn-secondary px-3 py-1.5 text-xs">
              Ordn
            </Link>
          }
        >
          <strong>{projection.uncategorisedCount}</strong> transaktioner mangler kategori
          {' '}({formatMoneyRounded(projection.uncategorisedMinor)}).
        </Banner>
      )}

      {budgeted > 0 ? (
        <section className="card">
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-sm text-ink-500">Brugt af budget</span>
            <span className="text-xs text-ink-500">
              dag {projection.daysElapsed} af {projection.daysTotal}
            </span>
          </div>
          <div className="mb-3 flex items-baseline gap-2">
            <span className="tnum text-3xl font-bold">{formatMoneyRounded(spent)}</span>
            <span className="text-sm text-ink-500">af {formatMoneyRounded(budgeted)}</span>
          </div>
          <ProgressBar ratio={budgeted === 0 ? 0 : spent / budgeted} over={spent > budgeted} />
          <p className="mt-3 text-sm text-ink-500">
            {projection.isCurrentMonth ? (
              <>
                Lander omkring{' '}
                <strong className="text-ink-900 dark:text-ink-100">
                  {formatMoneyRounded(projection.projectedBudgetedMinor)}
                </strong>
                {projection.projectedBudgetedMinor > budgeted ? (
                  <span className="text-red-600 dark:text-red-400">
                    {' '}— {formatMoneyRounded(projection.projectedBudgetedMinor - budgeted)} over budget
                  </span>
                ) : (
                  <span className="text-emerald-600 dark:text-emerald-400">
                    {' '}— {formatMoneyRounded(budgeted - projection.projectedBudgetedMinor)} tilbage
                  </span>
                )}
              </>
            ) : (
              <>Måneden er afsluttet.</>
            )}
          </p>
        </section>
      ) : (
        <Banner
          tone="info"
          action={
            <Link to="/budget" className="btn-secondary px-3 py-1.5 text-xs">
              Opret
            </Link>
          }
        >
          Du har ikke sat et budget for denne måned endnu.
        </Banner>
      )}

      {projection.alerts.length > 0 && (
        <section className="card">
          <h2 className="mb-3 font-semibold">⚠️ Hold øje med</h2>
          <ul className="space-y-2.5">
            {projection.alerts.slice(0, 4).map((a) => (
              <li key={a.categoryId} className="flex gap-2.5 text-sm">
                <span aria-hidden>{a.icon}</span>
                <span className={a.status === 'over' ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300'}>
                  {a.message}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="grid grid-cols-2 gap-3">
        <div className="card">
          <div className="text-xs text-ink-500">Indkomst {projection.isCurrentMonth && '(forventet)'}</div>
          <div className="tnum mt-1 text-lg font-bold text-emerald-600 dark:text-emerald-400">
            {formatMoneyRounded(projection.projectedIncomeMinor)}
          </div>
        </div>
        <div className="card">
          <div className="text-xs text-ink-500">Udgift {projection.isCurrentMonth && '(forventet)'}</div>
          <div className="tnum mt-1 text-lg font-bold">{formatMoneyRounded(projection.projectedExpenseMinor)}</div>
        </div>
        <div className="card col-span-2">
          <div className="text-xs text-ink-500">Forventet resultat for måneden</div>
          <div
            className={`tnum mt-1 text-2xl font-bold ${
              projection.projectedNetMinor >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
            }`}
          >
            {projection.projectedNetMinor >= 0 ? '+' : '−'}
            {formatMoneyRounded(Math.abs(projection.projectedNetMinor))}
          </div>
          {daysLeft !== null && daysLeft < daysRemaining && (
            <p className="mt-2 text-sm text-red-600 dark:text-red-400">
              Med det nuværende forbrug rækker forbrugskontoen ca. {daysLeft} dage til.
            </p>
          )}
        </div>
      </section>

      <section className="card">
        <h2 className="mb-3 font-semibold">Konti</h2>
        <ul className="space-y-2">
          {accounts.map((a) => (
            <li key={a.id} className="flex items-center justify-between text-sm">
              <span>{a.name}</span>
              <span className="tnum font-semibold">{formatMoney(balances.get(a.id) ?? 0)}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* Shown for any month, not just the current one — the breakdown is the
          main way into a month's transactions, and hiding it for past months
          made history a dead end. */}
      {projection.categories.length > 0 && (
        <section className="card">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">Kategorier</h2>
            <Link to="/budget" className="text-sm text-ink-500">
              Se budget →
            </Link>
          </div>
          <ul className="space-y-3">
            {projection.categories.slice(0, 6).map((c) => (
              <li key={c.categoryId}>
                <Link
                  to={`/transactions?category=${encodeURIComponent(c.categoryId)}&month=${month}`}
                  className="block rounded-lg py-0.5 transition active:opacity-60"
                >
                  <div className="mb-1 flex items-baseline justify-between text-sm">
                    <span>
                      {c.icon} {c.categoryName}
                      {c.pot && <span className="ml-1 text-[10px] text-ink-400">OPSPARING</span>}
                    </span>
                    <span className="tnum text-ink-500">
                      {formatMoneyRounded(c.actualMinor)}
                      {c.budgetMinor !== null && ` / ${formatMoneyRounded(c.budgetMinor)}`}
                    </span>
                  </div>
                  {c.budgetMinor !== null && c.budgetMinor > 0 && (
                    <ProgressBar
                      ratio={c.actualMinor / c.budgetMinor}
                      color={c.color}
                      over={c.status === 'over'}
                    />
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Screen>
  )
}
