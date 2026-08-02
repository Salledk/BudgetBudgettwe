import { db, isLive } from './db'
import { newId } from '@/lib/id'
import { monthOf, type IsoMonth } from '@/lib/dates'
import { buildSeedAccounts, buildSeedCategories, buildSeedRules } from './seed'
import { DEFAULT_BUDGET_MONTH, DEFAULT_SETTINGS, type Account, type BankProfile, type Budget, type Category, type ImportBatch, type ResolvedBudget, type Rule, type Settings, type Transaction } from './types'

/**
 * The only module that talks to Dexie. Components and features call these
 * functions, so replacing IndexedDB with a synced backend later is a change
 * to this file rather than to every screen.
 */

const SETTINGS_ID = 'singleton'

function now(): number {
  return Date.now()
}

/** Adds id/updatedAt/deletedAt to a record being created. */
function create<T extends object>(data: T): T & { id: string; updatedAt: number; deletedAt: null } {
  return { ...data, id: newId(), updatedAt: now(), deletedAt: null }
}

// ---------------------------------------------------------------- bootstrap

/**
 * Populates categories, rules, accounts and settings on first run.
 * Idempotent — safe to call on every app start.
 */
export async function ensureSeeded(): Promise<void> {
  const existing = await db.categories.count()
  if (existing > 0) {
    await ensureSettings()
    return
  }

  const ts = now()
  const categories = buildSeedCategories(ts)
  const rules = buildSeedRules(categories, ts)
  const accounts = buildSeedAccounts(ts)

  await db.transaction('rw', db.categories, db.rules, db.accounts, db.settings, async () => {
    await db.categories.bulkPut(categories)
    await db.rules.bulkPut(rules)
    await db.accounts.bulkPut(accounts)
    await ensureSettings()
  })
}

async function ensureSettings(): Promise<Settings> {
  const existing = await db.settings.get(SETTINGS_ID)
  if (existing) return existing
  const settings: Settings = { ...DEFAULT_SETTINGS, id: SETTINGS_ID, updatedAt: now(), deletedAt: null }
  await db.settings.put(settings)
  return settings
}

export async function getSettings(): Promise<Settings> {
  return ensureSettings()
}

export async function updateSettings(patch: Partial<Omit<Settings, 'id'>>): Promise<Settings> {
  const current = await ensureSettings()
  const next = { ...current, ...patch, updatedAt: now() }
  await db.settings.put(next)
  return next
}

// ----------------------------------------------------------------- accounts

export async function listAccounts(): Promise<Account[]> {
  const all = await db.accounts.toArray()
  return all.filter(isLive).sort((a, b) => a.sortOrder - b.sortOrder)
}

export async function getAccount(id: string): Promise<Account | undefined> {
  const a = await db.accounts.get(id)
  return a && isLive(a) ? a : undefined
}

export async function createAccount(data: {
  name: string
  kind: Account['kind']
  openingBalanceMinor?: number
  accountNumber?: string | null
}): Promise<Account> {
  const accounts = await listAccounts()
  const account = create({
    name: data.name,
    kind: data.kind,
    openingBalanceMinor: data.openingBalanceMinor ?? 0,
    accountNumber: data.accountNumber ?? null,
    archived: false,
    sortOrder: (accounts.at(-1)?.sortOrder ?? 0) + 10,
  }) as Account
  await db.accounts.put(account)
  return account
}

export async function updateAccount(id: string, patch: Partial<Account>): Promise<void> {
  const current = await db.accounts.get(id)
  if (!current) return
  await db.accounts.put({ ...current, ...patch, id, updatedAt: now() })
}

/**
 * Soft-deletes an account and everything imported into it. Transactions are
 * removed too — leaving them orphaned would silently corrupt every total.
 */
export async function deleteAccount(id: string): Promise<void> {
  const ts = now()
  await db.transaction('rw', db.accounts, db.transactions, async () => {
    const account = await db.accounts.get(id)
    if (account) await db.accounts.put({ ...account, deletedAt: ts, updatedAt: ts })
    const txs = await db.transactions.where('accountId').equals(id).toArray()
    await db.transactions.bulkPut(txs.map((t) => ({ ...t, deletedAt: ts, updatedAt: ts })))
  })
}

// --------------------------------------------------------------- categories

export async function listCategories(): Promise<Category[]> {
  const all = await db.categories.toArray()
  return all.filter(isLive).sort((a, b) => a.sortOrder - b.sortOrder)
}

