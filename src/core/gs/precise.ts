import type {
  AnalysisMessage,
  ApplicabilityCheck,
  GroundModel,
  GsIteration,
  GsResult,
  GsSettings,
  ModulusReductionPoint,
} from '../../domain/types'
import { solveGeneralizedSymmetricEigen } from '../eigen'
import {
  calculateElasticGroundPeriod,
  resolveGroundVs,
  type ResolvedLayerVs,
  type VsCoefficientTableId,
} from '../vs'
import {
  buildSurfaceSpectrum,
  calculateSurfaceSpectrumPoint,
  createPeriodGrid,
  type SpectrumLimit,
} from './spectrum'

export interface CurveInterpolationResult {
  modulusRatio: number
  dampingRatio: number
  range: 'inside' | 'below' | 'above'
}

export interface ShearColumnLayer {
  layerId: string
  thicknessM: number
  densityKgM3: number
  shearModulusPa: number
}

export interface ShearColumnMatrices {
  /** DOF order is engineering bedrock upward to the surface. */
  diagonalMassKgM2: number[]
  stiffnessNM3: number[][]
}

export interface PreciseGsOptions {
  periodsS?: readonly number[]
  coefficientTableId?: VsCoefficientTableId
}

export interface PreciseCurveParameters {
  t1S: number
  t2S: number
  gs1: number
  gs2: number
}

interface DynamicLayer {
  id: string
  thicknessM: number
  densityKgM3: number
  g0Pa: number
}

export interface DynamicLayerState {
  strain: number
  modulusRatio: number
  dampingRatio: number
}

interface ComputedMetrics extends PreciseCurveParameters {
  alpha: number
  dampingRatio: number
  effectiveVsMps: number[]
  shearModulusPa: number[]
  modeDifferencesTopDown: number[]
  strains: number[]
}

export interface IterationEngineOptions {
  layers: readonly DynamicLayer[]
  initialStates: readonly DynamicLayerState[]
  bedrockDensityKgM3: number
  bedrockVsMps: number
  regionFactorZ: number
  effectiveStrainFactor: number
  relativeTolerance: number
  absoluteTolerance: number
  maxIterations: number
  level: SpectrumLimit
  dampingScale: number
  gsAtPeriod: (periodS: number, parameters: PreciseCurveParameters) => number
  updateState: (
    layerIndex: number,
    effectiveStrain: number,
  ) => { state: DynamicLayerState; messages?: AnalysisMessage[] }
}

export interface IterationEngineResult {
  converged: boolean
  metrics: ComputedMetrics
  states: DynamicLayerState[]
  iterations: GsIteration[]
  messages: AnalysisMessage[]
}

function analysisMessage(
  code: string,
  severity: AnalysisMessage['severity'],
  message: string,
  path?: string,
): AnalysisMessage {
  return { code, severity, message, path }
}

function uniqueMessages(messages: readonly AnalysisMessage[]): AnalysisMessage[] {
  const keys = new Set<string>()
  return messages.filter((message) => {
    const key = `${message.code}|${message.severity}|${message.path ?? ''}|${message.message}`
    if (keys.has(key)) return false
    keys.add(key)
    return true
  })
}

function validateCurve(curve: readonly ModulusReductionPoint[]): void {
  if (curve.length === 0) throw new RangeError('nonlinear property curve must not be empty')
  let previousStrain = -Infinity
  for (const point of curve) {
    if (
      !Number.isFinite(point.strain) ||
      !Number.isFinite(point.modulusRatio) ||
      !Number.isFinite(point.dampingRatio) ||
      point.strain <= 0 ||
      point.strain <= previousStrain ||
      point.modulusRatio <= 0 ||
      point.modulusRatio > 1.000001 ||
      point.dampingRatio < 0 ||
      point.dampingRatio >= 1
    ) {
      throw new RangeError(
        'curve strains must be strictly increasing and properties must be physical ratios',
      )
    }
    previousStrain = point.strain
  }
}

