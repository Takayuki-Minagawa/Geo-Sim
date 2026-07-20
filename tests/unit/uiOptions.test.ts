import { describe, expect, it } from 'vitest'
import { createDefaultProject } from '../../src/domain/defaultProject'
import { motionChartOption, nValueChartOption, spectrumChartOption } from '../../src/ui/options'

describe('localized chart options', () => {
  it('uses English labels and dark-mode axis colors', () => {
    const option = nValueChartOption(createDefaultProject().ground, 'en', 'dark')

    expect(option).toMatchObject({
      xAxis: {
        name: 'N-value',
        axisLabel: { color: '#e6f1f2' },
      },
      yAxis: {
        name: 'Depth (m)',
        splitLine: { lineStyle: { color: '#2f5056' } },
      },
    })
  })

  it('localizes empty motion and spectrum labels', () => {
    expect(motionChartOption(null, 'en', 'dark')).toMatchObject({
      title: { text: 'No ground motion loaded', textStyle: { color: '#e6f1f2' } },
    })
    expect(spectrumChartOption(null, 'en', 'light')).toMatchObject({
      legend: { data: ['Reference surface Sa', 'Time-history Sa'] },
    })
  })
})
