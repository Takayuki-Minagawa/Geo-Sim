export interface SymmetricEigenOptions {
  tolerance?: number
  symmetryTolerance?: number
  maxSweeps?: number
}

export interface SymmetricEigenResult {
  /** Eigenvalues sorted in ascending order. */
  eigenvalues: number[]
  /** Corresponding unit eigenvectors; `eigenvectors[mode][dof]`. */
  eigenvectors: number[][]
  iterations: number
  converged: boolean
  maxOffDiagonal: number
}

export interface GeneralizedEigenResult {
  omegaSquared: number[]
  angularFrequenciesRadS: number[]
  periodsS: number[]
  /** Mass-normalized physical modes; `modes[mode][dof]`. */
  modes: number[][]
  iterations: number
  converged: boolean
}

function assertSquareFiniteMatrix(matrix: readonly (readonly number[])[], label: string): number {
  const n = matrix.length
  if (n === 0) throw new RangeError(`${label} must not be empty`)
  if (n > 64) throw new RangeError(`${label} exceeds the supported small-matrix limit (64)`)
  for (const [rowIndex, row] of matrix.entries()) {
    if (row.length !== n) throw new RangeError(`${label}[${rowIndex}] is not square`)
    for (const value of row) {
      if (!Number.isFinite(value)) throw new RangeError(`${label} contains a non-finite value`)
    }
  }
  return n
}

function identity(size: number): number[][] {
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_unused, column) => (row === column ? 1 : 0)),
  )
}

function vectorNorm(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
}

/**
 * Jacobi rotations for real symmetric matrices. The target models have at most
 * a few dozen layers, so this dependency-free O(n^3) method is deterministic
 * and easier to audit than a general dense eigensolver.
 */
export function solveSymmetricEigen(
  input: readonly (readonly number[])[],
  options: SymmetricEigenOptions = {},
): SymmetricEigenResult {
  const n = assertSquareFiniteMatrix(input, 'matrix')
  const tolerance = options.tolerance ?? 1e-12
  const symmetryTolerance = options.symmetryTolerance ?? 1e-10
  const maxSweeps = options.maxSweeps ?? Math.max(20, 12 * n * n)
  if (!(tolerance > 0) || !(symmetryTolerance >= 0) || !(maxSweeps >= 1)) {
    throw new RangeError('Invalid eigensolver options')
  }

  const matrix = input.map((row) => [...row])
  let scale = 0
  for (let row = 0; row < n; row += 1) {
    for (let column = 0; column < n; column += 1) {
      scale = Math.max(scale, Math.abs(matrix[row]![column]!))
    }
  }
  for (let row = 0; row < n; row += 1) {
    for (let column = row + 1; column < n; column += 1) {
      const difference = Math.abs(matrix[row]![column]! - matrix[column]![row]!)
      if (difference > symmetryTolerance * Math.max(1, scale)) {
        throw new RangeError('matrix must be symmetric')
      }
      const mean = (matrix[row]![column]! + matrix[column]![row]!) / 2
      matrix[row]![column] = mean
      matrix[column]![row] = mean
    }
  }

  const vectors = identity(n)
  let maxOffDiagonal = Number.POSITIVE_INFINITY
  let iteration = 0

  for (; iteration < maxSweeps; iteration += 1) {
    let p = 0
    let q = 0
    maxOffDiagonal = 0
    for (let row = 0; row < n; row += 1) {
      for (let column = row + 1; column < n; column += 1) {
        const magnitude = Math.abs(matrix[row]![column]!)
        if (magnitude > maxOffDiagonal) {
          maxOffDiagonal = magnitude
          p = row
          q = column
        }
      }
    }

    const diagonalScale = Math.max(
      1,
      ...Array.from({ length: n }, (_, index) => Math.abs(matrix[index]![index]!)),
    )
    if (maxOffDiagonal <= tolerance * diagonalScale || n === 1) break

    const app = matrix[p]![p]!
    const aqq = matrix[q]![q]!
    const apq = matrix[p]![q]!
    const angle = 0.5 * Math.atan2(2 * apq, aqq - app)
    const cosine = Math.cos(angle)
    const sine = Math.sin(angle)

    for (let k = 0; k < n; k += 1) {
      if (k === p || k === q) continue
      const akp = matrix[k]![p]!
      const akq = matrix[k]![q]!
      const rotatedP = cosine * akp - sine * akq
      const rotatedQ = sine * akp + cosine * akq
      matrix[k]![p] = rotatedP
      matrix[p]![k] = rotatedP
      matrix[k]![q] = rotatedQ
      matrix[q]![k] = rotatedQ
    }
    matrix[p]![p] = cosine * cosine * app - 2 * sine * cosine * apq + sine * sine * aqq
    matrix[q]![q] = sine * sine * app + 2 * sine * cosine * apq + cosine * cosine * aqq
    matrix[p]![q] = 0
    matrix[q]![p] = 0

    for (let row = 0; row < n; row += 1) {
      const vip = vectors[row]![p]!
      const viq = vectors[row]![q]!
      vectors[row]![p] = cosine * vip - sine * viq
      vectors[row]![q] = sine * vip + cosine * viq
    }
  }

  if (n === 1) maxOffDiagonal = 0
  const pairs = Array.from({ length: n }, (_, index) => {
    const vector = vectors.map((row) => row[index]!)
    const norm = vectorNorm(vector)
    if (!(norm > 0)) throw new Error('eigensolver produced a zero eigenvector')
    const normalized = vector.map((value) => value / norm)
    const pivot = normalized.find((value) => Math.abs(value) > 1e-14)
    return {
      value: matrix[index]![index]!,
      vector: pivot !== undefined && pivot < 0 ? normalized.map((value) => -value) : normalized,
    }
  }).sort((left, right) => left.value - right.value)

  const diagonalScale = Math.max(
    1,
    ...Array.from({ length: n }, (_, index) => Math.abs(matrix[index]![index]!)),
  )
  return {
    eigenvalues: pairs.map((pair) => pair.value),
    eigenvectors: pairs.map((pair) => pair.vector),
    iterations: iteration,
    converged: maxOffDiagonal <= tolerance * diagonalScale,
    maxOffDiagonal,
  }
}