/** Log-strain interpolation with endpoint clamping and an explicit range flag. */
export function interpolateModulusCurve(
  curve: readonly ModulusReductionPoint[],
  strain: number,
): CurveInterpolationResult {
  validateCurve(curve)
  if (!Number.isFinite(strain) || strain < 0) throw new RangeError('strain must be finite and non-negative')
  const first = curve[0]!
  const last = curve[curve.length - 1]!
  if (strain <= first.strain) {
    return {
      modulusRatio: first.modulusRatio,
      dampingRatio: first.dampingRatio,
      range: strain < first.strain ? 'below' : 'inside',
    }
  }
  if (strain >= last.strain) {
    return {
      modulusRatio: last.modulusRatio,
      dampingRatio: last.dampingRatio,
      range: strain > last.strain ? 'above' : 'inside',
    }
  }
  for (let index = 1; index < curve.length; index += 1) {
    const right = curve[index]!
    if (strain > right.strain) continue
    const left = curve[index - 1]!
    const fraction =
      (Math.log(strain) - Math.log(left.strain)) /
      (Math.log(right.strain) - Math.log(left.strain))
    return {
      modulusRatio: left.modulusRatio + fraction * (right.modulusRatio - left.modulusRatio),
      dampingRatio: left.dampingRatio + fraction * (right.dampingRatio - left.dampingRatio),
      range: 'inside',
    }
  }
  throw new Error('unreachable curve interpolation branch')
}

/** Build a fixed-base, lumped-mass shear column in bottom-to-top DOF order. */
export function buildShearColumnMatrices(
  topDownLayers: readonly ShearColumnLayer[],
): ShearColumnMatrices {
  if (topDownLayers.length === 0) throw new RangeError('at least one layer is required')
  const bottomUp = [...topDownLayers].reverse()
  const diagonalMassKgM2 = bottomUp.map((layer) => {
    if (
      !Number.isFinite(layer.thicknessM) ||
      !Number.isFinite(layer.densityKgM3) ||
      !Number.isFinite(layer.shearModulusPa) ||
      layer.thicknessM <= 0 ||
      layer.densityKgM3 <= 0 ||
      layer.shearModulusPa <= 0
    ) {
      throw new RangeError(`invalid dynamic properties for layer ${layer.layerId}`)
    }
    return layer.densityKgM3 * layer.thicknessM
  })
  const springStiffness = bottomUp.map(
    (layer) => layer.shearModulusPa / layer.thicknessM,
  )
  const size = bottomUp.length
  const stiffnessNM3 = Array.from({ length: size }, () => Array<number>(size).fill(0))
  for (let spring = 0; spring < size; spring += 1) {
    const stiffness = springStiffness[spring]!
    stiffnessNM3[spring]![spring] = stiffnessNM3[spring]![spring]! + stiffness
    if (spring > 0) {
      stiffnessNM3[spring - 1]![spring - 1] =
        stiffnessNM3[spring - 1]![spring - 1]! + stiffness
      stiffnessNM3[spring]![spring - 1] = stiffnessNM3[spring]![spring - 1]! - stiffness
      stiffnessNM3[spring - 1]![spring] = stiffnessNM3[spring - 1]![spring]! - stiffness
    }
  }
  return { diagonalMassKgM2, stiffnessNM3 }
}

/** Four-branch precise Gs curve with the current pre-interaction lower bound. */
export function evaluatePreciseGs(
  periodS: number,
  parameters: PreciseCurveParameters,
  minimumGs = 1.23,
): number {
  if (!Number.isFinite(periodS) || periodS < 0) throw new RangeError('periodS is invalid')
  const { t1S, t2S, gs1, gs2 } = parameters
  if (
    ![t1S, t2S, gs1, gs2, minimumGs].every(Number.isFinite) ||
    t1S <= 0 ||
    t2S <= 0 ||
    t2S >= t1S ||
    gs1 <= 0 ||
    gs2 <= 0 ||
    minimumGs < 0
  ) {
    throw new RangeError('precise Gs parameters are invalid')
  }

  let rawGs: number
  if (periodS <= 0.8 * t2S) {
    rawGs = (gs2 * periodS) / (0.8 * t2S)
  } else if (periodS <= 0.8 * t1S) {
    rawGs = gs2 + ((gs1 - gs2) * (periodS - 0.8 * t2S)) / (0.8 * (t1S - t2S))
  } else if (periodS <= 1.2 * t1S) {
    rawGs = gs1
  } else {
    const denominator = 1 / (1.2 * t1S) - 0.1
    if (Math.abs(denominator) < 1e-12) {
      throw new RangeError('the precise Gs tail is singular for this T1')
    }
    const coefficientA = (gs1 - 1) / denominator
    rawGs = coefficientA / periodS + gs1 - coefficientA / (1.2 * t1S)
  }
  if (!Number.isFinite(rawGs)) throw new Error('precise Gs evaluation produced a non-finite value')
  return Math.max(minimumGs, rawGs)
}

