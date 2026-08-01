import { describe, expect, it } from 'vitest'
import { applyMapping, guessMapping, signatureOf, type RawTable } from './parse'

/**
 * Column guessing against the shapes real Danish exports take. The failure
 * mode these guard against is silent: a wrong column produces plausible
 * numbers rather than an error.
 */

function table(headers: string[], rows: string[][]): RawTable {
  return {
    headers,
    rows: rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']))),
    delimiter: ',',
    headerSignature: signatureOf(headers),
  }
}

/** The Lunar-style layout: comma-delimited with a UUID transaction id. */
const lunar = table(
  ['Dato', 'Tid', 'Titel', 'Beløb', 'Balance', 'Transaktions-ID', 'Note'],
  [
    ['01.08.2026', '09.29', 'MobilePay Maja Bang', '400,00', '22.116,76', 'fa5620df-bbd1-458c-94ed-a7543cc3f2f5', ''],
    ['31.07.2026', '19.15', 'Budget', '-10.000,00', '21.716,76', 'c92a4081-9b95-40c6-a2a8-6a48f9216966', ''],
    ['31.07.2026', '19.14', 'Rente', '19,21', '31.716,76', '14837558-537d-40b0-9fd4-bda70780e579', ''],
    ['29.07.2026', '19.00', 'Netto', '-120,24', '20.938,55', '966715ec-9169-5947-a2af-d25ec9eb6bcb', ''],
    ['27.07.2026', '18.46', 'nemlig.com', '-1.077,92', '21.309,44', 'f070b8fb-7a92-565c-af25-5e3780e3edc3', ''],
  ],
)

