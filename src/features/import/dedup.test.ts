import { describe, expect, it } from 'vitest'
import { dedupHashFor, dedupHashForExternalId, splitDuplicates } from './dedup'
import type { ParsedRow } from './parse'

function row(overrides: Partial<ParsedRow> = {}): ParsedRow {
  return {
    date: '2026-03-15',
    amountMinor: -4500,
    rawText: 'NETTO 1234',
    merchantKey: 'netto',
    balanceAfterMinor: null,
    postedDate: null,
    externalId: null,
    sourceRow: 2,
    ...overrides,
  }
}

describe('dedupHashFor', () => {
  it('is stable across calls', () => {
    const a = dedupHashFor('acc', '2026-03-15', -4500, 'NETTO 1234', 0)
    const b = dedupHashFor('acc', '2026-03-15', -4500, 'NETTO 1234', 0)
    expect(a).toBe(b)
  })

  it('ignores formatting differences in the description', () => {
    const a = dedupHashFor('acc', '2026-03-15', -4500, 'NETTO 1234, København', 0)
    const b = dedupHashFor('acc', '2026-03-15', -4500, 'netto 1234 københavn', 0)
    expect(a).toBe(b)
  })

  it('differs on account, date, amount and occurrence', () => {
    const base = dedupHashFor('acc', '2026-03-15', -4500, 'NETTO', 0)
    expect(dedupHashFor('other', '2026-03-15', -4500, 'NETTO', 0)).not.toBe(base)
    expect(dedupHashFor('acc', '2026-03-16', -4500, 'NETTO', 0)).not.toBe(base)
    expect(dedupHashFor('acc', '2026-03-15', -4600, 'NETTO', 0)).not.toBe(base)
    expect(dedupHashFor('acc', '2026-03-15', -4500, 'NETTO', 1)).not.toBe(base)
  })
})

