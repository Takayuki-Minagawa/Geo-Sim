import { describe, expect, it } from 'vitest'
import type { GroundModel, GsSettings, ModulusReductionPoint } from '../../src/domain/types'
import { solveGeneralizedSymmetricEigen } from '../../src/core/eigen'
import {
  buildShearColumnMatrices,
  calculateGs,
  calculateLegacyLayerState,
  calculateLegacyPreciseGs,
  calculatePreciseGs,
  calculateSimplifiedGs,
  calculateSimplifiedGsResult,
  calculateSurfaceSpectrumPoint,
  createPeriodGrid,
  evaluateLegacyPreciseGs,
  evaluatePreciseGs,
  interpolateModulusCurve,
  legacySoilParameters,
  standardBaseSpectrumMps2,
} from '../../src/core/gs'
import { estimateVsMps } from '../../src/core/vs'

const FLAT_CURVE: ModulusReductionPoint[] = [
  { strain: 1e-6, modulusRatio: 1, dampingRatio: 0.1 },
]

function groundWithCurves(curve: ModulusReductionPoint[] = FLAT_CURVE): GroundModel {
  return {
    groundwaterDepthM: 2,
    nValues: [],
    layers: [
      {
        id: 'L1',
        topDepthM: 0,
        bottomDepthM: 10,
        soilName: '粘土',
        soilClass: 'clay',
        geologicAge: 'alluvium',
        densityKgM3: 1800,
        vsMps: 200,
        vsSource: 'measured',
        modulusCurve: curve,
      },
      {
        id: 'L2',
        topDepthM: 10,
        bottomDepthM: 20,
        soilName: '細砂',
        soilClass: 'fine-sand',
        geologicAge: 'alluvium',
        densityKgM3: 1800,
        vsMps: 200,
        vsSource: 'measured',
        modulusCurve: curve,
      },
    ],
    engineeringBedrock: {
      depthM: 20,
      densityKgM3: 2000,
      vsMps: 400,
      thicknessM: 5,
      inclinationDeg: 2,
      investigationRadiusM: 100,
    },
  }
}

function settings(mode: GsSettings['mode'], overrides: Partial<GsSettings> = {}): GsSettings {
  return {
    mode,
    groundType: 2,
    groundTypeBasis: '柱状図と造成履歴を設計者が確認',
    regionFactorZ: 1,
    effectiveStrainFactor: 0.65,
    relativeTolerance: 1e-6,
    absoluteTolerance: 1e-9,
    maxIterations: 30,
    ...overrides,
  }
}

describe('simplified Gs exact branches', () => {
  it('implements Type 1 at 0.576 s and 0.64 s', () => {
    expect(calculateSimplifiedGs(0.576 - 1e-10, 1)).toBe(1.5)
    expect(calculateSimplifiedGs(0.576, 1)).toBeCloseTo(1.5, 12)
    expect(calculateSimplifiedGs(0.6, 1)).toBeCloseTo(0.864 / 0.6, 12)
    expect(calculateSimplifiedGs(0.64, 1)).toBe(1.35)
  })

  it('implements Type 2 at 0.64 s and 0.864 s', () => {
    expect(calculateSimplifiedGs(0.64 - 1e-10, 2)).toBe(1.5)
    expect(calculateSimplifiedGs(0.64, 2)).toBeCloseTo(1.5, 12)
    expect(calculateSimplifiedGs(0.8, 2)).toBeCloseTo(1.875, 12)
    expect(calculateSimplifiedGs(0.864, 2)).toBeCloseTo(2.025, 12)
    expect(calculateSimplifiedGs(0.864 + 1e-10, 2)).toBe(2.025)
  })

  it('implements Type 3 at 1.152 s', () => {
    expect(calculateSimplifiedGs(0.64, 3)).toBeCloseTo(1.5, 12)
    expect(calculateSimplifiedGs(1.152, 3)).toBeCloseTo(2.7, 12)
    expect(calculateSimplifiedGs(1.152 + 1e-10, 3)).toBe(2.7)
  })

  it('rejects negative and nonfinite periods', () => {
    expect(() => calculateSimplifiedGs(-1, 2)).toThrow(RangeError)
    expect(() => calculateSimplifiedGs(Number.NaN, 2)).toThrow(RangeError)
    expect(() => calculateSimplifiedGs(1, 4 as never)).toThrow(/groundType/)
  })
})

