import type { ResponseSpectrumPoint } from '../../domain/types'
import { peakAbsolute } from './integration'

const NEWMARK_BETA = 0.25
const NEWMARK_GAMMA = 0.5

export const DEFAULT_RESPONSE_SPECTRUM_DAMPING_RATIO = 0.05

export interface ResponseSpectrumOptions {
  dampingRatio?: number
  /** Browser resource guard for a user-supplied period array. */
  maxPeriods?: number
  /** Internal Newmark step is limited to this fraction of oscillator period. */
  maxStepToPeriodRatio?: number
  /** Guard against excessive interpolation for an unrealistically short period. */
  maxSubstepsPerInterval?: number
}

export interface PeriodGridOptions {
  minPeriodS?: number
  maxPeriodS?: number
  positivePointCount?: number
  includeZero?: boolean
}

interface OscillatorState {
  displacement: number
  velocity: number
  relativeAcceleration: number
}

const DEFAULT_MAX_PERIODS = 2_000
const DEFAULT_MAX_STEP_TO_PERIOD_RATIO = 0.1
const DEFAULT_MAX_SUBSTEPS_PER_INTERVAL = 100

function assertSpectrumInput(
  timesS: readonly number[],
  accelerationMps2: readonly number[],
  periodsS: readonly number[],
  options: Required<ResponseSpectrumOptions>,
): void {
  if (timesS.length !== accelerationMps2.length || timesS.length < 2) {
    throw new Error('Time and acceleration arrays must have the same length of at least 2')
  }
  if (periodsS.length === 0) throw new Error('At least one response-spectrum period is required')
  if (periodsS.length > options.maxPeriods) {
    throw new Error(`Response-spectrum period count exceeds ${options.maxPeriods}`)
  }
  if (!Number.isFinite(options.dampingRatio) || options.dampingRatio < 0 || options.dampingRatio >= 1) {
    throw new Error('Damping ratio must be finite and in the range [0, 1)')
  }
  if (
    !Number.isFinite(options.maxStepToPeriodRatio) ||
    options.maxStepToPeriodRatio <= 0 ||
    options.maxStepToPeriodRatio > 1
  ) {
    throw new Error('maxStepToPeriodRatio must be in the range (0, 1]')
  }
  if (
    !Number.isSafeInteger(options.maxSubstepsPerInterval) ||
    options.maxSubstepsPerInterval < 1
  ) {
    throw new Error('maxSubstepsPerInterval must be a positive safe integer')
  }

  for (let index = 0; index < timesS.length; index += 1) {
    const time = timesS[index]
    const acceleration = accelerationMps2[index]
    if (time === undefined || !Number.isFinite(time)) {
      throw new Error(`Time at index ${index} must be finite`)
    }
    if (acceleration === undefined || !Number.isFinite(acceleration)) {
      throw new Error(`Acceleration at index ${index} must be finite`)
    }
    if (index > 0) {
      const previous = timesS[index - 1]
      if (previous === undefined || time <= previous) {
        throw new Error('Times must be strictly increasing')
      }
    }
  }
  for (let index = 0; index < periodsS.length; index += 1) {
    const period = periodsS[index]
    if (period === undefined || !Number.isFinite(period) || period < 0) {
      throw new Error(`Period at index ${index} must be finite and non-negative`)
    }
  }
}

function advanceAverageAcceleration(
  state: OscillatorState,
  groundAccelerationAtEnd: number,
  stepS: number,
  circularFrequency: number,
  dampingRatio: number,
): OscillatorState {
  const stiffness = circularFrequency * circularFrequency
  const damping = 2 * dampingRatio * circularFrequency
  const coefficient0 = 1 / (NEWMARK_BETA * stepS * stepS)
  const coefficient1 = NEWMARK_GAMMA / (NEWMARK_BETA * stepS)
  const coefficient2 = 1 / (NEWMARK_BETA * stepS)
  const coefficient3 = 1 / (2 * NEWMARK_BETA) - 1
  const coefficient4 = NEWMARK_GAMMA / NEWMARK_BETA - 1
  const coefficient5 = stepS * (NEWMARK_GAMMA / (2 * NEWMARK_BETA) - 1)
  const effectiveStiffness = stiffness + coefficient0 + damping * coefficient1
  const effectiveLoad =
    -groundAccelerationAtEnd +
    coefficient0 * state.displacement +
    coefficient2 * state.velocity +
    coefficient3 * state.relativeAcceleration +
    damping *
      (coefficient1 * state.displacement +
        coefficient4 * state.velocity +
        coefficient5 * state.relativeAcceleration)
  const displacement = effectiveLoad / effectiveStiffness
  const relativeAcceleration =
    coefficient0 * (displacement - state.displacement) -
    coefficient2 * state.velocity -
    coefficient3 * state.relativeAcceleration
  const velocity =
    state.velocity +
    stepS *
      ((1 - NEWMARK_GAMMA) * state.relativeAcceleration +
        NEWMARK_GAMMA * relativeAcceleration)
  return { displacement, velocity, relativeAcceleration }
}

