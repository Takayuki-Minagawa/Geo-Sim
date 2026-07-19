import type { AnalysisMessage, MotionRecord } from '../../domain/types'

export const STANDARD_GRAVITY_MPS2 = 9.80665
export const DEFAULT_MAX_MOTION_POINTS = 1_000_000

export interface MotionValidationOptions {
  /** Hard limit used to keep an uploaded record from exhausting browser memory. */
  maxPoints?: number
  /** Relative tolerance applied to the representative time step. */
  relativeTimeStepTolerance?: number
  /** Absolute tolerance in seconds, useful for rounded decimal time columns. */
  absoluteTimeStepToleranceS?: number
}

export interface NormalizedMotionRecord {
  name: string
  sourceAccelerationUnit: MotionRecord['accelerationUnit']
  timesS: number[]
  accelerationsMps2: number[]
  timeStepS: number
}

export interface MotionValidationResult {
  valid: boolean
  normalized?: NormalizedMotionRecord
  messages: AnalysisMessage[]
}

const DEFAULT_RELATIVE_TIME_STEP_TOLERANCE = 1e-6
const DEFAULT_ABSOLUTE_TIME_STEP_TOLERANCE_S = 1e-10

function error(code: string, message: string, path?: string): AnalysisMessage {
  return { code, severity: 'error', message, path }
}

function unitScaleToMps2(unit: string): number | undefined {
  switch (unit) {
    case 'm/s2':
      return 1
    case 'gal':
      return 0.01
    case 'g':
      return STANDARD_GRAVITY_MPS2
    default:
      return undefined
  }
}

/** Convert a single acceleration value to SI units. */
export function accelerationToMps2(
  value: number,
  unit: MotionRecord['accelerationUnit'],
): number {
  if (!Number.isFinite(value)) {
    throw new Error('Acceleration must be finite')
  }

  const scale = unitScaleToMps2(unit)
  if (scale === undefined) {
    throw new Error(`Unsupported acceleration unit: ${String(unit)}`)
  }
  return value * scale
}

/**
 * Validate a uniformly sampled motion and normalize acceleration to m/s^2.
 *
 * The original arrays are never mutated. A record is valid only when it has at
 * least two, but no more than `maxPoints`, finite samples; equal-length time and
 * acceleration arrays; a strictly increasing time axis; and a uniform step.
 */
