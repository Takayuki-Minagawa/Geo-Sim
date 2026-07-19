import type {
  AnalysisMessage,
  GeologicAge,
  GroundLayer,
  GroundModel,
  NValue,
  SoilClass,
  ValueSource,
} from '../../domain/types'

/** Public Ohta--Goto coefficient table identified in the MLIT technical advice. */
export const REGULATORY_SOIL_COEFFICIENTS: Readonly<Partial<Record<SoilClass, number>>> = {
  clay: 1,
  silt: 1,
  'fine-sand': 1.086,
  'medium-sand': 1.066,
  'coarse-sand': 1.135,
  'gravelly-sand': 1.153,
  gravel: 1.448,
}

/** Values embedded in the legacy workbook. They are for compatibility checks only. */
export const LEGACY_SHEET_SOIL_COEFFICIENTS: Readonly<
  Partial<Record<SoilClass, number>>
> = {
  clay: 1,
  silt: 1,
  'surface-soil': 1,
  'fine-sand': 1.1,
  'medium-sand': 1.12,
  'coarse-sand': 1.135,
  'gravelly-sand': 1.153,
  gravel: 1.448,
}

export const GEOLOGIC_AGE_COEFFICIENTS: Readonly<
  Partial<Record<GeologicAge, number>>
> = {
  alluvium: 1,
  diluvium: 1.303,
}

export type VsCoefficientTableId = 'regulatory' | 'legacy-sheet'

export interface AverageNResult {
  averageN: number | null
  count: number
  messages: AnalysisMessage[]
}

export interface ResolvedLayerVs {
  layerId: string
  thicknessM: number
  centerDepthM: number
  densityKgM3: number
  vsMps: number | null
  source: 'direct' | 'estimated' | 'unresolved'
  valueSource?: ValueSource
  averageN: number | null
  coefficientTableId: VsCoefficientTableId
  soilCoefficient: number | null
  ageCoefficient: number | null
  messages: AnalysisMessage[]
}

export interface ResolvedGroundVs {
  layers: ResolvedLayerVs[]
  messages: AnalysisMessage[]
}

export interface ElasticPeriodResult {
  periodS: number | null
  totalThicknessM: number
  travelDenominatorM2S: number
  messages: AnalysisMessage[]
}

function warning(code: string, message: string, path?: string): AnalysisMessage {
  return { code, severity: 'warning', message, path }
}

function error(code: string, message: string, path?: string): AnalysisMessage {
  return { code, severity: 'error', message, path }
}

/**
 * Reproduces the workbook's `aveN` boundary convention: top is excluded and
 * bottom is included (`topDepthM < depth <= bottomDepthM`). Invalid samples are
 * ignored with a warning; N=0 remains a valid observation.
 */
export function averageNForInterval(
  nValues: readonly NValue[],
  topDepthM: number,
  bottomDepthM: number,
  path = 'ground.nValues',
): AverageNResult {
  const messages: AnalysisMessage[] = []
  if (!Number.isFinite(topDepthM) || !Number.isFinite(bottomDepthM)) {
    return {
      averageN: null,
      count: 0,
      messages: [error('VS_INTERVAL_NOT_FINITE', 'N値平均区間の深度が有限値ではありません。', path)],
    }
  }
  if (bottomDepthM <= topDepthM) {
    return {
      averageN: null,
      count: 0,
      messages: [error('VS_INTERVAL_INVALID', 'N値平均区間は下端深度を上端深度より深くしてください。', path)],
    }
  }

  let sum = 0
  let count = 0
  for (const [index, sample] of nValues.entries()) {
    if (!(sample.depthM > topDepthM && sample.depthM <= bottomDepthM)) continue
    if (!Number.isFinite(sample.depthM) || !Number.isFinite(sample.n) || sample.n < 0) {
      messages.push(
        warning(
          'VS_N_SAMPLE_INVALID',
          `深度区間内のN値データ${index + 1}を無効値として除外しました。`,
          `${path}[${index}]`,
        ),
      )
      continue
    }
    sum += sample.n
    count += 1
  }

  if (count === 0) {
    messages.push(
      warning(
        'VS_N_DATA_MISSING',
        `深度 ${topDepthM} m超～${bottomDepthM} m以下に有効なN値がありません。`,
        path,
      ),
    )
    return { averageN: null, count, messages }
  }
  return { averageN: sum / count, count, messages }
}

