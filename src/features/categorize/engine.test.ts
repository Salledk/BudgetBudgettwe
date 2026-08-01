import { describe, expect, it } from 'vitest'
import { rule, tx } from '@/test/factories'
import { buildHistory, categorise, categoriseBatch, suggestRulePattern } from './engine'

describe('categorise', () => {
  it('matches a seed merchant rule', () => {
    const rules = [rule({ pattern: 'netto', categoryId: 'groceries' })]
    const result = categorise(tx({ rawText: 'NETTO 1234 KØBENHAVN DEN 12.03' }), rules)

    expect(result.categoryId).toBe('groceries')
    expect(result.source).toBe('seed')
  })

  it('lets a user rule beat a seed rule regardless of list order', () => {
    const rules = [
      rule({ id: 'user', pattern: 'netto', categoryId: 'household', source: 'user', priority: 1005 }),
      rule({ id: 'seed', pattern: 'netto', categoryId: 'groceries', source: 'seed', priority: 105 }),
    ]

    const result = categorise(tx({ rawText: 'NETTO 1234' }), rules)

    expect(result.categoryId).toBe('household')
    expect(result.source).toBe('rule')
    expect(result.ruleId).toBe('user')
  })

  it('matches against the cleaned merchant key as well as the raw text', () => {
    const rules = [rule({ pattern: 'circle k', categoryId: 'fuel' })]
    expect(categorise(tx({ rawText: 'CIRCLE K ROSKILDE' }), rules).categoryId).toBe('fuel')
  })

  it('supports exact matching on the merchant key', () => {
    const rules = [rule({ pattern: 'netto', matchType: 'exact', categoryId: 'groceries' })]

    expect(categorise(tx({ rawText: 'NETTO 1234 KØBENHAVN' }), rules).categoryId).toBe('groceries')
    expect(categorise(tx({ rawText: 'NETTO BAGERI SPECIAL' }), rules).categoryId).toBeNull()
  })

  it('survives a malformed user regex rather than failing the import', () => {
    const rules = [
      rule({ pattern: '[unclosed', matchType: 'regex', categoryId: 'x' }),
      rule({ pattern: 'netto', categoryId: 'groceries' }),
    ]

    expect(categorise(tx({ rawText: 'NETTO 1234' }), rules).categoryId).toBe('groceries')
  })

  it('ignores disabled rules', () => {
    const rules = [rule({ pattern: 'netto', categoryId: 'groceries', enabled: false })]
    expect(categorise(tx({ rawText: 'NETTO 1234' }), rules).categoryId).toBeNull()
  })

  it('returns no match rather than guessing', () => {
    expect(categorise(tx({ rawText: 'SOME UNKNOWN SHOP' }), []).categoryId).toBeNull()
  })
})

describe('word-start matching', () => {
  it('does not match a short pattern inside a hexadecimal reference', () => {
    // "3f" occurs constantly inside UUIDs; a plain substring match turned a
    // union-dues rule into 63 false positives on one real statement.
    const rules = [rule({ pattern: '3f', categoryId: 'union' })]

    expect(categorise(tx({ rawText: 'Autobahn Tank b530afe6-5d0c-3f2a' }), rules).categoryId).toBeNull()
    // A standalone token still matches.
    expect(categorise(tx({ rawText: '3F Fagforening' }), rules).categoryId).toBe('union')
  })

  it('does not match a pattern inside an ordinary word', () => {
    const rules = [rule({ pattern: 'ase', categoryId: 'union' })]

    expect(categorise(tx({ rawText: 'Jesper Kron Andreasen' }), rules).categoryId).toBeNull()
    expect(categorise(tx({ rawText: 'PARKHAUSER BASEL-STADT' }), rules).categoryId).toBeNull()
    expect(categorise(tx({ rawText: 'ASE A-kasse' }), rules).categoryId).toBe('union')
  })

  it('distinguishes "sport" from "transport"', () => {
    const rules = [rule({ pattern: 'sport', categoryId: 'leisure' })]

    expect(categorise(tx({ rawText: 'Transport Movia' }), rules).categoryId).toBeNull()
    expect(categorise(tx({ rawText: 'SPORT HAGLEITNER' }), rules).categoryId).toBe('leisure')
  })

  it('still matches names the bank runs together with other text', () => {
    // Real exports produce "LIDL281KBENHAVNNVTUBOR" for a Lidl purchase.
    const rules = [rule({ pattern: 'lidl', categoryId: 'groceries' })]
    expect(categorise(tx({ rawText: 'LIDL281KBENHAVNNVTUBOR' }), rules).categoryId).toBe('groceries')
  })

  it('handles Danish letters at the boundary', () => {
    const rules = [rule({ pattern: 'rente', categoryId: 'interest' })]

    expect(categorise(tx({ rawText: 'Rente' }), rules).categoryId).toBe('interest')
    // "ø" is a letter, so "børenteX" must not count as a word start.
    expect(categorise(tx({ rawText: 'børente' }), rules).categoryId).toBeNull()
  })

  it('treats a pattern with regex characters literally', () => {
    const rules = [rule({ pattern: 'apple.com/bill', categoryId: 'subs' })]

    expect(categorise(tx({ rawText: 'APPLE.COM/BILL' }), rules).categoryId).toBe('subs')
    // The dot must not act as a wildcard.
    expect(categorise(tx({ rawText: 'applexcom/bill' }), rules).categoryId).toBeNull()
  })
})