/** Categories a user can budget against — excludes transfers and archived. */
export async function listBudgetableCategories(): Promise<Category[]> {
  const all = await listCategories()
  return all.filter((c) => !c.archived && c.kind !== 'transfer')
}

export async function createCategory(data: {
  name: string
  kind: Category['kind']
  icon?: string
  color?: string
  periodMonths?: number | null
}): Promise<Category> {
  const categories = await listCategories()
  const category = create({
    name: data.name,
    kind: data.kind,
    parentId: null,
    icon: data.icon ?? '📦',
    color: data.color ?? '#64748b',
    isSystem: false,
    archived: false,
    periodMonths: data.periodMonths ?? null,
    sortOrder: (categories.at(-1)?.sortOrder ?? 0) + 10,
  }) as Category
  await db.categories.put(category)
  return category
}

export async function updateCategory(id: string, patch: Partial<Category>): Promise<void> {
  const current = await db.categories.get(id)
  if (!current) return
  await db.categories.put({ ...current, ...patch, id, updatedAt: now() })
}

/**
 * Soft-deletes a category. Transactions and rules pointing at it are reset to
 * uncategorised rather than left dangling, so nothing disappears from totals
 * into a category that no longer exists.
 */
export async function deleteCategory(id: string): Promise<void> {
  const category = await db.categories.get(id)
  if (!category || category.isSystem) return
  const ts = now()

  await db.transaction('rw', db.categories, db.transactions, db.rules, db.budgets, async () => {
    await db.categories.put({ ...category, deletedAt: ts, updatedAt: ts })

    const txs = await db.transactions.where('categoryId').equals(id).toArray()
    await db.transactions.bulkPut(
      txs.map((t) => ({ ...t, categoryId: null, categorySource: null, reviewed: false, updatedAt: ts })),
    )

    const rules = await db.rules.where('categoryId').equals(id).toArray()
    await db.rules.bulkPut(rules.map((r) => ({ ...r, deletedAt: ts, updatedAt: ts })))

    const budgets = await db.budgets.where('categoryId').equals(id).toArray()
    await db.budgets.bulkPut(budgets.map((b) => ({ ...b, deletedAt: ts, updatedAt: ts })))
  })
}

// -------------------------------------------------------------- transactions

export async function listTransactions(filter: {
  accountId?: string
  month?: IsoMonth
  from?: string
  to?: string
  categoryId?: string | null
  uncategorisedOnly?: boolean
  needsReview?: boolean
  search?: string
  includeTransfers?: boolean
} = {}): Promise<Transaction[]> {
  let rows: Transaction[]

  if (filter.accountId) {
    rows = await db.transactions.where('accountId').equals(filter.accountId).toArray()
  } else if (filter.month) {
    rows = await db.transactions.where('date').between(`${filter.month}-00`, `${filter.month}-99`).toArray()
  } else if (filter.from && filter.to) {
    rows = await db.transactions.where('date').between(filter.from, filter.to, true, true).toArray()
  } else {
    rows = await db.transactions.toArray()
  }

  rows = rows.filter(isLive)

  if (filter.month) rows = rows.filter((t) => monthOf(t.date) === filter.month)
  if (filter.from) rows = rows.filter((t) => t.date >= filter.from!)
  if (filter.to) rows = rows.filter((t) => t.date <= filter.to!)
  if (filter.categoryId !== undefined) rows = rows.filter((t) => t.categoryId === filter.categoryId)
  if (filter.uncategorisedOnly) rows = rows.filter((t) => t.categoryId === null)
  if (filter.needsReview) rows = rows.filter((t) => t.categorySource === 'learned' && !t.reviewed)
  if (filter.includeTransfers === false) rows = rows.filter((t) => t.transferGroupId === null)

  if (filter.search) {
    const q = filter.search.toLowerCase()
    rows = rows.filter((t) => t.rawText.toLowerCase().includes(q) || (t.notes ?? '').toLowerCase().includes(q))
  }

  // Newest first, stable on same-day rows via id (which is time-sortable).
  return rows.sort((a, b) => (a.date === b.date ? b.id.localeCompare(a.id) : b.date.localeCompare(a.date)))
}

export async function getTransaction(id: string): Promise<Transaction | undefined> {
  const t = await db.transactions.get(id)
  return t && isLive(t) ? t : undefined
}

export async function putTransactions(txs: Transaction[]): Promise<void> {
  await db.transactions.bulkPut(txs)
}

