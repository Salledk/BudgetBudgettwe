import Dexie, { type Table } from 'dexie'
import type {
  Account,
  BankProfile,
  Budget,
  Category,
  ImportBatch,
  Rule,
  Settings,
  Transaction,
} from './types'

/**
 * IndexedDB schema. Indexes are chosen for the three hot queries:
 *   - transactions for a month (dashboard, budget, projections)
 *   - transactions for an account (import dedup, balances)
 *   - transactions by merchantKey (the learned categorisation layer)
 *
 * `dedupHash` is unique-indexed so a re-import of the same file cannot create
 * duplicates even if the dedup check above it is somehow bypassed.
 */
export class BudgetDb extends Dexie {
  accounts!: Table<Account, string>
  transactions!: Table<Transaction, string>
  categories!: Table<Category, string>
  rules!: Table<Rule, string>
  budgets!: Table<Budget, string>
  importBatches!: Table<ImportBatch, string>
  bankProfiles!: Table<BankProfile, string>
  settings!: Table<Settings, string>

  constructor(name = 'budgetbudgettwe') {
    super(name)
    this.version(1).stores({
      accounts: 'id, sortOrder, archived, deletedAt',
      transactions:
        'id, accountId, date, categoryId, merchantKey, transferGroupId, importBatchId, &dedupHash, deletedAt, [accountId+date], [date+categoryId]',
      categories: 'id, kind, parentId, sortOrder, deletedAt',
      rules: 'id, categoryId, priority, source, deletedAt',
      budgets: 'id, month, categoryId, deletedAt, &[month+categoryId]',
      importBatches: 'id, accountId, importedAt, deletedAt',
      bankProfiles: 'id, &headerSignature, deletedAt',
      settings: 'id',
    })
  }
}

export const db = new BudgetDb()

/** Stamps the audit fields every write must carry. */
export function stamp<T extends { updatedAt: number; deletedAt: number | null }>(record: T): T {
  record.updatedAt = Date.now()
  if (record.deletedAt === undefined) record.deletedAt = null
  return record
}

/** Live records only — everything stored is soft-deleted, never removed. */
export function isLive<T extends { deletedAt: number | null }>(r: T): boolean {
  return r.deletedAt === null
}