describe('guessMapping', () => {
  it('maps a comma-delimited export with a transaction id', () => {
    const m = guessMapping(lunar)

    expect(m.dateColumn).toBe('Dato')
    expect(m.dateFormat).toBe('dd.MM.yyyy')
    expect(m.amountColumn).toBe('Beløb')
    expect(m.balanceColumn).toBe('Balance')
    expect(m.idColumn).toBe('Transaktions-ID')
  })

  it('keeps the id column out of the description', () => {
    // Folding a UUID into the description gives every transaction a unique
    // merchant key, which defeats rules and learning entirely.
    const m = guessMapping(lunar)

    expect(m.descriptionColumns).toContain('Titel')
    expect(m.descriptionColumns).not.toContain('Transaktions-ID')
  })

  it('produces clean merchant keys once the id is excluded', () => {
    const { rows } = applyMapping(lunar, guessMapping(lunar))

    expect(rows.map((r) => r.merchantKey)).toEqual([
      'mobilepay maja bang',
      'budget',
      'rente',
      'netto',
      'nemlig.com',
    ])
  })

  it('carries the bank id through to the parsed row', () => {
    const { rows } = applyMapping(lunar, guessMapping(lunar))
    expect(rows[0].externalId).toBe('fa5620df-bbd1-458c-94ed-a7543cc3f2f5')
  })

  it('detects an id column even when the header gives no hint', () => {
    const t = table(
      ['Dato', 'Tekst', 'Beløb', 'Nøgle'],
      [
        ['01.08.2026', 'Netto', '-120,24', 'fa5620df-bbd1-458c-94ed-a7543cc3f2f5'],
        ['02.08.2026', 'Føtex', '-220,00', 'c92a4081-9b95-40c6-a2a8-6a48f9216966'],
        ['03.08.2026', 'Rema', '-90,50', '14837558-537d-40b0-9fd4-bda70780e579'],
        ['04.08.2026', 'Lidl', '-45,00', '966715ec-9169-5947-a2af-d25ec9eb6bcb'],
      ],
    )
    const m = guessMapping(t)

    expect(m.idColumn).toBe('Nøgle')
    expect(m.descriptionColumns).toEqual(['Tekst'])
  })

  it('does not treat a Danish time column as the transaction id', () => {
    // "Tid" is Danish for time, and contains the substring "id". Matching the
    // hint loosely picked it as the id column, and because clock times repeat
    // across days it collided on the unique index and aborted the whole import.
    const t = table(
      ['Dato', 'Tid', 'Tekst', 'Beløb', 'Saldo'],
      [
        ['2026-06-23', '22:19:05', 'Rejsekort', '-15,20', '19985,26'],
        ['2026-06-19', '01:19:47', 'Rejsekort', '-11,00', '20000,46'],
        ['2026-06-18', '02:27:58', 'Rejsekort', '-11,00', '20011,46'],
        ['2026-06-17', '01:19:47', 'Netto', '-95,00', '20106,46'],
      ],
    )
    const m = guessMapping(t)

    expect(m.idColumn).toBeNull()
    expect(m.dateColumn).toBe('Dato')
    expect(m.descriptionColumns).toEqual(['Tekst'])
  })

  it('does not treat short codes as the transaction id', () => {
    const t = table(
      ['Dato', 'Tekst', 'Beløb', 'Kode'],
      [
        ['01.08.2026', 'Netto', '-120,24', 'A1B2'],
        ['02.08.2026', 'Føtex', '-220,00', 'C3D4'],
        ['03.08.2026', 'Rema', '-90,50', 'E5F6'],
        ['04.08.2026', 'Lidl', '-45,00', 'G7H8'],
      ],
    )
    expect(guessMapping(t).idColumn).toBeNull()
  })

  it('still matches an id column named exactly "ID"', () => {
    const t = table(
      ['Dato', 'Tekst', 'Beløb', 'ID'],
      [
        ['01.08.2026', 'Netto', '-120,24', 'fa5620df-bbd1-458c-94ed-a7543cc3f2f5'],
        ['02.08.2026', 'Føtex', '-220,00', 'c92a4081-9b95-40c6-a2a8-6a48f9216966'],
        ['03.08.2026', 'Rema', '-90,50', '14837558-537d-40b0-9fd4-bda70780e579'],
      ],
    )
    expect(guessMapping(t).idColumn).toBe('ID')
  })

  it('does not mistake a description for an id just because it is unique', () => {
    const t = table(
      ['Dato', 'Posteringstekst', 'Beløb'],
      [
        ['01.08.2026', 'Netto Nørrebrogade', '-120,24'],
        ['02.08.2026', 'Føtex Frederiksberg', '-220,00'],
        ['03.08.2026', 'Rema 1000 Valby', '-90,50'],
        ['04.08.2026', 'Circle K Roskilde', '-45,00'],
      ],
    )
    const m = guessMapping(t)

    expect(m.idColumn).toBeNull()
    expect(m.descriptionColumns).toEqual(['Posteringstekst'])
  })

  it('handles a semicolon export with separate debit and credit columns', () => {
    const t = table(
      ['Bogføringsdato', 'Tekst', 'Hævet', 'Indsat', 'Saldo'],
      [
        ['14-03-2026', 'NETTO 1234', '120,24', '', '5.000,00'],
        ['15-03-2026', 'LØNOVERFØRSEL', '', '25.000,00', '30.000,00'],
        ['16-03-2026', 'FØTEX 5521', '220,00', '', '29.780,00'],
        ['17-03-2026', 'REMA 1000', '90,50', '', '29.689,50'],
      ],
    )
    const m = guessMapping(t)
    expect(m.amountMode).toBe('debit-credit')

    const { rows } = applyMapping(t, m)
    // Debit columns hold positive magnitudes; the sign comes from the column.
    expect(rows[0].amountMinor).toBe(-12024)
    expect(rows[1].amountMinor).toBe(2500000)
  })
})

describe('applyMapping', () => {
  it('reports unreadable rows instead of importing garbage', () => {
    const t = table(
      ['Dato', 'Tekst', 'Beløb'],
      [
        ['01.08.2026', 'Netto', '-120,24'],
        ['ikke en dato', 'Føtex', '-220,00'],
        ['03.08.2026', 'Rema', 'ikke et beløb'],
      ],
    )
    const { rows, issues } = applyMapping(t, { ...guessMapping(t), dateFormat: 'dd.MM.yyyy' })

    expect(rows).toHaveLength(1)
    expect(issues).toHaveLength(2)
  })

  it('skips zero-amount rows, which carry no budget information', () => {
    const t = table(
      ['Dato', 'Tekst', 'Beløb'],
      [
        ['01.08.2026', 'Netto', '-120,24'],
        ['02.08.2026', 'Gebyr', '0,00'],
      ],
    )
    const { rows, issues } = applyMapping(t, { ...guessMapping(t), dateFormat: 'dd.MM.yyyy' })

    expect(rows).toHaveLength(1)
    expect(issues).toHaveLength(1)
  })

  it('inverts the sign when the export writes expenses as positive', () => {
    const t = table(['Dato', 'Tekst', 'Beløb'], [['01.08.2026', 'Netto', '120,24']])
    const m = { ...guessMapping(t), dateFormat: 'dd.MM.yyyy' as const, invertSign: true }

    expect(applyMapping(t, m).rows[0].amountMinor).toBe(-12024)
  })
})
