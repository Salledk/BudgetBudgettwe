import { newId } from '@/lib/id'
import type { Account, Category, Rule } from './types'
import { SYSTEM_CATEGORY } from './types'

type NewCategory = Omit<Category, 'id' | 'updatedAt' | 'deletedAt'> & { id?: string }

/**
 * Default Danish category set. Split into fixed and variable groups because
 * that distinction drives how each one gets budgeted and projected later.
 */
const CATEGORY_SEED: NewCategory[] = [
  // Income
  { name: 'Løn', kind: 'income', parentId: null, icon: '💰', color: '#16a34a', isSystem: false, archived: false, sortOrder: 10 },
  { name: 'Refusion', kind: 'income', parentId: null, icon: '↩️', color: '#22c55e', isSystem: false, archived: false, sortOrder: 20 },
  { name: 'Anden indkomst', kind: 'income', parentId: null, icon: '✨', color: '#4ade80', isSystem: false, archived: false, sortOrder: 30 },

  // Fixed / recurring
  { name: 'Husleje', kind: 'expense', parentId: null, icon: '🏠', color: '#dc2626', isSystem: false, archived: false, sortOrder: 100 },
  { name: 'El, vand & varme', kind: 'expense', parentId: null, icon: '💡', color: '#ea580c', isSystem: false, archived: false, sortOrder: 110 },
  { name: 'Internet & TV', kind: 'expense', parentId: null, icon: '📺', color: '#d97706', isSystem: false, archived: false, sortOrder: 120 },
  { name: 'Telefon', kind: 'expense', parentId: null, icon: '📱', color: '#ca8a04', isSystem: false, archived: false, sortOrder: 130 },
  { name: 'Forsikring', kind: 'expense', parentId: null, icon: '🛡️', color: '#65a30d', isSystem: false, archived: false, sortOrder: 140 },
  { name: 'Abonnementer', kind: 'expense', parentId: null, icon: '🔁', color: '#0891b2', isSystem: false, archived: false, sortOrder: 150 },
  { name: 'Lån & afdrag', kind: 'expense', parentId: null, icon: '🏦', color: '#b91c1c', isSystem: false, archived: false, sortOrder: 160 },
  { name: 'A-kasse & fagforening', kind: 'expense', parentId: null, icon: '📋', color: '#0284c7', isSystem: false, archived: false, sortOrder: 170 },
  { name: 'Transport', kind: 'expense', parentId: null, icon: '🚌', color: '#2563eb', isSystem: false, archived: false, sortOrder: 180 },

  // Variable
  { name: 'Dagligvarer', kind: 'expense', parentId: null, icon: '🛒', color: '#059669', isSystem: false, archived: false, sortOrder: 200 },
  { name: 'Restaurant & takeaway', kind: 'expense', parentId: null, icon: '🍕', color: '#f59e0b', isSystem: false, archived: false, sortOrder: 210 },
  { name: 'Café', kind: 'expense', parentId: null, icon: '☕', color: '#a16207', isSystem: false, archived: false, sortOrder: 220 },
  { name: 'Bil & brændstof', kind: 'expense', parentId: null, icon: '⛽', color: '#7c3aed', isSystem: false, archived: false, sortOrder: 230 },
  { name: 'Tøj & sko', kind: 'expense', parentId: null, icon: '👕', color: '#db2777', isSystem: false, archived: false, sortOrder: 240 },
  { name: 'Personlig pleje', kind: 'expense', parentId: null, icon: '🧴', color: '#e11d48', isSystem: false, archived: false, sortOrder: 250 },
  { name: 'Sundhed & apotek', kind: 'expense', parentId: null, icon: '💊', color: '#be123c', isSystem: false, archived: false, sortOrder: 260 },
  { name: 'Underholdning', kind: 'expense', parentId: null, icon: '🎬', color: '#9333ea', isSystem: false, archived: false, sortOrder: 270 },
  { name: 'Fritid & hobby', kind: 'expense', parentId: null, icon: '🎸', color: '#7e22ce', isSystem: false, archived: false, sortOrder: 280 },
  { name: 'Hjem & husholdning', kind: 'expense', parentId: null, icon: '🪑', color: '#0d9488', isSystem: false, archived: false, sortOrder: 290 },
  { name: 'Gaver', kind: 'expense', parentId: null, icon: '🎁', color: '#c026d3', isSystem: false, archived: false, sortOrder: 300 },
  { name: 'Rejser & ferie', kind: 'expense', parentId: null, icon: '✈️', color: '#0ea5e9', isSystem: false, archived: false, sortOrder: 310 },
  { name: 'Børn', kind: 'expense', parentId: null, icon: '🧸', color: '#f97316', isSystem: false, archived: false, sortOrder: 320 },
  { name: 'Kontanter', kind: 'expense', parentId: null, icon: '💵', color: '#78716c', isSystem: false, archived: false, sortOrder: 330 },
  { name: 'Diverse', kind: 'expense', parentId: null, icon: '📦', color: '#64748b', isSystem: false, archived: false, sortOrder: 340 },

  // System — cannot be deleted, excluded from budgets and income/expense math.
  { id: SYSTEM_CATEGORY.transfer, name: 'Overførsel', kind: 'transfer', parentId: null, icon: '🔄', color: '#94a3b8', isSystem: true, archived: false, sortOrder: 900 },
  { id: SYSTEM_CATEGORY.savings, name: 'Opsparing', kind: 'savings', parentId: null, icon: '🐖', color: '#0369a1', isSystem: true, archived: false, sortOrder: 910 },
]