describe('notification standard spectrum', () => {
  it('is continuous at 0.16 s and 0.64 s', () => {
    expect(standardBaseSpectrumMps2(0.16, 'safety')).toBe(8)
    expect(standardBaseSpectrumMps2(0.64, 'safety')).toBe(8)
    expect(standardBaseSpectrumMps2(0.16 - 1e-10, 'safety')).toBeCloseTo(8, 8)
    expect(standardBaseSpectrumMps2(0.64 - 1e-10, 'safety')).toBe(8)
  })

  it('keeps damage at one fifth of safety', () => {
    for (const period of [0, 0.02, 0.16, 0.4, 0.64, 2]) {
      expect(standardBaseSpectrumMps2(period, 'damage')).toBeCloseTo(
        standardBaseSpectrumMps2(period, 'safety') / 5,
        12,
      )
    }
  })

  it('applies Z and converts Sa to pseudo Sv and Sd', () => {
    const result = calculateSurfaceSpectrumPoint(1, 2, 0.9, 'safety')
    expect(result.baseSaMps2).toBeCloseTo(5.12, 12)
    expect(result.surfaceSaMps2).toBeCloseTo(2 * 0.9 * 5.12, 12)
    expect(result.svMps).toBeCloseTo(result.surfaceSaMps2 / (2 * Math.PI), 12)
    expect(result.sdM).toBeCloseTo(result.surfaceSaMps2 / (2 * Math.PI) ** 2, 12)
  })
})

describe('period grid', () => {
  it('includes the default endpoints with exactly 250 rounded points', () => {
    const periods = createPeriodGrid()
    expect(periods).toHaveLength(250)
    expect(periods[0]).toBe(0.02)
    expect(periods.at(-1)).toBe(5)
    expect(periods[8]).toBe(0.18)
  })

  it('rounds accumulated decimal steps and appends a non-divisible maximum', () => {
    expect(createPeriodGrid(0.1, 0.3, 0.1)).toEqual([0.1, 0.2, 0.3])
    expect(createPeriodGrid(0.02, 0.055, 0.02)).toEqual([0.02, 0.04, 0.055])
  })

  it('rejects invalid and excessively large grids', () => {
    expect(() => createPeriodGrid(0.1, 0, 0.02)).toThrow(RangeError)
    expect(() => createPeriodGrid(0, 100_001, 1)).toThrow(
      /period grid exceeds 100,001 points/,
    )
  })
})

describe('precise curve and matrices', () => {
  it('interpolates nonlinear properties on log strain', () => {
    const curve: ModulusReductionPoint[] = [
      { strain: 1e-6, modulusRatio: 1, dampingRatio: 0.02 },
      { strain: 1e-4, modulusRatio: 0.5, dampingRatio: 0.1 },
    ]
    const interpolated = interpolateModulusCurve(curve, 1e-5)
    expect(interpolated.modulusRatio).toBeCloseTo(0.75, 12)
    expect(interpolated.dampingRatio).toBeCloseTo(0.06, 12)
    expect(interpolated.range).toBe('inside')
    expect(interpolateModulusCurve(curve, 1e-7).range).toBe('below')
    expect(interpolateModulusCurve(curve, 1e-3).range).toBe('above')
  })

  it('hits all four Gs interpolation boundaries and enforces 1.23', () => {
    const parameters = { t1S: 1, t2S: 1 / 3, gs1: 2, gs2: 1.5 }
    expect(evaluatePreciseGs(0, parameters)).toBe(1.23)
    expect(evaluatePreciseGs(0.8 / 3, parameters, 0)).toBeCloseTo(1.5, 12)
    expect(evaluatePreciseGs(0.8, parameters, 0)).toBeCloseTo(2, 12)
    expect(evaluatePreciseGs(1.2, parameters, 0)).toBeCloseTo(2, 12)
    expect(evaluatePreciseGs(10, parameters, 0)).toBeCloseTo(1, 12)
  })

  it('rejects the divergent precise-Gs tail when T1 exceeds 25/3 seconds', () => {
    expect(() =>
      evaluatePreciseGs(15, { t1S: 10, t2S: 10 / 3, gs1: 2, gs2: 1.5 }, 0),
    ).toThrow(RangeError)
  })

  it('builds a symmetric positive-definite shear-column system', () => {
    const matrices = buildShearColumnMatrices([
      { layerId: 'top', thicknessM: 5, densityKgM3: 1800, shearModulusPa: 72e6 },
      { layerId: 'bottom', thicknessM: 5, densityKgM3: 1900, shearModulusPa: 90e6 },
    ])
    expect(matrices.stiffnessNM3[0]![1]).toBe(matrices.stiffnessNM3[1]![0])
    const eigen = solveGeneralizedSymmetricEigen(
      matrices.stiffnessNM3,
      matrices.diagonalMassKgM2,
    )
    expect(eigen.omegaSquared.every((value) => value > 0)).toBe(true)
  })
})

