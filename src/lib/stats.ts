/**
 * Robust statistics for budget suggestion. Everything here is deliberately
 * median-based rather than mean-based: one annual insurance payment or a
 * holiday would drag a mean-derived monthly budget somewhere useless.
 */

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

/** Median absolute deviation — the spread measure that ignores outliers. */
export function mad(values: number[]): number {
  if (values.length === 0) return 0
  const m = median(values)
  return median(values.map((v) => Math.abs(v - m)))
}

export function stdDev(values: number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

/**
 * Coefficient of variation — spread relative to size. This is what separates
 * "rent, 8.500 every month" from "groceries, somewhere between 1.800 and 4.200".
 */
export function coefficientOfVariation(values: number[]): number {
  const m = mean(values)
  if (m === 0) return 0
  return stdDev(values) / Math.abs(m)
}

/** Drops the top and bottom `fraction` of values before averaging. */
export function trimmedMean(values: number[], fraction = 0.2): number {
  if (values.length === 0) return 0
  if (values.length < 4) return median(values)
  const s = [...values].sort((a, b) => a - b)
  const drop = Math.floor(s.length * fraction)
  const kept = s.slice(drop, s.length - drop)
  return Math.round(mean(kept.length > 0 ? kept : s))
}

/** Linear-interpolated percentile. `p` is 0..1. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  if (s.length === 1) return s[0]
  const idx = (s.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return s[lo]
  return Math.round(s[lo] + (s[hi] - s[lo]) * (idx - lo))
}

/**
 * Flags values far above the median as one-offs.
 *
 * Uses MAD rather than standard deviation because a single large value inflates
 * the standard deviation enough to hide itself. The 1.4826 factor makes MAD
 * comparable to a standard deviation for normally distributed data.
 *
 * Only the upper tail matters — an unusually cheap month is not a problem to
 * budget around.
 */
export function detectOutliers(values: number[], threshold = 3): { normal: number[]; outliers: number[] } {
  if (values.length < 4) return { normal: [...values], outliers: [] }

  const m = median(values)
  const scale = mad(values) * 1.4826

  // A zero MAD means over half the values are identical; fall back to a
  // proportional cutoff so a genuine spike is still caught.
  const cutoff = scale === 0 ? m * 2.5 : m + threshold * scale

  const normal: number[] = []
  const outliers: number[] = []
  for (const v of values) {
    if (v > cutoff && v > m) outliers.push(v)
    else normal.push(v)
  }
  // Never let outlier removal empty the set.
  if (normal.length === 0) return { normal: [...values], outliers: [] }
  return { normal, outliers }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Rounds to a human budget figure: nearest 50 kr under 1.000, else nearest 100. */
export function roundToBudgetFigure(minor: number): number {
  const abs = Math.abs(minor)
  const step = abs < 100_000 ? 5_000 : 10_000
  const rounded = Math.round(abs / step) * step
  return minor < 0 ? -rounded : rounded
}
