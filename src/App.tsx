import { useCallback, useMemo, useRef, useState } from 'react'
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
import { exportMotionCsv, importMotionCsv } from './io/csv/motionCsv'
import { exportModulusCurveCsv, parseModulusCurveCsv } from './io/csv/modulusCurveCsv'
import {
  exportGsResultCsv,
  exportLiquefactionResultCsv,
  exportMotionSpectrumCsv,
} from './io/csv/resultsCsv'
import { downloadTextFile } from './io/download'
import { hashProject, parseProjectJson, serializeProject, serializeResultBundle, sha256Buffer, sha256Text } from './io/json/projectJson'
import { analyzeInWorker } from './worker/workerClient'
import { Chart } from './ui/components/Chart'
import { Metric } from './ui/components/Metric'
import { StatusMessages } from './ui/components/StatusMessages'
import { gsChartOption, motionChartOption, nValueChartOption, spectrumChartOption } from './ui/options'
import './styles.css'

type TabId = 'project' | 'ground' | 'applicability' | 'gs' | 'liquefaction' | 'motion' | 'report'

const tabs: { id: TabId; label: string; short: string }[] = [
  { id: 'project', label: '案件', short: '01' },
  { id: 'ground', label: '地盤モデル', short: '02' },
  { id: 'applicability', label: '適用条件', short: '03' },
  { id: 'gs', label: '地盤増幅', short: '04' },
  { id: 'liquefaction', label: '液状化', short: '05' },
  { id: 'motion', label: '時刻歴', short: '06' },
  { id: 'report', label: 'レポート', short: '07' },
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

function ModulusCurveEditor({
  layer,
  onChange,
}: {
  layer: GroundLayer
  onChange: (patch: Partial<GroundLayer>) => void
}) {
  const serialized = exportModulusCurveCsv(layer.modulusCurve ?? []).replace(/^\uFEFF/, '')
  const [text, setText] = useState(serialized)
  const [error, setError] = useState<string | null>(null)

  const apply = () => {
    try {
      onChange({ modulusCurve: parseModulusCurveCsv(text) })
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className="curve-editor">
      <h4>{layer.id} / {layer.soilName}</h4>
      <label>特性点（strain, modulus_ratio, damping_ratio）<textarea aria-label={`${layer.id} 非線形特性`} value={text} onChange={(event) => setText(event.target.value)} /></label>
      <div className="curve-provenance">
        <label>試験・参照<input value={layer.modulusCurveProvenance?.reference ?? ''} onChange={(event) => onChange({ modulusCurveProvenance: event.target.value === '' ? undefined : { ...layer.modulusCurveProvenance, reference: event.target.value } })} /></label>
        <label>試験法<input value={layer.modulusCurveProvenance?.method ?? ''} onChange={(event) => onChange({ modulusCurveProvenance: { reference: layer.modulusCurveProvenance?.reference ?? '要記録', ...layer.modulusCurveProvenance, method: event.target.value || undefined } })} /></label>
      </div>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <button className="button button-ghost" type="button" onClick={apply}>曲線を反映</button>
    </div>
  )
}

export default function App() {
  const [project, setProject] = useState<JibanProject>(() => createDefaultProject())
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [motion, setMotion] = useState<MotionRecord | null>(null)
  const [motionUnit, setMotionUnit] = useState<MotionRecord['accelerationUnit']>('gal')
  const [messages, setMessages] = useState<AnalysisMessage[]>([])
  const [tab, setTab] = useState<TabId>('project')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const cancelRef = useRef<(() => void) | null>(null)

  const allMessages = useMemo(
    () => [...messages, ...(result?.messages ?? []), ...(result?.gs.messages ?? [])],
    [messages, result],
  )

  const importFile = useCallback(
    async (file: File) => {
      setMessages([])
      try {
        const lower = file.name.toLowerCase()
        if (lower.endsWith('.json')) {
          const text = await file.text()
          const imported = parseProjectJson(text)
          imported.provenance.sourceType = 'jiban-json'
          imported.provenance.sourceFileName = file.name
          imported.provenance.sourceSha256 = await sha256Text(text)
          setProject(imported)
          setResult(null)
          return
        }
        if (lower.endsWith('.xls') || lower.endsWith('.xlsx')) {
          const buffer = await file.arrayBuffer()
          const { importLegacyXls } = await import('./io/legacy-xls/importLegacyXls')
          const imported = importLegacyXls(buffer, file.name)
          imported.project.provenance.sourceSha256 = await sha256Buffer(buffer)
          setProject(imported.project)
          setMessages(imported.messages)
          setResult(null)
          return
        }
        if (lower.endsWith('.csv')) {
          const text = await file.text()
          if (tab === 'motion') {
            setMotion(importMotionCsv(text, file.name, motionUnit))
          } else if (file.name.includes('layer')) {
            setProject((current) =>
              cloneUpdate(current, (draft) => {
                draft.ground.layers = importLayersCsv(text)
                draft.provenance = { sourceType: 'csv', sourceFileName: file.name }
              }),
            )
          } else {
            setProject((current) =>
              cloneUpdate(current, (draft) => {
                draft.ground.nValues = importNValuesCsv(text)
                draft.provenance = { sourceType: 'csv', sourceFileName: file.name }
              }),
            )
          }
          setResult(null)
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
    [motionUnit, tab],
  )

  const onFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      if (file) void importFile(file)
      event.target.value = ''
    },
    [importFile],
  )

  const runAnalysis = useCallback(async () => {
    setBusy(true)
    setProgress(0)
    setMessages([])
    try {
      const inputSha256 = await hashProject(project)
      const task = analyzeInWorker(project, motion, inputSha256, setProgress)
      cancelRef.current = task.cancel
      const nextResult = await task.promise
      setResult(nextResult)
      setTab('gs')
    } catch (error) {
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
    setProject((current) =>
      cloneUpdate(current, (draft) => {
        Object.assign(draft.ground.layers[index]!, patch)
      }),
    )
    setResult(null)
  }, [])

  const setGroundValue = useCallback(
    (key: 'groundwaterDepthM' | 'improvementDepthM', value: number | undefined) => {
      setProject((current) =>
        cloneUpdate(current, (draft) => {
          if (key === 'groundwaterDepthM' && value !== undefined) {
            draft.ground.groundwaterDepthM = value
          } else if (key === 'improvementDepthM') {
            draft.ground.improvementDepthM = value
          }
        }),
      )
      setResult(null)
    },
    [],
  )

  const setBedrockValue = useCallback(
    (key: keyof JibanProject['ground']['engineeringBedrock'], value: number | undefined) => {
      setProject((current) =>
        cloneUpdate(current, (draft) => {
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
        }),
      )
      setResult(null)
    },
    [],
  )

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="brand-kicker">GROUND RESPONSE / LOCAL ONLY</p>
          <h1>地盤解析</h1>
        </div>
        <div className="top-actions">
          <label className="button button-ghost file-button">
            ファイルを開く
            <input accept=".json,.xls,.xlsx,.csv" onChange={onFileChange} type="file" />
          </label>
          <button className="button button-primary" disabled={busy} onClick={() => void runAnalysis()}>
            {busy ? `解析中 ${Math.round(progress * 100)}%` : '解析を実行'}
          </button>
          {busy ? (
            <button className="button button-danger" onClick={() => cancelRef.current?.()}>
              取消
            </button>
          ) : null}
        </div>
      </header>

      <div className="compliance-banner">
        <strong>開発・検証版</strong>
        <span>専門家レビュー未完了のため、結果は法適合を保証しません。ファイルは外部送信されません。</span>
      </div>

      <nav className="tabs" aria-label="解析画面">
        {tabs.map((item) => (
          <button
            aria-current={tab === item.id ? 'page' : undefined}
            className={tab === item.id ? 'tab active' : 'tab'}
            key={item.id}
            onClick={() => setTab(item.id)}
          >
            <span>{item.short}</span>
            {item.label}
          </button>
        ))}
      </nav>

      <main>
        <StatusMessages messages={allMessages} />

        {tab === 'project' ? (
          <div className="content-grid two-column">
            <Panel eyebrow="PROJECT" title="案件と計算条件">
              <div className="form-grid">
                <label>
                  案件名
                  <input
                    value={project.project.name}
                    onChange={(event) =>
                      setProject((current) =>
                        cloneUpdate(current, (draft) => {
                          draft.project.name = event.target.value
                        }),
                      )
                    }
                  />
                </label>
                <label>
                  地域係数 Z
                  <input
                    max="1"
                    min="0.7"
                    step="0.1"
                    type="number"
                    value={project.analysisSettings.gs.regionFactorZ}
                    onChange={(event) =>
                      setProject((current) =>
                        cloneUpdate(current, (draft) => {
                          draft.analysisSettings.gs.regionFactorZ = Number(event.target.value)
                        }),
                      )
                    }
                  />
                </label>
                <label>
                  地盤種別
                  <select
                    value={project.analysisSettings.gs.groundType}
                    onChange={(event) =>
                      setProject((current) =>
                        cloneUpdate(current, (draft) => {
                          draft.analysisSettings.gs.groundType = Number(event.target.value) as 1 | 2 | 3
                        }),
                      )
                    }
                  >
                    <option value="1">第一種</option>
                    <option value="2">第二種</option>
                    <option value="3">第三種</option>
                  </select>
                </label>
                <label>
                  Gsモード
                  <select
                    value={project.analysisSettings.gs.mode}
                    onChange={(event) =>
                      setProject((current) =>
                        cloneUpdate(current, (draft) => {
                          draft.analysisSettings.gs.mode = event.target.value as GsMode
                          draft.method.gs = event.target.value.startsWith('legacy')
                            ? 'legacy-workbook-compat'
                            : 'jp-mlit-kokuji-1457-current'
                        }),
                      )
                    }
                  >
                    <option value="damage-simplified">損傷限界・略算</option>
                    <option value="safety-simplified">安全限界・略算</option>
                    <option value="safety-precise">安全限界・精算</option>
                    <option value="legacy-damage-precise">旧照合・損傷精算</option>
                    <option value="legacy-safety-precise">旧照合・安全精算</option>
                  </select>
                </label>
                <label className="span-2">
                  地盤種別の根拠
                  <textarea
                    value={project.analysisSettings.gs.groundTypeBasis}
                    onChange={(event) =>
                      setProject((current) =>
                        cloneUpdate(current, (draft) => {
                          draft.analysisSettings.gs.groundTypeBasis = event.target.value
                        }),
                      )
                    }
                  />
                </label>
              </div>
            </Panel>
            <Panel eyebrow="PROVENANCE" title="入力の由来">
              <dl className="definition-list">
                <div><dt>形式</dt><dd>{project.provenance.sourceType}</dd></div>
                <div><dt>ファイル</dt><dd>{project.provenance.sourceFileName ?? '手入力'}</dd></div>
                <div><dt>スキーマ</dt><dd>{project.schemaVersion}</dd></div>
                <div><dt>計算法</dt><dd>{project.method.gs}</dd></div>
                <div><dt>法令確認日</dt><dd>{project.method.legalBasisCheckedOn}</dd></div>
              </dl>
              <div className="download-row">
                <button
                  className="button button-ghost"
                  onClick={() => downloadTextFile(`${project.project.name}.jiban.json`, serializeProject(project), 'application/json')}
                >
                  案件JSON保存
                </button>
                <button className="button button-ghost" onClick={() => downloadTextFile('layers.csv', exportLayersCsv(project.ground.layers), 'text/csv')}>
                  地層CSV
                </button>
                <button className="button button-ghost" onClick={() => downloadTextFile('n-values.csv', exportNValuesCsv(project.ground.nValues), 'text/csv')}>
                  N値CSV
                </button>
              </div>
            </Panel>
          </div>
        ) : null}

        {tab === 'ground' ? (
          <div className="content-grid">
            <Panel eyebrow="PROFILE" title="N値と地層モデル">
              <div className="source-legend" aria-label="値の出典凡例">
                <span className="source-tag input">入力</span>
                <span className="source-tag measured">直接試験</span>
                <span className="source-tag estimated">推定</span>
                <span className="source-tag default">既定</span>
                <span className="source-tag legacy">旧互換</span>
              </div>
              <div className="form-grid ground-controls">
                <label>地下水位 GL- (m)<input min="0" step="0.1" type="number" value={project.ground.groundwaterDepthM} onChange={(event) => setGroundValue('groundwaterDepthM', Number(event.target.value))} /></label>
                <label>地盤改良深さ GL- (m)<input min="0" step="0.1" type="number" value={project.ground.improvementDepthM ?? ''} onChange={(event) => setGroundValue('improvementDepthM', event.target.value === '' ? undefined : Number(event.target.value))} /></label>
                <label>工学的基盤深さ GL- (m)<input min="0" step="0.1" type="number" value={project.ground.engineeringBedrock.depthM} onChange={(event) => setBedrockValue('depthM', Number(event.target.value))} /></label>
                <label>工学的基盤 Vs (m/s)<input min="1" step="1" type="number" value={project.ground.engineeringBedrock.vsMps} onChange={(event) => setBedrockValue('vsMps', Number(event.target.value))} /></label>
                <label>工学的基盤密度 (kg/m³)<input min="500" step="10" type="number" value={project.ground.engineeringBedrock.densityKgM3} onChange={(event) => setBedrockValue('densityKgM3', Number(event.target.value))} /></label>
                <label>基盤層厚 (m)<input min="0" step="0.1" type="number" value={project.ground.engineeringBedrock.thicknessM ?? ''} onChange={(event) => setBedrockValue('thicknessM', event.target.value === '' ? undefined : Number(event.target.value))} /></label>
                <label>基盤傾斜 (°)<input min="0" max="90" step="0.1" type="number" value={project.ground.engineeringBedrock.inclinationDeg ?? ''} onChange={(event) => setBedrockValue('inclinationDeg', event.target.value === '' ? undefined : Number(event.target.value))} /></label>
                <label>調査範囲半径 (m)<input min="0" step="1" type="number" value={project.ground.engineeringBedrock.investigationRadiusM ?? ''} onChange={(event) => setBedrockValue('investigationRadiusM', event.target.value === '' ? undefined : Number(event.target.value))} /></label>
              </div>
              <div className="split-view">
                <Chart ariaLabel="深度別N値" option={nValueChartOption(project.ground)} />
                <div className="metrics-grid">
                  <Metric label="地下水位" value={project.ground.groundwaterDepthM} unit="m" />
                  <Metric label="基盤深さ" value={project.ground.engineeringBedrock.depthM} unit="m" />
                  <Metric label="基盤Vs" value={project.ground.engineeringBedrock.vsMps} unit="m/s" />
                  <Metric label="層数" value={project.ground.layers.length} />
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>層</th><th>上端 m</th><th>下端 m</th><th>土質</th><th>分類</th><th>密度 kg/m³</th><th>FC %</th><th>Vs m/s / 出典</th><th>Vs試験・参照</th></tr></thead>
                  <tbody>
                    {project.ground.layers.map((layer, index) => (
                      <tr key={layer.id}>
                        <td>{layer.id}</td>
                        <td>{layer.topDepthM}</td>
                        <td><input type="number" step="0.1" value={layer.bottomDepthM} onChange={(event) => setLayer(index, { bottomDepthM: Number(event.target.value) })} /></td>
                        <td><input value={layer.soilName} onChange={(event) => setLayer(index, { soilName: event.target.value })} /></td>
                        <td><select value={layer.soilClass} onChange={(event) => setLayer(index, { soilClass: event.target.value as SoilClass })}><option value="clay">粘土</option><option value="silt">シルト</option><option value="sand">砂</option><option value="fine-sand">細砂</option><option value="medium-sand">中砂</option><option value="coarse-sand">粗砂</option><option value="gravelly-sand">砂礫</option><option value="gravel">礫</option><option value="surface-soil">表土</option><option value="other">その他</option></select></td>
                        <td><input type="number" step="10" value={layer.densityKgM3} onChange={(event) => setLayer(index, { densityKgM3: Number(event.target.value) })} /></td>
                        <td><input type="number" step="1" value={layer.finesPercent ?? ''} onChange={(event) => setLayer(index, { finesPercent: event.target.value === '' ? undefined : Number(event.target.value) })} /></td>
                        <td><input type="number" step="1" value={layer.vsMps ?? ''} onChange={(event) => setLayer(index, { vsMps: event.target.value === '' ? undefined : Number(event.target.value), vsSource: event.target.value === '' ? undefined : 'measured' })} /><span className={`source-tag ${layer.vsSource ?? (layer.vsMps === undefined ? 'estimated' : 'input')}`}>{layer.vsSource ?? (layer.vsMps === undefined ? '解析時推定' : '入力')}</span></td>
                        <td><input aria-label={`${layer.id} Vs試験・参照`} value={layer.vsProvenance?.reference ?? ''} onChange={(event) => setLayer(index, { vsProvenance: event.target.value === '' ? undefined : { reference: event.target.value } })} placeholder="PS検層報告書等" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <details className="curve-section"><summary>G/G0–γ・h–γ 非線形特性入力</summary><p className="hint">安全限界精算では全層の曲線と出典を記録します。無根拠の既定曲線は自動適用しません。</p><div className="curve-grid">{project.ground.layers.map((layer, index) => <ModulusCurveEditor key={`${project.provenance.sourceType}:${project.provenance.sourceFileName ?? ''}:${project.provenance.sourceSha256 ?? ''}:${layer.id}`} layer={layer} onChange={(patch) => setLayer(index, patch)} />)}</div></details>
            </Panel>
          </div>
        ) : null}

        {tab === 'applicability' ? (
          <Panel eyebrow="APPLICABILITY" title="精算法の適用条件">
            <p className="lead">単一の自動合否ではなく、各条件と未評価項目を分けて記録します。</p>
            <div className="check-grid">
              {(result?.gs.applicability ?? [
                { id: 'bedrock-vs', label: '工学的基盤のVs', status: project.ground.engineeringBedrock.vsMps >= 400 ? 'pass' : 'fail', detail: `${project.ground.engineeringBedrock.vsMps} m/s` },
                { id: 'bedrock-thickness', label: '工学的基盤の層厚', status: project.ground.engineeringBedrock.thicknessM === undefined ? 'not-assessed' : project.ground.engineeringBedrock.thicknessM >= 5 ? 'pass' : 'fail', detail: project.ground.engineeringBedrock.thicknessM === undefined ? '未入力' : `${project.ground.engineeringBedrock.thicknessM} m` },
                { id: 'inclination', label: '工学的基盤の傾斜', status: project.ground.engineeringBedrock.inclinationDeg === undefined ? 'not-assessed' : project.ground.engineeringBedrock.inclinationDeg <= 5 ? 'pass' : 'fail', detail: project.ground.engineeringBedrock.inclinationDeg === undefined ? '未入力' : `${project.ground.engineeringBedrock.inclinationDeg}°` },
                { id: 'liquefaction', label: '液状化による支障', status: 'not-assessed', detail: '解析後に専門家が確認' },
              ]).map((check) => (
                <div className={`check-card ${check.status}`} key={check.id}>
                  <span>{check.status === 'pass' ? 'PASS' : check.status === 'fail' ? 'FAIL' : '未評価'}</span>
                  <h3>{check.label}</h3><p>{check.detail}</p>
                </div>
              ))}
            </div>
          </Panel>
        ) : null}

        {tab === 'gs' ? (
          <div className="content-grid two-column chart-layout">
            <Panel eyebrow="AMPLIFICATION" title="地盤増幅 Gs(T)">
              <Chart ariaLabel="周期別地盤増幅率" option={gsChartOption(result)} />
            </Panel>
            <Panel eyebrow="RESULT" title="収束・特性値">
              <div className="metrics-grid">
                <Metric label="モード" value={result?.gs.mode ?? project.analysisSettings.gs.mode} />
                <Metric label="収束" value={result ? (result.gs.converged ? '収束' : '未収束') : '未計算'} />
                <Metric label="T1" value={format(result?.gs.t1S)} unit="s" />
                <Metric label="T2" value={format(result?.gs.t2S)} unit="s" />
                <Metric label="α" value={format(result?.gs.alpha)} />
                <Metric label="h" value={format(result?.gs.dampingRatio, 4)} />
                <Metric label="Gs1" value={format(result?.gs.gs1)} />
                <Metric label="Gs2" value={format(result?.gs.gs2)} />
              </div>
              {project.analysisSettings.gs.mode.startsWith('legacy') ? <div className="legacy-warning">旧シート照合モードです。法適合値として使用できません。</div> : null}
              <details><summary>反復履歴 ({result?.gs.iterations.length ?? 0})</summary><pre>{JSON.stringify(result?.gs.iterations ?? [], null, 2)}</pre></details>
            </Panel>
            <Panel eyebrow="SPECTRUM" title="地表加速度応答スペクトル">
              <Chart ariaLabel="地表および時刻歴の応答スペクトル" option={spectrumChartOption(result)} />
            </Panel>
          </div>
        ) : null}

        {tab === 'liquefaction' ? (
          <div className="content-grid">
            {(result?.liquefaction ?? []).map((caseResult) => (
              <Panel eyebrow={caseResult.caseId} key={caseResult.caseId} title={`${caseResult.peakAccelerationGal} gal / M${caseResult.magnitude}`}>
                <div className="metrics-grid compact"><Metric label="Dcy" value={format(caseResult.dcyCm, 2)} unit="cm" /><Metric label="程度" value={caseResult.dcyClass} /><Metric label="PL" value={format(caseResult.pl, 2)} /><Metric label="区分" value={caseResult.plClass} /></div>
                <div className="table-wrap"><table><thead><tr><th>層</th><th>深度</th><th>対象</th><th>N</th><th>Na</th><th>L</th><th>R</th><th>FL</th><th>γcy %</th><th>Dcy cm</th><th>PL寄与</th></tr></thead><tbody>{caseResult.layers.map((layer) => <tr key={layer.layerId}><td>{layer.layerId}</td><td>{layer.topDepthM}–{layer.bottomDepthM}</td><td>{layer.eligible ? '対象' : layer.reason ?? '対象外'}</td><td>{format(layer.n, 2)}</td><td>{format(layer.correctedN, 2)}</td><td>{format(layer.demandRatio, 3)}</td><td>{format(layer.resistanceRatio, 3)}</td><td>{format(layer.fl, 3)}</td><td>{format(layer.cyclicStrainPercent, 1)}</td><td>{format(layer.dcyContributionCm, 2)}</td><td>{format(layer.plContribution, 2)}</td></tr>)}</tbody></table></div>
              </Panel>
            ))}
            {!result ? <Panel title="液状化結果"><p className="empty-state">解析を実行すると、150 gal・350 galの層別根拠を表示します。</p></Panel> : null}
          </div>
        ) : null}

        {tab === 'motion' ? (
          <div className="content-grid two-column chart-layout">
            <Panel eyebrow="GROUND MOTION" title="加速度時刻歴">
              <div className="motion-import-row">
                <label>入力加速度単位
                  <select value={motionUnit} onChange={(event) => setMotionUnit(event.target.value as MotionRecord['accelerationUnit'])}>
                    <option value="gal">gal</option><option value="m/s2">m/s²</option><option value="g">g</option>
                  </select>
                </label>
                <label className="button button-ghost file-button inline">motion.csvを開く<input accept=".csv" onChange={onFileChange} type="file" /></label>
                <button className="button button-ghost" disabled={!motion} onClick={() => motion && downloadTextFile('motion.csv', exportMotionCsv(motion), 'text/csv')}>時刻歴CSV保存</button>
              </div>
              <Chart ariaLabel="入力加速度時刻歴" option={motionChartOption(motion)} />
            </Panel>
            <Panel eyebrow="METRICS" title="時刻歴指標">
              <div className="metrics-grid"><Metric label="点数" value={motion?.timesS.length ?? 0} /><Metric label="Δt" value={format(result?.motion?.timeStepS, 4)} unit="s" /><Metric label="PGA" value={format(result?.motion?.pgaMps2)} unit="m/s²" /><Metric label="PGV" value={format(result?.motion?.pgvMps)} unit="m/s" /><Metric label="PGD" value={format(result?.motion?.pgdM)} unit="m" /></div>
              <p className="hint">CSVは1列目に時刻(s)、2列目に加速度を指定します。読込前に単位を選択してください。</p>
            </Panel>
          </div>
        ) : null}

        {tab === 'report' ? (
          <Panel eyebrow="REPORT" title="計算概要と出力">
            <div className="report-header"><div><span>案件</span><strong>{project.project.name}</strong></div><div><span>アプリ版</span><strong>{project.appVersion}</strong></div><div><span>計算法</span><strong>{project.method.gs}</strong></div><div><span>状態</span><strong>{result ? '計算済み' : '未計算'}</strong></div><div><span>計算日時</span><strong>{result?.calculatedAt ?? '—'}</strong></div><div><span>入力SHA-256</span><strong className="hash-value">{result?.inputSha256 ?? '—'}</strong></div></div>
            {result ? <div className="report-section page-break"><h3>計算メタデータ</h3><dl className="definition-list"><div><dt>Gs計算法ID</dt><dd>{result.metadata.gsMethodId}</dd></div><div><dt>Vs係数表</dt><dd>{result.metadata.vsCoefficientTableId}</dd></div><div><dt>液状化法ID</dt><dd>{result.metadata.liquefactionMethodId}</dd></div><div><dt>法令確認日</dt><dd>{result.metadata.legalBasisCheckedOn}</dd></div><div><dt>内部単位</dt><dd>m, m/s, m/s², kg/m³, Pa</dd></div></dl></div> : null}
            <div className="report-section page-break"><h3>入力地盤モデル</h3><p>地下水位 GL-{project.ground.groundwaterDepthM} m / 工学的基盤 GL-{project.ground.engineeringBedrock.depthM} m / Vs {project.ground.engineeringBedrock.vsMps} m/s</p><div className="table-wrap"><table><thead><tr><th>層</th><th>深度 m</th><th>土質</th><th>密度 kg/m³</th><th>FC %</th><th>Vs m/s</th><th>出典</th></tr></thead><tbody>{project.ground.layers.map((layer) => <tr key={layer.id}><td>{layer.id}</td><td>{layer.topDepthM}–{layer.bottomDepthM}</td><td>{layer.soilName}</td><td>{layer.densityKgM3}</td><td>{layer.finesPercent ?? '—'}</td><td>{layer.vsMps ?? '推定'}</td><td>{layer.vsSource ?? (layer.vsMps === undefined ? 'estimated' : 'input')}</td></tr>)}</tbody></table></div></div>
            {result ? <div className="report-section page-break"><h3>地盤増幅とスペクトル</h3><div className="metrics-grid compact"><Metric label="モード" value={result.gs.mode} /><Metric label="収束" value={result.gs.converged ? '収束' : '未収束'} /><Metric label="T1" value={format(result.gs.t1S)} unit="s" /><Metric label="Gs1" value={format(result.gs.gs1)} /></div><Chart ariaLabel="レポート用地盤増幅率" option={gsChartOption(result)} /><details open><summary>反復履歴 ({result.gs.iterations.length})</summary><pre>{JSON.stringify(result.gs.iterations, null, 2)}</pre></details></div> : null}
            {result ? <div className="report-section page-break"><h3>液状化スクリーニング</h3>{result.liquefaction.map((caseResult) => <div className="report-case" key={caseResult.caseId}><h4>{caseResult.peakAccelerationGal} gal / M{caseResult.magnitude}</h4><p>Dcy {format(caseResult.dcyCm, 2)} cm（{caseResult.dcyClass}） / PL {format(caseResult.pl, 2)}（{caseResult.plClass}）</p><div className="table-wrap"><table><thead><tr><th>層</th><th>深度 m</th><th>対象</th><th>N</th><th>Na</th><th>L</th><th>R</th><th>FL</th><th>Dcy cm</th><th>PL寄与</th></tr></thead><tbody>{caseResult.layers.map((layer) => <tr key={layer.layerId}><td>{layer.layerId}</td><td>{layer.topDepthM}–{layer.bottomDepthM}</td><td>{layer.eligible ? '対象' : '対象外'}</td><td>{format(layer.n, 2)}</td><td>{format(layer.correctedN, 2)}</td><td>{format(layer.demandRatio, 3)}</td><td>{format(layer.resistanceRatio, 3)}</td><td>{format(layer.fl, 3)}</td><td>{format(layer.dcyContributionCm, 2)}</td><td>{format(layer.plContribution, 2)}</td></tr>)}</tbody></table></div></div>)}</div> : null}
            {result?.motion ? <div className="report-section page-break"><h3>時刻歴・5%減衰弾性応答スペクトル</h3><div className="metrics-grid compact"><Metric label="PGA" value={format(result.motion.pgaMps2)} unit="m/s²" /><Metric label="PGV" value={format(result.motion.pgvMps)} unit="m/s" /><Metric label="PGD" value={format(result.motion.pgdM)} unit="m" /><Metric label="Δt" value={format(result.motion.timeStepS, 4)} unit="s" /></div><Chart ariaLabel="レポート用応答スペクトル" option={spectrumChartOption(result)} /></div> : null}
            <div className="report-section"><h3>注意事項</h3><p>本出力は開発・検証版です。専門家レビュー前のため、法適合、設計妥当性、液状化による支障の最終判断を保証しません。</p></div>
            <div className="report-section"><h3>警告・情報</h3><StatusMessages messages={allMessages} /></div>
            <div className="download-row">
              <button className="button button-primary" disabled={!result} onClick={() => result && downloadTextFile(`${project.project.name}-result.json`, serializeResultBundle(project, result), 'application/json')}>結果JSON</button>
              <button className="button button-ghost" disabled={!result} onClick={() => result && downloadTextFile(`${project.project.name}-gs.csv`, exportGsResultCsv(result), 'text/csv')}>Gs明細CSV</button>
              <button className="button button-ghost" disabled={!result} onClick={() => result && downloadTextFile(`${project.project.name}-liquefaction.csv`, exportLiquefactionResultCsv(result), 'text/csv')}>液状化明細CSV</button>
              <button className="button button-ghost" disabled={!result?.motion} onClick={() => result?.motion && downloadTextFile(`${project.project.name}-motion-spectrum.csv`, exportMotionSpectrumCsv(result), 'text/csv')}>応答スペクトルCSV</button>
              <button className="button button-ghost" onClick={() => window.print()}>印刷 / PDF</button>
            </div>
          </Panel>
        ) : null}
      </main>
    </div>
  )
}