describe('current safety precise iteration', () => {
  it('converges for flat curves, keeps current damping unscaled, and returns a spectrum', () => {
    const result = calculatePreciseGs(groundWithCurves(), settings('safety-precise'), {
      periodsS: [0.02, 0.4, 1],
    })
    expect(result.converged).toBe(true)
    expect(result.t1S).toBeCloseTo((4 * 20) / 200, 12)
    expect(result.t2S).toBeCloseTo(result.t1S! / 3, 12)
    expect(result.dampingRatio).toBeCloseTo(0.1, 12)
    expect(result.alpha).toBeCloseTo(0.45, 12)
    expect(result.gs1).toBeCloseTo(1.6474464579901151, 12)
    expect(result.gs2).toBeCloseTo(1.0857763300760044, 12)
    expect(result.curve).toHaveLength(3)
    expect(result.curve.every((point) => point.gs >= 1.23)).toBe(true)
    expect(result.iterations.length).toBeGreaterThan(0)
    expect(result.applicability.every((check) => check.status === 'pass' || check.status === 'not-assessed')).toBe(true)
  })

  it('returns explicit errors instead of numbers when a curve is missing', () => {
    const ground = groundWithCurves()
    delete ground.layers[0]!.modulusCurve
    const result = calculatePreciseGs(ground, settings('safety-precise'))
    expect(result.converged).toBe(false)
    expect(result.curve).toHaveLength(0)
    expect(result.messages).toContainEqual(
      expect.objectContaining({ code: 'GS_NONLINEAR_CURVE_MISSING', severity: 'error' }),
    )
  })

  it('records nonconvergence at the configured iteration ceiling', () => {
    const nonlinear: ModulusReductionPoint[] = [
      { strain: 1e-8, modulusRatio: 1, dampingRatio: 0.02 },
      { strain: 1e-5, modulusRatio: 0.8, dampingRatio: 0.05 },
      { strain: 1e-3, modulusRatio: 0.2, dampingRatio: 0.2 },
    ]
    const result = calculatePreciseGs(
      groundWithCurves(nonlinear),
      settings('safety-precise', {
        relativeTolerance: 0,
        absoluteTolerance: 0,
        maxIterations: 1,
      }),
      { periodsS: [0.1] },
    )
    expect(result.converged).toBe(false)
    expect(result.iterations).toHaveLength(1)
    expect(result.messages).toContainEqual(
      expect.objectContaining({ code: 'GS_NON_CONVERGENCE', severity: 'error' }),
    )
  })

  it('prevents damage-limit selection for the current precise method', () => {
    const result = calculatePreciseGs(groundWithCurves(), settings('damage-simplified'))
    expect(result.messages[0]).toMatchObject({
      code: 'GS_CURRENT_PRECISE_MODE_INVALID',
      severity: 'error',
    })
  })
})

