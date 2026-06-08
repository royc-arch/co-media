'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import Image from 'next/image'
import type { SavedReference } from '@/types'

// ── Types ─────────────────────────────────────────────────────────────────────

type Stage = 'idle' | 'uploading' | 'processing' | 'done' | 'error'

type FoodAnalysis = {
  dish_name:             string
  primary_type:          string
  secondary_types:       string[]
  visual_features:       string[]
  optimization_keywords: string[]
  quality_score:         number
  editing_plan: {
    light:     string[]
    texture:   string[]
    color:     string[]
    structure: string[]
  }
  parameter_directions: Record<string, string>
}

const DIRECTION_LEVELS = [
  { value: 'decrease',          label: '−' },
  { value: 'slightly decrease', label: '↓' },
  { value: 'keep moderate',     label: '○' },
  { value: 'slightly increase', label: '↑' },
  { value: 'increase',          label: '+' },
] as const

const STEP_LABELS: Record<string, string> = {
  'uploading':          'Uploading images…',
  'analyzing-style':    'Analyzing reference aesthetic…',
  'analyzing-subject':  'Reading original photo…',
  'extending':          'Extending canvas to fit target size…',
  'generating':         'Applying style transfer…',
}


// ── Image compression (client-side, keeps FormData under 4.5 MB) ──────────────

async function compressImage(file: File, maxPx = 1280): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new window.Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height))
      const w = Math.round(img.width  * scale)
      const h = Math.round(img.height * scale)
      const canvas = document.createElement('canvas')
      canvas.width  = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('Canvas unavailable')); return }
      ctx.drawImage(img, 0, 0, w, h)
      canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error('Compression failed')),
        'image/jpeg',
        0.88,
      )
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')) }
    img.src = url
  })
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function HomePage() {
  const router   = useRouter()
  const supabase = createClient()

  const [original,        setOriginal]        = useState<File | null>(null)
  const [reference,       setReference]       = useState<File | null>(null)
  const [intensity,       setIntensity]       = useState(80)
  const [transferBackground, setTransferBackground] = useState(false)
  const [foodAnalysis,    setFoodAnalysis]    = useState<FoodAnalysis | null>(null)
  const [stage,           setStage]           = useState<Stage>('idle')
  const [stepKey,         setStepKey]         = useState('uploading')
  const [outputUrl,       setOutputUrl]       = useState<string | null>(null)
  const [error,           setError]           = useState<string | null>(null)
  const [originalPreview,  setOriginalPreview]  = useState<string | null>(null)
  const [referencePreview, setReferencePreview] = useState<string | null>(null)
  const [versions,         setVersions]         = useState<Array<{ url: string; intensity: number }>>([])
  const [savedRefs,        setSavedRefs]        = useState<SavedReference[]>([])
  const [selectedSavedRef, setSelectedSavedRef] = useState<SavedReference | null>(null)
  const [refSaved,         setRefSaved]         = useState(false)

  // Keep stable object-URL previews for both input files
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
    fetch('/api/references')
      .then(r => r.ok ? r.json() : [])
      .then(setSavedRefs)
      .catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleTransform() {
    if (!original || (!reference && !selectedSavedRef)) return

    setStage('uploading')
    setStepKey('uploading')
    setError(null)
    setOutputUrl(null)
    setRefSaved(false)

    try {
      // Compress original image client-side
      const blob1 = await compressImage(original)

      const formData = new FormData()
      formData.append('image1', blob1, 'original.jpg')
      formData.append('jobId', crypto.randomUUID())
      formData.append('intensity', String(intensity))
      if (transferBackground) formData.append('transfer_background', '1')

      if (selectedSavedRef) {
        // Use saved reference by URL — no upload needed
        formData.append('image2_url', selectedSavedRef.image_url)
      } else {
        // Compress and upload new reference file
        const blob2 = await compressImage(reference!)
        formData.append('image2', blob2, 'reference.jpg')
      }

      // Pass back user-edited food analysis so backend skips re-analysis
      if (foodAnalysis) formData.append('food_analysis', JSON.stringify(foodAnalysis))

      setStage('processing')
      setStepKey('analyzing-style')

      // POST files directly to the API — server handles Supabase Storage upload
      const res = await fetch('/api/transform', {
        method: 'POST',
        body:   formData,
        // No Content-Type header — browser sets it with the correct multipart boundary
      })

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
                if (data.foodAnalysis) setFoodAnalysis(data.foodAnalysis)
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
    setOriginal(null)
    setReference(null)
    setSelectedSavedRef(null)
    setIntensity(80)
    setTransferBackground(false)
    setFoodAnalysis(null)
    setStage('idle')
    setOutputUrl(null)
    setError(null)
    setStepKey('uploading')
    setOriginalPreview(null)
    setReferencePreview(null)
    setVersions([])
    setRefSaved(false)
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
    <div style={s.page}>
      <PageHeader />
      <main style={s.main}>

        {/* ── Result view ─────────────────────────────────────────────── */}
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
            foodAnalysis={foodAnalysis}
            onFoodAnalysisChange={setFoodAnalysis}
            referenceFile={reference}
            onSaveRef={handleSaveRef}
            refSaved={refSaved}
          />
        )}

        {/* ── Upload view ─────────────────────────────────────────────── */}
        {stage !== 'done' && (
          <>
            <div style={s.hero} className="animate-fade-up">
              <h1 style={s.heroTitle}>Style Transfer</h1>
              <p style={s.heroSub}>
                Upload your photo and a reference image. The AI will transform
                your photo to match the reference aesthetic.
              </p>
            </div>

            <div style={s.uploadRow} className="animate-fade-up">
              <DropZone
                label="Your Photo"
                hint="The image to transform"
                file={original}
                onFile={setOriginal}
                disabled={isProcessing}
              />
              <div style={s.arrowCol}>
                <span style={s.arrowGlyph}>→</span>
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

            <div style={s.belowUpload} className="animate-fade-up">
              {stage === 'idle' && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
                    <input
                      type="checkbox"
                      checked={transferBackground}
                      onChange={e => setTransferBackground(e.target.checked)}
                      style={{ accentColor: 'var(--gold)', width: 14, height: 14, cursor: 'pointer' }}
                    />
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>
                      Also transfer background
                    </span>
                  </label>
                  <button
                    className="btn btn-gold"
                    onClick={handleTransform}
                    disabled={!original || (!reference && !selectedSavedRef)}
                    style={{ minWidth: 160 }}
                  >
                    Transform →
                  </button>
                </div>
              )}

              {isProcessing && (
                <div style={s.progressWrap}>
                  <Spinner />
                  <span style={s.progressLabel}>
                    {STEP_LABELS[stepKey] ?? 'Processing…'}
                  </span>
                  <span style={s.progressHint}>Takes 30–60 seconds</span>
                </div>
              )}

              {stage === 'error' && (
                <div style={s.errorWrap}>
                  <span style={s.errorMsg}>{error}</span>
                  <button className="btn btn-ghost" onClick={reset} style={{ marginTop: 16 }}>
                    Try Again
                  </button>
                </div>
              )}
            </div>
          </>
        )}

      </main>
    </div>
  )
}

