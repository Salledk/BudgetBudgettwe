import { useMemo, useState } from 'react'
import { formatMonthLabel } from '@/lib/dates'
import { formatAmountPlain, formatMoneyRounded, parseUserAmount } from '@/lib/money'
import { Banner, Empty, MonthPicker, ProgressBar, Screen, Sheet, Sparkline, Spinner } from '@/app/components'
import { useAppData } from '@/app/useAppData'
import * as repo from '@/data/repo'
import { projectMonth } from '@/features/projections/project'
import { MIN_MONTHS, suggestBudget, type CategorySuggestion } from './suggest'

export function BudgetScreen() {
  const { loading, transactions, categories, budgets, month, setMonth, historyMonths, refresh } = useAppData()
  const [showSuggest, setShowSuggest] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const projection = useMemo(
    () => projectMonth({ month, transactions, categories, budgets, historyMonths }),
    [month, transactions, categories, budgets, historyMonths],
  )

  // historyMonths is already anchored to months that contain data.
  const monthsWithData = historyMonths
  const hasBudget = budgets.size > 0

  async function saveBudget(categoryId: string, text: string) {
    const minor = parseUserAmount(text)
    setEditing(null)
    if (minor === null) return
    if (minor <= 0) await repo.deleteBudget(month, categoryId)
    else await repo.setBudget(month, categoryId, minor, 'user')
    await refresh()
  }

  /** Copies the previous month's budget forward — the common case for a new month. */
  async function inheritPrevious() {
    const previous = await repo.latestBudgetedMonth(month)
    if (!previous) return
    const rows = await repo.listBudgets(previous)
    await repo.setBudgets(
      month,
      rows.map((b) => ({ categoryId: b.categoryId, amountMinor: b.amountMinor, source: b.source })),
    )
    await refresh()
  }

  if (loading) return <Screen title="Budget"><Spinner /></Screen>

  if (transactions.length === 0) {
    return (
      <Screen title="Budget">
        <Empty icon="📊" title="Intet at budgettere endnu" body="Importér nogle kontoudtog først — så foreslår jeg et budget ud fra dine vaner." />
      </Screen>
    )
  }

  const rows = projection.categories.filter((c) => c.budgetMinor !== null || c.actualMinor > 0)

  return (
    <Screen title="Budget" action={<MonthPicker month={month} onChange={setMonth} />}>
      {!hasBudget && (
        <div className="card space-y-3">
          <h2 className="font-semibold">Intet budget for {formatMonthLabel(month)}</h2>
          <p className="text-sm text-ink-500">
            {monthsWithData.length >= MIN_MONTHS
              ? `Jeg kan foreslå et budget ud fra dine sidste ${monthsWithData.length} måneder.`
              : `Du har data fra ${monthsWithData.length} ${monthsWithData.length === 1 ? 'måned' : 'måneder'} — jeg har brug for mindst ${MIN_MONTHS} for at foreslå noget fornuftigt.`}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-primary flex-1"
              disabled={monthsWithData.length < MIN_MONTHS}
              onClick={() => setShowSuggest(true)}
            >
              Foreslå budget
            </button>
            <button type="button" className="btn-secondary" onClick={inheritPrevious}>
              Kopiér sidste måned
            </button>
          </div>
        </div>
      )}

      {hasBudget && (
        <>
          <section className="card">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-sm text-ink-500">Budget i alt</span>
              <button type="button" className="text-sm text-ink-500" onClick={() => setShowSuggest(true)}>
                Genberegn →
              </button>
            </div>
            <div className="tnum text-2xl font-bold">{formatMoneyRounded(projection.budgetTotalMinor)}</div>
            {/* Compared against a typical month, not this one — a budget set on
                the 1st should not read as unaffordable just because no salary
                has landed yet. */}
            {projection.historicalIncomeMinor > 0 && (
              <p className="mt-1 text-sm text-ink-500">
                Forventet indkomst {formatMoneyRounded(projection.historicalIncomeMinor)} —{' '}
                {projection.historicalIncomeMinor >= projection.budgetTotalMinor ? (
                  <span className="text-emerald-600 dark:text-emerald-400">
                    {formatMoneyRounded(projection.historicalIncomeMinor - projection.budgetTotalMinor)} tilbage til opsparing
                  </span>
                ) : (
                  <span className="text-red-600 dark:text-red-400">
                    budgettet er {formatMoneyRounded(projection.budgetTotalMinor - projection.historicalIncomeMinor)} større end indkomsten
                  </span>
                )}
              </p>
            )}
          </section>

          <ul className="space-y-2">
            {rows.map((c) => (
              <li key={c.categoryId} className="card">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                    <span aria-hidden>{c.icon}</span>
                    <span className="truncate">{c.categoryName}</span>
                    {c.isRecurring && <span className="shrink-0 text-[10px] text-ink-400">FAST</span>}
                  </span>
                  <button
                    type="button"
                    className="tnum shrink-0 rounded-lg bg-ink-100 px-2.5 py-1 text-sm font-semibold dark:bg-ink-800"
                    onClick={() => {
                      setEditing(c.categoryId)
                      setDraft(c.budgetMinor ? formatAmountPlain(c.budgetMinor) : '')
                    }}
                  >
                    {c.budgetMinor === null ? 'Sæt budget' : formatMoneyRounded(c.budgetMinor)}
                  </button>
                </div>

                {editing === c.categoryId && (
                  <div className="mb-2 flex gap-2">
                    <input
                      autoFocus
                      inputMode="decimal"
                      className="field"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveBudget(c.categoryId, draft)
                        if (e.key === 'Escape') setEditing(null)
                      }}
                    />
                    <button type="button" className="btn-primary" onClick={() => void saveBudget(c.categoryId, draft)}>
                      Gem
                    </button>
                  </div>
                )}

                <ProgressBar
                  ratio={c.budgetMinor ? c.actualMinor / c.budgetMinor : 0}
                  color={c.color}
                  over={c.status === 'over'}
                />
                <div className="mt-1.5 flex justify-between text-xs text-ink-500">
                  <span className="tnum">{formatMoneyRounded(c.actualMinor)} brugt</span>
                  {c.remainingMinor !== null && (
                    <span className={`tnum ${c.remainingMinor < 0 ? 'text-red-600 dark:text-red-400' : ''}`}>
                      {c.remainingMinor < 0
                        ? `${formatMoneyRounded(-c.remainingMinor)} over`
                        : `${formatMoneyRounded(c.remainingMinor)} tilbage`}
                    </span>
                  )}
                </div>
                {c.message && (
                  <p
                    className={`mt-2 text-xs ${
                      c.status === 'over' ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'
                    }`}
                  >
                    {c.message}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {showSuggest && (
        <SuggestSheet
          onClose={() => setShowSuggest(false)}
          onSaved={async () => {
            setShowSuggest(false)
            await refresh()
          }}
        />
      )}
    </Screen>
  )
}

/**
 * Suggestion review. Every figure is editable before it is saved — the
 * suggestion is a starting point derived from habit, not a verdict.
 */
function SuggestSheet({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const { transactions, categories, month, historyMonths } = useAppData()
  const [overrides, setOverrides] = useState<Record<string, number>>({})
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const suggestion = useMemo(
    () => suggestBudget({ transactions, categories, months: historyMonths }),
    [transactions, categories, historyMonths],
  )

  const amountFor = (s: CategorySuggestion) => overrides[s.categoryId] ?? s.suggestedMinor

  const total = suggestion.categories
    .filter((s) => !excluded.has(s.categoryId))
    .reduce((sum, s) => sum + amountFor(s), 0)

  async function save() {
    setBusy(true)
    await repo.setBudgets(
      month,
      suggestion.categories
        .filter((s) => !excluded.has(s.categoryId) && amountFor(s) > 0)
        .map((s) => ({
          categoryId: s.categoryId,
          amountMinor: amountFor(s),
          source: (overrides[s.categoryId] !== undefined ? 'user' : 'suggested') as 'user' | 'suggested',
        })),
    )
    setBusy(false)
    await onSaved()
  }

  return (
    <Sheet open onClose={onClose} title={`Forslag til ${formatMonthLabel(month)}`}>
      <p className="mb-3 text-sm text-ink-500">
        Baseret på {suggestion.months.length} måneders forbrug. Ret beløbene som du vil.
      </p>

      {suggestion.categories.length === 0 ? (
        <Banner tone="warn">Ikke nok kategoriseret data til at foreslå et budget endnu.</Banner>
      ) : (
        <>
          <div className="card mb-3">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-ink-500">I alt</span>
              <span className="tnum text-xl font-bold">{formatMoneyRounded(total)}</span>
            </div>
            {suggestion.expectedIncomeMinor > 0 && (
              <p className="mt-1 text-xs text-ink-500">
                Forventet indkomst {formatMoneyRounded(suggestion.expectedIncomeMinor)} —{' '}
                {suggestion.expectedIncomeMinor - total >= 0
                  ? `${formatMoneyRounded(suggestion.expectedIncomeMinor - total)} tilbage til opsparing`
                  : `${formatMoneyRounded(total - suggestion.expectedIncomeMinor)} for meget`}
              </p>
            )}
            {suggestion.totalSetAsideMinor > 0 && (
              <p className="mt-1 text-xs text-ink-500">
                Derudover ca. {formatMoneyRounded(suggestion.totalSetAsideMinor)}/md at lægge til side til store,
                uregelmæssige regninger.
              </p>
            )}
          </div>

          <ul className="mb-4 space-y-2">
            {suggestion.categories.map((s) => {
              const off = excluded.has(s.categoryId)
              return (
                <li key={s.categoryId} className={`card ${off ? 'opacity-40' : ''}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{s.categoryName}</div>
                      <div className="text-xs text-ink-500">{s.rationale}</div>
                    </div>
                    <input
                      inputMode="decimal"
                      className="tnum w-28 shrink-0 rounded-lg border border-ink-200 bg-white px-2 py-1.5 text-right
                                 text-sm font-semibold dark:border-ink-700 dark:bg-ink-800"
                      value={formatAmountPlain(amountFor(s))}
                      disabled={off}
                      onChange={(e) => {
                        const minor = parseUserAmount(e.target.value)
                        if (minor !== null) setOverrides((o) => ({ ...o, [s.categoryId]: minor }))
                      }}
                    />
                  </div>

                  <div className="mt-2 flex items-center gap-3">
                    <div className="flex-1">
                      <Sparkline values={s.history.map((h) => h.amountMinor)} color={s.pattern === 'recurring' ? '#0ea5e9' : '#94a3b8'} />
                    </div>
                    <button
                      type="button"
                      className="shrink-0 text-xs text-ink-500 underline"
                      onClick={() =>
                        setExcluded((prev) => {
                          const next = new Set(prev)
                          if (next.has(s.categoryId)) next.delete(s.categoryId)
                          else next.add(s.categoryId)
                          return next
                        })
                      }
                    >
                      {off ? 'Tag med' : 'Spring over'}
                    </button>
                  </div>

                  {s.pattern === 'variable' && s.safeMinor > s.suggestedMinor && !off && (
                    <button
                      type="button"
                      className="mt-2 text-xs text-ink-500"
                      onClick={() => setOverrides((o) => ({ ...o, [s.categoryId]: s.safeMinor }))}
                    >
                      Brug sikkert bud i stedet: {formatMoneyRounded(s.safeMinor)} →
                    </button>
                  )}
                </li>
              )
            })}
          </ul>

          <div className="flex gap-2">
            <button type="button" className="btn-primary flex-1" onClick={save} disabled={busy}>
              Brug dette budget
            </button>
            <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
              Annullér
            </button>
          </div>
        </>
      )}
    </Sheet>
  )
}