describe('legacy workbook compatibility policy', () => {
  it('uses fixed cohesive and sandy parameters on the 1e-5 reduction grid', () => {
    expect(legacySoilParameters({ soilClass: 'clay' })).toMatchObject({
      family: 'cohesive',
      a1: 5,
      a2: 2.4,
      a3: 600,
    })
    expect(legacySoilParameters({ soilClass: 'fine-sand' })).toMatchObject({
      family: 'sandy',
      a1: 10,
      a2: 2.6,
      a3: 1100,
    })
    const state = calculateLegacyLayerState(0.001, legacySoilParameters({ soilClass: 'clay' }))
    expect(Math.round(state.modulusRatio * 100000)).toBeCloseTo(state.modulusRatio * 100000, 9)
    expect(state.dampingRatio).toBeGreaterThanOrEqual(0.02)
  })

  it('uses distinct damage and safety lower bounds', () => {
    const parameters = { t1S: 1, t2S: 1 / 3, gs1: 1.1, gs2: 0.8 }
    expect(evaluateLegacyPreciseGs(0.1, parameters, 'damage')).toBe(1.5)
    expect(evaluateLegacyPreciseGs(2, parameters, 'damage')).toBeGreaterThanOrEqual(1.35)
    expect(evaluateLegacyPreciseGs(0.1, parameters, 'safety')).toBe(1.23)
  })

  it('applies 0.8 damping, fixed 1%/20-iteration policy, and compatibility warning', () => {
    const ground = groundWithCurves()
    ground.layers = [ground.layers[0]!]
    ground.engineeringBedrock.depthM = 10
    ground.engineeringBedrock.investigationRadiusM = 50
    ground.layers.forEach((layer) => delete layer.modulusCurve)
    const result = calculateLegacyPreciseGs(
      ground,
      settings('legacy-safety-precise', {
        relativeTolerance: 1e-12,
        maxIterations: 1,
      }),
      { periodsS: [0.02] },
    )
    expect(result.messages).toContainEqual(
      expect.objectContaining({ code: 'GS_LEGACY_COMPATIBILITY_MODE', severity: 'warning' }),
    )
    expect(result.iterations.length).toBeLessThanOrEqual(20)
    const finalLayerDamping = result.iterations.at(-1)!.layers[0]!.dampingRatio
    expect(result.dampingRatio).toBeCloseTo(Math.max(0.05, 0.8 * finalLayerDamping), 12)
    expect(result.applicability[0]).toMatchObject({
      id: 'legacy-compatibility-only',
      status: 'fail',
    })
  })

  it('uses the legacy-sheet Vs coefficient table through the legacy Gs entry point', () => {
    const ground = groundWithCurves()
    ground.layers = [
      {
        ...ground.layers[1]!,
        topDepthM: 0,
        bottomDepthM: 10,
        nValue: 10,
        vsMps: undefined,
        vsSource: undefined,
      },
    ]
    ground.engineeringBedrock.depthM = 10
    ground.engineeringBedrock.investigationRadiusM = 50

    const result = calculateLegacyPreciseGs(
      ground,
      settings('legacy-safety-precise'),
      { periodsS: [0.02] },
    )
    const expectedLegacyPeriod = 40 / estimateVsMps(10, 5, 1, 1.1)
    const regulatoryPeriod = 40 / estimateVsMps(10, 5, 1, 1.086)

    expect(result.elasticPeriodS).toBeCloseTo(expectedLegacyPeriod, 12)
    expect(result.elasticPeriodS).not.toBeCloseTo(regulatoryPeriod, 8)
  })
})

describe('Gs dispatch', () => {
  it('produces a complete simplified result and dispatches by mode', () => {
    const ground = groundWithCurves()
    const direct = calculateSimplifiedGsResult(ground, settings('damage-simplified'), [0.02])
    const dispatched = calculateGs(ground, settings('damage-simplified'), { periodsS: [0.02] })
    expect(direct.converged).toBe(true)
    expect(dispatched).toEqual(direct)
    expect(dispatched.curve[0]).toMatchObject({ periodS: 0.02, gs: 1.5 })
    expect(dispatched.curve[0]!.baseSaMps2).toBeCloseTo(0.76, 12)
  })

  it('dispatches safety-simplified with the safety-limit base spectrum', () => {
    const dispatched = calculateGs(groundWithCurves(), settings('safety-simplified'), {
      periodsS: [0.02],
    })
    expect(dispatched.converged).toBe(true)
    expect(dispatched.curve[0]).toMatchObject({ periodS: 0.02, gs: 1.5 })
    expect(dispatched.curve[0]!.baseSaMps2).toBeCloseTo(3.8, 12)
    expect(dispatched.curve[0]!.surfaceSaMps2).toBeCloseTo(5.7, 12)
  })

  it('returns a structured error for an unknown runtime mode', () => {
    const invalidSettings = {
      ...settings('damage-simplified'),
      mode: 'future-mode',
    } as unknown as GsSettings

    const result = calculateGs(groundWithCurves(), invalidSettings, { periodsS: [0.02] })

    expect(result).toMatchObject({
      mode: 'future-mode',
      converged: false,
      curve: [],
      iterations: [],
    })
    expect(result.messages).toContainEqual(
      expect.objectContaining({ code: 'GS_MODE_UNKNOWN', severity: 'error' }),
    )
  })
})
