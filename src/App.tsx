import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import { createDefaultProject } from './domain/defaultProject'
import type {
  AnalysisMessage,
  AnalysisResult,
  GroundLayer,
  GsMode,
  JibanProject,
  MotionRecord,
  SoilClass,
} from './domain/types'
import { exportLayersCsv, exportNValuesCsv, importLayersCsv, importNValuesCsv } from './io/csv/csv'
import { detectCsvKind } from './io/csv/detectCsvKind'
import type { CsvKind } from './io/csv/detectCsvKind'
import { exportMotionCsv, importMotionCsv } from './io/csv/motionCsv'
import { exportModulusCurveCsv, parseModulusCurveCsv } from './io/csv/modulusCurveCsv'
import {
  exportGsResultCsv,
  exportLiquefactionResultCsv,
  exportMotionSpectrumCsv,
} from './io/csv/resultsCsv'
import { downloadTextFile } from './io/download'
import { assertValidProject, hashProject, parseProjectJson, serializeProject, serializeResultBundle, sha256Buffer } from './io/json/projectJson'
import { decodeUploadedText, readUploadedText } from './io/textEncoding'
import { analyzeInWorker } from './worker/workerClient'
import { Chart } from './ui/components/Chart'
import { ManualDialog } from './ui/components/ManualDialog'
import { Metric } from './ui/components/Metric'
import { StatusMessages } from './ui/components/StatusMessages'
import {
  applicabilityDetail,
  applicabilityLabel,
  classificationLabel,
  copies,
  gsModeLabel,
  soilClassLabel,
  sourceTypeLabel,
  valueSourceLabel,
} from './ui/i18n'
import type { Locale, ThemeMode, UiCopy } from './ui/i18n'
import { gsChartOption, motionChartOption, nValueChartOption, spectrumChartOption } from './ui/options'
import './styles.css'

type TabId = 'project' | 'ground' | 'applicability' | 'gs' | 'liquefaction' | 'motion' | 'report'

const tabs: { id: TabId; labelKey: keyof UiCopy; short: string }[] = [
  { id: 'project', labelKey: 'tabProject', short: '01' },
  { id: 'ground', labelKey: 'tabGround', short: '02' },
  { id: 'applicability', labelKey: 'tabApplicability', short: '03' },
  { id: 'gs', labelKey: 'tabGs', short: '04' },
  { id: 'liquefaction', labelKey: 'tabLiquefaction', short: '05' },
  { id: 'motion', labelKey: 'tabMotion', short: '06' },
  { id: 'report', labelKey: 'tabReport', short: '07' },
]

function cloneUpdate(project: JibanProject, update: (draft: JibanProject) => void): JibanProject {
  const draft = structuredClone(project)
  update(draft)
  return draft
}

function Panel({ title, eyebrow, children }: { title: string; eyebrow?: string; children: ReactNode }) {
  return (
    <section className="panel">
      {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
      <h2>{title}</h2>
      {children}
    </section>
  )
}

function format(value: number | undefined, digits = 3): string {
  return value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits)
}

function encodingMessages(warnings: string[]): AnalysisMessage[] {
  return warnings.map((message, index) => ({
    code: index === 0 ? 'FILE_ENCODING_DETECTED' : `FILE_ENCODING_WARNING_${index + 1}`,
    severity: message.includes('U+FFFD') ? 'warning' : 'info',
    message,
  }))
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'AbortError'
  )
}

function storedPreference<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = window.localStorage.getItem(key)
    return value !== null && allowed.includes(value as T) ? (value as T) : fallback
  } catch {
    return fallback
  }
}

function ModulusCurveEditor({
  layer,
  locale,
  onChange,
}: {
  layer: GroundLayer
  locale: Locale
  onChange: (patch: Partial<GroundLayer>) => void
}) {
  const copy = copies[locale]
  const serialized = exportModulusCurveCsv(layer.modulusCurve ?? []).replace(/^\uFEFF/, '')
  const [text, setText] = useState(serialized)
  const [error, setError] = useState<string | null>(null)

  const apply = () => {
    try {
      onChange({ modulusCurve: parseModulusCurveCsv(text) })
      setError(null)
    } catch (cause) {
      setError(
        locale === 'ja'
          ? cause instanceof Error
            ? cause.message
            : String(cause)
          : 'The curve could not be applied. Check the CSV columns and numeric values.',
      )
    }
  }

  return (
    <div className="curve-editor">
      <h4>{layer.id} / {layer.soilName}</h4>
      <label>{copy.curvePoints}<textarea aria-label={`${layer.id} ${copy.nonlinearSummary}`} value={text} onChange={(event) => setText(event.target.value)} /></label>
      <div className="curve-provenance">
        <label>{copy.testReference}<input value={layer.modulusCurveProvenance?.reference ?? ''} onChange={(event) => onChange({ modulusCurveProvenance: event.target.value === '' ? undefined : { ...layer.modulusCurveProvenance, reference: event.target.value } })} /></label>
        <label>{copy.testMethod}<input value={layer.modulusCurveProvenance?.method ?? ''} onChange={(event) => onChange({ modulusCurveProvenance: { reference: layer.modulusCurveProvenance?.reference ?? copy.recordRequired, ...layer.modulusCurveProvenance, method: event.target.value || undefined } })} /></label>
      </div>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <button className="button button-ghost" type="button" onClick={apply}>{copy.applyCurve}</button>
    </div>
  )
}

