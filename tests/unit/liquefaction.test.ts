import { describe, expect, it } from 'vitest'
import type {
  GroundLayer,
  GroundModel,
  LiquefactionCaseSettings,
} from '../../src/domain/types'
import {
  calculateLiquefactionCase,
  calculateLiquefactionCases,
  calculateOverburdenAtDepth,
  classifyDcy,
  classifyPl,
  correctedNValue,
  ganmacy,
  liquefactionDemandRatio,
  liquefactionResistanceRatio,
  nf,
  normalizeLiquefactionSegments,
  plDepthWeight,
} from '../../src/core/liquefaction'
import { normalizeGroundModel } from '../../src/core/normalization/splitLayers'

const DAMAGE_CASE: LiquefactionCaseSettings = {
  id: 'damage-150gal',
  peakAccelerationGal: 150,
  magnitude: 7,
}

const SAFETY_CASE: LiquefactionCaseSettings = {
  id: 'safety-350gal',
  peakAccelerationGal: 350,
  magnitude: 7.5,
}

describe('nf', () => {
  it.each([
    [0, 0],
    [4.999, 0],
    [5, 0],
    [7.5, 3],
    [9.999, 5.9988],
    [10, 6],
    [15, 7],
    [19.999, 7.9998],
    [20, 8],
    [35, 9.5],
    [100, 16],
  ])('FC=%d%% gives ΔNf=%d', (finesPercent, expected) => {
    expect(nf(finesPercent)).toBeCloseTo(expected, 10)
  })

  it('rejects nonphysical percentages', () => {
    expect(() => nf(-0.01)).toThrow(RangeError)
    expect(() => nf(100.01)).toThrow(RangeError)
    expect(() => nf(Number.NaN)).toThrow(RangeError)
  })
})

