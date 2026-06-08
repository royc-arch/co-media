'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter }    from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import Image             from 'next/image'
import {
  compressImage, DropZone, ReferenceZone, Spinner, QualityBadge, ParamRow, sz,
  type SavedReference,
} from '@/components/transform/shared'
import type { ComboAnalysis, FoodAnalysis, FaceAnalysis } from '@/app/api/transform-combo/route'

// ── Types ─────────────────────────────────────────────────────────────────────

type Stage = 'idle' | 'uploading' | 'processing' | 'done' | 'error'

const STEP_LABELS: Record<string, string> = {
  uploading:           'Uploading images…',
  identifying:         'Identifying people and food…',
  analyzing:           'Analysing food and people…',
  'analyzing-reference': 'Reading reference style…',
  generating:          'Applying style transfer…',
}

const FOOD_PARAMS  = ['highlights','shadows','contrast','whites','blacks','clarity','sharpness','vibrance','saturation','temperature']
const FACE_PARAMS  = ['skin_clarity','skin_vitality','skin_brightness','skin_smoothness','facial_contrast','eye_clarity','overall_tone']

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ComboPage() {
  const router   = useRouter()
  const supabase = createClient()

  const [original,         setOriginal]         = useState<File | null>(null)
  const [reference,        setReference]        = useState<File | null>(null)
  const [intensity,        setIntensity]        = useState(80)
  const [comboAnalysis,    setComboAnalysis]    = useState<ComboAnalysis | null>(null)
  const [stage,            setStage]            = useState<Stage>('idle')
  const [stepKey,          setStepKey]          = useState('uploading')
  const [outputUrl,        setOutputUrl]        = useState<string | null>(null)
  const [error,            setError]            = useState<string | null>(null)
  const [originalPreview,  setOriginalPreview]  = useState<string | null>(null)
  const [referencePreview, setReferencePreview] = useState<string | null>(null)
  const [versions,         setVersions]         = useState<Array<{ url: string; intensity: number }>>([])
  const [savedRefs,        setSavedRefs]        = useState<SavedReference[]>([])
  const [selectedSavedRef, setSelectedSavedRef] = useState<SavedReference | null>(null)
  const [refSaved,         setRefSaved]         = useState(false)

  useEffect(() => {
    if (!original) return
    const url = URL.createObjectURL(original)
    setOriginalPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [original])

  useEffect(() => {
    if (!reference) return
    const url = URL.createObjectURL(reference)
    setReferencePreview(url)
    return () => URL.revokeObjectURL(url)
  }, [reference])

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) router.push('/auth')
    })
    fetch('/api/references').then(r => r.ok ? r.json() : []).then(setSavedRefs).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleTransform() {
    if (!original || (!reference && !selectedSavedRef)) return

    setStage('uploading')
    setStepKey('uploading')
    setError(null)
    setOutputUrl(null)
    setRefSaved(false)

    try {
      const blob1 = await compressImage(original)
      const fd    = new FormData()
      fd.append('image1', blob1, 'original.jpg')
      fd.append('jobId',  crypto.randomUUID())
      fd.append('intensity', String(intensity))

      if (selectedSavedRef) {
        fd.append('image2_url', selectedSavedRef.image_url)
      } else {
        const blob2 = await compressImage(reference!)
        fd.append('image2', blob2, 'reference.jpg')
      }

      // Pass back existing analyses on re-apply (skip re-analysis)
      if (comboAnalysis?.food) fd.append('food_analysis', JSON.stringify(comboAnalysis.food))
      if (comboAnalysis?.face) fd.append('face_analysis', JSON.stringify(comboAnalysis.face))

      setStage('processing')
      setStepKey('identifying')

      const res = await fetch('/api/transform-combo', { method: 'POST', body: fd })
      if (!res.ok)   throw new Error('Transform request failed')
      if (!res.body) throw new Error('No response stream')

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let currentEvent = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim()
          } else if (line.startsWith('data: ') && line.length > 6) {
            try {
              const data = JSON.parse(line.slice(6))
              if (currentEvent === 'progress') setStepKey(data.step)
              if (currentEvent === 'done') {
                setOutputUrl(data.outputUrl)
                setVersions(prev => [...prev, { url: data.outputUrl, intensity }])
                if (data.comboAnalysis) setComboAnalysis(data.comboAnalysis)
                setStage('done')
              }
              if (currentEvent === 'error') {
                setError(data.message)
                setStage('error')
              }
            } catch { /* skip malformed */ }
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setStage('error')
    }
  }

  function reset() {
    setOriginal(null); setReference(null); setSelectedSavedRef(null)
    setIntensity(80);  setComboAnalysis(null); setStage('idle')
    setOutputUrl(null); setError(null); setStepKey('uploading')
    setOriginalPreview(null); setReferencePreview(null)
    setVersions([]); setRefSaved(false)
  }

  async function handleSaveRef(name: string) {
    if (!reference) return
    try {
      const blob = await compressImage(reference)
      const fd   = new FormData()
      fd.append('file', blob, 'reference.jpg')
      fd.append('name', name || 'Untitled')
      const res = await fetch('/api/references', { method: 'POST', body: fd })
      if (res.ok) {
        const saved: SavedReference = await res.json()
        setSavedRefs(prev => [saved, ...prev])
        setRefSaved(true)
      }
    } catch {}
  }

  const isProcessing = stage === 'uploading' || stage === 'processing'

  return (
    <div style={sz.page}>
      <main style={sz.main}>

        {stage === 'done' && outputUrl && (
          <ResultPanel
            outputUrl={outputUrl}
            onReset={reset}
            intensity={intensity}
            onIntensityChange={setIntensity}
            onReapply={handleTransform}
            originalPreview={originalPreview}
            referencePreview={referencePreview ?? selectedSavedRef?.image_url ?? null}
            onReferenceChange={f => { setReference(f); setSelectedSavedRef(null) }}
            versions={versions}
            comboAnalysis={comboAnalysis}
            onComboAnalysisChange={setComboAnalysis}
            referenceFile={reference}
            onSaveRef={handleSaveRef}
            refSaved={refSaved}
          />
        )}

        {stage !== 'done' && (
          <>
            <div style={sz.hero} className="animate-fade-up">
              <h1 style={sz.heroTitle}>Combo Transfer</h1>
              <p style={sz.heroSub}>
                Style transfer for photos with both people and food. The AI identifies each element separately and enhances them independently.
              </p>
            </div>

            <div style={sz.uploadRow} className="animate-fade-up">
              <DropZone
                label="Your Photo"
                hint="Photo with people and food together"
                file={original}
                onFile={setOriginal}
                disabled={isProcessing}
              />
              <div style={sz.arrowCol}>
                <span style={sz.arrowGlyph}>→</span>
              </div>
              <ReferenceZone
                file={reference}
                savedRef={selectedSavedRef}
                onFile={f => { setReference(f); setSelectedSavedRef(null) }}
                onSelectSavedRef={ref => { setSelectedSavedRef(ref); setReference(null) }}
                savedRefs={savedRefs}
                disabled={isProcessing}
              />
            </div>

            <div style={sz.belowUpload} className="animate-fade-up">
              {stage === 'idle' && (
                <button
                  className="btn btn-gold"
                  onClick={handleTransform}
                  disabled={!original || (!reference && !selectedSavedRef)}
                  style={{ minWidth: 160 }}
                >
                  Transform →
                </button>
              )}

              {isProcessing && (
                <div style={sz.progressWrap}>
                  <Spinner />
                  <span style={sz.progressLabel}>{STEP_LABELS[stepKey] ?? 'Processing…'}</span>
                  <span style={sz.progressHint}>Takes 45–90 seconds</span>
                </div>
              )}

              {stage === 'error' && (
                <div style={sz.errorWrap}>
                  <span style={sz.errorMsg}>{error}</span>
                  <button className="btn btn-ghost" onClick={reset} style={{ marginTop: 16 }}>Try Again</button>
                </div>
              )}
            </div>
          </>
        )}

      </main>
    </div>
  )
}

