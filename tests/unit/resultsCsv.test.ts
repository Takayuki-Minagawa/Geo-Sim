import { describe, expect, it } from 'vitest'
import Papa from 'papaparse'
import type { AnalysisResult } from '../../src/domain/types'
import {
  exportGsResultCsv,
  exportLiquefactionResultCsv,
  exportMotionSpectrumCsv,
} from '../../src/io/csv/resultsCsv'

const result: AnalysisResult = {
  resultVersion: '1.0.0',
  calculatedAt: '2026-07-19T00:00:00.000Z',
  appVersion: '0.1.0',
  inputSha256: 'abc',
  metadata: {
    gsMethodId: 'jp-mlit-kokuji-1457-current',
    legalBasisCheckedOn: '2026-07-19',
    vsCoefficientTableId: 'regulatory',
    liquefactionMethodId: 'legacy-aij-derived-screening-v1',
    responseSpectrumDampingRatio: 0.05,
    units: {
      length: 'm',
      acceleration: 'm/s2',
      velocity: 'm/s',
      density: 'kg/m3',
      stress: 'Pa',
    },
  },
  gs: {
    mode: 'safety-simplified',
    converged: true,
    curve: [
      { periodS: 1, gs: 1.5, baseSaMps2: 2, surfaceSaMps2: 3, svMps: 0.4, sdM: 0.06 },
    ],
    iterations: [],
    applicability: [],
    messages: [],
  },
  liquefaction: [
    {
      caseId: 'damage-150gal',
      peakAccelerationGal: 150,
      magnitude: 7,
      dcyCm: 1,
      dcyClass: '軽微',
      pl: 2,
      plClass: '低い',
      layers: [
        {
          layerId: 'L1',
          topDepthM: 1,
          bottomDepthM: 2,
          centerDepthM: 1.5,
          eligible: true,
          n: 5,
          correctedN: 7,
          demandRatio: 0.2,
          resistanceRatio: 0.3,
          fl: 1.5,
          cyclicStrainPercent: 0,
          dcyContributionCm: 0,
          plContribution: 0,
          reason: '対象',
        },
      ],
      messages: [],
    },
  ],
  motion: {
    pgaMps2: 1,
    pgvMps: 0.1,
    pgdM: 0.01,
    timeStepS: 0.01,
    spectrum: [{ periodS: 1, sdM: 0.1, svMps: 0.2, saMps2: 0.3 }],
    messages: [],
  },
  messages: [],
}

describe('結果CSV', () => {
  it('Gs・液状化・応答スペクトルの明細をBOM付きで出力する', () => {
    expect(exportGsResultCsv(result)).toContain('\uFEFFperiod_s,gs')
    expect(exportLiquefactionResultCsv(result)).toContain('damage-150gal,150,7,L1')
    expect(exportMotionSpectrumCsv(result)).toContain('1,0.1,0.2,0.3,0.05')
  })

  it('液状化明細の文字列セルをCSV数式として実行されない形にする', () => {
    const malicious = structuredClone(result)
    const caseResult = malicious.liquefaction[0]!
    const layer = caseResult.layers[0]!
    caseResult.caseId = '=HYPERLINK("https://example.invalid")' as typeof caseResult.caseId
    layer.layerId = '+CMD'
    layer.reason = '@SUM(1+1)'

    const exported = exportLiquefactionResultCsv(malicious)
    const parsed = Papa.parse<string[]>(exported.replace(/^\uFEFF/, '')).data

    expect(parsed[1]?.[0]).toBe("'=HYPERLINK(\"https://example.invalid\")")
    expect(parsed[1]?.[3]).toBe("'+CMD")
    expect(parsed[1]?.[16]).toBe("'@SUM(1+1)")
  })
})
