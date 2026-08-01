/**
 * Generates a realistic Danish bank export for end-to-end testing.
 *
 * Deliberately includes the things that break naive importers: semicolon
 * delimiters, comma decimals, dotted thousands separators, dd-MM-yyyy dates,
 * internal transfers between the user's own accounts, a duplicated same-day
 * purchase, and one annual insurance premium.
 */

export interface FixtureOptions {
  months?: number
  /** Month the data ends in, exclusive of the current month. */
  endMonth?: string
  seed?: number
}

/** Deterministic PRNG so a failing test is reproducible. */
function rng(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

const GROCERIES = ['NETTO 1234 KØBENHAVN', 'FØTEX 5521 AARHUS C', 'REMA 1000 ODENSE', 'LIDL 8812 VALBY', 'BILKA HORSENS']
const DINING = ['MCDONALDS NØRREPORT', 'WOLT DENMARK', 'SUNSET BOULEVARD', 'JOE AND THE JUICE']
const FUEL = ['CIRCLE K ROSKILDE', 'Q8 GLOSTRUP', 'SHELL HERNING']
const SUBS = ['SPOTIFY AB', 'NETFLIX.COM', 'VIAPLAY GROUP']

function dkk(minor: number): string {
  const kr = Math.floor(Math.abs(minor) / 100)
  const ore = Math.abs(minor) % 100
  const grouped = kr.toLocaleString('da-DK')
  return `${minor < 0 ? '-' : ''}${grouped},${String(ore).padStart(2, '0')}`
}

function ddmmyyyy(y: number, m: number, d: number): string {
  return `${String(d).padStart(2, '0')}-${String(m).padStart(2, '0')}-${y}`
}

export interface FixtureResult {
  /** CSV text for each account, keyed by account kind. */
  csv: Record<'budget' | 'spending' | 'savings', string>
  months: string[]
  /** Counts the tests assert against. */
  expected: {
    transferPairs: number
    duplicatedPurchases: number
    insurancePremiums: number
  }
}

export function buildFixture(options: FixtureOptions = {}): FixtureResult {
  const monthCount = options.months ?? 6
  const random = rng(options.seed ?? 42)

  // Anchor to a fixed past window so tests never depend on the current date.
  const endYear = 2026
  const endMonth = 3

  const rows: Record<'budget' | 'spending' | 'savings', string[][]> = {
    budget: [],
    spending: [],
    savings: [],
  }

  const months: string[] = []
  let transferPairs = 0
  let insurancePremiums = 0

  let balance = { budget: 1_200_00, spending: 450_00, savings: 45_000_00 }

  for (let i = monthCount - 1; i >= 0; i--) {
    const total = endYear * 12 + (endMonth - 1) - i
    const y = Math.floor(total / 12)
    const m = (total % 12) + 1
    months.push(`${y}-${String(m).padStart(2, '0')}`)

    // Salary into the budget account.
    const salary = 32_000_00 + Math.round(random() * 200_00)
    balance.budget += salary
    rows.budget.push([ddmmyyyy(y, m, 25), 'LØNOVERFØRSEL ARBEJDSGIVER A/S', dkk(salary), dkk(balance.budget)])

    // Fixed bills from the budget account.
    const fixed: Array<[string, number]> = [
      ['HUSLEJE BOLIGFORENING 3B', -8_500_00],
      ['ØRSTED SALG & SERVICE', -742_00],
      ['TELIA DANMARK', -229_00],
      ['HIPER A/S INTERNET', -249_00],
      ['A-KASSE HK DANMARK', -512_00],
    ]
    for (const [text, amount] of fixed) {
      balance.budget += amount
      rows.budget.push([ddmmyyyy(y, m, 1 + Math.floor(random() * 3)), text, dkk(amount), dkk(balance.budget)])
    }

    // An annual insurance premium — the one-off the budget suggester must isolate.
    if (m === 1) {
      const premium = -6_400_00
      balance.budget += premium
      rows.budget.push([ddmmyyyy(y, m, 12), 'TRYG FORSIKRING ÅRLIG PRÆMIE', dkk(premium), dkk(balance.budget)])
      insurancePremiums++
    }

    // Monthly transfer budget → spending. Both halves appear, on their own
    // statements, one day apart — exactly the case transfer pairing exists for.
    const move = 9_000_00
    balance.budget -= move
    rows.budget.push([ddmmyyyy(y, m, 2), 'OVERFØRSEL TIL FORBRUG', dkk(-move), dkk(balance.budget)])
    balance.spending += move
    rows.spending.push([ddmmyyyy(y, m, 3), 'OVERFØRSEL FRA BUDGET', dkk(move), dkk(balance.spending)])
    transferPairs++

    // Monthly saving.
    const save = 2_500_00
    balance.budget -= save
    rows.budget.push([ddmmyyyy(y, m, 2), 'OVERFØRSEL TIL OPSPARING', dkk(-save), dkk(balance.budget)])
    balance.savings += save
    rows.savings.push([ddmmyyyy(y, m, 2), 'OVERFØRSEL FRA BUDGET', dkk(save), dkk(balance.savings)])
    transferPairs++

    // Variable spending.
    const groceryTrips = 8 + Math.floor(random() * 5)
    for (let t = 0; t < groceryTrips; t++) {
      const amount = -(150_00 + Math.round(random() * 450_00))
      balance.spending += amount
      rows.spending.push([
        ddmmyyyy(y, m, 1 + Math.floor(random() * 27)),
        GROCERIES[Math.floor(random() * GROCERIES.length)],
        dkk(amount),
        dkk(balance.spending),
      ])
    }

    for (let t = 0; t < 3 + Math.floor(random() * 4); t++) {
      const amount = -(80_00 + Math.round(random() * 220_00))
      balance.spending += amount
      rows.spending.push([
        ddmmyyyy(y, m, 1 + Math.floor(random() * 27)),
        DINING[Math.floor(random() * DINING.length)],
        dkk(amount),
        dkk(balance.spending),
      ])
    }

    for (let t = 0; t < 2 + Math.floor(random() * 2); t++) {
      const amount = -(400_00 + Math.round(random() * 300_00))
      balance.spending += amount
      rows.spending.push([
        ddmmyyyy(y, m, 1 + Math.floor(random() * 27)),
        FUEL[Math.floor(random() * FUEL.length)],
        dkk(amount),
        dkk(balance.spending),
      ])
    }

    for (const sub of SUBS) {
      const amount = sub === 'SPOTIFY AB' ? -99_00 : -129_00
      balance.spending += amount
      rows.spending.push([ddmmyyyy(y, m, 15), sub, dkk(amount), dkk(balance.spending)])
    }
  }

  // Two identical coffees on the same day — both are real, and dedup must keep
  // both while still recognising a re-import of this same file.
  const dupAmount = -45_00
  balance.spending += dupAmount
  rows.spending.push([ddmmyyyy(2026, 3, 12), 'BARESSO COFFEE', dkk(dupAmount), dkk(balance.spending)])
  balance.spending += dupAmount
  rows.spending.push([ddmmyyyy(2026, 3, 12), 'BARESSO COFFEE', dkk(dupAmount), dkk(balance.spending)])

  const header = 'Bogføringsdato;Tekst;Beløb;Saldo'
  const toCsv = (data: string[][]) => [header, ...data.map((r) => r.join(';'))].join('\r\n')

  return {
    csv: {
      budget: toCsv(rows.budget),
      spending: toCsv(rows.spending),
      savings: toCsv(rows.savings),
    },
    months,
    expected: { transferPairs, duplicatedPurchases: 2, insurancePremiums },
  }
}

/** Wraps CSV text as a File, as the browser file input would supply it. */
export function csvFile(text: string, name = 'kontoudtog.csv'): File {
  return new File([text], name, { type: 'text/csv' })
}
