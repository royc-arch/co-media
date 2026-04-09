'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Job } from '@/types'
import Image from 'next/image'

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

const DIRECTION_LEVELS = [
  { value: 'decrease',          label: '−' },
  { value: 'slightly decrease', label: '↓' },
  { value: 'keep moderate',     label: '○' },
  { value: 'slightly increase', label: '↑' },
  { value: 'increase',          label: '+' },
] as const

const DIRECTION_TITLES: Record<string, string> = {
  'decrease':          'Decrease',
  'slightly decrease': 'Slightly Decrease',
  'keep moderate':     'Keep Moderate',
  'slightly increase': 'Slightly Increase',
  'increase':          'Increase',
}

function normalizeDir(v: string): string {
  if (v === 'reduce aggressively') return 'decrease'
  return v
}

const STEP_LABELS: Record<string, string> = {
  uploading:           'Uploading images…',
  'analyzing-style':   'Analyzing reference aesthetic…',
  'analyzing-subject': 'Reading original photo…',
  generating:          'Applying style transfer…',
  analyzing:           'Analysing reference atmosphere…',
}

export default function JobDetailClient({ job }: { job: Job }) {
  const router   = useRouter()
  const supabase = createClient()

  const [intensity,       setIntensity]       = useState(80)
  const [foodAnalysis,    setFoodAnalysis]    = useState<FoodAnalysis | null>(null)
  const [referenceFile,   setReferenceFile]   = useState<File | null>(null)
  const [referencePreview,setReferencePreview]= useState<string | null>(null)
  const [stage,           setStage]           = useState<'idle' | 'processing' | 'done' | 'error'>('idle')
  const refInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!referenceFile) return
    const url = URL.createObjectURL(referenceFile)
    setReferencePreview(url)
    return () => URL.revokeObjectURL(url)
  }, [referenceFile])
  const [stepKey,     setStepKey]     = useState('uploading')
  const [error,       setError]       = useState<string | null>(null)
  const [selectedUrl, setSelectedUrl] = useState(job.output_url!)
  const [versions,    setVersions]    = useState<Array<{ url: string; intensity: number }>>([
    { url: job.output_url!, intensity: NaN },
  ])

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) router.push('/auth')
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleReapply() {
    setStage('processing')
    setStepKey('uploading')
    setError(null)

    try {
      const formData = new FormData()
      formData.append('image1_url', job.image1_url)
      if (referenceFile) {
        formData.append('image2', referenceFile, 'reference.jpg')
      } else {
        formData.append('image2_url', job.image2_url)
      }
      formData.append('jobId', crypto.randomUUID())
      formData.append('intensity', String(intensity))
      if (foodAnalysis) formData.append('food_analysis', JSON.stringify(foodAnalysis))

      const res = await fetch('/api/transform', { method: 'POST', body: formData })
      if (!res.ok || !res.body) throw new Error('Transform request failed')

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
                setSelectedUrl(data.outputUrl)
                setVersions(prev => [...prev, { url: data.outputUrl, intensity }])
                if (data.foodAnalysis) setFoodAnalysis(data.foodAnalysis)
                setStage('done')
              }
              if (currentEvent === 'error') { setError(data.message); setStage('error') }
            } catch { /* skip malformed */ }
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setStage('error')
    }
  }

  const isProcessing = stage === 'processing'

  const date = new Date(job.created_at).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  })

  async function signOut() {
    await supabase.auth.signOut()
    router.push('/auth')
    router.refresh()
  }

  return (
    <div style={s.page}>
      {/* Header */}
      <header style={s.header}>
        <div style={s.headerInner}>
          <a href="/" style={s.logo}>
            <span style={s.logoMark}>◈</span>
            <span style={s.logoName}>Co.Media</span>
          </a>
          <nav style={s.nav}>
            <a href="/" style={s.navLink}>Style Transfer</a>
            <span style={s.navSep}>·</span>
            <a href="/showcase" style={s.navLink}>Video Showcase</a>
            <span style={s.navSep}>·</span>
            <a href="/history" style={{ ...s.navLink, color: 'var(--orange)' }}>Works</a>
            <span style={s.navSep}>·</span>
            <a href="/references" style={s.navLink}>References</a>
            <span style={s.navSep}>·</span>
            <button onClick={signOut} style={s.navBtn}>Sign Out</button>
          </nav>
        </div>
      </header>

      <main style={s.main}>

        {/* Page title */}
        <div style={s.pageHeader} className="animate-fade-up">
          <a href="/history" style={s.backLink}>← Gallery</a>
          <p style={s.pageDate}>{date}</p>
        </div>

        {/* Main result image */}
        <div style={s.resultWrap} className="animate-fade-up">
          <div style={s.resultImgWrap}>
            <Image
              src={selectedUrl}
              alt="Result"
              fill
              style={{ objectFit: 'contain' }}
              sizes="(max-width: 900px) 90vw, 840px"
              priority
            />
          </div>
        </div>

        {/* Version strip */}
        {versions.length > 1 && (
          <div style={s.versionStrip} className="animate-fade-up">
            {versions.map((v, i) => (
              <div
                key={i}
                style={s.versionItem}
                onClick={() => setSelectedUrl(v.url)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={v.url}
                  alt={`v${i + 1}`}
                  style={{
                    ...s.versionThumb,
                    outline: selectedUrl === v.url ? '2px solid var(--gold)' : 'none',
                  }}
                />
                <span style={s.versionLabel}>
                  {i === 0 ? 'Original' : `v${i + 1}`}
                </span>
                {!isNaN(v.intensity) && (
                  <span style={s.versionSub}>{v.intensity}%</span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Source images */}
        <div style={s.sourceRow} className="animate-fade-up">
          <div style={s.sourceItem}>
            <div style={s.sourceImgWrap}>
              <Image src={job.image1_url} alt="Subject" fill style={{ objectFit: 'cover' }} sizes="120px" />
            </div>
            <span style={s.sourceLabel}>Subject</span>
          </div>
          <span style={s.sourceArrow}>→</span>
          <div style={s.sourceItem}>
            <div
              className="ref-thumb-wrap"
              style={{ ...s.sourceImgWrap, cursor: 'pointer' }}
              onClick={() => refInputRef.current?.click()}
            >
              {referencePreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={referencePreview} alt="Style" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              ) : (
                <Image src={job.image2_url} alt="Style" fill style={{ objectFit: 'cover' }} sizes="120px" />
              )}
              <div className="ref-overlay" style={s.sourceOverlay}>
                <span className="ref-overlay-text" style={s.sourceOverlayText}>Change</span>
              </div>
            </div>
            <span style={s.sourceLabel}>
              Style Reference
              {referencePreview && <span style={s.sourceLabelChanged}> · changed</span>}
            </span>
            <input
              ref={refInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              style={{ display: 'none' }}
              onChange={e => {
                const f = e.target.files?.[0]
                if (f) setReferenceFile(f)
                e.target.value = ''
              }}
            />
          </div>
        </div>

        {/* Intensity + re-apply */}
        <div style={s.controls} className="animate-fade-up">
          {/* Food analysis panel */}
          {foodAnalysis && (
            <FoodAnalysisPanel
              analysis={foodAnalysis}
              onChange={setFoodAnalysis}
              disabled={isProcessing}
            />
          )}

          <div style={{ ...s.intensityHeader, marginTop: foodAnalysis ? 20 : 4 }}>
            <span style={s.intensityLabel}>Atmosphere Intensity</span>
            <span style={s.intensityValue}>{intensity}%</span>
          </div>
          <input
            type="range"
            min={10} max={100} step={5}
            value={intensity}
            onChange={e => setIntensity(Number(e.target.value))}
            disabled={isProcessing}
            style={s.slider}
          />
          <div style={s.sliderHints}>
            <span>Subtle</span><span>Full</span>
          </div>

          {isProcessing && (
            <div style={s.progressWrap}>
              <div style={s.spinner} />
              <span style={s.progressLabel}>{STEP_LABELS[stepKey] ?? 'Processing…'}</span>
              <span style={s.progressHint}>Takes 30–60 seconds</span>
            </div>
          )}

          {stage === 'error' && error && (
            <p style={s.errorMsg}>{error}</p>
          )}

          <div style={s.actions}>
            <button
              className="btn btn-gold"
              onClick={handleReapply}
              disabled={isProcessing}
              style={{ minWidth: 140 }}
            >
              {isProcessing ? 'Applying…' : 'Re-apply →'}
            </button>
            <a
              href={selectedUrl}
              download="retouch-output.png"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-ghost"
            >
              Download
            </a>
          </div>
        </div>

      </main>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: 'var(--bg)',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    borderBottom: '1px solid var(--border)',
    background: 'var(--header-bg)',
    backdropFilter: 'blur(12px)',
    position: 'sticky',
    top: 0,
    zIndex: 100,
  },
  headerInner: {
    maxWidth: 1100,
    margin: '0 auto',
    padding: '0 24px',
    height: 56,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    textDecoration: 'none',
    color: 'var(--text)',
  },
  logoMark: { color: 'var(--orange)', fontSize: 18 },
  logoName: {
    fontFamily: 'var(--font-display)',
    fontSize: 22,
    fontWeight: 700,
    letterSpacing: '-0.01em',
    color: '#FFFFFF',
  },
  nav: { display: 'flex', alignItems: 'center', gap: 14 },
  navLink: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 11,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    textDecoration: 'none',
    transition: 'color 0.15s',
  },
  navSep: { color: 'rgba(255,255,255,0.2)', fontSize: 12 },
  navBtn: {
    background: 'none',
    border: 'none',
    color: 'rgba(255,255,255,0.55)',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    cursor: 'pointer',
    padding: 0,
    transition: 'color 0.15s',
  },
  main: {
    maxWidth: 900,
    margin: '0 auto',
    padding: '48px 24px 80px',
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: 36,
  },
  pageHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  backLink: {
    color: 'var(--text-muted)',
    fontSize: 11,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    textDecoration: 'none',
    transition: 'color 0.15s',
  },
  pageDate: {
    color: 'var(--text-muted)',
    fontSize: 11,
    letterSpacing: '0.06em',
  },
  resultWrap: { width: '100%' },
  resultImgWrap: {
    position: 'relative',
    width: '100%',
    paddingBottom: '62.5%',
    background: 'var(--surface)',
    borderRadius: 6,
    overflow: 'hidden',
    border: '1px solid var(--border)',
  },
  versionStrip: {
    display: 'flex',
    gap: 12,
    overflowX: 'auto',
    paddingBottom: 4,
  },
  versionItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 5,
    flexShrink: 0,
    cursor: 'pointer',
  },
  versionThumb: {
    width: 88,
    height: 88,
    objectFit: 'cover',
    borderRadius: 4,
    border: '1px solid var(--border)',
  },
  versionLabel: {
    fontSize: 9,
    letterSpacing: '0.10em',
    textTransform: 'uppercase',
    color: 'var(--text-muted)',
  },
  versionSub: {
    fontSize: 9,
    color: 'var(--gold-dim)',
    letterSpacing: '0.06em',
  },
  sourceRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 20,
  },
  sourceItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
  },
  sourceImgWrap: {
    position: 'relative',
    width: 100,
    height: 100,
    borderRadius: 4,
    overflow: 'hidden',
    border: '1px solid var(--border)',
  },
  sourceLabel: {
    color: 'var(--text-muted)',
    fontSize: 9,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
  },
  sourceArrow: {
    color: 'var(--gold-dim)',
    fontSize: 18,
    marginTop: -20,
  },
  sourceOverlay: {
    position:       'absolute',
    inset:          0,
    background:     'rgba(0,0,0,0)',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    transition:     'background 0.2s',
  },
  sourceOverlayText: {
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
  sourceLabelChanged: {
    color:         'var(--gold)',
    fontSize:      9,
    letterSpacing: '0.08em',
  },
  controls: {
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
    maxWidth: 560,
  },
  intensityHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 10,
  },
  intensityLabel: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: 'var(--text-muted)',
  },
  intensityValue: {
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
    color: 'var(--gold)',
  },
  slider: {
    width: '100%',
    accentColor: 'var(--gold)',
    cursor: 'pointer',
    height: 2,
  },
  sliderHints: {
    display: 'flex',
    justifyContent: 'space-between',
    marginTop: 6,
    marginBottom: 24,
    fontSize: 9,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--text-muted)',
  },
  progressWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    marginBottom: 20,
  },
  spinner: {
    width: 20,
    height: 20,
    border: '2px solid var(--border-light)',
    borderTopColor: 'var(--gold)',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  progressLabel: {
    color: 'var(--text-secondary)',
    fontSize: 12,
    letterSpacing: '0.06em',
  },
  progressHint: {
    color: 'var(--text-muted)',
    fontSize: 10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  },
  errorMsg: {
    color: 'var(--error)',
    fontSize: 12,
    marginBottom: 16,
  },
  actions: {
    display: 'flex',
    gap: 12,
    flexWrap: 'wrap',
  },
}

