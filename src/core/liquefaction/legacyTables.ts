/**
 * Fine-content correction used by the legacy workbook (VBA `nf`).
 *
 * The function intentionally preserves the workbook's strict upper bounds:
 * 5, 10 and 20 percent belong to the following interval.
 */
export function nf(finesPercent: number): number {
  assertFiniteNonNegative(finesPercent, '細粒土含有率')

  if (finesPercent > 100) {
    throw new RangeError('細粒土含有率は100% 以下である必要があります')
  }
  if (finesPercent < 5) return 0
  if (finesPercent < 10) return 1.2 * finesPercent - 6
  if (finesPercent < 20) return 0.2 * (finesPercent - 10) + 6
  return 0.1 * (finesPercent - 20) + 8
}

export const fineContentCorrection = nf

interface GanmacyBand {
  upperDemandExclusive: number
  correctedNThresholds: readonly number[]
}

const STRAIN_PERCENT = [8, 4, 3, 2, 1, 0.5] as const

/** Thresholds transcribed from workbook VBA `Module1.ganmacy`. */
const GANMACY_BANDS: readonly GanmacyBand[] = [
  { upperDemandExclusive: 0.1, correctedNThresholds: [3.5, 5, 6, 7, 7.5, 7.6] },
  { upperDemandExclusive: 0.15, correctedNThresholds: [5, 7.2, 8, 10, 12, 13] },
  { upperDemandExclusive: 0.2, correctedNThresholds: [5, 8, 10, 12, 16, 17.5] },
  { upperDemandExclusive: 0.25, correctedNThresholds: [5, 8, 10.5, 13.5, 17.5, 21] },
  { upperDemandExclusive: 0.3, correctedNThresholds: [5, 8, 10.5, 14.5, 18.5, 22.5] },
  { upperDemandExclusive: 0.35, correctedNThresholds: [5, 8, 10.5, 15, 20, 23.5] },
  { upperDemandExclusive: 0.4, correctedNThresholds: [5, 8, 10.5, 15, 20.5, 24.5] },
  { upperDemandExclusive: 0.45, correctedNThresholds: [5, 8, 10.5, 15, 21, 25] },
  {
    upperDemandExclusive: Number.POSITIVE_INFINITY,
    correctedNThresholds: [5, 8, 10.5, 15, 21, 25.5],
  },
] as const

/**
 * Cyclic shear strain in percent, matching the complete legacy VBA step table.
 *
 * A demand ratio below 0.05 always returns zero. At every other table boundary,
 * equality advances to the next (higher-demand or higher-Na) interval because
 * the original VBA comparisons were all strict `<` comparisons.
 */
export function ganmacy(correctedN: number, demandRatio: number): number {
  assertFiniteNonNegative(correctedN, '補正N値 Na')
  assertFiniteNonNegative(demandRatio, '地震時せん断応力比')

  if (demandRatio < 0.05) return 0

  const band = GANMACY_BANDS.find(
    ({ upperDemandExclusive }) => demandRatio < upperDemandExclusive,
  )

  // The final, unbounded band guarantees a match.
  if (!band) return 0

  const thresholdIndex = band.correctedNThresholds.findIndex(
    (threshold) => correctedN < threshold,
  )
  return thresholdIndex < 0 ? 0 : STRAIN_PERCENT[thresholdIndex]!
}

export const cyclicShearStrainPercent = ganmacy

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label}は0以上の有限値である必要があります`)
  }
}
