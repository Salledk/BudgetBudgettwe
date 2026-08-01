import Papa from 'papaparse'
import { guessDateFormat, parseDate, type DateFormat } from '@/lib/dates'
import { parseAmount } from '@/lib/money'
import { merchantKey } from '@/lib/normalize'
import type { AmountMode, BankProfile } from '@/data/types'

/** A file reduced to headers + string cells, before any mapping is applied. */
export interface RawTable {
  headers: string[]
  rows: Array<Record<string, string>>
  delimiter: string
  /** Identifies this export layout so a saved mapping can be reused. */
  headerSignature: string
}

export type ColumnMapping = Omit<BankProfile, 'id' | 'updatedAt' | 'deletedAt' | 'name' | 'headerSignature'>

export interface ParsedRow {
  date: string
  amountMinor: number
  rawText: string
  merchantKey: string
  balanceAfterMinor: number | null
  /** The bank's own transaction id, when the export supplied one. */
  externalId: string | null
  /** Index in the source file, for error reporting. */
  sourceRow: number
}

export interface ParseIssue {
  sourceRow: number
  reason: string
  raw: Record<string, string>
}

/**
 * Danish bank exports are frequently Windows-1252 or ISO-8859-1 rather than
 * UTF-8. Decoding wrongly turns every "Føtex" into "FÃ¸tex" — which then
 * poisons merchant keys and every rule that depends on them, so it is worth
 * detecting properly rather than assuming.
 */
export function decodeBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)

  // BOM wins outright.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3))
  }

  const strict = new TextDecoder('utf-8', { fatal: true })
  try {
    return strict.decode(bytes)
  } catch {
    // Not valid UTF-8 — Windows-1252 is the overwhelmingly likely alternative
    // and is a superset of ISO-8859-1 for the characters that matter here.
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

export async function readFile(file: File): Promise<RawTable> {
  const isExcel = /\.(xlsx|xlsm|xls)$/i.test(file.name)
  return isExcel ? readExcel(file) : readCsv(file)
}

async function readCsv(file: File): Promise<RawTable> {
  const text = decodeBuffer(await file.arrayBuffer())
  const cleaned = stripPreamble(text)

  const result = Papa.parse<Record<string, string>>(cleaned, {
    header: true,
    skipEmptyLines: 'greedy',
    // Papa auto-detects among these; Danish exports overwhelmingly use ';'.
    delimitersToGuess: [';', ',', '\t', '|'],
    transformHeader: (h) => h.trim(),
  })

  const headers = (result.meta.fields ?? []).filter((h) => h && h.trim() !== '')
  const rows = (result.data ?? []).filter((r) => Object.values(r).some((v) => (v ?? '').toString().trim() !== ''))

  return {
    headers,
    rows: rows.map(normaliseRow),
    delimiter: result.meta.delimiter ?? ';',
    headerSignature: signatureOf(headers),
  }
}

async function readExcel(file: File): Promise<RawTable> {
  // Loaded on demand: the spreadsheet parser is by far the largest dependency,
  // and most users only ever import CSV.
  const XLSX = await import('xlsx')
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true, raw: false })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '' })

  const headerIdx = findHeaderRow(matrix)
  const headers = (matrix[headerIdx] ?? []).map((h) => String(h ?? '').trim())
  const rows: Array<Record<string, string>> = []

  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const cells = matrix[i] ?? []
    if (cells.every((c) => String(c ?? '').trim() === '')) continue
    const row: Record<string, string> = {}
    headers.forEach((h, j) => {
      if (h) row[h] = String(cells[j] ?? '').trim()
    })
    rows.push(row)
  }

  return {
    headers: headers.filter(Boolean),
    rows,
    delimiter: ',',
    headerSignature: signatureOf(headers.filter(Boolean)),
  }
}

function normaliseRow(row: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(row)) {
    if (!k || !k.trim()) continue
    out[k.trim()] = (v ?? '').toString().trim()
  }
  return out
}

/**
 * Some banks put an account summary above the real header row. The header is
 * the first row with several non-empty cells that looks like labels rather
 * than data.
 */
