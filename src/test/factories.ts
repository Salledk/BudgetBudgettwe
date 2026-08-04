import { newId } from '@/lib/id'
import { merchantKey } from '@/lib/normalize'
import type { Category, Rule, Transaction } from '@/data/types'

/** Test helpers so each test states only what it actually cares about. */

let counter = 0

export function tx(overrides: Partial<Transaction> = {}): Transaction {
  counter++
  const rawText = overrides.rawText ?? `Transaction ${counter}`
  return {
    id: overrides.id ?? `tx-${counter}`,
    accountId: 'acc-1',
    date: '2026-03-15',
    postedDate: null,
    amountMinor: -10000,
    rawText,
    merchantKey: overrides.merchantKey ?? merchantKey(rawText),
    counterparty: null,
    balanceAfterMinor: null,
    categoryId: null,
    categorySource: null,
    transferGroupId: null,
    importBatchId: 'batch-1',
    dedupHash: overrides.dedupHash ?? `hash-${counter}`,
    dedupKeys: overrides.dedupKeys ?? [overrides.dedupHash ?? `hash-${counter}`],
    externalId: null,
    notes: null,
    reviewed: false,
    updatedAt: 1,
    deletedAt: null,
    ...overrides,
  }
}

export function category(overrides: Partial<Category> = {}): Category {
  return {
    id: overrides.id ?? newId(),
    name: 'Test',
    kind: 'expense',
    parentId: null,
    icon: '📦',
    color: '#000000',
    isSystem: false,
    archived: false,
    periodMonths: null,
    rollover: false,
    rolloverSince: null,
    sortOrder: 10,
    updatedAt: 1,
    deletedAt: null,
    ...overrides,
  }
}

export function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: overrides.id ?? newId(),
    pattern: 'netto',
    matchType: 'contains',
    categoryId: 'cat-groceries',
    priority: 100,
    source: 'seed',
    hitCount: 0,
    enabled: true,
    updatedAt: 1,
    deletedAt: null,
    ...overrides,
  }
}

/** Builds one transaction per month for a category, for suggestion tests. */
export function monthlySeries(
  categoryId: string,
  amounts: Array<[month: string, minor: number]>,
  overrides: Partial<Transaction> = {},
): Transaction[] {
  return amounts.map(([month, minor]) =>
    tx({ date: `${month}-15`, amountMinor: -minor, categoryId, categorySource: 'manual', ...overrides }),
  )
}