function calculateMetrics(
  options: IterationEngineOptions,
  states: readonly DynamicLayerState[],
): ComputedMetrics {
  if (states.length !== options.layers.length) throw new RangeError('dynamic state size mismatch')
  const shearModulusPa = options.layers.map((layer, index) => {
    const state = states[index]!
    if (
      !Number.isFinite(state.modulusRatio) ||
      !Number.isFinite(state.dampingRatio) ||
      state.modulusRatio <= 0 ||
      state.modulusRatio > 1.000001 ||
      state.dampingRatio < 0 ||
      state.dampingRatio >= 1
    ) {
      throw new RangeError(`invalid nonlinear state for layer ${layer.id}`)
    }
    return layer.g0Pa * state.modulusRatio
  })
  const effectiveVsMps = options.layers.map((layer, index) =>
    Math.sqrt(shearModulusPa[index]! / layer.densityKgM3),
  )
  const totalThicknessM = options.layers.reduce((sum, layer) => sum + layer.thicknessM, 0)
  const velocityThicknessSum = options.layers.reduce(
    (sum, layer, index) => sum + effectiveVsMps[index]! * layer.thicknessM,
    0,
  )
  const densityThicknessSum = options.layers.reduce(
    (sum, layer) => sum + layer.densityKgM3 * layer.thicknessM,
    0,
  )
  const t1S = (4 * totalThicknessM ** 2) / velocityThicknessSum
  const t2S = t1S / 3
  const alpha =
    (velocityThicknessSum * densityThicknessSum) /
    (totalThicknessM ** 2 * options.bedrockDensityKgM3 * options.bedrockVsMps)

  const matrices = buildShearColumnMatrices(
    options.layers.map((layer, index) => ({
      layerId: layer.id,
      thicknessM: layer.thicknessM,
      densityKgM3: layer.densityKgM3,
      shearModulusPa: shearModulusPa[index]!,
    })),
  )
  const modes = solveGeneralizedSymmetricEigen(
    matrices.stiffnessNM3,
    matrices.diagonalMassKgM2,
  )
  if (!modes.converged) throw new Error('symmetric eigenvalue solver did not converge')
  const firstModeBottomUp = modes.modes[0]!
  const surfaceAmplitude = firstModeBottomUp[firstModeBottomUp.length - 1]!
  if (Math.abs(surfaceAmplitude) < 1e-14) throw new Error('first mode has zero surface amplitude')
  const normalizedBottomUp = firstModeBottomUp.map((value) => value / surfaceAmplitude)
  const modeDifferencesTopDown = options.layers.map((_layer, topDownIndex) => {
    const topNodeBottomUpIndex = options.layers.length - 1 - topDownIndex
    const topDisplacement = normalizedBottomUp[topNodeBottomUpIndex]!
    const bottomDisplacement =
      topNodeBottomUpIndex === 0 ? 0 : normalizedBottomUp[topNodeBottomUpIndex - 1]!
    return topDisplacement - bottomDisplacement
  })
  const energyWeights = options.layers.map(
    (layer, index) =>
      (shearModulusPa[index]! * modeDifferencesTopDown[index]! ** 2) /
      (2 * layer.thicknessM),
  )
  const totalEnergy = energyWeights.reduce((sum, value) => sum + value, 0)
  if (!(totalEnergy > 0) || !Number.isFinite(totalEnergy)) {
    throw new Error('modal strain energy is not positive')
  }
  const weightedDamping = states.reduce(
    (sum, state, index) => sum + state.dampingRatio * energyWeights[index]!,
    0,
  )
  const dampingRatio = Math.max(0.05, options.dampingScale * (weightedDamping / totalEnergy))
  const gs1 = 1 / (alpha + 1.57 * dampingRatio)
  const gs2 = 1 / (alpha + 4.71 * dampingRatio)
  const parameters = { t1S, t2S, gs1, gs2 }
  const demandGs = options.gsAtPeriod(t1S, parameters)
  const surfaceSdM = calculateSurfaceSpectrumPoint(
    t1S,
    demandGs,
    options.regionFactorZ,
    options.level,
  ).sdM
  const strains = options.layers.map(
    (layer, index) =>
      (options.effectiveStrainFactor *
        Math.abs(surfaceSdM * modeDifferencesTopDown[index]!)) /
      layer.thicknessM,
  )

  const allValues = [
    t1S,
    t2S,
    alpha,
    dampingRatio,
    gs1,
    gs2,
    ...effectiveVsMps,
    ...strains,
  ]
  if (!allValues.every(Number.isFinite)) throw new Error('nonlinear calculation produced NaN/Infinity')
  return {
    ...parameters,
    alpha,
    dampingRatio,
    effectiveVsMps,
    shearModulusPa,
    modeDifferencesTopDown,
    strains,
  }
}