// ── Page header ───────────────────────────────────────────────────────────────

function PageHeader() {
  const router   = useRouter()
  const supabase = createClient()

  async function signOut() {
    await supabase.auth.signOut()
    router.push('/auth')
    router.refresh()
  }

  return (
    <header style={s.header}>
      <div style={s.headerInner}>
        <div style={s.logo}>
          <span style={s.logoMark}>◈</span>
          <span style={s.logoName}>Co.Media</span>
        </div>
        <nav style={s.nav}>
          <a href="/" style={{ ...s.navLink, color: 'var(--orange)' }}>Style Transfer</a>
          <span style={s.navSep}>·</span>
          <a href="/showcase" style={s.navLink}>Video Showcase</a>
          <span style={s.navSep}>·</span>
          <a href="/history" style={s.navLink}>Works</a>
          <span style={s.navSep}>·</span>
          <a href="/references" style={s.navLink}>References</a>
          <span style={s.navSep}>·</span>
          <button onClick={signOut} style={s.navBtn}>Sign Out</button>
        </nav>
      </div>
    </header>
  )
}

// ── Drop zone ─────────────────────────────────────────────────────────────────

function DropZone({
  label, hint, file, onFile, disabled,
}: {
  label:    string
  hint:     string
  file:     File | null
  onFile:   (f: File) => void
  disabled: boolean
}) {
  const [dragging, setDragging] = useState(false)
  const [preview,  setPreview]  = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!file) { setPreview(null); return }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (disabled) return
    const f = e.dataTransfer.files[0]
    if (f && f.type.startsWith('image/')) onFile(f)
  }, [disabled, onFile])

  const border = dragging
    ? 'var(--gold-dim)'
    : file
    ? 'var(--border-light)'
    : 'var(--border)'

  const bg = dragging ? 'var(--card-hover)' : 'var(--card)'

  return (
    <div
      style={{ ...s.zone, borderColor: border, background: bg, cursor: disabled ? 'default' : 'pointer' }}
      onClick={() => !disabled && inputRef.current?.click()}
      onDragOver={e => { e.preventDefault(); if (!disabled) setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f) }}
      />

      {preview ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt={label} style={s.zonePreview} />
          <div style={s.zoneBadge}>{label}</div>
        </>
      ) : (
        <div style={s.zonePlaceholder}>
          <span style={s.zonePlus}>+</span>
          <span style={s.zoneLabel}>{label}</span>
          <span style={s.zoneHint}>{hint}</span>
          <span style={s.zoneFormats}>JPEG · PNG · WEBP</span>
        </div>
      )}
    </div>
  )
}

// ── Reference zone (upload or pick from saved) ────────────────────────────────

