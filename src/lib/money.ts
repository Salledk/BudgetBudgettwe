/**
 * Money is stored everywhere as a signed integer number of minor units (øre).
 * Negative = money left the account. Floats never touch a stored amount —
 * they are only produced at the render edge by the formatters below.
 */

export type Minor = number

const DKK = new Intl.NumberFormat('da-DK', {
  style: 'currency',
  currency: 'DKK',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const DKK_ROUND = new Intl.NumberFormat('da-DK', {
  style: 'currency',
  currency: 'DKK',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

const PLAIN = new Intl.NumberFormat('da-DK', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** "1.234,56 kr." — full precision. */
export function formatMoney(minor: Minor): string {
  return DKK.format(minor / 100)
}

/** "1.235 kr." — for dashboards and budget figures where øre are noise. */
export function formatMoneyRounded(minor: Minor): string {
  return DKK_ROUND.format(Math.round(minor / 100))
}

/** "1.234,56" — no currency marker, for input fields. */
export function formatAmountPlain(minor: Minor): string {
  return PLAIN.format(minor / 100)
}

/** Always shows a sign. Used where direction matters more than magnitude. */
export function formatSigned(minor: Minor): string {
  const s = formatMoney(Math.abs(minor))
  return minor < 0 ? `−${s}` : `+${s}`
}

/**
 * Parses a bank-export amount into minor units.
 *
 * Handles the shapes Danish exports actually produce:
 *   "1.234,56"  "-1.234,56"  "1 234,56"  "1234.56"  "(1.234,56)"  "1.234,56 kr."
 *   "DKK 1.234,56"  "+1234"  "1,234.56" (some banks emit en-US)
 *
 * Separator direction is inferred per value rather than assumed, because a
 * single export can mix "1.234,56" and "1234.56" across columns.
 */
export function parseAmount(
  input: string | number | null | undefined,
  opts: { decimalSeparator?: ',' | '.' | 'auto' } = {},
): Minor | null {
  if (input === null || input === undefined) return null
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null
    return Math.round(input * 100)
  }

  let s = input.trim()
  if (s === '') return null

  // Accounting negatives: (1.234,56)
  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1)
  }

  // Strip currency markers, non-breaking spaces and stray letters.
  s = s
    .replace(/ /g, ' ')
    .replace(/(kr\.?|DKK|EUR|USD|€|\$)/gi, '')
    .trim()

  if (s.startsWith('-') || s.startsWith('−')) {
    negative = true
    s = s.slice(1).trim()
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim()
  }

  // Trailing minus: "1.234,56-" (seen in some legacy exports)
  if (s.endsWith('-')) {
    negative = true
    s = s.slice(0, -1).trim()
  }

  s = s.replace(/\s/g, '')
  if (s === '' || !/[0-9]/.test(s)) return null
  if (!/^[0-9.,]+$/.test(s)) return null

  const decimalSeparator = resolveDecimalSeparator(s, opts.decimalSeparator ?? 'auto')

  let normalised: string
  if (decimalSeparator === ',') {
    normalised = s.replace(/\./g, '').replace(',', '.')
  } else {
    normalised = s.replace(/,/g, '')
  }

  // More than one decimal point left means the value was never a number.
  if ((normalised.match(/\./g) ?? []).length > 1) return null

  const value = Number(normalised)
  if (!Number.isFinite(value)) return null

  // Round in minor units to dodge float drift: 1234.565 * 100 = 123456.49999
  const minor = Math.round(Number((value * 100).toFixed(4)))
  return negative ? -minor : minor
}

function resolveDecimalSeparator(s: string, hint: ',' | '.' | 'auto'): ',' | '.' {
  if (hint !== 'auto') return hint

  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')

  // Both present: whichever comes last is the decimal separator.
  if (lastComma >= 0 && lastDot >= 0) return lastComma > lastDot ? ',' : '.'

  if (lastComma >= 0) {
    // Only commas. "1,234" is ambiguous — exactly 3 digits after a single
    // comma reads as a thousands group; anything else is a decimal.
    const commaCount = (s.match(/,/g) ?? []).length
    if (commaCount > 1) return '.' // 1,234,567 → commas are groupers
    return isGroupingSeparator(s, lastComma) ? '.' : ','
  }

  if (lastDot >= 0) {
    const dotCount = (s.match(/\./g) ?? []).length
    if (dotCount > 1) return ',' // 1.234.567 → dots are groupers
    return isGroupingSeparator(s, lastDot) ? ',' : '.'
  }

  // No separator at all — direction is irrelevant.
  return ','
}

/**
 * For a value with exactly one separator, decides whether it groups thousands.
 *
 * Two conditions must both hold: exactly three digits after it, and at most
 * three before it. The second matters — "1234,565" cannot be a grouped number,
 * because a grouped number never has four digits before its first separator,
 * so the comma there is a decimal point.
 */
function isGroupingSeparator(s: string, index: number): boolean {
  const before = s.slice(0, index).replace(/\D/g, '')
  const after = s.length - index - 1
  return after === 3 && before.length <= 3 && before.length > 0
}

/** Parses free-text user input from a budget field. Lenient by design. */
export function parseUserAmount(input: string): Minor | null {
  return parseAmount(input)
}

export function sumMinor(values: Iterable<Minor>): Minor {
  let total = 0
  for (const v of values) total += v
  return total
}

/** Percentage as 0..n float, guarding the divide-by-zero budget case. */
export function ratio(actual: Minor, budget: Minor): number | null {
  if (budget === 0) return null
  return actual / budget
}
