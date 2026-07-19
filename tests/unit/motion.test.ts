import { describe, expect, it } from 'vitest'

import type { MotionRecord } from '../../src/domain/types'
import {
  MotionValidationError,
  STANDARD_GRAVITY_MPS2,
  analyzeMotion,
  computeElasticResponseSpectrum,
  correctBaseline,
  integrateAcceleration,
  validateMotionRecord,
} from '../../src/core/motion'

function uniformTimes(durationS: number, intervals: number): number[] {
  return Array.from({ length: intervals + 1 }, (_, index) => (durationS * index) / intervals)
}

describe('motion validation and SI normalization', () => {
  it('converts g and gal to m/s2 without mutating the source', () => {
    const gRecord: MotionRecord = {
      name: 'g record',
      accelerationUnit: 'g',
      timesS: [0, 0.01, 0.02],
      accelerations: [0, 1, -1],
    }
    const gResult = validateMotionRecord(gRecord)
    expect(gResult.valid).toBe(true)
    expect(gResult.normalized?.accelerationsMps2).toEqual([
      0,
      STANDARD_GRAVITY_MPS2,
      -STANDARD_GRAVITY_MPS2,
    ])
    expect(gRecord.accelerations).toEqual([0, 1, -1])

    const galResult = validateMotionRecord({
      ...gRecord,
      accelerationUnit: 'gal',
      accelerations: [0, 100, -100],
    })
    expect(galResult.normalized?.accelerationsMps2).toEqual([0, 1, -1])
  })

  it.each([
    {
      label: 'non-monotonic time',
      timesS: [0, 0.01, 0.01],
      accelerations: [0, 1, 0],
      code: 'MOTION_TIME_NOT_STRICTLY_INCREASING',
      options: {},
    },
    {
      label: 'non-uniform time',
      timesS: [0, 0.01, 0.021],
      accelerations: [0, 1, 0],
      code: 'MOTION_TIME_STEP_NON_UNIFORM',
      options: {},
    },
    {
      label: 'non-finite value',
      timesS: [0, 0.01, 0.02],
      accelerations: [0, Number.NaN, 0],
      code: 'MOTION_ACCELERATION_NON_FINITE',
      options: {},
    },
    {
      label: 'oversize record',
      timesS: [0, 0.01, 0.02],
      accelerations: [0, 1, 0],
      code: 'MOTION_TOO_LARGE',
      options: { maxPoints: 2 },
    },
  ])('rejects $label', ({ timesS, accelerations, code, options }) => {
    const result = validateMotionRecord(
      { name: 'invalid', accelerationUnit: 'm/s2', timesS, accelerations },
      options,
    )
    expect(result.valid).toBe(false)
    expect(result.messages.map((message) => message.code)).toContain(code)
  })

  it('throws one aggregate validation error from end-to-end analysis', () => {
    expect(() =>
      analyzeMotion({
        name: 'bad',
        accelerationUnit: 'm/s2',
        timesS: [0, 1, 0.5],
        accelerations: [0, 0, 0],
      }),
    ).toThrow(MotionValidationError)
  })
})

describe('baseline correction and trapezoidal integration', () => {
  it('integrates constant acceleration exactly when correction is disabled', () => {
    const times = uniformTimes(1, 4)
    const integrated = integrateAcceleration(times, times.map(() => 2), {
      baselineCorrection: 'none',
    })
    expect(integrated.velocityMps.at(-1)).toBeCloseTo(2, 12)
    expect(integrated.displacementM.at(-1)).toBeCloseTo(1, 12)
  })

  it('removes the time-weighted mean and gives zero final velocity', () => {
    const times = uniformTimes(1, 10)
    const integrated = integrateAcceleration(times, times.map(() => 2), {
      baselineCorrection: 'mean',
    })
    expect(integrated.correctedAccelerationMps2.every((value) => value === 0)).toBe(true)
    expect(integrated.velocityMps.at(-1)).toBeCloseTo(0, 14)
    expect(integrated.displacementM.at(-1)).toBeCloseTo(0, 14)
  })

  it('removes an affine acceleration trend', () => {
    const times = uniformTimes(2, 20)
    const values = times.map((time) => 0.3 + 0.04 * time)
    const corrected = correctBaseline(times, values, 'linear')
    expect(Math.max(...corrected.correctedValues.map(Math.abs))).toBeLessThan(1e-14)
    expect(corrected.removedIntercept).toBeCloseTo(0.3, 12)
    expect(corrected.removedSlopePerSecond).toBeCloseTo(0.04, 12)
  })
})

