import { describe, expect, it } from 'vitest'
import { importNValuesCsv } from '../../src/io/csv/csv'
import { decodeUploadedText } from '../../src/io/textEncoding'

describe('uploaded text decoding', () => {
  it('decodes UTF-8 with a BOM and removes the BOM', () => {
    const content = new TextEncoder().encode('砂質土')
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...content])

    expect(decodeUploadedText(bytes)).toEqual({
      text: '砂質土',
      encoding: 'utf-8',
      hadBom: true,
      warnings: [],
    })
  })

  it('uses Shift_JIS when the byte sequence is not valid UTF-8', () => {
    const shiftJisSand = Uint8Array.from([0x8d, 0xbb, 0x8e, 0xbf, 0x93, 0x79])

    expect(decodeUploadedText(shiftJisSand)).toEqual({
      text: '砂質土',
      encoding: 'shift_jis',
      hadBom: false,
      warnings: ['Shift_JIS（CP932）として読み込みました'],
    })
  })

  it('preserves Japanese fields in an Excel-style Shift_JIS CSV import', () => {
    const header = new TextEncoder().encode('depth_m,n_value,soil_name\r\n1,5,')
    const soilName = [0x8d, 0xbb, 0x8e, 0xbf, 0x93, 0x79]
    const bytes = Uint8Array.from([...header, ...soilName, 0x0d, 0x0a])

    expect(importNValuesCsv(decodeUploadedText(bytes).text)).toEqual([
      { depthM: 1, n: 5, soilName: '砂質土' },
    ])
  })

  it('reports an existing replacement character to prevent silent persistence', () => {
    const decoded = decodeUploadedText(new TextEncoder().encode('砂\uFFFD土'))

    expect(decoded.warnings).toContain('置換文字（U+FFFD）が含まれています。文字化けを確認してください')
  })

  it('rejects unsupported or undecodable encodings', () => {
    expect(() => decodeUploadedText(Uint8Array.from([0xff, 0xfe, 0x41, 0x00]))).toThrow(
      'UTF-16は未対応',
    )
    expect(() => decodeUploadedText(Uint8Array.from([0x81]))).toThrow('文字コードを判定できません')
  })
})