// ── Food style picker ─────────────────────────────────────────────────────────

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
          <div style={fa.tags}>
            <span style={{ ...fa.tag, ...fa.tagPrimary }}>{analysis.primary_type}</span>
            {analysis.secondary_types.map(t => (
              <span key={t} style={{ ...fa.tag, ...fa.tagSecondary }}>{t}</span>
            ))}
            {analysis.visual_features.map(f => (
              <span key={f} style={fa.tag}>{f}</span>
            ))}
          </div>
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
  wrap:         { width: '100%', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' },
  toggle:       { width: '100%', background: 'var(--card)', border: 'none', padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', textAlign: 'left' },
  toggleLeft:   { display: 'flex', alignItems: 'center', gap: 12 },
  toggleLabel:  { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-muted)' },
  toggleType:   { fontSize: 11, color: 'var(--gold)', letterSpacing: '0.04em' },
  toggleChevron:{ fontSize: 9, color: 'var(--text-muted)' },
  body:         { padding: '16px', borderTop: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', flexDirection: 'column', gap: 16 },
  tags:         { display: 'flex', flexWrap: 'wrap', gap: 6 },
  tag:          { padding: '3px 10px', border: '1px solid var(--border)', borderRadius: 20, fontSize: 9, letterSpacing: '0.08em', color: 'var(--text-muted)', background: 'var(--card)' },
  tagPrimary:   { borderColor: 'var(--gold)', color: 'var(--gold)' },
  tagSecondary: { borderColor: 'var(--border-light)', color: 'var(--text-secondary)' },
  grid:         { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  row:          { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  paramLabel:   { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--text-muted)', minWidth: 70 },
  btns:         { display: 'flex', gap: 3 },
  dirBtn:       { width: 24, height: 24, border: '1px solid', borderRadius: 3, fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 0.12s, border-color 0.12s', fontFamily: 'var(--font-mono)', padding: 0 },
}
