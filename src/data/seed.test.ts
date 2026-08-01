import { describe, expect, it } from 'vitest'
import { categorise } from '@/features/categorize/engine'
import { merchantKey } from '@/lib/normalize'
import { buildSeedCategories, buildSeedRules } from './seed'
import { SYSTEM_CATEGORY } from './types'

/**
 * The seed rules are the difference between an app that categorises most of a
 * Danish statement on import and one that presents an undifferentiated list.
 * These cases come from descriptions that appear in real exports.
 */

const categories = buildSeedCategories(1)
const rules = buildSeedRules(categories, 1)
const nameById = new Map(categories.map((c) => [c.id, c.name]))

function categoryFor(rawText: string): string | null {
  const result = categorise({ rawText, merchantKey: merchantKey(rawText), amountMinor: -1000 }, rules)
  return result.categoryId ? (nameById.get(result.categoryId) ?? result.categoryId) : null
}

describe('internal transfers', () => {
  it('recognises an account name used as the whole description', () => {
    // Several banks export one account at a time and label the transfer with
    // the other account's name. The counterpart may never be imported, so
    // pairing cannot catch these — only a rule can.
    expect(categoryFor('Budget')).toBe('Overførsel')
    expect(categoryFor('Savings')).toBe('Overførsel')
    expect(categoryFor('Opsparing')).toBe('Overførsel')
    expect(categoryFor('OVERFØRSEL')).toBe('Overførsel')
  })

  it('catches a savings transfer with a suffix', () => {
    expect(categoryFor('Savings / udlæg')).toBe('Overførsel')
  })

  it('does not swallow a shop whose name merely begins with Budget', () => {
    // Matched exactly, so an actual business is safe.
    expect(categoryFor('Budget Rent a Car Kastrup')).not.toBe('Overførsel')
  })

  it('maps transfers to the system category, so totals exclude them', () => {
    const result = categorise({ rawText: 'Budget', merchantKey: 'budget', amountMinor: -1000 }, rules)
    expect(result.categoryId).toBe(SYSTEM_CATEGORY.transfer)
  })
})

describe('income', () => {
  it('recognises abbreviated salary transfers', () => {
    expect(categoryFor('LØNOVER.')).toBe('Løn')
    expect(categoryFor('LØNOVER. 2811842527')).toBe('Løn')
    expect(categoryFor('LØNOVERFØRSEL ARBEJDSGIVER A/S')).toBe('Løn')
  })

  it('recognises public benefits and interest', () => {
    expect(categoryFor('BØRNE- OG UNGEYDELSE')).toBe('Offentlige ydelser')
    expect(categoryFor('Rente')).toBe('Renter')
    expect(categoryFor('FK-FERIEPENGE')).toBe('Løn')
  })
})

describe('merchants', () => {
  const cases: Array<[string, string]> = [
    ['NETTO 1234 KØBENHAVN DEN 12.03', 'Dagligvarer'],
    ['FØTEX 5521 AARHUS C', 'Dagligvarer'],
    ['Rema 1000 Odense', 'Dagligvarer'],
    ['LIDL281KBENHAVNNVTUBOR', 'Dagligvarer'],
    ['Inco Cash & Carry', 'Dagligvarer'],
    ['Elite Købmand', 'Dagligvarer'],
    ['Circle K Roskilde', 'Bil & brændstof'],
    ['Autobahn Tank& Rast Be', 'Bil & brændstof'],
    ['thansen', 'Bil & brændstof'],
    ['SPOTIFY AB', 'Abonnementer'],
    ['OpenAI', 'Abonnementer'],
    ['IKEA Gentofte', 'Hjem & husholdning'],
    ['Proshop', 'Hjem & husholdning'],
    ['Vinted', 'Tøj & sko'],
    ['DECATHLON INTERLAKEN', 'Fritid & hobby'],
    ['Eventyrsport', 'Fritid & hobby'],
    ['Bodenhoffs Bageri', 'Café'],
    ['Parkman', 'Transport'],
    ['LÆRERSTANDENS ONLINE', 'Forsikring'],
  ]

  it.each(cases)('categorises %s as %s', (text, expected) => {
    expect(categoryFor(text)).toBe(expected)
  })

  it('leaves person-to-person payments alone', () => {
    // The payee is the only real signal, and guessing wrong is worse than
    // leaving these for the user to classify once.
    expect(categoryFor('MobilePay Maja Bang Jakobsen')).toBeNull()
    expect(categoryFor('Jesper Kron Andreasen')).toBeNull()
    expect(categoryFor('Heidi Raunskov P')).toBeNull()
  })
})

describe('seed integrity', () => {
  it('points every rule at a category that exists', () => {
    const ids = new Set(categories.map((c) => c.id))
    for (const r of rules) expect(ids.has(r.categoryId)).toBe(true)
  })

  it('ranks transfer rules above merchant rules', () => {
    const transferRules = rules.filter((r) => r.categoryId === SYSTEM_CATEGORY.transfer)
    const merchantRules = rules.filter((r) => r.categoryId !== SYSTEM_CATEGORY.transfer)
    const lowestTransfer = Math.min(...transferRules.map((r) => r.priority))
    const highestMerchant = Math.max(...merchantRules.map((r) => r.priority))

    expect(lowestTransfer).toBeGreaterThan(highestMerchant)
  })

  it('has no pattern short enough to match noise', () => {
    for (const r of rules) {
      expect(r.pattern.trim().length).toBeGreaterThanOrEqual(2)
    }
  })
})
