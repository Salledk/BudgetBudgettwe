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
