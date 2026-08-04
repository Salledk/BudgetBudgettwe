import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatMonthLabel } from '@/lib/dates'
import { formatMoneyRounded, parseUserAmount } from '@/lib/money'
import { Banner, Empty, MonthPicker, ProgressBar, Screen, Sheet, Sparkline, Spinner } from '@/app/components'
import { useAppData } from '@/app/useAppData'
import * as repo from '@/data/repo'
import { DEFAULT_BUDGET_MONTH } from '@/data/types'
import { projectMonth, type CategoryProjection } from '@/features/projections/project'
import { MIN_MONTHS, suggestBudget, type CategorySuggestion } from './suggest'

/** Which budget is being edited: the standing default, or one month. */
type Scope = 'default' | 'month'

export function BudgetScreen() {
  const { loading, transactions, categories, categoriesById, budgets, pots, month, setMonth, historyMonths, refresh } = useAppData()
  const [showSuggest, setShowSuggest] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [scope, setScope] = useState<Scope>('month')
  const [defaults, setDefaults] = useState<Map<string, number>>(new Map())

  // The standing budget is not part of the month-scoped app state, so it is
  // loaded here and refreshed whenever the month view changes underneath it.
  useEffect(() => {
    void repo.listDefaultBudgets().then((rows) => setDefaults(new Map(rows.map((b) => [b.categoryId, b.amountMinor]))))
  }, [budgets])

  const projection = useMemo(
    () => projectMonth({ month, transactions, categories, budgets, pots, historyMonths }),
    [month, transactions, categories, budgets, historyMonths],
  )

  // historyMonths is already anchored to months that contain data.
  const monthsWithData = historyMonths
  const hasBudget = budgets.size > 0

  async function saveBudget(categoryId: string, text: string) {
    const minor = parseUserAmount(text)
    // Closing the editor on unreadable input silently discarded what was
    // typed and left the old figure in place, with nothing to explain it.
    if (minor === null) {
      setInvalid(true)
      return
    }
    setEditing(null)
    setInvalid(false)

    if (scope === 'default') {
      if (minor <= 0) await repo.deleteDefaultBudget(categoryId)
      else await repo.setDefaultBudget(categoryId, minor, 'user')
    } else if (minor <= 0) {
      // Zero in a month is a deliberate "nothing here", not a request to fall
      // back to the standard budget — that is what "Brug standard" is for.
      await repo.setBudget(month, categoryId, 0, 'user')
    } else {
      await repo.setBudget(month, categoryId, minor, 'user')
    }
    await refresh()
  }

  /** Drops this month's override so the category follows the standard again. */
  async function resetToDefault(categoryId: string) {
    await repo.deleteBudget(month, categoryId)
    await refresh()
  }

  async function setRollover(categoryId: string, rollover: boolean) {
    // Accrual starts now rather than being backdated over budgets that were
    // never in force, which would open the pot at a confident wrong number.
    await repo.updateCategory(categoryId, {
      rollover,
      rolloverSince: rollover ? month : null,
    })
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
          {/* A standing budget every month inherits, so an unchanged category
              never has to be typed in again. */}
          <div className="flex gap-2">
            <button
              type="button"
              className={scope === 'month' ? 'chip-on flex-1' : 'chip-off flex-1'}
              onClick={() => { setScope('month'); setEditing(null) }}
            >
              {formatMonthLabel(month)}
            </button>
            <button
              type="button"
              className={scope === 'default' ? 'chip-on flex-1' : 'chip-off flex-1'}
              onClick={() => { setScope('default'); setEditing(null) }}
            >
              Standard
            </button>
          </div>

          {scope === 'default' && (
            <Banner tone="info">
              Standardbudgettet gælder alle måneder. Ret en enkelt måned ved at skifte tilbage — det ændrer kun den måned.
            </Banner>
          )}

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
            {rows.map((c) => {
              const category = categoriesById.get(c.categoryId)
              const resolved = budgets.get(c.categoryId)
              const inherited = resolved?.inherited ?? false
              const shownMinor = scope === 'default' ? (defaults.get(c.categoryId) ?? null) : c.budgetMinor

              return (
                <li key={c.categoryId} className="card">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <Link
                      to={`/transactions?category=${encodeURIComponent(c.categoryId)}&month=${month}`}
                      className="flex min-w-0 items-center gap-2 text-sm font-medium"
                    >
                      <span aria-hidden>{c.icon}</span>
                      <span className="truncate">{c.categoryName}</span>
                      {c.pot ? (
                        <span className="shrink-0 text-[10px] text-ink-400">OPSPARING</span>
                      ) : (
                        c.isRecurring && <span className="shrink-0 text-[10px] text-ink-400">FAST</span>
                      )}
                    </Link>
                    <button
                      type="button"
                      className="tnum shrink-0 rounded-lg bg-ink-100 px-2.5 py-1 text-sm font-semibold dark:bg-ink-800"
                      onClick={() => {
                        setEditing(c.categoryId)
                        setInvalid(false)
                        // Plain whole kroner. Seeding the field with a
                        // formatted "3.700,00" made it awkward to type over and
                        // left the editor showing a different format from the
                        // button that opened it.
                        setDraft(shownMinor ? String(Math.round(shownMinor / 100)) : '')
                      }}
                    >
                      {shownMinor === null ? 'Sæt budget' : formatMoneyRounded(shownMinor)}
                    </button>
                  </div>

                  {scope === 'month' && (
                    <div className="mb-2 flex items-center gap-2 text-xs text-ink-500">
                      {inherited ? (
                        <span>Følger standardbudgettet</span>
                      ) : (
                        <>
                          <span>Kun denne måned</span>
                          <button type="button" className="underline" onClick={() => void resetToDefault(c.categoryId)}>
                            Brug standard
                          </button>
                        </>
                      )}
                    </div>
                  )}

                  {editing === c.categoryId && (
                    <div className="mb-2 space-y-2">
                      <div className="flex items-center gap-2">
                        <div className="relative flex-1">
                          <input
                            autoFocus
                            inputMode="decimal"
                            aria-label={`Budget for ${c.categoryName} i kroner`}
                            className={`field pr-10 text-right ${invalid ? 'border-red-500' : ''}`}
                            value={draft}
                            // Select everything on focus so typing replaces the
                            // amount instead of being appended to it.
                            onFocus={(e) => e.currentTarget.select()}
                            onChange={(e) => {
                              setDraft(e.target.value)
                              setInvalid(false)
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void saveBudget(c.categoryId, draft)
                              if (e.key === 'Escape') setEditing(null)
                            }}
                          />
                          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-ink-400">
                            kr.
                          </span>
                        </div>
                        <button type="button" className="btn-primary" onClick={() => void saveBudget(c.categoryId, draft)}>
                          Gem
                        </button>
                        <button type="button" className="btn-ghost px-2" onClick={() => setEditing(null)}>
                          Fortryd
                        </button>
                      </div>
                      {invalid && <p className="text-xs text-red-600">Skriv et beløb, fx 3500.</p>}
                      {category?.rollover && (
                        <p className="text-xs text-ink-500">
                          Beløbet lægges til kategorien hver måned. Det der ikke bliver brugt, bliver stående.
                        </p>
                      )}
                    </div>
                  )}

                  {c.pot ? (
                    <PotRow projection={c} />
                  ) : (
                    <>
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
                    </>
                  )}

                  {c.message && (
                    <p
                      className={`mt-2 text-xs ${
                        c.status === 'over' ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'
                      }`}
                    >
                      {c.message}
                    </p>
                  )}

                  {/* Kept out of the amount editor: deciding that a category
                      saves up is a different decision from typing what it gets
                      each month, and a control appearing mid-edit made entering
                      a number feel like filling in a form. */}
                  {category && !category.isSystem && category.kind === 'expense' && (
                    <label className="mt-2 flex items-center gap-1.5 text-xs text-ink-400">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-brand-600"
                        checked={category.rollover}
                        onChange={(e) => void setRollover(c.categoryId, e.target.checked)}
                      />
                      Gem det ubrugte til næste måned
                    </label>
                  )}
                </li>
              )
            })}
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
 * A category that rolls over shows what is in the pot, not this month against
 * this month's budget. The question is "how much is there to spend", and the
 * answer includes everything carried in from previous months.
 */
function PotRow({ projection }: { projection: CategoryProjection }) {
  const p = projection.pot!
  const owed = p.availableMinor < 0
  // Measured against everything that was available this month, so the bar reads
  // as "how much of the pot is gone" rather than "how much of this month's
  // budget is gone".
  const poolMinor = p.carriedInMinor + p.budgetedMinor
  const ratio = poolMinor > 0 ? p.spentMinor / poolMinor : 0

  return (
    <>
      <ProgressBar ratio={ratio} color={projection.color} over={owed} />
      <div className="mt-1.5 flex justify-between text-xs text-ink-500">
        <span className="tnum">{formatMoneyRounded(p.spentMinor)} brugt</span>
        <span className={`tnum ${owed ? 'text-red-600 dark:text-red-400' : ''}`}>
          {owed
            ? `${formatMoneyRounded(-p.availableMinor)} i minus`
            : `${formatMoneyRounded(p.availableMinor)} i kassen`}
        </span>
      </div>
      <p className="mt-1 text-xs text-ink-400">
        {formatMoneyRounded(p.carriedInMinor)} overført + {formatMoneyRounded(p.budgetedMinor)} denne måned
        {p.nextDueMonth && ` · næste regning ca. ${formatMonthLabel(p.nextDueMonth)}`}
      </p>
    </>
  )
}

/**
 * Suggestion review. Every figure is editable before it is saved — the
 * suggestion is a starting point derived from habit, not a verdict.
 */
function SuggestSheet({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const { transactions, categories, month, historyMonths } = useAppData()
  const [overrides, setOverrides] = useState<Record<string, number>>({})
  // Raw text per row, so typing is not fought by reformatting.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  // Categories where the user declined the inferred billing interval.
  const [periodicOptOut, setPeriodicOptOut] = useState<Set<string>>(new Set())

  const suggestion = useMemo(
    () => suggestBudget({ transactions, categories, months: historyMonths }),
    [transactions, categories, historyMonths],
  )

  const amountFor = (s: CategorySuggestion) => overrides[s.categoryId] ?? s.suggestedMinor

  const total = suggestion.categories
    .filter((s) => !excluded.has(s.categoryId))
    .reduce((sum, s) => sum + amountFor(s), 0)

  /**
   * `asDefault` writes the standing budget, which is almost always what is
   * wanted — a budget derived from months of habit describes a normal month,
   * not one particular month.
   */
  async function save(asDefault: boolean) {
    setBusy(true)
    const entries = suggestion.categories
      .filter((s) => !excluded.has(s.categoryId) && amountFor(s) > 0)
      .map((s) => ({
        categoryId: s.categoryId,
        amountMinor: amountFor(s),
        source: (overrides[s.categoryId] !== undefined ? 'user' : 'suggested') as 'user' | 'suggested',
      }))

    await repo.setBudgets(asDefault ? DEFAULT_BUDGET_MONTH : month, entries)

    // Accepting a periodic suggestion also records the interval, so the reserve
    // starts building rather than the category being budgeted flat.
    for (const s of suggestion.categories) {
      if (excluded.has(s.categoryId) || !s.suggestedPeriodMonths) continue
      if (periodicOptOut.has(s.categoryId)) continue
      await repo.updateCategory(s.categoryId, {
        periodMonths: s.suggestedPeriodMonths,
        rollover: true,
        rolloverSince: month,
      })
    }

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
                    {/* The text has to be its own state. Deriving the value
                        from the parsed number reformatted it on every
                        keystroke, and an unparseable value — an empty field,
                        mid-edit — was dropped entirely, so the box could not
                        even be cleared. */}
                    <input
                      inputMode="decimal"
                      aria-label={`Budget for ${s.categoryName} i kroner`}
                      className="tnum w-28 shrink-0 rounded-lg border border-ink-200 bg-white px-2 py-1.5 text-right
                                 text-sm font-semibold dark:border-ink-700 dark:bg-ink-800"
                      value={drafts[s.categoryId] ?? String(Math.round(amountFor(s) / 100))}
                      disabled={off}
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) => {
                        const text = e.target.value
                        setDrafts((d) => ({ ...d, [s.categoryId]: text }))
                        const minor = parseUserAmount(text)
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
                      onClick={() => {
                        setOverrides((o) => ({ ...o, [s.categoryId]: s.safeMinor }))
                        setDrafts((d) => ({ ...d, [s.categoryId]: String(Math.round(s.safeMinor / 100)) }))
                      }}
                    >
                      Brug sikkert bud i stedet: {formatMoneyRounded(s.safeMinor)} →
                    </button>
                  )}

                  {s.suggestedPeriodMonths && !off && (
                    <div className="mt-2 rounded-lg bg-blue-50 px-3 py-2 text-xs dark:bg-blue-950/50">
                      {periodicOptOut.has(s.categoryId) ? (
                        <button
                          type="button"
                          className="underline"
                          onClick={() =>
                            setPeriodicOptOut((prev) => {
                              const next = new Set(prev)
                              next.delete(s.categoryId)
                              return next
                            })
                          }
                        >
                          Gem alligevel det ubrugte
                        </button>
                      ) : (
                        <>
                          Ser ud til at blive betalt{' '}
                          {s.suggestedPeriodMonths === 12
                            ? 'en gang om året'
                            : `hver ${s.suggestedPeriodMonths}. måned`}
                          . Det ubrugte bliver stående, så der er nok når regningen kommer.{' '}
                          <button
                            type="button"
                            className="underline"
                            onClick={() => setPeriodicOptOut((prev) => new Set(prev).add(s.categoryId))}
                          >
                            Nej tak
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>

          <div className="space-y-2">
            {/* A budget built from months of habit describes a normal month, so
                saving it as the standard is the sensible default. */}
            <button type="button" className="btn-primary w-full" onClick={() => void save(true)} disabled={busy}>
              Gem som standardbudget
            </button>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => void save(false)} disabled={busy}>
                Kun {formatMonthLabel(month)}
              </button>
              <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
                Annullér
              </button>
            </div>
          </div>
        </>
      )}
    </Sheet>
  )
}
