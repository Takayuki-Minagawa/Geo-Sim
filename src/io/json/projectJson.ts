import type { ErrorObject, ValidateFunction } from 'ajv'
import generatedValidate from '../../generated/validateJibanProject.js'
import type { AnalysisResult, JibanProject } from '../../domain/types'

const validate = generatedValidate as ValidateFunction<JibanProject>

const encoder = new TextEncoder()

export class ProjectValidationError extends Error {
  readonly details: string[]

  constructor(details: string[]) {
    super(`案件JSONがスキーマに適合しません: ${details.join('; ')}`)
    this.name = 'ProjectValidationError'
    this.details = details
  }
}

function validateLayerOrder(project: JibanProject): string[] {
  const errors: string[] = []
  let previousBottom = 0
  const layerIds = new Set<string>()
  for (const [index, layer] of project.ground.layers.entries()) {
    if (layer.bottomDepthM <= layer.topDepthM) {
      errors.push(`ground.layers[${index}] の層厚が正ではありません`)
    }
    if (Math.abs(layer.topDepthM - previousBottom) > 1e-8) {
      errors.push(`ground.layers[${index}] の上端が前層下端と連続していません`)
    }
    if (layer.bottomDepthM > project.ground.engineeringBedrock.depthM + 1e-8) {
      errors.push(`ground.layers[${index}] が工学的基盤より深くまで定義されています`)
    }
    if (layerIds.has(layer.id)) {
      errors.push(`ground.layers[${index}] のID「${layer.id}」が重複しています`)
    }
    layerIds.add(layer.id)
    previousBottom = layer.bottomDepthM
  }
  if (project.ground.groundwaterDepthM > project.ground.engineeringBedrock.depthM) {
    errors.push('ground.groundwaterDepthM が工学的基盤より深く設定されています')
  }
  if (
    project.ground.improvementDepthM !== undefined &&
    project.ground.improvementDepthM > project.ground.engineeringBedrock.depthM
  ) {
    errors.push('ground.improvementDepthM が工学的基盤より深く設定されています')
  }
  const legacyMode = project.analysisSettings.gs.mode.startsWith('legacy')
  const expectedMethod = legacyMode
    ? 'legacy-workbook-compat'
    : 'jp-mlit-kokuji-1457-current'
  if (project.method.gs !== expectedMethod) {
    errors.push(`method.gs と analysisSettings.gs.mode の現行/旧互換区分が一致しません`)
  }
  const caseIds = new Set(project.analysisSettings.liquefactionCases.map(({ id }) => id))
  if (caseIds.size !== project.analysisSettings.liquefactionCases.length) {
    errors.push('analysisSettings.liquefactionCases のケースIDが重複しています')
  }
  return errors
}

export function assertValidProject(value: unknown): asserts value is JibanProject {
  const valid = validate(value)
  const errors = valid
    ? []
    : (validate.errors ?? []).map(
        (error: ErrorObject) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`,
      )
  if (valid) {
    errors.push(...validateLayerOrder(value))
  }
  if (errors.length > 0) {
    throw new ProjectValidationError(errors)
  }
}

export function parseProjectJson(text: string): JibanProject {
  if (encoder.encode(text).byteLength > 10 * 1024 * 1024) {
    throw new ProjectValidationError(['ファイルサイズが10 MiBを超えています'])
  }
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch (error) {
    throw new ProjectValidationError([
      `JSONを解析できません: ${error instanceof Error ? error.message : String(error)}`,
    ])
  }
  const candidate =
    value !== null &&
    typeof value === 'object' &&
    'project' in value &&
    !('schemaVersion' in value)
      ? value.project
      : value
  assertValidProject(candidate)
  return candidate
}

export function serializeProject(project: JibanProject): string {
  assertValidProject(project)
  return `${JSON.stringify(project, null, 2)}\n`
}

export function serializeResultBundle(project: JibanProject, result: AnalysisResult): string {
  assertValidProject(project)
  return `${JSON.stringify({ project, result }, null, 2)}\n`
}

export async function sha256Text(text: string): Promise<string> {
  return sha256Buffer(encoder.encode(text))
}

export async function sha256Buffer(buffer: BufferSource): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function hashProject(project: JibanProject): Promise<string> {
  return sha256Text(serializeProject(project))
}