/** Shared deterministic nonlinear engine used by current and legacy policies. */
export function runNonlinearGsIteration(
  options: IterationEngineOptions,
): IterationEngineResult {
  if (
    options.layers.length === 0 ||
    options.initialStates.length !== options.layers.length ||
    !Number.isFinite(options.bedrockDensityKgM3) ||
    !Number.isFinite(options.bedrockVsMps) ||
    options.bedrockDensityKgM3 <= 0 ||
    options.bedrockVsMps <= 0 ||
    !Number.isFinite(options.regionFactorZ) ||
    options.regionFactorZ <= 0 ||
    !Number.isFinite(options.effectiveStrainFactor) ||
    options.effectiveStrainFactor <= 0 ||
    !Number.isFinite(options.relativeTolerance) ||
    options.relativeTolerance < 0 ||
    !Number.isFinite(options.absoluteTolerance) ||
    options.absoluteTolerance < 0 ||
    !Number.isInteger(options.maxIterations) ||
    options.maxIterations < 1 ||
    !Number.isFinite(options.dampingScale) ||
    options.dampingScale <= 0
  ) {
    throw new RangeError('invalid nonlinear iteration settings')
  }

  let states = options.initialStates.map((state) => ({ ...state }))
  let metrics = calculateMetrics(options, states)
  const iterations: GsIteration[] = []
  const messages: AnalysisMessage[] = []
  let converged = false

  for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
    const nextStates = metrics.strains.map((strain, layerIndex) => {
      const updated = options.updateState(layerIndex, strain)
      if (updated.messages) messages.push(...updated.messages)
      return updated.state
    })
    const nextMetrics = calculateMetrics(options, nextStates)
    const absoluteChange = Math.abs(nextMetrics.t1S - metrics.t1S)
    const relativeChange = absoluteChange / Math.max(Math.abs(metrics.t1S), 1e-15)
    iterations.push({
      iteration,
      periodS: nextMetrics.t1S,
      relativeChange,
      layers: nextStates.map((state, index) => ({
        layerId: options.layers[index]!.id,
        strain: state.strain,
        modulusRatio: state.modulusRatio,
        dampingRatio: state.dampingRatio,
      })),
    })
    states = nextStates
    metrics = nextMetrics
    if (
      absoluteChange <=
      options.absoluteTolerance + options.relativeTolerance * Math.abs(metrics.t1S)
    ) {
      converged = true
      break
    }
  }

  if (!converged) {
    messages.push(
      analysisMessage(
        'GS_NON_CONVERGENCE',
        'error',
        `非線形反復が上限${options.maxIterations}回までに収束しませんでした。`,
        'analysisSettings.gs.maxIterations',
      ),
    )
  }
  return { converged, metrics, states, iterations, messages: uniqueMessages(messages) }
}

