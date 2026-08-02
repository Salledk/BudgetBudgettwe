import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { db } from '@/data/db'
import * as repo from '@/data/repo'
import { AppDataProvider } from '@/app/useAppData'
import { newId } from '@/lib/id'
import { currentMonth } from '@/lib/dates'
import type { Transaction } from '@/data/types'
import { SettingsScreen } from './SettingsScreen'

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

    await userEvent.click(await screen.findByRole('button', { name: /Dagligvarer/ }))
    const field = screen.getByLabelText(/Navn på Dagligvarer/)
    await userEvent.clear(field)
    await userEvent.type(field, 'Mad og drikke')
    await userEvent.click(screen.getByRole('button', { name: 'Gem' }))
    await screen.findByRole('button', { name: /Mad og drikke/ })

    const names = (await repo.listCategories()).map((c) => c.name)
    expect(names).toContain('Mad og drikke')
    expect(names).not.toContain('Dagligvarer')
  })

  it('changes its type', async () => {
    renderScreen()
    await openPanel(/^Kategorier/)

    await userEvent.click(await screen.findByRole('button', { name: /Dagligvarer/ }))
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'income')
    await userEvent.click(screen.getByRole('button', { name: 'Gem' }))
    await screen.findByRole('button', { name: /Dagligvarer INDKOMST/ })

    const c = (await repo.listCategories()).find((x) => x.name === 'Dagligvarer')!
    expect(c.kind).toBe('income')
  })

  it('will not let a system category change type', async () => {
    renderScreen()
    await openPanel(/^Kategorier/)

    // Transfers are excluded from every total by kind, so it must stay fixed.
    await userEvent.click(await screen.findByRole('button', { name: /Overførsel/ }))
    expect(screen.getByLabelText(/Navn på Overførsel/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Type')).not.toBeInTheDocument()
  })

  it('leaves the category alone when cancelled', async () => {
    renderScreen()
    await openPanel(/^Kategorier/)

    await userEvent.click(await screen.findByRole('button', { name: /Dagligvarer/ }))
    const field = screen.getByLabelText(/Navn på Dagligvarer/)
    await userEvent.clear(field)
    await userEvent.type(field, 'Noget andet')
    await userEvent.click(screen.getByRole('button', { name: 'Fortryd' }))

    const names = (await repo.listCategories()).map((c) => c.name)
    expect(names).toContain('Dagligvarer')
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
