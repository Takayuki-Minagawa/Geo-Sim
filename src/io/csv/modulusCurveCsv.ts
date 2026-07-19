import Papa from 'papaparse'
import type { ModulusReductionPoint } from '../../domain/types'

export function exportModulusCurveCsv(points: readonly ModulusReductionPoint[]): string {
  return `\uFEFF${Papa.unparse(
    [
      ['strain', 'modulus_ratio', 'damping_ratio'],
      ...points.map((point) => [point.strain, point.modulusRatio, point.dampingRatio]),
    ],
    { newline: '\r\n' },
  )}`
}

export function parseModulusCurveCsv(text: string): ModulusReductionPoint[] {
  if (new TextEncoder().encode(text).byteLength > 1024 * 1024) {
    throw new Error('非線形特性CSVが1 MiBを超えています')
  }
  const parsed = Papa.parse<string[]>(text.replace(/^\uFEFF/, ''), {
    skipEmptyLines: 'greedy',
  })
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map(({ message }) => message).join('; '))
  }
  const rows = parsed.data.filter((row) => row.length >= 3)
  const hasHeader = rows.length > 0 && !Number.isFinite(Number(rows[0]?.[0]))
  const dataRows = hasHeader ? rows.slice(1) : rows
  if (dataRows.length < 1 || dataRows.length > 1000) {
    throw new Error('非線形特性は1〜1,000点で指定してください')
  }
  let previousStrain = -Infinity
  return dataRows.map((row, index) => {
    const strain = Number(row[0])
    const modulusRatio = Number(row[1])
    const dampingRatio = Number(row[2])
    if (!Number.isFinite(strain) || strain <= 0 || strain <= previousStrain) {
      throw new Error(`行${index + 1}: strainは0より大きく、厳密に増加させてください`)
    }
    if (!Number.isFinite(modulusRatio) || modulusRatio <= 0 || modulusRatio > 1) {
      throw new Error(`行${index + 1}: modulus_ratioは0超〜1で指定してください`)
    }
    if (!Number.isFinite(dampingRatio) || dampingRatio < 0 || dampingRatio > 1) {
      throw new Error(`行${index + 1}: damping_ratioは0〜1で指定してください`)
    }
    previousStrain = strain
    return { strain, modulusRatio, dampingRatio }
  })
}