export function assessPreciseGsApplicability(ground: GroundModel): ApplicabilityCheck[] {
  const totalThicknessM = ground.layers.reduce(
    (sum, layer) => sum + Math.max(0, layer.bottomDepthM - layer.topDepthM),
    0,
  )
  const bedrock = ground.engineeringBedrock
  const curvesAvailable = ground.layers.every(
    (layer) => layer.modulusCurve !== undefined && layer.modulusCurve.length > 0,
  )
  return [
    {
      id: 'engineering-bedrock-vs',
      label: '工学的基盤Vsがおおむね400 m/s以上',
      status: bedrock.vsMps >= 400 ? 'pass' : 'fail',
      detail: `入力Vs=${bedrock.vsMps} m/s`,
    },
    {
      id: 'engineering-bedrock-thickness',
      label: '工学的基盤の必要層厚',
      status:
        bedrock.thicknessM === undefined
          ? 'not-assessed'
          : bedrock.thicknessM >= 5
            ? 'pass'
            : 'fail',
      detail:
        bedrock.thicknessM === undefined
          ? '層厚資料が未入力です。'
          : `確認層厚=${bedrock.thicknessM} m（アプリの一次スクリーニング値5 m）`,
    },
    {
      id: 'bedrock-uniformity-radius',
      label: '基盤深度の一様性を確認する調査範囲',
      status:
        bedrock.investigationRadiusM === undefined
          ? 'not-assessed'
          : bedrock.investigationRadiusM >= 5 * totalThicknessM
            ? 'pass'
            : 'fail',
      detail:
        bedrock.investigationRadiusM === undefined
          ? `表層厚約5倍（${(5 * totalThicknessM).toFixed(1)} m）の確認範囲が未入力です。`
          : `確認範囲=${bedrock.investigationRadiusM} m、表層厚5倍=${(5 * totalThicknessM).toFixed(1)} m`,
    },
    {
      id: 'bedrock-inclination',
      label: '工学的基盤の傾斜',
      status:
        bedrock.inclinationDeg === undefined
          ? 'not-assessed'
          : Math.abs(bedrock.inclinationDeg) <= 5
            ? 'pass'
            : 'fail',
      detail:
        bedrock.inclinationDeg === undefined
          ? '傾斜が未入力です。'
          : `傾斜=${bedrock.inclinationDeg}°（5°超は個別検討が必要）`,
    },
    {
      id: 'nonlinear-properties',
      label: '全層のG/G0–γ・h–γ曲線',
      status: curvesAvailable ? 'pass' : 'fail',
      detail: curvesAvailable ? '全層に曲線入力があります。' : '曲線が未入力の層があります。',
    },
    {
      id: 'terrain-effects',
      label: 'がけ・傾斜地・近傍地形の影響',
      status: 'not-assessed',
      detail: '地形影響は本地盤モデルだけでは判定できません。',
    },
    {
      id: 'liquefaction-interference',
      label: '液状化変形がGs計算へ支障を生じないこと',
      status: 'not-assessed',
      detail: '液状化計算結果と技術者判断を別途記録してください。',
    },
  ]
}

function emptyPreciseResult(
  settings: GsSettings,
  applicability: ApplicabilityCheck[],
  messages: AnalysisMessage[],
): GsResult {
  return {
    mode: settings.mode,
    converged: false,
    curve: [],
    iterations: [],
    applicability,
    messages: uniqueMessages(messages),
  }
}

function createDynamicLayers(
  ground: GroundModel,
  resolvedLayers: readonly ResolvedLayerVs[],
): DynamicLayer[] {
  return ground.layers.map((layer, index) => {
    const resolved = resolvedLayers[index]!
    if (resolved.vsMps === null) throw new RangeError(`Vs unresolved for layer ${layer.id}`)
    return {
      id: layer.id,
      thicknessM: resolved.thicknessM,
      densityKgM3: layer.densityKgM3,
      g0Pa: layer.densityKgM3 * resolved.vsMps ** 2,
    }
  })
}

