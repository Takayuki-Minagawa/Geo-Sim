import Papa from 'papaparse'

export type CsvKind = 'n-values' | 'layers' | 'motion'
export type CsvTypeDetectionErrorReason = 'invalid-header' | 'unknown' | 'ambiguous'

export class CsvTypeDetectionError extends Error {
  readonly reason: CsvTypeDetectionErrorReason
  readonly candidates: CsvKind[]

  constructor(reason: CsvTypeDetectionErrorReason, candidates: CsvKind[] = []) {
    const message =
      reason === 'ambiguous'
        ? `CSV種別が曖昧です（候補: ${candidates.join(', ')}）`
        : reason === 'invalid-header'
          ? 'CSVヘッダを解析できません'
          : 'CSV種別を判定できません。ヘッダを確認してください'
    super(message)
    this.name = 'CsvTypeDetectionError'
    this.reason = reason
    this.candidates = candidates
  }
}

interface CsvSignature {
  kind: CsvKind
  matches: (headers: ReadonlySet<string>) => boolean
}

const SIGNATURES: readonly CsvSignature[] = [
  {
    kind: 'n-values',
    matches: (headers) => headers.has('depth_m') && headers.has('n_value'),
  },
  {
    kind: 'layers',
    matches: (headers) => headers.has('id') && headers.has('top_depth_m'),
  },
  {
    kind: 'motion',
    matches: (headers) =>
      headers.has('time_s') &&
      [...headers].some(
        (header) => header === 'acceleration' || header.startsWith('acceleration_'),
      ),
  },
]

function normalizeHeader(header: string): string {
  return header.trim().replace(/^['"]|['"]$/g, '').trim().toLowerCase()
}

export function detectCsvKind(text: string): CsvKind {
  const parsed = Papa.parse<string[]>(text.replace(/^\uFEFF/, ''), {
    preview: 1,
    skipEmptyLines: 'greedy',
  })
  if (parsed.errors.length > 0) {
    throw new CsvTypeDetectionError('invalid-header')
  }
  const firstRow = parsed.data[0]
  if (!firstRow || firstRow.length === 0) {
    throw new CsvTypeDetectionError('unknown')
  }
  const headers = new Set(firstRow.map(normalizeHeader).filter(Boolean))
  const candidates = SIGNATURES.filter(({ matches }) => matches(headers)).map(({ kind }) => kind)
  if (candidates.length === 0) throw new CsvTypeDetectionError('unknown')
  if (candidates.length > 1) throw new CsvTypeDetectionError('ambiguous', candidates)
  return candidates[0]!
}
