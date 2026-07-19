import { describe, expect, it } from 'vitest'
import {
  isSymmetricMatrix,
  solveGeneralizedSymmetricEigen,
  solveSymmetricEigen,
} from '../../src/core/eigen'

function residualNorm(matrix: number[][], eigenvalue: number, vector: number[]): number {
  return Math.sqrt(
    matrix.reduce((sum, row, index) => {
      const residual =
        row.reduce((value, coefficient, column) => value + coefficient * vector[column]!, 0) -
        eigenvalue * vector[index]!
      return sum + residual * residual
    }, 0),
  )
}

describe('symmetric Jacobi eigensolver', () => {
  it('solves and sorts a known 2x2 matrix', () => {
    const matrix = [
      [2, 1],
      [1, 2],
    ]
    const result = solveSymmetricEigen(matrix)
    expect(result.converged).toBe(true)
    expect(result.eigenvalues[0]).toBeCloseTo(1, 12)
    expect(result.eigenvalues[1]).toBeCloseTo(3, 12)
    result.eigenvectors.forEach((vector, index) => {
      expect(residualNorm(matrix, result.eigenvalues[index]!, vector)).toBeLessThan(1e-10)
    })
  })

  it('handles a one degree-of-freedom system', () => {
    expect(solveSymmetricEigen([[4]])).toMatchObject({
      eigenvalues: [4],
      eigenvectors: [[1]],
      converged: true,
    })
  })

  it('rejects nonsymmetric and nonfinite matrices', () => {
    expect(() =>
      solveSymmetricEigen([
        [1, 1],
        [0, 1],
      ]),
    ).toThrow(/symmetric/)
    expect(() => solveSymmetricEigen([[Number.NaN]])).toThrow(/non-finite/)
  })
})

describe('generalized symmetric eigensolver', () => {
  it('solves Kφ=ω²Mφ and mass-normalizes the modes', () => {
    const result = solveGeneralizedSymmetricEigen([[800]], [2])
    expect(result.omegaSquared[0]).toBeCloseTo(400, 12)
    expect(result.periodsS[0]).toBeCloseTo((2 * Math.PI) / 20, 12)
    expect(result.modes[0]![0]).toBeCloseTo(1 / Math.sqrt(2), 12)
  })

  it('rejects rigid-body and negative-mass systems', () => {
    expect(() => solveGeneralizedSymmetricEigen([[0]], [1])).toThrow(/positive definite/)
    expect(() => solveGeneralizedSymmetricEigen([[1]], [-1])).toThrow(/masses/)
  })

  it('exposes a scale-aware symmetry check', () => {
    expect(
      isSymmetricMatrix([
        [2, -1],
        [-1, 1],
      ]),
    ).toBe(true)
    expect(
      isSymmetricMatrix([
        [2, -1],
        [-0.9, 1],
      ]),
    ).toBe(false)
  })
})
