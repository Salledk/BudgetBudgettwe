import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/data/db'
import * as repo from '@/data/repo'
import { SYSTEM_CATEGORY } from '@/data/types'
import { buildFixture, csvFile } from '@/test/fixture'
import { suggestBudget } from '@/features/budget/suggest'
import { projectMonth } from '@/features/projections/project'
import { guessMapping, readFile } from './parse'
import { recategoriseAll, runImport } from './runImport'

/**
 * End-to-end through the real database: import → dedup → transfer pairing →
 * auto-categorisation → budget suggestion → projection. These are the paths
 * where a bug silently produces plausible-but-wrong money figures.
 */

const fixture = buildFixture()

async function reset() {
  await db.delete()
  await db.open()
  await repo.ensureSeeded()
}

async function accountsByKind() {
  const accounts = await repo.listAccounts()
  return {
    budget: accounts.find((a) => a.kind === 'budget')!,
    spending: accounts.find((a) => a.kind === 'spending')!,
    savings: accounts.find((a) => a.kind === 'savings')!,
  }
}

async function importAll() {
  const accounts = await accountsByKind()
  const results = []
  for (const kind of ['budget', 'spending', 'savings'] as const) {
    const table = await readFile(csvFile(fixture.csv[kind], `${kind}.csv`))
    results.push(
      await runImport({
        table,
        mapping: guessMapping(table),
        accountId: accounts[kind].id,
        fileName: `${kind}.csv`,
        saveProfile: true,
      }),
    )
  }
  return results
}

beforeEach(reset)

describe('column guessing', () => {
  it('reads a Danish semicolon export without help', async () => {
    const table = await readFile(csvFile(fixture.csv.spending))
    const mapping = guessMapping(table)

    expect(mapping.dateColumn).toBe('Bogføringsdato')
    expect(mapping.dateFormat).toBe('dd-MM-yyyy')
    expect(mapping.amountColumn).toBe('Beløb')
    expect(mapping.balanceColumn).toBe('Saldo')
    expect(mapping.descriptionColumns).toEqual(['Tekst'])
    expect(mapping.amountMode).toBe('single')
  })

  it('preserves Danish characters through parsing', async () => {
    const table = await readFile(csvFile(fixture.csv.budget))
    const texts = table.rows.map((r) => r['Tekst']).join(' ')

    expect(texts).toContain('LØNOVERFØRSEL')
    expect(texts).toContain('ØRSTED')
    expect(texts).not.toContain('Ã') // the mojibake signature of a bad decode
  })
})

