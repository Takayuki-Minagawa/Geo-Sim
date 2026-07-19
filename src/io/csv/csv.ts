import Papa from 'papaparse'
import type { GroundLayer, NValue, SoilClass, ValueSource } from '../../domain/types'

const MAX_CSV_BYTES = 10 * 1024 * 1024
const ESCAPABLE_CSV_PREFIX = /^'*(?=[=+\-@])/
const SOIL_CLASSES = [
  'clay',
  'silt',
  'sand',
  'fine-sand',
  'medium-sand',
  'coarse-sand',
  'gravelly-sand',
  'gravel',
  'surface-soil',
  'fill',
  'organic',
  'rock',
  'other',
] as const satisfies readonly SoilClass[]
const VALUE_SOURCES = [
  'input',
  'estimated',
  'default',
  'measured',
  'legacy',
] as const satisfies readonly ValueSource[]

export function safeCsvText(value: string): string {
  return ESCAPABLE_CSV_PREFIX.test(value) ? `'${value}` : value
}

export function restoreCsvText(value: string): string {
  return /^'+[=+\-@]/.test(value) ? value.slice(1) : value
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

function enumValue<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  label: string,
): T | undefined {
  const normalized = value?.trim()
  if (!normalized) return undefined
  if (allowed.some((candidate) => candidate === normalized)) return normalized as T
  throw new Error(`${label} の値「${normalized}」は許容されていません`)
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
    soilName: row.soil_name ? restoreCsvText(row.soil_name) || undefined : undefined,
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
  return result.data.map((row, index) => {
    const rowNumber = index + 2
    const reference = restoreCsvText(row.vs_reference ?? '')
    return {
      id: restoreCsvText(row.id ?? '') || `L${index + 1}`,
      topDepthM: finiteNumber(row.top_depth_m, `行${rowNumber} top_depth_m`),
      bottomDepthM: finiteNumber(row.bottom_depth_m, `行${rowNumber} bottom_depth_m`),
      soilName: restoreCsvText(row.soil_name ?? '') || '未設定',
      soilClass: enumValue(row.soil_class, SOIL_CLASSES, `行${rowNumber} soil_class`) ?? 'other',
      geologicAge:
        row.geologic_age === 'alluvium' || row.geologic_age === 'diluvium'
          ? row.geologic_age
          : 'unknown',
      densityKgM3: finiteNumber(row.density_kg_m3, `行${rowNumber} density_kg_m3`),
      finesPercent: row.fines_percent
        ? finiteNumber(row.fines_percent, `行${rowNumber} fines_percent`)
        : undefined,
      nValue: row.n_value ? finiteNumber(row.n_value, `行${rowNumber} n_value`) : undefined,
      vsMps: row.vs_m_s ? finiteNumber(row.vs_m_s, `行${rowNumber} vs_m_s`) : undefined,
      vsSource: enumValue(row.vs_source, VALUE_SOURCES, `行${rowNumber} vs_source`),
      vsProvenance: reference
        ? {
            reference,
            method: restoreCsvText(row.vs_test_method ?? '') || undefined,
            testedOn: restoreCsvText(row.vs_tested_on ?? '') || undefined,
            location: restoreCsvText(row.vs_test_location ?? '') || undefined,
          }
        : undefined,
      improved: row.improved === 'true' || row.improved === '1',
    }
  })
}
