import { daysBetween } from '@/lib/dates'
import { newId } from '@/lib/id'
import { SYSTEM_CATEGORY, type Transaction } from '@/data/types'

/**
 * Pairs transactions that represent the same money moving between the user's
 * own accounts.
 *
 * This is the single most important correction the app makes. Without it,
 * moving 5.000 kr from the budget account to the spending account looks like
 * 5.000 kr of income and 5.000 kr of expense — which inflates both sides of
 * every total and makes budget suggestions meaningless.
 */

/** Same amount, opposite sign, on different accounts, within this many days. */
export const TRANSFER_WINDOW_DAYS = 3

export interface TransferPair {
  outId: string
  inId: string
  groupId: string
}

/**
 * Finds transfer pairs among `candidates`, optionally matching against
 * `existing` transactions already stored (so the second account's statement,
 * imported a week later, still pairs with the first).
 *
 * Greedy nearest-date matching: each transaction is used at most once, and the
 * closest date wins, so a recurring monthly transfer of the same amount pairs
 * with its own counterpart rather than with last month's.
 */
export function findTransferPairs(candidates: Transaction[], existing: Transaction[] = []): TransferPair[] {
  const pool = [...existing, ...candidates].filter((t) => t.deletedAt === null && !t.transferGroupId)

  // Bucket by absolute amount — a transfer's two halves always match exactly.
  const byAmount = new Map<number, Transaction[]>()
  for (const t of pool) {
    const key = Math.abs(t.amountMinor)
    const list = byAmount.get(key) ?? []
    list.push(t)
    byAmount.set(key, list)
  }

  const used = new Set<string>()
  const pairs: TransferPair[] = []

  for (const group of byAmount.values()) {
    if (group.length < 2) continue

    const outflows = group.filter((t) => t.amountMinor < 0).sort((a, b) => a.date.localeCompare(b.date))
    const inflows = group.filter((t) => t.amountMinor > 0).sort((a, b) => a.date.localeCompare(b.date))
    if (outflows.length === 0 || inflows.length === 0) continue

    for (const out of outflows) {
      if (used.has(out.id)) continue

      let best: Transaction | null = null
      let bestDistance = Number.POSITIVE_INFINITY

      for (const inn of inflows) {
        if (used.has(inn.id)) continue
        // Money moving within one account is not a transfer between accounts.
        if (inn.accountId === out.accountId) continue

        const distance = Math.abs(daysBetween(out.date, inn.date))
        if (distance > TRANSFER_WINDOW_DAYS) continue

        if (distance < bestDistance) {
          bestDistance = distance
          best = inn
        }
      }

      if (best) {
        used.add(out.id)
        used.add(best.id)
        pairs.push({ outId: out.id, inId: best.id, groupId: newId() })
      }
    }
  }

  return pairs
}

/** Applies pairs to a transaction list, returning only the changed records. */
export function applyTransferPairs(txs: Transaction[], pairs: TransferPair[]): Transaction[] {
  const byId = new Map(txs.map((t) => [t.id, t]))
  const ts = Date.now()
  const updated: Transaction[] = []

  for (const pair of pairs) {
    for (const id of [pair.outId, pair.inId]) {
      const tx = byId.get(id)
      if (!tx) continue
      updated.push({
        ...tx,
        transferGroupId: pair.groupId,
        categoryId: SYSTEM_CATEGORY.transfer,
        categorySource: 'transfer',
        reviewed: true,
        updatedAt: ts,
      })
    }
  }

  return updated
}

/** True for transactions that must be excluded from income/expense totals. */
export function isTransfer(tx: Pick<Transaction, 'transferGroupId' | 'categoryId'>): boolean {
  return tx.transferGroupId !== null || tx.categoryId === SYSTEM_CATEGORY.transfer
}
