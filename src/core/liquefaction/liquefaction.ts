import type {
  AnalysisMessage,
  GroundLayer,
  GroundModel,
  LiquefactionCaseResult,
  LiquefactionCaseSettings,
  LiquefactionLayerResult,
  Severity,
} from '../../domain/types'
import { ganmacy, nf } from './legacyTables'
import { calculateOverburdenAtDepth } from './overburden'

export const LEGACY_GRAVITY_GAL = 980
export const PL_MAX_DEPTH_M = 20

export const DEFAULT_LIQUEFACTION_CASES: readonly LiquefactionCaseSettings[] = [
  { id: 'damage-150gal', peakAccelerationGal: 150, magnitude: 7 },
  { id: 'safety-350gal', peakAccelerationGal: 350, magnitude: 7.5 },
] as const

interface NormalizedSegment {
  sourceLayer: GroundLayer
  sourceLayerIndex: number
  resultLayerId: string
  topDepthM: number
  bottomDepthM: number
  nValue: number | undefined
}

interface EligibilityReason {
  code: string
  severity: Severity
  message: string
}

const EXCLUDED_SOIL_CLASSES = new Set<GroundLayer['soilClass']>([
  'gravelly-sand',
  'gravel',
  'rock',
])

/** `Na = N * sqrt(10 / σ'z) + ΔNf`, with σ'z in tf/m2. */
export function correctedNValue(
  nValue: number,
  effectiveStressTfM2: number,
  finesPercent: number,
): number {
  assertFiniteNonNegative(nValue, 'N値')
  if (!Number.isFinite(effectiveStressTfM2) || effectiveStressTfM2 <= 0) {
    throw new RangeError('有効上載圧は0より大きい有限値である必要があります')
  }
  return nValue * Math.sqrt(10 / effectiveStressTfM2) + nf(finesPercent)
}

/** 5% liquefaction-resistance curve used by the legacy workbook. */
export function liquefactionResistanceRatio(correctedN: number): number {
  assertFiniteNonNegative(correctedN, '補正N値 Na')
  if (correctedN >= 25) return 1
  return 0.045 + 0.0085 * correctedN + 1.7 ** (correctedN - 12) / 5000
}

/**
 * Earthquake-induced cyclic shear-stress ratio from the legacy workbook.
 * `totalStressTfM2` and `effectiveStressTfM2` must use the same units.
 */
export function liquefactionDemandRatio(
  settings: LiquefactionCaseSettings,
  depthM: number,
  totalStressTfM2: number,
  effectiveStressTfM2: number,
): number {
  assertFiniteNonNegative(depthM, '評価深さ')
  assertFiniteNonNegative(settings.peakAccelerationGal, '最大加速度')
  assertFiniteNonNegative(settings.magnitude, 'マグニチュード')
  assertFiniteNonNegative(totalStressTfM2, '全上載圧')
  if (!Number.isFinite(effectiveStressTfM2) || effectiveStressTfM2 <= 0) {
    throw new RangeError('有効上載圧は0より大きい有限値である必要があります')
  }

  const depthReduction = 1 - 0.015 * depthM
  const demand =
    0.1 *
    (settings.magnitude - 1) *
    (settings.peakAccelerationGal / LEGACY_GRAVITY_GAL) *
    (totalStressTfM2 / effectiveStressTfM2) *
    depthReduction

  if (!Number.isFinite(demand) || demand <= 0) {
    throw new RangeError('地震時せん断応力比が0より大きい有限値になりません')
  }
  return demand
}

export function classifyDcy(dcyCm: number): string {
  assertFiniteNonNegative(dcyCm, 'Dcy')
  if (dcyCm === 0) return 'なし'
  if (dcyCm <= 5) return '軽微'
  if (dcyCm <= 10) return '小'
  if (dcyCm <= 20) return '中'
  if (dcyCm <= 40) return '大'
  return '甚大'
}

export function classifyPl(pl: number): string {
  assertFiniteNonNegative(pl, 'PL')
  if (pl === 0) return '被害発生の可能性なし'
  if (pl <= 5) return '可能性が低い'
  if (pl <= 15) return '可能性がある'
  return '可能性が高い'
}

/** PL depth weight `W(z) = 10 - 0.5z`; it is zero at and below 20 m. */
export function plDepthWeight(centerDepthM: number): number {
  assertFiniteNonNegative(centerDepthM, '層中心深さ')
  return Math.max(0, 10 - 0.5 * centerDepthM)
}

/**
 * Splits source layers at groundwater, improvement depth and the 20 m PL limit.
 * Segment properties and a layer-level N value are inherited from the source
 * layer. This lets Dcy and PL use exactly the same calculation rows.
 */
