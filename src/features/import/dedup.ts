import { stableHash } from '@/lib/id'
import { dedupText } from '@/lib/normalize'
import type { ParsedRow } from './parse'

/**
 * Duplicate detection for re-imported statements.
 *
 * A transaction can be recognised by more than one thing, and which of them is
 * available depends on the export:
 *
 *  - the bank's own transaction id, when there is one;
 *  - account + date + amount + text;
 *  - the same, but keyed on the *posting* date.
 *
 * That last one exists because a card amount is reserved on one day and drawn
 * a few days later, and the bank's own exports disagree about which date to
 * print. A detailed export gives both dates; a simpler one gives only the
 * posting date. Keyed on a single date, the same purchase imported from both
 * formats looks like two different transactions — which is exactly what
 * happened: of 187 transactions present in two exports of one account, 114
 * came back with the posting date and duplicated.
 *
 * So each transaction carries a *set* of fingerprints, and a row is a duplicate
 * when it shares any of them with something already stored.
 *
 * The occurrence index in every key is what still allows two genuinely
 * identical purchases — same shop, same price, same day — to both survive.
 */

export function dedupHashFor(accountId: string, date: string, amountMinor: number, rawText: string, occurrence: number): string {
  return stableHash(`${accountId}|${date}|${amountMinor}|${dedupText(rawText)}|${occurrence}`)
}

/**
 * When the bank supplies its own transaction id, that is the authoritative
 * fingerprint: it survives the bank restating a description or a balance, and
 * it distinguishes two identical purchases without any occurrence counting.
 */
export function dedupHashForExternalId(accountId: string, externalId: string, occurrence = 0): string {
  const base = `${accountId}|id|${externalId.trim().toLowerCase()}`
  // The occurrence suffix is omitted at 0 so hashes stay stable for files
  // already imported before repeated ids were handled.
  return stableHash(occurrence === 0 ? base : `${base}|${occurrence}`)
}

export interface DedupResult {
  fresh: Array<ParsedRow & { dedupHash: string; dedupKeys: string[] }>
  duplicates: Array<ParsedRow & { dedupHash: string; dedupKeys: string[] }>
}

/**
 * Splits parsed rows into new and already-imported.
 *
 * `existing` holds every fingerprint already stored for this account — the
 * union of each stored transaction's keys, not just its primary one.
 */
export function splitDuplicates(rows: ParsedRow[], accountId: string, existing: Set<string>): DedupResult {
  const seenInFile = new Map<string, number>()
  const fresh: DedupResult['fresh'] = []
  const duplicates: DedupResult['duplicates'] = []

  // Ascending date order so occurrence numbering is deterministic regardless
  // of how the bank ordered the export.
  const ordered = [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.sourceRow - b.sourceRow)

  /** Next occurrence number for a base key, counted within this file. */
  const nextOccurrence = (base: string) => {
    const n = seenInFile.get(base) ?? 0
    seenInFile.set(base, n + 1)
    return n
  }

  for (const row of ordered) {
    const keys: string[] = []

    if (row.externalId) {
      const base = `id|${row.externalId.trim().toLowerCase()}`
      keys.push(dedupHashForExternalId(accountId, row.externalId, nextOccurrence(base)))
    }

    // Always include the date-derived keys, even alongside an id. The two
    // formats of one export can carry different ids for the same purchase, so
    // the id alone cannot bridge them.
    const onDate = (date: string) => {
      const base = `${date}|${row.amountMinor}|${dedupText(row.rawText)}`
      return dedupHashFor(accountId, date, row.amountMinor, row.rawText, nextOccurrence(base))
    }

    keys.push(onDate(row.date))
    if (row.postedDate && row.postedDate !== row.date) keys.push(onDate(row.postedDate))

    // The primary key is the strongest available, and is what the unique index
    // enforces; the rest exist only to be matched against.
    const dedupHash = keys[0]
    const withKeys = { ...row, dedupHash, dedupKeys: keys }

    if (keys.some((k) => existing.has(k))) duplicates.push(withKeys)
    else fresh.push(withKeys)
  }

  return { fresh, duplicates }
}