function findHeaderRow(matrix: string[][]): number {
  for (let i = 0; i < Math.min(matrix.length, 15); i++) {
    const cells = (matrix[i] ?? []).map((c) => String(c ?? '').trim())
    const filled = cells.filter(Boolean)
    if (filled.length < 2) continue
    // A header row's cells are mostly non-numeric.
    const numeric = filled.filter((c) => /^[\d.,\-\s]+$/.test(c)).length
    if (numeric / filled.length < 0.4) return i
  }
  return 0
}

function stripPreamble(text: string): string {
  const lines = text.split(/\r?\n/)
  // Drop leading blank or single-cell lines that precede the real header.
  let start = 0
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const line = lines[i]
    if (line.trim() === '') {
      start = i + 1
      continue
    }
    const cells = line.split(/[;,\t|]/).filter((c) => c.trim() !== '')
    if (cells.length >= 2) {
      start = i
      break
    }
    start = i + 1
  }
  return lines.slice(start).join('\n')
}

export function signatureOf(headers: string[]): string {
  return headers
    .map((h) => h.toLowerCase().replace(/\s+/g, ''))
    .sort()
    .join('|')
}

// ------------------------------------------------------------- auto-mapping

const DATE_HINTS = ['bogføringsdato', 'bogforingsdato', 'dato', 'date', 'transaktionsdato', 'valørdato', 'valordato', 'posteringsdato', 'rentedato']
const TEXT_HINTS = ['tekst', 'beskrivelse', 'posteringstekst', 'description', 'meddelelse', 'detaljer', 'text', 'modtager', 'afsender', 'narrative']
const AMOUNT_HINTS = ['beløb', 'belob', 'amount', 'beløb i dkk', 'transaktionsbeløb', 'value']
const BALANCE_HINTS = ['saldo', 'balance', 'saldo efter', 'bogført saldo']
const DEBIT_HINTS = ['debet', 'debit', 'hævet', 'haevet', 'ud', 'withdrawal']
const CREDIT_HINTS = ['kredit', 'credit', 'indsat', 'ind', 'deposit']
const ID_HINTS = [
  'transaktions-id', 'transaktionsid', 'transaction id', 'transaktionsnummer',
  'id', 'reference', 'referencenummer', 'arkivreference', 'bilagsnummer', 'løbenummer',
]

function scoreHeader(header: string, hints: string[]): number {
  const h = header.toLowerCase().replace(/\s+/g, ' ').trim()
  let best = 0
  for (const hint of hints) {
    if (h === hint) best = Math.max(best, 100)
    else if (h.startsWith(hint)) best = Math.max(best, 80)
    else if (h.includes(hint)) best = Math.max(best, 60)
  }
  return best
}

function pickColumn(headers: string[], hints: string[], exclude: string[] = []): string | null {
  let best: string | null = null
  let bestScore = 0
  for (const h of headers) {
    if (exclude.includes(h)) continue
    const score = scoreHeader(h, hints)
    if (score > bestScore) {
      bestScore = score
      best = h
    }
  }
  return bestScore > 0 ? best : null
}

/**
 * Guesses a mapping from header names, then sanity-checks it against actual
 * cell contents — header names alone are not reliable enough to import money
 * on, and a wrong amount column is silent corruption rather than a visible error.
 */