/** Alias retaining the legacy function name while keeping a typed result. */
export const aveN = averageNForInterval

export function soilCoefficient(
  soilClass: SoilClass,
  tableId: VsCoefficientTableId,
): number | null {
  const table =
    tableId === 'regulatory'
      ? REGULATORY_SOIL_COEFFICIENTS
      : LEGACY_SHEET_SOIL_COEFFICIENTS
  return table[soilClass] ?? null
}

/** Ohta--Goto-style empirical Vs estimate. Inputs and output are SI. */
export function estimateVsMps(
  nValue: number,
  centerDepthM: number,
  ageCoefficient: number,
  soilTypeCoefficient: number,
): number {
  if (
    !Number.isFinite(nValue) ||
    !Number.isFinite(centerDepthM) ||
    !Number.isFinite(ageCoefficient) ||
    !Number.isFinite(soilTypeCoefficient) ||
    nValue <= 0 ||
    centerDepthM <= 0 ||
    ageCoefficient <= 0 ||
    soilTypeCoefficient <= 0
  ) {
    throw new RangeError('Vs推定式の入力は正の有限値でなければなりません。')
  }
  return (
    68.79 *
    nValue ** 0.171 *
    centerDepthM ** 0.199 *
    ageCoefficient *
    soilTypeCoefficient
  )
}

export function resolveLayerVs(
  layer: GroundLayer,
  nValues: readonly NValue[],
  tableId: VsCoefficientTableId = 'regulatory',
  layerIndex?: number,
): ResolvedLayerVs {
  const path =
    layerIndex === undefined ? `ground.layers.${layer.id}` : `ground.layers[${layerIndex}]`
  const messages: AnalysisMessage[] = []
  const thicknessM = layer.bottomDepthM - layer.topDepthM
  const centerDepthM = (layer.topDepthM + layer.bottomDepthM) / 2

  if (!Number.isFinite(thicknessM) || thicknessM <= 0) {
    messages.push(error('VS_LAYER_THICKNESS_INVALID', '層厚は正の有限値が必要です。', path))
  }
  if (!Number.isFinite(layer.densityKgM3) || layer.densityKgM3 <= 0) {
    messages.push(error('VS_DENSITY_INVALID', '湿潤密度は正の有限値が必要です。', path))
  }

  // Direct/PS-logging values always take priority over an empirical estimate.
  if (layer.vsMps !== undefined) {
    if (Number.isFinite(layer.vsMps) && layer.vsMps > 0) {
      return {
        layerId: layer.id,
        thicknessM,
        centerDepthM,
        densityKgM3: layer.densityKgM3,
        vsMps: layer.vsMps,
        source: 'direct',
        valueSource: layer.vsSource ?? 'input',
        averageN: layer.nValue ?? null,
        coefficientTableId: tableId,
        soilCoefficient: null,
        ageCoefficient: null,
        messages,
      }
    }
    messages.push(error('VS_DIRECT_INVALID', '直接入力Vsは正の有限値が必要です。', `${path}.vsMps`))
    return {
      layerId: layer.id,
      thicknessM,
      centerDepthM,
      densityKgM3: layer.densityKgM3,
      vsMps: null,
      source: 'unresolved',
      valueSource: layer.vsSource,
      averageN: layer.nValue ?? null,
      coefficientTableId: tableId,
      soilCoefficient: null,
      ageCoefficient: null,
      messages,
    }
  }

  let averageN: number | null
  if (layer.nValue !== undefined) {
    if (Number.isFinite(layer.nValue) && layer.nValue >= 0) {
      averageN = layer.nValue
    } else {
      averageN = null
      messages.push(error('VS_LAYER_N_INVALID', '層N値は0以上の有限値が必要です。', `${path}.nValue`))
    }
  } else {
    const average = averageNForInterval(nValues, layer.topDepthM, layer.bottomDepthM)
    averageN = average.averageN
    messages.push(...average.messages)
  }

  const st = soilCoefficient(layer.soilClass, tableId)
  const yg = GEOLOGIC_AGE_COEFFICIENTS[layer.geologicAge] ?? null
  if (st === null) {
    messages.push(
      error(
        'VS_SOIL_CLASS_UNMAPPED',
        `${tableId}係数表では土質区分「${layer.soilClass}」を一意に対応付けできません。直接Vsまたは明示区分が必要です。`,
        `${path}.soilClass`,
      ),
    )
  }
  if (yg === null) {
    messages.push(
      error(
        'VS_GEOLOGIC_AGE_UNKNOWN',
        '地質年代が不明なためVsを推定できません。',
        `${path}.geologicAge`,
      ),
    )
  }
  if (averageN === 0) {
    messages.push(
      warning(
        'VS_ZERO_N_UNRESOLVED',
        '平均N値が0のため経験式から正のVsを推定できません。直接Vsを入力してください。',
        path,
      ),
    )
  }

  let vsMps: number | null = null
  if (
    averageN !== null &&
    averageN > 0 &&
    st !== null &&
    yg !== null &&
    centerDepthM > 0 &&
    thicknessM > 0
  ) {
    vsMps = estimateVsMps(averageN, centerDepthM, yg, st)
  }

  return {
    layerId: layer.id,
    thicknessM,
    centerDepthM,
    densityKgM3: layer.densityKgM3,
    vsMps,
    source: vsMps === null ? 'unresolved' : 'estimated',
    valueSource: vsMps === null ? undefined : 'estimated',
    averageN,
    coefficientTableId: tableId,
    soilCoefficient: st,
    ageCoefficient: yg,
    messages,
  }
}

