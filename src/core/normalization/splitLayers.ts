import type { AnalysisMessage, GroundLayer, GroundModel } from '../../domain/types'

const EPSILON = 1e-9

export interface NormalizedGround {
  ground: GroundModel
  clippedGround: GroundModel
  messages: AnalysisMessage[]
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values.map((value) => Math.round(value * 1e9) / 1e9))].sort((a, b) => a - b)
}

function validateInputLayers(layers: GroundLayer[]): AnalysisMessage[] {
  const messages: AnalysisMessage[] = []
  if (layers.length === 0) {
    return [
      {
        code: 'LAYER_MODEL_EMPTY',
        severity: 'error',
        path: 'ground.layers',
        message: '工学的基盤より上に解析対象の地層がありません',
      },
    ]
  }
  let previousBottom = 0
  for (const [index, layer] of layers.entries()) {
    if (layer.bottomDepthM <= layer.topDepthM + EPSILON) {
      messages.push({
        code: 'LAYER_NON_POSITIVE_THICKNESS',
        severity: 'error',
        path: `ground.layers[${index}]`,
        message: `${layer.id} の層厚が正ではありません`,
      })
    }
    if (Math.abs(layer.topDepthM - previousBottom) > EPSILON) {
      messages.push({
        code: 'LAYER_NOT_CONTIGUOUS',
        severity: 'error',
        path: `ground.layers[${index}]`,
        message: `${layer.id} の上端と前層下端が連続していません`,
      })
    }
    previousBottom = layer.bottomDepthM
  }
  return messages
}

export function normalizeGroundModel(model: GroundModel): NormalizedGround {
  const bedrockDepthM = model.engineeringBedrock.depthM
  const relevantLayers = model.layers
    .filter((layer) => layer.topDepthM < bedrockDepthM)
    .map((layer) => ({
      ...structuredClone(layer),
      bottomDepthM: Math.min(layer.bottomDepthM, bedrockDepthM),
    }))
  const clippedGround = { ...structuredClone(model), layers: relevantLayers }
  const messages = validateInputLayers(relevantLayers)
  if (messages.some((message) => message.severity === 'error')) {
    return {
      ground: structuredClone(clippedGround),
      clippedGround,
      messages,
    }
  }

  const boundaries = uniqueSorted([
    0,
    model.groundwaterDepthM,
    model.improvementDepthM ?? -1,
    20,
    model.engineeringBedrock.depthM,
  ]).filter((value) => value >= 0 && value <= model.engineeringBedrock.depthM)

  const normalized: GroundLayer[] = []
  for (const layer of relevantLayers) {
    const bottom = layer.bottomDepthM
    if (bottom <= layer.topDepthM + EPSILON) continue

    const cuts = uniqueSorted([
      layer.topDepthM,
      bottom,
      ...boundaries.filter(
        (boundary) => boundary > layer.topDepthM + EPSILON && boundary < bottom - EPSILON,
      ),
    ])
    for (let index = 0; index < cuts.length - 1; index += 1) {
      const topDepthM = cuts[index]
      const bottomDepthM = cuts[index + 1]
      if (topDepthM === undefined || bottomDepthM === undefined) continue
      normalized.push({
        ...structuredClone(layer),
        id: cuts.length > 2 ? `${layer.id}:${index + 1}` : layer.id,
        topDepthM,
        bottomDepthM,
        improved:
          Boolean(layer.improved) ||
          (model.improvementDepthM !== undefined &&
            bottomDepthM <= model.improvementDepthM + EPSILON),
      })
    }
  }

  const normalizedBottomDepthM = normalized.at(-1)?.bottomDepthM
  if (
    normalizedBottomDepthM === undefined ||
    Math.abs(normalizedBottomDepthM - model.engineeringBedrock.depthM) > EPSILON
  ) {
    messages.push({
      code: 'LAYERS_DO_NOT_REACH_BEDROCK',
      severity: 'warning',
      message: '表層地盤の最下端が工学的基盤深さと一致しません',
    })
  }

  return {
    ground: { ...structuredClone(model), layers: normalized },
    clippedGround,
    messages,
  }
}