export function buildSeedCategories(now = Date.now()): Category[] {
  return CATEGORY_SEED.map((c) => ({
    ...c,
    id: c.id ?? newId(now),
    updatedAt: now,
    deletedAt: null,
  }))
}

export function buildSeedAccounts(now = Date.now()): Account[] {
  const base = { updatedAt: now, deletedAt: null, openingBalanceMinor: 0, accountNumber: null, archived: false }
  return [
    { ...base, id: newId(now), name: 'Budgetkonto', kind: 'budget' as const, sortOrder: 10 },
    { ...base, id: newId(now), name: 'Forbrugskonto', kind: 'spending' as const, sortOrder: 20 },
    { ...base, id: newId(now), name: 'Opsparing', kind: 'savings' as const, sortOrder: 30 },
  ]
}

/**
 * Seed merchant rules, matched against the normalised merchant key.
 *
 * Patterns are intentionally short chain names — `merchantKey` has already
 * stripped store numbers, cities and dates by the time these run.
 *
 * MobilePay is deliberately absent: "MobilePay Anders" could be rent, a shared
 * dinner or a gift, and guessing wrong is worse than leaving it uncategorised.
 */
const RULE_SEED: Array<{ patterns: string[]; category: string }> = [
  {
    category: 'Dagligvarer',
    patterns: [
      'netto', 'føtex', 'fotex', 'rema', 'bilka', 'lidl', 'aldi', 'coop', '365discount', 'fakta',
      'irma', 'meny', 'spar', 'superbrugsen', 'kvickly', 'brugsen', 'salling', 'nemlig', 'købmand',
      'løvbjerg', 'lovbjerg', 'abc lavpris',
    ],
  },
  {
    category: 'Restaurant & takeaway',
    patterns: [
      'mcdonald', 'burger king', 'sunset boulevard', 'domino', 'pizza', 'sushi', 'wolt', 'just eat',
      'restaurant', 'kebab', 'grill', 'cafeteria', 'jensens', 'bone', 'letz sushi', 'joe and the juice',
      'espresso house', 'starbucks', 'lagkagehuset', 'baresso',
    ],
  },
  { category: 'Café', patterns: ['cafe', 'café', 'kaffe', 'bager', 'konditori'] },
  {
    category: 'Bil & brændstof',
    patterns: ['circle k', 'q8', 'shell', 'ok benzin', 'ok plus', 'uno-x', 'ingo', 'f24', 'tank', 'fdm', 'autoværksted', 'dæk'],
  },
  {
    category: 'Transport',
    patterns: ['dsb', 'rejsekort', 'movia', 'metro', 'arriva', 'midttrafik', 'fynbus', 'nordjyllands trafik', 'taxa', 'dantaxi', 'flixbus', 'parkering', 'easypark', 'parkman'],
  },
  {
    category: 'Abonnementer',
    patterns: ['spotify', 'netflix', 'hbo', 'max', 'viaplay', 'disney', 'tv 2 play', 'apple.com/bill', 'apple com bill', 'itunes', 'google', 'youtube', 'amazon prime', 'dropbox', 'adobe', 'microsoft', 'storytel', 'mofibo', 'podimo', 'audible', 'patreon', 'strava'],
  },
  { category: 'Telefon', patterns: ['telia', 'telenor', 'yousee', 'cbb', 'oister', 'lebara', 'lycamobile', 'callme', 'telmore', 'greentel'] },
  { category: 'Internet & TV', patterns: ['hiper', 'fastspeed', 'stofa', 'waoo', 'kviknet', 'altibox', 'norlys internet'] },
  { category: 'El, vand & varme', patterns: ['ørsted', 'orsted', 'andel energi', 'norlys', 'ewii', 'nrgi', 'energi fyn', 'vandværk', 'hofor', 'fjernvarme', 'radius', 'cerius', 'gasleverandør', 'natur energi', 'velkommen'] },
  { category: 'Forsikring', patterns: ['tryg', 'topdanmark', 'alka', 'codan', 'if forsikring', 'gjensidige', 'alm brand', 'lb forsikring', 'gf forsikring', 'popermo', 'pensiondanmark', 'sygeforsikring', 'danmark forsikring'] },
  { category: 'Husleje', patterns: ['husleje', 'boligforening', 'boligselskab', 'lejemål', 'ejerforening', 'andelsboligforening', 'kab', 'dab', 'fsb', 'aab'] },
  { category: 'A-kasse & fagforening', patterns: ['a-kasse', 'akasse', 'fagforening', '3f', 'hk ', 'krifa', 'ase', 'ingeniørforeningen', 'djøf', 'dansk metal', 'ftfa', 'magistrenes'] },
  { category: 'Lån & afdrag', patterns: ['realkredit', 'totalkredit', 'nordea kredit', 'jyske realkredit', 'lån & spar', 'afdrag', 'santander', 'ekspres bank', 'resurs bank'] },
  { category: 'Sundhed & apotek', patterns: ['apotek', 'læge', 'tandlæge', 'fysioterapi', 'kiropraktor', 'psykolog', 'sygesikring', 'falck', 'hospital', 'klinik'] },
  { category: 'Personlig pleje', patterns: ['matas', 'normal', 'frisør', 'saloon', 'the body shop', 'skønhed'] },
  { category: 'Fritid & hobby', patterns: ['fitness world', 'sats', 'puregym', 'loop fitness', 'sportmaster', 'intersport', 'decathlon', 'stadium', 'padel', 'svømmehal', 'bibliotek', 'golf'] },
  { category: 'Underholdning', patterns: ['nordisk film', 'cinemaxx', 'biograf', 'ticketmaster', 'billetlugen', 'billetto', 'tivoli', 'zoo', 'koncert', 'steam', 'playstation', 'nintendo', 'xbox'] },
  { category: 'Tøj & sko', patterns: ['h&m', 'zara', 'zalando', 'bestseller', 'only', 'vero moda', 'jack jones', 'magasin', 'bahne', 'skoringen', 'nike', 'adidas', 'asos', 'boozt', 'na-kd'] },
  { category: 'Hjem & husholdning', patterns: ['ikea', 'jysk', 'ilva', 'sinnerup', 'elgiganten', 'power', 'bilka byg', 'silvan', 'bauhaus', 'jem og fix', 'stark', 'flying tiger', 'søstrene grene', 'sostrene grene', 'imerco', 'kop og kande'] },
  { category: 'Gaver', patterns: ['gavekort', 'interflora', 'blomster'] },
  { category: 'Rejser & ferie', patterns: ['sas', 'norwegian', 'ryanair', 'booking.com', 'airbnb', 'hotel', 'momondo', 'travellink', 'apollo rejser', 'spies', 'tui', 'dfds', 'molslinjen', 'scandlines'] },
  { category: 'Børn', patterns: ['daginstitution', 'vuggestue', 'børnehave', 'sfo', 'babysam', 'legetøj', 'br ', 'fritidshjem'] },
  { category: 'Kontanter', patterns: ['hævning', 'haevning', 'kontant', 'atm', 'automat udbetaling'] },
  { category: 'Løn', patterns: ['lønoverførsel', 'lon overforsel', 'løn ', 'salær', 'udbetaling løn'] },
]

export function buildSeedRules(categories: Category[], now = Date.now()): Rule[] {
  const byName = new Map(categories.map((c) => [c.name, c.id]))
  const rules: Rule[] = []

  for (const group of RULE_SEED) {
    const categoryId = byName.get(group.category)
    if (!categoryId) continue
    for (const pattern of group.patterns) {
      rules.push({
        id: newId(now),
        pattern: pattern.trim(),
        matchType: 'contains',
        categoryId,
        // Seed rules sit below user rules (1000+) so a user override always wins.
        // Longer patterns rank higher so "ok benzin" beats a bare "ok".
        priority: 100 + pattern.trim().length,
        source: 'seed',
        hitCount: 0,
        enabled: true,
        updatedAt: now,
        deletedAt: null,
      })
    }
  }
  return rules
}

export const USER_RULE_PRIORITY = 1000
