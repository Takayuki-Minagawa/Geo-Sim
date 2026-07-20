import type {
  AnalysisMessage,
  ApplicabilityCheck,
  GroundModel,
  GsResult,
  GsSettings,
} from '../../domain/types'
import { calculateElasticGroundPeriod, resolveGroundVs } from '../vs'
import { calculateLegacyPreciseGs } from './legacy'
import { calculatePreciseGs, type PreciseGsOptions } from './precise'
import { calculateSimplifiedGs } from './simplified'
import { buildSurfaceSpectrum, createPeriodGrid, type SpectrumLimit } from './spectrum'

export * from './legacy'
export * from './precise'
export * from './simplified'
export * from './spectrum'

function groundTypeApplicability(settings: GsSettings): ApplicabilityCheck[] {
  const hasBasis = settings.groundTypeBasis.trim().length > 0
  return [
    {
      id: 'simplified-ground-type-basis',
      label: '地盤種別の根拠記録',
      status: hasBasis ? 'pass' : 'fail',
      detail: hasBasis
        ? `第${settings.groundType}種地盤: ${settings.groundTypeBasis}`
        : '地盤種別は自動確定せず、地質・層厚・埋立履歴等の根拠入力が必要です。',
    },
  ]
}

export function calculateSimplifiedGsResult(
  ground: GroundModel,
  settings: GsSettings,
  periodsS: readonly number[] = createPeriodGrid(),
): GsResult {
  const applicability = groundTypeApplicability(settings)
  const messages: AnalysisMessage[] = []
  if (settings.mode !== 'damage-simplified' && settings.mode !== 'safety-simplified') {
    return {
      mode: settings.mode,
      converged: false,
      curve: [],
      iterations: [],
      applicability,
      messages: [
        {
          code: 'GS_SIMPLIFIED_MODE_INVALID',
          severity: 'error',
          message: '略算法にはdamage-simplifiedまたはsafety-simplifiedを指定してください。',
          path: 'analysisSettings.gs.mode',
        },
      ],
    }
  }
  if (!settings.groundTypeBasis.trim()) {
    messages.push({
      code: 'GS_GROUND_TYPE_BASIS_MISSING',
      severity: 'warning',
      message: '地盤種別の採用根拠が未入力です。結果の確定前に記録してください。',
      path: 'analysisSettings.gs.groundTypeBasis',
    })
  }

  // Tg is a reference value only in the simplified method. Failure to estimate
  // Vs must not suppress the legally selected ground-type curve.
  const resolved = resolveGroundVs(ground, 'regulatory')
  const elastic = calculateElasticGroundPeriod(resolved.layers)
  if (elastic.periodS === null) {
    messages.push({
      code: 'GS_REFERENCE_TG_UNAVAILABLE',
      severity: 'warning',
      message: '一部層のVsが未確定のため、参考弾性地盤周期Tgを算定できません。',
      path: 'ground.layers',
    })
  }

  try {
    const limit: SpectrumLimit = settings.mode === 'damage-simplified' ? 'damage' : 'safety'
    const curve = buildSurfaceSpectrum(
      periodsS,
      (periodS) => calculateSimplifiedGs(periodS, settings.groundType),
      settings.regionFactorZ,
      limit,
    )
    return {
      mode: settings.mode,
      converged: true,
      elasticPeriodS: elastic.periodS ?? undefined,
      curve,
      iterations: [],
      applicability,
      messages,
    }
  } catch (cause) {
    messages.push({
      code: 'GS_SIMPLIFIED_CALCULATION_FAILED',
      severity: 'error',
      message: cause instanceof Error ? cause.message : 'Gs略算法の計算に失敗しました。',
    })
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

export function calculateGs(
  ground: GroundModel,
  settings: GsSettings,
  options: PreciseGsOptions = {},
): GsResult {
  const runtimeMode = settings.mode as string
  switch (runtimeMode) {
    case 'damage-simplified':
    case 'safety-simplified':
      return calculateSimplifiedGsResult(
        ground,
        settings,
        options.periodsS ?? createPeriodGrid(),
      )
    case 'safety-precise':
      return calculatePreciseGs(ground, settings, options)
    case 'legacy-damage-precise':
    case 'legacy-safety-precise':
      return calculateLegacyPreciseGs(ground, settings, options)
    default:
      return {
        mode: settings.mode,
        converged: false,
        curve: [],
        iterations: [],
        applicability: [],
        messages: [
          {
            code: 'GS_MODE_UNKNOWN',
            severity: 'error',
            message: `未対応のGs計算モード「${runtimeMode}」が指定されました。`,
            path: 'analysisSettings.gs.mode',
          },
        ],
      }
  }
}