/** Solve K phi = omega^2 M phi for a positive diagonal lumped mass matrix. */
export function solveGeneralizedSymmetricEigen(
  stiffness: readonly (readonly number[])[],
  diagonalMass: readonly number[],
  options: SymmetricEigenOptions = {},
): GeneralizedEigenResult {
  const n = assertSquareFiniteMatrix(stiffness, 'stiffness')
  if (diagonalMass.length !== n) throw new RangeError('mass vector size does not match stiffness')
  for (const mass of diagonalMass) {
    if (!Number.isFinite(mass) || mass <= 0) {
      throw new RangeError('all lumped masses must be positive finite values')
    }
  }

  const transformed = stiffness.map((row, rowIndex) =>
    row.map(
      (value, columnIndex) =>
        value / Math.sqrt(diagonalMass[rowIndex]! * diagonalMass[columnIndex]!),
    ),
  )
  const solved = solveSymmetricEigen(transformed, options)
  const positivityTolerance = (options.tolerance ?? 1e-12) * Math.max(1, ...solved.eigenvalues.map(Math.abs))

  const modes = solved.eigenvectors.map((massWeightedMode, modeIndex) => {
    const omegaSquared = solved.eigenvalues[modeIndex]!
    if (!(omegaSquared > positivityTolerance)) {
      throw new RangeError('stiffness is not positive definite')
    }
    let physical = massWeightedMode.map(
      (value, dof) => value / Math.sqrt(diagonalMass[dof]!),
    )
    const modalMass = physical.reduce(
      (sum, value, dof) => sum + diagonalMass[dof]! * value * value,
      0,
    )
    physical = physical.map((value) => value / Math.sqrt(modalMass))
    // A stable sign convention makes iteration histories exactly reproducible.
    if (physical[physical.length - 1]! < 0) physical = physical.map((value) => -value)
    return physical
  })

  const angularFrequenciesRadS = solved.eigenvalues.map(Math.sqrt)
  return {
    omegaSquared: solved.eigenvalues,
    angularFrequenciesRadS,
    periodsS: angularFrequenciesRadS.map((omega) => (2 * Math.PI) / omega),
    modes,
    iterations: solved.iterations,
    converged: solved.converged,
  }
}

export function isSymmetricMatrix(
  matrix: readonly (readonly number[])[],
  tolerance = 1e-10,
): boolean {
  if (matrix.length === 0 || matrix.some((row) => row.length !== matrix.length)) return false
  let scale = 1
  for (const row of matrix) for (const value of row) scale = Math.max(scale, Math.abs(value))
  for (let row = 0; row < matrix.length; row += 1) {
    for (let column = row + 1; column < matrix.length; column += 1) {
      if (Math.abs(matrix[row]![column]! - matrix[column]![row]!) > tolerance * scale) {
        return false
      }
    }
  }
  return true
}