export function guessMapping(table: RawTable): ColumnMapping {
  const { headers, rows } = table
  const sample = rows.slice(0, 25)

  let dateColumn = pickColumn(headers, DATE_HINTS)
  if (!dateColumn) dateColumn = headers.find((h) => columnLooksLikeDate(sample, h)) ?? headers[0] ?? ''

  const balanceColumn = pickColumn(headers, BALANCE_HINTS)

  const debitColumn = pickColumn(headers, DEBIT_HINTS, [dateColumn, balanceColumn ?? ''])
  const creditColumn = pickColumn(headers, CREDIT_HINTS, [dateColumn, balanceColumn ?? '', debitColumn ?? ''])

  let amountColumn = pickColumn(headers, AMOUNT_HINTS, [dateColumn, balanceColumn ?? ''])
  // Fall back to the first numeric column that isn't the balance.
  if (!amountColumn && !(debitColumn && creditColumn)) {
    amountColumn =
      headers.find((h) => h !== dateColumn && h !== balanceColumn && columnLooksLikeAmount(sample, h)) ?? null
  }

  const amountMode: AmountMode = !amountColumn && debitColumn && creditColumn ? 'debit-credit' : 'single'

  /*
   * Resolved after the numeric columns are claimed, and before descriptions.
   *
   * After, because an amount column contains no long words and would otherwise
   * satisfy the "not human text" half of the identifier test. Before, because
   * an id column is textual enough to be mistaken for a description — and
   * folding a UUID into the description gives every transaction a unique
   * merchant key, which defeats categorisation entirely.
   */
  const claimed = [dateColumn, balanceColumn, amountColumn, debitColumn, creditColumn].filter(Boolean) as string[]
  const idColumn =
    pickColumn(headers, ID_HINTS, claimed) ??
    headers.find((h) => !claimed.includes(h) && columnLooksLikeIdentifier(sample, h)) ??
    null

  const used = new Set(
    [dateColumn, balanceColumn, amountColumn, debitColumn, creditColumn, idColumn].filter(Boolean) as string[],
  )
  let descriptionColumns = headers.filter((h) => !used.has(h) && scoreHeader(h, TEXT_HINTS) > 0)
  if (descriptionColumns.length === 0) {
    // Any remaining mostly-textual column will do.
    descriptionColumns = headers.filter((h) => !used.has(h) && columnLooksTextual(sample, h))
  }
  if (descriptionColumns.length === 0) descriptionColumns = headers.filter((h) => !used.has(h)).slice(0, 1)

  const dateFormat =
    guessDateFormat(sample.map((r) => r[dateColumn] ?? '')) ?? ('dd-MM-yyyy' as DateFormat)

  return {
    delimiter: table.delimiter,
    dateColumn,
    dateFormat,
    amountMode,
    amountColumn: amountMode === 'single' ? amountColumn : null,
    debitColumn: amountMode === 'debit-credit' ? debitColumn : null,
    creditColumn: amountMode === 'debit-credit' ? creditColumn : null,
    descriptionColumns,
    balanceColumn,
    idColumn,
    decimalSeparator: 'auto',
    invertSign: false,
    skipRows: 0,
  }
}

/**
 * True for columns holding opaque per-row identifiers — UUIDs, long hex
 * references, receipt numbers.
 *
 * Two signals together: the values are nearly all distinct, and they look like
 * machine identifiers rather than words. Uniqueness alone is not enough, since
 * a description column is often unique too.
 */
function columnLooksLikeIdentifier(rows: Array<Record<string, string>>, header: string): boolean {
  const values = rows.map((r) => r[header]).filter((v) => v && v.trim() !== '')
  if (values.length < 3) return false

  const distinct = new Set(values).size
  if (distinct / values.length < 0.9) return false

  // A column of amounts or dates is unique and wordless too. Rule those out
  // explicitly rather than letting them pass the "not human text" test.
  const numericish = values.filter((v) => parseAmount(v) !== null || parseDate(v) !== null).length
  if (numericish / values.length > 0.5) return false

  const idShaped = values.filter((v) => {
    const s = v.trim()
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(s)) return true // UUID
    if (/^[0-9a-f]{16,}$/i.test(s)) return true // long hex
    if (/^\d{10,}$/.test(s)) return true // long numeric reference
    // No word longer than two letters — not human text.
    return !/[a-zæøå]{3,}/i.test(s)
  }).length

  return idShaped / values.length >= 0.8
}

function columnLooksLikeDate(rows: Array<Record<string, string>>, header: string): boolean {
  const values = rows.map((r) => r[header]).filter((v) => v && v.trim() !== '')
  if (values.length === 0) return false
  const parsed = values.filter((v) => parseDate(v) !== null).length
  return parsed / values.length >= 0.8
}

