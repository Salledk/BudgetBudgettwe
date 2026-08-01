import { describe, expect, it } from 'vitest'
import { dedupText, merchantKey, merchantKeyShort } from './normalize'

describe('merchantKey', () => {
  it('collapses the same shop written several ways', () => {
    const keys = [
      'NETTO 1234 KØBENHAVN DEN 12.03',
      'Netto 5521 Aarhus C  Den 03.04',
      'VISA/DANKORT NETTO 1234',
      'netto',
    ].map(merchantKey)

    expect(new Set(keys).size).toBe(1)
    expect(keys[0]).toBe('netto')
  })

  it('strips embedded dates in the forms banks use', () => {
    expect(merchantKey('REMA 1000 Den 12.03')).toBe('rema')
    expect(merchantKey('REMA 1000 d. 3/4')).toBe('rema')
    expect(merchantKey('REMA 1000 12-03-2026')).toBe('rema')
    expect(merchantKey('REMA 1000 2026-03-12')).toBe('rema')
  })

  it('strips card prefixes, references and receipt numbers', () => {
    expect(merchantKey('Kortkøb Matas Nota 449182')).toBe('matas')
    expect(merchantKey('Matas XX1234')).toBe('matas')
    expect(merchantKey('Matas ref: A8817263')).toBe('matas')
    expect(merchantKey('Matas 998877665544')).toBe('matas')
  })

  it('strips currency conversion tails from foreign purchases', () => {
    expect(merchantKey('Spotify AB kurs 7,4412')).toBe('spotify ab')
    expect(merchantKey('Steam Games 12,00 EUR')).toBe('steam games')
  })

  it('keeps multi-word chain names intact', () => {
    expect(merchantKey('CIRCLE K ROSKILDE')).toBe('circle k')
    expect(merchantKey('FITNESS WORLD AARHUS')).toBe('fitness world')
  })

  it('preserves Danish characters, since rules depend on them', () => {
    expect(merchantKey('FØTEX ODENSE')).toBe('føtex')
    expect(merchantKey('Ørsted Salg & Service')).toBe('ørsted salg & service')
  })

  it('returns empty when nothing identifying survives', () => {
    // An empty key must not become a merchant that matches everything.
    expect(merchantKey('123456')).toBe('')
    expect(merchantKey('')).toBe('')
    expect(merchantKey('   ')).toBe('')
  })
})

describe('merchantKeyShort', () => {
  it('keeps the first two meaningful words', () => {
    expect(merchantKeyShort('CIRCLE K ROSKILDE VESTERGADE')).toBe('circle k')
    expect(merchantKeyShort('NETTO 1234')).toBe('netto')
  })
})

describe('dedupText', () => {
  it('ignores punctuation and case differences between exports', () => {
    expect(dedupText('NETTO 1234, København')).toBe(dedupText('netto 1234 københavn'))
  })

  it('keeps digits, since they distinguish otherwise identical rows', () => {
    expect(dedupText('Netto 1234')).not.toBe(dedupText('Netto 5678'))
  })
})
