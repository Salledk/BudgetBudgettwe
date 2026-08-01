/**
 * Dates are stored as plain ISO day strings ("2026-03-14") — no time, no zone.
 * A bank transaction happens on a day, and attaching a timezone to it only
 * creates opportunities for it to drift into the previous month.
 */

export type IsoDay = string // yyyy-MM-dd
export type IsoMonth = string // yyyy-MM

export const DATE_FORMATS = [
  'dd-MM-yyyy',
  'dd.MM.yyyy',
  'dd/MM/yyyy',
  'yyyy-MM-dd',
  'yyyy/MM/dd',
  'MM/dd/yyyy',
  'dd-MM-yy',
  'dd.MM.yy',
  'ddMMyyyy',
] as const

export type DateFormat = (typeof DATE_FORMATS)[number]

const PATTERNS: Record<DateFormat, RegExp> = {
  'dd-MM-yyyy': /^(\d{1,2})-(\d{1,2})-(\d{4})$/,
  'dd.MM.yyyy': /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/,
  'dd/MM/yyyy': /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
  'yyyy-MM-dd': /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
  'yyyy/MM/dd': /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/,
  'MM/dd/yyyy': /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
  'dd-MM-yy': /^(\d{1,2})-(\d{1,2})-(\d{2})$/,
  'dd.MM.yy': /^(\d{1,2})\.(\d{1,2})\.(\d{2})$/,
  ddMMyyyy: /^(\d{2})(\d{2})(\d{4})$/,
}

/** Field order for each format, so one matcher can serve them all. */
const ORDER: Record<DateFormat, ['d' | 'm' | 'y', 'd' | 'm' | 'y', 'd' | 'm' | 'y']> = {
  'dd-MM-yyyy': ['d', 'm', 'y'],
  'dd.MM.yyyy': ['d', 'm', 'y'],
  'dd/MM/yyyy': ['d', 'm', 'y'],
  'yyyy-MM-dd': ['y', 'm', 'd'],
  'yyyy/MM/dd': ['y', 'm', 'd'],
  'MM/dd/yyyy': ['m', 'd', 'y'],
  'dd-MM-yy': ['d', 'm', 'y'],
  'dd.MM.yy': ['d', 'm', 'y'],
  ddMMyyyy: ['d', 'm', 'y'],
}

export function parseDate(input: string | number | Date | null | undefined, format?: DateFormat): IsoDay | null {
  if (input === null || input === undefined) return null

  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : toIsoDay(input.getFullYear(), input.getMonth() + 1, input.getDate())
  }

  // Excel serial date numbers (days since 1899-12-30).
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) return null
    const ms = Math.round(input) * 86400000 + Date.UTC(1899, 11, 30)
    const d = new Date(ms)
    return toIsoDay(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
  }

  const s = input.trim()
  if (s === '') return null

  const candidates: DateFormat[] = format ? [format] : [...DATE_FORMATS]
  for (const fmt of candidates) {
    const m = PATTERNS[fmt].exec(s)
    if (!m) continue
    const order = ORDER[fmt]
    let d = 0
    let mo = 0
    let y = 0
    for (let i = 0; i < 3; i++) {
      const n = Number(m[i + 1])
      if (order[i] === 'd') d = n
      else if (order[i] === 'm') mo = n
      else y = n
    }
    if (y < 100) y += y < 70 ? 2000 : 1900
    if (!isRealDate(y, mo, d)) continue
    return toIsoDay(y, mo, d)
  }
  return null
}

/**
 * Picks the format that parses the most sample values. Ties break toward the
 * earlier entry in DATE_FORMATS, which puts Danish day-first ahead of US
 * month-first — the right default here, and the reason "03/04/2026" resolves
 * to 3 April rather than 4 March.
 */
export function guessDateFormat(samples: string[]): DateFormat | null {
  const clean = samples.map((s) => (s ?? '').trim()).filter(Boolean)
  if (clean.length === 0) return null

  let best: DateFormat | null = null
  let bestScore = 0
  for (const fmt of DATE_FORMATS) {
    let score = 0
    for (const s of clean) if (parseDate(s, fmt)) score++
    if (score > bestScore) {
      bestScore = score
      best = fmt
    }
  }
  // Require most rows to parse, otherwise we picked up coincidental matches.
  return bestScore >= Math.ceil(clean.length * 0.8) ? best : null
}

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  if (y < 1900 || y > 2200) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export function toIsoDay(y: number, m: number, d: number): IsoDay {
  return `${y}-${pad(m)}-${pad(d)}`
}

export function monthOf(day: IsoDay): IsoMonth {
  return day.slice(0, 7)
}

export function todayIso(now: Date = new Date()): IsoDay {
  return toIsoDay(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

export function currentMonth(now: Date = new Date()): IsoMonth {
  return todayIso(now).slice(0, 7)
}

export function daysInMonth(month: IsoMonth): number {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** Day-of-month for "today" if the month is current; otherwise the full month. */
export function elapsedDaysInMonth(month: IsoMonth, now: Date = new Date()): number {
  const today = todayIso(now)
  const thisMonth = today.slice(0, 7)
  if (month < thisMonth) return daysInMonth(month)
  if (month > thisMonth) return 0
  return Number(today.slice(8, 10))
}

export function addMonths(month: IsoMonth, delta: number): IsoMonth {
  const [y, m] = month.split('-').map(Number)
  const total = y * 12 + (m - 1) + delta
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`
}

/** Inclusive list of months, oldest first. */
export function monthRange(from: IsoMonth, to: IsoMonth): IsoMonth[] {
  const out: IsoMonth[] = []
  let cur = from
  // Guard against an inverted range producing an unbounded loop.
  for (let i = 0; cur <= to && i < 1200; i++) {
    out.push(cur)
    cur = addMonths(cur, 1)
  }
  return out
}

/** The N complete months before the current one, oldest first. */
export function lastCompleteMonths(count: number, now: Date = new Date()): IsoMonth[] {
  const previous = addMonths(currentMonth(now), -1)
  return monthRange(addMonths(previous, -(count - 1)), previous)
}

export function daysBetween(a: IsoDay, b: IsoDay): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000)
}

const DAY_LABEL = new Intl.DateTimeFormat('da-DK', { weekday: 'long', day: 'numeric', month: 'long' })
const MONTH_LABEL = new Intl.DateTimeFormat('da-DK', { month: 'long', year: 'numeric' })

export function formatDayLabel(day: IsoDay, now: Date = new Date()): string {
  const today = todayIso(now)
  if (day === today) return 'I dag'
  const [y, m, d] = day.split('-').map(Number)
  const yesterday = daysBetween(day, today) === 1
  if (yesterday) return 'I går'
  return capitalise(DAY_LABEL.format(new Date(y, m - 1, d)))
}

export function formatMonthLabel(month: IsoMonth): string {
  const [y, m] = month.split('-').map(Number)
  return capitalise(MONTH_LABEL.format(new Date(y, m - 1, 1)))
}

export function formatShortDay(day: IsoDay): string {
  const [, m, d] = day.split('-').map(Number)
  return `${d}/${m}`
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
