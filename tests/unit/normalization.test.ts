import { describe, expect, it } from 'vitest'
import { createDefaultProject } from '../../src/domain/defaultProject'
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
})