export function normalizeLiquefactionSegments(ground: GroundModel): ReadonlyArray<{
  layerId: string
  sourceLayerId: string
  topDepthM: number
  bottomDepthM: number
}> {
  return createNormalizedSegments(ground).map((segment) => ({
    layerId: segment.resultLayerId,
    sourceLayerId: segment.sourceLayer.id,
    topDepthM: segment.topDepthM,
    bottomDepthM: segment.bottomDepthM,
  }))
}

export function calculateLiquefactionCase(
  ground: GroundModel,
  settings: LiquefactionCaseSettings,
): LiquefactionCaseResult {
  const messages: AnalysisMessage[] = [
    {
      code: 'LIQUEFACTION_LEGACY_SCREENING_METHOD',
      severity: 'warning',
      message:
        '旧シート由来のスクリーニング式です。適用基準・係数表の版は専門家確認が必要です。',
    },
  ]

  let segments: NormalizedSegment[]
  try {
    segments = createNormalizedSegments(ground)
  } catch (error) {
    messages.push({
      code: 'LIQUEFACTION_INVALID_LAYER_MODEL',
      severity: 'error',
      message: error instanceof Error ? error.message : '地盤層モデルが不正です',
      path: 'ground.layers',
    })
    return emptyCaseResult(settings, messages)
  }

  if (segments.length === 0) {
    messages.push({
      code: 'LIQUEFACTION_NO_LAYERS',
      severity: 'error',
      message: '液状化を評価できる地盤層がありません。',
      path: 'ground.layers',
    })
    return emptyCaseResult(settings, messages)
  }

  const layerResults = segments.map((segment) =>
    calculateSegment(ground, settings, segment, messages),
  )
  const dcyCm = sum(layerResults.map(({ dcyContributionCm }) => dcyContributionCm))
  const pl = sum(layerResults.map(({ plContribution }) => plContribution))

  if (dcyCm > 0) {
    messages.push({
      code: 'LIQUEFACTION_GS_REVIEW_REQUIRED',
      severity: 'warning',
      message:
        '液状化による変形がGs計算の前提に支障しないか、設計者による別途検討が必要です。',
    })
  }

  return {
    caseId: settings.id,
    peakAccelerationGal: settings.peakAccelerationGal,
    magnitude: settings.magnitude,
    dcyCm,
    dcyClass: classifyDcy(dcyCm),
    pl,
    plClass: classifyPl(pl),
    layers: layerResults,
    messages,
  }
}

export function calculateLiquefactionCases(
  ground: GroundModel,
  cases: readonly LiquefactionCaseSettings[] = DEFAULT_LIQUEFACTION_CASES,
): LiquefactionCaseResult[] {
  return cases.map((settings) => calculateLiquefactionCase(ground, settings))
}

export const calculateLiquefaction = calculateLiquefactionCases

function calculateSegment(
  ground: GroundModel,
  settings: LiquefactionCaseSettings,
  segment: NormalizedSegment,
  messages: AnalysisMessage[],
): LiquefactionLayerResult {
  const thicknessM = segment.bottomDepthM - segment.topDepthM
  const centerDepthM = segment.topDepthM + thicknessM / 2
  const reasons = assessEligibility(ground, segment)
  const path = `ground.layers[${segment.sourceLayerIndex}]`

  if (reasons.length > 0) {
    for (const reason of reasons) {
      messages.push({
        code: reason.code,
        severity: reason.severity,
        message: `${formatInterval(segment)}: ${reason.message}`,
        path,
      })
    }
    return createLayerResult(segment, centerDepthM, {
      eligible: false,
      n: segment.nValue ?? 0,
      reason: reasons.map(({ message }) => message).join(' / '),
    })
  }

  let demandRatio: number
  let correctedN: number
  let resistanceRatio: number
  let fl: number
  try {
    const stress = calculateOverburdenAtDepth(
      ground.layers,
      ground.groundwaterDepthM,
      segment.bottomDepthM,
    )
    demandRatio = liquefactionDemandRatio(
      settings,
      segment.bottomDepthM,
      stress.totalStressTfM2,
      stress.effectiveStressTfM2,
    )
    correctedN = correctedNValue(
      segment.nValue as number,
      stress.effectiveStressTfM2,
      segment.sourceLayer.finesPercent as number,
    )
    resistanceRatio = liquefactionResistanceRatio(correctedN)
    fl = resistanceRatio / demandRatio
  } catch (error) {
    const reason = error instanceof Error ? error.message : '応力またはFLを計算できません'
    messages.push({
      code: 'LIQUEFACTION_STRESS_CALCULATION_FAILED',
      severity: 'error',
      message: `${formatInterval(segment)}: ${reason}`,
      path,
    })
    return createLayerResult(segment, centerDepthM, {
      eligible: false,
      n: segment.nValue ?? 0,
      reason,
    })
  }

  const cyclicStrainPercent = fl < 1 ? ganmacy(correctedN, demandRatio) : 0
  const dcyContributionCm = cyclicStrainPercent * thicknessM
  const plContribution =
    segment.topDepthM < PL_MAX_DEPTH_M && fl < 1
      ? (1 - fl) * plDepthWeight(centerDepthM) * thicknessM
      : 0
  const reason =
    '対象（地下水位以深、FC≤35%、N≤15、非礫質・非岩盤、地盤改良範囲外）'

  messages.push({
    code: 'LIQUEFACTION_LAYER_ELIGIBLE',
    severity: 'info',
    message: `${formatInterval(segment)}: ${reason}`,
    path,
  })

  return {
    layerId: segment.resultLayerId,
    topDepthM: segment.topDepthM,
    bottomDepthM: segment.bottomDepthM,
    centerDepthM,
    eligible: true,
    n: segment.nValue as number,
    correctedN,
    demandRatio,
    resistanceRatio,
    fl,
    cyclicStrainPercent,
    dcyContributionCm,
    plContribution,
    reason,
  }
}

