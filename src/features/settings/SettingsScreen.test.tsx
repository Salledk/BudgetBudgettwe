import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { db } from '@/data/db'
import * as repo from '@/data/repo'
import { AppDataProvider } from '@/app/useAppData'
import { newId } from '@/lib/id'
import { currentMonth } from '@/lib/dates'
import type { Category, Transaction } from '@/data/types'
import { SettingsScreen, reorderWithinGroup } from './SettingsScreen'

/** Editing categories and rules, which previously could only be created or deleted. */

const MONTH = currentMonth()

async function seed() {
  await db.delete()
  await db.open()
  await repo.ensureSeeded()

  const accounts = await repo.listAccounts()
  const groceries = (await repo.listCategories()).find((c) => c.name === 'Dagligvarer')!

  const tx: Transaction = {
    id: newId(),
    accountId: accounts[0].id,
    date: `${MONTH}-05`,
    postedDate: null,
    amountMinor: -25000,
    rawText: 'SLAGTER HANSEN',
    merchantKey: 'slagter hansen',
    counterparty: null,
    balanceAfterMinor: null,
    categoryId: null,
    categorySource: null,
    transferGroupId: null,
    importBatchId: 'batch',
    dedupHash: newId(),
    dedupKeys: [],
    externalId: null,
    notes: null,
    reviewed: false,
    updatedAt: Date.now(),
    deletedAt: null,
  }
  await repo.putTransactions([tx])
  return groceries
}

function renderScreen() {
  return render(
    <MemoryRouter>
      <AppDataProvider>
        <SettingsScreen />
      </AppDataProvider>
    </MemoryRouter>,
  )
}

async function openPanel(name: RegExp) {
  const button = await screen.findByRole('button', { name }, { timeout: 5000 })
  await userEvent.click(button)
}

/**
 * Every rule change ends by reporting how many transactions moved. Waiting for
 * that banner — rather than for the database alone — means the re-run and the
 * refresh behind it have finished, so nothing is still in flight when the next
 * test wipes the database.
 */
async function waitForRecategorisation() {
  await screen.findByText(/kategoriseret igen/, undefined, { timeout: 5000 })
}

beforeEach(seed)

