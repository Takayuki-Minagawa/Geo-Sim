import { read, utils, type CellObject, type WorkBook, type WorkSheet } from 'xlsx'
import { APP_VERSION, createDefaultProject } from '../../domain/defaultProject'
import type { AnalysisMessage, GeologicAge, GroundLayer, JibanProject, SoilClass } from '../../domain/types'
import { normalizeGroundModel } from '../../core/normalization/splitLayers'

export interface LegacyImportResult {
  project: JibanProject
  messages: AnalysisMessage[]
}

function sheetCell(sheet: WorkSheet, address: string): CellObject | undefined {
  return sheet[address] as CellObject | undefined
}

function inputValue(sheet: WorkSheet, address: string): unknown {
  const cell = sheetCell(sheet, address)
  if (!cell || cell.f) return undefined
  return cell.v
}

function numericInput(sheet: WorkSheet, address: string): number | undefined {
  const value = inputValue(sheet, address)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return undefined
}

function displayedNumber(sheet: WorkSheet, address: string): number | undefined {
  const cell = sheetCell(sheet, address)
  return typeof cell?.v === 'number' && Number.isFinite(cell.v) ? cell.v : undefined
}

function textInput(sheet: WorkSheet, address: string): string | undefined {
  const value = inputValue(sheet, address)
  if (
    value === undefined ||
    value === null ||
    (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
  ) {
    return undefined
  }
  const text = String(value).trim()
  return text === '' ? undefined : text
}

export function classifyJapaneseSoil(name: string): SoilClass {
  if (name.includes('岩')) return 'rock'
  if (name.includes('砂礫')) return 'gravelly-sand'
  if (name.includes('礫')) return 'gravel'
  if (name.includes('粗砂')) return 'coarse-sand'
  if (name.includes('中砂')) return 'medium-sand'
  if (name.includes('細砂')) return 'fine-sand'
  if (name.includes('砂')) return 'sand'
  if (name.includes('粘土')) return 'clay'
  if (name.includes('シルト')) return 'silt'
  if (name.includes('盛土')) return 'fill'
  if (name.includes('表土')) return 'surface-soil'
  if (name.includes('腐植')) return 'organic'
  return 'other'
}

function geologicAgeFromCell(sheet: WorkSheet, row: number): GeologicAge {
  const value = numericInput(sheet, `O${row}`)
  if (value === 1.303) return 'diluvium'
  if (value === 1) return 'alluvium'
  return 'unknown'
}

function extractNValues(sheet: WorkSheet): JibanProject['ground']['nValues'] {
  const values: JibanProject['ground']['nValues'] = []
  for (let row = 13; row <= 82; row += 1) {
    const depthM = numericInput(sheet, `A${row}`)
    const n = numericInput(sheet, `C${row}`)
    if (depthM === undefined || n === undefined) continue
    values.push({ depthM, n, soilName: textInput(sheet, `B${row}`) })
  }
  return values
}

function extractLayers(sheet: WorkSheet): GroundLayer[] {
  const layers: GroundLayer[] = []
  let topDepthM = 0
  for (let row = 14; row <= 28; row += 1) {
    const bottomDepthM = numericInput(sheet, `H${row}`)
    const soilName = textInput(sheet, `K${row}`)
    const densityTonneM3 = numericInput(sheet, `L${row}`)
    if (bottomDepthM === undefined || soilName === undefined || densityTonneM3 === undefined) continue
    if (bottomDepthM <= topDepthM) continue
    layers.push({
      id: `L${layers.length + 1}`,
      topDepthM,
      bottomDepthM,
      soilName,
      soilClass: classifyJapaneseSoil(soilName),
      geologicAge: geologicAgeFromCell(sheet, row),
      densityKgM3: densityTonneM3 * 1000,
      finesPercent: numericInput(sheet, `N${row}`),
    })
    topDepthM = bottomDepthM
  }
  return layers
}

export function importLegacyWorkbook(workbook: WorkBook, fileName = '地盤シート.xls'): LegacyImportResult {
  const sheet = workbook.Sheets['メイン']
  if (!sheet) throw new Error('旧XLSに「メイン」シートがありません')

  const messages: AnalysisMessage[] = [
    {
      code: 'LEGACY_IMPORT_INPUTS_ONLY',
      severity: 'info',
      message: 'VBA、数式、外部リンク、保存計算値を実行・採用せず、入力セルだけを取り込みました',
    },
  ]
  const project = createDefaultProject()
  project.appVersion = APP_VERSION
  project.project.name = textInput(sheet, 'B3') ?? textInput(sheet, 'G3') ?? '旧XLS取込案件'
  const latitude = numericInput(sheet, 'Q3')
  const longitude = numericInput(sheet, 'Q4')
  if (latitude !== undefined || longitude !== undefined) {
    project.project.location = { latitude, longitude }
  }
  project.provenance = {
    sourceType: 'legacy-xls',
    sourceFileName: fileName,
    importedAt: new Date().toISOString(),
  }
  project.method.gs = 'jp-mlit-kokuji-1457-current'
  project.ground.groundwaterDepthM = numericInput(sheet, 'I11') ?? 0
  project.ground.improvementDepthM = numericInput(sheet, 'I9')
  project.ground.nValues = extractNValues(sheet)
  project.ground.layers = extractLayers(sheet)

  const bedrockDepth = numericInput(sheet, 'H29') ?? project.ground.layers.at(-1)?.bottomDepthM
  const bedrockDensity = numericInput(sheet, 'L29')
  const bedrockVs = numericInput(sheet, 'Q29') ?? displayedNumber(sheet, 'Q29')
  if (bedrockDepth === undefined || bedrockDensity === undefined || bedrockVs === undefined) {
    messages.push({
      code: 'LEGACY_BEDROCK_INCOMPLETE',
      severity: 'error',
      message: '工学的基盤の深さ・密度・Vsを旧XLSから取得できませんでした',
    })
  } else {
    project.ground.engineeringBedrock = {
      depthM: bedrockDepth,
      densityKgM3: bedrockDensity * 1000,
      vsMps: bedrockVs,
    }
  }

  if (project.ground.layers.length === 0 || project.ground.nValues.length === 0) {
    messages.push({
      code: 'LEGACY_INPUTS_MISSING',
      severity: 'error',
      message: '旧XLSから地層またはN値を取得できませんでした',
    })
  }

  const normalized = normalizeGroundModel(project.ground)
  project.ground = normalized.ground
  messages.push(...normalized.messages)
  return { project, messages }
}

export function importLegacyXls(buffer: ArrayBuffer, fileName?: string): LegacyImportResult {
  if (buffer.byteLength > 20 * 1024 * 1024) {
    throw new Error('旧XLSが20 MiBを超えています')
  }
  const workbook = read(buffer, {
    type: 'array',
    sheets: ['メイン'],
    cellFormula: true,
    cellNF: false,
    cellStyles: false,
    cellHTML: false,
    bookVBA: false,
    bookDeps: false,
    bookFiles: false,
  })
  const mainSheet = workbook.Sheets['メイン']
  if (mainSheet?.['!ref']) {
    const range = utils.decode_range(mainSheet['!ref'])
    const rowCount = range.e.r - range.s.r + 1
    const columnCount = range.e.c - range.s.c + 1
    if (rowCount > 10_000 || columnCount > 256 || rowCount * columnCount > 2_000_000) {
      throw new Error('旧XLSの「メイン」シートが許容サイズを超えています')
    }
  }
  return importLegacyWorkbook(workbook, fileName)
}

export function createSyntheticLegacyWorkbook(): WorkBook {
  const rows: unknown[][] = Array.from({ length: 29 }, () =>
    Array.from({ length: 17 }, (): unknown => null),
  )
  rows[2]![1] = '合成テスト案件'
  rows[10]![8] = 1
  for (let index = 0; index < 5; index += 1) {
    rows[12 + index]![0] = index + 1
    rows[12 + index]![2] = index + 2
  }
  rows[13]![7] = 2
  rows[13]![10] = '砂'
  rows[13]![11] = 1.8
  rows[13]![13] = 20
  rows[14]![7] = 5
  rows[14]![10] = '粘土'
  rows[14]![11] = 1.6
  rows[14]![13] = 80
  rows[28]![7] = 5
  rows[28]![10] = '砂礫'
  rows[28]![11] = 2
  rows[28]![16] = 400
  const book = utils.book_new()
  utils.book_append_sheet(book, utils.aoa_to_sheet(rows), 'メイン')
  return book
}
