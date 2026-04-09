'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

// ── Types ─────────────────────────────────────────────────────────────────────

type ShowcaseType = 'hero_push' | 'orbit' | 'birdview' | 'detail' | 'three_act'
type ClipKey      = Exclude<ShowcaseType, 'three_act'>
type Duration     = '0' | '5'
type Stage        = 'idle' | 'streaming' | 'polling' | 'done' | 'error'
type VideoStep    = 'uploading' | 'analyzing-dish' | 'analyzing' | 'transforming' | 'generating'

// ── Showcase definitions ──────────────────────────────────────────────────────

const SHOWCASE_TYPES: Record<Exclude<ShowcaseType, 'three_act'>, {
  label: string; tagline: string; camera: string; feel: string; icon: string; riskLevel: 'low' | 'medium' | 'high'
}> = {
  hero_push: {
    label: 'Hero Push', tagline: 'The classic.', camera: 'Slow cinematic push in',
    feel: 'Universal · Menu-ready · Most stable', icon: '▶', riskLevel: 'low',
  },
  orbit: {
    label: 'Orbit', tagline: 'Full circle.', camera: 'Very slow 360° orbit',
    feel: 'Premium · Cover shot · Tasting menu', icon: '◎', riskLevel: 'medium',
  },
  birdview: {
    label: 'Birdview', tagline: 'Rise above.', camera: 'Front angle → directly overhead arc',
    feel: 'Editorial · Flat lay reveal · Instagram', icon: '⊙', riskLevel: 'low',
  },
  detail: {
    label: 'Detail', tagline: 'Get close.', camera: 'Macro close-up · Ultra sharp texture',
    feel: 'Michelin · Print · Appetite-first', icon: '◉', riskLevel: 'low',
  },
}

// ── Step definitions ──────────────────────────────────────────────────────────

const ALL_STEPS: { key: VideoStep; label: string; desc: string }[] = [
  { key: 'uploading',       label: 'Uploading',            desc: 'Uploading images to the cloud' },
  { key: 'analyzing-dish',  label: 'Analysing dish',       desc: 'Identifying dish type for physically correct motion' },
  { key: 'analyzing',       label: 'Analysing aesthetic',  desc: 'Reading your reference for lighting and mood' },
  { key: 'transforming',    label: 'Style transfer',       desc: 'Applying your reference aesthetic to the photo' },
  { key: 'generating',      label: 'Co.Media AI is rendering your video', desc: 'Generating cinematic video — est. 2–4 min' },
]


// ── Image compression ─────────────────────────────────────────────────────────

