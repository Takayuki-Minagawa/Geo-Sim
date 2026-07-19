import type { EChartsOption } from 'echarts'
import type { AnalysisResult, GroundModel, MotionRecord } from '../domain/types'

const axisStyle = {
  axisLine: { lineStyle: { color: '#78909c' } },
  splitLine: { lineStyle: { color: '#e6edf0' } },
}

export function nValueChartOption(ground: GroundModel): EChartsOption {
  return {
    tooltip: { trigger: 'axis' },
    grid: { top: 24, right: 24, bottom: 52, left: 64 },
    xAxis: { type: 'value', name: 'N値', min: 0, ...axisStyle },
    yAxis: {
      type: 'value',
      name: '深度 (m)',
      inverse: true,
      min: 0,
      max: ground.engineeringBedrock.depthM,
      ...axisStyle,
    },
    series: [
      {
        name: 'N値',
        type: 'line',
        step: 'middle',
        symbolSize: 7,
        lineStyle: { width: 3, color: '#087f8c' },
        itemStyle: { color: '#087f8c' },
        data: ground.nValues.map((value) => [value.n, value.depthM]),
      },
    ],
  }
}

export function gsChartOption(result: AnalysisResult | null): EChartsOption {
  const curve = result?.gs.curve ?? []
  return {
    tooltip: { trigger: 'axis' },
    legend: { data: ['Gs'] },
    grid: { top: 42, right: 24, bottom: 52, left: 64 },
    xAxis: { type: 'value', name: '周期 T (s)', min: 0, ...axisStyle },
    yAxis: { type: 'value', name: '増幅率 Gs', min: 0, ...axisStyle },
    series: [
      {
        name: 'Gs',
        type: 'line',
        showSymbol: false,
        lineStyle: { width: 3, color: '#d1495b' },
        data: curve.map((point) => [point.periodS, point.gs]),
      },
    ],
  }
}

export function spectrumChartOption(result: AnalysisResult | null): EChartsOption {
  const surface = result?.gs.curve ?? []
  const motion = result?.motion?.spectrum ?? []
  return {
    tooltip: { trigger: 'axis' },
    legend: { data: ['告示地表Sa', '時刻歴Sa'] },
    grid: { top: 42, right: 24, bottom: 52, left: 72 },
    xAxis: { type: 'value', name: '周期 T (s)', min: 0, ...axisStyle },
    yAxis: { type: 'value', name: 'Sa (m/s²)', min: 0, ...axisStyle },
    series: [
      {
        name: '告示地表Sa',
        type: 'line',
        showSymbol: false,
        data: surface.map((point) => [point.periodS, point.surfaceSaMps2]),
      },
      {
        name: '時刻歴Sa',
        type: 'line',
        showSymbol: false,
        data: motion.map((point) => [point.periodS, point.saMps2]),
      },
    ],
  }
}

export function motionChartOption(record: MotionRecord | null): EChartsOption {
  if (!record) return { title: { text: '時刻歴未読込', left: 'center', top: 'middle' } }
  const maxPoints = 5_000
  const stride = Math.max(1, Math.ceil(record.timesS.length / maxPoints))
  const data: [number, number][] = []
  for (let index = 0; index < record.timesS.length; index += stride) {
    const time = record.timesS[index]
    const acceleration = record.accelerations[index]
    if (time !== undefined && acceleration !== undefined) data.push([time, acceleration])
  }
  return {
    tooltip: { trigger: 'axis' },
    grid: { top: 24, right: 24, bottom: 52, left: 72 },
    xAxis: { type: 'value', name: '時刻 (s)', ...axisStyle },
    yAxis: { type: 'value', name: `加速度 (${record.accelerationUnit})`, ...axisStyle },
    series: [{ type: 'line', showSymbol: false, lineStyle: { width: 1, color: '#335c67' }, data }],
  }
}