describe('ganmacy', () => {
  const bands = [
    { demand: 0.075, thresholds: [3.5, 5, 6, 7, 7.5, 7.6] },
    { demand: 0.125, thresholds: [5, 7.2, 8, 10, 12, 13] },
    { demand: 0.175, thresholds: [5, 8, 10, 12, 16, 17.5] },
    { demand: 0.225, thresholds: [5, 8, 10.5, 13.5, 17.5, 21] },
    { demand: 0.275, thresholds: [5, 8, 10.5, 14.5, 18.5, 22.5] },
    { demand: 0.325, thresholds: [5, 8, 10.5, 15, 20, 23.5] },
    { demand: 0.375, thresholds: [5, 8, 10.5, 15, 20.5, 24.5] },
    { demand: 0.425, thresholds: [5, 8, 10.5, 15, 21, 25] },
    { demand: 0.45, thresholds: [5, 8, 10.5, 15, 21, 25.5] },
  ] as const
  const strains = [8, 4, 3, 2, 1, 0.5] as const

  it('returns zero below the first demand boundary', () => {
    expect(ganmacy(0, 0)).toBe(0)
    expect(ganmacy(0, 0.049999)).toBe(0)
    expect(ganmacy(0, 0.05)).toBe(8)
  })

  it.each(bands)('reproduces every Na step for demand=$demand', ({ demand, thresholds }) => {
    thresholds.forEach((threshold, index) => {
      expect(ganmacy(threshold - 1e-6, demand)).toBe(strains[index])
      expect(ganmacy(threshold, demand)).toBe(strains[index + 1] ?? 0)
    })
  })

  it('uses the next demand band at an exact boundary', () => {
    expect(ganmacy(4, 0.099999)).toBe(4)
    expect(ganmacy(4, 0.1)).toBe(8)
    expect(ganmacy(25.25, 0.449999)).toBe(0)
    expect(ganmacy(25.25, 0.45)).toBe(0.5)
  })

  it('rejects negative or nonfinite inputs', () => {
    expect(() => ganmacy(-1, 0.1)).toThrow(RangeError)
    expect(() => ganmacy(1, -0.1)).toThrow(RangeError)
    expect(() => ganmacy(1, Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })
})

describe('overburden stress', () => {
  it('splits a layer crossing groundwater and returns tf/m2 and kPa', () => {
    const layers = [
      layer({ id: 'L1', topDepthM: 0, bottomDepthM: 2, densityKgM3: 1800 }),
      layer({ id: 'L2', topDepthM: 2, bottomDepthM: 4, densityKgM3: 2000 }),
    ]

    const stress = calculateOverburdenAtDepth(layers, 1, 3)

    expect(stress.totalStressTfM2).toBeCloseTo(5.6, 12)
    expect(stress.effectiveStressTfM2).toBeCloseTo(3.6, 12)
    expect(stress.porePressureTfM2).toBeCloseTo(2, 12)
    expect(stress.totalStressKPa).toBeCloseTo(54.91724, 8)
    expect(stress.effectiveStressKPa).toBeCloseTo(35.30394, 8)
  })

  it('requires continuous nonoverlapping coverage to the requested depth', () => {
    const gap = [
      layer({ id: 'L1', topDepthM: 0, bottomDepthM: 1 }),
      layer({ id: 'L2', topDepthM: 2, bottomDepthM: 3 }),
    ]
    const overlap = [
      layer({ id: 'L1', topDepthM: 0, bottomDepthM: 2 }),
      layer({ id: 'L2', topDepthM: 1.5, bottomDepthM: 3 }),
    ]

    expect(() => calculateOverburdenAtDepth(gap, 0, 2.5)).toThrow('未定義区間')
    expect(() => calculateOverburdenAtDepth(overlap, 0, 2.5)).toThrow('重複')
  })
})

describe('FL equations', () => {
  it('calculates demand, corrected N, resistance and FL for both standard cases', () => {
    const totalStress = 3.6
    const effectiveStress = 1.6
    const depth = 2
    const correctedN = correctedNValue(2, effectiveStress, 10)
    const resistance = liquefactionResistanceRatio(correctedN)
    const damageDemand = liquefactionDemandRatio(
      DAMAGE_CASE,
      depth,
      totalStress,
      effectiveStress,
    )
    const safetyDemand = liquefactionDemandRatio(
      SAFETY_CASE,
      depth,
      totalStress,
      effectiveStress,
    )

    expect(correctedN).toBeCloseTo(11, 12)
    expect(resistance).toBeCloseTo(0.13861764705882354, 12)
    expect(damageDemand).toBeCloseTo(0.20043367346938779, 12)
    expect(safetyDemand).toBeCloseTo(0.5066517857142857, 12)
    expect(resistance / damageDemand).toBeCloseTo(0.6915886171192417, 12)
    expect(resistance / safetyDemand).toBeCloseTo(0.2735954968823374, 12)
  })
})

describe('liquefaction layer eligibility and normalized rows', () => {
  it('splits at groundwater, improvement depth and the PL 20 m boundary', () => {
    const ground = model(
      [layer({ id: 'L1', topDepthM: 0, bottomDepthM: 21, nValue: 2 })],
      { groundwaterDepthM: 0.7, improvementDepthM: 2 },
    )

    expect(normalizeLiquefactionSegments(ground)).toEqual([
      { layerId: 'L1@0-0.7m', sourceLayerId: 'L1', topDepthM: 0, bottomDepthM: 0.7 },
      { layerId: 'L1@0.7-2m', sourceLayerId: 'L1', topDepthM: 0.7, bottomDepthM: 2 },
      { layerId: 'L1@2-20m', sourceLayerId: 'L1', topDepthM: 2, bottomDepthM: 20 },
      { layerId: 'L1@20-21m', sourceLayerId: 'L1', topDepthM: 20, bottomDepthM: 21 },
    ])
  })

  it('does not create a zero-thickness row when split boundaries coincide', () => {
    const ground = model(
      [layer({ id: 'L1', topDepthM: 0, bottomDepthM: 10, nValue: 2 })],
      { groundwaterDepthM: 5, improvementDepthM: 5 },
    )

    expect(normalizeLiquefactionSegments(ground)).toEqual([
      { layerId: 'L1@0-5m', sourceLayerId: 'L1', topDepthM: 0, bottomDepthM: 5 },
      { layerId: 'L1@5-10m', sourceLayerId: 'L1', topDepthM: 5, bottomDepthM: 10 },
    ])
  })

  it('applies every eligibility condition and returns per-layer reason messages', () => {
    const ground = model([
      layer({ id: 'eligible', topDepthM: 0, bottomDepthM: 1, nValue: 2 }),
      layer({
        id: 'gravel',
        topDepthM: 1,
        bottomDepthM: 2,
        soilClass: 'gravel',
        soilName: '礫',
        nValue: 2,
      }),
      layer({ id: 'fines', topDepthM: 2, bottomDepthM: 3, finesPercent: 35.01, nValue: 2 }),
      layer({ id: 'n-high', topDepthM: 3, bottomDepthM: 4, nValue: 15.01 }),
      layer({ id: 'improved', topDepthM: 4, bottomDepthM: 5, nValue: 2, improved: true }),
    ])

    const result = calculateLiquefactionCase(ground, DAMAGE_CASE)

    expect(result.layers.map(({ layerId, eligible }) => [layerId, eligible])).toEqual([
      ['eligible', true],
      ['gravel', false],
      ['fines', false],
      ['n-high', false],
      ['improved', false],
    ])
    expect(result.messages.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'LIQUEFACTION_LAYER_ELIGIBLE',
        'LIQUEFACTION_EXCLUDED_SOIL',
        'LIQUEFACTION_FINES_OVER_LIMIT',
        'LIQUEFACTION_N_VALUE_OVER_LIMIT',
        'LIQUEFACTION_IMPROVED_LAYER',
      ]),
    )
    expect(result.layers[1]?.reason).toContain('対象外土質')
    expect(result.layers[2]?.reason).toContain('35%')
    expect(result.layers[3]?.reason).toContain('15')
    expect(result.layers[4]?.reason).toContain('地盤改良層')
  })

  it('excludes only the portion within the improvement depth after splitting', () => {
    const ground = model(
      [layer({ id: 'L1', topDepthM: 0, bottomDepthM: 2, nValue: 2 })],
      { improvementDepthM: 1 },
    )

    const result = calculateLiquefactionCase(ground, DAMAGE_CASE)

    expect(result.layers).toHaveLength(2)
    expect(result.layers[0]).toMatchObject({
      layerId: 'L1@0-1m',
      eligible: false,
      dcyContributionCm: 0,
      plContribution: 0,
    })
    expect(result.layers[0]?.reason).toContain('GL-1m')
    expect(result.layers[1]).toMatchObject({ layerId: 'L1@1-2m', eligible: true })
  })

  it('keeps an explicitly improved layer excluded after ground normalization', () => {
    const ground = model([
      layer({ id: 'L1', topDepthM: 0, bottomDepthM: 2, nValue: 2, improved: true }),
    ])

    const result = calculateLiquefactionCase(normalizeGroundModel(ground).ground, DAMAGE_CASE)

    expect(result.dcyCm).toBe(0)
    expect(result.layers).toHaveLength(1)
    expect(result.layers[0]).toMatchObject({ eligible: false, dcyContributionCm: 0 })
    expect(result.messages.map(({ code }) => code)).toContain('LIQUEFACTION_IMPROVED_LAYER')
  })

  it('uses direct layer N first, then the legacy upper-inclusive interval average', () => {
    const ground = model([layer({ id: 'L1', topDepthM: 0, bottomDepthM: 2, nValue: undefined })])
    ground.nValues = [
      { depthM: 0, n: 99 },
      { depthM: 1, n: 2 },
      { depthM: 2, n: 4 },
      { depthM: 2.1, n: 99 },
    ]

    const result = calculateLiquefactionCase(ground, DAMAGE_CASE)
    expect(result.layers[0]?.n).toBe(3)

    ground.layers[0]!.nValue = 5
    expect(calculateLiquefactionCase(ground, DAMAGE_CASE).layers[0]?.n).toBe(5)
  })

  it('uses the same original-layer N average through normalization and refreshes it after CSV replacement', () => {
    const ground = model(
      [layer({ id: 'L1', topDepthM: 0, bottomDepthM: 4, nValue: undefined })],
      { groundwaterDepthM: 2 },
    )
    ground.nValues = [
      { depthM: 1, n: 2 },
      { depthM: 3, n: 10 },
    ]

    const direct = calculateLiquefactionCase(ground, DAMAGE_CASE)
    const normalized = normalizeGroundModel(ground)
    const afterNormalization = calculateLiquefactionCase(normalized.clippedGround, DAMAGE_CASE)

    expect(direct.layers.map(({ n }) => n)).toEqual([6, 6])
    expect(afterNormalization.layers.map(({ n }) => n)).toEqual([6, 6])
    expect(afterNormalization.dcyCm).toBeCloseTo(direct.dcyCm, 12)
    expect(afterNormalization.pl).toBeCloseTo(direct.pl, 12)

    normalized.clippedGround.nValues = [
      { depthM: 1, n: 20 },
      { depthM: 3, n: 30 },
    ]
    const afterReplacement = calculateLiquefactionCase(normalized.clippedGround, DAMAGE_CASE)
    expect(afterReplacement.layers.map(({ n }) => n)).toEqual([25, 25])
  })

  it('excludes every layer when groundwater is below the complete layer model', () => {
    const ground = model([layer({ id: 'L1', topDepthM: 0, bottomDepthM: 2, nValue: 2 })], {
      groundwaterDepthM: 3,
    })

    const result = calculateLiquefactionCase(ground, DAMAGE_CASE)

    expect(result.dcyCm).toBe(0)
    expect(result.pl).toBe(0)
    expect(result.layers.every(({ eligible }) => !eligible)).toBe(true)
    expect(result.messages.map(({ code }) => code)).toContain('LIQUEFACTION_ABOVE_GROUNDWATER')
  })

  it('returns LIQUEFACTION_INVALID_LAYER_MODEL for a discontinuous layer model', () => {
    const ground = model([
      layer({ id: 'L1', topDepthM: 0, bottomDepthM: 1 }),
      layer({ id: 'L2', topDepthM: 2, bottomDepthM: 3 }),
    ])

    const result = calculateLiquefactionCase(ground, DAMAGE_CASE)

    expect(result.layers).toEqual([])
    expect(result.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'LIQUEFACTION_INVALID_LAYER_MODEL', severity: 'error' }),
      ]),
    )
  })

  it('sets strain and PL contribution to zero for an eligible FL >= 1 layer', () => {
    const ground = model([layer({ id: 'L1', topDepthM: 0, bottomDepthM: 1, nValue: 15 })])

    const result = calculateLiquefactionCase(ground, DAMAGE_CASE)

    expect(result.layers[0]).toMatchObject({
      eligible: true,
      cyclicStrainPercent: 0,
      dcyContributionCm: 0,
      plContribution: 0,
    })
    expect(result.layers[0]?.fl).toBeGreaterThanOrEqual(1)
  })
})

