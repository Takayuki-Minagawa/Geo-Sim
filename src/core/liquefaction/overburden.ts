import type { GroundLayer } from '../../domain/types'

export const WATER_DENSITY_KG_M3 = 1000
export const STANDARD_GRAVITY_M_S2 = 9.80665

export interface OverburdenStress {
  depthM: number
  totalStressTfM2: number
  effectiveStressTfM2: number
  porePressureTfM2: number
  totalStressKPa: number
  effectiveStressKPa: number
  porePressureKPa: number
}

/**
 * Integrates vertical overburden to `depthM`.
 *
 * Assumptions are explicit and independent of the old sheet's row layout:
 * - `densityKgM3` is the bulk density above groundwater and saturated bulk
 *   density below groundwater;
 * - groundwater is hydrostatic with water density 1,000 kg/m3;
 * - a layer crossing groundwater is split exactly at that boundary;
 * - the supplied layers must continuously cover the interval from GL to the
 *   requested depth (gaps and overlaps are input errors).
 *
 * The tf/m2 values are the numerical units used by the legacy N-value
 * correction. kPa values are returned for SI-facing diagnostics and reports.
 */
export function calculateOverburdenAtDepth(
  layers: readonly GroundLayer[],
  groundwaterDepthM: number,
  depthM: number,
): OverburdenStress {
  assertFiniteNonNegative(groundwaterDepthM, '地下水位深さ')
  assertFiniteNonNegative(depthM, '評価深さ')

  if (depthM === 0) {
    return createStressResult(0, 0, 0)
  }

  const sorted = [...layers].sort((left, right) => left.topDepthM - right.topDepthM)
  let cursor = 0
  let totalStressTfM2 = 0
  let effectiveStressTfM2 = 0
  const tolerance = 1e-9

  for (const layer of sorted) {
    validateLayer(layer)

    if (layer.bottomDepthM <= cursor + tolerance) {
      throw new RangeError(`層 ${layer.id} が先行層と重複しています`)
    }
    if (layer.topDepthM > cursor + tolerance && cursor < depthM - tolerance) {
      throw new RangeError(
        `GL-${cursor}m から GL-${layer.topDepthM}m の間に未定義区間があります`,
      )
    }
    if (layer.topDepthM < cursor - tolerance) {
      throw new RangeError(`層 ${layer.id} が先行層と重複しています`)
    }
    if (layer.topDepthM >= depthM) break

    const top = Math.max(layer.topDepthM, cursor)
    const bottom = Math.min(layer.bottomDepthM, depthM)
    const densityTfM3 = layer.densityKgM3 / 1000
    const aboveWaterBottom = Math.min(bottom, groundwaterDepthM)
    const aboveWaterThickness = Math.max(0, aboveWaterBottom - top)
    const belowWaterTop = Math.max(top, groundwaterDepthM)
    const belowWaterThickness = Math.max(0, bottom - belowWaterTop)

    totalStressTfM2 += densityTfM3 * (aboveWaterThickness + belowWaterThickness)
    effectiveStressTfM2 += densityTfM3 * aboveWaterThickness
    effectiveStressTfM2 +=
      (densityTfM3 - WATER_DENSITY_KG_M3 / 1000) * belowWaterThickness
    cursor = bottom

    if (cursor >= depthM - tolerance) break
  }

  if (cursor < depthM - tolerance) {
    throw new RangeError(`GL-${cursor}m 以深の層がなく、GL-${depthM}m の応力を計算できません`)
  }
  if (effectiveStressTfM2 <= 0) {
    throw new RangeError(`GL-${depthM}m の有効上載圧が0以下です`)
  }

  return createStressResult(depthM, totalStressTfM2, effectiveStressTfM2)
}

function createStressResult(
  depthM: number,
  totalStressTfM2: number,
  effectiveStressTfM2: number,
): OverburdenStress {
  const porePressureTfM2 = totalStressTfM2 - effectiveStressTfM2
  const tfM2ToKPa = STANDARD_GRAVITY_M_S2
  return {
    depthM,
    totalStressTfM2,
    effectiveStressTfM2,
    porePressureTfM2,
    totalStressKPa: totalStressTfM2 * tfM2ToKPa,
    effectiveStressKPa: effectiveStressTfM2 * tfM2ToKPa,
    porePressureKPa: porePressureTfM2 * tfM2ToKPa,
  }
}

function validateLayer(layer: GroundLayer): void {
  assertFiniteNonNegative(layer.topDepthM, `層 ${layer.id} の上端深さ`)
  assertFiniteNonNegative(layer.bottomDepthM, `層 ${layer.id} の下端深さ`)
  if (layer.bottomDepthM <= layer.topDepthM) {
    throw new RangeError(`層 ${layer.id} の層厚が0以下です`)
  }
  if (!Number.isFinite(layer.densityKgM3) || layer.densityKgM3 <= 0) {
    throw new RangeError(`層 ${layer.id} の密度が0より大きい有限値ではありません`)
  }
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label}は0以上の有限値である必要があります`)
  }
}