export function resolveGroundVs(
  ground: GroundModel,
  tableId: VsCoefficientTableId = 'regulatory',
): ResolvedGroundVs {
  const layers = ground.layers.map((layer, index) =>
    resolveLayerVs(layer, ground.nValues, tableId, index),
  )
  return { layers, messages: layers.flatMap((layer) => layer.messages) }
}

/**
 * Elastic ground period using the quarter-wavelength travel-time expression:
 * Tg = 4 H^2 / sum(Vs_i H_i).
 */
export function calculateElasticGroundPeriod(
  layers: readonly Pick<ResolvedLayerVs, 'layerId' | 'thicknessM' | 'vsMps'>[],
): ElasticPeriodResult {
  const messages: AnalysisMessage[] = []
  let totalThicknessM = 0
  let travelDenominatorM2S = 0

  for (const [index, layer] of layers.entries()) {
    if (!Number.isFinite(layer.thicknessM) || layer.thicknessM <= 0) {
      messages.push(
        error(
          'TG_LAYER_THICKNESS_INVALID',
          `層「${layer.layerId}」の層厚が不正です。`,
          `layers[${index}].thicknessM`,
        ),
      )
      continue
    }
    if (layer.vsMps === null || !Number.isFinite(layer.vsMps) || layer.vsMps <= 0) {
      messages.push(
        error(
          'TG_VS_UNRESOLVED',
          `層「${layer.layerId}」のVsが未確定です。`,
          `layers[${index}].vsMps`,
        ),
      )
      continue
    }
    totalThicknessM += layer.thicknessM
    travelDenominatorM2S += layer.vsMps * layer.thicknessM
  }

  if (messages.some((message) => message.severity === 'error') || totalThicknessM <= 0) {
    return { periodS: null, totalThicknessM, travelDenominatorM2S, messages }
  }
  return {
    periodS: (4 * totalThicknessM ** 2) / travelDenominatorM2S,
    totalThicknessM,
    travelDenominatorM2S,
    messages,
  }
}
