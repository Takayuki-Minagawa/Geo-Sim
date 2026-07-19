export type BaselineCorrectionMethod = 'none' | 'mean' | 'linear'

export interface BaselineCorrectionResult {
  method: BaselineCorrectionMethod
  correctedValues: number[]
  /** Constant term removed at the first sample, in the input value's units. */
  removedIntercept: number
  /** Linear trend removed per second, in the input value's units per second. */
  removedSlopePerSecond: number
}

export interface AccelerationIntegrationOptions {
  /** `mean` is the safe default for raw records; see the module README. */
  baselineCorrection?: BaselineCorrectionMethod
  initialVelocityMps?: number
  initialDisplacementM?: number
}

export interface IntegratedMotion {
  correctedAccelerationMps2: number[]
  velocityMps: number[]
  displacementM: number[]
  baseline: BaselineCorrectionResult
}

function assertTimeSeries(timesS: readonly number[], values: readonly number[]): void {
  if (timesS.length !== values.length) {
    throw new Error('Time and value arrays must have the same length')
  }
  if (timesS.length < 2) {
    throw new Error('At least two samples are required')
  }

  for (let index = 0; index < timesS.length; index += 1) {
    const time = timesS[index]
    const value = values[index]
    if (time === undefined || !Number.isFinite(time)) {
      throw new Error(`Time at index ${index} must be finite`)
    }
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error(`Value at index ${index} must be finite`)
    }
    if (index > 0) {
      const previous = timesS[index - 1]
      if (previous === undefined || time <= previous) {
        throw new Error('Times must be strictly increasing')
      }
    }
  }
}

function trapezoidalArea(timesS: readonly number[], values: readonly number[]): number {
  let area = 0
  for (let index = 1; index < timesS.length; index += 1) {
    const previousTime = timesS[index - 1]
    const time = timesS[index]
    const previousValue = values[index - 1]
    const value = values[index]
    if (
      previousTime === undefined ||
      time === undefined ||
      previousValue === undefined ||
      value === undefined
    ) {
      throw new Error('Time series contains a missing sample')
    }
    area += 0.5 * (previousValue + value) * (time - previousTime)
  }
  return area
}

/**
 * Remove no trend, a time-weighted mean, or a least-squares linear trend.
 *
 * `mean` subtracts integral(value)/duration, so trapezoidal integration of the
 * corrected acceleration has zero net velocity change. `linear` subtracts a
 * least-squares affine trend and then removes its small residual weighted mean.
 */
export function correctBaseline(
  timesS: readonly number[],
  values: readonly number[],
  method: BaselineCorrectionMethod = 'mean',
): BaselineCorrectionResult {
  assertTimeSeries(timesS, values)

  if (method === 'none') {
    return {
      method,
      correctedValues: [...values],
      removedIntercept: 0,
      removedSlopePerSecond: 0,
    }
  }

  const firstTime = timesS[0]
  const lastTime = timesS[timesS.length - 1]
  if (firstTime === undefined || lastTime === undefined) {
    throw new Error('Time series is empty')
  }
  const duration = lastTime - firstTime

  if (method === 'mean') {
    const weightedMean = trapezoidalArea(timesS, values) / duration
    return {
      method,
      correctedValues: values.map((value) => value - weightedMean),
      removedIntercept: weightedMean,
      removedSlopePerSecond: 0,
    }
  }

  if (method !== 'linear') {
    throw new Error(`Unsupported baseline correction: ${String(method)}`)
  }

  let sumTime = 0
  let sumValue = 0
  let sumTimeSquared = 0
  let sumTimeValue = 0
  for (let index = 0; index < timesS.length; index += 1) {
    const time = timesS[index]
    const value = values[index]
    if (time === undefined || value === undefined) {
      throw new Error('Time series contains a missing sample')
    }
    const relativeTime = time - firstTime
    sumTime += relativeTime
    sumValue += value
    sumTimeSquared += relativeTime * relativeTime
    sumTimeValue += relativeTime * value
  }

  const count = timesS.length
  const denominator = count * sumTimeSquared - sumTime * sumTime
  const slope = denominator === 0 ? 0 : (count * sumTimeValue - sumTime * sumValue) / denominator
  const intercept = (sumValue - slope * sumTime) / count
  const detrended = values.map((value, index) => {
    const time = timesS[index]
    if (time === undefined) throw new Error('Time series contains a missing sample')
    return value - (intercept + slope * (time - firstTime))
  })

  // Discrete least squares and trapezoidal weighting differ at the end points.
  // Removing this residual makes the integrated final velocity deterministic.
  const residualWeightedMean = trapezoidalArea(timesS, detrended) / duration
  return {
    method,
    correctedValues: detrended.map((value) => value - residualWeightedMean),
    removedIntercept: intercept + residualWeightedMean,
    removedSlopePerSecond: slope,
  }
}

/** Cumulative trapezoidal integration with an explicit initial value. */
export function trapezoidalIntegrate(
  timesS: readonly number[],
  values: readonly number[],
  initialValue = 0,
): number[] {
  assertTimeSeries(timesS, values)
  if (!Number.isFinite(initialValue)) {
    throw new Error('Initial value must be finite')
  }

  const integrated = new Array<number>(values.length)
  integrated[0] = initialValue
  for (let index = 1; index < values.length; index += 1) {
    const previousTime = timesS[index - 1]
    const time = timesS[index]
    const previousValue = values[index - 1]
    const value = values[index]
    const previousIntegral = integrated[index - 1]
    if (
      previousTime === undefined ||
      time === undefined ||
      previousValue === undefined ||
      value === undefined ||
      previousIntegral === undefined
    ) {
      throw new Error('Time series contains a missing sample')
    }
    integrated[index] =
      previousIntegral + 0.5 * (previousValue + value) * (time - previousTime)
  }
  return integrated
}

/**
 * Integrate acceleration twice. No high-pass filter is hidden in this routine;
 * callers explicitly select `none`, `mean`, or `linear` baseline correction.
 */
export function integrateAcceleration(
  timesS: readonly number[],
  accelerationMps2: readonly number[],
  options: AccelerationIntegrationOptions = {},
): IntegratedMotion {
  const initialVelocity = options.initialVelocityMps ?? 0
  const initialDisplacement = options.initialDisplacementM ?? 0
  if (!Number.isFinite(initialVelocity) || !Number.isFinite(initialDisplacement)) {
    throw new Error('Initial velocity and displacement must be finite')
  }

  const baseline = correctBaseline(
    timesS,
    accelerationMps2,
    options.baselineCorrection ?? 'mean',
  )
  const velocity = trapezoidalIntegrate(timesS, baseline.correctedValues, initialVelocity)
  const displacement = trapezoidalIntegrate(timesS, velocity, initialDisplacement)
  return {
    correctedAccelerationMps2: baseline.correctedValues,
    velocityMps: velocity,
    displacementM: displacement,
    baseline,
  }
}

/** Maximum absolute finite value in a non-empty series. */
export function peakAbsolute(values: readonly number[]): number {
  if (values.length === 0) throw new Error('Cannot calculate a peak of an empty series')
  let peak = 0
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error(`Value at index ${index} must be finite`)
    }
    peak = Math.max(peak, Math.abs(value))
  }
  return peak
}
