import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dispose: vi.fn(),
  init: vi.fn(),
  resize: vi.fn(),
  setOption: vi.fn(),
  use: vi.fn(),
}))

vi.mock('echarts/core', () => ({ init: mocks.init, use: mocks.use }))
vi.mock('echarts/charts', () => ({ LineChart: {} }))
vi.mock('echarts/components', () => ({
  AriaComponent: {},
  GridComponent: {},
  LegendComponent: {},
  TitleComponent: {},
  TooltipComponent: {},
}))
vi.mock('echarts/renderers', () => ({ SVGRenderer: {} }))

import { Chart } from '../../src/ui/components/Chart'

class ResizeObserverStub implements ResizeObserver {
  disconnect = vi.fn()
  observe = vi.fn()
  unobserve = vi.fn()

  constructor(callback: ResizeObserverCallback) {
    void callback
  }
}

describe('Chart', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    mocks.init.mockReturnValue({
      dispose: mocks.dispose,
      resize: mocks.resize,
      setOption: mocks.setOption,
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('option更新では既存インスタンスを再利用し、アンマウント時だけ破棄する', () => {
    const { rerender, unmount } = render(
      <Chart ariaLabel="試験チャート" option={{ title: { text: 'first' } }} />,
    )

    rerender(<Chart ariaLabel="試験チャート" option={{ title: { text: 'second' } }} />)

    expect(mocks.init).toHaveBeenCalledTimes(1)
    expect(mocks.setOption).toHaveBeenCalledTimes(2)
    expect(mocks.dispose).not.toHaveBeenCalled()

    unmount()
    expect(mocks.dispose).toHaveBeenCalledTimes(1)
  })
})
