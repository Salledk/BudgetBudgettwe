import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import * as repo from './repo'

/**
 * Category ordering. `sortOrder` has always existed and `listCategories` has
 * always sorted by it, but nothing wrote it after the seed — so both the
 * reordering and where a new category lands are untested ground.
 */

async function reset() {
  await db.delete()
  await db.open()
  await repo.ensureSeeded()
}

const namesOf = async (kind?: string) =>
  (await repo.listCategories()).filter((c) => !kind || c.kind === kind).map((c) => c.name)

beforeEach(reset)

describe('reorderCategories', () => {
  it('applies the given order', async () => {
    const ids = (await repo.listCategories()).map((c) => c.id)
    const moved = [ids[3], ...ids.filter((id) => id !== ids[3])]

    await repo.reorderCategories(moved)

    expect((await repo.listCategories()).map((c) => c.id)).toEqual(moved)
  })

  it('leaves every other field alone', async () => {
    const before = (await repo.listCategories())[0]
    const ids = (await repo.listCategories()).map((c) => c.id)

    await repo.reorderCategories([...ids].reverse())

    const after = (await repo.listCategories()).find((c) => c.id === before.id)!
    expect(after.name).toBe(before.name)
    expect(after.kind).toBe(before.kind)
    expect(after.icon).toBe(before.icon)
    expect(after.periodMonths).toBe(before.periodMonths)
  })

  it('leaves no ties or gaps to run out of', async () => {
    // Renumbering wholesale is what keeps repeated moves from working their way
    // into equal sortOrders, where the list order would stop being defined.
    const ids = (await repo.listCategories()).map((c) => c.id)
    await repo.reorderCategories([...ids].reverse())

    const orders = (await repo.listCategories()).map((c) => c.sortOrder)
    expect(new Set(orders).size).toBe(orders.length)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
  })

  it('survives an id that no longer exists', async () => {
    const ids = (await repo.listCategories()).map((c) => c.id)
    await repo.reorderCategories(['slettet-for-længe-siden', ...ids])

    expect((await repo.listCategories()).map((c) => c.id)).toEqual(ids)
  })
})

describe('createCategory', () => {
  it('puts a new income category with the other income ones', async () => {
    // The system categories sort at 900+, so appending to the global end put
    // every new category — income included — below the whole expense list.
    await repo.createCategory({ name: 'Feriepenge', kind: 'income' })

    const income = await namesOf('income')
    expect(income.at(-1)).toBe('Feriepenge')

    const all = await namesOf()
    expect(all.indexOf('Feriepenge')).toBeLessThan(all.indexOf('Dagligvarer'))
  })

  it('puts a new expense category with the other expenses', async () => {
    await repo.createCategory({ name: 'Vaskeri', kind: 'expense' })

    const all = await namesOf()
    expect(all.indexOf('Vaskeri')).toBeGreaterThan(all.indexOf('Løn'))
    expect(all.indexOf('Vaskeri')).toBeLessThan(all.indexOf('Overførsel'))
  })

  it('keeps the order stable across several additions', async () => {
    await repo.createCategory({ name: 'Feriepenge', kind: 'income' })
    await repo.createCategory({ name: 'Vaskeri', kind: 'expense' })
    await repo.createCategory({ name: 'Bonus', kind: 'income' })

    const income = await namesOf('income')
    expect(income.slice(-2)).toEqual(['Feriepenge', 'Bonus'])
  })
})