export async function setCategory(
  transactionIds: string[],
  categoryId: string | null,
  source: Transaction['categorySource'] = 'manual',
): Promise<void> {
  const ts = now()
  const txs = (await db.transactions.bulkGet(transactionIds)).filter((t): t is Transaction => !!t)
  await db.transactions.bulkPut(
    txs.map((t) => ({ ...t, categoryId, categorySource: categoryId ? source : null, reviewed: true, updatedAt: ts })),
  )
}

/** Marks learned suggestions as accepted without changing the category. */
export async function markReviewed(transactionIds: string[]): Promise<void> {
  const ts = now()
  const txs = (await db.transactions.bulkGet(transactionIds)).filter((t): t is Transaction => !!t)
  await db.transactions.bulkPut(txs.map((t) => ({ ...t, reviewed: true, updatedAt: ts })))
}

export async function updateTransaction(id: string, patch: Partial<Transaction>): Promise<void> {
  const current = await db.transactions.get(id)
  if (!current) return
  await db.transactions.put({ ...current, ...patch, id, updatedAt: now() })
}

/**
 * Every fingerprint already stored for an account — the import path's
 * duplicate check.
 *
 * Returns the union of each transaction's keys rather than just its primary
 * one, so a purchase can be recognised by its id, its transaction date or its
 * posting date. Rows written before multiple keys existed only have
 * `dedupHash`, which still works.
 */
export async function existingDedupHashes(accountId: string): Promise<Set<string>> {
  const rows = await db.transactions.where('accountId').equals(accountId).toArray()
  const keys = new Set<string>()
  for (const t of rows) {
    if (!isLive(t)) continue
    for (const k of t.dedupKeys ?? [t.dedupHash]) keys.add(k)
  }
  return keys
}

/** Distinct merchant keys with a user-confirmed category — feeds the learned layer. */
export async function categorisedByMerchant(): Promise<Map<string, Map<string, number>>> {
  const rows = await db.transactions.toArray()
  const out = new Map<string, Map<string, number>>()
  for (const t of rows) {
    if (!isLive(t) || !t.categoryId || !t.merchantKey) continue
    // Only user-confirmed assignments teach; otherwise the model reinforces itself.
    if (t.categorySource !== 'manual' && t.categorySource !== 'rule') continue
    const counts = out.get(t.merchantKey) ?? new Map<string, number>()
    counts.set(t.categoryId, (counts.get(t.categoryId) ?? 0) + 1)
    out.set(t.merchantKey, counts)
  }
  return out
}

export async function earliestTransactionDate(): Promise<string | null> {
  const rows = await db.transactions.orderBy('date').toArray()
  const live = rows.filter(isLive)
  return live[0]?.date ?? null
}

// -------------------------------------------------------------------- rules

export async function listRules(): Promise<Rule[]> {
  const all = await db.rules.toArray()
  return all
    .filter(isLive)
    .filter((r) => r.enabled)
    // Highest priority first; longer patterns beat shorter ones at equal priority.
    .sort((a, b) => b.priority - a.priority || b.pattern.length - a.pattern.length)
}

export async function listAllRules(): Promise<Rule[]> {
  const all = await db.rules.toArray()
  return all.filter(isLive).sort((a, b) => b.priority - a.priority)
}

export async function createRule(data: {
  pattern: string
  categoryId: string
  matchType?: Rule['matchType']
  priority?: number
}): Promise<Rule> {
  const rule = create({
    pattern: data.pattern.trim().toLowerCase(),
    matchType: data.matchType ?? 'contains',
    categoryId: data.categoryId,
    priority: data.priority ?? 1000 + data.pattern.trim().length,
    source: 'user' as const,
    hitCount: 0,
    enabled: true,
  }) as Rule
  await db.rules.put(rule)
  return rule
}

export async function updateRule(id: string, patch: Partial<Rule>): Promise<void> {
  const current = await db.rules.get(id)
  if (!current) return
  await db.rules.put({ ...current, ...patch, id, updatedAt: now() })
}

export async function deleteRule(id: string): Promise<void> {
  const current = await db.rules.get(id)
  if (!current) return
  await db.rules.put({ ...current, deletedAt: now(), updatedAt: now() })
}

export async function bumpRuleHits(counts: Map<string, number>): Promise<void> {
  if (counts.size === 0) return
  const ids = [...counts.keys()]
  const rules = (await db.rules.bulkGet(ids)).filter((r): r is Rule => !!r)
  await db.rules.bulkPut(rules.map((r) => ({ ...r, hitCount: r.hitCount + (counts.get(r.id) ?? 0) })))
}

// ------------------------------------------------------------------ budgets

/** Rows stored against exactly this month. Never includes the default. */
export async function listBudgets(month: IsoMonth): Promise<Budget[]> {
  const rows = await db.budgets.where('month').equals(month).toArray()
  return rows.filter(isLive)
}

