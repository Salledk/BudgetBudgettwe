import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { formatAmountPlain, formatMoney, parseUserAmount } from '@/lib/money'
import { Banner, Screen, Sheet, Spinner } from '@/app/components'
import { useAccountBalances, useAppData } from '@/app/useAppData'
import * as repo from '@/data/repo'
import type { Account, Category, Rule } from '@/data/types'
import { recategoriseAll } from '@/features/import/runImport'
import { PERIOD_OPTIONS, isPeriodic } from '@/features/budget/periodic'

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

const CATEGORY_KINDS: Array<{ value: Category['kind']; label: string }> = [
  { value: 'expense', label: 'Udgift' },
  { value: 'income', label: 'Indkomst' },
  { value: 'savings', label: 'Opsparing' },
]

/**
 * Income and expense answer different questions, so each gets its own heading
 * rather than sharing one undifferentiated list. Transfers and savings sit
 * together at the end: neither is money you budget.
 */
const CATEGORY_GROUPS: Array<{ key: string; label: string; kinds: Array<Category['kind']> }> = [
  { key: 'income', label: 'Indkomst', kinds: ['income'] },
  { key: 'expense', label: 'Udgifter', kinds: ['expense'] },
  { key: 'other', label: 'Andre', kinds: ['savings', 'transfer'] },
]

function groupKeyOf(kind: Category['kind']): string {
  return CATEGORY_GROUPS.find((g) => g.kinds.includes(kind))?.key ?? 'other'
}

/** Same wording the budget screen uses, so one setting reads the same in both. */
function periodicBadge(c: Category): string | null {
  if (!isPeriodic(c)) return null
  return c.periodMonths === 12 ? 'ÅRLIG' : c.periodMonths === 3 ? 'KVARTAL' : 'PERIODISK'
}

interface CategoryDraft {
  name: string
  icon: string
  kind: Category['kind']
  periodMonths: number | null
}

/**
 * The new display order after dragging `activeId` onto `overId`, or null when
 * the move is not allowed.
 *
 * Kept separate from the drag handler because this is the part with a rule in
 * it — a drop across a heading would change what the category *is*, which is
 * the editor's job, not the drag handle's — and because pointer and keyboard
 * dragging both depend on layout measurement that jsdom cannot provide.
 */
export function reorderWithinGroup(
  categories: Category[],
  activeId: string,
  overId: string,
): string[] | null {
  if (activeId === overId) return null

  const byId = new Map(categories.map((c) => [c.id, c]))
  const from = byId.get(activeId)
  const to = byId.get(overId)
  if (!from || !to) return null
  if (from.isSystem || to.isSystem) return null
  if (groupKeyOf(from.kind) !== groupKeyOf(to.kind)) return null

  const ids = categories.map((c) => c.id)
  return arrayMove(ids, ids.indexOf(activeId), ids.indexOf(overId))
}

