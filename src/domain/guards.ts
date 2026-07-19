export function assertFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be finite`)
  }
  return value
}

export function assertRange(value: number, min: number, max: number, label: string): number {
  assertFinite(value, label)
  if (value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`)
  }
  return value
}
