import { describe, expect, it } from 'vitest'
import { serializeProject } from '../../src/io/json/projectJson'
import { write } from 'xlsx'
import {
  createSyntheticLegacyWorkbook,
  importLegacyXls,
  importLegacyWorkbook,
} from '../../src/io/legacy-xls/importLegacyXls'

describe('legacy XLS adapter', () => {
  it('extracts only input cells from a synthetic workbook', () => {
    const imported = importLegacyWorkbook(createSyntheticLegacyWorkbook(), 'synthetic.xls')
    expect(imported.project.project.name).toBe('合成テスト案件')
    expect(imported.project.ground.layers).toHaveLength(2)
    expect(imported.project.ground.engineeringBedrock.vsMps).toBe(400)
    expect(imported.messages.some((message) => message.code === 'LEGACY_IMPORT_INPUTS_ONLY')).toBe(true)
  })

  it('reads a generated BIFF8 buffer', () => {
    const bytes = write(createSyntheticLegacyWorkbook(), { bookType: 'xls', type: 'array' }) as ArrayBuffer
    const imported = importLegacyXls(bytes, 'synthetic.xls')
    expect(imported.project.provenance.sourceType).toBe('legacy-xls')
    expect(imported.project.ground.nValues).toHaveLength(5)
  })

  it('does not adopt the cached value of a formula cell as engineering-bedrock Vs', () => {
    const workbook = createSyntheticLegacyWorkbook()
    const sheet = workbook.Sheets['メイン']!
    sheet.Q29 = { t: 'n', v: 777, f: '=VLOOKUP(A1,A2:B3,2,FALSE)' }

    const imported = importLegacyWorkbook(workbook, 'formula.xls')
    const incomplete = imported.messages.find(
      ({ code }) => code === 'LEGACY_BEDROCK_INCOMPLETE',
    )

    expect(imported.project.ground.engineeringBedrock.vsMps).toBe(0)
    expect(incomplete).toMatchObject({ code: 'LEGACY_BEDROCK_INCOMPLETE', severity: 'error' })
    expect(incomplete?.message).toMatch(/Vs.*手入力/)
    expect(() => serializeProject(imported.project)).toThrow(/engineeringBedrock\/vsMps/)
  })
})
