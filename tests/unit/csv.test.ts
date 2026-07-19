import { describe, expect, it } from 'vitest'
import { exportNValuesCsv, importNValuesCsv, safeCsvText } from '../../src/io/csv/csv'
import { exportMotionCsv, importMotionCsv } from '../../src/io/csv/motionCsv'

describe('CSV I/O', () => {
  it('neutralizes spreadsheet formulas in text values', () => {
    expect(safeCsvText('=1+1')).toBe("'=1+1")
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
})
