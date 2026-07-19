import { describe, expect, it } from 'vitest'
import {
  exportModulusCurveCsv,
  parseModulusCurveCsv,
} from '../../src/io/csv/modulusCurveCsv'

describe('非線形特性CSV', () => {
  it('ひずみ・剛性比・減衰比を往復する', () => {
    const points = [
      { strain: 1e-6, modulusRatio: 1, dampingRatio: 0.02 },
      { strain: 1e-4, modulusRatio: 0.5, dampingRatio: 0.1 },
    ]
    expect(parseModulusCurveCsv(exportModulusCurveCsv(points))).toEqual(points)
  })

  it('非増加ひずみと範囲外値を拒否する', () => {
    expect(() => parseModulusCurveCsv('1e-4,1,0.02\n1e-5,0.5,0.1')).toThrow('厳密に増加')
    expect(() => parseModulusCurveCsv('1e-4,1.1,0.02')).toThrow('modulus_ratio')
  })
})