async function compressImage(file: File, maxPx = 1280): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new window.Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width  = Math.round(img.width  * scale)
      canvas.height = Math.round(img.height * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('Canvas unavailable')); return }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error('Compression failed')),
        'image/jpeg', 0.95,
      )
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')) }
    img.src = url
  })
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ShowcasePage() {
  const router   = useRouter()
  const supabase = createClient()

  const [imageFile,    setImageFile]    = useState<File | null>(null)
  const [refFile,      setRefFile]      = useState<File | null>(null)
  const [dishName,     setDishName]     = useState('')
  const [showcase,      setShowcase]      = useState<ShowcaseType>('hero_push')
  const [detailCrop,    setDetailCrop]    = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [clipDurations, setClipDurations] = useState<Record<ClipKey, Duration>>({
    hero_push: '5', orbit: '5', birdview: '5', detail: '5',
  })
  const [stage,        setStage]        = useState<Stage>('idle')
  const [currentStep,  setCurrentStep]  = useState<VideoStep | null>(null)
  const [videoUrl,     setVideoUrl]     = useState<string | null>(null)
  const [error,        setError]        = useState<string | null>(null)
  const [videoJobId,    setVideoJobId]    = useState<string | null>(null)
  const [taskId,        setTaskId]        = useState<string | null>(null)
  const [clipTaskIds,   setClipTaskIds]   = useState<string[]>([])
  const [clipDoneCount, setClipDoneCount] = useState(0)

  const pollRef           = useRef<ReturnType<typeof setInterval> | null>(null)
  const [pollProgress, setPollProgress] = useState(0)
  const pollStartRef      = useRef<number>(0)
  const clipDurationsSnap = useRef<Record<ClipKey, Duration>>(clipDurations)

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) router.push('/auth')
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Slow-fill progress bar during Co.Media AI polling (~3 min estimate)
  useEffect(() => {
    if (stage !== 'polling') { setPollProgress(0); return }
    pollStartRef.current = Date.now()
    const ESTIMATE_MS = showcase === 'three_act' ? 5 * 60 * 1000 : 3 * 60 * 1000
    const tick = setInterval(() => {
      const pct = Math.min(92, ((Date.now() - pollStartRef.current) / ESTIMATE_MS) * 100)
      setPollProgress(pct)
    }, 1000)
    return () => clearInterval(tick)
  }, [stage, showcase])

  // Polling
  const pollFailsRef = useRef(0)

  // Single-clip polling (hero_push / orbit / birdview / detail)
  useEffect(() => {
    if (stage !== 'polling' || !taskId || clipTaskIds.length > 0) return
    pollFailsRef.current = 0
    pollRef.current = setInterval(async () => {
      try {
        const params = new URLSearchParams({ taskId })
        if (videoJobId) params.set('videoJobId', videoJobId)
        const res  = await fetch(`/api/video/status?${params}`)
        const data = await res.json() as { status: string; videoUrl?: string; error?: string }
        pollFailsRef.current = 0
        if (data.status === 'done' && data.videoUrl) {
          clearInterval(pollRef.current!)
          setPollProgress(100)
          setTimeout(() => { setVideoUrl(data.videoUrl!); setStage('done') }, 400)
        } else if (data.status === 'failed') {
          clearInterval(pollRef.current!)
          setError(data.error ?? 'Video generation failed')
          setStage('error')
        }
      } catch (err) {
        pollFailsRef.current += 1
        if (pollFailsRef.current >= 3) {
          clearInterval(pollRef.current!)
          setError(err instanceof Error ? err.message : 'Failed to check video status')
          setStage('error')
        }
      }
    }, 4000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [stage, taskId, videoJobId, clipTaskIds.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Multi-clip polling (three_act — 4 clips then stitch)
  useEffect(() => {
    if (stage !== 'polling' || clipTaskIds.length === 0) return
    pollFailsRef.current = 0
    const doneUrls: Record<string, string> = {}

    pollRef.current = setInterval(async () => {
      try {
        const pendingIds = clipTaskIds.filter(id => !doneUrls[id])
        for (const id of pendingIds) {
          const res  = await fetch(`/api/video/status?taskId=${id}`)
          const data = await res.json() as { status: string; videoUrl?: string; error?: string }
          if (data.status === 'done' && data.videoUrl) {
            doneUrls[id] = data.videoUrl
          } else if (data.status === 'failed') {
            clearInterval(pollRef.current!)
            setError(data.error ?? 'A clip failed to generate')
            setStage('error')
            return
          }
        }
        pollFailsRef.current = 0

        const doneCount = Object.keys(doneUrls).length
        setClipDoneCount(doneCount)
        setPollProgress(Math.round((doneCount / clipTaskIds.length) * 85))

        if (doneCount === clipTaskIds.length) {
          clearInterval(pollRef.current!)
          setPollProgress(90)
          try {
            const res = await fetch('/api/video/stitch', {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                videoJobId,
                videoUrls:      clipTaskIds.map(id => doneUrls[id]),
                useTransitions: true,
                clipDurations:  (['hero_push','orbit','birdview','detail'] as ClipKey[])
                                  .filter(k => clipDurationsSnap.current[k] !== '0')
                                  .map(k => parseInt(clipDurationsSnap.current[k])),
                fadeDuration:   0.5,
              }),
            })
            const stitchData = await res.json() as { videoUrl?: string; error?: string }
            if (!res.ok || !stitchData.videoUrl) throw new Error(stitchData.error ?? 'Stitch failed')
            setPollProgress(100)
            setTimeout(() => { setVideoUrl(stitchData.videoUrl!); setStage('done') }, 400)
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Stitch failed')
            setStage('error')
          }
        }
      } catch (err) {
        pollFailsRef.current += 1
        if (pollFailsRef.current >= 3) {
          clearInterval(pollRef.current!)
          setError(err instanceof Error ? err.message : 'Failed to check clip status')
          setStage('error')
        }
      }
    }, 4000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [stage, clipTaskIds, videoJobId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleGenerate() {
    if (!imageFile) return
    setStage('streaming')
    setCurrentStep('uploading')
    setError(null)
    setVideoUrl(null)
    setTaskId(null)
    setVideoJobId(null)
    clipDurationsSnap.current = clipDurations

    const needsCrop = showcase === 'detail' || (showcase === 'three_act' && clipDurations.detail !== '0')
    if (needsCrop && !detailCrop) {
      setError('Please drag to select the detail area on your photo')
      setStage('error')
      return
    }

    try {
      const blob = await compressImage(imageFile, 2048)
      const fd   = new FormData()
      fd.append('image', blob, 'food.jpg')
      if (refFile) {
        const refBlob = await compressImage(refFile, 2048)
        fd.append('reference', refBlob, 'reference.jpg')
      }
      fd.append('showcase', showcase)
      fd.append('duration', '5')
      if (showcase === 'three_act') fd.append('clipDurations', JSON.stringify(clipDurations))
      if (detailCrop) fd.append('detailCrop', JSON.stringify(detailCrop))
      if (dishName.trim()) fd.append('dishName', dishName.trim())

      const response = await fetch('/api/video/generate', { method: 'POST', body: fd })
      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error((err as { error?: string }).error ?? 'Failed to start generation')
      }

      const reader  = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''

        for (const part of parts) {
          if (!part.trim()) continue
          let type = '', dataStr = ''
          for (const line of part.split('\n')) {
            if (line.startsWith('event: ')) type    = line.slice(7).trim()
            if (line.startsWith('data: '))  dataStr = line.slice(6).trim()
          }
          if (!type || !dataStr) continue

          let data: Record<string, unknown>
          try { data = JSON.parse(dataStr) } catch { continue }

          if (type === 'progress') {
            setCurrentStep(data.step as VideoStep)
          } else if (type === 'done') {
            setVideoJobId(data.videoJobId as string)
            if (Array.isArray(data.clipTaskIds)) {
              setClipTaskIds(data.clipTaskIds as string[])
            } else {
              setTaskId(data.taskId as string)
            }
            setCurrentStep('generating')
            setStage('polling')
          } else if (type === 'error') {
            throw new Error((data.message as string) ?? 'Unknown error')
          }
        }
      }

      // Handle any remaining buffered event (stream closed without trailing \n\n)
      if (buffer.trim()) {
        let type = '', dataStr = ''
        for (const line of buffer.split('\n')) {
          if (line.startsWith('event: ')) type    = line.slice(7).trim()
          if (line.startsWith('data: '))  dataStr = line.slice(6).trim()
        }
        if (type === 'error' && dataStr) {
          try { throw new Error((JSON.parse(dataStr) as { message?: string }).message ?? 'Unknown error') } catch { /* ignore */ }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setStage('error')
    }
  }

  function reset() {
    setImageFile(null)
    setRefFile(null)
    setDishName('')
    setShowcase('hero_push')
    setStage('idle')
    setCurrentStep(null)
    setVideoUrl(null)
    setError(null)
    setTaskId(null)
    setVideoJobId(null)
    setClipTaskIds([])
    setClipDoneCount(0)
    setClipDurations({ hero_push: '5', orbit: '5', birdview: '5', detail: '5' })
    setDetailCrop(null)
    setPollProgress(0)
    if (pollRef.current) clearInterval(pollRef.current)
  }

  const isActive     = stage === 'streaming' || stage === 'polling'
  const visibleSteps = ALL_STEPS
    .filter(s => {
      if (s.key === 'analyzing' || s.key === 'transforming') return !!refFile
      return true
    })
    .map(s => {
      if (s.key === 'generating' && showcase === 'three_act' && clipTaskIds.length > 0) {
        return { ...s, desc: `Generating 4 clips (${clipDoneCount}/${clipTaskIds.length} done) — est. 4–5 min` }
      }
      return s
    })

  return (
    <div style={s.page}>
      <Header />
      <main style={s.main}>

        {/* Hero */}
        <div style={s.hero} className="animate-fade-up">
          <div style={s.heroEyebrow}>Video Showcase Studio</div>
          <h1 style={s.heroTitle}>Bring Your Dish to Life</h1>
          <p style={s.heroSub}>
            Upload your food photo and an optional style reference.
            We'll apply your aesthetic, then render a cinematic video.
          </p>
        </div>

        {/* Upload + config */}
        {stage !== 'done' && (
          <div style={s.uploadSection} className="animate-fade-up">

            {/* Two upload zones */}
            <div style={s.uploadRow}>
              <div style={s.uploadCol}>
                <div style={s.uploadColLabel}>
                  Food Photo <span style={s.required}>required</span>
                </div>
                <DropZone
                  file={imageFile} onFile={f => { setImageFile(f); setDetailCrop(null) }} disabled={isActive}
                  cropMode={(showcase === 'detail' || (showcase === 'three_act' && clipDurations.detail !== '0')) && !!imageFile && !isActive}
                  crop={detailCrop}
                  onCrop={setDetailCrop}
                />
              </div>
              <div style={s.uploadColDivider}>
                <span style={{ color: 'var(--border-light)', fontSize: 20 }}>+</span>
              </div>
              <div style={s.uploadCol}>
                <div style={s.uploadColLabel}>
                  Style Reference <span style={s.optional}>optional</span>
                </div>
                <DropZone file={refFile} onFile={setRefFile} disabled={isActive} accent="gold" />
              </div>
            </div>

            {/* Dish name input */}
            {imageFile && !isActive && stage !== 'error' && (
              <div style={s.dishInputRow}>
                <label style={s.dishInputLabel}>
                  What&apos;s in your photo? <span style={s.optional}>optional · helps with realistic motion</span>
                </label>
                <input
                  type="text"
                  value={dishName}
                  onChange={e => setDishName(e.target.value)}
                  placeholder="e.g. sushi rolls, beef ramen, chocolate lava cake, iced cocktail…"
                  maxLength={80}
                  style={s.dishInput}
                />
              </div>
            )}

            {/* Config (only when food photo uploaded and not active) */}
            {imageFile && !isActive && stage !== 'error' && (
              <>
                <div style={s.sectionHeader}>
                  <span style={s.sectionTitle}>Cinematic Treatment</span>
                </div>

                {/* Standard 4 types */}
                <div style={s.typeGrid}>
                  {(Object.entries(SHOWCASE_TYPES) as [Exclude<ShowcaseType, 'three_act'>, typeof SHOWCASE_TYPES[Exclude<ShowcaseType, 'three_act'>]][]).map(([key, def]) => {
                    const active = showcase === key
                    return (
                      <button
                        key={key}
                        onClick={() => setShowcase(key)}
                        style={{
                          ...s.typeCard,
                          borderColor: active ? 'var(--teal)' : 'var(--border)',
                          background:  active ? 'var(--teal-glow)' : 'var(--card)',
                        }}
                      >
                        <div style={{ ...s.typeIcon, color: active ? 'var(--teal)' : 'var(--border-light)' }}>
                          {def.icon}
                        </div>
                        <div style={{ ...s.typeLabel, color: active ? 'var(--teal)' : 'var(--text)' }}>
                          {def.label}
                        </div>
                        <div style={s.typeTagline}>{def.tagline}</div>
                        <div style={s.typeCamera}>{def.camera}</div>
                        <div style={s.typeFeel}>{def.feel}</div>
                        {def.riskLevel === 'high' && (
                          <div style={s.riskBadge}>⚠ Higher deformation risk</div>
                        )}
                      </button>
                    )
                  })}
                </div>

                {/* Combo — premium card, full width */}
                <ComboCard
                  active={showcase === 'three_act'}
                  onClick={() => setShowcase('three_act')}
                  clipDurations={clipDurations}
                  onClipDurationChange={(key, dur) => setClipDurations(prev => ({ ...prev, [key]: dur }))}
                />

                <button
                  className="btn"
                  onClick={handleGenerate}
                  style={showcase === 'three_act' ? s.generateBtnGold : s.generateBtn}
                >
                  {showcase === 'three_act'
                    ? (() => {
                        const activeSec = Object.values(clipDurations).reduce((s, d) => s + (d === '0' ? 0 : parseInt(d)), 0)
                        return `Generate Combo (${activeSec}s) →`
                      })()
                    : 'Generate Video →'
                  }
                </button>
              </>
            )}

            {/* Progress steps */}
            {isActive && (
              <StepProgress
                steps={visibleSteps}
                currentStep={currentStep}
                stage={stage}
                pollProgress={pollProgress}
              />
            )}

            {/* Error */}
            {stage === 'error' && (
              <div style={s.errorWrap}>
                <span style={s.errorMsg}>{error}</span>
                <button className="btn btn-ghost" onClick={reset} style={{ marginTop: 12 }}>
                  Try Again
                </button>
              </div>
            )}
          </div>
        )}

        {/* Result */}
        {stage === 'done' && videoUrl && (
          <div style={s.resultSection} className="animate-fade-up">
            <div style={s.resultMeta}>
              <h2 style={s.resultTitle}>
                {showcase === 'three_act' ? 'Your Combo is Ready' : 'Your Showcase is Ready'}
              </h2>
              <p style={s.resultSub}>
                {showcase === 'three_act'
                  ? (() => {
                      const snap        = clipDurationsSnap.current
                      const activeSec   = Object.values(snap).reduce((s, d) => s + (d === '0' ? 0 : parseInt(d)), 0)
                      const activeCount = Object.values(snap).filter(d => d !== '0').length
                      return `Combo · ${activeSec}s · ${activeCount} clips · kling-v3`
                    })()
                  : `${SHOWCASE_TYPES[showcase as Exclude<ShowcaseType, 'three_act'>]?.label ?? showcase} · 5s · kling-v3`
                }
              </p>
            </div>
            <video src={videoUrl} controls autoPlay loop playsInline style={s.videoPlayer} />
            <div style={s.resultActions}>
              <a
                href={videoUrl} download="food-showcase.mp4"
                target="_blank" rel="noopener noreferrer"
                className="btn"
                style={showcase === 'three_act' ? s.generateBtnGold : s.generateBtn}
              >
                Download MP4
              </a>
              <button className="btn btn-ghost" onClick={reset}>Create Another</button>
            </div>
          </div>
        )}

      </main>
    </div>
  )
}

// ── Combo premium card ────────────────────────────────────────────────────────

const CLIP_ENTRIES: [ClipKey, string][] = [
  ['hero_push', 'Hero Push'],
  ['orbit',     'Orbit'],
  ['birdview',  'Birdview'],
  ['detail',    'Detail'],
]

function ComboCard({
  active, onClick, clipDurations, onClipDurationChange,
}: {
  active:                boolean
  onClick:               () => void
  clipDurations:         Record<ClipKey, Duration>
  onClipDurationChange:  (key: ClipKey, dur: Duration) => void
}) {
  const activeSec   = CLIP_ENTRIES.reduce((s, [k]) => s + (clipDurations[k] === '0' ? 0 : parseInt(clipDurations[k])), 0)
  const activeCount = CLIP_ENTRIES.filter(([k]) => clipDurations[k] !== '0').length

  const accentColor = active ? 'var(--gold)' : 'var(--teal)'
  const accentGlow  = active ? 'var(--gold-glow)' : 'var(--teal-glow)'

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => e.key === 'Enter' && onClick()}
      style={{
        ...s.threeActCard,
        borderColor: active ? 'var(--gold)' : 'var(--border-light)',
        background:  active ? 'var(--gold-glow)' : 'var(--card)',
        boxShadow:   active ? '0 0 32px var(--gold-glow-strong)' : 'none',
      }}
    >
      {/* Premium badge */}
      <div style={s.premiumBadge}>Premium</div>

      {/* Header */}
      <div style={{ padding: '24px 28px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
          <span style={{ ...s.threeActIcon, color: active ? 'var(--gold)' : 'var(--gold-dim)' }}>◈</span>
          <span style={{ ...s.threeActTitle, color: active ? 'var(--gold-light)' : 'var(--text)' }}>Combo</span>
          <span style={s.threeActSub}>Mix any clips · set each duration</span>
        </div>
        <div style={s.threeActDesc}>
          Pick which camera angles to include and how long each runs — stitched into one premium reel.
        </div>
        <div style={s.threeActMeta}>
          {activeCount} clip{activeCount !== 1 ? 's' : ''} active · {activeSec}s total · {activeCount}× generation cost
        </div>
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: active ? 'rgba(201,169,110,0.18)' : 'var(--border)', margin: '0 0' }} />

      {/* Clip rows */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {CLIP_ENTRIES.map(([key, label], i) => {
          const skipped = clipDurations[key] === '0'
          const isLast  = i === CLIP_ENTRIES.length - 1
          return (
            <div
              key={key}
              style={{
                display:        'flex',
                alignItems:     'center',
                justifyContent: 'space-between',
                padding:        '14px 28px',
                borderBottom:   isLast ? 'none' : `1px solid ${active ? 'rgba(201,169,110,0.10)' : 'var(--border)'}`,
                opacity:        skipped ? 0.45 : 1,
                transition:     'opacity 0.2s',
              }}
            >
              {/* Label */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <span style={{
                  fontFamily: 'var(--font-display)', fontSize: 13,
                  color: active ? 'var(--gold-dim)' : 'var(--text-muted)',
                  width: 16, textAlign: 'center', flexShrink: 0,
                }}>
                  {i + 1}
                </span>
                <span style={{
                  fontFamily:     'var(--font-mono)',
                  fontSize:       11,
                  letterSpacing:  '0.08em',
                  textTransform:  'uppercase',
                  color:          skipped ? 'var(--text-muted)' : active ? 'var(--gold-light)' : 'var(--text)',
                  textDecoration: skipped ? 'line-through' : 'none',
                  transition:     'color 0.2s',
                }}>
                  {label}
                </span>
              </div>

              {/* Duration buttons */}
              <div style={{ display: 'flex', gap: 8 }} onClick={e => e.stopPropagation()}>
                {(['0', '5'] as Duration[]).map(d => {
                  const sel = clipDurations[key] === d
                  const isSkip = d === '0'
                  return (
                    <button
                      key={d}
                      onClick={e => { e.stopPropagation(); onClipDurationChange(key, d) }}
                      style={{
                        padding:      '6px 14px',
                        borderRadius: 5,
                        border:       '1px solid',
                        borderColor:  sel
                          ? (isSkip ? 'var(--border-light)' : accentColor)
                          : 'var(--border)',
                        color:  sel
                          ? (isSkip ? 'var(--text-secondary)' : accentColor)
                          : 'var(--text-muted)',
                        background: sel
                          ? (isSkip ? 'rgba(255,255,255,0.04)' : accentGlow)
                          : 'transparent',
                        fontSize:      11,
                        fontFamily:    'var(--font-mono)',
                        letterSpacing: '0.06em',
                        cursor:        'pointer',
                        transition:    'all 0.15s',
                        fontWeight:    sel ? 500 : 400,
                      }}
                    >
                      {isSkip ? 'skip' : `${d}s`}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Step progress component ───────────────────────────────────────────────────

function StepProgress({
  steps, currentStep, stage, pollProgress,
}: {
  steps:        { key: VideoStep; label: string; desc: string }[]
  currentStep:  VideoStep | null
  stage:        Stage
  pollProgress: number
}) {
  const ORDER: VideoStep[] = ['uploading', 'analyzing', 'transforming', 'generating']
  const currentIdx = currentStep ? ORDER.indexOf(currentStep) : -1

  return (
    <div style={sp.wrap}>
      {steps.map((step, i) => {
        const isDone   = ORDER.indexOf(step.key) < currentIdx
        const isActive = step.key === currentStep ||
          (stage === 'polling' && step.key === 'generating')

        return (
          <div key={step.key} style={sp.row}>
            {i > 0 && (
              <div style={{ ...sp.connector, background: isDone ? 'var(--teal)' : 'var(--border)' }} />
            )}

            <div style={sp.stepRow}>
              <div style={{
                ...sp.dot,
                borderColor: isDone || isActive ? 'var(--teal)' : 'var(--border)',
                background:  isDone ? 'var(--teal)' : isActive ? 'var(--teal-glow)' : 'var(--card)',
              }}>
                {isDone ? (
                  <span style={{ color: '#0A0807', fontSize: 10, fontWeight: 700 }}>✓</span>
                ) : isActive ? (
                  <TealSpinner size={10} />
                ) : (
                  <span style={{ color: 'var(--border-light)', fontSize: 9 }}>{i + 1}</span>
                )}
              </div>
              <div style={sp.textCol}>
                <span style={{ ...sp.label, color: isDone || isActive ? 'var(--text)' : 'var(--text-muted)' }}>
                  {step.label}
                </span>
                {isActive && <span style={sp.desc}>{step.desc}</span>}
              </div>
            </div>

            {/* Slow-fill time bar for Co.Media AI step */}
            {isActive && step.key === 'generating' && (
              <div style={sp.barWrap}>
                <div style={{ ...sp.barFill, width: `${pollProgress}%` }} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

const sp: Record<string, React.CSSProperties> = {
  wrap: {
    width: '100%', maxWidth: 480, display: 'flex', flexDirection: 'column',
    padding: '28px 32px', background: 'var(--card)', border: '1px solid var(--border)',
    borderRadius: 8, gap: 0,
  },
  row:       { display: 'flex', flexDirection: 'column', gap: 0 },
  connector: { width: 1, height: 20, marginLeft: 15, transition: 'background 0.3s' },
  stepRow:   { display: 'flex', alignItems: 'flex-start', gap: 14 },
  dot: {
    width: 30, height: 30, borderRadius: '50%', border: '1px solid',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, transition: 'all 0.3s',
  },
  textCol:  { display: 'flex', flexDirection: 'column', paddingTop: 5, gap: 3 },
  label:    { fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '0.08em', transition: 'color 0.3s' },
  desc:     { fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.04em' },
  barWrap: {
    marginTop: 12, marginLeft: 44, height: 2, background: 'var(--border)',
    borderRadius: 2, overflow: 'hidden', maxWidth: 280,
  },
  barFill: { height: '100%', background: 'var(--teal)', borderRadius: 2, transition: 'width 0.8s ease' },
}

// ── Header ────────────────────────────────────────────────────────────────────

function Header() {
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
        <a href="/" style={s.logo}>
          <span style={s.logoMark}>◈</span>
          <span style={s.logoName}>Co.Media</span>
        </a>
        <nav style={s.nav}>
          <a href="/" style={s.navLink}>Style Transfer</a>
          <span style={s.navSep}>·</span>
          <a href="/showcase" style={{ ...s.navLink, color: 'var(--orange)' }}>Video Showcase</a>
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
  file, onFile, disabled, accent = 'teal',
  cropMode = false, crop = null, onCrop,
}: {
  file: File | null; onFile: (f: File) => void; disabled: boolean; accent?: 'teal' | 'gold'
  cropMode?: boolean
  crop?: { x: number; y: number; w: number; h: number } | null
  onCrop?: (c: { x: number; y: number; w: number; h: number } | null) => void
}) {
  const [dragging,     setDragging]     = useState(false)
  const [preview,      setPreview]      = useState<string | null>(null)
  const [cropDragging, setCropDragging] = useState(false)
  const inputRef     = useRef<HTMLInputElement>(null)
  const cropStartRef = useRef<{ x: number; y: number } | null>(null)
  const cropContRef  = useRef<HTMLDivElement>(null)
  const accentColor  = accent === 'teal' ? 'var(--teal)' : 'var(--gold)'
  const accentGlow   = accent === 'teal' ? 'var(--teal-glow)' : 'var(--gold-glow)'

  useEffect(() => {
    if (!file) { setPreview(null); return }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    if (disabled) return
    const f = e.dataTransfer.files[0]
    if (f && f.type.startsWith('image/')) onFile(f)
  }, [disabled, onFile])

  const cropRel = (e: React.MouseEvent) => {
    const r = cropContRef.current!.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left)  / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top)   / r.height)),
    }
  }

  // ── Crop mode ──────────────────────────────────────────────────────────────
  if (cropMode && preview) {
    const hasCrop = !!(crop && crop.w > 0.04 && crop.h > 0.04)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px', marginBottom: 8,
          background: 'rgba(201,169,110,0.08)',
          border: `1px solid ${hasCrop ? 'var(--gold)' : 'var(--gold-dim)'}`,
          borderRadius: 6,
        }}>
          <span style={{ color: 'var(--gold)', fontSize: 14, lineHeight: 1 }}>◈</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.06em', color: hasCrop ? 'var(--gold-light)' : 'var(--gold)' }}>
            {hasCrop ? 'Detail area selected — redraw to adjust' : 'Drag on your photo to select the detail area'}
          </span>
        </div>
        <div
          ref={cropContRef}
          onMouseDown={e => { e.preventDefault(); cropStartRef.current = cropRel(e); setCropDragging(true) }}
          onMouseMove={e => {
            if (!cropDragging || !cropStartRef.current) return
            const cur = cropRel(e)
            onCrop?.({
              x: Math.min(cropStartRef.current.x, cur.x),
              y: Math.min(cropStartRef.current.y, cur.y),
              w: Math.abs(cur.x - cropStartRef.current.x),
              h: Math.abs(cur.y - cropStartRef.current.y),
            })
          }}
          onMouseUp={e => {
            if (!cropDragging || !cropStartRef.current) return
            setCropDragging(false)
            const cur = cropRel(e)
            const w = Math.abs(cur.x - cropStartRef.current.x)
            const h = Math.abs(cur.y - cropStartRef.current.y)
            if (w < 0.04 || h < 0.04) onCrop?.(null)
          }}
          onMouseLeave={() => setCropDragging(false)}
          style={{
            position: 'relative', cursor: 'crosshair', userSelect: 'none',
            borderRadius: 8, overflow: 'hidden',
            border: `1px solid ${hasCrop ? 'var(--gold-dim)' : 'var(--border-light)'}`,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} draggable={false} style={{ width: '100%', display: 'block' }} alt="" />

          {hasCrop ? (
            <>
              <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.52)', pointerEvents: 'none' }} />
              <div style={{
                position:   'absolute',
                top:        `${crop!.y * 100}%`,
                left:       `${crop!.x * 100}%`,
                width:      `${crop!.w * 100}%`,
                height:     `${crop!.h * 100}%`,
                boxShadow:  '0 0 0 9999px rgba(0,0,0,0.52)',
                border:     '1.5px solid var(--gold)',
                pointerEvents: 'none',
              }} />
            </>
          ) : (
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(0,0,0,0.28)', pointerEvents: 'none',
            }}>
              <span style={{
                color: 'rgba(255,255,255,0.8)', fontSize: 11, fontFamily: 'var(--font-mono)',
                letterSpacing: '0.1em', textTransform: 'uppercase',
                background: 'rgba(0,0,0,0.55)', padding: '7px 16px', borderRadius: 3,
              }}>
                Drag to select detail area
              </span>
            </div>
          )}
        </div>

        {/* Actions row */}
        <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
          <button
            onClick={() => !disabled && inputRef.current?.click()}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', padding: 0 }}
          >
            change photo
          </button>
          {hasCrop && (
            <button
              onClick={() => onCrop?.(null)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', padding: 0 }}
            >
              clear selection
            </button>
          )}
        </div>
        <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f) }} />
      </div>
    )
  }

  // ── Normal mode ────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        ...s.zone,
        borderColor: dragging ? accentColor : file ? 'var(--border-light)' : 'var(--border)',
        background:  dragging ? accentGlow  : 'var(--card)',
      }}
      onClick={() => !disabled && inputRef.current?.click()}
      onDragOver={e => { e.preventDefault(); if (!disabled) setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f) }}
      />
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt="Upload preview" style={s.zoneImg} />
      ) : (
        <div style={s.zonePlaceholder}>
          <span style={{ fontSize: 28, color: 'var(--border-light)', lineHeight: 1 }}>+</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>
            JPEG · PNG · WEBP
          </span>
        </div>
      )}
    </div>
  )
}

// ── Teal spinner ──────────────────────────────────────────────────────────────

function TealSpinner({ size = 16 }: { size?: number }) {
  return (
    <div style={{
      width: size, height: size,
      border: `2px solid var(--border-light)`,
      borderTopColor: 'var(--teal)',
      borderRadius: '50%',
      animation: 'spin 0.8s linear infinite',
      flexShrink: 0,
    }} />
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: { minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column' },

  header: {
    borderBottom: '1px solid rgba(255,255,255,0.08)', background: 'var(--header-bg)',
    backdropFilter: 'blur(16px)', position: 'sticky', top: 0, zIndex: 100,
  },
  headerInner: {
    maxWidth: 1280, margin: '0 auto', padding: '0 40px', height: 60,
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  },
  logo:     { display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' },
  logoMark: { color: 'var(--teal)', fontSize: 20 },
  logoName: { fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em', color: '#FFFFFF' },
  nav:      { display: 'flex', alignItems: 'center', gap: 20 },
  navLink: {
    color: 'rgba(255,255,255,0.55)', fontSize: 11, letterSpacing: '0.1em',
    textTransform: 'uppercase', textDecoration: 'none', transition: 'color 0.15s',
  },
  navSep: { color: 'rgba(255,255,255,0.2)', fontSize: 12 },
  navBtn: {
    background: 'none', border: 'none', color: 'rgba(255,255,255,0.55)', fontFamily: 'var(--font-mono)',
    fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer', padding: 0,
  },

  main: {
    flex: 1, maxWidth: 1200, margin: '0 auto', padding: '80px 40px 100px',
    width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 56,
  },

  hero:        { textAlign: 'center', maxWidth: 640 },
  heroEyebrow: {
    fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.22em',
    textTransform: 'uppercase', color: 'var(--teal)', marginBottom: 20,
  },
  heroTitle: {
    fontFamily: 'var(--font-display)', fontSize: 64, fontWeight: 300,
    letterSpacing: '0.02em', color: 'var(--text)', lineHeight: 1.08, marginBottom: 20,
  },
  heroSub: { color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.9, letterSpacing: '0.02em' },

  uploadSection: { width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 40 },
  uploadRow:     { width: '100%', maxWidth: 820, display: 'flex', alignItems: 'stretch', gap: 0 },
  uploadCol:     { flex: 1, display: 'flex', flexDirection: 'column', gap: 10 },
  uploadColLabel: {
    fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.14em',
    textTransform: 'uppercase', color: 'var(--text-muted)',
  },
  required: { color: 'var(--teal)',     marginLeft: 6 },
  optional: { color: 'var(--gold-dim)', marginLeft: 6 },

  dishInputRow: { width: '100%', maxWidth: 820, display: 'flex', flexDirection: 'column', gap: 10 },
  dishInputLabel: {
    fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.14em',
    textTransform: 'uppercase', color: 'var(--text-muted)',
  },
  dishInput: {
    width: '100%', padding: '12px 16px', background: 'var(--card)',
    border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)',
    fontSize: 14, fontFamily: 'inherit', outline: 'none',
    transition: 'border-color 0.2s',
    boxSizing: 'border-box' as const,
  },
  uploadColDivider: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '0 20px', paddingTop: 28,
  },

  zone: {
    width: '100%', minHeight: 240, border: '1px dashed', borderRadius: 8, overflow: 'hidden',
    position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', transition: 'border-color 0.2s, background 0.2s', userSelect: 'none',
  },
  zoneImg:         { width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0, display: 'block' },
  zonePlaceholder: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '40px 24px' },

  sectionHeader: {
    width: '100%', maxWidth: 960,
    display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
  },
  sectionTitle: {
    fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.16em',
    textTransform: 'uppercase', color: 'var(--text-muted)',
  },

  typeGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16,
    width: '100%', maxWidth: 960,
  },
  typeCard: {
    position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
    gap: 8, padding: '22px 20px', border: '1px solid', borderRadius: 8,
    cursor: 'pointer', transition: 'all 0.15s', textAlign: 'left',
  },
  typeIcon:    { fontSize: 22, lineHeight: 1, marginBottom: 4 },
  typeLabel:   { fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 400, letterSpacing: '0.02em' },
  typeTagline: { fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', letterSpacing: '0.02em' },
  typeCamera:  { fontSize: 11, color: 'var(--text-secondary)', letterSpacing: '0.02em', marginTop: 4, lineHeight: 1.5 },
  typeFeel:    { fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.05em' },
  riskBadge:   { fontSize: 9, color: '#C9916E', letterSpacing: '0.04em', marginTop: 4 },

  // Combo card
  threeActCard: {
    position:      'relative',
    display:       'flex',
    flexDirection: 'column',
    border:        '1px solid',
    borderRadius:  8,
    cursor:        'pointer',
    transition:    'all 0.2s',
    textAlign:     'left',
    width:         '100%',
    maxWidth:      960,
    overflow:      'hidden',
  },
  premiumBadge: {
    position:      'absolute',
    top:           14,
    right:         16,
    fontSize:      8,
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
    color:         'var(--gold)',
    border:        '1px solid var(--gold-dim)',
    borderRadius:  20,
    padding:       '3px 10px',
  },
  threeActLeft:  { flex: 1 },
  threeActIcon:  { fontSize: 22, lineHeight: 1, transition: 'color 0.2s' },
  threeActTitle: {
    fontFamily:    'var(--font-display)',
    fontSize:      24,
    fontWeight:    400,
    letterSpacing: '0.02em',
    transition:    'color 0.2s',
  },
  threeActSub: {
    fontSize:      11,
    color:         'var(--text-muted)',
    fontStyle:     'italic',
    letterSpacing: '0.02em',
  },
  threeActDesc: {
    fontSize:      13,
    color:         'var(--text-secondary)',
    letterSpacing: '0.01em',
    lineHeight:    1.7,
    marginBottom:  10,
  },
  threeActMeta: {
    fontFamily:    'var(--font-mono)',
    fontSize:      10,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color:         'var(--gold-dim)',
  },
  threeActSegments: { display: 'flex', alignItems: 'center', flexShrink: 0 },
  segment: {
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    justifyContent: 'center',
    width:          72,
    height:         60,
    border:         '1px solid',
    borderRadius:   4,
    gap:            4,
    transition:     'all 0.2s',
  },
  segmentNum:   { fontSize: 18, fontFamily: 'var(--font-display)', lineHeight: 1 },
  segmentLabel: { fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase' },

  durationRow:  { width: '100%', maxWidth: 960, display: 'flex', alignItems: 'center', gap: 20 },
  durationBtns: { display: 'flex', gap: 10 },
  durationBtn: {
    padding: '9px 24px', border: '1px solid', borderRadius: 6, fontFamily: 'var(--font-mono)',
    fontSize: 12, letterSpacing: '0.08em', cursor: 'pointer', transition: 'all 0.15s',
  },

  generateBtn: {
    background:    'linear-gradient(135deg, #2A7A6A 0%, var(--teal) 50%, #8AE8D4 100%)',
    color:         '#0A0807',
    boxShadow:     '0 0 24px rgba(110,201,180,0.25), 0 2px 10px rgba(0,0,0,0.4)',
    border:        'none', padding: '14px 40px', borderRadius: 4,
    fontFamily:    'var(--font-mono)', fontSize: 11, letterSpacing: '0.14em',
    textTransform: 'uppercase', cursor: 'pointer', transition: 'all 0.2s',
    textDecoration:'none', display: 'inline-flex', alignItems: 'center',
  },
  generateBtnGold: {
    background:    'linear-gradient(135deg, var(--gold-dim) 0%, var(--gold) 50%, var(--gold-light) 100%)',
    color:         '#0A0807',
    boxShadow:     '0 0 24px var(--gold-glow-strong), 0 2px 10px rgba(0,0,0,0.4)',
    border:        'none', padding: '14px 40px', borderRadius: 4,
    fontFamily:    'var(--font-mono)', fontSize: 11, letterSpacing: '0.14em',
    textTransform: 'uppercase', cursor: 'pointer', transition: 'all 0.2s',
    textDecoration:'none', display: 'inline-flex', alignItems: 'center',
  },

  errorWrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, textAlign: 'center' },
  errorMsg:  { color: 'var(--error)', fontSize: 13 },

  resultSection: { width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 36 },
  resultMeta:    { textAlign: 'center' },
  resultTitle: {
    fontFamily: 'var(--font-display)', fontSize: 44, fontWeight: 300,
    color: 'var(--text)', letterSpacing: '0.03em', marginBottom: 10,
  },
  resultSub: {
    fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.14em',
    textTransform: 'uppercase', color: 'var(--teal)',
  },
  videoPlayer: {
    width: '100%', maxWidth: 820, borderRadius: 8,
    border: '1px solid var(--border)', background: 'var(--surface)',
  },
  resultActions: { display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center' },
}
