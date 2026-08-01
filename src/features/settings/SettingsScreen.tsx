import { useEffect, useRef, useState } from 'react'
import { formatAmountPlain, formatMoney, parseUserAmount } from '@/lib/money'
import { Banner, Screen, Sheet, Spinner } from '@/app/components'
import { useAccountBalances, useAppData } from '@/app/useAppData'
import * as repo from '@/data/repo'
import type { Account, Category, Rule } from '@/data/types'
import { recategoriseAll } from '@/features/import/runImport'
import { PERIOD_OPTIONS } from '@/features/budget/periodic'

type Panel = 'accounts' | 'categories' | 'rules' | 'data' | null

export function SettingsScreen() {
  const { loading, accounts, categories, transactions, settings, refresh } = useAppData()
  const [panel, setPanel] = useState<Panel>(null)
  const [rules, setRules] = useState<Rule[]>([])
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    void repo.listAllRules().then(setRules)
  }, [panel])

  if (loading) return <Screen title="Indstillinger"><Spinner /></Screen>

  return (
    <Screen title="Indstillinger">
      {message && <Banner tone="success">{message}</Banner>}

      <nav className="card divide-y divide-ink-100 dark:divide-ink-800">
        <Item label="Konti" detail={`${accounts.length}`} onClick={() => setPanel('accounts')} />
        <Item label="Kategorier" detail={`${categories.filter((c) => !c.isSystem).length}`} onClick={() => setPanel('categories')} />
        <Item label="Regler" detail={`${rules.filter((r) => r.source === 'user').length} egne`} onClick={() => setPanel('rules')} />
        <Item label="Data & backup" detail={`${transactions.length} transaktioner`} onClick={() => setPanel('data')} />
      </nav>

      <section className="card space-y-3">
        <h2 className="font-semibold">Budgetberegning</h2>
        <div>
          <label className="label" htmlFor="lookback">
            Måneder der ses tilbage
          </label>
          <select
            id="lookback"
            className="field"
            value={settings?.lookbackMonths ?? 6}
            onChange={async (e) => {
              await repo.updateSettings({ lookbackMonths: Number(e.target.value) })
              await refresh()
            }}
          >
            {[3, 4, 6, 9, 12].map((n) => (
              <option key={n} value={n}>
                {n} måneder
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs text-ink-500">
            Flere måneder giver et roligere budget; færre reagerer hurtigere på ændrede vaner.
          </p>
        </div>
      </section>

      <button
        type="button"
        className="btn-secondary w-full"
        onClick={async () => {
          const count = await recategoriseAll()
          await refresh()
          setMessage(`${count} transaktioner blev kategoriseret igen.`)
        }}
      >
        Kør kategorisering igen
      </button>

      <p className="px-2 text-center text-xs text-ink-500">
        Alle data ligger kun på denne enhed. Intet sendes til en server.
      </p>

      {panel === 'accounts' && <AccountsPanel onClose={() => setPanel(null)} />}
      {panel === 'categories' && <CategoriesPanel onClose={() => setPanel(null)} />}
      {panel === 'rules' && <RulesPanel rules={rules} onClose={() => setPanel(null)} onChanged={setRules} />}
      {panel === 'data' && <DataPanel onClose={() => setPanel(null)} onMessage={setMessage} />}
    </Screen>
  )
}

function Item({ label, detail, onClick }: { label: string; detail: string; onClick: () => void }) {
  return (
    <button type="button" className="flex w-full items-center justify-between py-3.5 text-left" onClick={onClick}>
      <span className="font-medium">{label}</span>
      <span className="text-sm text-ink-500">{detail} ›</span>
    </button>
  )
}

function AccountsPanel({ onClose }: { onClose: () => void }) {
  const { accounts, refresh } = useAppData()
  const balances = useAccountBalances()
  const [editing, setEditing] = useState<Account | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<Account['kind']>('spending')
  const [opening, setOpening] = useState('')

  async function save() {
    const openingMinor = parseUserAmount(opening) ?? 0
    if (editing) {
      await repo.updateAccount(editing.id, { name: name.trim(), kind, openingBalanceMinor: openingMinor })
    } else {
      if (!name.trim()) return
      await repo.createAccount({ name: name.trim(), kind, openingBalanceMinor: openingMinor })
    }
    setEditing(null)
    setAdding(false)
    setName('')
    setOpening('')
    await refresh()
  }

  const showForm = adding || editing !== null

  return (
    <Sheet open onClose={onClose} title="Konti">
      <p className="mb-3 text-sm text-ink-500">
        Konti holder importer adskilt og gør det muligt at genkende overførsler mellem dine egne konti — så de ikke
        tælles med som indkomst og udgift. Budgetter og kategorier er fælles på tværs af konti.
      </p>

      <ul className="mb-3 space-y-2">
        {accounts.map((a) => (
          <li key={a.id} className="card flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate font-medium">{a.name}</div>
              <div className="text-xs text-ink-500">
                {KIND_LABEL[a.kind]} · {formatMoney(balances.get(a.id) ?? 0)}
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                className="text-xs text-ink-500"
                onClick={() => {
                  setEditing(a)
                  setAdding(false)
                  setName(a.name)
                  setKind(a.kind)
                  setOpening(a.openingBalanceMinor ? formatAmountPlain(a.openingBalanceMinor) : '')
                }}
              >
                Ret
              </button>
              <button
                type="button"
                className="text-xs text-red-600"
                onClick={async () => {
                  if (!confirm(`Slet "${a.name}"? Alle transaktioner på kontoen fjernes også.`)) return
                  await repo.deleteAccount(a.id)
                  await refresh()
                }}
              >
                Slet
              </button>
            </div>
          </li>
        ))}
      </ul>

      {showForm ? (
        <div className="card space-y-3">
          <div>
            <label className="label" htmlFor="acc-name">Navn</label>
            <input id="acc-name" className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Fx Fælleskonto" />
          </div>
          <div>
            <label className="label" htmlFor="acc-kind">Type</label>
            <select id="acc-kind" className="field" value={kind} onChange={(e) => setKind(e.target.value as Account['kind'])}>
              {Object.entries(KIND_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="acc-open">Startsaldo</label>
            <input id="acc-open" inputMode="decimal" className="field" value={opening} onChange={(e) => setOpening(e.target.value)} placeholder="0,00" />
            <p className="mt-1 text-xs text-ink-500">Saldoen før den første importerede transaktion.</p>
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-primary flex-1" onClick={save}>Gem</button>
            <button type="button" className="btn-secondary" onClick={() => { setAdding(false); setEditing(null) }}>Annullér</button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn-secondary w-full" onClick={() => { setAdding(true); setName(''); setOpening('') }}>
          + Tilføj konto
        </button>
      )}
    </Sheet>
  )
}

const KIND_LABEL: Record<Account['kind'], string> = {
  budget: 'Budgetkonto',
  spending: 'Forbrugskonto',
  savings: 'Opsparing',
  other: 'Anden konto',
}

function CategoriesPanel({ onClose }: { onClose: () => void }) {
  const { categories, refresh } = useAppData()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<Category['kind']>('expense')
  const [icon, setIcon] = useState('📦')

  return (
    <Sheet open onClose={onClose} title="Kategorier">
      <ul className="mb-3 space-y-1.5">
        {categories.map((c) => (
          <li key={c.id} className="card py-2.5">
            <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden>{c.icon}</span>
              <span className="truncate text-sm">{c.name}</span>
              {c.isSystem && <span className="shrink-0 text-[10px] text-ink-400">SYSTEM</span>}
            </span>
            {!c.isSystem && (
              <button
                type="button"
                className="shrink-0 text-xs text-red-600"
                onClick={async () => {
                  if (!confirm(`Slet "${c.name}"? Transaktioner i kategorien bliver ukategoriserede.`)) return
                  await repo.deleteCategory(c.id)
                  await refresh()
                }}
              >
                Slet
              </button>
            )}
            </div>
            {/* Periodic bills are budgeted as a full period's cost and set
                aside monthly, so the interval belongs with the category. */}
            {!c.isSystem && c.kind === 'expense' && (
              <label className="mt-2 flex items-center gap-2 text-xs text-ink-500">
                Betales
                <select
                  className="rounded-lg border border-ink-200 bg-white px-2 py-1 text-xs dark:border-ink-700 dark:bg-ink-800"
                  value={c.periodMonths ?? 1}
                  onChange={async (e) => {
                    const v = Number(e.target.value)
                    await repo.updateCategory(c.id, { periodMonths: v === 1 ? null : v })
                    await refresh()
                  }}
                >
                  {PERIOD_OPTIONS.map((o) => (
                    <option key={o.months} value={o.months}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </li>
        ))}
      </ul>

      <div className="card space-y-3">
        <h3 className="font-semibold">Ny kategori</h3>
        <div className="flex gap-2">
          <input
            className="field w-16 text-center"
            value={icon}
            onChange={(e) => setIcon(e.target.value.slice(0, 2))}
            aria-label="Ikon"
          />
          <input className="field flex-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="Navn" />
        </div>
        <select className="field" value={kind} onChange={(e) => setKind(e.target.value as Category['kind'])}>
          <option value="expense">Udgift</option>
          <option value="income">Indkomst</option>
          <option value="savings">Opsparing</option>
        </select>
        <button
          type="button"
          className="btn-primary w-full"
          disabled={!name.trim()}
          onClick={async () => {
            await repo.createCategory({ name: name.trim(), kind, icon })
            setName('')
            await refresh()
          }}
        >
          Tilføj
        </button>
      </div>
    </Sheet>
  )
}

function RulesPanel({
  rules,
  onClose,
  onChanged,
}: {
  rules: Rule[]
  onClose: () => void
  onChanged: (rules: Rule[]) => void
}) {
  const { categoriesById, refresh } = useAppData()
  const [showSeed, setShowSeed] = useState(false)

  const userRules = rules.filter((r) => r.source === 'user')
  const seedRules = rules.filter((r) => r.source === 'seed')
  const shown = showSeed ? [...userRules, ...seedRules] : userRules

  async function remove(id: string) {
    await repo.deleteRule(id)
    onChanged(await repo.listAllRules())
    await refresh()
  }

  return (
    <Sheet open onClose={onClose} title="Regler">
      <p className="mb-3 text-sm text-ink-500">
        Regler kategoriserer automatisk. Dine egne regler vinder altid over de indbyggede.
      </p>

      {userRules.length === 0 && !showSeed && (
        <Banner tone="info">
          Du har ingen egne regler endnu. De oprettes når du kategoriserer en transaktion og siger ja til at huske
          valget.
        </Banner>
      )}

      <ul className="my-3 space-y-1.5">
        {shown.map((r) => (
          <li key={r.id} className="card flex items-center justify-between gap-2 py-2.5">
            <span className="min-w-0">
              <span className="block truncate text-sm">
                «{r.pattern}» → {categoriesById.get(r.categoryId)?.name ?? '?'}
              </span>
              <span className="text-xs text-ink-500">
                {r.source === 'user' ? 'din regel' : 'indbygget'}
                {r.hitCount > 0 && ` · brugt ${r.hitCount}×`}
              </span>
            </span>
            <button type="button" className="shrink-0 text-xs text-red-600" onClick={() => remove(r.id)}>
              Slet
            </button>
          </li>
        ))}
      </ul>

      <button type="button" className="btn-secondary w-full" onClick={() => setShowSeed((s) => !s)}>
        {showSeed ? 'Skjul indbyggede regler' : `Vis ${seedRules.length} indbyggede regler`}
      </button>
    </Sheet>
  )
}

function DataPanel({ onClose, onMessage }: { onClose: () => void; onMessage: (m: string) => void }) {
  const { refresh, transactions } = useAppData()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  async function doExport() {
    const backup = await repo.exportBackup()
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `budget-backup-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function doImport(file: File) {
    if (!confirm('Dette erstatter ALLE data på denne enhed med indholdet af backupfilen. Fortsæt?')) return
    setBusy(true)
    try {
      const text = await file.text()
      await repo.importBackup(JSON.parse(text))
      await refresh()
      onMessage('Backup gendannet.')
      onClose()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Kunne ikke læse backupfilen.')
    }
    setBusy(false)
  }

  return (
    <Sheet open onClose={onClose} title="Data & backup">
      <Banner tone="info">
        Dine data ligger kun i denne browser på denne enhed. Tag en backup jævnligt — og før du skifter telefon.
      </Banner>

      <div className="mt-3 space-y-2">
        <button type="button" className="btn-primary w-full" onClick={doExport} disabled={busy}>
          Gem backup ({transactions.length} transaktioner)
        </button>

        <button type="button" className="btn-secondary w-full" onClick={() => fileRef.current?.click()} disabled={busy}>
          Gendan fra backup
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void doImport(f)
          }}
        />

        <button
          type="button"
          className="btn-danger w-full"
          disabled={busy}
          onClick={async () => {
            if (!confirm('Slet ALT: transaktioner, budgetter, regler og konti. Kan ikke fortrydes. Er du sikker?')) return
            if (!confirm('Helt sikker? Tag en backup først hvis du er i tvivl.')) return
            setBusy(true)
            await repo.clearAllData()
            await refresh()
            setBusy(false)
            onMessage('Alle data er slettet.')
            onClose()
          }}
        >
          Slet alle data
        </button>
      </div>
    </Sheet>
  )
}