function assessEligibility(
  ground: GroundModel,
  segment: NormalizedSegment,
): EligibilityReason[] {
  const reasons: EligibilityReason[] = []
  const layer = segment.sourceLayer

  if (segment.bottomDepthM <= ground.groundwaterDepthM) {
    reasons.push({
      code: 'LIQUEFACTION_ABOVE_GROUNDWATER',
      severity: 'info',
      message: `地下水位 GL-${ground.groundwaterDepthM}m より上の区間です`,
    })
  }
  if (EXCLUDED_SOIL_CLASSES.has(layer.soilClass)) {
    reasons.push({
      code: 'LIQUEFACTION_EXCLUDED_SOIL',
      severity: 'info',
      message: `対象外土質です（${layer.soilName || layer.soilClass}）`,
    })
  }
  if (layer.finesPercent === undefined || !Number.isFinite(layer.finesPercent)) {
    reasons.push({
      code: 'LIQUEFACTION_FINES_MISSING',
      severity: 'warning',
      message: '細粒土含有率 FC が未入力です',
    })
  } else if (layer.finesPercent < 0 || layer.finesPercent > 100) {
    reasons.push({
      code: 'LIQUEFACTION_FINES_INVALID',
      severity: 'error',
      message: `細粒土含有率 FC=${layer.finesPercent}% が0〜100% の範囲外です`,
    })
  } else if (layer.finesPercent > 35) {
    reasons.push({
      code: 'LIQUEFACTION_FINES_OVER_LIMIT',
      severity: 'info',
      message: `細粒土含有率 FC=${layer.finesPercent}% が35% を超えます`,
    })
  }
  if (segment.nValue === undefined) {
    reasons.push({
      code: 'LIQUEFACTION_N_VALUE_MISSING',
      severity: 'warning',
      message: 'N値が未入力で、層内に利用できるN値データもありません',
    })
  } else if (segment.nValue < 0) {
    reasons.push({
      code: 'LIQUEFACTION_N_VALUE_INVALID',
      severity: 'error',
      message: `N=${segment.nValue} は0以上である必要があります`,
    })
  } else if (segment.nValue > 15) {
    reasons.push({
      code: 'LIQUEFACTION_N_VALUE_OVER_LIMIT',
      severity: 'info',
      message: `N=${segment.nValue} が15を超えます`,
    })
  }
  if (layer.improved) {
    reasons.push({
      code: 'LIQUEFACTION_IMPROVED_LAYER',
      severity: 'info',
      message: '地盤改良層として指定されています',
    })
  }
  if (
    ground.improvementDepthM !== undefined &&
    ground.improvementDepthM > 0 &&
    segment.bottomDepthM <= ground.improvementDepthM
  ) {
    reasons.push({
      code: 'LIQUEFACTION_WITHIN_IMPROVEMENT_DEPTH',
      severity: 'info',
      message: `地盤補強・改良深さ GL-${ground.improvementDepthM}m 以浅の区間です`,
    })
  }
  return reasons
}

