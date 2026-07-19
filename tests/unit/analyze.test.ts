import { describe, expect, it, vi } from 'vitest'
import { analyzeProject } from '../../src/core/analyze'
import { createDefaultProject } from '../../src/domain/defaultProject'
import type { AnalyzeRequest } from '../../src/worker/protocol'
import { executeAnalyzeRequest } from '../../src/worker/execute'

describe('統合解析', () => {
  it('Gs・液状化と出力メタデータをひとつの結果にまとめる', () => {
    const progress: number[] = []
    const result = analyzeProject(createDefaultProject(), null, 'test-sha', (value) =>
      progress.push(value),
    )
    expect(result.gs.curve.length).toBeGreaterThan(10)
    expect(result.liquefaction).toHaveLength(2)
    expect(result.metadata).toMatchObject({
      gsMethodId: 'jp-mlit-kokuji-1457-current',
      vsCoefficientTableId: 'regulatory',
    })
    expect(result.inputSha256).toBe('test-sha')
    expect(progress.at(-1)).toBe(1)
  })

  it('transferable表現のWorker経路と直接実行を一致させる', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-19T00:00:00.000Z'))
    const project = createDefaultProject()
    const times = new Float64Array([0, 0.01, 0.02, 0.03])
    const accelerations = new Float64Array([0, 10, -10, 0])
    const request: AnalyzeRequest = {
      type: 'analyze',
      id: 'worker-test',
      project,
      inputSha256: 'worker-sha',
      motion: {
        name: 'pulse',
        accelerationUnit: 'gal',
        timesBuffer: times.buffer,
        accelerationsBuffer: accelerations.buffer,
      },
    }
    const direct = analyzeProject(
      project,
      {
        name: 'pulse',
        accelerationUnit: 'gal',
        timesS: Array.from(times),
        accelerations: Array.from(accelerations),
      },
      'worker-sha',
    )
    expect(executeAnalyzeRequest(request)).toEqual(direct)
    vi.useRealTimers()
  })
})