export function validateMotionRecord(
  record: MotionRecord,
  options: MotionValidationOptions = {},
): MotionValidationResult {
  const maxPoints = options.maxPoints ?? DEFAULT_MAX_MOTION_POINTS
  const relativeTolerance =
    options.relativeTimeStepTolerance ?? DEFAULT_RELATIVE_TIME_STEP_TOLERANCE
  const absoluteTolerance =
    options.absoluteTimeStepToleranceS ?? DEFAULT_ABSOLUTE_TIME_STEP_TOLERANCE_S

  if (!Number.isSafeInteger(maxPoints) || maxPoints < 2) {
    throw new Error('maxPoints must be a safe integer greater than or equal to 2')
  }
  if (!Number.isFinite(relativeTolerance) || relativeTolerance < 0) {
    throw new Error('relativeTimeStepTolerance must be finite and non-negative')
  }
  if (!Number.isFinite(absoluteTolerance) || absoluteTolerance < 0) {
    throw new Error('absoluteTimeStepToleranceS must be finite and non-negative')
  }

  const messages: AnalysisMessage[] = []
  const times = record.timesS
  const accelerations = record.accelerations

  if (!Array.isArray(times)) {
    messages.push(error('MOTION_TIMES_NOT_ARRAY', '時刻列が配列ではありません。', 'timesS'))
  }
  if (!Array.isArray(accelerations)) {
    messages.push(
      error('MOTION_ACCELERATIONS_NOT_ARRAY', '加速度列が配列ではありません。', 'accelerations'),
    )
  }
  if (!Array.isArray(times) || !Array.isArray(accelerations)) {
    return { valid: false, messages }
  }

  if (times.length !== accelerations.length) {
    messages.push(
      error(
        'MOTION_LENGTH_MISMATCH',
        `時刻列（${times.length}点）と加速度列（${accelerations.length}点）の長さが一致しません。`,
      ),
    )
  }
  if (times.length < 2 || accelerations.length < 2) {
    messages.push(error('MOTION_TOO_SHORT', '地震動には2点以上のデータが必要です。'))
  }
  if (times.length > maxPoints || accelerations.length > maxPoints) {
    messages.push(
      error(
        'MOTION_TOO_LARGE',
        `地震動のデータ点数が上限${maxPoints.toLocaleString()}点を超えています。`,
      ),
    )
  }

  const timeNonFiniteIndex = times.findIndex((value) => !Number.isFinite(value))
  if (timeNonFiniteIndex >= 0) {
    messages.push(
      error(
        'MOTION_TIME_NON_FINITE',
        `時刻に有限でない値があります（${timeNonFiniteIndex + 1}行目）。`,
        `timesS[${timeNonFiniteIndex}]`,
      ),
    )
  }
  const accelerationNonFiniteIndex = accelerations.findIndex(
    (value) => !Number.isFinite(value),
  )
  if (accelerationNonFiniteIndex >= 0) {
    messages.push(
      error(
        'MOTION_ACCELERATION_NON_FINITE',
        `加速度に有限でない値があります（${accelerationNonFiniteIndex + 1}行目）。`,
        `accelerations[${accelerationNonFiniteIndex}]`,
      ),
    )
  }

  const unit = record.accelerationUnit as string
  const unitScale = unitScaleToMps2(unit)
  if (unitScale === undefined) {
    messages.push(
      error(
        'MOTION_UNIT_INVALID',
        `加速度単位「${String(unit)}」には対応していません。g、gal、m/s2のいずれかを指定してください。`,
        'accelerationUnit',
      ),
    )
  }

  let representativeTimeStep: number | undefined
  if (
    times.length >= 2 &&
    times.length === accelerations.length &&
    timeNonFiniteIndex < 0
  ) {
    let nonIncreasingIndex = -1
    for (let index = 1; index < times.length; index += 1) {
      const previous = times[index - 1]
      const current = times[index]
      if (previous === undefined || current === undefined || current <= previous) {
        nonIncreasingIndex = index
        break
      }
    }

    if (nonIncreasingIndex >= 0) {
      messages.push(
        error(
          'MOTION_TIME_NOT_STRICTLY_INCREASING',
          `時刻は厳密な昇順である必要があります（${nonIncreasingIndex + 1}行目）。`,
          `timesS[${nonIncreasingIndex}]`,
        ),
      )
    } else {
      const firstTime = times[0]
      const lastTime = times[times.length - 1]
      if (firstTime !== undefined && lastTime !== undefined) {
        representativeTimeStep = (lastTime - firstTime) / (times.length - 1)
        const tolerance = Math.max(
          absoluteTolerance,
          representativeTimeStep * relativeTolerance,
        )

        let nonUniformIndex = -1
        let nonUniformStep = 0
        for (let index = 1; index < times.length; index += 1) {
          const previous = times[index - 1]
          const current = times[index]
          if (previous === undefined || current === undefined) continue
          const step = current - previous
          if (Math.abs(step - representativeTimeStep) > tolerance) {
            nonUniformIndex = index
            nonUniformStep = step
            break
          }
        }

        if (nonUniformIndex >= 0) {
          messages.push(
            error(
              'MOTION_TIME_STEP_NON_UNIFORM',
              `時間刻みが一定ではありません（代表値${representativeTimeStep.toPrecision(8)}秒、${nonUniformIndex + 1}行目${nonUniformStep.toPrecision(8)}秒）。`,
              `timesS[${nonUniformIndex}]`,
            ),
          )
          representativeTimeStep = undefined
        }
      }
    }
  }

  const valid = !messages.some((message) => message.severity === 'error')
  if (
    !valid ||
    representativeTimeStep === undefined ||
    unitScale === undefined ||
    accelerationNonFiniteIndex >= 0
  ) {
    return { valid: false, messages }
  }

  if (unit !== 'm/s2') {
    messages.push({
      code: 'MOTION_UNIT_CONVERTED',
      severity: 'info',
      message: `加速度を${unit}からm/s2へ換算しました。`,
      path: 'accelerationUnit',
    })
  }

  return {
    valid: true,
    normalized: {
      name: record.name,
      sourceAccelerationUnit: record.accelerationUnit,
      timesS: [...times],
      accelerationsMps2: accelerations.map((value) => value * unitScale),
      timeStepS: representativeTimeStep,
    },
    messages,
  }
}

export class MotionValidationError extends Error {
  readonly validationMessages: AnalysisMessage[]

  constructor(messages: AnalysisMessage[]) {
    const details = messages
      .filter((message) => message.severity === 'error')
      .map((message) => message.message)
      .join(' ')
    super(details || 'Invalid motion record')
    this.name = 'MotionValidationError'
    this.validationMessages = messages
  }
}

/** Validate and return the normalized record, or throw one aggregate error. */
export function assertValidMotionRecord(
  record: MotionRecord,
  options: MotionValidationOptions = {},
): { normalized: NormalizedMotionRecord; messages: AnalysisMessage[] } {
  const result = validateMotionRecord(record, options)
  if (!result.valid || result.normalized === undefined) {
    throw new MotionValidationError(result.messages)
  }
  return { normalized: result.normalized, messages: result.messages }
}
