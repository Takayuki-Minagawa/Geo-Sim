import { describe, expect, it } from 'vitest'
import {
  CsvTypeDetectionError,
  detectCsvKind,
} from '../../src/io/csv/detectCsvKind'

describe('CSV kind detection', () => {
  it.each([
    ['n-values', '\uFEFFdepth_m,n_value,soil_name\r\n1,5,砂'],
    [
      'layers',
      'id,top_depth_m,bottom_depth_m,soil_name,soil_class,density_kg_m3\nL1,0,2,砂,sand,1800',
    ],
    ['motion', 'time_s,acceleration_gal\n0,0\n0.01,100'],
  ] as const)('detects %s from its header instead of its filename or active tab', (kind, csv) => {
    expect(detectCsvKind(csv)).toBe(kind)
  })

  it('normalizes quoted header names, case, and surrounding whitespace', () => {
    expect(detectCsvKind(' "DEPTH_M" , "N_VALUE" , soil_name\n1,2,砂')).toBe('n-values')
  })

  it('throws an explicit unknown error when no known header signature matches', () => {
    expect.assertions(3)
    try {
      detectCsvKind('foo,bar\n1,2')
    } catch (error) {
      expect(error).toBeInstanceOf(CsvTypeDetectionError)
      expect((error as CsvTypeDetectionError).reason).toBe('unknown')
      expect((error as Error).message).toContain('CSV種別を判定できません')
    }
  })

  it('throws an explicit ambiguous error when multiple signatures match', () => {
    expect.assertions(3)
    try {
      detectCsvKind('id,top_depth_m,bottom_depth_m,depth_m,n_value\nL1,0,1,1,3')
    } catch (error) {
      expect(error).toBeInstanceOf(CsvTypeDetectionError)
      expect((error as CsvTypeDetectionError).reason).toBe('ambiguous')
      expect((error as CsvTypeDetectionError).candidates).toEqual(['n-values', 'layers'])
    }
  })
})
