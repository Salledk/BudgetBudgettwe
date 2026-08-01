import { merchantKey, normalizeText } from '@/lib/normalize'
import type { CategorySource, Rule, Transaction } from '@/data/types'

/**
 * Three-layer categorisation, first match wins:
 *
 *   1. Rules   — user rules, then seeded merchant rules, ordered by priority.
 *   2. Learned — a merchant the user has categorised consistently before.
 *   3. Nothing — left uncategorised rather than guessed at.
 *
 * The engine is a pure function of (transaction, rules, history). It performs
 * no I/O, which is what makes it testable and lets the whole re-categorise
 * pass run over thousands of rows without touching the database.
 */

export interface CategorisationResult {
  categoryId: string | null
  source: CategorySource | null
  /** Rule that produced the match, for hit counting. */
  ruleId: string | null
  /** Learned matches carry how many past transactions back the guess. */
  confidence: number
}

export const NO_MATCH: CategorisationResult = {
  categoryId: null,
  source: null,
  ruleId: null,
  confidence: 0,
}

/** How many consistent past transactions before the learned layer will guess. */
export const LEARN_MIN_OCCURRENCES = 2
/** Share of a merchant's history that must agree on one category. */
export const LEARN_MIN_AGREEMENT = 0.7

export interface MerchantHistory {
  /** merchantKey → categoryId → count of user-confirmed assignments */
  byMerchant: Map<string, Map<string, number>>
}

export function categorise(
  tx: Pick<Transaction, 'rawText' | 'merchantKey' | 'amountMinor'>,
  rules: Rule[],
  history?: MerchantHistory,
): CategorisationResult {
  const key = tx.merchantKey || merchantKey(tx.rawText)
  const haystack = normalizeText(tx.rawText)

  // Layer 1 & 2 — rules, already sorted by priority (user rules first).
  for (const rule of rules) {
    if (!rule.enabled) continue
    if (matchesRule(rule, haystack, key)) {
      return {
        categoryId: rule.categoryId,
        source: rule.source === 'user' ? 'rule' : 'seed',
        ruleId: rule.id,
        confidence: 1,
      }
    }
  }

  // Layer 3 — learned from what the user has already done with this merchant.
  if (history && key) {
    const learned = learnedMatch(key, history)
    if (learned) return learned
  }

  return NO_MATCH
}

function matchesRule(rule: Rule, haystack: string, key: string): boolean {
  const pattern = rule.pattern.toLowerCase().trim()
  if (!pattern) return false

  switch (rule.matchType) {
    case 'exact':
      // Exact matches against the cleaned merchant key, not the raw text —
      // raw text almost never repeats verbatim.
      return key === pattern
    case 'regex':
      try {
        return new RegExp(pattern, 'i').test(haystack)
      } catch {
        // A malformed user regex must not break the whole import.
        return false
      }
    case 'contains':
    default:
      return matchesAtWordStart(haystack, pattern) || (key !== '' && matchesAtWordStart(key, pattern))
  }
}

const wordStartCache = new Map<string, RegExp>()

/**
 * Substring match anchored to the start of a word.
 *
 * A plain `includes` is far too loose on bank text: "3f" occurs constantly
 * inside hexadecimal reference ids, and "ase" sits inside "Andreasen" and
 * "Basel". Anchoring to a word start kills those while still matching the
 * run-together names banks produce, like "LIDL281KBENHAVNNVTUBOR" for "lidl".
 */
function matchesAtWordStart(haystack: string, pattern: string): boolean {
  let re = wordStartCache.get(pattern)
  if (!re) {
    const trimmed = pattern.trim()
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const boundary = '[^\\p{L}\\p{N}]'

    // Very short patterns must match a whole token. "3f" otherwise matches the
    // tail of a hyphenated hex reference like "5d0c-3f2a", and "ase" the middle
    // of "Andreasen". Longer patterns only need a word start, so run-together
    // bank text such as "LIDL281KBENHAVNNVTUBOR" still matches "lidl".
    re =
      trimmed.length <= 3
        ? new RegExp(`(^|${boundary})${escaped}(${boundary}|$)`, 'iu')
        : new RegExp(`(^|${boundary})${escaped}`, 'iu')

    wordStartCache.set(pattern, re)
  }
  return re.test(haystack)
}

function learnedMatch(key: string, history: MerchantHistory): CategorisationResult | null {
  const counts = history.byMerchant.get(key)
  if (!counts || counts.size === 0) return null

  let bestCategory: string | null = null
  let bestCount = 0
  let total = 0
  for (const [categoryId, count] of counts) {
    total += count
    if (count > bestCount) {
      bestCount = count
      bestCategory = categoryId
    }
  }

  if (!bestCategory) return null
  if (bestCount < LEARN_MIN_OCCURRENCES) return null
  // Split history ("sometimes groceries, sometimes household") is not a signal.
  if (bestCount / total < LEARN_MIN_AGREEMENT) return null

  return { categoryId: bestCategory, source: 'learned', ruleId: null, confidence: bestCount / total }
}

/**
 * Categorises a batch, threading learned knowledge forward as it goes so that
 * an import containing five Netto visits benefits from the first one being
 * matched — without needing a second pass.
 */
export function categoriseBatch(
  txs: Transaction[],
  rules: Rule[],
  history: MerchantHistory,
): { updated: Transaction[]; ruleHits: Map<string, number> } {
  const ruleHits = new Map<string, number>()
  const updated: Transaction[] = []

  for (const tx of txs) {
    // Transfers are decided by pairing, not by text — never overwrite them.
    if (tx.transferGroupId) continue
    // Never overwrite a human decision.
    if (tx.categorySource === 'manual') continue

    const result = categorise(tx, rules, history)
    if (!result.categoryId) continue

    if (result.ruleId) ruleHits.set(result.ruleId, (ruleHits.get(result.ruleId) ?? 0) + 1)

    updated.push({
      ...tx,
      categoryId: result.categoryId,
      categorySource: result.source,
      // Rule matches are trustworthy; learned guesses go to the review queue.
      reviewed: result.source !== 'learned',
      updatedAt: Date.now(),
    })
  }

  return { updated, ruleHits }
}

export function buildHistory(byMerchant: Map<string, Map<string, number>>): MerchantHistory {
  return { byMerchant }
}

/**
 * Suggests a rule pattern after a manual categorisation, e.g. the user picks
 * "Dagligvarer" for "NETTO 1234 KØBENHAVN DEN 12.03" and we offer to always
 * categorise "netto" that way.
 *
 * Returns null when the description yields nothing stable enough to key on —
 * a MobilePay transfer to a person, for instance, where the useful part is the
 * name and a rule would be wrong more often than right.
 */
export function suggestRulePattern(rawText: string): string | null {
  const key = merchantKey(rawText)
  if (!key) return null

  const words = key.split(' ').filter(Boolean)
  if (words.length === 0) return null

  // One or two words is the sweet spot: "netto", "circle k", "rema".
  const pattern = words.slice(0, 2).join(' ')
  if (pattern.length < 3) return null

  // Generic payment verbs make terrible rules — they'd match everything.
  const GENERIC = new Set([
    'mobilepay', 'overførsel', 'overforsel', 'betaling', 'køb', 'kob', 'visa', 'dankort',
    'straksoverførsel', 'indbetaling', 'udbetaling', 'bs betaling', 'betalingsservice',
  ])
  if (GENERIC.has(pattern) || GENERIC.has(words[0])) return null

  return pattern
}