export default function App() {
  const [locale, setLocale] = useState<Locale>(() =>
    storedPreference('geo-sim-locale', ['ja', 'en'], 'ja'),
  )
  const [theme, setTheme] = useState<ThemeMode>(() =>
    storedPreference('geo-sim-theme', ['light', 'dark'], 'light'),
  )
  const [manualOpen, setManualOpen] = useState(false)
  const [project, setProject] = useState<JibanProject>(() => createDefaultProject())
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [motion, setMotion] = useState<MotionRecord | null>(null)
  const [motionUnit, setMotionUnit] = useState<MotionRecord['accelerationUnit']>('gal')
  const [messages, setMessages] = useState<AnalysisMessage[]>([])
  const [tab, setTab] = useState<TabId>('project')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const cancelRef = useRef<(() => void) | null>(null)
  const inputRevisionRef = useRef(0)
  const copy = copies[locale]

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = copy.documentTitle
    try {
      window.localStorage.setItem('geo-sim-locale', locale)
    } catch {
      // The preference remains available for this session when storage is disabled.
    }
  }, [copy.documentTitle, locale])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      'content',
      theme === 'dark' ? '#071c20' : '#0c3035',
    )
    try {
      window.localStorage.setItem('geo-sim-theme', theme)
    } catch {
      // The preference remains available for this session when storage is disabled.
    }
  }, [theme])

  const invalidateResult = useCallback(() => {
    inputRevisionRef.current += 1
    setResult(null)
  }, [])

  const replaceProject = useCallback(
    (nextProject: JibanProject) => {
      invalidateResult()
      setProject(nextProject)
    },
    [invalidateResult],
  )

  const updateProject = useCallback(
    (update: (draft: JibanProject) => void) => {
      invalidateResult()
      setProject((current) => cloneUpdate(current, update))
    },
    [invalidateResult],
  )

  const replaceMotion = useCallback(
    (nextMotion: MotionRecord) => {
      invalidateResult()
      setMotion(nextMotion)
    },
    [invalidateResult],
  )

  const allMessages = useMemo(
    () => [...messages, ...(result?.messages ?? []), ...(result?.gs.messages ?? [])],
    [messages, result],
  )

  const importFile = useCallback(
    async (file: File, forcedCsvKind?: CsvKind) => {
      setMessages([])
      try {
        const lower = file.name.toLowerCase()
        if (lower.endsWith('.json')) {
          const buffer = await file.arrayBuffer()
          const decoded = decodeUploadedText(buffer)
          const text = decoded.text
          const imported = parseProjectJson(text)
          imported.provenance.sourceType = 'jiban-json'
          imported.provenance.sourceFileName = file.name
          imported.provenance.sourceSha256 = await sha256Buffer(buffer)
          replaceProject(imported)
          setMessages(encodingMessages(decoded.warnings))
          return
        }
        if (lower.endsWith('.xls') || lower.endsWith('.xlsx')) {
          const buffer = await file.arrayBuffer()
          const { importLegacyXls } = await import('./io/legacy-xls/importLegacyXls')
          const imported = importLegacyXls(buffer, file.name)
          imported.project.provenance.sourceSha256 = await sha256Buffer(buffer)
          replaceProject(imported.project)
          setMessages(imported.messages)
          return
        }
        if (lower.endsWith('.csv')) {
          const decoded = await readUploadedText(file)
          const kind = forcedCsvKind ?? detectCsvKind(decoded.text)
          if (kind === 'motion') {
            replaceMotion(importMotionCsv(decoded.text, file.name, motionUnit))
          } else if (kind === 'layers') {
            const importedProject = cloneUpdate(project, (draft) => {
              draft.ground.layers = importLayersCsv(decoded.text)
              draft.provenance = { sourceType: 'csv', sourceFileName: file.name }
            })
            assertValidProject(importedProject)
            replaceProject(importedProject)
          } else {
            const importedProject = cloneUpdate(project, (draft) => {
              draft.ground.nValues = importNValuesCsv(decoded.text)
              draft.provenance = { sourceType: 'csv', sourceFileName: file.name }
            })
            assertValidProject(importedProject)
            replaceProject(importedProject)
          }
          setMessages(encodingMessages(decoded.warnings))
          return
        }
        throw new Error('対応形式は .jiban.json / .xls / .xlsx / .csv です')
      } catch (error) {
        setMessages([
          {
            code: 'FILE_IMPORT_FAILED',
            severity: 'error',
            message: error instanceof Error ? error.message : String(error),
          },
        ])
      }
    },
    [motionUnit, project, replaceMotion, replaceProject],
  )

  const onFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      if (file) void importFile(file)
      event.target.value = ''
    },
    [importFile],
  )

  const onMotionFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      if (file) void importFile(file, 'motion')
      event.target.value = ''
    },
    [importFile],
  )

  const runAnalysis = useCallback(async () => {
    const inputRevision = inputRevisionRef.current
    setBusy(true)
    setProgress(0)
    setMessages([])
    try {
      const inputSha256 = await hashProject(project)
      const task = analyzeInWorker(project, motion, inputSha256, setProgress)
      cancelRef.current = task.cancel
      const nextResult = await task.promise
      if (inputRevisionRef.current !== inputRevision) {
        setMessages([
          {
            code: 'ANALYSIS_INPUT_CHANGED',
            severity: 'warning',
            message: '解析中に入力が変更されたため、完了した結果を破棄しました。再解析してください。',
          },
        ])
        return
      }
      setResult(nextResult)
      setTab('gs')
    } catch (error) {
      if (isAbortError(error)) {
        setMessages([
          {
            code: 'ANALYSIS_CANCELLED',
            severity: 'info',
            message: '解析を取り消しました。',
          },
        ])
        return
      }
      setMessages([
        {
          code: 'ANALYSIS_FAILED',
          severity: 'error',
          message: error instanceof Error ? error.message : String(error),
        },
      ])
    } finally {
      cancelRef.current = null
      setBusy(false)
    }
  }, [motion, project])

  const setLayer = useCallback((index: number, patch: Partial<GroundLayer>) => {
    updateProject((draft) => {
      Object.assign(draft.ground.layers[index]!, patch)
    })
  }, [updateProject])

  const setGroundValue = useCallback(
    (key: 'groundwaterDepthM' | 'improvementDepthM', value: number | undefined) => {
      updateProject((draft) => {
        if (key === 'groundwaterDepthM' && value !== undefined) {
          draft.ground.groundwaterDepthM = value
        } else if (key === 'improvementDepthM') {
          draft.ground.improvementDepthM = value
        }
      })
    },
    [updateProject],
  )

  const setBedrockValue = useCallback(
    (key: keyof JibanProject['ground']['engineeringBedrock'], value: number | undefined) => {
      updateProject((draft) => {
        if (value === undefined) {
          if (
            key === 'thicknessM' ||
            key === 'inclinationDeg' ||
            key === 'investigationRadiusM'
          ) {
            delete draft.ground.engineeringBedrock[key]
          }
          return
        }
        draft.ground.engineeringBedrock[key] = value
      })
    },
    [updateProject],
  )

  const saveProjectJson = useCallback(() => {
    try {
      downloadTextFile(
        `${project.project.name}.jiban.json`,
        serializeProject(project),
        'application/json',
      )
    } catch (error) {
      setMessages([
        {
          code: 'PROJECT_EXPORT_FAILED',
          severity: 'error',
          message: error instanceof Error ? error.message : String(error),
        },
      ])
    }
  }, [project])

  const saveResultJson = useCallback(async () => {
    if (!result) return
    try {
      const currentInputSha256 = await hashProject(project)
      if (currentInputSha256 !== result.inputSha256) {
        throw new Error('現在の入力と解析結果が一致しません。再解析してください。')
      }
      downloadTextFile(
        `${project.project.name}-result.json`,
        serializeResultBundle(project, result),
        'application/json',
      )
    } catch (error) {
      setMessages([
        {
          code: 'RESULT_EXPORT_FAILED',
          severity: 'error',
          message: error instanceof Error ? error.message : String(error),
        },
      ])
    }
  }, [project, result])

  const nValueOption = useMemo(
    () => nValueChartOption(project.ground, locale, theme),
    [locale, project.ground, theme],
  )
  const gsOption = useMemo(() => gsChartOption(result, locale, theme), [locale, result, theme])
  const spectrumOption = useMemo(
    () => spectrumChartOption(result, locale, theme),
    [locale, result, theme],
  )
  const motionOption = useMemo(
    () => motionChartOption(motion, locale, theme),
    [locale, motion, theme],
  )

  return (
    <div className="app-shell" data-theme={theme}>
      <header className="topbar">
        <div>
          <p className="brand-kicker">{copy.brandKicker}</p>
          <h1>{copy.appTitle}</h1>
        </div>
        <div className="top-actions">
          <div aria-label={copy.preferencesLabel} className="preference-actions" role="group">
            <button
              aria-label={copy.switchLanguage}
              className="button button-utility"
              onClick={() => setLocale((current) => (current === 'ja' ? 'en' : 'ja'))}
              type="button"
            >
              {locale === 'ja' ? 'English' : '日本語'}
            </button>
            <button
              aria-pressed={theme === 'dark'}
              className="button button-utility"
              onClick={() => setTheme((current) => (current === 'light' ? 'dark' : 'light'))}
              type="button"
            >
              {theme === 'light' ? `◐ ${copy.darkMode}` : `☀ ${copy.lightMode}`}
            </button>
            <button
              className="button button-utility"
              onClick={() => setManualOpen(true)}
              type="button"
            >
              ? {copy.manual}
            </button>
          </div>
          <label className="button button-ghost file-button">
            {copy.openFile}
            <input accept=".json,.xls,.xlsx,.csv" onChange={onFileChange} type="file" />
          </label>
          <button className="button button-primary" disabled={busy} onClick={() => void runAnalysis()}>
            {busy ? `${copy.analyzing} ${Math.round(progress * 100)}%` : copy.runAnalysis}
          </button>
          {busy ? (
            <button className="button button-danger" onClick={() => cancelRef.current?.()}>
              {copy.cancel}
            </button>
          ) : null}
        </div>
      </header>

      <div className="compliance-banner">
        <strong>{copy.complianceTitle}</strong>
        <span>{copy.complianceText}</span>
      </div>

      <nav className="tabs" aria-label={copy.navigationLabel}>
        {tabs.map((item) => (
          <button
            aria-current={tab === item.id ? 'page' : undefined}
            className={tab === item.id ? 'tab active' : 'tab'}
            key={item.id}
            onClick={() => setTab(item.id)}
          >
            <span>{item.short}</span>
            {copy[item.labelKey]}
          </button>
        ))}
      </nav>

      <main>
        <StatusMessages locale={locale} messages={allMessages} />

        {tab === 'project' ? (
          <div className="content-grid two-column">
            <Panel eyebrow="PROJECT" title={copy.projectTitle}>
              <div className="form-grid">
                <label>
                  {copy.projectName}
                  <input
                    value={project.project.name}
                    onChange={(event) =>
                      updateProject((draft) => {
                        draft.project.name = event.target.value
                      })
                    }
                  />
                </label>
                <label>
                  {copy.regionFactor}
                  <input
                    max="1"
                    min="0.7"
                    step="0.1"
                    type="number"
                    value={project.analysisSettings.gs.regionFactorZ}
                    onChange={(event) =>
                      updateProject((draft) => {
                        draft.analysisSettings.gs.regionFactorZ = Number(event.target.value)
                      })
                    }
                  />
                </label>
                <label>
                  {copy.groundType}
                  <select
                    value={project.analysisSettings.gs.groundType}
                    onChange={(event) =>
                      updateProject((draft) => {
                        draft.analysisSettings.gs.groundType = Number(event.target.value) as 1 | 2 | 3
                      })
                    }
                  >
                    <option value="1">{copy.groundType1}</option>
                    <option value="2">{copy.groundType2}</option>
                    <option value="3">{copy.groundType3}</option>
                  </select>
                </label>
                <label>
                  {copy.gsMode}
                  <select
                    value={project.analysisSettings.gs.mode}
                    onChange={(event) =>
                      updateProject((draft) => {
                        draft.analysisSettings.gs.mode = event.target.value as GsMode
                        draft.method.gs = event.target.value.startsWith('legacy')
                          ? 'legacy-workbook-compat'
                          : 'jp-mlit-kokuji-1457-current'
                      })
                    }
                  >
                    {([
                      'damage-simplified',
                      'safety-simplified',
                      'safety-precise',
                      'legacy-damage-precise',
                      'legacy-safety-precise',
                    ] as GsMode[]).map((mode) => (
                      <option key={mode} value={mode}>{gsModeLabel(mode, locale)}</option>
                    ))}
                  </select>
                </label>
                <label className="span-2">
                  {copy.groundTypeBasis}
                  <textarea
                    value={project.analysisSettings.gs.groundTypeBasis}
                    onChange={(event) =>
                      updateProject((draft) => {
                        draft.analysisSettings.gs.groundTypeBasis = event.target.value
                      })
                    }
                  />
                </label>
              </div>
            </Panel>
            <Panel eyebrow="PROVENANCE" title={copy.provenanceTitle}>
              <dl className="definition-list">
                <div><dt>{copy.sourceType}</dt><dd>{sourceTypeLabel(project.provenance.sourceType, locale)}</dd></div>
                <div><dt>{copy.file}</dt><dd>{project.provenance.sourceFileName ?? copy.manualInput}</dd></div>
                <div><dt>{copy.schema}</dt><dd>{project.schemaVersion}</dd></div>
                <div><dt>{copy.method}</dt><dd>{project.method.gs}</dd></div>
                <div><dt>{copy.legalBasisDate}</dt><dd>{project.method.legalBasisCheckedOn}</dd></div>
              </dl>
              <div className="download-row">
                <button
                  className="button button-ghost"
                  onClick={saveProjectJson}
                >
                  {copy.saveProjectJson}
                </button>
                <button className="button button-ghost" onClick={() => downloadTextFile('layers.csv', exportLayersCsv(project.ground.layers), 'text/csv')}>
                  {copy.layersCsv}
                </button>
                <button className="button button-ghost" onClick={() => downloadTextFile('n-values.csv', exportNValuesCsv(project.ground.nValues), 'text/csv')}>
                  {copy.nValuesCsv}
                </button>
              </div>
            </Panel>
          </div>
        ) : null}

        {tab === 'ground' ? (
          <div className="content-grid">
            <Panel eyebrow="PROFILE" title={copy.groundTitle}>
              <div className="source-legend" aria-label={copy.sourceLegend}>
                <span className="source-tag input">{copy.sourceInput}</span>
                <span className="source-tag measured">{copy.sourceMeasured}</span>
                <span className="source-tag estimated">{copy.sourceEstimated}</span>
                <span className="source-tag default">{copy.sourceDefault}</span>
                <span className="source-tag legacy">{copy.sourceLegacy}</span>
              </div>
              <div className="form-grid ground-controls">
                <label>{copy.groundwaterDepth}<input min="0" step="0.1" type="number" value={project.ground.groundwaterDepthM} onChange={(event) => setGroundValue('groundwaterDepthM', Number(event.target.value))} /></label>
                <label>{copy.improvementDepth}<input min="0" step="0.1" type="number" value={project.ground.improvementDepthM ?? ''} onChange={(event) => setGroundValue('improvementDepthM', event.target.value === '' ? undefined : Number(event.target.value))} /></label>
                <label>{copy.bedrockDepth}<input min="0" step="0.1" type="number" value={project.ground.engineeringBedrock.depthM} onChange={(event) => setBedrockValue('depthM', Number(event.target.value))} /></label>
                <label>{copy.bedrockVs}<input min="1" step="1" type="number" value={project.ground.engineeringBedrock.vsMps} onChange={(event) => setBedrockValue('vsMps', Number(event.target.value))} /></label>
                <label>{copy.bedrockDensity}<input min="500" step="10" type="number" value={project.ground.engineeringBedrock.densityKgM3} onChange={(event) => setBedrockValue('densityKgM3', Number(event.target.value))} /></label>
                <label>{copy.bedrockThickness}<input min="0" step="0.1" type="number" value={project.ground.engineeringBedrock.thicknessM ?? ''} onChange={(event) => setBedrockValue('thicknessM', event.target.value === '' ? undefined : Number(event.target.value))} /></label>
                <label>{copy.bedrockInclination}<input min="0" max="90" step="0.1" type="number" value={project.ground.engineeringBedrock.inclinationDeg ?? ''} onChange={(event) => setBedrockValue('inclinationDeg', event.target.value === '' ? undefined : Number(event.target.value))} /></label>
                <label>{copy.investigationRadius}<input min="0" step="1" type="number" value={project.ground.engineeringBedrock.investigationRadiusM ?? ''} onChange={(event) => setBedrockValue('investigationRadiusM', event.target.value === '' ? undefined : Number(event.target.value))} /></label>
              </div>
              <div className="split-view">
                <Chart ariaLabel={copy.nValueChartAria} option={nValueOption} />
                <div className="metrics-grid">
                  <Metric label={copy.groundwaterMetric} value={project.ground.groundwaterDepthM} unit="m" />
                  <Metric label={copy.bedrockDepthMetric} value={project.ground.engineeringBedrock.depthM} unit="m" />
                  <Metric label={copy.bedrockVsMetric} value={project.ground.engineeringBedrock.vsMps} unit="m/s" />
                  <Metric label={copy.layerCount} value={project.ground.layers.length} />
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>{copy.layer}</th><th>{copy.topDepth}</th><th>{copy.bottomDepth}</th><th>{copy.soil}</th><th>{copy.classification}</th><th>{copy.density}</th><th>{copy.fines}</th><th>{copy.vsAndSource}</th><th>{copy.vsReference}</th></tr></thead>
                  <tbody>
                    {project.ground.layers.map((layer, index) => (
                      <tr key={layer.id}>
                        <td>{layer.id}</td>
                        <td>{layer.topDepthM}</td>
                        <td><input type="number" step="0.1" value={layer.bottomDepthM} onChange={(event) => setLayer(index, { bottomDepthM: Number(event.target.value) })} /></td>
                        <td><input value={layer.soilName} onChange={(event) => setLayer(index, { soilName: event.target.value })} /></td>
                        <td><select value={layer.soilClass} onChange={(event) => setLayer(index, { soilClass: event.target.value as SoilClass })}>{(['clay', 'silt', 'sand', 'fine-sand', 'medium-sand', 'coarse-sand', 'gravelly-sand', 'gravel', 'surface-soil', 'fill', 'organic', 'rock', 'other'] as SoilClass[]).map((soilClass) => <option key={soilClass} value={soilClass}>{soilClassLabel(soilClass, locale)}</option>)}</select></td>
                        <td><input type="number" step="10" value={layer.densityKgM3} onChange={(event) => setLayer(index, { densityKgM3: Number(event.target.value) })} /></td>
                        <td><input type="number" step="1" value={layer.finesPercent ?? ''} onChange={(event) => setLayer(index, { finesPercent: event.target.value === '' ? undefined : Number(event.target.value) })} /></td>
                        <td><input type="number" step="1" value={layer.vsMps ?? ''} onChange={(event) => setLayer(index, { vsMps: event.target.value === '' ? undefined : Number(event.target.value), vsSource: event.target.value === '' ? undefined : 'measured' })} /><span className={`source-tag ${layer.vsSource ?? (layer.vsMps === undefined ? 'estimated' : 'input')}`}>{layer.vsSource ? valueSourceLabel(layer.vsSource, locale) : layer.vsMps === undefined ? copy.estimatedAtAnalysis : copy.sourceInput}</span></td>
                        <td><input aria-label={`${layer.id} ${copy.vsReference}`} value={layer.vsProvenance?.reference ?? ''} onChange={(event) => setLayer(index, { vsProvenance: event.target.value === '' ? undefined : { reference: event.target.value } })} placeholder={copy.psLoggingPlaceholder} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <details className="curve-section"><summary>{copy.nonlinearSummary}</summary><p className="hint">{copy.nonlinearHint}</p><div className="curve-grid">{project.ground.layers.map((layer, index) => <ModulusCurveEditor key={`${project.provenance.sourceType}:${project.provenance.sourceFileName ?? ''}:${project.provenance.sourceSha256 ?? ''}:${layer.id}`} layer={layer} locale={locale} onChange={(patch) => setLayer(index, patch)} />)}</div></details>
            </Panel>
          </div>
        ) : null}

        {tab === 'applicability' ? (
          <Panel eyebrow="APPLICABILITY" title={copy.applicabilityTitle}>
            <p className="lead">{copy.applicabilityLead}</p>
            <div className="check-grid">
              {(result?.gs.applicability ?? [
                { id: 'bedrock-vs', label: '工学的基盤のVs', status: project.ground.engineeringBedrock.vsMps >= 400 ? 'pass' : 'fail', detail: `${project.ground.engineeringBedrock.vsMps} m/s` },
                { id: 'bedrock-thickness', label: '工学的基盤の層厚', status: project.ground.engineeringBedrock.thicknessM === undefined ? 'not-assessed' : project.ground.engineeringBedrock.thicknessM >= 5 ? 'pass' : 'fail', detail: project.ground.engineeringBedrock.thicknessM === undefined ? '未入力' : `${project.ground.engineeringBedrock.thicknessM} m` },
                { id: 'inclination', label: '工学的基盤の傾斜', status: project.ground.engineeringBedrock.inclinationDeg === undefined ? 'not-assessed' : project.ground.engineeringBedrock.inclinationDeg <= 5 ? 'pass' : 'fail', detail: project.ground.engineeringBedrock.inclinationDeg === undefined ? '未入力' : `${project.ground.engineeringBedrock.inclinationDeg}°` },
                { id: 'liquefaction', label: '液状化による支障', status: 'not-assessed', detail: '解析後に専門家が確認' },
              ]).map((check) => (
                <div className={`check-card ${check.status}`} key={check.id}>
                  <span>{check.status === 'pass' ? 'PASS' : check.status === 'fail' ? 'FAIL' : copy.notAssessed}</span>
                  <h3>{applicabilityLabel(check, locale)}</h3><p>{applicabilityDetail(check, locale)}</p>
                </div>
              ))}
            </div>
          </Panel>
        ) : null}

        {tab === 'gs' ? (
          <div className="content-grid two-column chart-layout">
            <Panel eyebrow="AMPLIFICATION" title={copy.gsTitle}>
              <Chart ariaLabel={copy.gsChartAria} option={gsOption} />
            </Panel>
            <Panel eyebrow="RESULT" title={copy.characteristicTitle}>
              <div className="metrics-grid">
                <Metric label={copy.mode} value={gsModeLabel(result?.gs.mode ?? project.analysisSettings.gs.mode, locale)} />
                <Metric label={copy.convergence} value={result ? (result.gs.converged ? copy.converged : copy.notConverged) : copy.notCalculated} />
                <Metric label="T1" value={format(result?.gs.t1S)} unit="s" />
                <Metric label="T2" value={format(result?.gs.t2S)} unit="s" />
                <Metric label="α" value={format(result?.gs.alpha)} />
                <Metric label="h" value={format(result?.gs.dampingRatio, 4)} />
                <Metric label="Gs1" value={format(result?.gs.gs1)} />
                <Metric label="Gs2" value={format(result?.gs.gs2)} />
              </div>
              {project.analysisSettings.gs.mode.startsWith('legacy') ? <div className="legacy-warning">{copy.legacyWarning}</div> : null}
              <details><summary>{copy.iterationHistory} ({result?.gs.iterations.length ?? 0})</summary><pre>{JSON.stringify(result?.gs.iterations ?? [], null, 2)}</pre></details>
            </Panel>
            <Panel eyebrow="SPECTRUM" title={copy.surfaceSpectrumTitle}>
              <Chart ariaLabel={copy.spectrumChartAria} option={spectrumOption} />
            </Panel>
          </div>
        ) : null}

        {tab === 'liquefaction' ? (
          <div className="content-grid">
            {(result?.liquefaction ?? []).map((caseResult) => (
              <Panel eyebrow={caseResult.caseId} key={caseResult.caseId} title={`${caseResult.peakAccelerationGal} gal / M${caseResult.magnitude}`}>
                <div className="metrics-grid compact"><Metric label="Dcy" value={format(caseResult.dcyCm, 2)} unit="cm" /><Metric label={copy.degree} value={classificationLabel(caseResult.dcyClass, locale)} /><Metric label="PL" value={format(caseResult.pl, 2)} /><Metric label={copy.category} value={classificationLabel(caseResult.plClass, locale)} /></div>
                <div className="table-wrap"><table><thead><tr><th>{copy.layer}</th><th>{copy.depth}</th><th>{copy.eligible}</th><th>N</th><th>Na</th><th>L</th><th>R</th><th>FL</th><th>γcy %</th><th>Dcy cm</th><th>{copy.plContribution}</th></tr></thead><tbody>{caseResult.layers.map((layer) => <tr key={layer.layerId}><td>{layer.layerId}</td><td>{layer.topDepthM}–{layer.bottomDepthM}</td><td>{layer.eligible ? copy.target : locale === 'ja' ? layer.reason ?? copy.excluded : copy.excluded}</td><td>{format(layer.n, 2)}</td><td>{format(layer.correctedN, 2)}</td><td>{format(layer.demandRatio, 3)}</td><td>{format(layer.resistanceRatio, 3)}</td><td>{format(layer.fl, 3)}</td><td>{format(layer.cyclicStrainPercent, 1)}</td><td>{format(layer.dcyContributionCm, 2)}</td><td>{format(layer.plContribution, 2)}</td></tr>)}</tbody></table></div>
              </Panel>
            ))}
            {!result ? <Panel title={copy.liquefactionResults}><p className="empty-state">{copy.liquefactionEmpty}</p></Panel> : null}
          </div>
        ) : null}

        {tab === 'motion' ? (
          <div className="content-grid two-column chart-layout">
            <Panel eyebrow="GROUND MOTION" title={copy.accelerationHistoryTitle}>
              <div className="motion-import-row">
                <label>{copy.accelerationUnit}
                  <select value={motionUnit} onChange={(event) => setMotionUnit(event.target.value as MotionRecord['accelerationUnit'])}>
                    <option value="gal">gal</option><option value="m/s2">m/s²</option><option value="g">g</option>
                  </select>
                </label>
                <label className="button button-ghost file-button inline">{copy.openMotionCsv}<input accept=".csv" onChange={onMotionFileChange} type="file" /></label>
                <button className="button button-ghost" disabled={!motion} onClick={() => motion && downloadTextFile('motion.csv', exportMotionCsv(motion), 'text/csv')}>{copy.saveMotionCsv}</button>
              </div>
              <Chart ariaLabel={copy.motionChartAria} option={motionOption} />
            </Panel>
            <Panel eyebrow="METRICS" title={copy.motionMetricsTitle}>
              <div className="metrics-grid"><Metric label={copy.points} value={motion?.timesS.length ?? 0} /><Metric label="Δt" value={format(result?.motion?.timeStepS, 4)} unit="s" /><Metric label="PGA" value={format(result?.motion?.pgaMps2)} unit="m/s²" /><Metric label="PGV" value={format(result?.motion?.pgvMps)} unit="m/s" /><Metric label="PGD" value={format(result?.motion?.pgdM)} unit="m" /></div>
              <p className="hint">{copy.motionHint}</p>
            </Panel>
          </div>
        ) : null}

        {tab === 'report' ? (
          <Panel eyebrow="REPORT" title={copy.reportTitle}>
            <div className="report-header">
              <div><span>{copy.project}</span><strong>{project.project.name}</strong></div>
              <div><span>{copy.appVersion}</span><strong>{project.appVersion}</strong></div>
              <div><span>{copy.method}</span><strong>{project.method.gs}</strong></div>
              <div><span>{copy.status}</span><strong>{result ? copy.calculated : copy.notCalculated}</strong></div>
              <div><span>{copy.calculatedAt}</span><strong>{result?.calculatedAt ?? '—'}</strong></div>
              <div><span>{copy.inputHash}</span><strong className="hash-value">{result?.inputSha256 ?? '—'}</strong></div>
            </div>
            {result ? (
              <div className="report-section page-break">
                <h3>{copy.calculationMetadata}</h3>
                <dl className="definition-list">
                  <div><dt>{copy.gsMethodId}</dt><dd>{result.metadata.gsMethodId}</dd></div>
                  <div><dt>{copy.vsTable}</dt><dd>{result.metadata.vsCoefficientTableId}</dd></div>
                  <div><dt>{copy.liquefactionMethodId}</dt><dd>{result.metadata.liquefactionMethodId}</dd></div>
                  <div><dt>{copy.legalBasisDate}</dt><dd>{result.metadata.legalBasisCheckedOn}</dd></div>
                  <div><dt>{copy.internalUnits}</dt><dd>m, m/s, m/s², kg/m³, Pa</dd></div>
                </dl>
              </div>
            ) : null}
            <div className="report-section page-break">
              <h3>{copy.inputGroundModel}</h3>
              <p>
                {locale === 'ja'
                  ? `地下水位 GL-${project.ground.groundwaterDepthM} m / 工学的基盤 GL-${project.ground.engineeringBedrock.depthM} m / Vs ${project.ground.engineeringBedrock.vsMps} m/s`
                  : `Groundwater GL-${project.ground.groundwaterDepthM} m / engineering bedrock GL-${project.ground.engineeringBedrock.depthM} m / Vs ${project.ground.engineeringBedrock.vsMps} m/s`}
              </p>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>{copy.layer}</th><th>{copy.depth} m</th><th>{copy.soil}</th><th>{copy.density}</th><th>{copy.fines}</th><th>Vs m/s</th><th>{copy.source}</th></tr></thead>
                  <tbody>{project.ground.layers.map((layer) => <tr key={layer.id}><td>{layer.id}</td><td>{layer.topDepthM}–{layer.bottomDepthM}</td><td>{layer.soilName}</td><td>{layer.densityKgM3}</td><td>{layer.finesPercent ?? '—'}</td><td>{layer.vsMps ?? copy.sourceEstimated}</td><td>{valueSourceLabel(layer.vsSource ?? (layer.vsMps === undefined ? 'estimated' : 'input'), locale)}</td></tr>)}</tbody>
                </table>
              </div>
            </div>
            {result ? (
              <div className="report-section page-break">
                <h3>{copy.amplificationAndSpectrum}</h3>
                <div className="metrics-grid compact"><Metric label={copy.mode} value={gsModeLabel(result.gs.mode, locale)} /><Metric label={copy.convergence} value={result.gs.converged ? copy.converged : copy.notConverged} /><Metric label="T1" value={format(result.gs.t1S)} unit="s" /><Metric label="Gs1" value={format(result.gs.gs1)} /></div>
                <Chart ariaLabel={copy.reportGsChartAria} option={gsOption} />
                <details open><summary>{copy.iterationHistory} ({result.gs.iterations.length})</summary><pre>{JSON.stringify(result.gs.iterations, null, 2)}</pre></details>
              </div>
            ) : null}
            {result ? (
              <div className="report-section page-break">
                <h3>{copy.liquefactionScreening}</h3>
                {result.liquefaction.map((caseResult) => (
                  <div className="report-case" key={caseResult.caseId}>
                    <h4>{caseResult.peakAccelerationGal} gal / M{caseResult.magnitude}</h4>
                    <p>Dcy {format(caseResult.dcyCm, 2)} cm ({classificationLabel(caseResult.dcyClass, locale)}) / PL {format(caseResult.pl, 2)} ({classificationLabel(caseResult.plClass, locale)})</p>
                    <div className="table-wrap"><table><thead><tr><th>{copy.layer}</th><th>{copy.depth} m</th><th>{copy.eligible}</th><th>N</th><th>Na</th><th>L</th><th>R</th><th>FL</th><th>Dcy cm</th><th>{copy.plContribution}</th></tr></thead><tbody>{caseResult.layers.map((layer) => <tr key={layer.layerId}><td>{layer.layerId}</td><td>{layer.topDepthM}–{layer.bottomDepthM}</td><td>{layer.eligible ? copy.target : copy.excluded}</td><td>{format(layer.n, 2)}</td><td>{format(layer.correctedN, 2)}</td><td>{format(layer.demandRatio, 3)}</td><td>{format(layer.resistanceRatio, 3)}</td><td>{format(layer.fl, 3)}</td><td>{format(layer.dcyContributionCm, 2)}</td><td>{format(layer.plContribution, 2)}</td></tr>)}</tbody></table></div>
                  </div>
                ))}
              </div>
            ) : null}
            {result?.motion ? (
              <div className="report-section page-break">
                <h3>{copy.motionAndSpectrum}</h3>
                <div className="metrics-grid compact"><Metric label="PGA" value={format(result.motion.pgaMps2)} unit="m/s²" /><Metric label="PGV" value={format(result.motion.pgvMps)} unit="m/s" /><Metric label="PGD" value={format(result.motion.pgdM)} unit="m" /><Metric label="Δt" value={format(result.motion.timeStepS, 4)} unit="s" /></div>
                <Chart ariaLabel={copy.reportSpectrumAria} option={spectrumOption} />
              </div>
            ) : null}
            <div className="report-section"><h3>{copy.notes}</h3><p>{copy.reportCaution}</p></div>
            <div className="report-section"><h3>{copy.warningsAndInfo}</h3><StatusMessages locale={locale} messages={allMessages} /></div>
            <div className="download-row">
              <button className="button button-primary" disabled={!result} onClick={() => void saveResultJson()}>{copy.resultJson}</button>
              <button className="button button-ghost" disabled={!result} onClick={() => result && downloadTextFile(`${project.project.name}-gs.csv`, exportGsResultCsv(result), 'text/csv')}>{copy.gsDetailCsv}</button>
              <button className="button button-ghost" disabled={!result} onClick={() => result && downloadTextFile(`${project.project.name}-liquefaction.csv`, exportLiquefactionResultCsv(result), 'text/csv')}>{copy.liquefactionDetailCsv}</button>
              <button className="button button-ghost" disabled={!result?.motion} onClick={() => result?.motion && downloadTextFile(`${project.project.name}-motion-spectrum.csv`, exportMotionSpectrumCsv(result), 'text/csv')}>{copy.spectrumCsv}</button>
              <button className="button button-ghost" onClick={() => window.print()}>{copy.printPdf}</button>
            </div>
          </Panel>
        ) : null}
      </main>
      {manualOpen ? <ManualDialog locale={locale} onClose={() => setManualOpen(false)} /> : null}
    </div>
  )
}
