import { LineChart } from 'echarts/charts'
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components'
import { init, use as registerEChartsModules } from 'echarts/core'
import type { EChartsCoreOption } from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import { useEffect, useRef } from 'react'

registerEChartsModules([
  LineChart,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  AriaComponent,
  SVGRenderer,
])

interface ChartProps {
  option: EChartsCoreOption
  ariaLabel: string
  height?: number
}

export function Chart({ option, ariaLabel, height = 360 }: ChartProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ref.current) return
    const chart = init(ref.current, undefined, { renderer: 'svg' })
    chart.setOption({
      animation: false,
      aria: { enabled: true, decal: { show: true } },
      ...option,
    })
    const resize = new ResizeObserver(() => chart.resize())
    resize.observe(ref.current)
    return () => {
      resize.disconnect()
      chart.dispose()
    }
  }, [option])

  return <div ref={ref} role="img" aria-label={ariaLabel} style={{ width: '100%', height }} />
}
