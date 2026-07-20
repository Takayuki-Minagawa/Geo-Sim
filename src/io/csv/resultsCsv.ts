import Papa from 'papaparse'
import type { AnalysisResult } from '../../domain/types'
import { safeCsvText } from './csv'

function csv(rows: readonly (readonly (string | number | boolean)[])[]): string {
  return `\uFEFF${Papa.unparse(rows.map((row) => [...row]), { newline: '\r\n' })}`
}

export function exportGsResultCsv(result: AnalysisResult): string {
  return csv([
    [
      'period_s',
      'gs',
      'base_sa_m_s2',
      'surface_sa_m_s2',
      'surface_sv_m_s',
      'surface_sd_m',
      'mode',
      'converged',
    ],
    ...result.gs.curve.map((point) => [
      point.periodS,
      point.gs,
      point.baseSaMps2,
      point.surfaceSaMps2,
      point.svMps,
      point.sdM,
      result.gs.mode,
      result.gs.converged,
    ]),
  ])
}

export function exportLiquefactionResultCsv(result: AnalysisResult): string {
  return csv([
    [
      'case_id',
      'peak_acceleration_gal',
      'magnitude',
      'layer_id',
      'top_depth_m',
      'bottom_depth_m',
      'center_depth_m',
      'eligible',
      'n',
      'corrected_n',
      'demand_ratio_l',
      'resistance_ratio_r',
      'fl',
      'cyclic_strain_percent',
      'dcy_contribution_cm',
      'pl_contribution',
      'reason',
    ],
    ...result.liquefaction.flatMap((caseResult) =>
      caseResult.layers.map((layer) => [
        safeCsvText(caseResult.caseId),
        caseResult.peakAccelerationGal,
        caseResult.magnitude,
        safeCsvText(layer.layerId),
        layer.topDepthM,
        layer.bottomDepthM,
        layer.centerDepthM,
        layer.eligible,
        layer.n,
        layer.correctedN,
        layer.demandRatio,
        layer.resistanceRatio,
        layer.fl,
        layer.cyclicStrainPercent,
        layer.dcyContributionCm,
        layer.plContribution,
        safeCsvText(layer.reason ?? ''),
      ]),
    ),
  ])
}

export function exportMotionSpectrumCsv(result: AnalysisResult): string {
  if (!result.motion) throw new Error('時刻歴解析結果がありません')
  return csv([
    ['period_s', 'sd_m', 'sv_m_s', 'sa_m_s2', 'damping_ratio'],
    ...result.motion.spectrum.map((point) => [
      point.periodS,
      point.sdM,
      point.svMps,
      point.saMps2,
      result.metadata.responseSpectrumDampingRatio,
    ]),
  ])
}