describe('editing a category', () => {
  it('renames it', async () => {
    renderScreen()
    await openPanel(/^Kategorier/)

    await userEvent.click(await screen.findByRole('button', { name: 'Dagligvarer' }))
    const field = screen.getByLabelText(/Navn på Dagligvarer/)
    await userEvent.clear(field)
    await userEvent.type(field, 'Mad og drikke')
    await userEvent.click(screen.getByRole('button', { name: 'Gem' }))
    await screen.findByRole('button', { name: 'Mad og drikke' })

    const names = (await repo.listCategories()).map((c) => c.name)
    expect(names).toContain('Mad og drikke')
    expect(names).not.toContain('Dagligvarer')
  })

  it('changes its type', async () => {
    renderScreen()
    await openPanel(/^Kategorier/)

    await userEvent.click(await screen.findByRole('button', { name: 'Dagligvarer' }))
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'income')
    await userEvent.click(screen.getByRole('button', { name: 'Gem' }))

    // It should move under the Indkomst heading, not merely change a field.
    await waitFor(() => {
      const section = screen.getByRole('heading', { name: 'Indkomst' }).closest('section') as HTMLElement
      expect(within(section).getByRole('button', { name: 'Dagligvarer' })).toBeInTheDocument()
    })

    const c = (await repo.listCategories()).find((x) => x.name === 'Dagligvarer')!
    expect(c.kind).toBe('income')
  })

  it('will not let a system category change type', async () => {
    renderScreen()
    await openPanel(/^Kategorier/)

    // Transfers are excluded from every total by kind, so it must stay fixed.
    await userEvent.click(await screen.findByRole('button', { name: 'Overførsel' }))
    expect(screen.getByLabelText(/Navn på Overførsel/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Type')).not.toBeInTheDocument()
  })

  it('leaves the category alone when cancelled', async () => {
    renderScreen()
    await openPanel(/^Kategorier/)

    await userEvent.click(await screen.findByRole('button', { name: 'Dagligvarer' }))
    const field = screen.getByLabelText(/Navn på Dagligvarer/)
    await userEvent.clear(field)
    await userEvent.type(field, 'Noget andet')
    await userEvent.click(screen.getByRole('button', { name: 'Fortryd' }))

    const names = (await repo.listCategories()).map((c) => c.name)
    expect(names).toContain('Dagligvarer')
  })
})

describe('the periodic interval', () => {
  it('is saved from the editor and shown on the row', async () => {
    renderScreen()
    await openPanel(/^Kategorier/)

    await userEvent.click(await screen.findByRole('button', { name: 'Forsikring' }))
    await userEvent.selectOptions(screen.getByLabelText('Betales'), '12')
    await userEvent.click(screen.getByRole('button', { name: 'Gem' }))

    await waitFor(async () => {
      const c = (await repo.listCategories()).find((x) => x.name === 'Forsikring')!
      expect(c.periodMonths).toBe(12)
    })

    // The badge is the only thing that distinguishes a yearly bill from a
    // monthly one at a glance.
    const row = (await screen.findByRole('button', { name: 'Forsikring' })).closest('li') as HTMLElement
    expect(within(row).getByText('ÅRLIG')).toBeInTheDocument()
  })

  it('is discarded when the edit is cancelled', async () => {
    renderScreen()
    await openPanel(/^Kategorier/)

    await userEvent.click(await screen.findByRole('button', { name: 'Forsikring' }))
    await userEvent.selectOptions(screen.getByLabelText('Betales'), '3')
    await userEvent.click(screen.getByRole('button', { name: 'Fortryd' }))

    const c = (await repo.listCategories()).find((x) => x.name === 'Forsikring')!
    expect(c.periodMonths).toBeNull()
  })

  it('is not offered for an income category', async () => {
    renderScreen()
    await openPanel(/^Kategorier/)

    // Income has no recurring bill to spread over the year.
    await userEvent.click(await screen.findByRole('button', { name: 'Løn' }))
    expect(screen.queryByLabelText('Betales')).not.toBeInTheDocument()
  })

  it('appears as soon as the type is switched to expense', async () => {
    renderScreen()
    await openPanel(/^Kategorier/)

    await userEvent.click(await screen.findByRole('button', { name: 'Løn' }))
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'expense')

    // Reading the staged kind, so no save-and-reopen round trip is needed.
    expect(screen.getByLabelText('Betales')).toBeInTheDocument()
  })

  it('is cleared when a periodic category stops being an expense', async () => {
    const insurance = (await repo.listCategories()).find((c) => c.name === 'Forsikring')!
    await repo.updateCategory(insurance.id, { periodMonths: 12 })

    renderScreen()
    await openPanel(/^Kategorier/)

    await userEvent.click(await screen.findByRole('button', { name: 'Forsikring' }))
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'income')
    await userEvent.click(screen.getByRole('button', { name: 'Gem' }))

    // Left set, the interval would keep affecting nothing while still reading
    // as configured.
    await waitFor(async () => {
      const c = (await repo.listCategories()).find((x) => x.name === 'Forsikring')!
      expect(c.periodMonths).toBeNull()
    })
  })
})

describe('ordering categories', () => {
  it('groups them under Indkomst, Udgifter and Andre', async () => {
    renderScreen()
    await openPanel(/^Kategorier/)

    const income = (await screen.findByRole('heading', { name: 'Indkomst' })).closest('section') as HTMLElement
    const expense = screen.getByRole('heading', { name: 'Udgifter' }).closest('section') as HTMLElement

    expect(within(income).getByRole('button', { name: 'Løn' })).toBeInTheDocument()
    expect(within(income).queryByRole('button', { name: 'Dagligvarer' })).not.toBeInTheDocument()
    expect(within(expense).getByRole('button', { name: 'Dagligvarer' })).toBeInTheDocument()
  })

  it('gives every ordinary category a drag handle', async () => {
    renderScreen()
    await openPanel(/^Kategorier/)

    await screen.findByRole('button', { name: 'Dagligvarer' })
    expect(screen.getByRole('button', { name: 'Flyt Dagligvarer' })).toBeInTheDocument()
  })

  it('gives a system category no drag handle', async () => {
    renderScreen()
    await openPanel(/^Kategorier/)

    await screen.findByRole('button', { name: 'Overførsel' })
    expect(screen.queryByRole('button', { name: 'Flyt Overførsel' })).not.toBeInTheDocument()
  })
})

/*
 * The move itself is tested here rather than through the rendered list: both
 * pointer and keyboard dragging need element rectangles to decide what was
 * dropped where, and jsdom reports every element as zero-sized, so no drop
 * target is ever found. This is the rule that drag ends up applying.
 */