/** The standing budget every month inherits. */
export async function listDefaultBudgets(): Promise<Budget[]> {
  const rows = await db.budgets.where('month').equals(DEFAULT_BUDGET_MONTH).toArray()
  return rows.filter(isLive)
}

/**
 * The budget in force for a month: the standing budget, with any month-specific
 * rows laid over it.
 *
 * A month row always wins, **including one set to zero** — "nothing budgeted
 * here this month" has to be expressible, and is different from inheriting.
 * Deleting the month row reverts the category to the default.
 *
 * This is the single place resolution happens; the budget screen and the
 * projections both read through it.
 */
export async function budgetMap(month: IsoMonth): Promise<Map<string, ResolvedBudget>> {
  const [defaults, monthRows] = await Promise.all([listDefaultBudgets(), listBudgets(month)])

  const out = new Map<string, ResolvedBudget>()
  for (const b of defaults) out.set(b.categoryId, { ...b, month, inherited: true })
  for (const b of monthRows) out.set(b.categoryId, { ...b, inherited: false })
  return out
}

export async function setDefaultBudget(
  categoryId: string,
  amountMinor: number,
  source: Budget['source'] = 'user',
): Promise<void> {
  await setBudget(DEFAULT_BUDGET_MONTH, categoryId, amountMinor, source)
}

export async function deleteDefaultBudget(categoryId: string): Promise<void> {
  await deleteBudget(DEFAULT_BUDGET_MONTH, categoryId)
}

export async function setBudget(
  month: IsoMonth | typeof DEFAULT_BUDGET_MONTH,
  categoryId: string,
  amountMinor: number,
  source: Budget['source'] = 'user',
): Promise<void> {
  const existing = await db.budgets.where({ month, categoryId }).first()
  if (existing) {
    await db.budgets.put({ ...existing, amountMinor, source, deletedAt: null, updatedAt: now() })
    return
  }
  await db.budgets.put(create({ month, categoryId, amountMinor, source }) as Budget)
}

export async function setBudgets(
  month: IsoMonth | typeof DEFAULT_BUDGET_MONTH,
  entries: Array<{ categoryId: string; amountMinor: number; source?: Budget['source'] }>,
): Promise<void> {
  await db.transaction('rw', db.budgets, async () => {
    for (const e of entries) await setBudget(month, e.categoryId, e.amountMinor, e.source ?? 'user')
  })
}

export async function deleteBudget(
  month: IsoMonth | typeof DEFAULT_BUDGET_MONTH,
  categoryId: string,
): Promise<void> {
  const existing = await db.budgets.where({ month, categoryId }).first()
  if (existing) await db.budgets.put({ ...existing, deletedAt: now(), updatedAt: now() })
}

/** True when this month overrides the default for that category. */
export async function hasMonthOverride(month: IsoMonth, categoryId: string): Promise<boolean> {
  const row = await db.budgets.where({ month, categoryId }).first()
  return !!row && isLive(row)
}

/**
 * The most recent real month that has any budget set — used to inherit forward.
 * The default sentinel is excluded: it is not a month and copying "default"
 * forward would be meaningless.
 */
export async function latestBudgetedMonth(before: IsoMonth): Promise<IsoMonth | null> {
  const rows = (await db.budgets.toArray())
    .filter(isLive)
    .filter((b) => b.month !== DEFAULT_BUDGET_MONTH && b.month < before)
  if (rows.length === 0) return null
  return rows.reduce((max, b) => (b.month > max ? b.month : max), rows[0].month)
}

// ------------------------------------------------------------ import batches

export async function listImportBatches(): Promise<ImportBatch[]> {
  const rows = await db.importBatches.toArray()
  return rows.filter(isLive).sort((a, b) => b.importedAt - a.importedAt)
}

export async function createImportBatch(data: Omit<ImportBatch, 'id' | 'updatedAt' | 'deletedAt'>): Promise<ImportBatch> {
  const batch = create(data) as ImportBatch
  await db.importBatches.put(batch)
  return batch
}

/**
 * Removes an entire import and unpairs any transfers it created, so an
 * accidental import of the wrong file or wrong account is fully reversible.
 */