describe('splitDuplicates', () => {
  it('treats everything as new when nothing is stored', () => {
    const { fresh, duplicates } = splitDuplicates([row(), row({ amountMinor: -9900 })], 'acc', new Set())
    expect(fresh).toHaveLength(2)
    expect(duplicates).toHaveLength(0)
  })

  it('keeps two genuinely identical same-day purchases', () => {
    // Two coffees, same shop, same price, same day — both are real.
    const rows = [row({ sourceRow: 2 }), row({ sourceRow: 3 })]
    const { fresh } = splitDuplicates(rows, 'acc', new Set())
    expect(fresh).toHaveLength(2)
    expect(fresh[0].dedupHash).not.toBe(fresh[1].dedupHash)
  })

  it('detects every row as a duplicate when the same file is imported twice', () => {
    const rows = [row({ sourceRow: 2 }), row({ sourceRow: 3 }), row({ amountMinor: -1200, sourceRow: 4 })]

    const first = splitDuplicates(rows, 'acc', new Set())
    expect(first.fresh).toHaveLength(3)

    const stored = new Set(first.fresh.map((r) => r.dedupHash))
    const second = splitDuplicates(rows, 'acc', stored)

    expect(second.fresh).toHaveLength(0)
    expect(second.duplicates).toHaveLength(3)
  })

  it('numbers occurrences deterministically regardless of file row order', () => {
    const ascending = [row({ sourceRow: 2 }), row({ sourceRow: 3 })]
    const descending = [row({ sourceRow: 3 }), row({ sourceRow: 2 })]

    const a = splitDuplicates(ascending, 'acc', new Set()).fresh.map((r) => r.dedupHash).sort()
    const b = splitDuplicates(descending, 'acc', new Set()).fresh.map((r) => r.dedupHash).sort()

    expect(a).toEqual(b)
  })

  it('imports only the new rows from an overlapping statement', () => {
    // A second export covering March and April, where March was already imported.
    const march = [row({ date: '2026-03-15' }), row({ date: '2026-03-20' })]
    const stored = new Set(splitDuplicates(march, 'acc', new Set()).fresh.map((r) => r.dedupHash))

    const overlapping = [...march, row({ date: '2026-04-02' }), row({ date: '2026-04-09' })]
    const { fresh, duplicates } = splitDuplicates(overlapping, 'acc', stored)

    expect(fresh).toHaveLength(2)
    expect(duplicates).toHaveLength(2)
    expect(fresh.map((f) => f.date)).toEqual(['2026-04-02', '2026-04-09'])
  })

  it('uses the bank id as the fingerprint when the export has one', () => {
    const rows = [
      row({ externalId: 'fa5620df-bbd1-458c-94ed-a7543cc3f2f5' }),
      row({ externalId: 'c92a4081-9b95-40c6-a2a8-6a48f9216966' }),
    ]
    const first = splitDuplicates(rows, 'acc', new Set())
    expect(first.fresh).toHaveLength(2)

    const stored = new Set(first.fresh.map((r) => r.dedupHash))
    expect(splitDuplicates(rows, 'acc', stored).duplicates).toHaveLength(2)
  })

  it('recognises a re-export even when the bank restates the description', () => {
    // A derived fingerprint would treat this as a new transaction; the bank's
    // own id does not care what the description says.
    const original = row({ externalId: 'fa5620df-bbd1', rawText: 'NETTO 1234' })
    const restated = row({ externalId: 'fa5620df-bbd1', rawText: 'Netto Nørrebrogade 155' })

    const stored = new Set(splitDuplicates([original], 'acc', new Set()).fresh.map((r) => r.dedupHash))
    expect(splitDuplicates([restated], 'acc', stored).duplicates).toHaveLength(1)
  })

  it('keeps two identical purchases apart by their differing bank ids', () => {
    const rows = [row({ externalId: 'id-a' }), row({ externalId: 'id-b' })]
    const { fresh } = splitDuplicates(rows, 'acc', new Set())

    expect(fresh).toHaveLength(2)
    expect(fresh[0].dedupHash).not.toBe(fresh[1].dedupHash)
  })

  it('survives an id column that repeats values', () => {
    // A wrongly-mapped column, or a bank that reuses references, must not
    // produce two identical fingerprints — the unique index would reject the
    // entire batch rather than the offending row.
    const rows = [
      row({ externalId: '01:34:46', date: '2026-02-03', amountMinor: -15215 }),
      row({ externalId: '01:34:46', date: '2026-03-03', amountMinor: -30010 }),
      row({ externalId: '01:34:46', date: '2026-04-03', amountMinor: -12000 }),
    ]
    const { fresh } = splitDuplicates(rows, 'acc', new Set())

    expect(fresh).toHaveLength(3)
    expect(new Set(fresh.map((f) => f.dedupHash)).size).toBe(3)
  })

  it('still recognises a re-import when ids repeat', () => {
    const rows = [
      row({ externalId: 'dup', date: '2026-02-03', amountMinor: -100 }),
      row({ externalId: 'dup', date: '2026-03-03', amountMinor: -200 }),
    ]
    const stored = new Set(splitDuplicates(rows, 'acc', new Set()).fresh.map((r) => r.dedupHash))

    expect(splitDuplicates(rows, 'acc', stored).duplicates).toHaveLength(2)
  })

  it('keeps the fingerprint stable for a unique id', () => {
    // Files imported before repeated ids were handled must not all look new.
    const a = splitDuplicates([row({ externalId: 'abc-123' })], 'acc', new Set()).fresh[0]
    expect(a.dedupHash).toBe(dedupHashForExternalId('acc', 'abc-123'))
  })

  it('falls back to the derived fingerprint for rows with no bank id', () => {
    const rows = [row({ externalId: 'id-a' }), row({ externalId: null, rawText: 'CASH' })]
    const first = splitDuplicates(rows, 'acc', new Set())
    expect(first.fresh).toHaveLength(2)

    const stored = new Set(first.fresh.map((r) => r.dedupHash))
    expect(splitDuplicates(rows, 'acc', stored).duplicates).toHaveLength(2)
  })

  it('recognises a purchase across exports that date it differently', () => {
    // A card amount is reserved on one day and drawn a few days later. The
    // detailed export prints both dates; the simpler one prints only the
    // posting date. Keyed on a single date these look like two purchases —
    // on one real account, 199 of them did.
    const detailed = row({ date: '2025-07-08', postedDate: '2025-07-09', amountMinor: -45000, rawText: 'Auto bilsyn' })
    const simple = row({ date: '2025-07-09', postedDate: null, amountMinor: -45000, rawText: 'Auto bilsyn' })

    const stored = new Set(splitDuplicates([detailed], 'acc', new Set()).fresh.flatMap((r) => r.dedupKeys))
    const second = splitDuplicates([simple], 'acc', stored)

    expect(second.duplicates).toHaveLength(1)
    expect(second.fresh).toHaveLength(0)
  })

  it('recognises it in the other import order too', () => {
    const detailed = row({ date: '2025-07-08', postedDate: '2025-07-09', amountMinor: -45000, rawText: 'Auto bilsyn' })
    const simple = row({ date: '2025-07-09', postedDate: null, amountMinor: -45000, rawText: 'Auto bilsyn' })

    const stored = new Set(splitDuplicates([simple], 'acc', new Set()).fresh.flatMap((r) => r.dedupKeys))
    expect(splitDuplicates([detailed], 'acc', stored).duplicates).toHaveLength(1)
  })

  it('bridges the two formats even when only one carries a bank id', () => {
    // The formats do not share ids, so the id alone cannot link them — the
    // date-derived keys have to be present alongside it.
    const withId = row({ date: '2025-07-09', externalId: 'abc-123', amountMinor: -45000, rawText: 'Auto bilsyn' })
    const withDates = row({ date: '2025-07-08', postedDate: '2025-07-09', amountMinor: -45000, rawText: 'Auto bilsyn' })

    const stored = new Set(splitDuplicates([withDates], 'acc', new Set()).fresh.flatMap((r) => r.dedupKeys))
    expect(splitDuplicates([withId], 'acc', stored).duplicates).toHaveLength(1)
  })

  it('does not merge two real purchases that merely fall a day apart', () => {
    // Circle K at 64,00 on consecutive days is a real pattern in this data;
    // only a shared posting date makes them the same purchase.
    const monday = row({ date: '2026-04-07', postedDate: '2026-04-07', amountMinor: -6400, rawText: 'Circle K' })
    const tuesday = row({ date: '2026-04-08', postedDate: '2026-04-08', amountMinor: -6400, rawText: 'Circle K' })

    const { fresh } = splitDuplicates([monday, tuesday], 'acc', new Set())
    expect(fresh).toHaveLength(2)
  })

  it('ignores a posting date identical to the transaction date', () => {
    const r = splitDuplicates(
      [row({ date: '2026-03-15', postedDate: '2026-03-15' })],
      'acc',
      new Set(),
    ).fresh[0]
    // No point carrying the same key twice.
    expect(r.dedupKeys).toHaveLength(1)
  })

  it('scopes duplicates to one account', () => {
    const rows = [row()]
    const stored = new Set(splitDuplicates(rows, 'acc-1', new Set()).fresh.map((r) => r.dedupHash))
    // The same row on a different account is a different transaction.
    expect(splitDuplicates(rows, 'acc-2', stored).fresh).toHaveLength(1)
  })
})
