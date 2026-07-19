import type { AnalysisResult, JibanProject, MotionRecord } from '../domain/types'

export interface WorkerMotion {
  name: string
  accelerationUnit: MotionRecord['accelerationUnit']
  timesBuffer: ArrayBuffer
  accelerationsBuffer: ArrayBuffer
}

export interface AnalyzeRequest {
  type: 'analyze'
  id: string
  project: JibanProject
  motion: WorkerMotion | null
  inputSha256: string
}

export type AnalysisWorkerResponse =
  | { type: 'progress'; id: string; progress: number }
  | { type: 'result'; id: string; result: AnalysisResult }
  | { type: 'error'; id: string; message: string }
