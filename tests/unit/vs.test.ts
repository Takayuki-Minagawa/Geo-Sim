import { describe, expect, it } from 'vitest'
import type { GroundLayer, NValue } from '../../src/domain/types'
import {
  GEOLOGIC_AGE_COEFFICIENTS,
  LEGACY_SHEET_SOIL_COEFFICIENTS,
  REGULATORY_SOIL_COEFFICIENTS,
  averageNForInterval,
  calculateElasticGroundPeriod,
  estimateVsMps,
  resolveLayerVs,
} from '../../src/core/vs'

const BASE_LAYER: GroundLayer = {
  id: 'L1',
  topDepthM: 0,
  bottomDepthM: 10,
  soilName: '細砂',
  soilClass: 'fine-sand',
  geologicAge: 'alluvium',
  densityKgM3: 1800,
}

describe('aveN compatibility boundaries', () => {
  const samples: NValue[] = [
    { depthM: 0, n: 99 },
    { depthM: 1, n: 2 },
    { depthM: 2, n: 4 },
    { depthM: 3, n: 6 },
  ]

  it('excludes the top and includes the bottom', () => {
    expect(averageNForInterval(samples, 1, 3)).toMatchObject({ averageN: 5, count: 2 })
    expect(averageNForInterval(samples, 0, 1)).toMatchObject({ averageN: 2, count: 1 })
  })

  it('retains N=0 as a valid observation', () => {
    const result = averageNForInterval([{ depthM: 1, n: 0 }], 0, 1)
    expect(result).toMatchObject({ averageN: 0, count: 1 })
    expect(result.messages).toHaveLength(0)
  })

  it('returns an explicit warning when no data exist', () => {
    const result = averageNForInterval(samples, 10, 11)
    expect(result.averageN).toBeNull()
    expect(result.messages).toContainEqual(
      expect.objectContaining({ code: 'VS_N_DATA_MISSING', severity: 'warning' }),
    )
  })

  it('rejects reversed or zero-thickness intervals', () => {
    expect(averageNForInterval(samples, 2, 2).messages[0]).toMatchObject({
      code: 'VS_INTERVAL_INVALID',
      severity: 'error',
    })
  })
})

describe('Vs estimation', () => {
  it('keeps regulatory and workbook coefficient tables separate', () => {
    expect(REGULATORY_SOIL_COEFFICIENTS['fine-sand']).toBe(1.086)
    expect(REGULATORY_SOIL_COEFFICIENTS['medium-sand']).toBe(1.066)
    expect(LEGACY_SHEET_SOIL_COEFFICIENTS['fine-sand']).toBe(1.1)
    expect(LEGACY_SHEET_SOIL_COEFFICIENTS['medium-sand']).toBe(1.12)
    expect(GEOLOGIC_AGE_COEFFICIENTS.diluvium).toBe(1.303)
  })

  it('implements Vs=68.79 N^0.171 D^0.199 Yg St', () => {
    const expected = 68.79 * 10 ** 0.171 * 5 ** 0.199 * 1.303 * 1.086
    expect(estimateVsMps(10, 5, 1.303, 1.086)).toBeCloseTo(expected, 12)
  })

  it('prioritizes a direct Vs and preserves its provenance', () => {
    const result = resolveLayerVs(
      { ...BASE_LAYER, vsMps: 245, vsSource: 'measured', nValue: 1 },
      [{ depthM: 5, n: 50 }],
    )
    expect(result).toMatchObject({
      vsMps: 245,
      source: 'direct',
      valueSource: 'measured',
      soilCoefficient: null,
    })
  })

  it('uses the requested table for an estimate', () => {
    const regulatory = resolveLayerVs({ ...BASE_LAYER, nValue: 10 }, [], 'regulatory')
    const legacy = resolveLayerVs({ ...BASE_LAYER, nValue: 10 }, [], 'legacy-sheet')
    expect(regulatory.vsMps).toBeCloseTo(estimateVsMps(10, 5, 1, 1.086), 12)
    expect(legacy.vsMps).toBeCloseTo(estimateVsMps(10, 5, 1, 1.1), 12)
    expect(legacy.vsMps).toBeGreaterThan(regulatory.vsMps!)
  })

  it('does not manufacture a positive Vs from N=0', () => {
    const result = resolveLayerVs({ ...BASE_LAYER, nValue: 0 }, [])
    expect(result.vsMps).toBeNull()
    expect(result.messages).toContainEqual(expect.objectContaining({ code: 'VS_ZERO_N_UNRESOLVED' }))
  })

  it('requires an explicit mapping for a generic soil class', () => {
    const result = resolveLayerVs({ ...BASE_LAYER, soilClass: 'sand', nValue: 10 }, [])
    expect(result.vsMps).toBeNull()
    expect(result.messages).toContainEqual(
      expect.objectContaining({ code: 'VS_SOIL_CLASS_UNMAPPED', severity: 'error' }),
    )
  })
})

describe('elastic ground period', () => {
  it('equals the quarter-wavelength period for a uniform layer', () => {
    const result = calculateElasticGroundPeriod([
      { layerId: 'uniform', thicknessM: 20, vsMps: 200 },
    ])
    expect(result.periodS).toBeCloseTo((4 * 20) / 200, 12)
  })

  it('uses the full layered expression and reports unresolved Vs', () => {
    const layered = calculateElasticGroundPeriod([
      { layerId: 'L1', thicknessM: 10, vsMps: 100 },
      { layerId: 'L2', thicknessM: 10, vsMps: 300 },
    ])
    expect(layered.periodS).toBeCloseTo((4 * 20 ** 2) / (100 * 10 + 300 * 10), 12)

    const invalid = calculateElasticGroundPeriod([
      { layerId: 'L1', thicknessM: 10, vsMps: null },
    ])
    expect(invalid.periodS).toBeNull()
    expect(invalid.messages[0]).toMatchObject({ code: 'TG_VS_UNRESOLVED' })
  })
})
