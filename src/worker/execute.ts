import { analyzeProject, type AnalysisProgress } from '../core/analyze'
import type { MotionRecord } from '../domain/types'
import type { AnalyzeRequest } from './protocol'

function deserializeMotion(request: AnalyzeRequest): MotionRecord | null {
  if (!request.motion) return null
  return {
    name: request.motion.name,
    accelerationUnit: request.motion.accelerationUnit,
    timesS: Array.from(new Float64Array(request.motion.timesBuffer)),
    accelerations: Array.from(new Float64Array(request.motion.accelerationsBuffer)),
  }
}

export function executeAnalyzeRequest(
  request: AnalyzeRequest,
  onProgress?: AnalysisProgress,
) {
  return analyzeProject(
    request.project,
    deserializeMotion(request),
    request.inputSha256,
    onProgress,
  )
}