function CategoriesPanel({ onClose }: { onClose: () => void }) {
  const { categories, refresh } = useAppData()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<Category['kind']>('expense')
  const [icon, setIcon] = useState('📦')

  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<CategoryDraft>({
    name: '',
    icon: '',
    kind: 'expense',
    periodMonths: null,
  })

  // Holds the new order between the drop and the reload, so a dragged row does
  // not snap back to where it came from for a frame.
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null)

  const ordered = useMemo(() => {
    if (!pendingOrder) return categories
    const rank = new Map(pendingOrder.map((id, i) => [id, i]))
    return [...categories].sort(
      (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    )
  }, [categories, pendingOrder])

  const sensors = useSensors(
    // A short press before a drag begins, so tapping a row still opens the
    // editor and a vertical swipe still scrolls the sheet.
    useSensor(PointerSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function startEdit(c: Category) {
    setEditing(c.id)
    setDraft({ name: c.name, icon: c.icon, kind: c.kind, periodMonths: c.periodMonths ?? null })
  }

  async function saveEdit(c: Category) {
    const trimmed = draft.name.trim()
    if (!trimmed) return
    const kindNow = c.isSystem ? c.kind : draft.kind
    await repo.updateCategory(c.id, {
      name: trimmed,
      icon: draft.icon.trim() || c.icon,
      // A system category's kind drives how transfers are excluded from every
      // total, so it stays fixed even while its label can be changed.
      kind: kindNow,
      // Only an expense has a bill to spread, so moving a category out of
      // Udgift clears the interval rather than leaving it set but inert.
      periodMonths: kindNow === 'expense' ? draft.periodMonths : null,
    })
    setEditing(null)
    await refresh()
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over) return

    const next = reorderWithinGroup(ordered, String(active.id), String(over.id))
    if (!next) return

    setPendingOrder(next)
    await repo.reorderCategories(next)
    await refresh()
    setPendingOrder(null)
  }

  async function remove(c: Category) {
    if (!confirm(`Slet "${c.name}"? Transaktioner i kategorien bliver ukategoriserede.`)) return
    await repo.deleteCategory(c.id)
    await refresh()
  }

  return (
    <Sheet open onClose={onClose} title="Kategorier">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={(e) => void handleDragEnd(e)}
      >
        {CATEGORY_GROUPS.map((group) => {
          const rows = ordered.filter((c) => group.kinds.includes(c.kind))
          if (rows.length === 0) return null
          return (
            <section key={group.key} className="mb-4">
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400">
                {group.label}
              </h3>
              <SortableContext items={rows.map((c) => c.id)} strategy={verticalListSortingStrategy}>
                <ul className="space-y-1.5">
                  {rows.map((c) => (
                    <CategoryRow
                      key={c.id}
                      category={c}
                      editing={editing === c.id}
                      draft={draft}
                      setDraft={setDraft}
                      onToggle={() => (editing === c.id ? setEditing(null) : startEdit(c))}
                      onSave={() => void saveEdit(c)}
                      onCancel={() => setEditing(null)}
                      onDelete={() => void remove(c)}
                    />
                  ))}
                </ul>
              </SortableContext>
            </section>
          )
        })}
      </DndContext>

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
          {CATEGORY_KINDS.map((k) => (
            <option key={k.value} value={k.value}>{k.label}</option>
          ))}
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

function CategoryRow({
  category: c,
  editing,
  draft,
  setDraft,
  onToggle,
  onSave,
  onCancel,
  onDelete,
}: {
  category: Category
  editing: boolean
  draft: CategoryDraft
  setDraft: React.Dispatch<React.SetStateAction<CategoryDraft>>
  onToggle: () => void
  onSave: () => void
  onCancel: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: c.id,
    disabled: c.isSystem,
  })
  const badge = periodicBadge(c)

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`card py-2.5 ${isDragging ? 'relative z-10 opacity-80 shadow-lg' : ''}`}
    >
      <div className="flex items-center justify-between gap-2">
        {!c.isSystem && (
          <button
            type="button"
            // touch-none keeps the drag from fighting the sheet's scrolling.
            className="shrink-0 cursor-grab touch-none px-1 text-ink-300"
            aria-label={`Flyt ${c.name}`}
            {...attributes}
            {...listeners}
          >
            ⠿
          </button>
        )}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          // Labelled with the name alone so the badges below stay out of the
          // accessible name.
          aria-label={c.name}
          onClick={onToggle}
        >
          <span aria-hidden>{c.icon}</span>
          <span className="truncate text-sm">{c.name}</span>
          {c.isSystem && <span className="shrink-0 text-[10px] text-ink-400">SYSTEM</span>}
          {badge && <span className="shrink-0 text-[10px] text-ink-400">{badge}</span>}
        </button>
        {!c.isSystem && (
          <button type="button" className="shrink-0 text-xs text-red-600" onClick={onDelete}>
            Slet
          </button>
        )}
      </div>

      {editing && (
        <div className="mt-2 space-y-2">
          <div className="flex gap-2">
            <input
              className="field w-16 text-center"
              value={draft.icon}
              aria-label="Ikon"
              onChange={(e) => setDraft((d) => ({ ...d, icon: e.target.value.slice(0, 2) }))}
            />
            <input
              autoFocus
              className="field flex-1"
              value={draft.name}
              aria-label={`Navn på ${c.name}`}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSave()
                if (e.key === 'Escape') onCancel()
              }}
            />
          </div>
          {!c.isSystem && (
            <select
              className="field"
              value={draft.kind}
              aria-label="Type"
              onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value as Category['kind'] }))}
            >
              {CATEGORY_KINDS.map((k) => (
                <option key={k.value} value={k.value}>{k.label}</option>
              ))}
            </select>
          )}
          {!c.isSystem && draft.kind !== c.kind && (
            <p className="text-xs text-amber-600">
              Skifter du type, flytter kategoriens transaktioner mellem indkomst og udgift.
            </p>
          )}

          {/* Only an expense has a recurring bill to spread. Reading the staged
              kind rather than the saved one means switching to Udgift reveals
              this straight away, without a save-and-reopen. */}
          {!c.isSystem && draft.kind === 'expense' && (
            <>
              <label className="flex items-center gap-2 text-xs text-ink-500">
                Betales
                <select
                  className="rounded-lg border border-ink-200 bg-white px-2 py-1 text-xs dark:border-ink-700 dark:bg-ink-800"
                  aria-label="Betales"
                  value={draft.periodMonths ?? 1}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    setDraft((d) => ({ ...d, periodMonths: v === 1 ? null : v }))
                  }}
                >
                  {PERIOD_OPTIONS.map((o) => (
                    <option key={o.months} value={o.months}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              {draft.periodMonths !== null && draft.periodMonths > 1 && (
                <p className="text-xs text-ink-500">
                  Budgettet er hele regningen — der sættes 1/{draft.periodMonths} til side hver måned.
                </p>
              )}
            </>
          )}

          <div className="flex gap-2">
            <button type="button" className="btn-primary flex-1" onClick={onSave}>
              Gem
            </button>
            <button type="button" className="btn-ghost" onClick={onCancel}>
              Fortryd
            </button>
          </div>
        </div>
      )}
    </li>
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
  const { categories, categoriesById, refresh } = useAppData()
  const [showSeed, setShowSeed] = useState(false)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState({ pattern: '', categoryId: '', matchType: 'contains' as Rule['matchType'] })
  const [adding, setAdding] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const assignable = categories.filter((c) => !c.archived)

  const userRules = rules.filter((r) => r.source === 'user')
  const seedRules = rules.filter((r) => r.source === 'seed')
  const q = search.trim().toLowerCase()
  const shown = (showSeed || q ? [...userRules, ...seedRules] : userRules).filter(
    (r) =>
      !q ||
      r.pattern.toLowerCase().includes(q) ||
      (categoriesById.get(r.categoryId)?.name ?? '').toLowerCase().includes(q),
  )

  /**
   * Rules only matter through the transactions they touch, so every change is
   * followed by a re-run. Manual choices are left alone by design.
   */
  async function applyAndReport(action: () => Promise<void>) {
    setBusy(true)
    await action()
    const changed = await recategoriseAll()
    onChanged(await repo.listAllRules())
    await refresh()
    setBusy(false)
    setNote(`${changed} transaktion${changed === 1 ? '' : 'er'} blev kategoriseret igen.`)
  }

  function startEdit(r: Rule) {
    setAdding(false)
    setEditing(r.id)
    setDraft({ pattern: r.pattern, categoryId: r.categoryId, matchType: r.matchType })
  }

  function startAdd() {
    setEditing(null)
    setAdding(true)
    setDraft({ pattern: '', categoryId: assignable[0]?.id ?? '', matchType: 'contains' })
  }

  const draftValid = draft.pattern.trim().length >= 2 && draft.categoryId !== ''

  return (
    <Sheet open onClose={onClose} title="Regler">
      <p className="mb-3 text-sm text-ink-500">
        Regler kategoriserer automatisk. Dine egne regler vinder altid over de indbyggede.
      </p>

      {note && <Banner tone="success">{note}</Banner>}

      {userRules.length === 0 && !showSeed && !q && (
        <Banner tone="info">
          Du har ingen egne regler endnu. De oprettes når du kategoriserer en transaktion og siger ja til at huske
          valget — eller lav en her.
        </Banner>
      )}

      <input
        type="search"
        className="field my-3"
        placeholder="Søg i regler…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {(adding || editing) && (
        <div className="card mb-3 space-y-3">
          <h3 className="font-semibold">{adding ? 'Ny regel' : 'Ret regel'}</h3>
          <div>
            <label className="label" htmlFor="rule-pattern">Tekst der skal matches</label>
            <input
              id="rule-pattern"
              autoFocus
              className="field"
              value={draft.pattern}
              placeholder="fx netto"
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setDraft((d) => ({ ...d, pattern: e.target.value }))}
            />
            <p className="mt-1 text-xs text-ink-500">
              Matcher fra starten af et ord, så «netto» rammer «NETTO 1234» men ikke «minetto».
            </p>
          </div>
          <div>
            <label className="label" htmlFor="rule-cat">Kategori</label>
            <select
              id="rule-cat"
              className="field"
              value={draft.categoryId}
              onChange={(e) => setDraft((d) => ({ ...d, categoryId: e.target.value }))}
            >
              {assignable.map((c) => (
                <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="rule-match">Match</label>
            <select
              id="rule-match"
              className="field"
              value={draft.matchType}
              onChange={(e) => setDraft((d) => ({ ...d, matchType: e.target.value as Rule['matchType'] }))}
            >
              <option value="contains">Indeholder teksten</option>
              <option value="exact">Præcis denne butik</option>
              <option value="regex">Regulært udtryk</option>
            </select>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-primary flex-1"
              disabled={!draftValid || busy}
              onClick={() =>
                void applyAndReport(async () => {
                  if (adding) {
                    await repo.createRule({
                      pattern: draft.pattern,
                      categoryId: draft.categoryId,
                      matchType: draft.matchType,
                    })
                  } else if (editing) {
                    await repo.updateRule(editing, {
                      pattern: draft.pattern.trim().toLowerCase(),
                      categoryId: draft.categoryId,
                      matchType: draft.matchType,
                    })
                  }
                  setEditing(null)
                  setAdding(false)
                })
              }
            >
              {busy ? 'Arbejder…' : 'Gem'}
            </button>
            <button type="button" className="btn-ghost" onClick={() => { setEditing(null); setAdding(false) }}>
              Fortryd
            </button>
          </div>
        </div>
      )}

      <ul className="my-3 space-y-1.5">
        {shown.map((r) => (
          <li key={r.id} className="card py-2.5">
            <div className="flex items-center justify-between gap-2">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => startEdit(r)}>
                <span className="block truncate text-sm">
                  «{r.pattern}» → {categoriesById.get(r.categoryId)?.name ?? '?'}
                </span>
                <span className="text-xs text-ink-500">
                  {r.source === 'user' ? 'din regel' : 'indbygget'}
                  {r.matchType !== 'contains' && ` · ${r.matchType}`}
                  {r.hitCount > 0 && ` · brugt ${r.hitCount}×`}
                </span>
              </button>
              <button
                type="button"
                className="shrink-0 text-xs text-red-600"
                disabled={busy}
                onClick={() => void applyAndReport(() => repo.deleteRule(r.id))}
              >
                Slet
              </button>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex gap-2">
        <button type="button" className="btn-primary flex-1" onClick={startAdd} disabled={busy}>
          + Ny regel
        </button>
        <button type="button" className="btn-secondary" onClick={() => setShowSeed((s) => !s)}>
          {showSeed || q ? 'Skjul indbyggede' : `Vis ${seedRules.length} indbyggede`}
        </button>
      </div>
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
