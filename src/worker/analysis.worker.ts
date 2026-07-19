/// <reference lib="webworker" />

import { executeAnalyzeRequest } from './execute'
import type { AnalysisWorkerResponse, AnalyzeRequest } from './protocol'

const workerScope: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope

workerScope.addEventListener('message', (event: MessageEvent<AnalyzeRequest>) => {
  const request = event.data
  if (request.type !== 'analyze') return
  try {
    const result = executeAnalyzeRequest(request, (progress) => {
      const response: AnalysisWorkerResponse = {
        type: 'progress',
        id: request.id,
        progress,
      }
      workerScope.postMessage(response)
    })
    const response: AnalysisWorkerResponse = { type: 'result', id: request.id, result }
    workerScope.postMessage(response)
  } catch (error) {
    const response: AnalysisWorkerResponse = {
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    }
    workerScope.postMessage(response)
  }
})

export {}
