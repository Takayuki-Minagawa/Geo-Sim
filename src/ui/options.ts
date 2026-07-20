import type { EChartsOption } from 'echarts'
import type { AnalysisResult, GroundModel, MotionRecord } from '../domain/types'
import type { Locale, ThemeMode } from './i18n'

const chartPalettes: Record<ThemeMode, {
  text: string
  muted: string
  line: string
  tooltip: string
  teal: string
  red: string
  blue: string
}> = {
  light: {
    text: '#173c41',
    muted: '#78909c',
    line: '#e6edf0',
    tooltip: '#ffffff',
    teal: '#087f8c',
    red: '#d1495b',
    blue: '#335c67',
  },
  dark: {
    text: '#e6f1f2',
    muted: '#9bb2b6',
    line: '#2f5056',
    tooltip: '#102a2f',
    teal: '#55d4dc',
    red: '#ff8190',
    blue: '#80c8da',
  },
}

function presentation(theme: ThemeMode) {
  const palette = chartPalettes[theme]
  return {
    textStyle: { color: palette.text },
    tooltip: {
      trigger: 'axis' as const,
      backgroundColor: palette.tooltip,
      borderColor: palette.muted,
      textStyle: { color: palette.text },
    },
    legend: { textStyle: { color: palette.text } },
    axisStyle: {
      axisLine: { lineStyle: { color: palette.muted } },
      axisLabel: { color: palette.text },
      nameTextStyle: { color: palette.text },
      splitLine: { lineStyle: { color: palette.line } },
    },
    palette,
  }
}

export function nValueChartOption(
  ground: GroundModel,
  locale: Locale = 'ja',
  theme: ThemeMode = 'light',
): EChartsOption {
  const style = presentation(theme)
  const nValue = locale === 'ja' ? 'N値' : 'N-value'
  return {
    textStyle: style.textStyle,
    tooltip: style.tooltip,
    grid: { top: 24, right: 24, bottom: 52, left: 64 },
    xAxis: { type: 'value', name: nValue, min: 0, ...style.axisStyle },
    yAxis: {
      type: 'value',
      name: locale === 'ja' ? '深度 (m)' : 'Depth (m)',
      inverse: true,
      min: 0,
      max: ground.engineeringBedrock.depthM,
      ...style.axisStyle,
    },
    series: [
      {
        name: nValue,
        type: 'line',
        step: 'middle',
        symbolSize: 7,
        lineStyle: { width: 3, color: style.palette.teal },
        itemStyle: { color: style.palette.teal },
        data: ground.nValues.map((value) => [value.n, value.depthM]),
      },
    ],
  }
}

export function gsChartOption(
  result: AnalysisResult | null,
  locale: Locale = 'ja',
  theme: ThemeMode = 'light',
): EChartsOption {
  const curve = result?.gs.curve ?? []
  const style = presentation(theme)
  return {
    textStyle: style.textStyle,
    tooltip: style.tooltip,
    legend: { data: ['Gs'], ...style.legend },
    grid: { top: 42, right: 24, bottom: 52, left: 64 },
    xAxis: {
      type: 'value',
      name: locale === 'ja' ? '周期 T (s)' : 'Period T (s)',
      min: 0,
      ...style.axisStyle,
    },
    yAxis: {
      type: 'value',
      name: locale === 'ja' ? '増幅率 Gs' : 'Amplification Gs',
      min: 0,
      ...style.axisStyle,
    },
    series: [
      {
        name: 'Gs',
        type: 'line',
        showSymbol: false,
        lineStyle: { width: 3, color: style.palette.red },
        data: curve.map((point) => [point.periodS, point.gs]),
      },
    ],
  }
}

export function spectrumChartOption(
  result: AnalysisResult | null,
  locale: Locale = 'ja',
  theme: ThemeMode = 'light',
): EChartsOption {
  const surface = result?.gs.curve ?? []
  const motion = result?.motion?.spectrum ?? []
  const style = presentation(theme)
  const surfaceLabel = locale === 'ja' ? '告示関連・地表Sa' : 'Reference surface Sa'
  const motionLabel = locale === 'ja' ? '時刻歴Sa' : 'Time-history Sa'
  return {
    textStyle: style.textStyle,
    tooltip: style.tooltip,
    legend: { data: [surfaceLabel, motionLabel], ...style.legend },
    grid: { top: 42, right: 24, bottom: 52, left: 72 },
    xAxis: {
      type: 'value',
      name: locale === 'ja' ? '周期 T (s)' : 'Period T (s)',
      min: 0,
      ...style.axisStyle,
    },
    yAxis: { type: 'value', name: 'Sa (m/s²)', min: 0, ...style.axisStyle },
    series: [
      {
        name: surfaceLabel,
        type: 'line',
        showSymbol: false,
        lineStyle: { color: style.palette.teal },
        data: surface.map((point) => [point.periodS, point.surfaceSaMps2]),
      },
      {
        name: motionLabel,
        type: 'line',
        showSymbol: false,
        lineStyle: { color: style.palette.red },
        data: motion.map((point) => [point.periodS, point.saMps2]),
      },
    ],
  }
}

export function motionChartOption(
  record: MotionRecord | null,
  locale: Locale = 'ja',
  theme: ThemeMode = 'light',
): EChartsOption {
  const style = presentation(theme)
  if (!record) {
    return {
      textStyle: style.textStyle,
      title: {
        text: locale === 'ja' ? '時刻歴未読込' : 'No ground motion loaded',
        left: 'center',
        top: 'middle',
        textStyle: { color: style.palette.text },
      },
    }
  }
  const maxPoints = 5_000
  const stride = Math.max(1, Math.ceil(record.timesS.length / maxPoints))
  const data: [number, number][] = []
  for (let index = 0; index < record.timesS.length; index += stride) {
    const time = record.timesS[index]
    const acceleration = record.accelerations[index]
    if (time !== undefined && acceleration !== undefined) data.push([time, acceleration])
  }
  return {
    textStyle: style.textStyle,
    tooltip: style.tooltip,
    grid: { top: 24, right: 24, bottom: 52, left: 72 },
    xAxis: {
      type: 'value',
      name: locale === 'ja' ? '時刻 (s)' : 'Time (s)',
      ...style.axisStyle,
    },
    yAxis: {
      type: 'value',
      name: `${locale === 'ja' ? '加速度' : 'Acceleration'} (${record.accelerationUnit})`,
      ...style.axisStyle,
    },
    series: [
      {
        type: 'line',
        showSymbol: false,
        lineStyle: { width: 1, color: style.palette.blue },
        data,
      },
    ],
  }
}
