import { newId } from '@/lib/id'
import { db } from '@/data/db'
import * as repo from '@/data/repo'
import type { Transaction } from '@/data/types'
import { buildHistory, categoriseBatch } from '@/features/categorize/engine'
import { splitDuplicates } from './dedup'
import { applyMapping, type ColumnMapping, type ParseIssue, type RawTable } from './parse'
import { applyTransferPairs, findTransferPairs } from './transfers'

export interface ImportSummary {
  batchId: string
  totalRows: number
  inserted: number
  duplicates: number
  transfersLinked: number
  autoCategorised: number
  needsReview: number
  issues: ParseIssue[]
}

/**
 * The full import pipeline, run as one transaction so a failure part-way
 * through cannot leave half a statement in the database.
 *
 * Order matters: transfers are paired before categorisation so that the
 * categoriser skips them, and history is read before the batch is categorised
 * so learned matches reflect what the user has confirmed rather than what this
 * same import just guessed.
 */
export async function runImport(params: {
  table: RawTable
  mapping: ColumnMapping
  accountId: string
  fileName: string
  saveProfile?: boolean
  profileName?: string
}): Promise<ImportSummary> {
  const { table, mapping, accountId, fileName } = params

  const { rows, issues } = applyMapping(table, mapping)
  const existingHashes = await repo.existingDedupHashes(accountId)
  const { fresh, duplicates } = splitDuplicates(rows, accountId, existingHashes)

  const batchId = newId()
  const ts = Date.now()

  const newTransactions: Transaction[] = fresh.map((row) => ({
    id: newId(),
    accountId,
    date: row.date,
    amountMinor: row.amountMinor,
    rawText: row.rawText,
    merchantKey: row.merchantKey,
    counterparty: null,
    balanceAfterMinor: row.balanceAfterMinor,
    categoryId: null,
    categorySource: null,
    transferGroupId: null,
    importBatchId: batchId,
    dedupHash: row.dedupHash,
    notes: null,
    reviewed: false,
    updatedAt: ts,
    deletedAt: null,
  }))

  // Pair transfers against everything already stored, not just this file — the
  // other side of a transfer usually arrives in a separate statement.
  const allExisting = await repo.listTransactions()
  const pairs = findTransferPairs(newTransactions, allExisting)
  const transferUpdates = applyTransferPairs([...newTransactions, ...allExisting], pairs)

  const transferUpdateById = new Map(transferUpdates.map((t) => [t.id, t]))
  const merged = newTransactions.map((t) => transferUpdateById.get(t.id) ?? t)
  // Updates that landed on previously-stored transactions.
  const existingUpdates = transferUpdates.filter((t) => !newTransactions.some((n) => n.id === t.id))

  const [rules, merchantCounts] = await Promise.all([repo.listRules(), repo.categorisedByMerchant()])
  const { updated: categorised, ruleHits } = categoriseBatch(merged, rules, buildHistory(merchantCounts))

  const categorisedById = new Map(categorised.map((t) => [t.id, t]))
  const finalRows = merged.map((t) => categorisedById.get(t.id) ?? t)

  await db.transaction('rw', db.transactions, db.importBatches, db.rules, async () => {
    await repo.putTransactions([...finalRows, ...existingUpdates])
    await repo.bumpRuleHits(ruleHits)
    await repo.createImportBatch({
      fileName,
      accountId,
      importedAt: ts,
      rowCount: table.rows.length,
      insertedCount: finalRows.length,
      duplicateCount: duplicates.length,
      transferCount: pairs.length,
    })
  })

  if (params.saveProfile) {
    await repo.saveBankProfile({
      ...mapping,
      name: params.profileName ?? fileName.replace(/\.[^.]+$/, ''),
      headerSignature: table.headerSignature,
    })
  }

  return {
    batchId,
    totalRows: table.rows.length,
    inserted: finalRows.length,
    duplicates: duplicates.length,
    transfersLinked: pairs.length,
    autoCategorised: finalRows.filter((t) => t.categoryId !== null).length,
    needsReview: finalRows.filter((t) => t.categorySource === 'learned' && !t.reviewed).length,
    issues,
  }
}

/**
 * Re-runs rules and learned matching across everything not manually assigned.
 * Used after adding or editing a rule so the change applies retroactively —
 * otherwise a new rule would only ever affect future imports.
 */
export async function recategoriseAll(options: { includeAuto?: boolean } = {}): Promise<number> {
  const includeAuto = options.includeAuto ?? true

  const [all, rules, merchantCounts] = await Promise.all([
    repo.listTransactions(),
    repo.listRules(),
    repo.categorisedByMerchant(),
  ])

  const targets = all.filter((t) => {
    if (t.transferGroupId) return false
    if (t.categorySource === 'manual') return false
    if (!includeAuto && t.categoryId !== null) return false
    return true
  })

  const { updated, ruleHits } = categoriseBatch(targets, rules, buildHistory(merchantCounts))
  if (updated.length > 0) {
    await repo.putTransactions(updated)
    await repo.bumpRuleHits(ruleHits)
  }
  return updated.length
}

/**
 * Applies a single rule to transactions that are not manually categorised.
 * Called right after the user accepts "always categorise X as Y", so the
 * back-fill is immediate and visible.
 */
export async function applyRuleRetroactively(pattern: string, categoryId: string): Promise<number> {
  const all = await repo.listTransactions()
  const needle = pattern.toLowerCase().trim()
  if (!needle) return 0

  const matches = all.filter((t) => {
    if (t.transferGroupId) return false
    if (t.categorySource === 'manual') return false
    if (t.categoryId === categoryId) return false
    return t.rawText.toLowerCase().includes(needle) || t.merchantKey.includes(needle)
  })

  if (matches.length === 0) return 0

  const ts = Date.now()
  await repo.putTransactions(
    matches.map((t) => ({ ...t, categoryId, categorySource: 'rule' as const, reviewed: true, updatedAt: ts })),
  )
  return matches.length
}
