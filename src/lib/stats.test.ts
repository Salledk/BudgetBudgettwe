import { describe, expect, it } from 'vitest'
import {
  coefficientOfVariation,
  detectOutliers,
  mad,
  median,
  percentile,
  roundToBudgetFigure,
  trimmedMean,
} from './stats'

describe('median', () => {
  it('handles odd and even counts', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(3) // rounded midpoint of 2 and 3
    expect(median([])).toBe(0)
    expect(median([7])).toBe(7)
  })
})

describe('coefficientOfVariation', () => {
  it('is near zero for a fixed bill', () => {
    expect(coefficientOfVariation([850000, 850000, 850000, 850000])).toBe(0)
    expect(coefficientOfVariation([850000, 851000, 849000])).toBeLessThan(0.01)
  })

  it('is high for erratic spending', () => {
    expect(coefficientOfVariation([180000, 420000, 220000, 390000])).toBeGreaterThan(0.3)
  })

  it('does not divide by a zero mean', () => {
    expect(coefficientOfVariation([0, 0, 0])).toBe(0)
  })
})

describe('detectOutliers', () => {
  it('pulls out an annual payment hiding among monthly ones', () => {
    // Eleven ordinary months and one insurance premium.
    const values = [20000, 21000, 19500, 20500, 22000, 19000, 21500, 20000, 480000]
    const { normal, outliers } = detectOutliers(values)
    expect(outliers).toEqual([480000])
    expect(normal).toHaveLength(8)
  })

  it('leaves steady values alone', () => {
    const values = [20000, 21000, 19500, 20500, 22000]
    const { outliers } = detectOutliers(values)
    expect(outliers).toEqual([])
  })

  it('ignores the lower tail — a cheap month is not a problem', () => {
    const values = [20000, 21000, 19500, 20500, 100]
    const { outliers } = detectOutliers(values)
    expect(outliers).toEqual([])
  })

  it('still catches a spike when MAD is zero', () => {
    // Identical values give MAD 0; a proportional cutoff must take over.
    const values = [10000, 10000, 10000, 10000, 90000]
    const { outliers } = detectOutliers(values)
    expect(outliers).toEqual([90000])
  })

  it('never empties the set', () => {
    const { normal } = detectOutliers([5, 5, 5, 5])
    expect(normal.length).toBeGreaterThan(0)
  })

  it('does not attempt outlier detection on too few values', () => {
    const { normal, outliers } = detectOutliers([10, 900])
    expect(outliers).toEqual([])
    expect(normal).toEqual([10, 900])
  })
})

describe('trimmedMean', () => {
  it('discards the extremes', () => {
    // 1 and 100 are trimmed; the middle values decide.
    expect(trimmedMean([1, 10, 11, 12, 13, 100])).toBeGreaterThan(9)
    expect(trimmedMean([1, 10, 11, 12, 13, 100])).toBeLessThan(15)
  })

  it('falls back to the median for short series', () => {
    expect(trimmedMean([10, 20, 30])).toBe(20)
  })

  it('handles an empty series', () => {
    expect(trimmedMean([])).toBe(0)
  })
})

describe('percentile', () => {
  it('interpolates', () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25)
    expect(percentile([10, 20, 30, 40], 0)).toBe(10)
    expect(percentile([10, 20, 30, 40], 1)).toBe(40)
  })

  it('handles single values and empties', () => {
    expect(percentile([42], 0.75)).toBe(42)
    expect(percentile([], 0.75)).toBe(0)
  })
})

describe('mad', () => {
  it('measures spread without being moved by an outlier', () => {
    expect(mad([10, 10, 10, 10])).toBe(0)
    expect(mad([10, 12, 14, 1000])).toBe(mad([10, 12, 14, 16]))
  })
})

describe('roundToBudgetFigure', () => {
  it('rounds amounts under 1.000 kr to the nearest 50 kr', () => {
    expect(roundToBudgetFigure(87_34)).toBe(100_00)
    expect(roundToBudgetFigure(320_00)).toBe(300_00)
    expect(roundToBudgetFigure(333_00)).toBe(350_00)
  })

  it('rounds amounts from 1.000 kr up to the nearest 100 kr', () => {
    expect(roundToBudgetFigure(2_347_00)).toBe(2_300_00)
    expect(roundToBudgetFigure(2_360_00)).toBe(2_400_00)
    expect(roundToBudgetFigure(8_512_00)).toBe(8_500_00)
  })

  it('preserves sign', () => {
    expect(roundToBudgetFigure(-2_347_00)).toBe(-2_300_00)
  })
})
