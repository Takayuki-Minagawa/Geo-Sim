import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { analyzeProject } from '../../src/core/analyze'
import { createDefaultProject } from '../../src/domain/defaultProject'
import type { AnalysisResult } from '../../src/domain/types'

const workerMock = vi.hoisted(() => ({ analyzeInWorker: vi.fn() }))

vi.mock('../../src/worker/workerClient', () => ({
  analyzeInWorker: workerMock.analyzeInWorker,
}))
vi.mock('../../src/ui/components/Chart', () => ({
  Chart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

import App from '../../src/App'

describe('App analysis result lifecycle', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('解析中に入力が変わった場合は古い入力の結果を確定表示しない', async () => {
    let resolveResult: ((result: AnalysisResult) => void) | undefined
    const promise = new Promise<AnalysisResult>((resolve) => {
      resolveResult = resolve
    })
    workerMock.analyzeInWorker.mockReturnValue({ promise, cancel: vi.fn() })
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '解析を実行' }))
    await waitFor(() => expect(workerMock.analyzeInWorker).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByLabelText('案件名'), { target: { value: '解析中の変更' } })

    const staleResult = analyzeProject(createDefaultProject(), null, 'stale-input')
    await act(async () => {
      resolveResult?.(staleResult)
      await promise
    })

    await waitFor(() => {
      expect(screen.getByText('ANALYSIS_INPUT_CHANGED')).toBeInTheDocument()
    })
    expect(screen.getByLabelText('案件名')).toHaveValue('解析中の変更')
    expect(screen.queryByText('計算済み')).not.toBeInTheDocument()
  })

  it('利用者による解析取消をエラーではなく情報として表示する', async () => {
    let rejectResult: ((reason: unknown) => void) | undefined
    const promise = new Promise<AnalysisResult>((_resolve, reject) => {
      rejectResult = reject
    })
    const cancel = vi.fn(() => {
      rejectResult?.(new DOMException('解析を取り消しました', 'AbortError'))
    })
    workerMock.analyzeInWorker.mockReturnValue({ promise, cancel })
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '解析を実行' }))
    await waitFor(() => expect(workerMock.analyzeInWorker).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    await waitFor(() => {
      expect(screen.getByText('ANALYSIS_CANCELLED')).toBeInTheDocument()
    })
    expect(screen.getByText('解析を取り消しました。')).toBeInTheDocument()
    expect(screen.queryByText('ANALYSIS_FAILED')).not.toBeInTheDocument()
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
