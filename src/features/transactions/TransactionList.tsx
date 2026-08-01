import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { formatDayLabel, formatMonthLabel, monthOf } from '@/lib/dates'
import { formatMoney } from '@/lib/money'
import { Banner, Empty, Screen, Sheet, Spinner } from '@/app/components'
import { useAppData } from '@/app/useAppData'
import * as repo from '@/data/repo'
import type { Transaction } from '@/data/types'
import { CategorySheet } from '@/features/categorize/CategorySheet'

type Filter = 'all' | 'uncategorised' | 'review' | 'month'

/**
 * The categorisation workhorse. Optimised for the actual task: working through
 * a pile of uncategorised transactions on a phone, quickly, with bulk select
 * for the common case where ten rows share one category.
 */
export function TransactionList() {
  const { loading, transactions, categoriesById, accountsById, accounts, month, refresh } = useAppData()
  const [params, setParams] = useSearchParams()

  const [filter, setFilter] = useState<Filter>((params.get('filter') as Filter) ?? 'all')
  const [accountId, setAccountId] = useState<string | 'all'>('all')
  const [search, setSearch] = useState('')
  // Drill-down from a category total elsewhere in the app. Kept in the URL so
  // the back button returns to the screen that sent you here.
  const categoryId = params.get('category')
  const monthParam = params.get('month')
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [sheetFor, setSheetFor] = useState<Transaction[] | null>(null)
  const [detail, setDetail] = useState<Transaction | null>(null)
  const [limit, setLimit] = useState(100)

  const needsReviewCount = useMemo(
    () => transactions.filter((t) => t.categorySource === 'learned' && !t.reviewed).length,
    [transactions],
  )
  const uncategorisedCount = useMemo(() => transactions.filter((t) => t.categoryId === null).length, [transactions])

  const filtered = useMemo(() => {
    let rows = transactions
    if (categoryId) rows = rows.filter((t) => t.categoryId === categoryId)
    if (monthParam) rows = rows.filter((t) => monthOf(t.date) === monthParam)
    if (filter === 'uncategorised') rows = rows.filter((t) => t.categoryId === null)
    if (filter === 'review') rows = rows.filter((t) => t.categorySource === 'learned' && !t.reviewed)
    if (filter === 'month') rows = rows.filter((t) => monthOf(t.date) === month)
    if (accountId !== 'all') rows = rows.filter((t) => t.accountId === accountId)
    if (search.trim()) {
      const q = search.toLowerCase()
      rows = rows.filter((t) => t.rawText.toLowerCase().includes(q))
    }
    return rows
  }, [transactions, filter, accountId, search, month, categoryId, monthParam])

  const drilldownTotal = useMemo(
    () => filtered.reduce((sum, t) => sum + Math.abs(t.amountMinor), 0),
    [filtered],
  )

  function clearParam(key: string) {
    params.delete(key)
    setParams(params, { replace: true })
    setLimit(100)
  }

  const visible = filtered.slice(0, limit)

  const grouped = useMemo(() => {
    const groups: Array<{ date: string; rows: Transaction[] }> = []
    for (const tx of visible) {
      const last = groups.at(-1)
      if (last && last.date === tx.date) last.rows.push(tx)
      else groups.push({ date: tx.date, rows: [tx] })
    }
    return groups
  }, [visible])

  function setFilterAndUrl(next: Filter) {
    setFilter(next)
    setSelection(new Set())
    setLimit(100)
    if (next === 'all') params.delete('filter')
    else params.set('filter', next)
    setParams(params, { replace: true })
  }

  function toggle(id: string) {
    setSelection((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectionMode = selection.size > 0
  const selected = useMemo(() => transactions.filter((t) => selection.has(t.id)), [transactions, selection])

  if (loading) return <Screen title="Transaktioner"><Spinner /></Screen>

  return (
    <Screen title="Transaktioner">
      {(categoryId || monthParam) && (
        <div className="card flex flex-wrap items-center gap-2">
          <span className="text-sm text-ink-500">Viser</span>
          {categoryId && (
            <button type="button" className="chip-on" onClick={() => clearParam('category')}>
              {categoriesById.get(categoryId)?.icon} {categoriesById.get(categoryId)?.name ?? 'Kategori'} ✕
            </button>
          )}
          {monthParam && (
            <button type="button" className="chip-on" onClick={() => clearParam('month')}>
              {formatMonthLabel(monthParam)} ✕
            </button>
          )}
          <span className="tnum ml-auto text-sm font-semibold">{formatMoney(drilldownTotal)}</span>
          <span className="w-full text-xs text-ink-500">
            {filtered.length} transaktion{filtered.length === 1 ? '' : 'er'} · tryk på et filter for at fjerne det
          </span>
        </div>
      )}

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        <button className={filter === 'all' ? 'chip-on' : 'chip-off'} onClick={() => setFilterAndUrl('all')}>
          Alle
        </button>
        <button className={filter === 'month' ? 'chip-on' : 'chip-off'} onClick={() => setFilterAndUrl('month')}>
          Denne måned
        </button>
        <button
          className={filter === 'uncategorised' ? 'chip-on' : 'chip-off'}
          onClick={() => setFilterAndUrl('uncategorised')}
        >
          Ukategoriseret {uncategorisedCount > 0 && `(${uncategorisedCount})`}
        </button>
        {needsReviewCount > 0 && (
          <button className={filter === 'review' ? 'chip-on' : 'chip-off'} onClick={() => setFilterAndUrl('review')}>
            Gennemgå ({needsReviewCount})
          </button>
        )}
      </div>

      {accounts.length > 1 && (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          <button className={accountId === 'all' ? 'chip-on' : 'chip-off'} onClick={() => setAccountId('all')}>
            Alle konti
          </button>
          {accounts.map((a) => (
            <button key={a.id} className={accountId === a.id ? 'chip-on' : 'chip-off'} onClick={() => setAccountId(a.id)}>
              {a.name}
            </button>
          ))}
        </div>
      )}

      <input
        type="search"
        className="field"
        placeholder="Søg i tekst…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {filter === 'review' && needsReviewCount > 0 && (
        <Banner
          tone="info"
          action={
            <button
              className="btn-secondary px-3 py-1.5 text-xs"
              onClick={async () => {
                await repo.markReviewed(filtered.map((t) => t.id))
                await refresh()
              }}
            >
              Godkend alle
            </button>
          }
        >
          Disse er gættet ud fra dine tidligere valg. Tjek dem, eller godkend alle.
        </Banner>
      )}

      {filtered.length === 0 ? (
        <Empty
          icon="🔍"
          title="Ingen transaktioner"
          body={
            transactions.length === 0
              ? 'Importér et kontoudtog for at komme i gang.'
              : 'Ingen transaktioner matcher filteret.'
          }
        />
      ) : (
        <div className="space-y-4">
          {grouped.map((group) => (
            <section key={group.date}>
              <h2 className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
                {formatDayLabel(group.date)}
              </h2>
              <ul className="overflow-hidden rounded-2xl bg-white dark:bg-ink-900">
                {group.rows.map((tx) => {
                  const category = tx.categoryId ? categoriesById.get(tx.categoryId) : null
                  const isSelected = selection.has(tx.id)
                  return (
                    <li key={tx.id} className="border-b border-ink-100 last:border-0 dark:border-ink-800">
                      <button
                        type="button"
                        className={`flex w-full items-center gap-3 px-3 py-3 text-left transition ${
                          isSelected ? 'bg-ink-100 dark:bg-ink-800' : ''
                        }`}
                        onClick={() => (selectionMode ? toggle(tx.id) : setDetail(tx))}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          toggle(tx.id)
                        }}
                      >
                        <span
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base"
                          style={{ backgroundColor: `${category?.color ?? '#94a3b8'}20` }}
                          aria-hidden
                        >
                          {isSelected ? '✓' : (category?.icon ?? '❓')}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{tx.rawText}</span>
                          <span className="block truncate text-xs text-ink-500">
                            {category?.name ?? 'Ukategoriseret'}
                            {tx.categorySource === 'learned' && !tx.reviewed && ' · gæt'}
                            {accounts.length > 1 && ` · ${accountsById.get(tx.accountId)?.name ?? ''}`}
                          </span>
                        </span>
                        <span
                          className={`tnum shrink-0 text-sm font-semibold ${
                            tx.amountMinor > 0 ? 'text-emerald-600 dark:text-emerald-400' : ''
                          }`}
                        >
                          {formatMoney(tx.amountMinor)}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}

          {filtered.length > visible.length && (
            <button type="button" className="btn-secondary w-full" onClick={() => setLimit((l) => l + 200)}>
              Vis flere ({filtered.length - visible.length} tilbage)
            </button>
          )}
        </div>
      )}

      {selectionMode && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-200 bg-white p-3 pb-8 dark:border-ink-800 dark:bg-ink-900">
          <div className="flex items-center gap-2">
            <button type="button" className="btn-ghost px-3" onClick={() => setSelection(new Set())}>
              Annullér
            </button>
            <button type="button" className="btn-primary flex-1" onClick={() => setSheetFor(selected)}>
              Kategorisér {selection.size}
            </button>
          </div>
        </div>
      )}

      {detail && (
        <Sheet open onClose={() => setDetail(null)} title="Transaktion">
          <TransactionDetail
            tx={detail}
            onCategorise={() => {
              setSheetFor([detail])
              setDetail(null)
            }}
            onClose={() => setDetail(null)}
          />
        </Sheet>
      )}

      {sheetFor && (
        <CategorySheet
          open
          transactions={sheetFor}
          onClose={() => {
            setSheetFor(null)
            setSelection(new Set())
          }}
          onDone={refresh}
        />
      )}
    </Screen>
  )
}

function TransactionDetail({
  tx,
  onCategorise,
  onClose,
}: {
  tx: Transaction
  onCategorise: () => void
  onClose: () => void
}) {
  const { categoriesById, accountsById, refresh } = useAppData()
  const [notes, setNotes] = useState(tx.notes ?? '')
  const category = tx.categoryId ? categoriesById.get(tx.categoryId) : null

  const sourceLabel: Record<string, string> = {
    manual: 'valgt af dig',
    rule: 'via din regel',
    seed: 'genkendt butik',
    learned: 'gættet ud fra dine tidligere valg',
    transfer: 'intern overførsel',
  }

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="tnum text-2xl font-bold">{formatMoney(tx.amountMinor)}</div>
        <div className="mt-1 text-sm">{tx.rawText}</div>
        <dl className="mt-3 space-y-1 text-xs text-ink-500">
          <div className="flex justify-between">
            <dt>Dato</dt>
            <dd>{tx.date}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Konto</dt>
            <dd>{accountsById.get(tx.accountId)?.name ?? '—'}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Kategori</dt>
            <dd>
              {category ? `${category.icon} ${category.name}` : 'Ukategoriseret'}
              {tx.categorySource && ` (${sourceLabel[tx.categorySource] ?? tx.categorySource})`}
            </dd>
          </div>
          {tx.transferGroupId && (
            <div className="flex justify-between">
              <dt>Type</dt>
              <dd>Overførsel mellem egne konti — tælles ikke med</dd>
            </div>
          )}
        </dl>
      </div>

      <div>
        <label className="label" htmlFor="notes">
          Note
        </label>
        <input
          id="notes"
          className="field"
          value={notes}
          placeholder="Fx hvad købet var til"
          onChange={(e) => setNotes(e.target.value)}
          onBlur={async () => {
            if (notes !== (tx.notes ?? '')) {
              await repo.updateTransaction(tx.id, { notes: notes || null })
              await refresh()
            }
          }}
        />
      </div>

      <div className="flex gap-2">
        <button type="button" className="btn-primary flex-1" onClick={onCategorise}>
          Skift kategori
        </button>
        <button type="button" className="btn-secondary" onClick={onClose}>
          Luk
        </button>
      </div>
    </div>
  )
}