/** Current regulatory safety-limit precise calculation. */
export function calculatePreciseGs(
  ground: GroundModel,
  settings: GsSettings,
  options: PreciseGsOptions = {},
): GsResult {
  const applicability = assessPreciseGsApplicability(ground)
  const messages: AnalysisMessage[] = []
  if (settings.mode !== 'safety-precise') {
    messages.push(
      analysisMessage(
        'GS_CURRENT_PRECISE_MODE_INVALID',
        'error',
        '現行精算法は安全限界時だけ選択できます。',
        'analysisSettings.gs.mode',
      ),
    )
    return emptyPreciseResult(settings, applicability, messages)
  }

  const coefficientTableId = options.coefficientTableId ?? 'regulatory'
  if (coefficientTableId !== 'regulatory') {
    messages.push(
      analysisMessage(
        'GS_CURRENT_COEFFICIENT_TABLE_INVALID',
        'error',
        '現行精算法ではregulatory Vs係数表だけを使用できます。',
      ),
    )
    return emptyPreciseResult(settings, applicability, messages)
  }

  const resolved = resolveGroundVs(ground, coefficientTableId)
  messages.push(...resolved.messages)
  const elasticPeriod = calculateElasticGroundPeriod(resolved.layers)
  messages.push(...elasticPeriod.messages)

  for (const [index, layer] of ground.layers.entries()) {
    if (!layer.modulusCurve || layer.modulusCurve.length === 0) {
      messages.push(
        analysisMessage(
          'GS_NONLINEAR_CURVE_MISSING',
          'error',
          `層「${layer.id}」のG/G0–γ・h–γ曲線が未入力です。`,
          `ground.layers[${index}].modulusCurve`,
        ),
      )
      continue
    }
    try {
      validateCurve(layer.modulusCurve)
    } catch (cause) {
      messages.push(
        analysisMessage(
          'GS_NONLINEAR_CURVE_INVALID',
          'error',
          cause instanceof Error ? cause.message : '非線形曲線が不正です。',
          `ground.layers[${index}].modulusCurve`,
        ),
      )
    }
  }
  if (messages.some((message) => message.severity === 'error')) {
    return emptyPreciseResult(settings, applicability, messages)
  }

  try {
    const dynamicLayers = createDynamicLayers(ground, resolved.layers)
    const initialStates = ground.layers.map((layer) => {
      const firstPoint = layer.modulusCurve![0]!
      return {
        strain: firstPoint.strain,
        modulusRatio: firstPoint.modulusRatio,
        dampingRatio: firstPoint.dampingRatio,
      }
    })
    const engine = runNonlinearGsIteration({
      layers: dynamicLayers,
      initialStates,
      bedrockDensityKgM3: ground.engineeringBedrock.densityKgM3,
      bedrockVsMps: ground.engineeringBedrock.vsMps,
      regionFactorZ: settings.regionFactorZ,
      effectiveStrainFactor: settings.effectiveStrainFactor,
      relativeTolerance: settings.relativeTolerance,
      absoluteTolerance: settings.absoluteTolerance,
      maxIterations: settings.maxIterations,
      level: 'safety',
      dampingScale: 1,
      gsAtPeriod: (periodS, parameters) => evaluatePreciseGs(periodS, parameters),
      updateState: (layerIndex, strain) => {
        const layer = ground.layers[layerIndex]!
        const interpolated = interpolateModulusCurve(layer.modulusCurve!, strain)
        const interpolationMessages: AnalysisMessage[] = []
        if (interpolated.range !== 'inside') {
          interpolationMessages.push(
            analysisMessage(
              interpolated.range === 'above'
                ? 'GS_CURVE_RANGE_EXCEEDED'
                : 'GS_CURVE_BELOW_RANGE',
              'warning',
              `層「${layer.id}」の有効ひずみを曲線${interpolated.range === 'above' ? '上限' : '下限'}値へ固定しました。`,
              `ground.layers[${layerIndex}].modulusCurve`,
            ),
          )
        }
        return {
          state: {
            strain,
            modulusRatio: interpolated.modulusRatio,
            dampingRatio: interpolated.dampingRatio,
          },
          messages: interpolationMessages,
        }
      },
    })
    messages.push(...engine.messages)
    for (const check of applicability) {
      if (check.status !== 'pass') {
        messages.push(
          analysisMessage(
            `GS_APPLICABILITY_${check.status === 'fail' ? 'FAILED' : 'NOT_ASSESSED'}`,
            'warning',
            `${check.label}: ${check.detail}`,
            `applicability.${check.id}`,
          ),
        )
      }
    }
    const parameters: PreciseCurveParameters = engine.metrics
    const periods = options.periodsS ?? createPeriodGrid()
    const curve = buildSurfaceSpectrum(
      periods,
      (periodS) => evaluatePreciseGs(periodS, parameters),
      settings.regionFactorZ,
      'safety',
    )
    return {
      mode: settings.mode,
      converged: engine.converged,
      t1S: engine.metrics.t1S,
      t2S: engine.metrics.t2S,
      alpha: engine.metrics.alpha,
      dampingRatio: engine.metrics.dampingRatio,
      gs1: engine.metrics.gs1,
      gs2: engine.metrics.gs2,
      elasticPeriodS: elasticPeriod.periodS ?? undefined,
      curve,
      iterations: engine.iterations,
      applicability,
      messages: uniqueMessages(messages),
    }
  } catch (cause) {
    messages.push(
      analysisMessage(
        'GS_PRECISE_CALCULATION_FAILED',
        'error',
        cause instanceof Error ? cause.message : '精算法の計算に失敗しました。',
      ),
    )
    return emptyPreciseResult(settings, applicability, messages)
  }
}
