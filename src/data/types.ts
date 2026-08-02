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
  archived: boolean
  sortOrder: number
  /**
   * Billing interval in months for a periodic expense — 3 for quarterly, 12 for
   * yearly. `null` for an ordinary category.
   *
   * When set, the category's budget holds the **full cost per period** and the
   * monthly set-aside is derived, so changing the interval can never leave a
   * stale monthly figure behind. Records written before this field existed read
   * back as `undefined` and must be treated as `null`.
   */
  periodMonths: number | null
}

/** How a transaction came to have its category. Drives the review queue. */
export type CategorySource = 'manual' | 'rule' | 'seed' | 'learned' | 'transfer'

export interface Transaction extends BaseRecord {
  accountId: string
  date: IsoDay
  /**
   * When the amount actually left the account, if the export said so.
   *
   * Banks reserve a card amount on one day and draw it a few days later, and
   * their exports disagree about which of the two `Dato` means: a detailed
   * export gives both, a simpler one gives only the posting date. Recording
   * both is what lets the same purchase be recognised across the two formats.
   */
  postedDate: IsoDay | null
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
  /** Primary fingerprint, uniquely indexed. The strongest key available. */
  dedupHash: string
  /**
   * Every fingerprint this transaction could be recognised by — its id, its
   * transaction date, and its posting date. A later import counts as a
   * duplicate when it shares *any* of these, which is what matches a purchase
   * across two exports that date it differently.
   */
  dedupKeys: string[]
  /** The bank's own id for this transaction, when the export provided one. */
  externalId: string | null
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
  /** A real month, or DEFAULT_BUDGET_MONTH for the standing budget. */
  month: IsoMonth | typeof DEFAULT_BUDGET_MONTH
  categoryId: string
  amountMinor: Minor
  source: BudgetSource
}

/**
 * Sentinel month for the standing budget that every month inherits.
 *
 * Stored in the same table as real months so the existing
 * `&[month+categoryId]` unique index guarantees one default per category, with
 * no separate table and no migration. It sorts below any real month
 * ("default" < "2024-.."), which keeps `latestBudgetedMonth` honest.
 */
export const DEFAULT_BUDGET_MONTH = 'default'

/** A budget resolved for a month, plus where the figure came from. */
export interface ResolvedBudget extends Budget {
  /** True when this month has no row of its own and inherits the default. */
  inherited: boolean
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
  /** Column holding the posting date, when the export has a second date. */
  postedDateColumn: string | null
  amountMode: AmountMode
  amountColumn: string | null
  debitColumn: string | null
  creditColumn: string | null
  descriptionColumns: string[]
  balanceColumn: string | null
  /**
   * Column holding the bank's own transaction id, when the export has one.
   * Far more reliable for duplicate detection than a fingerprint we derive.
   */
  idColumn: string | null
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
