import { describe, expect, it } from 'vitest'
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
    expect(imported.project.ground.layers).toHaveLength(3)
    expect(imported.project.ground.engineeringBedrock.vsMps).toBe(400)
    expect(imported.messages.some((message) => message.code === 'LEGACY_IMPORT_INPUTS_ONLY')).toBe(true)
  })

  it('reads a generated BIFF8 buffer', () => {
    const bytes = write(createSyntheticLegacyWorkbook(), { bookType: 'xls', type: 'array' }) as ArrayBuffer
    const imported = importLegacyXls(bytes, 'synthetic.xls')
    expect(imported.project.provenance.sourceType).toBe('legacy-xls')
    expect(imported.project.ground.nValues).toHaveLength(5)
  })
})
