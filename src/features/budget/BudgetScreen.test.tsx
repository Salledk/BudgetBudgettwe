import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { db } from '@/data/db'
import * as repo from '@/data/repo'
import { AppDataProvider } from '@/app/useAppData'
import { newId } from '@/lib/id'
import { currentMonth } from '@/lib/dates'
import type { Transaction } from '@/data/types'
import { BudgetScreen } from './BudgetScreen'

/**
 * Typing an amount, exercised with real keystrokes.
 *
 * This exists because the browser check that was supposed to cover it used
 * Playwright's `fill()`, which clears the field first. That hid a field seeded
 * with a formatted "3.700,00" and never selected on focus: typing appended, and
 * the resulting "3.700,004000" happened to parse back to the original amount,
 * so a new figure was silently discarded. Only real typing catches that.
 */

const MONTH = currentMonth()

async function seed(amountMinor: number) {
  await db.delete()
  await db.open()
  await repo.ensureSeeded()

  const accounts = await repo.listAccounts()
  const categories = await repo.listCategories()
  const groceries = categories.find((c) => c.name === 'Dagligvarer')!

  const tx: Transaction = {
    id: newId(),
    accountId: accounts[0].id,
    date: `${MONTH}-05`,
    postedDate: null,
    amountMinor: -25000,
    rawText: 'NETTO 1234',
    merchantKey: 'netto',
    counterparty: null,
    balanceAfterMinor: null,
    categoryId: groceries.id,
    categorySource: 'manual',
    transferGroupId: null,
    importBatchId: 'batch',
    dedupHash: newId(),
    dedupKeys: [],
    externalId: null,
    notes: null,
    reviewed: true,
    updatedAt: Date.now(),
    deletedAt: null,
  }
  await repo.putTransactions([tx])
  await repo.setDefaultBudget(groceries.id, amountMinor)
  return groceries
}

function renderScreen() {
  return render(
    <MemoryRouter>
      <AppDataProvider>
        <BudgetScreen />
      </AppDataProvider>
    </MemoryRouter>,
  )
}

/** The row for a category, once the screen has loaded. */
async function rowFor(name: string): Promise<HTMLElement> {
  const heading = await screen.findByText(name, {}, { timeout: 5000 })
  return heading.closest('li') as HTMLElement
}

beforeEach(async () => {
  await seed(370000) // 3.700 kr
})

describe('editing a budget amount', () => {
  it('opens with plain whole kroner rather than a formatted amount', async () => {
    renderScreen()
    const row = await rowFor('Dagligvarer')
    await userEvent.click(within(row).getByRole('button', { name: /3\.700/ }))

    const field = within(row).getByLabelText(/Budget for Dagligvarer/)
    // "3.700,00" was awkward to type over and did not match the button.
    expect(field).toHaveValue('3700')
  })

  it('selects the whole amount so typing replaces it', async () => {
    renderScreen()
    const row = await rowFor('Dagligvarer')
    await userEvent.click(within(row).getByRole('button', { name: /3\.700/ }))

    const field = within(row).getByLabelText(/Budget for Dagligvarer/) as HTMLInputElement

    // This selection is what makes a keystroke replace the amount rather than
    // extend it. Asserted directly because `userEvent.type` appends regardless
    // of selection, so typing here would not exercise the real behaviour.
    expect(document.activeElement).toBe(field)
    expect(field.selectionStart).toBe(0)
    expect(field.selectionEnd).toBe(field.value.length)
  })

  it('saves a replacement amount', async () => {
    renderScreen()
    const row = await rowFor('Dagligvarer')
    await userEvent.click(within(row).getByRole('button', { name: /3\.700/ }))

    const field = within(row).getByLabelText(/Budget for Dagligvarer/)
    await userEvent.clear(field)
    await userEvent.type(field, '4000')
    expect(field).toHaveValue('4000')

    await userEvent.click(within(row).getByRole('button', { name: 'Gem' }))

    // The month view is the default scope, so this writes an override.
    await waitFor(async () => {
      const resolved = await repo.budgetMap(MONTH)
      const groceries = (await repo.listCategories()).find((c) => c.name === 'Dagligvarer')!
      expect(resolved.get(groceries.id)?.amountMinor).toBe(400000)
    })
  })

  it('keeps the editor open and explains itself on unreadable input', async () => {
    renderScreen()
    const row = await rowFor('Dagligvarer')
    await userEvent.click(within(row).getByRole('button', { name: /3\.700/ }))

    const field = within(row).getByLabelText(/Budget for Dagligvarer/)
    await userEvent.type(field, 'abc')
    await userEvent.click(within(row).getByRole('button', { name: 'Gem' }))

    // Previously this closed silently and kept the old figure.
    expect(within(row).getByText(/Skriv et beløb/)).toBeInTheDocument()
    expect(field).toBeInTheDocument()
    expect((await repo.listBudgets(MONTH))).toHaveLength(0)
  })

  it('leaves the amount untouched when cancelled', async () => {
    renderScreen()
    const row = await rowFor('Dagligvarer')
    await userEvent.click(within(row).getByRole('button', { name: /3\.700/ }))

    const field = within(row).getByLabelText(/Budget for Dagligvarer/)
    await userEvent.type(field, '9999')
    await userEvent.click(within(row).getByRole('button', { name: 'Fortryd' }))

    expect((await repo.listBudgets(MONTH))).toHaveLength(0)
  })

  it('accepts a Danish grouped amount too', async () => {
    renderScreen()
    const row = await rowFor('Dagligvarer')
    await userEvent.click(within(row).getByRole('button', { name: /3\.700/ }))

    const field = within(row).getByLabelText(/Budget for Dagligvarer/)
    await userEvent.clear(field)
    await userEvent.type(field, '4.250')
    await userEvent.click(within(row).getByRole('button', { name: 'Gem' }))

    await waitFor(async () => {
      const resolved = await repo.budgetMap(MONTH)
      const groceries = (await repo.listCategories()).find((c) => c.name === 'Dagligvarer')!
      expect(resolved.get(groceries.id)?.amountMinor).toBe(425000)
    })
  })
})