describe('learned layer', () => {
  it('reuses a category the user has applied consistently', () => {
    const history = buildHistory(new Map([['slagter hansen', new Map([['groceries', 4]])]]))
    const result = categorise(tx({ rawText: 'SLAGTER HANSEN 998' }), [], history)

    expect(result.categoryId).toBe('groceries')
    expect(result.source).toBe('learned')
  })

  it('stays quiet until there is enough evidence', () => {
    const history = buildHistory(new Map([['slagter hansen', new Map([['groceries', 1]])]]))
    expect(categorise(tx({ rawText: 'SLAGTER HANSEN' }), [], history).categoryId).toBeNull()
  })

  it('stays quiet when past choices disagree', () => {
    // Split history is not a signal — guessing here would be wrong half the time.
    const history = buildHistory(new Map([['bilka', new Map([['groceries', 3], ['household', 3]])]]))
    expect(categorise(tx({ rawText: 'BILKA HORSENS' }), [], history).categoryId).toBeNull()
  })

  it('applies the dominant category when history is lopsided', () => {
    const history = buildHistory(new Map([['bilka', new Map([['groceries', 9], ['household', 1]])]]))
    expect(categorise(tx({ rawText: 'BILKA HORSENS' }), [], history).categoryId).toBe('groceries')
  })

  it('never outranks a rule', () => {
    const rules = [rule({ pattern: 'bilka', categoryId: 'groceries' })]
    const history = buildHistory(new Map([['bilka', new Map([['household', 10]])]]))

    expect(categorise(tx({ rawText: 'BILKA' }), rules, history).source).toBe('seed')
  })
})

describe('categoriseBatch', () => {
  it('never overwrites a manual choice', () => {
    const rules = [rule({ pattern: 'netto', categoryId: 'groceries' })]
    const rows = [tx({ rawText: 'NETTO 1234', categoryId: 'gifts', categorySource: 'manual' })]

    expect(categoriseBatch(rows, rules, buildHistory(new Map())).updated).toHaveLength(0)
  })

  it('never overwrites a detected transfer', () => {
    const rules = [rule({ pattern: 'overførsel', categoryId: 'misc' })]
    const rows = [tx({ rawText: 'Overførsel til opsparing', transferGroupId: 'g1' })]

    expect(categoriseBatch(rows, rules, buildHistory(new Map())).updated).toHaveLength(0)
  })

  it('marks rule matches as reviewed but sends learned guesses for review', () => {
    const rules = [rule({ pattern: 'netto', categoryId: 'groceries' })]
    const history = buildHistory(new Map([['slagter hansen', new Map([['groceries', 5]])]]))
    const rows = [tx({ rawText: 'NETTO 1234' }), tx({ rawText: 'SLAGTER HANSEN' })]

    const { updated } = categoriseBatch(rows, rules, history)

    expect(updated.find((t) => t.rawText === 'NETTO 1234')?.reviewed).toBe(true)
    expect(updated.find((t) => t.rawText === 'SLAGTER HANSEN')?.reviewed).toBe(false)
  })

  it('counts rule hits for the rules list', () => {
    const rules = [rule({ id: 'r1', pattern: 'netto', categoryId: 'groceries' })]
    const rows = [tx({ rawText: 'NETTO 1' }), tx({ rawText: 'NETTO 2' }), tx({ rawText: 'FØTEX' })]

    const { ruleHits } = categoriseBatch(rows, rules, buildHistory(new Map()))

    expect(ruleHits.get('r1')).toBe(2)
  })
})

describe('suggestRulePattern', () => {
  it('proposes the chain name', () => {
    expect(suggestRulePattern('NETTO 1234 KØBENHAVN DEN 12.03')).toBe('netto')
    expect(suggestRulePattern('CIRCLE K ROSKILDE')).toBe('circle k')
  })

  it('refuses generic payment wording that would match everything', () => {
    expect(suggestRulePattern('MobilePay Anders')).toBeNull()
    expect(suggestRulePattern('Overførsel')).toBeNull()
    expect(suggestRulePattern('Betalingsservice')).toBeNull()
  })

  it('refuses when nothing identifying remains', () => {
    expect(suggestRulePattern('123456')).toBeNull()
    expect(suggestRulePattern('')).toBeNull()
  })
})
