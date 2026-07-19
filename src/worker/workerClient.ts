import type { AnalysisResult, JibanProject, MotionRecord } from '../domain/types'
import type { AnalysisWorkerResponse, AnalyzeRequest, WorkerMotion } from './protocol'

export interface AnalysisTask {
  promise: Promise<AnalysisResult>
  cancel: () => void
}

function serializeMotion(record: MotionRecord | null): { motion: WorkerMotion | null; transfer: Transferable[] } {
  if (!record) return { motion: null, transfer: [] }
  const times = new Float64Array(record.timesS)
  const accelerations = new Float64Array(record.accelerations)
  return {
    motion: {
      name: record.name,
      accelerationUnit: record.accelerationUnit,
      timesBuffer: times.buffer,
      accelerationsBuffer: accelerations.buffer,
    },
    transfer: [times.buffer, accelerations.buffer],
  }
}

export function analyzeInWorker(
  project: JibanProject,
  motionRecord: MotionRecord | null,
  inputSha256: string,
  onProgress: (progress: number) => void,
): AnalysisTask {
  const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' })
  const id = globalThis.crypto.randomUUID()
  const { motion, transfer } = serializeMotion(motionRecord)

  let settled = false
  let rejectTask: ((reason?: unknown) => void) | undefined
  const promise = new Promise<AnalysisResult>((resolve, reject) => {
    rejectTask = reject
    worker.addEventListener('message', (event: MessageEvent<AnalysisWorkerResponse>) => {
      const response = event.data
      if (response.id !== id || settled) return
      if (response.type === 'progress') {
        onProgress(Math.max(0, Math.min(1, response.progress)))
      } else if (response.type === 'result') {
        settled = true
        worker.terminate()
        resolve(response.result)
      } else if (response.type === 'error') {
        settled = true
        worker.terminate()
        reject(new Error(response.message))
      }
    })
    worker.addEventListener('error', (event) => {
      if (settled) return
      settled = true
      worker.terminate()
      reject(new Error(event.message || 'Workerで不明なエラーが発生しました'))
    })
    const request: AnalyzeRequest = {
      type: 'analyze',
      id,
      project: structuredClone(project),
      motion,
      inputSha256,
    }
    worker.postMessage(request, transfer)
  })

  return {
    promise,
    cancel: () => {
      if (settled) return
      settled = true
      worker.terminate()
      rejectTask?.(new DOMException('解析を取り消しました', 'AbortError'))
    },
  }
}