function ReferenceZone({
  file,
  savedRef,
  onFile,
  onSelectSavedRef,
  savedRefs,
  disabled,
}: {
  file:             File | null
  savedRef:         SavedReference | null
  onFile:           (f: File) => void
  onSelectSavedRef: (r: SavedReference) => void
  savedRefs:        SavedReference[]
  disabled:         boolean
}) {
  const [mode,    setMode]    = useState<'upload' | 'saved'>('upload')
  const [dragging, setDragging] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!file) { setPreview(null); return }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (disabled) return
    const f = e.dataTransfer.files[0]
    if (f && f.type.startsWith('image/')) { onFile(f); setMode('upload') }
  }, [disabled, onFile])

  // What to show as the current selection
  const activePreview = mode === 'upload' ? preview : (savedRef?.image_url ?? null)
  const hasSelection  = mode === 'upload' ? !!file : !!savedRef

  const borderColor = dragging ? 'var(--gold-dim)' : hasSelection ? 'var(--border-light)' : 'var(--border)'
  const bg = dragging ? 'var(--card-hover)' : 'var(--card)'

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 0, minHeight: 320 }}>

      {/* Tab bar */}
      <div style={rz.tabs}>
        <button
          style={{ ...rz.tab, ...(mode === 'upload' ? rz.tabActive : {}) }}
          onClick={() => setMode('upload')}
          disabled={disabled}
        >
          Upload
        </button>
        <button
          style={{ ...rz.tab, ...(mode === 'saved' ? rz.tabActive : {}) }}
          onClick={() => setMode('saved')}
          disabled={disabled}
        >
          Saved {savedRefs.length > 0 && `(${savedRefs.length})`}
        </button>
      </div>

      {/* Upload mode */}
      {mode === 'upload' && (
        <div
          style={{ ...s.zone, borderColor, background: bg, cursor: disabled ? 'default' : 'pointer', borderTopLeftRadius: 0, borderTopRightRadius: 0 }}
          onClick={() => !disabled && inputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); if (!disabled) setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) { onFile(f); setMode('upload') } }}
          />
          {preview ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={preview} alt="Style Reference" style={s.zonePreview} />
              <div style={s.zoneBadge}>Style Reference</div>
            </>
          ) : (
            <div style={s.zonePlaceholder}>
              <span style={s.zonePlus}>+</span>
              <span style={s.zoneLabel}>Style Reference</span>
              <span style={s.zoneHint}>The look you want to apply</span>
              <span style={s.zoneFormats}>JPEG · PNG · WEBP</span>
            </div>
          )}
        </div>
      )}

      {/* Saved mode */}
      {mode === 'saved' && (
        <div style={rz.savedPanel}>
          {savedRefs.length === 0 ? (
            <div style={rz.savedEmpty}>
              <span style={{ fontSize: 22, color: 'var(--border-light)' }}>◈</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
                No saved references yet.{' '}
                <button
                  style={{ background: 'none', border: 'none', color: 'var(--orange)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11, padding: 0 }}
                  onClick={() => setMode('upload')}
                >
                  Upload one
                </button>
                {' '}or{' '}
                <a href="/references" style={{ color: 'var(--orange)' }}>manage references →</a>
              </span>
            </div>
          ) : (
            <div style={rz.savedGrid}>
              {savedRefs.map(ref => {
                const isSelected = savedRef?.id === ref.id
                return (
                  <div
                    key={ref.id}
                    style={{
                      ...rz.savedItem,
                      borderColor: isSelected ? 'var(--orange)' : 'var(--border)',
                      boxShadow:   isSelected ? '0 0 0 2px rgba(242,56,1,0.25)' : 'none',
                    }}
                    onClick={() => !disabled && onSelectSavedRef(ref)}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={ref.image_url} alt={ref.name} style={rz.savedThumb} />
                    <span style={rz.savedName}>{ref.name}</span>
                    {isSelected && <div style={rz.selectedBadge}>✓</div>}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* If saved ref selected, show small preview at bottom */}
      {mode === 'saved' && savedRef && (
        <div style={rz.savedPreviewBar}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={savedRef.image_url} alt={savedRef.name} style={rz.savedPreviewThumb} />
          <span style={rz.savedPreviewName}>{savedRef.name} selected</span>
        </div>
      )}
    </div>
  )
}

const rz: Record<string, React.CSSProperties> = {
  tabs: {
    display:             'flex',
    background:          'var(--card)',
    borderRadius:        '6px 6px 0 0',
    border:              '1px solid var(--border)',
    borderBottomColor:   'transparent',
    overflow:            'hidden',
  },
  tab: {
    flex:          1,
    padding:       '8px 12px',
    background:    'transparent',
    border:        'none',
    borderBottom:  '2px solid transparent',
    fontFamily:    'var(--font-mono)',
    fontSize:      9,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color:         'var(--text-muted)',
    cursor:        'pointer',
    transition:    'color 0.15s, border-color 0.15s',
  },
  tabActive: {
    color:        'var(--orange)',
    borderBottom: '2px solid var(--orange)',
  },
  savedPanel: {
    flex:          1,
    border:        '1px solid var(--border)',
    borderTop:     'none',
    borderRadius:  '0 0 6px 6px',
    background:    'var(--card)',
    overflowY:     'auto',
    minHeight:     280,
    padding:       12,
  },
  savedEmpty: {
    height:         '100%',
    minHeight:      240,
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            12,
  },
  savedGrid: {
    display:             'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap:                 8,
  },
  savedItem: {
    position:     'relative',
    borderRadius: 4,
    border:       '1.5px solid var(--border)',
    overflow:     'hidden',
    cursor:       'pointer',
    transition:   'border-color 0.15s, box-shadow 0.15s',
    background:   'var(--bg)',
  },
  savedThumb: {
    width:       '100%',
    aspectRatio: '4/3',
    objectFit:   'cover',
    display:     'block',
  },
  savedName: {
    display:       'block',
    padding:       '5px 7px',
    fontSize:      9,
    letterSpacing: '0.06em',
    color:         'var(--text-muted)',
    overflow:      'hidden',
    textOverflow:  'ellipsis',
    whiteSpace:    'nowrap',
  },
  selectedBadge: {
    position:       'absolute',
    top:            6,
    right:          6,
    background:     'var(--orange)',
    color:          '#fff',
    borderRadius:   '50%',
    width:          18,
    height:         18,
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    fontSize:       10,
  },
  savedPreviewBar: {
    display:       'flex',
    alignItems:    'center',
    gap:           10,
    padding:       '8px 10px',
    background:    'rgba(242,56,1,0.06)',
    border:        '1px solid rgba(242,56,1,0.2)',
    borderRadius:  '0 0 6px 6px',
    marginTop:     -1,
  },
  savedPreviewThumb: {
    width:        36,
    height:       36,
    objectFit:   'cover',
    borderRadius: 3,
    border:       '1px solid var(--border)',
  },
  savedPreviewName: {
    fontSize:      10,
    letterSpacing: '0.06em',
    color:         'var(--orange)',
  },
}

// ── Result panel ──────────────────────────────────────────────────────────────

function ResultPanel({
  outputUrl,
  onReset,
  intensity,
  onIntensityChange,
  onReapply,
  originalPreview,
  referencePreview,
  onReferenceChange,
  versions,
  foodAnalysis,
  onFoodAnalysisChange,
  referenceFile,
  onSaveRef,
  refSaved,
}: {
  outputUrl:            string
  onReset:              () => void
  intensity:            number
  onIntensityChange:    (v: number) => void
  onReapply:            () => void
  originalPreview:      string | null
  referencePreview:     string | null
  onReferenceChange:    (f: File) => void
  versions:             Array<{ url: string; intensity: number }>
  foodAnalysis:         FoodAnalysis | null
  onFoodAnalysisChange: (v: FoodAnalysis) => void
  referenceFile:        File | null
  onSaveRef:            (name: string) => Promise<void>
  refSaved:             boolean
}) {
  const [reapplying,  setReapplying]  = useState(false)
  const [selectedUrl, setSelectedUrl] = useState(outputUrl)
  const [showCrop,    setShowCrop]    = useState(false)
  const [savingRef,   setSavingRef]   = useState(false)
  const [saveRefName, setSaveRefName] = useState('')
  const refInputRef = useRef<HTMLInputElement>(null)

  // Always show the latest output when a new one arrives
  useEffect(() => { setSelectedUrl(outputUrl) }, [outputUrl])

  async function handleReapply() {
    setReapplying(true)
    await onReapply()
    setReapplying(false)
  }

  function handleRefFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (f) onReferenceChange(f)
    // Reset input so same file can be re-selected
    e.target.value = ''
  }

  return (
    <div style={s.result} className="animate-fade-up">
      <div style={s.resultMeta}>
        <h2 style={s.resultTitle}>Transformation Complete</h2>
        <p style={s.resultSub}>
          Your photo has been styled to match the reference aesthetic.
        </p>
      </div>

      <div style={s.resultImgWrap}>
        <Image
          src={selectedUrl}
          alt="Transformed photo"
          fill
          style={{ objectFit: 'contain' }}
          sizes="(max-width: 800px) 90vw, 760px"
          priority
        />
      </div>

      {/* ── Comparison strip ─────────────────────────────── */}
      {(originalPreview || versions.length > 1) && (
        <div style={s.compareStrip}>
          {originalPreview && (
            <div
              style={{ ...s.compareItem, cursor: 'pointer' }}
              onClick={() => setSelectedUrl(originalPreview)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={originalPreview}
                alt="Original"
                style={{
                  ...s.compareThumb,
                  outline: selectedUrl === originalPreview ? '2px solid var(--gold)' : 'none',
                }}
              />
              <span style={s.compareLabel}>Original</span>
            </div>
          )}
          {versions.map((v, i) => (
            <div
              key={i}
              style={{ ...s.compareItem, cursor: 'pointer' }}
              onClick={() => setSelectedUrl(v.url)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={v.url}
                alt={`Version ${i + 1}`}
                style={{
                  ...s.compareThumb,
                  outline: selectedUrl === v.url ? '2px solid var(--gold)' : 'none',
                }}
              />
              <span style={s.compareLabel}>
                {i === 0 ? '1st gen' : `v${i + 1}`}
              </span>
              <span style={s.compareSub}>{v.intensity}%</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Style reference ──────────────────────────────── */}
      <div style={s.refRow}>
        <span style={s.refLabel}>Style Reference</span>
        <div className="ref-thumb-wrap" style={s.refThumbWrap} onClick={() => refInputRef.current?.click()}>
          {referencePreview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={referencePreview} alt="Style reference" style={s.refThumb} />
          ) : (
            <div style={s.refThumbEmpty}>+</div>
          )}
          <div className="ref-overlay" style={s.refThumbOverlay}>
            <span className="ref-overlay-text" style={s.refThumbOverlayText}>Change</span>
          </div>
        </div>
        <input
          ref={refInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          style={{ display: 'none' }}
          onChange={handleRefFileChange}
        />
        <p style={s.refHint}>Click to swap the style reference before re-applying.</p>
      </div>

      {/* ── Save this reference ──────────────────────────── */}
      {referenceFile && !refSaved && (
        <div style={s.saveRefBanner}>
          <div style={s.saveRefLeft}>
            <span style={s.saveRefIcon}>◈</span>
            <span style={s.saveRefText}>Save this reference for instant reuse in future transfers</span>
          </div>
          <div style={s.saveRefRight}>
            <input
              type="text"
              placeholder="Name this reference…"
              value={saveRefName}
              onChange={e => setSaveRefName(e.target.value)}
              style={s.saveRefInput}
              onKeyDown={async e => {
                if (e.key === 'Enter' && !savingRef) {
                  setSavingRef(true)
                  await onSaveRef(saveRefName)
                  setSavingRef(false)
                }
              }}
            />
            <button
              className="btn btn-gold"
              style={{ padding: '7px 16px', fontSize: 10 }}
              disabled={savingRef}
              onClick={async () => {
                setSavingRef(true)
                await onSaveRef(saveRefName)
                setSavingRef(false)
              }}
            >
              {savingRef ? 'Saving…' : 'Save →'}
            </button>
          </div>
        </div>
      )}
      {refSaved && (
        <div style={s.saveRefDone}>
          <span style={s.saveRefIcon}>◈</span>
          <span>Reference saved — available in your <a href="/references" style={{ color: 'var(--orange)' }}>References library</a></span>
        </div>
      )}

      {/* ── Food analysis panel ──────────────────────────── */}
      {foodAnalysis && (
        <FoodAnalysisPanel
          analysis={foodAnalysis}
          onChange={onFoodAnalysisChange}
          disabled={reapplying}
        />
      )}

      {/* ── Intensity control ─────────────────────────────── */}
      <div style={s.intensityWrap}>
        <div style={s.intensityHeader}>
          <span style={s.intensityLabel}>Atmosphere Intensity</span>
          <span style={s.intensityValue}>{intensity}%</span>
        </div>
        <input
          type="range"
          min={10}
          max={100}
          step={5}
          value={intensity}
          onChange={e => onIntensityChange(Number(e.target.value))}
          disabled={reapplying}
          style={s.intensitySlider}
        />
        <div style={s.intensityHints}>
          <span>Subtle</span>
          <span>Full</span>
        </div>
        <button
          className="btn btn-gold"
          onClick={handleReapply}
          disabled={reapplying}
          style={{ marginTop: 16, minWidth: 140 }}
        >
          {reapplying ? 'Applying…' : 'Re-apply →'}
        </button>
      </div>

      <div style={s.resultActions}>
        <a
          href={selectedUrl}
          download="retouch-output.png"
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-gold"
        >
          Download
        </a>
        <button
          className="btn btn-ghost"
          onClick={() => setShowCrop(v => !v)}
        >
          {showCrop ? 'Hide Crop' : 'Crop & Export'}
        </button>
        <button className="btn btn-ghost" onClick={onReset}>
          Transform Another
        </button>
        <a href="/history" className="btn btn-ghost">
          View Works
        </a>
      </div>

      {showCrop && <CropTool imageUrl={selectedUrl} />}
    </div>
  )
}

// ── Quality badge ─────────────────────────────────────────────────────────────

function QualityBadge({ score }: { score: number }) {
  const tier = score >= 7 ? 'high' : score >= 4 ? 'mid' : 'low'
  const label = tier === 'high' ? 'High Quality' : tier === 'mid' ? 'Good' : 'Needs Work'
  const color = tier === 'high' ? 'var(--gold)' : tier === 'mid' ? 'var(--text-secondary)' : 'var(--error)'
  return (
    <span style={{ fontSize: 9, letterSpacing: '0.08em', color, border: `1px solid ${color}`, borderRadius: 20, padding: '2px 8px' }}>
      {score}/10 · {label}
    </span>
  )
}

// ── Food analysis panel ───────────────────────────────────────────────────────

const PARAM_KEYS = [
  { key: 'highlights',  label: 'Highlights'  },
  { key: 'shadows',     label: 'Shadows'     },
  { key: 'contrast',    label: 'Contrast'    },
  { key: 'whites',      label: 'Whites'      },
  { key: 'blacks',      label: 'Blacks'      },
  { key: 'clarity',     label: 'Clarity'     },
  { key: 'sharpness',   label: 'Sharpness'   },
  { key: 'vibrance',    label: 'Vibrance'    },
  { key: 'saturation',  label: 'Saturation'  },
  { key: 'temperature', label: 'Temperature' },
]

const DIRECTION_TITLES: Record<string, string> = {
  'decrease':          'Decrease',
  'slightly decrease': 'Slightly Decrease',
  'keep moderate':     'Keep Moderate',
  'slightly increase': 'Slightly Increase',
  'increase':          'Increase',
}

// Normalize any direction value to one of our 5 display levels
function normalizeDir(v: string): string {
  if (v === 'reduce aggressively') return 'decrease'
  return v
}

function FoodAnalysisPanel({
  analysis,
  onChange,
  disabled = false,
}: {
  analysis:  FoodAnalysis
  onChange:  (updated: FoodAnalysis) => void
  disabled?: boolean
}) {
  const [expanded, setExpanded] = useState(false)

  function setParam(key: string, value: string) {
    onChange({
      ...analysis,
      parameter_directions: { ...analysis.parameter_directions, [key]: value },
    })
  }

  return (
    <div style={fa.wrap}>
      <button style={fa.toggle} onClick={() => setExpanded(e => !e)}>
        <div style={fa.toggleLeft}>
          <span style={fa.toggleLabel}>Food Analysis</span>
          <span style={fa.toggleType}>{analysis.primary_type}</span>
          <QualityBadge score={analysis.quality_score} />
        </div>
        <span style={fa.toggleChevron}>{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div style={fa.body}>
          {/* Primary + secondary type tags + visual feature tags */}
          <div style={fa.tags}>
            <span style={{ ...fa.tag, ...fa.tagPrimary }}>{analysis.primary_type}</span>
            {analysis.secondary_types.map(t => (
              <span key={t} style={{ ...fa.tag, ...fa.tagSecondary }}>{t}</span>
            ))}
            {analysis.visual_features.map(f => (
              <span key={f} style={fa.tag}>{f}</span>
            ))}
          </div>

          {/* Parameter direction editor */}
          <div style={fa.grid}>
            {PARAM_KEYS.map(({ key, label }) => {
              const current = normalizeDir(analysis.parameter_directions[key] ?? 'keep moderate')
              return (
                <div key={key} style={fa.row}>
                  <span style={fa.paramLabel}>{label}</span>
                  <div style={fa.btns}>
                    {DIRECTION_LEVELS.map(dir => {
                      const active = current === dir.value
                      return (
                        <button
                          key={dir.value}
                          onClick={() => !disabled && setParam(key, dir.value)}
                          disabled={disabled}
                          title={DIRECTION_TITLES[dir.value]}
                          style={{
                            ...fa.dirBtn,
                            background:  active ? 'var(--gold)'  : 'var(--surface)',
                            borderColor: active ? 'var(--gold)'  : 'var(--border)',
                            color:       active ? 'var(--bg)'    : 'var(--text-muted)',
                            cursor:      disabled ? 'default' : 'pointer',
                          }}
                        >
                          {dir.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

const fa: Record<string, React.CSSProperties> = {
  wrap: {
    width:        '100%',
    maxWidth:     840,
    border:       '1px solid var(--border)',
    borderRadius: 6,
    overflow:     'hidden',
  },
  toggle: {
    width:          '100%',
    background:     'var(--card)',
    border:         'none',
    padding:        '12px 16px',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    cursor:         'pointer',
    textAlign:      'left',
  },
  toggleLeft: {
    display:    'flex',
    alignItems: 'center',
    gap:        12,
  },
  toggleLabel: {
    fontFamily:    'var(--font-mono)',
    fontSize:      10,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color:         'var(--text-muted)',
  },
  toggleType: {
    fontSize:      11,
    color:         'var(--gold)',
    letterSpacing: '0.04em',
  },
  toggleChevron: {
    fontSize: 9,
    color:    'var(--text-muted)',
  },
  body: {
    padding:       '16px',
    borderTop:     '1px solid var(--border)',
    background:    'var(--surface)',
    display:       'flex',
    flexDirection: 'column',
    gap:           16,
  },
  tags: {
    display:  'flex',
    flexWrap: 'wrap',
    gap:      6,
  },
  tag: {
    padding:       '3px 10px',
    border:        '1px solid var(--border)',
    borderRadius:  20,
    fontSize:      9,
    letterSpacing: '0.08em',
    color:         'var(--text-muted)',
    background:    'var(--card)',
  },
  tagPrimary: {
    borderColor: 'var(--gold)',
    color:       'var(--gold)',
  },
  tagSecondary: {
    borderColor: 'var(--border-light)',
    color:       'var(--text-secondary)',
  },
  grid: {
    display:             'grid',
    gridTemplateColumns: '1fr 1fr',
    gap:                 8,
  },
  row: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    gap:            8,
  },
  paramLabel: {
    fontFamily:    'var(--font-mono)',
    fontSize:      9,
    letterSpacing: '0.10em',
    textTransform: 'uppercase',
    color:         'var(--text-muted)',
    minWidth:      70,
  },
  btns: {
    display: 'flex',
    gap:     3,
  },
  dirBtn: {
    width:        24,
    height:       24,
    border:       '1px solid',
    borderRadius: 3,
    fontSize:     11,
    display:      'flex',
    alignItems:   'center',
    justifyContent:'center',
    transition:   'background 0.12s, border-color 0.12s',
    fontFamily:   'var(--font-mono)',
    padding:      0,
  },
}

// ── Crop tool ─────────────────────────────────────────────────────────────────

const CROP_RATIOS: Record<string, number | null> = {
  'Free': null, '1:1': 1, '4:3': 4/3, '3:4': 3/4, '16:9': 16/9, '9:16': 9/16,
}

function CropTool({ imageUrl }: { imageUrl: string }) {
  const [ratioKey,    setRatioKey]    = useState('Free')
  const [crop,        setCrop]        = useState({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 })
  const containerRef  = useRef<HTMLDivElement>(null)
  const canvasRef     = useRef<HTMLCanvasElement>(null)
  const imgRef        = useRef<HTMLImageElement>(null)
  const [imgLoaded,   setImgLoaded]   = useState(false)
  const dragRef       = useRef<{ handle: string; startX: number; startY: number; startCrop: typeof crop } | null>(null)

  // Draw overlay whenever crop changes or image loads
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container || !imgLoaded) return
    const { width: W, height: H } = container.getBoundingClientRect()
    canvas.width  = W
    canvas.height = H
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, W, H)
    const cx = crop.x * W, cy = crop.y * H, cw = crop.w * W, ch = crop.h * H
    // Gray overlay
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(0, 0, W, H)
    ctx.clearRect(cx, cy, cw, ch)
    // Dashed border
    ctx.save()
    ctx.setLineDash([6, 4])
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth   = 1.5
    ctx.strokeRect(cx + 0.75, cy + 0.75, cw - 1.5, ch - 1.5)
    ctx.restore()
    // Rule-of-thirds grid lines
    ctx.save()
    ctx.setLineDash([3, 4])
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.moveTo(cx + cw / 3, cy); ctx.lineTo(cx + cw / 3, cy + ch)
    ctx.moveTo(cx + 2 * cw / 3, cy); ctx.lineTo(cx + 2 * cw / 3, cy + ch)
    ctx.moveTo(cx, cy + ch / 3); ctx.lineTo(cx + cw, cy + ch / 3)
    ctx.moveTo(cx, cy + 2 * ch / 3); ctx.lineTo(cx + cw, cy + 2 * ch / 3)
    ctx.stroke()
    ctx.restore()
  }, [crop, imgLoaded])

  function getPos(e: React.MouseEvent): { x: number; y: number } {
    const rect = containerRef.current!.getBoundingClientRect()
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height }
  }

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    const pos = getPos(e)
    const { x: cx, y: cy, w: cw, h: ch } = crop
    const tol = 0.03
    // Determine which handle is being dragged
    const onL = Math.abs(pos.x - cx) < tol
    const onR = Math.abs(pos.x - (cx + cw)) < tol
    const onT = Math.abs(pos.y - cy) < tol
    const onB = Math.abs(pos.y - (cy + ch)) < tol
    const inside = pos.x > cx && pos.x < cx + cw && pos.y > cy && pos.y < cy + ch

    let handle = ''
    if (onT && onL) handle = 'tl'
    else if (onT && onR) handle = 'tr'
    else if (onB && onL) handle = 'bl'
    else if (onB && onR) handle = 'br'
    else if (onL) handle = 'l'
    else if (onR) handle = 'r'
    else if (onT) handle = 't'
    else if (onB) handle = 'b'
    else if (inside) handle = 'move'
    if (!handle) return

    dragRef.current = { handle, startX: pos.x, startY: pos.y, startCrop: { ...crop } }
  }

  function onMouseMove(e: React.MouseEvent) {
    if (!dragRef.current) return
    const pos = getPos(e)
    const { handle, startX, startY, startCrop: sc } = dragRef.current
    const dx = pos.x - startX, dy = pos.y - startY
    const ratio = CROP_RATIOS[ratioKey]

    let { x, y, w, h } = sc

    const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
    const minSize = 0.05

    if (handle === 'move') {
      x = clamp(sc.x + dx, 0, 1 - sc.w)
      y = clamp(sc.y + dy, 0, 1 - sc.h)
    } else {
      if (handle.includes('l')) {
        const newX = clamp(sc.x + dx, 0, sc.x + sc.w - minSize)
        w = sc.x + sc.w - newX; x = newX
      }
      if (handle.includes('r')) {
        w = clamp(sc.w + dx, minSize, 1 - sc.x)
      }
      if (handle.includes('t')) {
        const newY = clamp(sc.y + dy, 0, sc.y + sc.h - minSize)
        h = sc.y + sc.h - newY; y = newY
      }
      if (handle.includes('b')) {
        h = clamp(sc.h + dy, minSize, 1 - sc.y)
      }
      // Lock ratio if set — adjust height from width
      if (ratio) {
        const containerRect = containerRef.current!.getBoundingClientRect()
        const imgAspect = containerRect.width / containerRect.height
        h = (w / ratio) * imgAspect
        // Clamp h
        if (y + h > 1) { h = 1 - y; w = (h * ratio) / imgAspect }
      }
    }

    setCrop({ x, y, w, h })
  }

  function onMouseUp() { dragRef.current = null }

  function applyRatio(key: string) {
    setRatioKey(key)
    const ratio = CROP_RATIOS[key]
    if (!ratio || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const imgAspect = rect.width / rect.height
    const cx = crop.x + crop.w / 2
    const cy = crop.y + crop.h / 2
    let w = crop.w
    let h = (w / ratio) * imgAspect
    if (h > 0.9) { h = 0.9; w = (h * ratio) / imgAspect }
    const x = clampN(cx - w / 2, 0, 1 - w)
    const y = clampN(cy - h / 2, 0, 1 - h)
    setCrop({ x, y, w, h })
  }

  function clampN(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)) }

  function downloadCrop() {
    const img = imgRef.current
    if (!img) return
    const canvas  = document.createElement('canvas')
    const nW = img.naturalWidth, nH = img.naturalHeight
    canvas.width  = Math.round(crop.w * nW)
    canvas.height = Math.round(crop.h * nH)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, crop.x * nW, crop.y * nH, crop.w * nW, crop.h * nH, 0, 0, canvas.width, canvas.height)
    canvas.toBlob(blob => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = 'retouch-cropped.png'; a.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }

  return (
    <div style={ct.wrap}>
      {/* Ratio presets */}
      <div style={ct.ratioRow}>
        {Object.keys(CROP_RATIOS).map(key => (
          <button
            key={key}
            onClick={() => applyRatio(key)}
            style={{
              ...ct.ratioBtn,
              borderColor: ratioKey === key ? 'var(--gold)' : 'var(--border)',
              color:       ratioKey === key ? 'var(--gold)' : 'var(--text-muted)',
              background:  ratioKey === key ? 'rgba(201,169,110,0.08)' : 'var(--card)',
            }}
          >
            {key}
          </button>
        ))}
      </div>

      {/* Image + overlay */}
      <div
        ref={containerRef}
        style={ct.imgWrap}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={imageUrl}
          alt="Crop preview"
          style={ct.img}
          onLoad={() => setImgLoaded(true)}
          crossOrigin="anonymous"
        />
        <canvas ref={canvasRef} style={ct.canvas} />

        {/* Corner handles */}
        {imgLoaded && (['tl','tr','bl','br'] as const).map(handle => {
          const isLeft = handle.includes('l')
          const isTop  = handle.includes('t')
          const container = containerRef.current
          if (!container) return null
          const rect = container.getBoundingClientRect()
          return (
            <div
              key={handle}
              style={{
                ...ct.handle,
                left: isLeft
                  ? `calc(${crop.x * 100}% - 5px)`
                  : `calc(${(crop.x + crop.w) * 100}% - 5px)`,
                top: isTop
                  ? `calc(${crop.y * 100}% - 5px)`
                  : `calc(${(crop.y + crop.h) * 100}% - 5px)`,
                cursor: handle === 'tl' || handle === 'br' ? 'nwse-resize' : 'nesw-resize',
              }}
            />
          )
        })}
      </div>

      <button className="btn btn-gold" onClick={downloadCrop} style={{ alignSelf: 'center', minWidth: 140 }}>
        Download Cropped
      </button>
    </div>
  )
}

// ── Spinner ───────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div style={{
      width:  22,
      height: 22,
      border: '2px solid var(--border-light)',
      borderTopColor: 'var(--gold)',
      borderRadius: '50%',
      animation: 'spin 0.8s linear infinite',
      flexShrink: 0,
    }} />
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight:       '100vh',
    background:      'var(--bg)',
    display:         'flex',
    flexDirection:   'column',
  },

  // Header
  header: {
    borderBottom:    '1px solid var(--border)',
    background:      'var(--header-bg)',
    backdropFilter:  'blur(12px)',
    position:        'sticky',
    top:             0,
    zIndex:          100,
  },
  headerInner: {
    maxWidth:        1100,
    margin:          '0 auto',
    padding:         '0 24px',
    height:          56,
    display:         'flex',
    alignItems:      'center',
    justifyContent:  'space-between',
  },
  logo: {
    display:         'flex',
    alignItems:      'center',
    gap:             8,
  },
  logoMark: {
    color:           'var(--gold)',
    fontSize:        18,
  },
  logoName: {
    fontFamily:      'var(--font-display)',
    fontSize:        22,
    fontWeight:      700,
    letterSpacing:   '-0.01em',
    color:           '#FFFFFF',
  },
  nav: {
    display:         'flex',
    alignItems:      'center',
    gap:             14,
  },
  navLink: {
    color:           'rgba(255,255,255,0.55)',
    fontSize:        11,
    letterSpacing:   '0.1em',
    textTransform:   'uppercase',
    textDecoration:  'none',
    transition:      'color 0.15s',
  },
  navSep: {
    color:           'rgba(255,255,255,0.2)',
    fontSize:        12,
  },
  navBtn: {
    background:      'none',
    border:          'none',
    color:           'rgba(255,255,255,0.55)',
    fontFamily:      'var(--font-mono)',
    fontSize:        11,
    letterSpacing:   '0.1em',
    textTransform:   'uppercase',
    cursor:          'pointer',
    padding:         0,
    transition:      'color 0.15s',
  },

  // Main
  main: {
    flex:            1,
    maxWidth:        1000,
    margin:          '0 auto',
    padding:         '64px 24px 80px',
    width:           '100%',
    display:         'flex',
    flexDirection:   'column',
    alignItems:      'center',
    gap:             0,
  },

  // Hero
  hero: {
    textAlign:       'center',
    marginBottom:    52,
  },
  heroTitle: {
    fontFamily:      'var(--font-display)',
    fontSize:        52,
    fontWeight:      300,
    letterSpacing:   '0.03em',
    color:           'var(--text)',
    lineHeight:      1.1,
    marginBottom:    14,
  },
  heroSub: {
    color:           'var(--text-secondary)',
    fontSize:        13,
    lineHeight:      1.7,
    maxWidth:        440,
    margin:          '0 auto',
    letterSpacing:   '0.02em',
  },

  // Upload row
  uploadRow: {
    display:         'flex',
    alignItems:      'center',
    gap:             24,
    width:           '100%',
    maxWidth:        840,
    marginBottom:    36,
  },

  arrowCol: {
    display:         'flex',
    flexDirection:   'column',
    alignItems:      'center',
    paddingTop:      20,
    flexShrink:      0,
  },
  arrowGlyph: {
    color:           'var(--gold-dim)',
    fontSize:        22,
  },

  // Drop zone
  zone: {
    flex:            1,
    minHeight:       320,
    border:          '1px dashed var(--border)',
    borderRadius:    6,
    overflow:        'hidden',
    position:        'relative',
    display:         'flex',
    alignItems:      'center',
    justifyContent:  'center',
    transition:      'border-color 0.2s, background 0.2s',
    userSelect:      'none',
  },
  zonePreview: {
    width:           '100%',
    height:          '100%',
    objectFit:       'cover',
    display:         'block',
    position:        'absolute',
    inset:           0,
  },
  zoneBadge: {
    position:        'absolute',
    bottom:          10,
    left:            10,
    background:      'rgba(10,8,7,0.80)',
    border:          '1px solid var(--border)',
    borderRadius:    3,
    padding:         '4px 9px',
    fontSize:        9,
    letterSpacing:   '0.12em',
    textTransform:   'uppercase',
    color:           'var(--text-secondary)',
  },
  zonePlaceholder: {
    display:         'flex',
    flexDirection:   'column',
    alignItems:      'center',
    gap:             8,
    padding:         '32px 20px',
    textAlign:       'center',
  },
  zonePlus: {
    fontSize:        28,
    color:           'var(--border-light)',
    lineHeight:      1,
    marginBottom:    4,
  },
  zoneLabel: {
    fontFamily:      'var(--font-display)',
    fontSize:        18,
    fontWeight:      300,
    color:           'var(--text-secondary)',
    letterSpacing:   '0.04em',
  },
  zoneHint: {
    fontSize:        11,
    color:           'var(--text-muted)',
    letterSpacing:   '0.04em',
  },
  zoneFormats: {
    fontSize:        9,
    color:           'var(--text-muted)',
    letterSpacing:   '0.10em',
    textTransform:   'uppercase',
    marginTop:       4,
  },

  // Below upload area
  compareStrip: {
    display:        'flex',
    gap:            12,
    overflowX:      'auto' as const,
    width:          '100%',
    paddingBottom:  8,
  },
  compareItem: {
    display:        'flex',
    flexDirection:  'column' as const,
    alignItems:     'center',
    gap:            6,
    flexShrink:     0,
  },
  compareThumb: {
    width:          100,
    height:         100,
    objectFit:      'cover' as const,
    borderRadius:   4,
    border:         '1px solid var(--border)',
  },
  compareLabel: {
    fontSize:       9,
    letterSpacing:  '0.10em',
    textTransform:  'uppercase' as const,
    color:          'var(--text-muted)',
  },
  compareSub: {
    fontSize:       9,
    color:          'var(--gold-dim)',
    letterSpacing:  '0.06em',
  },

  intensityWrap: {
    width:          '100%',
    maxWidth:       840,
    marginBottom:   28,
  },
  intensityHeader: {
    display:        'flex',
    justifyContent: 'space-between',
    alignItems:     'baseline',
    marginBottom:   10,
  },
  intensityLabel: {
    fontFamily:     'var(--font-mono)',
    fontSize:       10,
    letterSpacing:  '0.12em',
    textTransform:  'uppercase' as const,
    color:          'var(--text-muted)',
  },
  intensityValue: {
    fontFamily:     'var(--font-mono)',
    fontSize:       13,
    color:          'var(--gold)',
  },
  intensitySlider: {
    width:          '100%',
    accentColor:    'var(--gold)',
    cursor:         'pointer',
    height:         2,
  },
  intensityHints: {
    display:        'flex',
    justifyContent: 'space-between',
    marginTop:      6,
    fontSize:       9,
    letterSpacing:  '0.08em',
    textTransform:  'uppercase' as const,
    color:          'var(--text-muted)',
  },

  belowUpload: {
    display:         'flex',
    flexDirection:   'column',
    alignItems:      'center',
    gap:             10,
    minHeight:       60,
  },

  // Progress
  progressWrap: {
    display:         'flex',
    alignItems:      'center',
    gap:             14,
    flexDirection:   'column',
    textAlign:       'center',
  },
  progressLabel: {
    color:           'var(--text-secondary)',
    fontSize:        12,
    letterSpacing:   '0.06em',
  },
  progressHint: {
    color:           'var(--text-muted)',
    fontSize:        10,
    letterSpacing:   '0.08em',
    textTransform:   'uppercase',
  },

  // Error
  errorWrap: {
    display:         'flex',
    flexDirection:   'column',
    alignItems:      'center',
    gap:             4,
    textAlign:       'center',
    maxWidth:        400,
  },
  errorMsg: {
    color:           'var(--error)',
    fontSize:        12,
    letterSpacing:   '0.02em',
  },

  // Result
  result: {
    display:         'flex',
    flexDirection:   'column',
    alignItems:      'center',
    gap:             32,
    width:           '100%',
    maxWidth:        840,
  },
  resultMeta: {
    textAlign:       'center',
  },
  resultTitle: {
    fontFamily:      'var(--font-display)',
    fontSize:        36,
    fontWeight:      300,
    color:           'var(--text)',
    letterSpacing:   '0.03em',
    marginBottom:    10,
  },
  resultSub: {
    color:           'var(--text-muted)',
    fontSize:        12,
    letterSpacing:   '0.04em',
  },
  resultImgWrap: {
    position:        'relative',
    width:           '100%',
    paddingBottom:   '62.5%',
    background:      'var(--surface)',
    borderRadius:    6,
    overflow:        'hidden',
    border:          '1px solid var(--border)',
  },
  resultActions: {
    display:         'flex',
    gap:             12,
    flexWrap:        'wrap',
    justifyContent:  'center',
  },

  // Reference row
  refRow: {
    display:    'flex',
    alignItems: 'center',
    gap:        16,
    width:      '100%',
    maxWidth:   840,
  },
  refLabel: {
    fontFamily:    'var(--font-mono)',
    fontSize:      10,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color:         'var(--text-muted)',
    flexShrink:    0,
  },
  refThumbWrap: {
    position:     'relative',
    width:        72,
    height:       72,
    borderRadius: 4,
    overflow:     'hidden',
    border:       '1px solid var(--border)',
    cursor:       'pointer',
    flexShrink:   0,
  },
  refThumb: {
    width:      '100%',
    height:     '100%',
    objectFit:  'cover',
    display:    'block',
  },
  refThumbEmpty: {
    width:          '100%',
    height:         '100%',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    background:     'var(--surface)',
    color:          'var(--border-light)',
    fontSize:       20,
  },
  refThumbOverlay: {
    position:       'absolute',
    inset:          0,
    background:     'rgba(0,0,0,0)',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    transition:     'background 0.2s',
  },
  refThumbOverlayText: {
    color:         'transparent',
    fontFamily:    'var(--font-mono)',
    fontSize:      9,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    background:    'rgba(10,8,7,0.75)',
    border:        '1px solid var(--border-light)',
    borderRadius:  3,
    padding:       '4px 8px',
    transition:    'color 0.2s',
    pointerEvents: 'none',
  },
  refHint: {
    color:         'var(--text-muted)',
    fontSize:      10,
    letterSpacing: '0.04em',
    lineHeight:    1.5,
  },

  // Save reference banner
  saveRefBanner: {
    width:          '100%',
    maxWidth:       840,
    background:     'linear-gradient(135deg, rgba(242,56,1,0.06) 0%, rgba(255,174,20,0.06) 100%)',
    border:         '1px solid rgba(242,56,1,0.25)',
    borderRadius:   6,
    padding:        '14px 18px',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    gap:            16,
    flexWrap:       'wrap' as const,
  },
  saveRefLeft: {
    display:    'flex',
    alignItems: 'center',
    gap:        10,
    flex:       1,
    minWidth:   180,
  },
  saveRefIcon: {
    color:     'var(--orange)',
    fontSize:  16,
    flexShrink: 0,
  },
  saveRefText: {
    fontSize:      11,
    color:         'var(--text-secondary)',
    letterSpacing: '0.02em',
  },
  saveRefRight: {
    display:    'flex',
    alignItems: 'center',
    gap:        8,
    flexShrink: 0,
  },
  saveRefInput: {
    background:    'var(--surface)',
    border:        '1px solid var(--border-light)',
    borderRadius:  4,
    padding:       '6px 10px',
    fontFamily:    'var(--font-mono)',
    fontSize:      11,
    color:         'var(--text)',
    outline:       'none',
    width:         180,
  },
  saveRefDone: {
    width:      '100%',
    maxWidth:   840,
    display:    'flex',
    alignItems: 'center',
    gap:        8,
    fontSize:   11,
    color:      'var(--text-muted)',
    padding:    '10px 0',
  },
}

// ── Crop tool styles ──────────────────────────────────────────────────────────

const ct: Record<string, React.CSSProperties> = {
  wrap: {
    width:          '100%',
    maxWidth:       840,
    display:        'flex',
    flexDirection:  'column',
    gap:            16,
    border:         '1px solid var(--border)',
    borderRadius:   6,
    padding:        20,
    background:     'var(--surface)',
  },
  ratioRow: {
    display:        'flex',
    gap:            6,
    flexWrap:       'wrap',
  },
  ratioBtn: {
    padding:        '5px 12px',
    border:         '1px solid',
    borderRadius:   4,
    fontSize:       10,
    fontFamily:     'var(--font-mono)',
    letterSpacing:  '0.08em',
    cursor:         'pointer',
    transition:     'all 0.15s',
  },
  imgWrap: {
    position:       'relative',
    width:          '100%',
    userSelect:     'none',
    cursor:         'crosshair',
    lineHeight:     0,
  },
  img: {
    width:          '100%',
    height:         'auto',
    display:        'block',
    borderRadius:   4,
  },
  canvas: {
    position:       'absolute',
    inset:          0,
    width:          '100%',
    height:         '100%',
    pointerEvents:  'none',
  },
  handle: {
    position:       'absolute',
    width:          10,
    height:         10,
    background:     'white',
    border:         '1.5px solid rgba(255,255,255,0.9)',
    borderRadius:   2,
    boxShadow:      '0 0 4px rgba(0,0,0,0.5)',
    zIndex:         10,
    pointerEvents:  'none',
  },
}