describe('motion intensity measures', () => {
  it('matches a one-cycle sine pulse for PGA, PGV and PGD', () => {
    const amplitude = 1.2
    const duration = 1
    const circularFrequency = 2 * Math.PI
    const times = uniformTimes(duration, 2_000)
    const record: MotionRecord = {
      name: 'one-cycle sine',
      accelerationUnit: 'm/s2',
      timesS: times,
      accelerations: times.map((time) => amplitude * Math.sin(circularFrequency * time)),
    }
    const result = analyzeMotion(record, {
      integration: { baselineCorrection: 'none' },
      periodsS: [0, 0.5, 1, 2],
    })
    expect(result.pgaMps2).toBeCloseTo(amplitude, 8)
    expect(result.pgvMps).toBeCloseTo((2 * amplitude) / circularFrequency, 5)
    expect(result.pgdM).toBeCloseTo((amplitude * duration) / circularFrequency, 5)
  })
})

describe('Newmark elastic response spectrum', () => {
  it('returns exact zeros for a zero motion and PGA at period zero', () => {
    const times = uniformTimes(2, 200)
    const spectrum = computeElasticResponseSpectrum(
      times,
      times.map(() => 0),
      [0, 0.1, 1, 5],
    )
    expect(spectrum).toEqual([
      { periodS: 0, sdM: 0, svMps: 0, saMps2: 0 },
      { periodS: 0.1, sdM: 0, svMps: 0, saMps2: 0 },
      { periodS: 1, sdM: 0, svMps: 0, saMps2: 0 },
      { periodS: 5, sdM: 0, svMps: 0, saMps2: 0 },
    ])
  })

  it('matches the analytical damped step response at its first displacement peak', () => {
    const period = 1
    const dampingRatio = 0.05
    const amplitude = 1
    const circularFrequency = 2 * Math.PI
    const dampedFrequency = circularFrequency * Math.sqrt(1 - dampingRatio ** 2)
    const firstDisplacementPeakTime = Math.PI / dampedFrequency
    const times = uniformTimes(firstDisplacementPeakTime, 2_000)
    const acceleration = times.map(() => amplitude)
    const point = computeElasticResponseSpectrum(times, acceleration, [period], {
      dampingRatio,
      maxStepToPeriodRatio: 1,
    })[0]
    if (point === undefined) throw new Error('Spectrum point was not calculated')

    const decayAtPeak = Math.exp(
      -dampingRatio * circularFrequency * firstDisplacementPeakTime,
    )
    const expectedDisplacement =
      (amplitude / circularFrequency ** 2) * (1 + decayAtPeak)
    const velocityPeakTime =
      Math.atan(dampedFrequency / (dampingRatio * circularFrequency)) / dampedFrequency
    const expectedVelocity =
      (amplitude / dampedFrequency) *
      Math.exp(-dampingRatio * circularFrequency * velocityPeakTime) *
      Math.sin(dampedFrequency * velocityPeakTime)
    const analyticalAbsoluteAccelerations = times.map((time) =>
      amplitude *
      (1 -
        Math.exp(-dampingRatio * circularFrequency * time) * Math.cos(dampedFrequency * time) +
        (dampingRatio * circularFrequency *
          Math.exp(-dampingRatio * circularFrequency * time) *
          Math.sin(dampedFrequency * time)) /
          dampedFrequency),
    )
    const expectedAbsoluteAcceleration = Math.max(...analyticalAbsoluteAccelerations)

    expect(point.sdM).toBeCloseTo(expectedDisplacement, 6)
    expect(point.svMps).toBeCloseTo(expectedVelocity, 6)
    expect(point.saMps2).toBeCloseTo(expectedAbsoluteAcceleration, 5)
  })
})
