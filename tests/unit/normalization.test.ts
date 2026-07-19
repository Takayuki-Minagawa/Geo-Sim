import { describe, expect, it } from 'vitest'
import { createDefaultProject } from '../../src/domain/defaultProject'
import type { GroundLayer, GroundModel } from '../../src/domain/types'
import { normalizeGroundModel } from '../../src/core/normalization/splitLayers'

describe('ground normalization', () => {
  it('splits layers at groundwater and 20 m boundaries without zero thickness', () => {
    const project = createDefaultProject()
    const result = normalizeGroundModel(project.ground)
    expect(result.messages.some((message) => message.severity === 'error')).toBe(false)
    expect(result.ground.layers.some((layer) => layer.bottomDepthM === 0.7)).toBe(true)
    expect(result.ground.layers.every((layer) => layer.bottomDepthM > layer.topDepthM)).toBe(true)
  })

  it('marks layers above the improvement depth', () => {
    const project = createDefaultProject()
    project.ground.improvementDepthM = 3
    const result = normalizeGroundModel(project.ground)
    expect(
      result.ground.layers.filter((layer) => layer.bottomDepthM <= 3).every((layer) => layer.improved),
    ).toBe(true)
  })

  it('truncates a layer crossing engineering bedrock and excludes deeper layers', () => {
    const result = normalizeGroundModel(
      ground([
        layer({ id: 'L1', topDepthM: 0, bottomDepthM: 8 }),
        layer({ id: 'L2', topDepthM: 8, bottomDepthM: 12 }),
        layer({
          id: 'L3',
          topDepthM: 12,
          bottomDepthM: 15,
          soilName: '礫',
          soilClass: 'gravel',
        }),
      ], 10),
    )

    expect(result.ground.layers.map(({ id, topDepthM, bottomDepthM }) => ({
      id,
      topDepthM,
      bottomDepthM,
    }))).toEqual([
      { id: 'L1', topDepthM: 0, bottomDepthM: 8 },
      { id: 'L2', topDepthM: 8, bottomDepthM: 10 },
    ])
    expect(result.ground.layers.some(({ soilClass }) => soilClass === 'gravel')).toBe(false)
  })

  it('ignores a non-contiguous layer that starts entirely below engineering bedrock', () => {
    const result = normalizeGroundModel(
      ground([
        layer({ id: 'L1', topDepthM: 0, bottomDepthM: 10 }),
        layer({
          id: 'L2',
          topDepthM: 12,
          bottomDepthM: 15,
          soilName: '礫',
          soilClass: 'gravel',
        }),
      ], 10),
    )

    expect(result.ground.layers.map(({ id }) => id)).toEqual(['L1'])
    expect(result.messages.map(({ code }) => code)).not.toContain('LAYER_NOT_CONTIGUOUS')
  })

  it('preserves an explicitly improved source layer without an improvement depth', () => {
    const result = normalizeGroundModel(
      ground([layer({ id: 'L1', topDepthM: 0, bottomDepthM: 2, improved: true })], 2),
    )

    expect(result.ground.layers).toHaveLength(1)
    expect(result.ground.layers[0]?.improved).toBe(true)
  })

  it('does not persist an N-value average derived from replaceable boring data', () => {
    const input = ground([layer({ id: 'L1', topDepthM: 0, bottomDepthM: 4, nValue: undefined })], 4)
    input.groundwaterDepthM = 2
    input.nValues = [
      { depthM: 1, n: 2 },
      { depthM: 3, n: 10 },
    ]

    const result = normalizeGroundModel(input)

    expect(result.ground.layers.map(({ nValue }) => nValue)).toEqual([undefined, undefined])
    expect(result.clippedGround.layers).toHaveLength(1)
    expect(result.clippedGround.layers[0]?.nValue).toBeUndefined()
  })

  it('does not warn when the last layer reaches a numerically equivalent bedrock depth', () => {
    const result = normalizeGroundModel(
      ground([layer({ id: 'L1', topDepthM: 0, bottomDepthM: 0.3 })], 0.1 + 0.2),
    )

    expect(result.messages.map(({ code }) => code)).not.toContain('LAYERS_DO_NOT_REACH_BEDROCK')
  })

  it.each([
    {
      name: 'non-contiguous layers',
      layers: [
        layer({ id: 'L1', topDepthM: 0, bottomDepthM: 1 }),
        layer({ id: 'L2', topDepthM: 2, bottomDepthM: 3 }),
      ],
      expectedCode: 'LAYER_NOT_CONTIGUOUS',
    },
    {
      name: 'a zero-thickness layer',
      layers: [layer({ id: 'L1', topDepthM: 0, bottomDepthM: 0 })],
      expectedCode: 'LAYER_NON_POSITIVE_THICKNESS',
    },
  ])('reports an error for $name', ({ layers, expectedCode }) => {
    const result = normalizeGroundModel(ground(layers, 3))

    expect(result.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: expectedCode, severity: 'error' })]),
    )
  })

  it('reports an error when every input layer is below engineering bedrock', () => {
    const result = normalizeGroundModel(
      ground([layer({ id: 'deep', topDepthM: 2, bottomDepthM: 3 })], 1),
    )

    expect(result.ground.layers).toEqual([])
    expect(result.messages).toContainEqual(
      expect.objectContaining({ code: 'LAYER_MODEL_EMPTY', severity: 'error' }),
    )
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

function ground(layers: GroundLayer[], bedrockDepthM: number): GroundModel {
  return {
    groundwaterDepthM: 0,
    nValues: [],
    layers,
    engineeringBedrock: {
      depthM: bedrockDepthM,
      densityKgM3: 2000,
      vsMps: 400,
    },
  }
}