function createNormalizedSegments(ground: GroundModel): NormalizedSegment[] {
  assertFiniteNonNegative(ground.groundwaterDepthM, '地下水位深さ')
  if (ground.improvementDepthM !== undefined) {
    assertFiniteNonNegative(ground.improvementDepthM, '地盤改良深さ')
  }

  const indexed = ground.layers
    .map((layer, sourceLayerIndex) => ({ layer, sourceLayerIndex }))
    .sort((left, right) => left.layer.topDepthM - right.layer.topDepthM)
  validateLayerSequence(indexed.map(({ layer }) => layer))

  return indexed.flatMap(({ layer, sourceLayerIndex }) => {
    const boundaries = [layer.topDepthM, layer.bottomDepthM]
    for (const boundary of [
      ground.groundwaterDepthM,
      ground.improvementDepthM,
      PL_MAX_DEPTH_M,
    ]) {
      if (
        boundary !== undefined &&
        boundary > layer.topDepthM &&
        boundary < layer.bottomDepthM
      ) {
        boundaries.push(boundary)
      }
    }
    boundaries.sort((left, right) => left - right)
    const nValue = resolveLayerNValue(layer, ground)
    const wasSplit = boundaries.length > 2

    return boundaries.slice(0, -1).map((topDepthM, index) => {
      const bottomDepthM = boundaries[index + 1]!
      return {
        sourceLayer: layer,
        sourceLayerIndex,
        resultLayerId: wasSplit
          ? `${layer.id}@${formatDepth(topDepthM)}-${formatDepth(bottomDepthM)}m`
          : layer.id,
        topDepthM,
        bottomDepthM,
        nValue,
      }
    })
  })
}

function resolveLayerNValue(layer: GroundLayer, ground: GroundModel): number | undefined {
  if (layer.nValue !== undefined && Number.isFinite(layer.nValue)) return layer.nValue

  const values = ground.nValues.filter(
    ({ depthM, n }) =>
      Number.isFinite(depthM) &&
      Number.isFinite(n) &&
      layer.topDepthM < depthM &&
      depthM <= layer.bottomDepthM,
  )
  if (values.length === 0) return undefined
  return sum(values.map(({ n }) => n)) / values.length
}

function validateLayerSequence(layers: readonly GroundLayer[]): void {
  const tolerance = 1e-9
  let previousBottom: number | undefined

  for (const layer of layers) {
    assertFiniteNonNegative(layer.topDepthM, `層 ${layer.id} の上端深さ`)
    assertFiniteNonNegative(layer.bottomDepthM, `層 ${layer.id} の下端深さ`)
    if (layer.bottomDepthM <= layer.topDepthM) {
      throw new RangeError(`層 ${layer.id} の層厚が0以下です`)
    }
    if (!Number.isFinite(layer.densityKgM3) || layer.densityKgM3 <= 0) {
      throw new RangeError(`層 ${layer.id} の密度が0より大きい有限値ではありません`)
    }
    if (previousBottom === undefined && Math.abs(layer.topDepthM) > tolerance) {
      throw new RangeError(`最上層 ${layer.id} が GL-0m から始まっていません`)
    }
    if (previousBottom !== undefined) {
      if (layer.topDepthM < previousBottom - tolerance) {
        throw new RangeError(`層 ${layer.id} が先行層と重複しています`)
      }
      if (layer.topDepthM > previousBottom + tolerance) {
        throw new RangeError(
          `GL-${formatDepth(previousBottom)}m から GL-${formatDepth(layer.topDepthM)}m の間に未定義区間があります`,
        )
      }
    }
    previousBottom = layer.bottomDepthM
  }
}

function createLayerResult(
  segment: NormalizedSegment,
  centerDepthM: number,
  partial: Pick<LiquefactionLayerResult, 'eligible' | 'n'> & { reason: string },
): LiquefactionLayerResult {
  return {
    layerId: segment.resultLayerId,
    topDepthM: segment.topDepthM,
    bottomDepthM: segment.bottomDepthM,
    centerDepthM,
    eligible: partial.eligible,
    n: partial.n,
    correctedN: 0,
    demandRatio: 0,
    resistanceRatio: 0,
    fl: 0,
    cyclicStrainPercent: 0,
    dcyContributionCm: 0,
    plContribution: 0,
    reason: partial.reason,
  }
}

function emptyCaseResult(
  settings: LiquefactionCaseSettings,
  messages: AnalysisMessage[],
): LiquefactionCaseResult {
  return {
    caseId: settings.id,
    peakAccelerationGal: settings.peakAccelerationGal,
    magnitude: settings.magnitude,
    dcyCm: 0,
    dcyClass: classifyDcy(0),
    pl: 0,
    plClass: classifyPl(0),
    layers: [],
    messages,
  }
}

function formatInterval(segment: NormalizedSegment): string {
  return `${segment.sourceLayer.id} (GL-${formatDepth(segment.topDepthM)}〜${formatDepth(segment.bottomDepthM)}m)`
}

function formatDepth(value: number): string {
  return Number(value.toFixed(6)).toString()
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label}は0以上の有限値である必要があります`)
  }
}