describe('import pipeline', () => {
  it('imports every row and reports honest counts', async () => {
    const results = await importAll()

    for (const r of results) {
      expect(r.inserted).toBeGreaterThan(0)
      expect(r.duplicates).toBe(0)
      // Every row in the fixture is a valid transaction.
      expect(r.inserted + r.issues.length).toBe(r.totalRows)
      expect(r.issues).toHaveLength(0)
    }

    const stored = await repo.listTransactions()
    expect(stored.length).toBe(results.reduce((sum, r) => sum + r.inserted, 0))
  })

  it('imports nothing on a second pass over the same files', async () => {
    await importAll()
    const before = (await repo.listTransactions()).length

    const second = await importAll()

    expect((await repo.listTransactions()).length).toBe(before)
    for (const r of second) {
      expect(r.inserted).toBe(0)
      expect(r.duplicates).toBeGreaterThan(0)
    }
  })

  it('keeps two identical same-day purchases', async () => {
    await importAll()
    const stored = await repo.listTransactions()
    const coffees = stored.filter((t) => t.rawText.includes('BARESSO') && t.date === '2026-03-12')

    expect(coffees).toHaveLength(fixture.expected.duplicatedPurchases)
  })

  it('pairs transfers between the user’s own accounts', async () => {
    await importAll()
    const stored = await repo.listTransactions()
    const paired = stored.filter((t) => t.transferGroupId !== null)

    expect(paired.length).toBe(fixture.expected.transferPairs * 2)
    expect(paired.every((t) => t.categoryId === SYSTEM_CATEGORY.transfer)).toBe(true)

    // Each group holds exactly one outflow and one inflow.
    const groups = new Map<string, number[]>()
    for (const t of paired) {
      const list = groups.get(t.transferGroupId!) ?? []
      list.push(t.amountMinor)
      groups.set(t.transferGroupId!, list)
    }
    for (const amounts of groups.values()) {
      expect(amounts).toHaveLength(2)
      expect(amounts[0] + amounts[1]).toBe(0)
    }
  })

  it('auto-categorises the great majority of transactions', async () => {
    await importAll()
    const stored = await repo.listTransactions()
    const categorised = stored.filter((t) => t.categoryId !== null)

    expect(categorised.length / stored.length).toBeGreaterThan(0.9)
  })

  it('routes known Danish merchants to the right categories', async () => {
    await importAll()
    const stored = await repo.listTransactions()
    const categories = await repo.listCategories()
    const nameById = new Map(categories.map((c) => [c.id, c.name]))

    const nameFor = (needle: string) => {
      const t = stored.find((x) => x.rawText.includes(needle))
      return t?.categoryId ? nameById.get(t.categoryId) : null
    }

    expect(nameFor('NETTO')).toBe('Dagligvarer')
    expect(nameFor('FØTEX')).toBe('Dagligvarer')
    expect(nameFor('CIRCLE K')).toBe('Bil & brændstof')
    expect(nameFor('SPOTIFY')).toBe('Abonnementer')
    expect(nameFor('HUSLEJE')).toBe('Husleje')
    expect(nameFor('ØRSTED')).toBe('El, vand & varme')
    expect(nameFor('TRYG FORSIKRING')).toBe('Forsikring')
  })

  it('undoes a whole batch, unpairing the transfers it created', async () => {
    const [budgetResult] = await importAll()
    const before = (await repo.listTransactions()).length

    const removed = await repo.undoImportBatch(budgetResult.batchId)
    const after = await repo.listTransactions()

    expect(removed).toBe(budgetResult.inserted)
    expect(after.length).toBe(before - budgetResult.inserted)
    // The surviving halves are no longer marked as transfers.
    expect(after.filter((t) => t.transferGroupId !== null)).toHaveLength(0)
  })

  it('reuses a saved bank profile for a file with the same layout', async () => {
    await importAll()
    const table = await readFile(csvFile(fixture.csv.spending))
    const profile = await repo.findBankProfile(table.headerSignature)

    expect(profile).toBeDefined()
    expect(profile?.dateColumn).toBe('Bogføringsdato')
  })
})

describe('rules learned from manual correction', () => {
  it('back-fills past transactions when a rule is created', async () => {
    await importAll()
    const categories = await repo.listCategories()
    const gifts = categories.find((c) => c.name === 'Gaver')!

    const stored = await repo.listTransactions()
    const baresso = stored.filter((t) => t.rawText.includes('BARESSO'))
    expect(baresso.length).toBeGreaterThan(0)

    await repo.createRule({ pattern: 'baresso', categoryId: gifts.id })
    await recategoriseAll()

    const after = await repo.listTransactions()
    const recategorised = after.filter((t) => t.rawText.includes('BARESSO'))
    expect(recategorised.every((t) => t.categoryId === gifts.id)).toBe(true)
  })

  it('leaves manual choices untouched when rules are re-run', async () => {
    await importAll()
    const categories = await repo.listCategories()
    const gifts = categories.find((c) => c.name === 'Gaver')!

    const stored = await repo.listTransactions()
    const netto = stored.find((t) => t.rawText.includes('NETTO'))!
    await repo.setCategory([netto.id], gifts.id, 'manual')

    await recategoriseAll()

    const after = await repo.getTransaction(netto.id)
    expect(after?.categoryId).toBe(gifts.id)
    expect(after?.categorySource).toBe('manual')
  })
})

