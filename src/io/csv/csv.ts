import Papa from 'papaparse'
import type { GroundLayer, NValue, SoilClass } from '../../domain/types'

const MAX_CSV_BYTES = 10 * 1024 * 1024
const DANGEROUS_CSV_PREFIX = /^[=+\-@]/

export function safeCsvText(value: string): string {
  return DANGEROUS_CSV_PREFIX.test(value) ? `'${value}` : value
}

function assertCsvSize(text: string): void {
  if (new TextEncoder().encode(text).byteLength > MAX_CSV_BYTES) {
    throw new Error('CSVファイルサイズが10 MiBを超えています')
  }
}

function finiteNumber(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} が数値ではありません`)
  }
  return parsed
}

export function exportNValuesCsv(values: NValue[]): string {
  const rows = values.map((value) => ({
    depth_m: value.depthM,
    n_value: value.n,
    soil_name: safeCsvText(value.soilName ?? ''),
  }))
  return `\uFEFF${Papa.unparse(rows, { newline: '\r\n' })}`
}

export function importNValuesCsv(text: string): NValue[] {
  assertCsvSize(text)
  const result = Papa.parse<Record<string, string>>(text.replace(/^\uFEFF/, ''), {
    header: true,
    skipEmptyLines: 'greedy',
  })
  if (result.errors.length > 0) {
    throw new Error(result.errors.map((error) => error.message).join('; '))
  }
  if (result.data.length > 10_000) {
    throw new Error('N値データが10,000行を超えています')
  }
  return result.data.map((row, index) => ({
    depthM: finiteNumber(row.depth_m, `行${index + 2} depth_m`),
    n: finiteNumber(row.n_value, `行${index + 2} n_value`),
    soilName: row.soil_name?.replace(/^'(?=[=+\-@])/, '') || undefined,
  }))
}

export function exportLayersCsv(layers: GroundLayer[]): string {
  const rows = layers.map((layer) => ({
    id: safeCsvText(layer.id),
    top_depth_m: layer.topDepthM,
    bottom_depth_m: layer.bottomDepthM,
    soil_name: safeCsvText(layer.soilName),
    soil_class: layer.soilClass,
    geologic_age: layer.geologicAge,
    density_kg_m3: layer.densityKgM3,
    fines_percent: layer.finesPercent ?? '',
    n_value: layer.nValue ?? '',
    vs_m_s: layer.vsMps ?? '',
    vs_source: layer.vsSource ?? '',
    vs_reference: safeCsvText(layer.vsProvenance?.reference ?? ''),
    vs_test_method: safeCsvText(layer.vsProvenance?.method ?? ''),
    vs_tested_on: safeCsvText(layer.vsProvenance?.testedOn ?? ''),
    vs_test_location: safeCsvText(layer.vsProvenance?.location ?? ''),
    improved: layer.improved ?? false,
  }))
  return `\uFEFF${Papa.unparse(rows, { newline: '\r\n' })}`
}

export function importLayersCsv(text: string): GroundLayer[] {
  assertCsvSize(text)
  const result = Papa.parse<Record<string, string>>(text.replace(/^\uFEFF/, ''), {
    header: true,
    skipEmptyLines: 'greedy',
  })
  if (result.errors.length > 0) {
    throw new Error(result.errors.map((error) => error.message).join('; '))
  }
  if (result.data.length > 500) {
    throw new Error('地層データが500行を超えています')
  }
  return result.data.map((row, index) => ({
    id: row.id || `L${index + 1}`,
    topDepthM: finiteNumber(row.top_depth_m, `行${index + 2} top_depth_m`),
    bottomDepthM: finiteNumber(row.bottom_depth_m, `行${index + 2} bottom_depth_m`),
    soilName: row.soil_name || '未設定',
    soilClass: (row.soil_class || 'other') as SoilClass,
    geologicAge:
      row.geologic_age === 'alluvium' || row.geologic_age === 'diluvium'
        ? row.geologic_age
        : 'unknown',
    densityKgM3: finiteNumber(row.density_kg_m3, `行${index + 2} density_kg_m3`),
    finesPercent: row.fines_percent ? finiteNumber(row.fines_percent, 'fines_percent') : undefined,
    nValue: row.n_value ? finiteNumber(row.n_value, 'n_value') : undefined,
    vsMps: row.vs_m_s ? finiteNumber(row.vs_m_s, 'vs_m_s') : undefined,
    vsSource: row.vs_source ? (row.vs_source as GroundLayer['vsSource']) : undefined,
    vsProvenance: row.vs_reference
      ? {
          reference: row.vs_reference,
          method: row.vs_test_method || undefined,
          testedOn: row.vs_tested_on || undefined,
          location: row.vs_test_location || undefined,
        }
      : undefined,
    improved: row.improved === 'true' || row.improved === '1',
  }))
}