export async function undoImportBatch(batchId: string): Promise<number> {
  const ts = now()
  let removed = 0

  await db.transaction('rw', db.importBatches, db.transactions, async () => {
    const txs = (await db.transactions.where('importBatchId').equals(batchId).toArray()).filter(isLive)
    removed = txs.length

    const groupIds = new Set(txs.map((t) => t.transferGroupId).filter((g): g is string => !!g))
    await db.transactions.bulkPut(txs.map((t) => ({ ...t, deletedAt: ts, updatedAt: ts })))

    // Any surviving half of a broken transfer pair goes back to uncategorised.
    for (const g of groupIds) {
      const partners = (await db.transactions.where('transferGroupId').equals(g).toArray()).filter(isLive)
      await db.transactions.bulkPut(
        partners.map((p) => ({ ...p, transferGroupId: null, categoryId: null, categorySource: null, updatedAt: ts })),
      )
    }

    const batch = await db.importBatches.get(batchId)
    if (batch) await db.importBatches.put({ ...batch, deletedAt: ts, updatedAt: ts })
  })

  return removed
}

// ------------------------------------------------------------- bank profiles

export async function findBankProfile(headerSignature: string): Promise<BankProfile | undefined> {
  const p = await db.bankProfiles.where('headerSignature').equals(headerSignature).first()
  return p && isLive(p) ? p : undefined
}

export async function listBankProfiles(): Promise<BankProfile[]> {
  return (await db.bankProfiles.toArray()).filter(isLive)
}

export async function saveBankProfile(profile: Omit<BankProfile, 'id' | 'updatedAt' | 'deletedAt'>): Promise<BankProfile> {
  const existing = await db.bankProfiles.where('headerSignature').equals(profile.headerSignature).first()
  if (existing) {
    const next = { ...existing, ...profile, id: existing.id, deletedAt: null, updatedAt: now() }
    await db.bankProfiles.put(next)
    return next
  }
  const created = create(profile) as BankProfile
  await db.bankProfiles.put(created)
  return created
}

// ------------------------------------------------------------------- backup

export interface BackupFile {
  format: 'budgetbudgettwe-backup'
  version: 1
  exportedAt: string
  data: {
    accounts: Account[]
    transactions: Transaction[]
    categories: Category[]
    rules: Rule[]
    budgets: Budget[]
    importBatches: ImportBatch[]
    bankProfiles: BankProfile[]
    settings: Settings[]
  }
}

export async function exportBackup(): Promise<BackupFile> {
  const [accounts, transactions, categories, rules, budgets, importBatches, bankProfiles, settings] =
    await Promise.all([
      db.accounts.toArray(),
      db.transactions.toArray(),
      db.categories.toArray(),
      db.rules.toArray(),
      db.budgets.toArray(),
      db.importBatches.toArray(),
      db.bankProfiles.toArray(),
      db.settings.toArray(),
    ])

  return {
    format: 'budgetbudgettwe-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    data: { accounts, transactions, categories, rules, budgets, importBatches, bankProfiles, settings },
  }
}

/** Replaces all local data. The caller is responsible for confirming with the user. */
export async function importBackup(file: BackupFile): Promise<void> {
  if (file?.format !== 'budgetbudgettwe-backup') {
    throw new Error('Filen er ikke en gyldig backup fra denne app.')
  }

  await db.transaction(
    'rw',
    [db.accounts, db.transactions, db.categories, db.rules, db.budgets, db.importBatches, db.bankProfiles, db.settings],
    async () => {
      await Promise.all([
        db.accounts.clear(),
        db.transactions.clear(),
        db.categories.clear(),
        db.rules.clear(),
        db.budgets.clear(),
        db.importBatches.clear(),
        db.bankProfiles.clear(),
        db.settings.clear(),
      ])
      const d = file.data
      await Promise.all([
        db.accounts.bulkPut(d.accounts ?? []),
        db.transactions.bulkPut(d.transactions ?? []),
        db.categories.bulkPut(d.categories ?? []),
        db.rules.bulkPut(d.rules ?? []),
        db.budgets.bulkPut(d.budgets ?? []),
        db.importBatches.bulkPut(d.importBatches ?? []),
        db.bankProfiles.bulkPut(d.bankProfiles ?? []),
        db.settings.bulkPut(d.settings ?? []),
      ])
    },
  )
}

export async function clearAllData(): Promise<void> {
  await db.transaction(
    'rw',
    [db.accounts, db.transactions, db.categories, db.rules, db.budgets, db.importBatches, db.bankProfiles, db.settings],
    async () => {
      await Promise.all([
        db.accounts.clear(),
        db.transactions.clear(),
        db.categories.clear(),
        db.rules.clear(),
        db.budgets.clear(),
        db.importBatches.clear(),
        db.bankProfiles.clear(),
        db.settings.clear(),
      ])
    },
  )
  await ensureSeeded()
}
