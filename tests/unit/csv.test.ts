import { describe, expect, it } from 'vitest'
import type { GroundLayer } from '../../src/domain/types'
import {
  exportLayersCsv,
  exportNValuesCsv,
  importLayersCsv,
  importNValuesCsv,
  restoreCsvText,
  safeCsvText,
} from '../../src/io/csv/csv'
import { exportMotionCsv, importMotionCsv } from '../../src/io/csv/motionCsv'

describe('CSV I/O', () => {
  it('neutralizes spreadsheet formulas in text values', () => {
    expect(safeCsvText('=1+1')).toBe("'=1+1")
    expect(restoreCsvText(safeCsvText("''=入力値"))).toBe("''=入力値")
    expect(safeCsvText('通常文字')).toBe('通常文字')
  })

  it('round-trips N values with UTF-8 BOM', () => {
    const csv = exportNValuesCsv([{ depthM: 1, n: 3, soilName: '=HYPERLINK("x")' }])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(importNValuesCsv(csv)).toEqual([
      { depthM: 1, n: 3, soilName: '=HYPERLINK("x")' },
    ])
  })

  it('reads and writes a motion record', () => {
    const original = {
      name: 'test',
      accelerationUnit: 'gal' as const,
      timesS: [0, 0.01, 0.02],
      accelerations: [0, 100, 0],
    }
    const parsed = importMotionCsv(exportMotionCsv(original), 'test', 'gal')
    expect(parsed).toEqual(original)
  })

  it('round-trips every escaped text field in a ground layer', () => {
    const layers: GroundLayer[] = [
      {
        id: '=L1',
        topDepthM: 0,
        bottomDepthM: 2,
        soilName: '-粘土混じり砂',
        soilClass: 'sand',
        geologicAge: 'alluvium',
        densityKgM3: 1800,
        finesPercent: 12,
        nValue: 7,
        vsMps: 145,
        vsSource: 'measured',
        vsProvenance: {
          reference: '+報告書',
          method: '@PS検層',
          testedOn: '=2026-07-20',
          location: '-孔内',
        },
        improved: true,
      },
    ]

    expect(importLayersCsv(exportLayersCsv(layers))).toEqual(layers)
  })

  it.each([
    ['soil_class', 'sandy'],
    ['vs_source', 'observed'],
  ])('rejects an invalid %s enum with the CSV row number', (column, invalidValue) => {
    const csv = [
      'id,top_depth_m,bottom_depth_m,soil_name,soil_class,geologic_age,density_kg_m3,vs_source',
      `L1,0,2,砂,sand,alluvium,1800,measured`,
      `L2,2,4,粘土,clay,alluvium,1700,measured`,
    ]
    const columnIndex = csv[0]!.split(',').indexOf(column)
    const row = csv[1]!.split(',')
    row[columnIndex] = invalidValue
    csv[1] = row.join(',')

    expect(() => importLayersCsv(csv.join('\n'))).toThrow(`行2 ${column}`)
  })
})