describe('budget suggestion from imported history', () => {
  it('derives a budget that matches the fixture’s habits', async () => {
    await importAll()
    const [transactions, categories] = await Promise.all([repo.listTransactions(), repo.listCategories()])

    const result = suggestBudget({ transactions, categories, months: fixture.months })

    expect(result.categories.length).toBeGreaterThan(3)

    // Rent is fixed at 8.500 every month and must be recognised as such.
    const rent = result.categories.find((c) => c.categoryName === 'Husleje')!
    expect(rent.pattern).toBe('recurring')
    expect(rent.suggestedMinor).toBe(850000)

    // Groceries vary; the suggestion must sit inside the observed range.
    const groceries = result.categories.find((c) => c.categoryName === 'Dagligvarer')!
    expect(groceries.pattern).toBe('variable')
    expect(groceries.suggestedMinor).toBeGreaterThanOrEqual(groceries.minMinor)
    expect(groceries.suggestedMinor).toBeLessThanOrEqual(groceries.maxMinor)

    // Salary is projected, never budgeted.
    expect(result.expectedIncomeMinor).toBeGreaterThan(3_000_000)
    expect(result.categories.find((c) => c.categoryName === 'Løn')).toBeUndefined()

    // Transfers must not appear as a spending category.
    expect(result.categories.find((c) => c.categoryName === 'Overførsel')).toBeUndefined()
  })

  it('isolates the annual insurance premium from the monthly figure', async () => {
    await importAll()
    const [transactions, categories] = await Promise.all([repo.listTransactions(), repo.listCategories()])

    const result = suggestBudget({ transactions, categories, months: fixture.months })
    const insurance = result.categories.find((c) => c.categoryName === 'Forsikring')

    // The premium lands in one month only, so it must not become a monthly budget.
    if (insurance) expect(insurance.suggestedMinor).toBeLessThan(640000)
  })

  it('keeps the suggested budget within projected income', async () => {
    await importAll()
    const [transactions, categories] = await Promise.all([repo.listTransactions(), repo.listCategories()])

    const result = suggestBudget({ transactions, categories, months: fixture.months })

    // The fixture person lives within their means; the suggestion should say so.
    expect(result.headroomMinor).toBeGreaterThan(0)
  })
})

describe('projection over imported data', () => {
  it('reports a completed month as actuals and flags an exceeded budget', async () => {
    await importAll()
    const [transactions, categories] = await Promise.all([repo.listTransactions(), repo.listCategories()])

    const month = fixture.months.at(-1)!
    const groceries = categories.find((c) => c.name === 'Dagligvarer')!

    // Deliberately under-budget groceries so the alert path is exercised.
    await repo.setBudget(month, groceries.id, 50000, 'user')
    const budgets = await repo.budgetMap(month)

    const projection = projectMonth({
      month,
      transactions,
      categories,
      budgets,
      historyMonths: fixture.months.slice(0, -1),
      now: new Date(2027, 0, 1), // long after the fixture window
    })

    const row = projection.categories.find((c) => c.categoryId === groceries.id)!
    expect(row.status).toBe('over')
    expect(row.message).toContain('over')
    expect(projection.alerts.length).toBeGreaterThan(0)
    expect(projection.isCurrentMonth).toBe(false)
    // A finished month is reported, not extrapolated.
    expect(row.projectedMinor).toBe(row.actualMinor)
  })

  it('excludes internal transfers from the month’s income and expense', async () => {
    await importAll()
    const [transactions, categories] = await Promise.all([repo.listTransactions(), repo.listCategories()])

    const month = fixture.months.at(-1)!
    const projection = projectMonth({
      month,
      transactions,
      categories,
      budgets: new Map(),
      historyMonths: fixture.months.slice(0, -1),
      now: new Date(2027, 0, 1),
    })

    // Salary is ~32.000. Were the 9.000 and 2.500 transfers counted, income
    // would be inflated by 11.500 and expenses by the same.
    expect(projection.incomeMinor).toBeGreaterThan(3_100_000)
    expect(projection.incomeMinor).toBeLessThan(3_300_000)
  })
})

describe('backup round-trip', () => {
  it('restores every record exactly', async () => {
    await importAll()
    const before = await repo.listTransactions()
    const backup = await repo.exportBackup()

    await repo.clearAllData()
    expect((await repo.listTransactions()).length).toBe(0)

    await repo.importBackup(JSON.parse(JSON.stringify(backup)))
    const after = await repo.listTransactions()

    expect(after.length).toBe(before.length)
    expect(after.map((t) => t.id).sort()).toEqual(before.map((t) => t.id).sort())
  })

  it('refuses a file that is not one of our backups', async () => {
    await expect(repo.importBackup({ format: 'something-else' } as never)).rejects.toThrow()
  })
})
