import type {
  AnalysisMessage,
  ApplicabilityCheck,
  GroundLayer,
  GroundModel,
  GsResult,
  GsSettings,
} from '../../domain/types'
import { calculateElasticGroundPeriod, resolveGroundVs } from '../vs'
import {
  evaluatePreciseGs,
  runNonlinearGsIteration,
  type DynamicLayerState,
  type PreciseCurveParameters,
  type PreciseGsOptions,
} from './precise'
import { buildSurfaceSpectrum, createPeriodGrid, type SpectrumLimit } from './spectrum'

export interface LegacySoilParameters {
  a1: number
  a2: number
  a3: number
  family: 'cohesive' | 'sandy'
}

const LEGACY_MODULUS_STEP = 0.00001

function message(
  code: string,
  severity: AnalysisMessage['severity'],
  text: string,
  path?: string,
): AnalysisMessage {
  return { code, severity, message: text, path }
}

export function legacySoilParameters(layer: Pick<GroundLayer, 'soilClass'>): LegacySoilParameters {
  const cohesive = new Set<GroundLayer['soilClass']>([
    'clay',
    'silt',
    'surface-soil',
    'fill',
    'organic',
  ])
  return cohesive.has(layer.soilClass)
    ? { a1: 5, a2: 2.4, a3: 600, family: 'cohesive' }
    : { a1: 10, a2: 2.6, a3: 1100, family: 'sandy' }
}

function legacyReductionEquation(
  modulusRatio: number,
  strain: number,
  parameters: LegacySoilParameters,
): number {
  return (
    modulusRatio *
    (1 +
      parameters.a1 *
        (modulusRatio * Math.max(0, strain) * parameters.a3) ** (parameters.a2 - 1))
  )
}

/**
 * Largest 1e-5 grid value satisfying the workbook's modulus-reduction
 * inequality. Bisection finds the root efficiently; final grid correction
 * preserves the decrement semantics of the VBA loop.
 */
export function calculateLegacyLayerState(
  strain: number,
  parameters: LegacySoilParameters,
): DynamicLayerState {
  if (!Number.isFinite(strain) || strain < 0) throw new RangeError('strain is invalid')
  let modulusRatio = 1
  if (legacyReductionEquation(1, strain, parameters) > 1) {
    let lower = 0
    let upper = 1
    for (let iteration = 0; iteration < 64; iteration += 1) {
      const midpoint = (lower + upper) / 2
      if (legacyReductionEquation(midpoint, strain, parameters) <= 1) lower = midpoint
      else upper = midpoint
    }
    if (
      lower < LEGACY_MODULUS_STEP &&
      legacyReductionEquation(LEGACY_MODULUS_STEP, strain, parameters) > 1
    ) {
      throw new RangeError('strain exceeds the legacy fixed-model calculation range')
    }
    modulusRatio = Math.floor((lower + 1e-12) / LEGACY_MODULUS_STEP) * LEGACY_MODULUS_STEP
    modulusRatio = Math.max(LEGACY_MODULUS_STEP, Math.min(1, modulusRatio))
    while (
      modulusRatio > LEGACY_MODULUS_STEP &&
      legacyReductionEquation(modulusRatio, strain, parameters) > 1
    ) {
      modulusRatio -= LEGACY_MODULUS_STEP
    }
    while (
      modulusRatio + LEGACY_MODULUS_STEP <= 1 &&
      legacyReductionEquation(modulusRatio + LEGACY_MODULUS_STEP, strain, parameters) <= 1
    ) {
      modulusRatio += LEGACY_MODULUS_STEP
    }
  }
  const dampingRatio = Math.max(
    0.02,
    (2 / Math.PI) * ((parameters.a2 - 1) / (parameters.a2 + 1)) * (1 - modulusRatio),
  )
  return { strain, modulusRatio, dampingRatio }
}

export function evaluateLegacyPreciseGs(
  periodS: number,
  parameters: PreciseCurveParameters,
  level: SpectrumLimit,
): number {
  const minimum = level === 'safety' ? 1.23 : periodS <= 1.2 * parameters.t1S ? 1.5 : 1.35
  return evaluatePreciseGs(periodS, parameters, minimum)
}

