export type UploadedTextEncoding = 'utf-8' | 'shift_jis'

export interface DecodedUploadedText {
  text: string
  encoding: UploadedTextEncoding
  hadBom: boolean
  warnings: string[]
}

export type TextDecodingErrorReason = 'unsupported-utf16' | 'unknown-encoding'

export class TextDecodingError extends Error {
  readonly reason: TextDecodingErrorReason

  constructor(reason: TextDecodingErrorReason, message: string) {
    super(message)
    this.name = 'TextDecodingError'
    this.reason = reason
  }
}

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const
const REPLACEMENT_CHARACTER = '\uFFFD'
const REPLACEMENT_WARNING = '置換文字（U+FFFD）が含まれています。文字化けを確認してください'

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte)
}

function warningsFor(text: string, encoding: UploadedTextEncoding): string[] {
  const warnings: string[] = []
  if (encoding === 'shift_jis') warnings.push('Shift_JIS（CP932）として読み込みました')
  if (text.includes(REPLACEMENT_CHARACTER)) warnings.push(REPLACEMENT_WARNING)
  return warnings
}

function decode(bytes: Uint8Array, encoding: UploadedTextEncoding): string {
  return new TextDecoder(encoding, { fatal: true }).decode(bytes)
}

export function decodeUploadedText(input: ArrayBuffer | Uint8Array): DecodedUploadedText {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)

  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) {
    throw new TextDecodingError(
      'unsupported-utf16',
      'UTF-16は未対応です。UTF-8またはShift_JIS（CP932）で保存してください',
    )
  }

  if (startsWith(bytes, UTF8_BOM)) {
    try {
      const text = decode(bytes.subarray(UTF8_BOM.length), 'utf-8')
      return { text, encoding: 'utf-8', hadBom: true, warnings: warningsFor(text, 'utf-8') }
    } catch {
      throw new TextDecodingError(
        'unknown-encoding',
        'UTF-8 BOMがありますが本文をUTF-8として読み込めません',
      )
    }
  }

  try {
    const text = decode(bytes, 'utf-8')
    return { text, encoding: 'utf-8', hadBom: false, warnings: warningsFor(text, 'utf-8') }
  } catch {
    try {
      const text = decode(bytes, 'shift_jis')
      return {
        text,
        encoding: 'shift_jis',
        hadBom: false,
        warnings: warningsFor(text, 'shift_jis'),
      }
    } catch {
      throw new TextDecodingError(
        'unknown-encoding',
        '文字コードを判定できません。UTF-8またはShift_JIS（CP932）で保存してください',
      )
    }
  }
}

export async function readUploadedText(file: Blob): Promise<DecodedUploadedText> {
  return decodeUploadedText(await file.arrayBuffer())
}
