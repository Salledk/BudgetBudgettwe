import type { IsoDay, IsoMonth, DateFormat } from '@/lib/dates'
import type { Minor } from '@/lib/money'

/**
 * Every stored record carries these. `updatedAt` and `deletedAt` exist so a
 * sync backend can be added later with last-write-wins semantics and tombstones
 * — without them, deletions could never propagate and a schema migration would
 * be needed to introduce them.
 */
export interface BaseRecord {
  id: string
  updatedAt: number
  deletedAt: number | null
}

export type AccountKind = 'budget' | 'spending' | 'savings' | 'other'

export interface Account extends BaseRecord {
  name: string
  kind: AccountKind
  /** Balance before the first imported transaction. Lets us derive running balances. */
  openingBalanceMinor: Minor
  /** Optional — used to auto-route an import to the right account. */
  accountNumber: string | null
  archived: boolean
  sortOrder: number
}

export type CategoryKind = 'income' | 'expense' | 'transfer' | 'savings'

export interface Category extends BaseRecord {
  name: string
  kind: CategoryKind
  parentId: string | null
  icon: string
  color: string
  /** System categories (Transfer, Uncategorised) cannot be deleted. */
  isSystem: boolean
  /** Recurring bills get budgeted from the median rather than a trimmed mean. */
  archived: boolean
  sortOrder: number
}

/** How a transaction came to have its category. Drives the review queue. */
export type CategorySource = 'manual' | 'rule' | 'seed' | 'learned' | 'transfer'

export interface Transaction extends BaseRecord {
  accountId: string
  date: IsoDay
  amountMinor: Minor
  /** Description exactly as the bank exported it. Never rewritten. */
  rawText: string
  /** Merchant key derived from rawText; recomputed on import, indexed. */
  merchantKey: string
  counterparty: string | null
  balanceAfterMinor: Minor | null
  categoryId: string | null
  categorySource: CategorySource | null
  /** Set when this transaction is paired with its opposite on another account. */
  transferGroupId: string | null
  importBatchId: string
  dedupHash: string
  notes: string | null
  /** User has seen and accepted a `learned` suggestion. */
  reviewed: boolean
}

export type RuleMatchType = 'contains' | 'exact' | 'regex'
export type RuleSource = 'user' | 'seed'

export interface Rule extends BaseRecord {
  pattern: string
  matchType: RuleMatchType
  categoryId: string
  /** Higher wins. User rules are seeded above seed rules. */
  priority: number
  source: RuleSource
  hitCount: number
  enabled: boolean
}

export type BudgetSource = 'suggested' | 'user'

export interface Budget extends BaseRecord {
  month: IsoMonth
  categoryId: string
  amountMinor: Minor
  source: BudgetSource
}

export interface ImportBatch extends BaseRecord {
  fileName: string
  accountId: string
  importedAt: number
  rowCount: number
  insertedCount: number
  duplicateCount: number
  transferCount: number
}

export type AmountMode = 'single' | 'debit-credit'

/**
 * A saved column mapping, keyed by the header signature of the file it came
 * from. This is what makes every import after the first one a single tap.
 */
export interface BankProfile extends BaseRecord {
  name: string
  /** Normalised, sorted header names joined — identifies a bank's export layout. */
  headerSignature: string
  delimiter: string
  dateColumn: string
  dateFormat: DateFormat
  amountMode: AmountMode
  amountColumn: string | null
  debitColumn: string | null
  creditColumn: string | null
  descriptionColumns: string[]
  balanceColumn: string | null
  decimalSeparator: ',' | '.' | 'auto'
  /** Some exports write outflows as positive numbers in a single column. */
  invertSign: boolean
  skipRows: number
}

export interface Settings extends BaseRecord {
  currency: string
  locale: string
  /** Months to look back when suggesting a budget. */
  lookbackMonths: number
  /** Fraction of budget at which a category is flagged "at risk". */
  atRiskRatio: number
  onboardedAt: number | null
}

/** Convenience shape used across the UI — a transaction plus its resolved refs. */
export interface TransactionView extends Transaction {
  category: Category | null
  account: Account | null
}

export const SYSTEM_CATEGORY = {
  transfer: 'sys-transfer',
  savings: 'sys-savings',
} as const

export const DEFAULT_SETTINGS: Omit<Settings, keyof BaseRecord> = {
  currency: 'DKK',
  locale: 'da-DK',
  lookbackMonths: 6,
  atRiskRatio: 1.0,
  onboardedAt: null,
}