function calculatePeriodResponse(
  timesS: readonly number[],
  groundAccelerationMps2: readonly number[],
  periodS: number,
  dampingRatio: number,
  maxStepToPeriodRatio: number,
  maxSubstepsPerInterval: number,
): ResponseSpectrumPoint {
  if (periodS === 0) {
    return {
      periodS,
      sdM: 0,
      svMps: 0,
      saMps2: peakAbsolute(groundAccelerationMps2),
    }
  }

  const circularFrequency = (2 * Math.PI) / periodS
  const firstAcceleration = groundAccelerationMps2[0]
  if (firstAcceleration === undefined) throw new Error('Ground motion is empty')
  let state: OscillatorState = {
    displacement: 0,
    velocity: 0,
    relativeAcceleration: -firstAcceleration,
  }
  let peakDisplacement = 0
  let peakVelocity = 0
  let peakAbsoluteAcceleration = 0

  for (let index = 1; index < timesS.length; index += 1) {
    const previousTime = timesS[index - 1]
    const time = timesS[index]
    const previousGroundAcceleration = groundAccelerationMps2[index - 1]
    const groundAcceleration = groundAccelerationMps2[index]
    if (
      previousTime === undefined ||
      time === undefined ||
      previousGroundAcceleration === undefined ||
      groundAcceleration === undefined
    ) {
      throw new Error('Ground motion contains a missing sample')
    }

    const interval = time - previousTime
    const requestedSubsteps = Math.ceil(interval / (maxStepToPeriodRatio * periodS))
    const substeps = Math.min(maxSubstepsPerInterval, Math.max(1, requestedSubsteps))
    const substepSize = interval / substeps
    for (let substep = 1; substep <= substeps; substep += 1) {
      const fraction = substep / substeps
      const interpolatedGroundAcceleration =
        previousGroundAcceleration +
        fraction * (groundAcceleration - previousGroundAcceleration)
      state = advanceAverageAcceleration(
        state,
        interpolatedGroundAcceleration,
        substepSize,
        circularFrequency,
        dampingRatio,
      )
      const absoluteAcceleration =
        state.relativeAcceleration + interpolatedGroundAcceleration
      peakDisplacement = Math.max(peakDisplacement, Math.abs(state.displacement))
      peakVelocity = Math.max(peakVelocity, Math.abs(state.velocity))
      peakAbsoluteAcceleration = Math.max(
        peakAbsoluteAcceleration,
        Math.abs(absoluteAcceleration),
      )
    }
  }

  return {
    periodS,
    sdM: peakDisplacement,
    svMps: peakVelocity,
    saMps2: peakAbsoluteAcceleration,
  }
}

/**
 * Calculate a linear elastic response spectrum using the unconditionally stable
 * Newmark average-acceleration method (beta=1/4, gamma=1/2).
 *
 * `sdM` and `svMps` are maxima of the absolute magnitudes of relative oscillator
 * response. `saMps2` is the true absolute mass acceleration |ü + ag|, not the
 * pseudo-acceleration omega^2 Sd. Period zero is represented by PGA and zero
 * relative displacement/velocity.
 */
export function computeElasticResponseSpectrum(
  timesS: readonly number[],
  groundAccelerationMps2: readonly number[],
  periodsS: readonly number[],
  options: ResponseSpectrumOptions = {},
): ResponseSpectrumPoint[] {
  const resolvedOptions: Required<ResponseSpectrumOptions> = {
    dampingRatio: options.dampingRatio ?? DEFAULT_RESPONSE_SPECTRUM_DAMPING_RATIO,
    maxPeriods: options.maxPeriods ?? DEFAULT_MAX_PERIODS,
    maxStepToPeriodRatio:
      options.maxStepToPeriodRatio ?? DEFAULT_MAX_STEP_TO_PERIOD_RATIO,
    maxSubstepsPerInterval:
      options.maxSubstepsPerInterval ?? DEFAULT_MAX_SUBSTEPS_PER_INTERVAL,
  }
  assertSpectrumInput(timesS, groundAccelerationMps2, periodsS, resolvedOptions)
  return periodsS.map((periodS) =>
    calculatePeriodResponse(
      timesS,
      groundAccelerationMps2,
      periodS,
      resolvedOptions.dampingRatio,
      resolvedOptions.maxStepToPeriodRatio,
      resolvedOptions.maxSubstepsPerInterval,
    ),
  )
}

/** Create a logarithmic positive period grid, optionally preceded by T=0. */
export function createLogSpacedPeriods(options: PeriodGridOptions = {}): number[] {
  const minPeriod = options.minPeriodS ?? 0.01
  const maxPeriod = options.maxPeriodS ?? 10
  const pointCount = options.positivePointCount ?? 160
  const includeZero = options.includeZero ?? true
  if (!Number.isFinite(minPeriod) || minPeriod <= 0) {
    throw new Error('minPeriodS must be finite and positive')
  }
  if (!Number.isFinite(maxPeriod) || maxPeriod <= minPeriod) {
    throw new Error('maxPeriodS must be finite and greater than minPeriodS')
  }
  if (!Number.isSafeInteger(pointCount) || pointCount < 2) {
    throw new Error('positivePointCount must be a safe integer greater than or equal to 2')
  }

  const logarithmicSpan = Math.log(maxPeriod / minPeriod)
  const periods = Array.from({ length: pointCount }, (_, index) =>
    index === pointCount - 1
      ? maxPeriod
      : minPeriod * Math.exp((logarithmicSpan * index) / (pointCount - 1)),
  )
  return includeZero ? [0, ...periods] : periods
}
