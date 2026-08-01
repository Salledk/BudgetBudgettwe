/**
 * Turning a raw bank description into a stable merchant key.
 *
 * Bank text for the same shop is rarely identical twice:
 *   "NETTO 1234 KØBENHAVN DEN 12.03"
 *   "Netto 5521 Aarhus C  Den 03.04"
 *   "VISA/DANKORT NETTO 1234"
 * All three must collapse to "netto" so that categorising one teaches the app
 * about the others. Everything stripped here is noise that varies per
 * transaction: store numbers, embedded dates, card references, receipt ids.
 */

/** Lowercase, strip diacritics, collapse whitespace. Danish æøå are preserved. */
export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

const NOISE_PATTERNS: RegExp[] = [
  // Card/payment scheme prefixes that say nothing about the merchant.
  /^(visa\/?dankort|visa|dankort|mastercard|maestro|kortkøb|kortbetaling|betaling|køb)\s+/i,
  // Embedded dates: "den 12.03", "d. 3/4", "12-03-2026", "2026-03-12"
  /\b(den|d\.)\s*\d{1,2}[.\-/]\d{1,2}([.\-/]\d{2,4})?\b/gi,
  /\b\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}\b/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  // Masked card numbers and long reference/receipt numbers.
  /\b(x{2,}|\*{2,})\d{2,}\b/gi,
  /\bnota\s*\d+\b/gi,
  /\bref\.?\s*[:\-]?\s*\w{4,}\b/gi,
  /\b\d{8,}\b/g,
  // Currency conversion tails: "kurs 7,4412", "12,00 EUR"
  /\bkurs\s*[\d.,]+/gi,
  /\b[\d.,]+\s*(eur|usd|gbp|sek|nok)\b/gi,
]

/**
 * Reduces a description to the part that identifies the merchant.
 * Returns '' when nothing identifying survives — callers must treat an empty
 * key as "no signal" rather than as a merchant everything matches.
 */
export function merchantKey(rawText: string): string {
  let s = normalizeText(rawText)

  for (const p of NOISE_PATTERNS) {
    s = s.replace(p, ' ')
  }

  s = s
    // Leading prepositions banks prefix to counterparty names: "FRA VESTERHUS
    // WINE" and "TIL VESTERHUS WINE" are the same party in both directions.
    .replace(/^(fra|til|from|to)\s+/i, '')
    // Store/branch numbers: "netto 1234" → "netto". Bare 2-6 digit runs only;
    // longer ones were already removed as references above.
    .replace(/\b\d{2,6}\b/g, ' ')
    // Punctuation that varies between exports.
    .replace(/[*#|;:_"']+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // Danish city names commonly appended to card purchases. Removing them means
  // the same chain in two cities shares one key.
  s = stripTrailingCity(s)

  // A key of only digits or a single character is not a merchant.
  if (s.length < 2 || /^\d+$/.test(s)) return ''
  return s
}

const CITIES = new Set([
  'københavn', 'kobenhavn', 'kbh', 'frederiksberg', 'aarhus', 'århus', 'odense', 'aalborg', 'ålborg',
  'esbjerg', 'randers', 'kolding', 'horsens', 'vejle', 'roskilde', 'herning', 'silkeborg', 'næstved',
  'naestved', 'greve', 'taastrup', 'ballerup', 'lyngby', 'hillerød', 'hillerod', 'helsingør', 'helsingor',
  'holbæk', 'holbaek', 'slagelse', 'viborg', 'køge', 'koge', 'holstebro', 'sønderborg', 'sonderborg',
  'svendborg', 'hjørring', 'hjorring', 'fredericia', 'ringsted', 'nykøbing', 'nykobing', 'glostrup',
  'gladsaxe', 'hvidovre', 'rødovre', 'rodovre', 'valby', 'amager', 'nørrebro', 'norrebro', 'østerbro',
  'osterbro', 'vesterbro', 'brøndby', 'brondby', 'albertslund', 'ishøj', 'ishoj', 'dk', 'danmark',
])

function stripTrailingCity(s: string): string {
  const parts = s.split(' ')
  // Strip repeatedly: "netto kobenhavn dk" → "netto"
  while (parts.length > 1) {
    const last = parts[parts.length - 1]
    if (CITIES.has(last)) {
      parts.pop()
      continue
    }
    // A lone letter is postal noise only directly after a city ("Aarhus C").
    // On its own it is part of the name, as in "Circle K".
    const prev = parts[parts.length - 2]
    if (last.length === 1 && /[a-zæøå]/.test(last) && CITIES.has(prev)) {
      parts.pop()
      parts.pop()
      continue
    }
    break
  }
  return parts.join(' ')
}

/**
 * A coarse key used only for the learned layer: the first two meaningful
 * words. Catches "rema 1000" vs "rema" and keeps chain names together while
 * still ignoring long descriptive tails.
 */
export function merchantKeyShort(rawText: string): string {
  const key = merchantKey(rawText)
  if (!key) return ''
  return key.split(' ').slice(0, 2).join(' ')
}

/** Text used for duplicate detection — aggressive, since a bank re-exports identically. */
export function dedupText(rawText: string): string {
  return normalizeText(rawText).replace(/[^a-z0-9æøå ]/g, '').replace(/\s+/g, ' ').trim()
}