// ── Result panel ──────────────────────────────────────────────────────────────

function ResultPanel({
  outputUrl, onReset, intensity, onIntensityChange, onReapply,
  originalPreview, referencePreview, onReferenceChange,
  versions, comboAnalysis, onComboAnalysisChange,
  referenceFile, onSaveRef, refSaved,
}: {
  outputUrl:             string
  onReset:               () => void
  intensity:             number
  onIntensityChange:     (v: number) => void
  onReapply:             () => void
  originalPreview:       string | null
  referencePreview:      string | null
  onReferenceChange:     (f: File) => void
  versions:              Array<{ url: string; intensity: number }>
  comboAnalysis:         ComboAnalysis | null
  onComboAnalysisChange: (v: ComboAnalysis) => void
  referenceFile:         File | null
  onSaveRef:             (name: string) => Promise<void>
  refSaved:              boolean
}) {
  const [reapplying,  setReapplying]  = useState(false)
  const [selectedUrl, setSelectedUrl] = useState(outputUrl)
  const [savingRef,   setSavingRef]   = useState(false)
  const [saveRefName, setSaveRefName] = useState('')
  const refInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setSelectedUrl(outputUrl) }, [outputUrl])

  async function handleReapply() {
    setReapplying(true)
    await onReapply()
    setReapplying(false)
  }

  function handleDownload() {
    const a = document.createElement('a')
    a.href = selectedUrl
    a.download = 'combo-transfer.png'
    a.click()
  }

  return (
    <div style={sz.result} className="animate-fade-up">
      <div>
        <h2 style={sz.resultTitle}>Transformation Complete</h2>
        <p style={sz.resultSub}>Food and people enhanced separately, style applied from reference.</p>
      </div>

      {/* Identification badge */}
      {comboAnalysis?.identification && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          {comboAnalysis.identification.has_food && (
            <span style={{ padding: '3px 10px', borderRadius: 3, border: '1px solid var(--gold-dim)', color: 'var(--gold)', background: 'rgba(255,174,20,0.08)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>
              Food detected
            </span>
          )}
          {comboAnalysis.identification.has_people && (
            <span style={{ padding: '3px 10px', borderRadius: 3, border: '1px solid rgba(242,56,1,0.4)', color: 'var(--orange)', background: 'rgba(242,56,1,0.08)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>
              {comboAnalysis.identification.people_count} {comboAnalysis.identification.people_count === 1 ? 'person' : 'people'} detected
            </span>
          )}
        </div>
      )}

      <div style={sz.resultImgWrap}>
        <Image src={selectedUrl} alt="Transformed photo" fill style={{ objectFit: 'contain' }}
          sizes="(max-width: 800px) 90vw, 760px" priority />
      </div>

      {/* Comparison strip */}
      {(originalPreview || versions.length > 1) && (
        <div style={sz.compareStrip}>
          {originalPreview && (
            <div style={{ ...sz.compareItem, cursor: 'pointer' }} onClick={() => setSelectedUrl(originalPreview)}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={originalPreview} alt="Original" style={{ ...sz.compareThumb, outline: selectedUrl === originalPreview ? '2px solid var(--gold)' : 'none' }} />
              <span style={sz.compareLabel}>Original</span>
            </div>
          )}
          {versions.map((v, i) => (
            <div key={i} style={{ ...sz.compareItem, cursor: 'pointer' }} onClick={() => setSelectedUrl(v.url)}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={v.url} alt={`v${i + 1}`} style={{ ...sz.compareThumb, outline: selectedUrl === v.url ? '2px solid var(--gold)' : 'none' }} />
              <span style={sz.compareLabel}>{i === 0 ? '1st gen' : `v${i + 1}`}</span>
              <span style={sz.compareSub}>{v.intensity}%</span>
            </div>
          ))}
        </div>
      )}

      {/* Style reference */}
      <div style={sz.refRow}>
        <span style={sz.refLabel}>Style Reference</span>
        <div style={sz.refThumbWrap} onClick={() => refInputRef.current?.click()}>
          {referencePreview
            ? <img src={referencePreview} alt="Style reference" style={sz.refThumb} /> // eslint-disable-line
            : <div style={sz.refThumbEmpty}>+</div>}
        </div>
        <input ref={refInputRef} type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) { onReferenceChange(f); e.target.value = '' } }} />
        <p style={sz.refHint}>Click to swap the style reference before re-applying.</p>
      </div>

      {/* Save reference */}
      {referenceFile && !refSaved && (
        <div style={{ width: '100%', background: 'linear-gradient(135deg,rgba(242,56,1,0.06) 0%,rgba(255,174,20,0.06) 100%)', border: '1px solid rgba(242,56,1,0.25)', borderRadius: 6, padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
            <span style={{ color: 'var(--orange)', fontSize: 16 }}>◈</span>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Save this reference for instant reuse in future transfers</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="text" placeholder="Name this reference…" value={saveRefName} onChange={e => setSaveRefName(e.target.value)}
              style={{ background: 'var(--surface)', border: '1px solid var(--border-light)', borderRadius: 4, padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)', outline: 'none', width: 180 }}
              onKeyDown={async e => { if (e.key === 'Enter' && !savingRef) { setSavingRef(true); await onSaveRef(saveRefName); setSavingRef(false) } }} />
            <button className="btn btn-gold" style={{ padding: '7px 16px', fontSize: 10 }} disabled={savingRef}
              onClick={async () => { setSavingRef(true); await onSaveRef(saveRefName); setSavingRef(false) }}>
              {savingRef ? 'Saving…' : 'Save →'}
            </button>
          </div>
        </div>
      )}
      {refSaved && (
        <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-muted)', padding: '10px 0' }}>
          <span style={{ color: 'var(--orange)' }}>◈</span>
          <span>Reference saved — available in your <a href="/references" style={{ color: 'var(--orange)' }}>References library</a></span>
        </div>
      )}

      {/* Analysis panels — food and people side by side (or stacked on mobile) */}
      {comboAnalysis && (comboAnalysis.food || comboAnalysis.face) && (
        <div style={{ width: '100%', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {comboAnalysis.food && (
            <div style={{ flex: 1, minWidth: 320 }}>
              <FoodAnalysisPanel
                analysis={comboAnalysis.food}
                onChange={food => onComboAnalysisChange({ ...comboAnalysis, food })}
              />
            </div>
          )}
          {comboAnalysis.face && comboAnalysis.face.people_count > 0 && (
            <div style={{ flex: 1, minWidth: 320 }}>
              <PeopleAnalysisPanel
                analysis={comboAnalysis.face}
                onChange={face => onComboAnalysisChange({ ...comboAnalysis, face })}
              />
            </div>
          )}
        </div>
      )}

      {/* Intensity */}
      <div style={{ ...sz.intensityWrap, maxWidth: 840 }}>
        <div style={sz.intensityHeader}>
          <span style={sz.intensityLabel}>Intensity</span>
          <span style={sz.intensityValue}>{intensity}%</span>
        </div>
        <input type="range" min={10} max={100} step={5} value={intensity}
          onChange={e => onIntensityChange(Number(e.target.value))} style={sz.intensitySlider} />
        <div style={sz.intensityHints}><span>Subtle</span><span>Strong</span></div>
      </div>

      {/* Actions */}
      <div style={sz.resultActions}>
        <button className="btn btn-gold" onClick={handleReapply} disabled={reapplying} style={{ minWidth: 140 }}>
          {reapplying ? 'Applying…' : 'Re-apply →'}
        </button>
        <button className="btn btn-ghost" onClick={handleDownload}>Download</button>
        <button className="btn btn-ghost" onClick={onReset}>Transform Another</button>
      </div>
    </div>
  )
}

// ── Food analysis panel ───────────────────────────────────────────────────────

function FoodAnalysisPanel({
  analysis, onChange,
}: {
  analysis: FoodAnalysis
  onChange: (v: FoodAnalysis) => void
}) {
  const [open, setOpen] = useState(false)

  function setParam(key: string, value: string) {
    onChange({ ...analysis, parameter_directions: { ...analysis.parameter_directions, [key]: value } })
  }

  return (
    <div style={sz.analysisPanel}>
      <div style={sz.analysisPanelHeader} onClick={() => setOpen(v => !v)}>
        <div style={sz.analysisPanelLeft}>
          <span style={sz.analysisPanelTitle}>Food Analysis</span>
          <QualityBadge score={analysis.quality_score} />
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: 14, transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}>▾</span>
      </div>

      {open && (
        <div style={sz.analysisPanelBody}>
          <div style={sz.tagCloud}>
            <span style={{ ...sz.tag, borderColor: 'var(--gold-dim)', color: 'var(--gold)', background: 'rgba(255,174,20,0.08)' }}>
              {analysis.primary_type}
            </span>
            {analysis.secondary_types.map((t, i) => (
              <span key={i} style={{ ...sz.tag, borderColor: 'var(--border)', color: 'var(--text-muted)', background: 'transparent' }}>{t}</span>
            ))}
          </div>
          <div style={sz.paramGrid}>
            {FOOD_PARAMS.map(key => (
              <ParamRow key={key} name={key}
                value={analysis.parameter_directions[key] ?? 'keep moderate'}
                onChange={v => setParam(key, v)} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── People analysis panel ─────────────────────────────────────────────────────

function PeopleAnalysisPanel({
  analysis, onChange,
}: {
  analysis: FaceAnalysis
  onChange: (v: FaceAnalysis) => void
}) {
  const [open, setOpen] = useState(false)

  function setParam(key: string, value: string) {
    onChange({ ...analysis, parameter_directions: { ...analysis.parameter_directions, [key]: value } })
  }

  return (
    <div style={sz.analysisPanel}>
      <div style={sz.analysisPanelHeader} onClick={() => setOpen(v => !v)}>
        <div style={sz.analysisPanelLeft}>
          <span style={sz.analysisPanelTitle}>
            People Analysis · {analysis.people_count} {analysis.people_count === 1 ? 'person' : 'people'}
          </span>
          <QualityBadge score={analysis.quality_score} />
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: 14, transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}>▾</span>
      </div>

      {open && (
        <div style={sz.analysisPanelBody}>
          {analysis.primary_issue && (
            <div style={{ paddingTop: 12 }}>
              <p style={{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 4 }}>Primary issue</p>
              <p style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{analysis.primary_issue}</p>
            </div>
          )}
          {analysis.editing_plan.length > 0 && (
            <div>
              <p style={{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6 }}>Skin & face plan</p>
              <ul style={{ margin: 0, padding: '0 0 0 16px', fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                {analysis.editing_plan.map((l, i) => <li key={i}>{l}</li>)}
              </ul>
            </div>
          )}
          <div style={sz.paramGrid}>
            {FACE_PARAMS.map(key => (
              <ParamRow key={key} name={key}
                value={analysis.parameter_directions[key] ?? 'keep moderate'}
                onChange={v => setParam(key, v)} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
