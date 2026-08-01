import { useMemo, useState } from 'react'
import { Sheet } from '@/app/components'
import { useAppData } from '@/app/useAppData'
import * as repo from '@/data/repo'
import { applyRuleRetroactively } from '@/features/import/runImport'
import type { Transaction } from '@/data/types'
import { suggestRulePattern } from './engine'

/**
 * Category picker. After a single-transaction assignment it offers to turn the
 * choice into a rule — this is the main way the app learns, and doing it at the
 * moment of correction is the only time the user has the context to say yes.
 */
export function CategorySheet({
  open,
  onClose,
  transactions,
  onDone,
}: {
  open: boolean
  onClose: () => void
  transactions: Transaction[]
  onDone: () => Promise<void>
}) {
  const { categories } = useAppData()
  const [pendingRule, setPendingRule] = useState<{ pattern: string; categoryId: string; categoryName: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const grouped = useMemo(() => {
    const live = categories.filter((c) => !c.archived)
    return {
      expense: live.filter((c) => c.kind === 'expense'),
      income: live.filter((c) => c.kind === 'income'),
      other: live.filter((c) => c.kind === 'savings' || c.kind === 'transfer'),
    }
  }, [categories])

  const single = transactions.length === 1 ? transactions[0] : null

  async function choose(categoryId: string, categoryName: string) {
    setBusy(true)
    await repo.setCategory(transactions.map((t) => t.id), categoryId, 'manual')

    // Only offer a rule for a single transaction — in a bulk assignment the
    // shared pattern is rarely what the user actually meant.
    const pattern = single ? suggestRulePattern(single.rawText) : null
    if (pattern) {
      setPendingRule({ pattern, categoryId, categoryName })
      setBusy(false)
      await onDone()
      return
    }

    setBusy(false)
    await onDone()
    onClose()
  }

  async function createRule() {
    if (!pendingRule) return
    setBusy(true)
    await repo.createRule({ pattern: pendingRule.pattern, categoryId: pendingRule.categoryId })
    const count = await applyRuleRetroactively(pendingRule.pattern, pendingRule.categoryId)
    setBusy(false)
    setResult(
      count > 0
        ? `Regel oprettet — ${count} tidligere transaktion${count === 1 ? '' : 'er'} blev også opdateret.`
        : 'Regel oprettet.',
    )
    setPendingRule(null)
    await onDone()
  }

  function dismiss() {
    setPendingRule(null)
    setResult(null)
    onClose()
  }

  if (pendingRule) {
    return (
      <Sheet open={open} onClose={dismiss} title="Skal jeg huske det?">
        <p className="mb-4 text-sm text-ink-600 dark:text-ink-400">
          Vil du altid kategorisere transaktioner der indeholder{' '}
          <strong className="text-ink-900 dark:text-ink-100">«{pendingRule.pattern}»</strong> som{' '}
          <strong className="text-ink-900 dark:text-ink-100">{pendingRule.categoryName}</strong>?
        </p>
        <div className="flex gap-2">
          <button type="button" className="btn-primary flex-1" onClick={createRule} disabled={busy}>
            Ja, husk det
          </button>
          <button type="button" className="btn-secondary flex-1" onClick={dismiss} disabled={busy}>
            Kun denne
          </button>
        </div>
      </Sheet>
    )
  }

  if (result) {
    return (
      <Sheet open={open} onClose={dismiss} title="Færdig">
        <p className="mb-4 text-sm text-ink-600 dark:text-ink-400">{result}</p>
        <button type="button" className="btn-primary w-full" onClick={dismiss}>
          OK
        </button>
      </Sheet>
    )
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={transactions.length === 1 ? 'Vælg kategori' : `Kategorisér ${transactions.length} transaktioner`}
    >
      {single && (
        <div className="mb-4 rounded-xl bg-white p-3 text-sm dark:bg-ink-900">
          <div className="font-medium">{single.rawText}</div>
          {single.merchantKey && <div className="mt-0.5 text-xs text-ink-500">nøgle: {single.merchantKey}</div>}
        </div>
      )}

      <div className="space-y-4">
        <CategoryGroup label="Udgifter" categories={grouped.expense} onPick={choose} disabled={busy} />
        <CategoryGroup label="Indkomst" categories={grouped.income} onPick={choose} disabled={busy} />
        <CategoryGroup label="Andet" categories={grouped.other} onPick={choose} disabled={busy} />

        <button
          type="button"
          className="btn-ghost w-full"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            await repo.setCategory(transactions.map((t) => t.id), null)
            setBusy(false)
            await onDone()
            onClose()
          }}
        >
          Fjern kategori
        </button>
      </div>
    </Sheet>
  )
}

function CategoryGroup({
  label,
  categories,
  onPick,
  disabled,
}: {
  label: string
  categories: Array<{ id: string; name: string; icon: string; color: string }>
  onPick: (id: string, name: string) => void
  disabled: boolean
}) {
  if (categories.length === 0) return null
  return (
    <div>
      <div className="label">{label}</div>
      <div className="grid grid-cols-2 gap-2">
        {categories.map((c) => (
          <button
            key={c.id}
            type="button"
            disabled={disabled}
            onClick={() => onPick(c.id, c.name)}
            className="flex items-center gap-2 rounded-xl bg-white px-3 py-3 text-left text-sm font-medium
                       transition active:scale-[0.98] disabled:opacity-50 dark:bg-ink-900"
          >
            <span aria-hidden>{c.icon}</span>
            <span className="truncate">{c.name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
