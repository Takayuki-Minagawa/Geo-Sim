import type { GsCurvePoint } from '../../domain/types'

export type SpectrumLimit = 'damage' | 'safety'

/** Standard acceleration response spectrum on exposed engineering bedrock (SI). */
export function standardBaseSpectrumMps2(periodS: number, limit: SpectrumLimit): number {
  if (!Number.isFinite(periodS) || periodS < 0) {
    throw new RangeError('periodS must be a finite value greater than or equal to zero')
  }
  if (limit !== 'damage' && limit !== 'safety') {
    throw new RangeError('limit must be damage or safety')
  }
  let safetyMps2: number
  if (periodS < 0.16) safetyMps2 = 3.2 + 30 * periodS
  else if (periodS < 0.64) safetyMps2 = 8
  else safetyMps2 = 5.12 / periodS
  return limit === 'damage' ? safetyMps2 / 5 : safetyMps2
}

export function calculateSurfaceSpectrumPoint(
  periodS: number,
  gs: number,
  regionFactorZ: number,
  limit: SpectrumLimit,
): GsCurvePoint {
  if (!Number.isFinite(gs) || gs < 0) throw new RangeError('gs must be finite and non-negative')
  if (!Number.isFinite(regionFactorZ) || regionFactorZ <= 0) {
    throw new RangeError('regionFactorZ must be a positive finite value')
  }
  const baseSaMps2 = standardBaseSpectrumMps2(periodS, limit)
  const surfaceSaMps2 = gs * regionFactorZ * baseSaMps2
  const frequencyFactor = periodS / (2 * Math.PI)
  return {
    periodS,
    gs,
    baseSaMps2,
    surfaceSaMps2,
    svMps: frequencyFactor * surfaceSaMps2,
    sdM: frequencyFactor ** 2 * surfaceSaMps2,
  }
}

export function createPeriodGrid(
  minimumS = 0.02,
  maximumS = 5,
  stepS = 0.02,
): number[] {
  if (
    !Number.isFinite(minimumS) ||
    !Number.isFinite(maximumS) ||
    !Number.isFinite(stepS) ||
    minimumS < 0 ||
    maximumS < minimumS ||
    stepS <= 0
  ) {
    throw new RangeError('invalid period grid')
  }
  const count = Math.floor((maximumS - minimumS) / stepS + 1e-12)
  if (count > 100_000) throw new RangeError('period grid exceeds 100,001 points')
  const periods = Array.from({ length: count + 1 }, (_unused, index) =>
    Number((minimumS + index * stepS).toPrecision(15)),
  )
  if (periods[periods.length - 1]! < maximumS - stepS * 1e-10) periods.push(maximumS)
  return periods
}

export function buildSurfaceSpectrum(
  periodsS: readonly number[],
  gsAtPeriod: (periodS: number) => number,
  regionFactorZ: number,
  limit: SpectrumLimit,
): GsCurvePoint[] {
  return periodsS.map((periodS) =>
    calculateSurfaceSpectrumPoint(periodS, gsAtPeriod(periodS), regionFactorZ, limit),
  )
}
