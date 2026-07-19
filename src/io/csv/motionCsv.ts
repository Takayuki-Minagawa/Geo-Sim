import Papa from 'papaparse'
import type { MotionRecord } from '../../domain/types'

export function importMotionCsv(
  text: string,
  name: string,
  accelerationUnit: MotionRecord['accelerationUnit'],
): MotionRecord {
  if (new TextEncoder().encode(text).byteLength > 50 * 1024 * 1024) {
    throw new Error('時刻歴CSVが50 MiBを超えています')
  }
  const result = Papa.parse<string[]>(text.replace(/^\uFEFF/, ''), {
    skipEmptyLines: 'greedy',
  })
  if (result.errors.length > 0) {
    throw new Error(result.errors.map((error) => error.message).join('; '))
  }
  const rows = result.data.filter((row) => row.length >= 2)
  const firstIsHeader = rows.length > 0 && !Number.isFinite(Number(rows[0]?.[0]))
  const dataRows = firstIsHeader ? rows.slice(1) : rows
  if (dataRows.length < 2 || dataRows.length > 1_000_000) {
    throw new Error('時刻歴は2～1,000,000点で指定してください')
  }
  return {
    name,
    accelerationUnit,
    timesS: dataRows.map((row, index) => {
      const value = Number(row[0])
      if (!Number.isFinite(value)) throw new Error(`時刻歴${index + 1}行目の時刻が不正です`)
      return value
    }),
    accelerations: dataRows.map((row, index) => {
      const value = Number(row[1])
      if (!Number.isFinite(value)) throw new Error(`時刻歴${index + 1}行目の加速度が不正です`)
      return value
    }),
  }
}

export function exportMotionCsv(record: MotionRecord): string {
  const rows = record.timesS.map((time, index) => [time, record.accelerations[index]])
  return `\uFEFF${Papa.unparse([['time_s', `acceleration_${record.accelerationUnit}`], ...rows], {
    newline: '\r\n',
  })}`
}
