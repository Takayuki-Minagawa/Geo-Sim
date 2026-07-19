import type { AnalysisMessage, MotionRecord, MotionResult } from '../../domain/types'
import {
  integrateAcceleration,
  peakAbsolute,
  type AccelerationIntegrationOptions,
} from './integration'
import {
  computeElasticResponseSpectrum,
  createLogSpacedPeriods,
  DEFAULT_RESPONSE_SPECTRUM_DAMPING_RATIO,
  type PeriodGridOptions,
  type ResponseSpectrumOptions,
} from './responseSpectrum'
import {
  assertValidMotionRecord,
  type MotionValidationOptions,
} from './validation'

export interface MotionAnalysisOptions {
  validation?: MotionValidationOptions
  integration?: AccelerationIntegrationOptions
  periodsS?: readonly number[]
  periodGrid?: PeriodGridOptions
  spectrum?: ResponseSpectrumOptions
}

/**
 * End-to-end browser-safe motion analysis.
 *
 * PGA, PGV and PGD are calculated after the explicitly selected baseline
 * correction (time-weighted mean by default). The same corrected acceleration
 * drives the response-spectrum oscillators.
 */
export function analyzeMotion(
  record: MotionRecord,
  options: MotionAnalysisOptions = {},
): MotionResult {
  const { normalized, messages: validationMessages } = assertValidMotionRecord(
    record,
    options.validation,
  )
  const integrated = integrateAcceleration(
    normalized.timesS,
    normalized.accelerationsMps2,
    options.integration,
  )
  const periods = options.periodsS
    ? [...options.periodsS]
    : createLogSpacedPeriods(options.periodGrid)
  const dampingRatio =
    options.spectrum?.dampingRatio ?? DEFAULT_RESPONSE_SPECTRUM_DAMPING_RATIO
  const spectrum = computeElasticResponseSpectrum(
    normalized.timesS,
    integrated.correctedAccelerationMps2,
    periods,
    { ...options.spectrum, dampingRatio },
  )

  const messages: AnalysisMessage[] = [...validationMessages]
  if (integrated.baseline.method !== 'none') {
    messages.push({
      code: 'MOTION_BASELINE_CORRECTED',
      severity: 'info',
      message:
        integrated.baseline.method === 'mean'
          ? `時間重み付き平均${integrated.baseline.removedIntercept.toExponential(5)} m/s2を加速度から除去しました。`
          : `加速度の一次トレンド（切片${integrated.baseline.removedIntercept.toExponential(5)} m/s2、傾き${integrated.baseline.removedSlopePerSecond.toExponential(5)} m/s3）を除去しました。`,
    })
  }

  const shortestPositivePeriod = periods
    .filter((period) => period > 0)
    .reduce<number | undefined>(
      (shortest, period) => (shortest === undefined ? period : Math.min(shortest, period)),
      undefined,
    )
  if (
    shortestPositivePeriod !== undefined &&
    normalized.timeStepS > shortestPositivePeriod / 10
  ) {
    messages.push({
      code: 'MOTION_SPECTRUM_TIME_STEP_COARSE',
      severity: 'warning',
      message: `入力時間刻み${normalized.timeStepS.toPrecision(6)}秒は最短周期${shortestPositivePeriod.toPrecision(6)}秒の1/10を超えます。内部補間は行いますが、元波形の高周波情報は復元できません。`,
    })
  }

  return {
    pgaMps2: peakAbsolute(integrated.correctedAccelerationMps2),
    pgvMps: peakAbsolute(integrated.velocityMps),
    pgdM: peakAbsolute(integrated.displacementM),
    timeStepS: normalized.timeStepS,
    spectrum,
    messages,
  }
}
