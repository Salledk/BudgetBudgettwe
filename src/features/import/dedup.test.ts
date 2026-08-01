import { describe, expect, it } from 'vitest'
import { dedupHashFor, splitDuplicates } from './dedup'
import type { ParsedRow } from './parse'

function row(overrides: Partial<ParsedRow> = {}): ParsedRow {
  return {
    date: '2026-03-15',
    amountMinor: -4500,
    rawText: 'NETTO 1234',
    merchantKey: 'netto',
    balanceAfterMinor: null,
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

  it('scopes duplicates to one account', () => {
    const rows = [row()]
    const stored = new Set(splitDuplicates(rows, 'acc-1', new Set()).fresh.map((r) => r.dedupHash))
    // The same row on a different account is a different transaction.
    expect(splitDuplicates(rows, 'acc-2', stored).fresh).toHaveLength(1)
  })
})
