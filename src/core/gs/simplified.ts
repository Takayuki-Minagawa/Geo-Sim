import type { GroundType } from '../../domain/types'

export const SIMPLIFIED_GS_BOUNDARIES_S = Object.freeze({
  type1Rise: 0.576,
  commonCorner: 0.64,
  type2Plateau: 0.864,
  type3Plateau: 1.152,
})

/** Exact branch rules from Notification 1457, including equality at corners. */
export function calculateSimplifiedGs(periodS: number, groundType: GroundType): number {
  if (!Number.isFinite(periodS) || periodS < 0) {
    throw new RangeError('periodS must be a finite value greater than or equal to zero')
  }
  if (groundType !== 1 && groundType !== 2 && groundType !== 3) {
    throw new RangeError('groundType must be 1, 2, or 3')
  }

  if (groundType === 1) {
    if (periodS < SIMPLIFIED_GS_BOUNDARIES_S.type1Rise) return 1.5
    if (periodS < SIMPLIFIED_GS_BOUNDARIES_S.commonCorner) return 0.864 / periodS
    return 1.35
  }

  const plateau = groundType === 2 ? 2.025 : 2.7
  const upperCorner = (SIMPLIFIED_GS_BOUNDARIES_S.commonCorner * plateau) / 1.5
  if (periodS < SIMPLIFIED_GS_BOUNDARIES_S.commonCorner) return 1.5
  if (periodS < upperCorner) {
    return (1.5 * periodS) / SIMPLIFIED_GS_BOUNDARIES_S.commonCorner
  }
  return plateau
}
