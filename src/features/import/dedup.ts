import { stableHash } from '@/lib/id'
import { dedupText } from '@/lib/normalize'
import type { ParsedRow } from './parse'

/**
 * Duplicate detection for re-imported statements.
 *
 * The naive fingerprint (account + date + amount + text) wrongly collapses two
 * genuine coffees bought at the same shop on the same day for the same price.
 * Adding an occurrence index fixes that: the first such row gets #0, the second
 * #1, and both survive. Re-importing the same file reproduces the same indexes,
 * so it still detects every duplicate.
 */
export function dedupHashFor(accountId: string, date: string, amountMinor: number, rawText: string, occurrence: number): string {
  return stableHash(`${accountId}|${date}|${amountMinor}|${dedupText(rawText)}|${occurrence}`)
}

/**
 * When the bank supplies its own transaction id, that is the authoritative
 * fingerprint: it survives the bank restating a description or a balance, and
 * it distinguishes two identical purchases without any occurrence counting.
 */
export function dedupHashForExternalId(accountId: string, externalId: string): string {
  return stableHash(`${accountId}|id|${externalId.trim().toLowerCase()}`)
}

export interface DedupResult {
  fresh: Array<ParsedRow & { dedupHash: string }>
  duplicates: Array<ParsedRow & { dedupHash: string }>
}

/**
 * Splits parsed rows into new and already-imported.
 *
 * `existing` holds the hashes already stored for this account. Occurrence
 * indexes are assigned within this file, then checked against that set.
 */
export function splitDuplicates(rows: ParsedRow[], accountId: string, existing: Set<string>): DedupResult {
  const seenInFile = new Map<string, number>()
  const fresh: Array<ParsedRow & { dedupHash: string }> = []
  const duplicates: Array<ParsedRow & { dedupHash: string }> = []

  // Ascending date order so occurrence numbering is deterministic regardless
  // of how the bank ordered the export.
  const ordered = [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.sourceRow - b.sourceRow)

  for (const row of ordered) {
    let dedupHash: string
    if (row.externalId) {
      dedupHash = dedupHashForExternalId(accountId, row.externalId)
    } else {
      const base = `${row.date}|${row.amountMinor}|${dedupText(row.rawText)}`
      const occurrence = seenInFile.get(base) ?? 0
      seenInFile.set(base, occurrence + 1)
      dedupHash = dedupHashFor(accountId, row.date, row.amountMinor, row.rawText, occurrence)
    }

    const withHash = { ...row, dedupHash }

    if (existing.has(dedupHash)) duplicates.push(withHash)
    else fresh.push(withHash)
  }

  return { fresh, duplicates }
}
