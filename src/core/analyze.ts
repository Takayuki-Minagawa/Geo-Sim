import { APP_VERSION } from '../domain/defaultProject'
import type {
  AnalysisMessage,
  AnalysisResult,
  JibanProject,
  MotionRecord,
} from '../domain/types'
import { calculateGs } from './gs'
import { calculateLiquefactionCases } from './liquefaction'
import { analyzeMotion } from './motion'
import { normalizeGroundModel } from './normalization/splitLayers'

export type AnalysisProgress = (progress: number) => void

function uniqueMessages(messages: readonly AnalysisMessage[]): AnalysisMessage[] {
  const keys = new Set<string>()
  return messages.filter((message) => {
    const key = `${message.code}|${message.severity}|${message.path ?? ''}|${message.message}`
    if (keys.has(key)) return false
    keys.add(key)
    return true
  })
}

/** Runs every analysis path as browser-safe, deterministic pure calculations. */
export function analyzeProject(
  project: JibanProject,
  motion: MotionRecord | null,
  inputSha256: string,
  onProgress: AnalysisProgress = () => undefined,
): AnalysisResult {
  onProgress(0.05)
  const normalized = normalizeGroundModel(project.ground)
  onProgress(0.2)
  const normalizationErrors = normalized.messages.filter(
    (message) => message.severity === 'error',
  )
  if (normalizationErrors.length > 0) {
    throw new RangeError(
      `地盤モデルを正規化できません: ${normalizationErrors.map((message) => message.message).join('; ')}`,
    )
  }

  const coefficientTableId = project.analysisSettings.gs.mode.startsWith('legacy')
    ? 'legacy-sheet'
    : 'regulatory'
  const gs = calculateGs(normalized.ground, project.analysisSettings.gs, {
    coefficientTableId,
  })
  onProgress(0.62)

  const liquefaction = calculateLiquefactionCases(
    normalized.clippedGround,
    project.analysisSettings.liquefactionCases,
  )
  onProgress(0.8)

  const motionResult = motion
    ? analyzeMotion(motion, {
        spectrum: {
          dampingRatio: project.analysisSettings.responseSpectrumDampingRatio,
        },
      })
    : undefined
  onProgress(0.96)

  const messages = uniqueMessages([
    ...normalized.messages,
    ...gs.messages,
    ...liquefaction.flatMap((result) => result.messages),
    ...(motionResult?.messages ?? []),
  ])
  onProgress(1)

  return {
    resultVersion: '1.0.0',
    calculatedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    inputSha256,
    metadata: {
      gsMethodId: project.method.gs,
      legalBasisCheckedOn: project.method.legalBasisCheckedOn,
      vsCoefficientTableId: coefficientTableId,
      liquefactionMethodId: project.method.liquefaction,
      responseSpectrumDampingRatio: project.analysisSettings.responseSpectrumDampingRatio,
      units: {
        length: 'm',
        acceleration: 'm/s2',
        velocity: 'm/s',
        density: 'kg/m3',
        stress: 'Pa',
      },
    },
    gs,
    liquefaction,
    motion: motionResult,
    messages,
  }
}
