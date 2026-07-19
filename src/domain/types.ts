export type Severity = 'info' | 'warning' | 'error'

export interface AnalysisMessage {
  code: string
  severity: Severity
  message: string
  path?: string
}

export type ValueSource = 'input' | 'estimated' | 'default' | 'measured' | 'legacy'

export interface ProvenancedNumber {
  value: number
  source: ValueSource
  reference?: string
}

export interface ProjectInfo {
  name: string
  description?: string
  location?: {
    latitude?: number
    longitude?: number
  }
}

export interface NValue {
  depthM: number
  n: number
  soilName?: string
}

export type SoilClass =
  | 'clay'
  | 'silt'
  | 'sand'
  | 'fine-sand'
  | 'medium-sand'
  | 'coarse-sand'
  | 'gravelly-sand'
  | 'gravel'
  | 'surface-soil'
  | 'fill'
  | 'organic'
  | 'rock'
  | 'other'

export type GeologicAge = 'alluvium' | 'diluvium' | 'unknown'

export interface ModulusReductionPoint {
  strain: number
  modulusRatio: number
  dampingRatio: number
}

export interface TestProvenance {
  reference: string
  method?: string
  testedOn?: string
  location?: string
}

export interface GroundLayer {
  id: string
  topDepthM: number
  bottomDepthM: number
  soilName: string
  soilClass: SoilClass
  geologicAge: GeologicAge
  densityKgM3: number
  finesPercent?: number
  nValue?: number
  vsMps?: number
  vsSource?: ValueSource
  vsProvenance?: TestProvenance
  modulusCurve?: ModulusReductionPoint[]
  modulusCurveProvenance?: TestProvenance
  improved?: boolean
}

export interface EngineeringBedrock {
  depthM: number
  densityKgM3: number
  vsMps: number
  thicknessM?: number
  inclinationDeg?: number
  investigationRadiusM?: number
}

export interface GroundModel {
  groundwaterDepthM: number
  improvementDepthM?: number
  nValues: NValue[]
  layers: GroundLayer[]
  engineeringBedrock: EngineeringBedrock
}

export type GroundType = 1 | 2 | 3
export type GsMode =
  | 'damage-simplified'
  | 'safety-simplified'
  | 'safety-precise'
  | 'legacy-damage-precise'
  | 'legacy-safety-precise'

export interface GsSettings {
  mode: GsMode
  groundType: GroundType
  groundTypeBasis: string
  regionFactorZ: number
  effectiveStrainFactor: number
  relativeTolerance: number
  absoluteTolerance: number
  maxIterations: number
}

export interface LiquefactionCaseSettings {
  id: 'damage-150gal' | 'safety-350gal'
  peakAccelerationGal: number
  magnitude: number
}

export interface AnalysisSettings {
  gs: GsSettings
  liquefactionCases: LiquefactionCaseSettings[]
  responseSpectrumDampingRatio: number
}

export interface SourceProvenance {
  sourceType: 'manual' | 'jiban-json' | 'legacy-xls' | 'csv'
  sourceFileName?: string
  sourceSha256?: string
  importedAt?: string
}

export interface JibanProject {
  schemaVersion: '1.0.0'
  appVersion: string
  project: ProjectInfo
  provenance: SourceProvenance
  method: {
    gs: 'jp-mlit-kokuji-1457-current' | 'legacy-workbook-compat'
    legalBasisCheckedOn: string
    liquefaction: 'legacy-aij-derived-screening-v1'
  }
  ground: GroundModel
  analysisSettings: AnalysisSettings
}

export interface GsCurvePoint {
  periodS: number
  gs: number
  baseSaMps2: number
  surfaceSaMps2: number
  svMps: number
  sdM: number
}

export interface GsIterationLayer {
  layerId: string
  strain: number
  modulusRatio: number
  dampingRatio: number
}

export interface GsIteration {
  iteration: number
  periodS: number
  relativeChange: number | null
  layers: GsIterationLayer[]
}

export interface GsResult {
  mode: GsMode
  converged: boolean
  t1S?: number
  t2S?: number
  alpha?: number
  dampingRatio?: number
  gs1?: number
  gs2?: number
  elasticPeriodS?: number
  curve: GsCurvePoint[]
  iterations: GsIteration[]
  applicability: ApplicabilityCheck[]
  messages: AnalysisMessage[]
}

export interface ApplicabilityCheck {
  id: string
  label: string
  status: 'pass' | 'fail' | 'not-assessed'
  detail: string
}

export interface LiquefactionLayerResult {
  layerId: string
  topDepthM: number
  bottomDepthM: number
  centerDepthM: number
  eligible: boolean
  n: number
  correctedN: number
  demandRatio: number
  resistanceRatio: number
  fl: number
  cyclicStrainPercent: number
  dcyContributionCm: number
  plContribution: number
  reason?: string
}

export interface LiquefactionCaseResult {
  caseId: LiquefactionCaseSettings['id']
  peakAccelerationGal: number
  magnitude: number
  dcyCm: number
  dcyClass: string
  pl: number
  plClass: string
  layers: LiquefactionLayerResult[]
  messages: AnalysisMessage[]
}

export interface MotionRecord {
  name: string
  accelerationUnit: 'm/s2' | 'gal' | 'g'
  timesS: number[]
  accelerations: number[]
}

export interface ResponseSpectrumPoint {
  periodS: number
  sdM: number
  svMps: number
  saMps2: number
}

export interface MotionResult {
  pgaMps2: number
  pgvMps: number
  pgdM: number
  timeStepS: number
  spectrum: ResponseSpectrumPoint[]
  messages: AnalysisMessage[]
}

export interface CalculationMetadata {
  gsMethodId: JibanProject['method']['gs']
  legalBasisCheckedOn: string
  vsCoefficientTableId: 'regulatory' | 'legacy-sheet'
  liquefactionMethodId: JibanProject['method']['liquefaction']
  responseSpectrumDampingRatio: number
  units: {
    length: 'm'
    acceleration: 'm/s2'
    velocity: 'm/s'
    density: 'kg/m3'
    stress: 'Pa'
  }
}

export interface AnalysisResult {
  resultVersion: '1.0.0'
  calculatedAt: string
  appVersion: string
  inputSha256: string
  metadata: CalculationMetadata
  gs: GsResult
  liquefaction: LiquefactionCaseResult[]
  motion?: MotionResult
  messages: AnalysisMessage[]
}