function columnLooksLikeAmount(rows: Array<Record<string, string>>, header: string): boolean {
  const values = rows.map((r) => r[header]).filter((v) => v && v.trim() !== '')
  if (values.length === 0) return false
  const parsed = values.filter((v) => parseAmount(v) !== null).length
  return parsed / values.length >= 0.8
}

function columnLooksTextual(rows: Array<Record<string, string>>, header: string): boolean {
  const values = rows.map((r) => r[header]).filter((v) => v && v.trim() !== '')
  if (values.length === 0) return false
  const textual = values.filter((v) => /[a-zA-ZæøåÆØÅ]{3,}/.test(v)).length
  return textual / values.length >= 0.5
}

// ---------------------------------------------------------------- applying

export function applyMapping(
  table: RawTable,
  mapping: ColumnMapping,
): { rows: ParsedRow[]; issues: ParseIssue[] } {
  const rows: ParsedRow[] = []
  const issues: ParseIssue[] = []

  const source = table.rows.slice(mapping.skipRows)

  source.forEach((raw, i) => {
    const sourceRow = i + mapping.skipRows + 2 // +2: 1-indexed, plus header row

    const date = parseDate(raw[mapping.dateColumn] ?? '', mapping.dateFormat)
    if (!date) {
      issues.push({ sourceRow, reason: `Kunne ikke læse dato: "${raw[mapping.dateColumn] ?? ''}"`, raw })
      return
    }

    const amountMinor = readAmount(raw, mapping)
    if (amountMinor === null) {
      issues.push({ sourceRow, reason: 'Kunne ikke læse beløb', raw })
      return
    }
    // A zero-amount row carries no budget information and is usually a
    // formatting artefact rather than a real posting.
    if (amountMinor === 0) {
      issues.push({ sourceRow, reason: 'Beløb er 0 — sprunget over', raw })
      return
    }

    const rawText = mapping.descriptionColumns
      .map((c) => (raw[c] ?? '').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

    const balanceAfterMinor = mapping.balanceColumn
      ? parseAmount(raw[mapping.balanceColumn] ?? '', { decimalSeparator: mapping.decimalSeparator })
      : null

    const externalId = mapping.idColumn ? (raw[mapping.idColumn] ?? '').trim() || null : null

    rows.push({
      date,
      amountMinor,
      rawText: rawText || '(ingen tekst)',
      merchantKey: merchantKey(rawText),
      balanceAfterMinor,
      externalId,
      sourceRow,
    })
  })

  return { rows, issues }
}

function readAmount(raw: Record<string, string>, mapping: ColumnMapping): number | null {
  const opts = { decimalSeparator: mapping.decimalSeparator }

  if (mapping.amountMode === 'debit-credit') {
    const debit = mapping.debitColumn ? parseAmount(raw[mapping.debitColumn] ?? '', opts) : null
    const credit = mapping.creditColumn ? parseAmount(raw[mapping.creditColumn] ?? '', opts) : null

    // Debit columns are written as positive magnitudes; the sign is implied by
    // which column the value landed in.
    if (debit !== null && debit !== 0) return -Math.abs(debit)
    if (credit !== null && credit !== 0) return Math.abs(credit)
    return null
  }

  if (!mapping.amountColumn) return null
  const value = parseAmount(raw[mapping.amountColumn] ?? '', opts)
  if (value === null) return null
  return mapping.invertSign ? -value : value
}

/**
 * Some exports list expenses as positive numbers. If nearly every row is
 * positive but the balance column is trending down, the sign convention is
 * inverted — worth flagging rather than importing a month where nothing was
 * ever spent.
 */
export function detectSignConvention(rows: ParsedRow[]): { likelyInverted: boolean; reason: string | null } {
  if (rows.length < 5) return { likelyInverted: false, reason: null }

  const positives = rows.filter((r) => r.amountMinor > 0).length
  const share = positives / rows.length

  if (share > 0.9) {
    return {
      likelyInverted: true,
      reason: 'Næsten alle beløb er positive — filen bruger sandsynligvis positive tal for udgifter.',
    }
  }
  return { likelyInverted: false, reason: null }
}
