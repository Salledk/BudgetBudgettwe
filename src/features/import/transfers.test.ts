import { describe, expect, it } from 'vitest'
import { tx } from '@/test/factories'
import { SYSTEM_CATEGORY } from '@/data/types'
import { applyTransferPairs, findTransferPairs, isTransfer } from './transfers'

describe('findTransferPairs', () => {
  it('pairs an outflow with the matching inflow on another account', () => {
    const out = tx({ id: 'a', accountId: 'budget', amountMinor: -500000, date: '2026-03-01' })
    const inn = tx({ id: 'b', accountId: 'spending', amountMinor: 500000, date: '2026-03-01' })

    const pairs = findTransferPairs([out, inn])

    expect(pairs).toHaveLength(1)
    expect(pairs[0].outId).toBe('a')
    expect(pairs[0].inId).toBe('b')
  })

  it('pairs across a few days, since the two sides rarely post together', () => {
    const out = tx({ id: 'a', accountId: 'budget', amountMinor: -500000, date: '2026-03-01' })
    const inn = tx({ id: 'b', accountId: 'spending', amountMinor: 500000, date: '2026-03-03' })

    expect(findTransferPairs([out, inn])).toHaveLength(1)
  })

  it('does not pair beyond the window', () => {
    const out = tx({ id: 'a', accountId: 'budget', amountMinor: -500000, date: '2026-03-01' })
    const inn = tx({ id: 'b', accountId: 'spending', amountMinor: 500000, date: '2026-03-10' })

    expect(findTransferPairs([out, inn])).toHaveLength(0)
  })

  it('does not pair movements within a single account', () => {
    const out = tx({ id: 'a', accountId: 'budget', amountMinor: -500000, date: '2026-03-01' })
    const inn = tx({ id: 'b', accountId: 'budget', amountMinor: 500000, date: '2026-03-01' })

    expect(findTransferPairs([out, inn])).toHaveLength(0)
  })

  it('does not pair amounts that merely look similar', () => {
    const out = tx({ id: 'a', accountId: 'budget', amountMinor: -500000, date: '2026-03-01' })
    const inn = tx({ id: 'b', accountId: 'spending', amountMinor: 499900, date: '2026-03-01' })

    expect(findTransferPairs([out, inn])).toHaveLength(0)
  })

  it('matches a recurring transfer to its own month, not to an earlier one', () => {
    const txs = [
      tx({ id: 'out-mar', accountId: 'budget', amountMinor: -500000, date: '2026-03-01' }),
      tx({ id: 'in-mar', accountId: 'spending', amountMinor: 500000, date: '2026-03-01' }),
      tx({ id: 'out-apr', accountId: 'budget', amountMinor: -500000, date: '2026-04-01' }),
      tx({ id: 'in-apr', accountId: 'spending', amountMinor: 500000, date: '2026-04-01' }),
    ]

    const pairs = findTransferPairs(txs)

    expect(pairs).toHaveLength(2)
    const march = pairs.find((p) => p.outId === 'out-mar')
    const april = pairs.find((p) => p.outId === 'out-apr')
    expect(march?.inId).toBe('in-mar')
    expect(april?.inId).toBe('in-apr')
  })

  it('pairs a new import against an already-stored counterpart', () => {
    // The other account's statement was imported a week earlier.
    const stored = [tx({ id: 'stored', accountId: 'spending', amountMinor: 500000, date: '2026-03-02' })]
    const incoming = [tx({ id: 'new', accountId: 'budget', amountMinor: -500000, date: '2026-03-01' })]

    const pairs = findTransferPairs(incoming, stored)

    expect(pairs).toHaveLength(1)
    expect(pairs[0].outId).toBe('new')
    expect(pairs[0].inId).toBe('stored')
  })

  it('uses each transaction at most once', () => {
    const txs = [
      tx({ id: 'out', accountId: 'budget', amountMinor: -500000, date: '2026-03-01' }),
      tx({ id: 'in-1', accountId: 'spending', amountMinor: 500000, date: '2026-03-01' }),
      tx({ id: 'in-2', accountId: 'savings', amountMinor: 500000, date: '2026-03-01' }),
    ]

    const pairs = findTransferPairs(txs)

    expect(pairs).toHaveLength(1)
  })

  it('leaves already-paired transactions alone', () => {
    const txs = [
      tx({ id: 'a', accountId: 'budget', amountMinor: -500000, transferGroupId: 'g1' }),
      tx({ id: 'b', accountId: 'spending', amountMinor: 500000, transferGroupId: 'g1' }),
    ]

    expect(findTransferPairs(txs)).toHaveLength(0)
  })
})

describe('applyTransferPairs', () => {
  it('marks both sides as a transfer with a shared group', () => {
    const out = tx({ id: 'a', accountId: 'budget', amountMinor: -500000 })
    const inn = tx({ id: 'b', accountId: 'spending', amountMinor: 500000 })
    const pairs = findTransferPairs([out, inn])

    const updated = applyTransferPairs([out, inn], pairs)

    expect(updated).toHaveLength(2)
    expect(updated[0].transferGroupId).toBe(updated[1].transferGroupId)
    expect(updated[0].categoryId).toBe(SYSTEM_CATEGORY.transfer)
    expect(updated[0].categorySource).toBe('transfer')
    // Transfers need no human review.
    expect(updated.every((t) => t.reviewed)).toBe(true)
  })
})

describe('isTransfer', () => {
  it('recognises both a paired transfer and a manually-set transfer category', () => {
    expect(isTransfer({ transferGroupId: 'g1', categoryId: null })).toBe(true)
    expect(isTransfer({ transferGroupId: null, categoryId: SYSTEM_CATEGORY.transfer })).toBe(true)
    expect(isTransfer({ transferGroupId: null, categoryId: 'groceries' })).toBe(false)
    expect(isTransfer({ transferGroupId: null, categoryId: null })).toBe(false)
  })
})