function legacyApplicability(): ApplicabilityCheck[] {
  return [
    {
      id: 'legacy-compatibility-only',
      label: '旧シート照合専用',
      status: 'fail',
      detail: '固定土質近似式と減衰0.8倍を用いるため、現行法適合値として使用できません。',
    },
    {
      id: 'terrain-effects',
      label: 'がけ・傾斜地・近傍地形の影響',
      status: 'not-assessed',
      detail: '旧シート照合計算では評価しません。',
    },
    {
      id: 'liquefaction-interference',
      label: '液状化変形のGs計算への支障',
      status: 'not-assessed',
      detail: '液状化結果と技術者判断を別途確認してください。',
    },
  ]
}

/** Legacy workbook compatibility calculation; never a current-regulation result. */
export function calculateLegacyPreciseGs(
  ground: GroundModel,
  settings: GsSettings,
  options: PreciseGsOptions = {},
): GsResult {
  const applicability = legacyApplicability()
  const messages: AnalysisMessage[] = [
    message(
      'GS_LEGACY_COMPATIBILITY_MODE',
      'warning',
      '旧シート照合モードです。算定値を現行法適合値として使用しないでください。',
      'analysisSettings.gs.mode',
    ),
  ]
  if (
    settings.mode !== 'legacy-damage-precise' &&
    settings.mode !== 'legacy-safety-precise'
  ) {
    messages.push(
      message(
        'GS_LEGACY_MODE_INVALID',
        'error',
        '旧精算法にはlegacy-damage-preciseまたはlegacy-safety-preciseを指定してください。',
      ),
    )
    return {
      mode: settings.mode,
      converged: false,
      curve: [],
      iterations: [],
      applicability,
      messages,
    }
  }

  const resolved = resolveGroundVs(ground, 'legacy-sheet')
  messages.push(...resolved.messages)
  const elasticPeriod = calculateElasticGroundPeriod(resolved.layers)
  messages.push(...elasticPeriod.messages)
  if (messages.some((item) => item.severity === 'error')) {
    return {
      mode: settings.mode,
      converged: false,
      curve: [],
      iterations: [],
      applicability,
      messages,
    }
  }

  try {
    const layers = ground.layers.map((layer, index) => {
      const vsMps = resolved.layers[index]!.vsMps
      if (vsMps === null) throw new Error(`Vs unresolved for layer ${layer.id}`)
      return {
        id: layer.id,
        thicknessM: layer.bottomDepthM - layer.topDepthM,
        densityKgM3: layer.densityKgM3,
        g0Pa: layer.densityKgM3 * vsMps ** 2,
      }
    })
    const level: SpectrumLimit =
      settings.mode === 'legacy-damage-precise' ? 'damage' : 'safety'
    const initialStates = layers.map<DynamicLayerState>(() => ({
      strain: 1e-5,
      modulusRatio: 1,
      dampingRatio: 0.02,
    }))
    const engine = runNonlinearGsIteration({
      layers,
      initialStates,
      bedrockDensityKgM3: ground.engineeringBedrock.densityKgM3,
      bedrockVsMps: ground.engineeringBedrock.vsMps,
      regionFactorZ: settings.regionFactorZ,
      effectiveStrainFactor: 0.65,
      relativeTolerance: 0.01,
      absoluteTolerance: 0,
      maxIterations: 20,
      level,
      dampingScale: 0.8,
      gsAtPeriod: (periodS, parameters) =>
        evaluateLegacyPreciseGs(periodS, parameters, level),
      updateState: (layerIndex, strain) => ({
        state: calculateLegacyLayerState(
          strain,
          legacySoilParameters(ground.layers[layerIndex]!),
        ),
      }),
    })
    messages.push(...engine.messages)
    const parameters: PreciseCurveParameters = engine.metrics
    const curve = buildSurfaceSpectrum(
      options.periodsS ?? createPeriodGrid(),
      (periodS) => evaluateLegacyPreciseGs(periodS, parameters, level),
      settings.regionFactorZ,
      level,
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
      messages,
    }
  } catch (cause) {
    messages.push(
      message(
        'GS_LEGACY_CALCULATION_FAILED',
        'error',
        cause instanceof Error ? cause.message : '旧シート照合計算に失敗しました。',
      ),
    )
    return {
      mode: settings.mode,
      converged: false,
      curve: [],
      iterations: [],
      applicability,
      messages,
    }
  }
}