describe('Dcy and PL aggregation', () => {
  it('calculates both 150 gal/M7 and 350 gal/M7.5 with layer contributions', () => {
    const ground = model([
      layer({ id: 'L1', topDepthM: 0, bottomDepthM: 1, nValue: 2 }),
      layer({ id: 'L2', topDepthM: 1, bottomDepthM: 2, nValue: 2 }),
    ])

    const [damage, safety] = calculateLiquefactionCases(ground)

    expect(damage).toMatchObject({
      caseId: 'damage-150gal',
      peakAccelerationGal: 150,
      magnitude: 7,
      dcyCm: 4,
      dcyClass: '軽微',
    })
    expect(safety).toMatchObject({
      caseId: 'safety-350gal',
      peakAccelerationGal: 350,
      magnitude: 7.5,
      dcyCm: 4,
      dcyClass: '軽微',
    })
    expect(damage?.layers[1]?.fl).toBeCloseTo(0.6915886171192417, 12)
    expect(safety?.layers[1]?.fl).toBeCloseTo(0.2735954968823374, 12)
    expect(damage?.layers.every(({ dcyContributionCm }) => dcyContributionCm === 2)).toBe(
      true,
    )
    expect(damage?.pl).toBeGreaterThan(0)
    expect(safety?.pl).toBeGreaterThan(damage?.pl ?? 0)
  })

  it('clips PL at 20 m while Dcy keeps the same normalized segment model', () => {
    const ground = model([
      layer({
        id: 'overburden',
        topDepthM: 0,
        bottomDepthM: 19,
        soilClass: 'gravel',
        soilName: '礫',
        nValue: 0,
        finesPercent: 0,
      }),
      layer({
        id: 'target',
        topDepthM: 19,
        bottomDepthM: 21,
        nValue: 0,
        finesPercent: 0,
      }),
    ])

    const result = calculateLiquefactionCase(ground, SAFETY_CASE)
    const atLimit = result.layers.find(({ layerId }) => layerId === 'target@19-20m')
    const belowLimit = result.layers.find(({ layerId }) => layerId === 'target@20-21m')

    expect(atLimit?.fl).toBeCloseTo(0.12307786195036809, 12)
    expect(atLimit?.plContribution).toBeCloseTo((1 - 0.12307786195036809) * 0.25, 12)
    expect(belowLimit).toMatchObject({ eligible: true, plContribution: 0 })
    expect(belowLimit?.dcyContributionCm).toBeGreaterThan(0)
    expect(result.pl).toBeCloseTo(atLimit?.plContribution ?? -1, 12)
  })

  it.each([
    [0, 'なし'],
    [5, '軽微'],
    [5.000001, '小'],
    [10, '小'],
    [10.000001, '中'],
    [20, '中'],
    [20.000001, '大'],
    [40, '大'],
    [40.000001, '甚大'],
  ])('classifies Dcy=%d cm as %s', (value, expected) => {
    expect(classifyDcy(value)).toBe(expected)
  })

  it.each([
    [0, '被害発生の可能性なし'],
    [5, '可能性が低い'],
    [5.000001, '可能性がある'],
    [15, '可能性がある'],
    [15.000001, '可能性が高い'],
  ])('classifies PL=%d as %s', (value, expected) => {
    expect(classifyPl(value)).toBe(expected)
  })

  it('uses W(z)=10-0.5z with an exact zero at 20 m', () => {
    expect(plDepthWeight(0)).toBe(10)
    expect(plDepthWeight(10)).toBe(5)
    expect(plDepthWeight(19.5)).toBe(0.25)
    expect(plDepthWeight(20)).toBe(0)
    expect(plDepthWeight(25)).toBe(0)
  })
})

function layer(
  overrides: Partial<GroundLayer> & Pick<GroundLayer, 'id' | 'topDepthM' | 'bottomDepthM'>,
): GroundLayer {
  const { id, topDepthM, bottomDepthM, ...optionalOverrides } = overrides
  return {
    id,
    topDepthM,
    bottomDepthM,
    soilName: '砂',
    soilClass: 'sand',
    geologicAge: 'alluvium',
    densityKgM3: 1800,
    finesPercent: 10,
    nValue: 2,
    ...optionalOverrides,
  }
}

function model(
  layers: GroundLayer[],
  overrides: Partial<Pick<GroundModel, 'groundwaterDepthM' | 'improvementDepthM'>> = {},
): GroundModel {
  const deepest = Math.max(0, ...layers.map(({ bottomDepthM }) => bottomDepthM))
  return {
    groundwaterDepthM: 0,
    nValues: [],
    layers,
    engineeringBedrock: {
      depthM: deepest,
      densityKgM3: 2000,
      vsMps: 400,
    },
    ...overrides,
  }
}