describe('reorderWithinGroup', () => {
  let cats: Category[]

  beforeEach(async () => {
    cats = await repo.listCategories()
  })

  const find = (name: string) => cats.find((c) => c.name === name)!

  it('moves a category down within its group', () => {
    const next = reorderWithinGroup(cats, find('Løn').id, find('Refusion').id)!
    const ids = cats.map((c) => c.id)

    expect(next).not.toBeNull()
    expect(next.indexOf(find('Løn').id)).toBe(ids.indexOf(find('Refusion').id))
    expect(next).toHaveLength(ids.length)
    expect(new Set(next).size).toBe(ids.length)
  })

  it('moves a category up within its group', () => {
    const next = reorderWithinGroup(cats, find('Gaver').id, find('Husleje').id)!
    expect(next[cats.map((c) => c.id).indexOf(find('Husleje').id)]).toBe(find('Gaver').id)
  })

  it('refuses to move a category across the income/expense line', () => {
    // Dropping under another heading would silently change the category's kind,
    // and with it whether its transactions count as money in or money out.
    expect(reorderWithinGroup(cats, find('Dagligvarer').id, find('Løn').id)).toBeNull()
    expect(reorderWithinGroup(cats, find('Løn').id, find('Dagligvarer').id)).toBeNull()
  })

  it('refuses to move a system category, or to displace one', () => {
    expect(reorderWithinGroup(cats, find('Overførsel').id, find('Opsparing').id)).toBeNull()
  })

  it('is a no-op when dropped on itself', () => {
    expect(reorderWithinGroup(cats, find('Løn').id, find('Løn').id)).toBeNull()
  })
})

describe('editing rules', () => {
  it('creates one and applies it to existing transactions', async () => {
    renderScreen()
    await openPanel(/^Regler/)

    await userEvent.click(await screen.findByRole('button', { name: '+ Ny regel' }))
    await userEvent.type(screen.getByLabelText(/Tekst der skal matches/), 'slagter hansen')

    const categories = await repo.listCategories()
    const groceries = categories.find((c) => c.name === 'Dagligvarer')!
    await userEvent.selectOptions(screen.getByLabelText('Kategori'), groceries.id)
    await userEvent.click(screen.getByRole('button', { name: 'Gem' }))
    await waitForRecategorisation()

    // A rule is only useful if it reaches what is already imported.
    const tx = (await repo.listTransactions())[0]
    expect(tx.categoryId).toBe(groceries.id)
  })

  it('retargets an existing rule and recategorises', async () => {
    const categories = await repo.listCategories()
    const groceries = categories.find((c) => c.name === 'Dagligvarer')!
    const gifts = categories.find((c) => c.name === 'Gaver')!
    await repo.createRule({ pattern: 'slagter hansen', categoryId: groceries.id })

    renderScreen()
    await openPanel(/^Regler/)

    await userEvent.click(await screen.findByRole('button', { name: /slagter hansen/ }))
    await userEvent.selectOptions(screen.getByLabelText('Kategori'), gifts.id)
    await userEvent.click(screen.getByRole('button', { name: 'Gem' }))
    await waitForRecategorisation()

    expect((await repo.listTransactions())[0].categoryId).toBe(gifts.id)
  })

  it('edits the pattern of a rule', async () => {
    const groceries = (await repo.listCategories()).find((c) => c.name === 'Dagligvarer')!
    await repo.createRule({ pattern: 'noget andet', categoryId: groceries.id })

    renderScreen()
    await openPanel(/^Regler/)

    await userEvent.click(await screen.findByRole('button', { name: /noget andet/ }))
    const field = screen.getByLabelText(/Tekst der skal matches/)
    await userEvent.clear(field)
    await userEvent.type(field, 'slagter')
    await userEvent.click(screen.getByRole('button', { name: 'Gem' }))
    await waitForRecategorisation()

    const rules = await repo.listAllRules()
    expect(rules.some((r) => r.pattern === 'slagter')).toBe(true)
    expect((await repo.listTransactions())[0].categoryId).toBe(groceries.id)
  })

  it('un-categorises when its rule is deleted', async () => {
    const groceries = (await repo.listCategories()).find((c) => c.name === 'Dagligvarer')!
    const rule = await repo.createRule({ pattern: 'slagter hansen', categoryId: groceries.id })
    await repo.setCategory([(await repo.listTransactions())[0].id], groceries.id, 'rule')

    renderScreen()
    await openPanel(/^Regler/)

    const row = (await screen.findByRole('button', { name: /slagter hansen/ })).closest('li') as HTMLElement
    await userEvent.click(within(row).getByRole('button', { name: 'Slet' }))
    await waitForRecategorisation()

    expect((await repo.listAllRules()).some((r) => r.id === rule.id)).toBe(false)
  })
})
