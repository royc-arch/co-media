'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams }               from 'next/navigation'
import Link                              from 'next/link'

// ── Types ──────────────────────────────────────────────────────────────────────

interface LocationSetting {
  location_name:       string
  display_name:        string
  account_name:        string
  custom_instructions: string | null
  prompt_hints:        string | null
}

interface GmbStyle {
  id:            string
  location_name: string
  name:          string
  stars:         number
  apply_mask:    number | null
  style_text:    string
  override_text: string | null
  keywords:      string | null
  context:       string | null
  created_at:    string
}

type Length     = 'recommended' | 'condense' | 'medium' | 'detailed'
type TrainPhase = 'setup' | 'r1loading' | 'r1' | 'r2loading' | 'r2' | 'done'
type View       = 'styles' | 'train'

interface TrainState {
  phase:      TrainPhase
  r1Replies:  string[]
  r1Pick:     string | null
  r2Replies:  string[]
  insight:    string
  savedLabel: string | null
}

const LENGTH_LABELS: Record<Length, string> = {
  recommended: 'Recommended · review length + 250',
  condense:    'Condense · ~250',
  medium:      'Medium · ~500',
  detailed:    'Detailed · ~750',
}

const STAR_LABELS = ['1 star', '2 stars', '3 stars', '4 stars', '5 stars']
const NUM_TO_STAR: Record<number, string> = { 1:'ONE', 2:'TWO', 3:'THREE', 4:'FOUR', 5:'FIVE' }

const DEFAULT_REVIEW = `We've been coming here for years and it never disappoints. The food is always fresh and the service is warm and attentive. Last visit the staff remembered our usual order — little details like that keep us coming back.`

const PHASES: TrainPhase[] = ['setup', 'r1', 'r2', 'done']
const PHASE_LABELS: Record<string, string> = {
  setup: 'Setup', r1: 'Round 1', r2: 'Round 2', done: 'Done',
}

function starStr(n: number) {
  return '★'.repeat(n) + '☆'.repeat(5 - n)
}

// ── Inner page ─────────────────────────────────────────────────────────────────

function TrainPageInner() {
  const searchParams = useSearchParams()
  const locParam     = searchParams.get('loc') ?? ''

  const [view,          setView]          = useState<View>('styles')
  const [settings,      setSettings]      = useState<LocationSetting | null>(null)
  const [styles,        setStyles]        = useState<GmbStyle[]>([])
  const [loadingLoc,    setLoadingLoc]    = useState(true)
  const [error,         setError]         = useState('')

  // Override editing: which style id is being edited
  const [editingId,     setEditingId]     = useState<string | null>(null)
  const [editText,      setEditText]      = useState('')
  const [savingEdit,    setSavingEdit]    = useState(false)
  const [deletingId,    setDeletingId]    = useState<string | null>(null)
  const [settingActive, setSettingActive] = useState<string | null>(null)

  // Trainer state
  const [trainState,    setTrainState]    = useState<TrainState>({
    phase: 'setup', r1Replies: [], r1Pick: null, r2Replies: [], insight: '', savedLabel: null,
  })
  const [sampleReview,  setSampleReview]  = useState(DEFAULT_REVIEW)
  const [sampleStars,   setSampleStars]   = useState(5)
  const [trainKeywords, setTrainKeywords] = useState('')
  const [trainLength,   setTrainLength]   = useState<Length>('recommended')
  const [trainContext,  setTrainContext]  = useState('')

  // Style test panel
  const [testingStyleId, setTestingStyleId] = useState<string | null>(null)
  const [testReview,     setTestReview]     = useState('')
  const [testStars,      setTestStars]      = useState(5)
  const [testGenerating, setTestGenerating] = useState(false)
  const [testReplies,    setTestReplies]    = useState<string[]>([])
  const [testCopied,     setTestCopied]     = useState<number | null>(null)
  const [testError,      setTestError]      = useState('')

  // ── Load ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    const settingsUrl = locParam
      ? `/api/gmb/settings?locationName=${encodeURIComponent(locParam)}`
      : '/api/gmb/settings'

    Promise.all([
      fetch(settingsUrl).then(r => r.json()),
      fetch('/api/gmb/styles').then(r => r.json()),
    ])
      .then(([settData, styleData]) => {
        const locs: LocationSetting[] = settData.settings ?? []
        if (locs.length) setSettings(locs[0])
        setStyles(styleData.styles ?? [])
      })
      .catch(() => setError('Failed to load settings.'))
      .finally(() => setLoadingLoc(false))
  }, [locParam])

  // ── Style management ──────────────────────────────────────────────────────

  async function deleteStyle(id: string) {
    setDeletingId(id)
    try {
      await fetch(`/api/gmb/styles?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      setStyles(prev => prev.filter(s => s.id !== id))
    } finally {
      setDeletingId(null)
    }
  }

  const [maskWarningId, setMaskWarningId] = useState<string | null>(null)

  // Keywords editing (max 2 keywords, 20 chars each)
  const [editingKwId,  setEditingKwId]  = useState<string | null>(null)
  const [editKw1,      setEditKw1]      = useState('')
  const [editKw2,      setEditKw2]      = useState('')
  const [savingKw,     setSavingKw]     = useState(false)
  // Context editing
  const [editingCtxId, setEditingCtxId] = useState<string | null>(null)
  const [editContext,  setEditContext]  = useState('')
  const [savingCtx,    setSavingCtx]    = useState(false)

  async function updateApplyMask(id: string, mask: number) {
    setStyles(prev => prev.map(st => st.id === id ? { ...st, apply_mask: mask } : st))
    await fetch(`/api/gmb/styles?id=${encodeURIComponent(id)}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ applyMask: mask }),
    })
  }

  async function saveOverride(id: string) {
    setSavingEdit(true)
    try {
      const res = await fetch(`/api/gmb/styles?id=${encodeURIComponent(id)}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ overrideText: editText.trim() || null }),
      })
      const d = await res.json() as { ok?: boolean; error?: string }
      if (!res.ok || d.error) { setError(d.error ?? 'Failed to save'); return }
      setStyles(prev => prev.map(s => s.id === id ? { ...s, override_text: editText.trim() || null } : s))
      setEditingId(null)
    } finally {
      setSavingEdit(false)
    }
  }

  async function saveKeywords(id: string) {
    const kws = [editKw1.trim(), editKw2.trim()].filter(Boolean).join(', ') || null
    setSavingKw(true)
    try {
      const res = await fetch(`/api/gmb/styles?id=${encodeURIComponent(id)}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ keywords: kws }),
      })
      const d = await res.json() as { ok?: boolean; error?: string }
      if (!res.ok || d.error) { setError(d.error ?? 'Failed to save keywords'); return }
      setStyles(prev => prev.map(s => s.id === id ? { ...s, keywords: kws } : s))
      setEditingKwId(null)
    } finally {
      setSavingKw(false)
    }
  }

  async function saveContext(id: string) {
    setSavingCtx(true)
    try {
      const res = await fetch(`/api/gmb/styles?id=${encodeURIComponent(id)}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ context: editContext.trim() || null }),
      })
      const d = await res.json() as { ok?: boolean; error?: string }
      if (!res.ok || d.error) { setError(d.error ?? 'Failed to save context'); return }
      setStyles(prev => prev.map(s => s.id === id ? { ...s, context: editContext.trim() || null } : s))
      setEditingCtxId(null)
    } finally {
      setSavingCtx(false)
    }
  }

  async function setActiveStyle(style: GmbStyle) {
    setSettingActive(style.id)
    try {
      const res = await fetch('/api/gmb/styles', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id: style.id, locationName: locParam }),
      })
      const d = await res.json() as { hints?: string }
      if (d.hints && settings) setSettings({ ...settings, prompt_hints: d.hints })
    } finally {
      setSettingActive(null)
    }
  }

  async function deactivateStyle() {
    if (!settings) return
    const loc = locParam || settings.location_name
    if (!loc) return
    try {
      await fetch(`/api/gmb/settings?locationName=${encodeURIComponent(loc)}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ prompt_hints: null }),
      })
      setSettings({ ...settings, prompt_hints: null })
    } catch { /* silent */ }
  }

  // ── Style test helpers ───────────────────────────────────────────────────

  function openTest(style: GmbStyle) {
    if (testingStyleId === style.id) { setTestingStyleId(null); return }
    setTestingStyleId(style.id)
    setTestReview('')
    setTestStars(style.stars)
    setTestReplies([])
    setTestError('')
  }

  function buildTestHints(style: GmbStyle): string {
    // mask=31 forces the style to apply to all star ratings during testing
    const base = `${style.name}||${style.stars}||31||${style.style_text}`
    return style.override_text ? base + `\n\nCampaign instructions: ${style.override_text}` : base
  }

  async function generateTestReply(style: GmbStyle) {
    if (!testReview.trim()) return
    setTestGenerating(true)
    setTestReplies([])
    setTestError('')
    try {
      const res = await fetch('/api/gmb/suggest-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reviewText:         testReview,
          reviewAuthor:       'Test Customer',
          starRating:         NUM_TO_STAR[testStars],
          keywords:           style.keywords ? style.keywords.split(',').map(k => k.trim()).filter(Boolean) : [],
          length:             'recommended',
          context:            style.context ?? '',
          customInstructions: '',
          promptHints:        buildTestHints(style),
          locationName:       locParam || undefined,
        }),
      })
      const d = await res.json() as { replies?: string[]; error?: string }
      if (d.error) { setTestError(d.error); return }
      setTestReplies(d.replies?.[0] ? [d.replies[0]] : [])
    } catch {
      setTestError('Generate failed. Please try again.')
    } finally {
      setTestGenerating(false)
    }
  }

  async function copyTestReply(text: string, idx: number) {
    await navigator.clipboard.writeText(text)
    setTestCopied(idx)
    setTimeout(() => setTestCopied(null), 2000)
  }

  // ── Trainer helpers ───────────────────────────────────────────────────────

  function patch(p: Partial<TrainState>) {
    setTrainState(prev => ({ ...prev, ...p }))
  }

  function resetToSetup() {
    setTrainState({ phase: 'setup', r1Replies: [], r1Pick: null, r2Replies: [], insight: '', savedLabel: null })
    setSampleReview(DEFAULT_REVIEW)
    setSampleStars(5)
    setTrainKeywords('')
    setTrainLength('recommended')
    setTrainContext('')
    setError('')
  }

  // ── Trainer API calls ─────────────────────────────────────────────────────

  async function generateR1() {
    if (!sampleReview.trim()) return
    patch({ phase: 'r1loading', r1Replies: [], r1Pick: null, r2Replies: [] })
    setError('')
    const kws = trainKeywords.split(',').map(k => k.trim()).filter(Boolean)
    try {
      const res = await fetch('/api/gmb/suggest-reply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reviewText: sampleReview, reviewAuthor: 'Sample Customer',
          starRating: NUM_TO_STAR[sampleStars], keywords: kws,
          length: trainLength, context: trainContext,
          customInstructions: settings?.custom_instructions ?? '',
          promptHints: settings?.prompt_hints ?? '',
          locationName: locParam || undefined,
        }),
      })
      const d = await res.json() as { replies?: string[]; error?: string }
      if (d.replies?.length) { patch({ phase: 'r1', r1Replies: d.replies }) }
      else { setError(`Generate failed: ${d.error ?? 'unknown'}`); patch({ phase: 'setup' }) }
    } catch { setError('Generate failed.'); patch({ phase: 'setup' }) }
  }

  async function pickR1(picked: string) {
    patch({ phase: 'r2loading', r1Pick: picked, r2Replies: [] })
    setError('')
    const kws = trainKeywords.split(',').map(k => k.trim()).filter(Boolean)
    try {
      const res = await fetch('/api/gmb/suggest-reply/refine', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selectedReply: picked, reviewText: sampleReview, reviewAuthor: 'Sample Customer',
          starRating: NUM_TO_STAR[sampleStars], keywords: kws,
          length: trainLength, context: trainContext,
          customInstructions: settings?.custom_instructions ?? '',
          promptHints: settings?.prompt_hints ?? '',
          locationName: locParam || undefined,
        }),
      })
      const d = await res.json() as { replies?: string[]; insight?: string; error?: string }
      if (d.replies?.length) { patch({ phase: 'r2', r2Replies: d.replies, insight: d.insight ?? '' }) }
      else { setError(`Refine failed: ${d.error ?? 'unknown'}`); patch({ phase: 'r1' }) }
    } catch { patch({ phase: 'r1' }) }
  }

  async function refreshR2() {
    if (!trainState.r1Pick) return
    patch({ phase: 'r2loading', r2Replies: [] })
    const kws = trainKeywords.split(',').map(k => k.trim()).filter(Boolean)
    try {
      const res = await fetch('/api/gmb/suggest-reply/refine', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selectedReply: trainState.r1Pick, reviewText: sampleReview, reviewAuthor: 'Sample Customer',
          starRating: NUM_TO_STAR[sampleStars], keywords: kws,
          length: trainLength, context: trainContext,
          customInstructions: settings?.custom_instructions ?? '',
          promptHints: settings?.prompt_hints ?? '',
          locationName: locParam || undefined,
        }),
      })
      const d = await res.json() as { replies?: string[]; insight?: string }
      patch(d.replies?.length
        ? { phase: 'r2', r2Replies: d.replies, insight: d.insight ?? '' }
        : { phase: 'r2' })
    } catch { patch({ phase: 'r2' }) }
  }

  async function pickR2(picked: string) {
    patch({ phase: 'done', savedLabel: null })
    setError('')
    try {
      const res = await fetch('/api/gmb/suggest-reply/learn', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          r1Pick: trainState.r1Pick ?? '', r2Pick: picked,
          reviewText: sampleReview, locationName: locParam, sampleStars,
        }),
      })
      const d = await res.json() as { hints?: string; styleId?: string; error?: string }
      if (d.error) {
        setError(d.error)
        patch({ phase: 'r2' })
        return
      }
      if (d.hints) {
        const parts = d.hints.split('||')
        const label = parts.length >= 3
          ? `${parts[0]} ${starStr(parseInt(parts[1]) || 5)}`
          : null
        patch({ savedLabel: label })
        if (settings) setSettings({ ...settings, prompt_hints: d.hints })
        // Refresh style list
        fetch(`/api/gmb/styles?locationName=${encodeURIComponent(locParam)}`)
          .then(r => r.json()).then(sd => setStyles(sd.styles ?? []))
      }
    } catch (e) {
      setError('Failed to save style. Please try again.')
      patch({ phase: 'r2' })
    }
  }

  // ── Progress ──────────────────────────────────────────────────────────────

  const visiblePhase = trainState.phase === 'r1loading' ? 'r1'
    : trainState.phase === 'r2loading' ? 'r2'
    : trainState.phase
  const phaseIdx = PHASES.indexOf(visiblePhase as TrainPhase)

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={s.page}>
      <div style={s.glow} />

      {/* Nav */}
      <nav style={s.nav}>
        <Link href="/" style={s.navBrand}><span style={s.navIcon}>◈</span><span style={s.navName}>Co.Media</span></Link>
        <span style={s.navSep}>/</span>
        <Link href="/gmb" style={s.navLink}>Review Reply</Link>
        <span style={s.navSep}>/</span>
        <Link href={locParam ? `/gmb/dashboard?loc=${encodeURIComponent(locParam)}` : '/gmb/dashboard'} style={s.navLink}>Dashboard</Link>
        <span style={s.navSep}>/</span>
        <span style={s.navCrumb}>Reply Styles</span>
      </nav>

      <div style={s.content}>
        {error && <div style={s.errorBanner}>⚠ {error}</div>}

        {/* Header + tabs */}
        <div style={s.header}>
          <p style={s.eyebrow}>Auto-reply · {settings?.display_name ?? locParam}</p>
          <h1 style={s.title}>Reply Styles</h1>
        </div>

        <div style={s.tabs}>
          <button
            onClick={() => setView('styles')}
            style={{ ...s.tab, ...(view === 'styles' ? s.tabActive : {}) }}
          >
            Saved Styles {styles.length > 0 && <span style={s.tabBadge}>{styles.length}</span>}
          </button>
          <button
            onClick={() => { setView('train'); resetToSetup() }}
            style={{ ...s.tab, ...(view === 'train' ? s.tabActive : {}) }}
          >
            + Train New Style
          </button>
        </div>

        {/* ── Styles view ─────────────────────────────────────────────────── */}
        {view === 'styles' && (
          <div>
            {loadingLoc ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><div style={s.spinner} /></div>
            ) : styles.length === 0 ? (
              <div style={s.emptyCard}>
                <p style={s.emptyTitle}>No styles saved yet</p>
                <p style={s.emptyDesc}>Train a new style to teach the AI how you want to sound. Your style is saved and used for all AI suggestions on the review page.</p>
                <button onClick={() => { setView('train'); resetToSetup() }} className="btn btn-gold" style={{ marginTop: 20, fontSize: 12 }}>
                  Train first style →
                </button>
              </div>
            ) : (
              <div style={s.styleGrid}>
                {styles.map(style => {
                  const isActive = settings?.prompt_hints?.startsWith(`${style.name}||${style.stars}||`)
                  const isEditing = editingId === style.id
                  const isDeleting = deletingId === style.id
                  const isActivating = settingActive === style.id

                  return (
                    <div key={style.id} style={{ ...s.styleCard, ...(isActive ? s.styleCardActive : {}) }}>
                      {/* Card header */}
                      <div style={s.styleCardHeader}>
                        <div>
                          <p style={s.styleName}>{style.name}</p>
                          <p style={s.styleStars}>{starStr(style.stars)}</p>
                        </div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                          {isActive && (
                            <button
                              onClick={deactivateStyle}
                              title="Click to deactivate"
                              style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '3px 8px', borderRadius: 4, background: 'rgba(34,197,94,0.12)', color: '#16a34a', border: '1px solid rgba(34,197,94,0.3)', cursor: 'pointer' }}
                            >
                              ● Active
                            </button>
                          )}
                          {!isActive && (
                            <button
                              onClick={() => setActiveStyle(style)}
                              disabled={!!isActivating}
                              className="btn btn-ghost"
                              style={{ fontSize: 9, padding: '4px 10px' }}
                            >
                              {isActivating ? '…' : 'Set Active'}
                            </button>
                          )}
                          <button
                            onClick={() => isDeleting ? undefined : deleteStyle(style.id)}
                            disabled={!!isDeleting}
                            style={s.deleteBtn}
                          >
                            {isDeleting ? '…' : '✕'}
                          </button>
                        </div>
                      </div>

                      {/* Style preview */}
                      <p style={s.stylePreview}>{style.style_text.slice(0, 120)}{style.style_text.length > 120 ? '…' : ''}</p>

                      {/* Applies to — individual star toggles */}
                      {(() => {
                        const defaultMask = 1 << (style.stars - 1)
                        const mask        = style.apply_mask ?? defaultMask
                        const isOn        = (n: number) => ((mask >> (n - 1)) & 1) === 1
                        const selectedCount = [1,2,3,4,5].filter(isOn).length
                        const showWarning = maskWarningId === style.id

                        return (
                          <div style={{ marginBottom: 12 }}>
                            <div style={s.appliesToRow}>
                              <span style={s.appliesToLabel}>Applies to</span>
                              <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' as const }}>
                                {[1,2,3,4,5].map(n => {
                                  const on = isOn(n)
                                  return (
                                    <button
                                      key={n}
                                      onClick={() => {
                                        if (on) {
                                          if (selectedCount <= 1) {
                                            setMaskWarningId(style.id)
                                            setTimeout(() => setMaskWarningId(null), 2000)
                                            return
                                          }
                                          updateApplyMask(style.id, mask & ~(1 << (n - 1)))
                                        } else {
                                          setMaskWarningId(null)
                                          updateApplyMask(style.id, mask | (1 << (n - 1)))
                                        }
                                      }}
                                      style={{
                                        fontFamily: 'var(--font-mono)', fontSize: 11,
                                        padding: '2px 6px', border: '1px solid', borderRadius: 4, cursor: 'pointer',
                                        background:   on ? 'rgba(242,56,1,0.08)' : 'transparent',
                                        borderColor:  on ? 'rgba(242,56,1,0.3)'  : 'var(--border)',
                                        color:        on ? 'var(--orange)'        : 'var(--text-muted)',
                                        transition: 'all 0.12s',
                                      }}
                                    >
                                      {'★'.repeat(n)}
                                    </button>
                                  )
                                })}
                                <button
                                  onClick={() => updateApplyMask(style.id, 31)}
                                  style={s.maskBtn}
                                  title="Apply to all star ratings"
                                >
                                  All
                                </button>
                                <button
                                  onClick={() => updateApplyMask(style.id, defaultMask)}
                                  style={s.maskBtn}
                                  title="Reset to training star only"
                                >
                                  Reset
                                </button>
                              </div>
                            </div>
                            {showWarning && (
                              <p style={s.maskWarning}>Must keep at least one star selected</p>
                            )}
                          </div>
                        )
                      })()}

                      {/* ── Context & Keywords ──────────────────────────── */}
                      {/* ── Keywords ────────────────────────────────────── */}
                      <div style={{ paddingTop: 10, borderTop: '1px solid var(--border)', marginBottom: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                          <span style={s.appliesToLabel}>Keywords</span>
                          {editingKwId !== style.id && (
                            <button onClick={() => {
                              const parts = (style.keywords ?? '').split(',').map(k => k.trim())
                              setEditKw1(parts[0] ?? '')
                              setEditKw2(parts[1] ?? '')
                              setEditingKwId(style.id)
                            }} style={s.editBtn}>
                              {style.keywords ? 'Edit' : '+ Add'}
                            </button>
                          )}
                        </div>
                        {editingKwId !== style.id ? (
                          style.keywords ? (
                            <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 4 }}>
                              {style.keywords.split(',').map(k => k.trim()).filter(Boolean).map(k => (
                                <span key={k} style={{ fontFamily: 'var(--font-mono)', fontSize: 10, background: 'rgba(242,56,1,0.08)', color: 'var(--orange)', borderRadius: 4, padding: '2px 7px', border: '1px solid rgba(242,56,1,0.2)' }}>
                                  {k}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>None</p>
                          )
                        ) : (
                          <>
                            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                              {([
                                { val: editKw1, set: setEditKw1, ph: 'Keyword 1', auto: true },
                                { val: editKw2, set: setEditKw2, ph: 'Keyword 2', auto: false },
                              ] as { val: string; set: (v: string) => void; ph: string; auto: boolean }[]).map(({ val, set, ph, auto }) => (
                                <div key={ph} style={{ flex: 1, position: 'relative' as const }}>
                                  <input
                                    autoFocus={auto}
                                    value={val}
                                    onChange={e => set(e.target.value.slice(0, 25))}
                                    maxLength={25}
                                    placeholder={ph}
                                    style={{ ...s.textarea, padding: '8px 10px', height: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, width: '100%', boxSizing: 'border-box' as const, paddingRight: 32 }}
                                  />
                                  <span style={{ position: 'absolute' as const, right: 8, top: '50%', transform: 'translateY(-50%)', fontFamily: 'var(--font-mono)', fontSize: 9, color: val.length >= 22 ? '#d97706' : 'var(--text-muted)', pointerEvents: 'none' as const }}>
                                    {val.length}/25
                                  </span>
                                </div>
                              ))}
                            </div>
                            <div style={{ display: 'flex', gap: 8 }}>
                              <button onClick={() => setEditingKwId(null)} className="btn btn-ghost" style={{ fontSize: 10 }}>Cancel</button>
                              <button onClick={() => saveKeywords(style.id)} disabled={savingKw} className="btn btn-gold" style={{ fontSize: 10 }}>
                                {savingKw ? 'Saving…' : 'Save'}
                              </button>
                            </div>
                          </>
                        )}
                      </div>

                      {/* ── Context ──────────────────────────────────────── */}
                      <div style={{ paddingTop: 10, borderTop: '1px solid var(--border)', marginBottom: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                          <span style={s.appliesToLabel}>Context</span>
                          {editingCtxId !== style.id && (
                            <button onClick={() => { setEditingCtxId(style.id); setEditContext(style.context ?? '') }} style={s.editBtn}>
                              {style.context ? 'Edit' : '+ Add'}
                            </button>
                          )}
                        </div>
                        {editingCtxId !== style.id ? (
                          style.context ? (
                            <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{style.context}</p>
                          ) : (
                            <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>None</p>
                          )
                        ) : (
                          <>
                            <textarea
                              autoFocus
                              value={editContext}
                              onChange={e => setEditContext(e.target.value)}
                              placeholder="e.g. We're a family-run restaurant. The owner personally greets guests on weekends."
                              rows={2}
                              style={{ ...s.textarea, marginBottom: 8 }}
                            />
                            <div style={{ display: 'flex', gap: 8 }}>
                              <button onClick={() => setEditingCtxId(null)} className="btn btn-ghost" style={{ fontSize: 10 }}>Cancel</button>
                              <button onClick={() => saveContext(style.id)} disabled={savingCtx} className="btn btn-gold" style={{ fontSize: 10 }}>
                                {savingCtx ? 'Saving…' : 'Save'}
                              </button>
                            </div>
                          </>
                        )}
                      </div>

                      {/* ── Campaign note ───────────────────────────────── */}
                      {!isEditing ? (
                        <div style={{ ...s.overrideRow, paddingTop: 10, borderTop: '1px solid var(--border)', marginTop: 4 }}>
                          <div>
                            <span style={{ ...s.appliesToLabel, display: 'block', marginBottom: 4 }}>Campaign note</span>
                            {style.override_text ? (
                              <div style={s.overrideDisplay}>
                                <span style={{ color: 'var(--orange)', marginRight: 6 }}>◈</span>
                                {style.override_text}
                              </div>
                            ) : (
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
                                None
                              </span>
                            )}
                          </div>
                          <button
                            onClick={() => { setEditingId(style.id); setEditText(style.override_text ?? '') }}
                            style={{ ...s.editBtn, flexShrink: 0 }}
                          >
                            {style.override_text ? 'Edit' : '+ Add'}
                          </button>
                        </div>
                      ) : (
                        <div style={{ paddingTop: 10, borderTop: '1px solid var(--border)', marginTop: 4 }}>
                          <p style={{ ...s.fieldLabel, marginBottom: 4 }}>Campaign note</p>
                          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.6 }}>
                            Use this to weave a specific promotion or product into every reply. The AI will mention it naturally when the review gives an opening — without forcing it. Examples:<br />
                            · A new dish: "Our truffle pasta just launched and it's been our best-seller — if they haven't tried it, suggest it."<br />
                            · A seasonal deal: "We have a Christmas event coming up with 20% off — invite them to join if it fits naturally."<br />
                            · A reminder: "We do free dessert on birthdays — mention it if relevant."
                          </p>
                          <textarea
                            autoFocus
                            value={editText}
                            onChange={e => setEditText(e.target.value)}
                            placeholder="e.g. Our new Sunday brunch menu just launched — if the timing feels right, invite them to try it next visit."
                            rows={3}
                            style={{ ...s.textarea, marginBottom: 8 }}
                          />
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button onClick={() => setEditingId(null)} className="btn btn-ghost" style={{ fontSize: 10 }}>Cancel</button>
                            <button onClick={() => saveOverride(style.id)} disabled={savingEdit} className="btn btn-gold" style={{ fontSize: 10 }}>
                              {savingEdit ? 'Saving…' : 'Save'}
                            </button>
                          </div>
                        </div>
                      )}

                      {/* ── Test panel ──────────────────────────────────── */}
                      <div style={s.testSection}>
                        <button onClick={() => openTest(style)} style={s.testToggleBtn}>
                          {testingStyleId === style.id ? '▾ Hide test' : '▸ Test this style'}
                        </button>

                        {testingStyleId === style.id && (
                          <div style={s.testPanel}>
                            <p style={s.testLabel}>Test review</p>
                            <textarea
                              value={testReview}
                              onChange={e => setTestReview(e.target.value)}
                              placeholder="Paste a customer review to test this style…"
                              style={{ ...s.textarea, marginBottom: 0 }}
                              rows={3}
                            />

                            <div style={s.testControls}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span style={s.testLabel}>Stars</span>
                                <div style={{ display: 'flex', gap: 1 }}>
                                  {[1,2,3,4,5].map(n => (
                                    <button key={n} onClick={() => setTestStars(n)}
                                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, padding: '0 1px', lineHeight: 1, color: n <= testStars ? '#f59e0b' : 'var(--border)', transition: 'color 0.1s' }}>
                                      ★
                                    </button>
                                  ))}
                                </div>
                              </div>
                              <button
                                onClick={() => generateTestReply(style)}
                                disabled={testGenerating || !testReview.trim()}
                                className="btn btn-gold"
                                style={{ fontSize: 11, padding: '8px 20px', opacity: testReview.trim() ? 1 : 0.4 }}
                              >
                                {testGenerating ? 'Generating…' : 'Generate →'}
                              </button>
                            </div>

                            {testError && <p style={s.testError}>⚠ {testError}</p>}

                            {testGenerating && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 0' }}>
                                <div style={{ ...s.spinner, width: 16, height: 16, borderWidth: 1.5 }} />
                                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>Generating with this style…</span>
                              </div>
                            )}

                            {testReplies.length > 0 && !testGenerating && (
                              <div style={s.testRepliesList}>
                                <div style={s.testReplyCard}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                    <span style={s.testReplyNum}>Generated reply</span>
                                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>{testReplies[0].length} chars</span>
                                  </div>
                                  <p style={s.testReplyText}>{testReplies[0]}</p>
                                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
                                    <button
                                      onClick={() => generateTestReply(style)}
                                      disabled={testGenerating}
                                      className="btn btn-ghost"
                                      style={{ fontSize: 10, padding: '5px 14px' }}
                                    >
                                      ↻ Retry
                                    </button>
                                    <button
                                      onClick={() => copyTestReply(testReplies[0], 0)}
                                      className="btn btn-ghost"
                                      style={{
                                        fontSize: 10, padding: '5px 14px',
                                        ...(testCopied === 0 ? { background: 'rgba(22,163,74,0.07)', borderColor: 'rgba(22,163,74,0.3)', color: 'var(--success)' } : {}),
                                      }}
                                    >
                                      {testCopied === 0 ? '✓ Copied' : 'Copy'}
                                    </button>
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Train view ──────────────────────────────────────────────────── */}
        {view === 'train' && (
          <div>
            <p style={s.trainDesc}>
              Enter a sample review, pick the reply that feels most like you, then refine.
              The AI learns your preferred voice and saves it to your style library.
            </p>

            {/* Progress */}
            <div style={s.progress}>
              {PHASES.map((ph, i) => (
                <div key={ph} style={{ display: 'flex', alignItems: 'center' }}>
                  <div style={{ ...s.step, ...(i <= phaseIdx ? s.stepActive : {}), ...(i < phaseIdx ? s.stepDone : {}) }}>
                    {i < phaseIdx ? '✓' : i + 1}
                  </div>
                  <span style={{ ...s.stepLabel, color: i <= phaseIdx ? 'var(--text)' : 'var(--text-muted)' }}>
                    {PHASE_LABELS[ph]}
                  </span>
                  {i < PHASES.length - 1 && (
                    <div style={{ ...s.stepLine, background: i < phaseIdx ? 'var(--orange)' : 'var(--border)' }} />
                  )}
                </div>
              ))}
            </div>

            <div style={s.card}>

              {/* Setup */}
              {trainState.phase === 'setup' && (
                <div>
                  <p style={s.sectionLabel}>Sample review</p>
                  <textarea
                    value={sampleReview}
                    onChange={e => setSampleReview(e.target.value)}
                    placeholder="Paste a real customer review or write a sample one…"
                    style={{ ...s.textarea, marginBottom: 20 }}
                    rows={4}
                  />

                  <div style={s.row2}>
                    <div style={{ flex: 1 }}>
                      <p style={s.sectionLabel}>Star rating</p>
                      <div style={s.starRow}>
                        {[1,2,3,4,5].map(n => (
                          <button key={n} onClick={() => setSampleStars(n)}
                            style={{ ...s.starBtn, color: n <= sampleStars ? '#f59e0b' : 'var(--border)' }}>★</button>
                        ))}
                        <span style={s.starLabel}>{STAR_LABELS[sampleStars - 1]}</span>
                      </div>
                    </div>
                    <div style={{ flex: 1 }}>
                      <p style={s.sectionLabel}>Reply length</p>
                      <div style={s.lengthGroup}>
                        {(Object.keys(LENGTH_LABELS) as Length[]).map(len => (
                          <button key={len} onClick={() => setTrainLength(len)}
                            style={{ ...s.lengthBtn, ...(trainLength === len ? s.lengthBtnActive : {}) }}>
                            {LENGTH_LABELS[len]}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div style={s.row2}>
                    <div style={{ flex: 1 }}>
                      <p style={s.sectionLabel}>Keywords <span style={{ opacity: 0.5, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></p>
                      <input placeholder="e.g. all-you-can-eat, sushi" value={trainKeywords}
                        onChange={e => setTrainKeywords(e.target.value)} style={s.input} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <p style={s.sectionLabel}>Context <span style={{ opacity: 0.5, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></p>
                      <textarea placeholder="e.g. Weekend brunch…" value={trainContext}
                        onChange={e => setTrainContext(e.target.value)}
                        style={{ ...s.textarea, resize: 'none' }} rows={3} />
                    </div>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button onClick={generateR1} disabled={!sampleReview.trim()} className="btn btn-gold">
                      Generate 5 options →
                    </button>
                  </div>
                </div>
              )}

              {/* Loading */}
              {(trainState.phase === 'r1loading' || trainState.phase === 'r2loading') && (
                <div style={s.loadingPanel}>
                  <div style={s.spinner} />
                  <div>
                    <p style={s.loadingTitle}>
                      {trainState.phase === 'r1loading' ? 'Generating 5 variations…' : 'Refining based on your pick…'}
                    </p>
                    <p style={s.loadingDesc}>This takes a few seconds.</p>
                  </div>
                </div>
              )}

              {/* Round 1 */}
              {trainState.phase === 'r1' && (
                <div>
                  <p style={s.roundHeading}>Pick the reply that feels most like you</p>
                  <p style={s.roundDesc}>Don't look for perfect — just the one closest to your voice.</p>
                  <div style={s.replyGrid}>
                    {trainState.r1Replies.map((reply, i) => (
                      <div key={i} style={s.replyCard}>
                        <div style={s.replyNum}>{i + 1}</div>
                        <p style={s.replyText}>{reply}</p>
                        <div style={s.replyFooter}>
                          <span style={s.charHint}>{reply.length} chars</span>
                          <button onClick={() => pickR1(reply)} className="btn btn-gold" style={{ fontSize: 11, padding: '6px 16px' }}>Choose this</button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={s.actionRow}>
                    <button onClick={resetToSetup} className="btn btn-ghost" style={{ fontSize: 11 }}>← Back to setup</button>
                    <button onClick={generateR1} className="btn btn-ghost" style={{ fontSize: 11 }}>None of these — Refresh</button>
                  </div>
                </div>
              )}

              {/* Round 2 */}
              {trainState.phase === 'r2' && (
                <div>
                  <p style={s.roundHeading}>Pick the best refined version</p>
                  {trainState.insight && (
                    <div style={s.insightBox}>
                      <span style={{ color: 'var(--orange)', marginRight: 6 }}>●</span>
                      {trainState.insight}
                    </div>
                  )}
                  <div style={s.replyGrid}>
                    {trainState.r2Replies.map((reply, i) => (
                      <div key={i} style={s.replyCard}>
                        <div style={s.replyNum}>{i + 1}</div>
                        <p style={s.replyText}>{reply}</p>
                        <div style={s.replyFooter}>
                          <span style={s.charHint}>{reply.length} chars</span>
                          <button onClick={() => pickR2(reply)} className="btn btn-gold" style={{ fontSize: 11, padding: '6px 16px' }}>Choose this</button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={s.actionRow}>
                    <button onClick={() => patch({ phase: 'r1' })} className="btn btn-ghost" style={{ fontSize: 11 }}>← Back to Round 1</button>
                    <button onClick={refreshR2} className="btn btn-ghost" style={{ fontSize: 11 }}>None of these — Refresh</button>
                  </div>
                </div>
              )}

              {/* Done */}
              {trainState.phase === 'done' && (
                <div style={s.donePanel}>
                  <div style={s.doneIcon}>✓</div>
                  <h2 style={s.doneTitle}>Style saved</h2>
                  {trainState.savedLabel
                    ? <p style={s.doneLabel}>{trainState.savedLabel}</p>
                    : <div style={s.spinner} />
                  }
                  <p style={s.doneDesc}>
                    Added to your style library and set as active for{' '}
                    <strong>{settings?.display_name ?? 'this location'}</strong>.
                  </p>
                  <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                    <button onClick={() => { setView('styles'); resetToSetup() }} className="btn btn-ghost" style={{ fontSize: 12 }}>
                      View Styles
                    </button>
                    <button onClick={resetToSetup} className="btn btn-ghost" style={{ fontSize: 12 }}>
                      Train again
                    </button>
                    <Link
                      href={locParam ? `/gmb/dashboard?loc=${encodeURIComponent(locParam)}` : '/gmb/dashboard'}
                      className="btn btn-gold" style={{ fontSize: 12, textDecoration: 'none' }}
                    >
                      Back to Dashboard
                    </Link>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function TrainPage() {
  return (
    <Suspense fallback={
      <div style={s.page}>
        <div style={s.glow} />
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
          <div style={s.spinner} />
        </div>
      </div>
    }>
      <TrainPageInner />
    </Suspense>
  )
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page:    { minHeight: '100vh', background: 'var(--bg)', position: 'relative' },
  glow:    { position: 'fixed', top: 0, left: '50%', transform: 'translateX(-50%)', width: 900, height: 220, background: 'radial-gradient(ellipse, var(--orange-glow) 0%, transparent 70%)', pointerEvents: 'none', filter: 'blur(50px)', zIndex: 0 },

  nav:     { position: 'sticky', top: 0, zIndex: 50, display: 'flex', alignItems: 'center', gap: 8, padding: '14px 24px', borderBottom: '1px solid var(--border)', background: 'rgba(244,246,250,0.92)', backdropFilter: 'blur(12px)' },
  navBrand:{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text)', textDecoration: 'none' },
  navIcon: { color: 'var(--orange)', fontSize: 18 },
  navName: { fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 700, color: 'var(--text)' },
  navSep:  { color: 'var(--text-muted)', fontSize: 16 },
  navLink: { fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--orange)', textDecoration: 'none' },
  navCrumb:{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)' },

  content: { maxWidth: 860, margin: '0 auto', padding: '40px 24px 60px', position: 'relative', zIndex: 1 },
  header:  { marginBottom: 24 },
  eyebrow: { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--orange)', marginBottom: 8 },
  title:   { fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 800, color: 'var(--text)', marginBottom: 0 },

  tabs:    { display: 'flex', gap: 4, marginBottom: 28, borderBottom: '1px solid var(--border)', paddingBottom: 0 },
  tab:     { fontFamily: 'var(--font-mono)', fontSize: 11, padding: '9px 18px', background: 'none', border: 'none', borderBottom: '2px solid transparent', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6, marginBottom: -1, transition: 'color 0.15s' },
  tabActive:{ color: 'var(--orange)', borderBottomColor: 'var(--orange)' },
  tabBadge: { background: 'var(--orange)', color: '#fff', borderRadius: 10, fontSize: 9, padding: '1px 6px', fontWeight: 700 },

  // Styles grid
  styleGrid:   { display: 'flex', flexDirection: 'column', gap: 12 },
  styleCard:   { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '20px 22px', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' },
  styleCardActive: { borderColor: 'var(--orange)', background: 'rgba(242,56,1,0.02)' },
  styleCardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 },
  styleName:   { fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, color: 'var(--text)', margin: 0 },
  styleStars:  { fontFamily: 'var(--font-mono)', fontSize: 13, color: '#f59e0b', marginTop: 2 },
  stylePreview:  { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.65, margin: '0 0 12px' },
  appliesToRow:  { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const },
  appliesToLabel:{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)', whiteSpace: 'nowrap' as const },
  maskBtn:       { fontFamily: 'var(--font-mono)', fontSize: 9, padding: '2px 8px', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', color: 'var(--text-muted)', background: 'transparent', letterSpacing: '0.06em' },
  maskWarning:   { fontFamily: 'var(--font-mono)', fontSize: 10, color: '#d97706', marginTop: 4, marginBottom: 0 },
  activeBadge: { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '3px 8px', borderRadius: 4, background: 'rgba(242,56,1,0.1)', color: 'var(--orange)', border: '1px solid rgba(242,56,1,0.2)' },
  deleteBtn:   { width: 24, height: 24, borderRadius: '50%', background: 'none', border: '1px solid var(--border)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s' },
  overrideRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  overrideDisplay: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5, flex: 1 },
  editBtn:     { fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--orange)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, whiteSpace: 'nowrap' as const },

  emptyCard:  { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '48px', textAlign: 'center' },
  emptyTitle: { fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700, color: 'var(--text)', marginBottom: 8 },
  emptyDesc:  { fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7, maxWidth: 420, margin: '0 auto' },

  // Train flow
  trainDesc: { fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.8, maxWidth: 560, marginBottom: 28 },
  progress:  { display: 'flex', alignItems: 'center', marginBottom: 28 },
  step:      { width: 28, height: 28, borderRadius: '50%', border: '2px solid var(--border)', background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', flexShrink: 0, transition: 'all 0.2s' },
  stepActive:{ borderColor: 'var(--orange)', color: 'var(--orange)' },
  stepDone:  { background: 'var(--orange)', borderColor: 'var(--orange)', color: '#fff' },
  stepLabel: { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.08em', padding: '0 8px', whiteSpace: 'nowrap' as const },
  stepLine:  { width: 32, height: 2, flexShrink: 0, transition: 'background 0.2s' },

  card:      { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, padding: '32px', boxShadow: '0 2px 12px rgba(0,0,0,0.06)' },
  sectionLabel: { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 },
  fieldLabel:   { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6, display: 'block' },
  textarea:     { width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.6, outline: 'none', resize: 'vertical', boxSizing: 'border-box' as const },
  input:        { width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 12, outline: 'none', boxSizing: 'border-box' as const },
  row2:         { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 },
  starRow:      { display: 'flex', alignItems: 'center', gap: 4 },
  starBtn:      { background: 'none', border: 'none', cursor: 'pointer', fontSize: 24, padding: '0 1px', transition: 'color 0.1s', lineHeight: 1 },
  starLabel:    { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', marginLeft: 8 },
  lengthGroup:  { display: 'flex', flexDirection: 'column', gap: 5 },
  lengthBtn:    { textAlign: 'left', padding: '6px 12px', fontFamily: 'var(--font-mono)', fontSize: 10, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 5, cursor: 'pointer', color: 'var(--text-muted)', transition: 'all 0.15s' },
  lengthBtnActive: { background: 'rgba(242,56,1,0.07)', borderColor: 'var(--orange)', color: 'var(--orange)' },

  loadingPanel: { display: 'flex', alignItems: 'center', gap: 20, padding: '40px 0' },
  loadingTitle: { fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 600, color: 'var(--text)', marginBottom: 4 },
  loadingDesc:  { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' },

  roundHeading: { fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 6 },
  roundDesc:    { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.7, marginBottom: 20 },
  insightBox:   { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 20, padding: '10px 14px', background: 'rgba(22,163,74,0.05)', border: '1px solid rgba(22,163,74,0.15)', borderRadius: 7, display: 'flex', alignItems: 'flex-start' },
  replyGrid:    { display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 },
  replyCard:    { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 18px' },
  replyNum:     { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--orange)', marginBottom: 8 },
  replyText:    { fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.75, margin: 0 },
  replyFooter:  { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 },
  charHint:     { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' },
  actionRow:    { display: 'flex', gap: 10 },

  donePanel: { display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '24px 0 8px', gap: 12 },
  doneIcon:  { width: 52, height: 52, borderRadius: '50%', background: 'rgba(22,163,74,0.12)', border: '2px solid rgba(22,163,74,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--success)', fontSize: 22 },
  doneTitle: { fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 800, color: 'var(--text)', margin: 0 },
  doneLabel: { fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--orange)', letterSpacing: '0.04em' },
  doneDesc:  { fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7, maxWidth: 440 },

  errorBanner: { background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 6, padding: '12px 16px', color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'var(--font-mono)', marginBottom: 24 },
  spinner:     { width: 22, height: 22, border: '2px solid var(--border)', borderTopColor: 'var(--orange)', borderRadius: '50%', animation: 'spin 0.8s linear infinite', flexShrink: 0 },

  // Test panel
  testSection:     { marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 },
  testToggleBtn:   { background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--orange)', padding: 0, letterSpacing: '0.06em', opacity: 0.9 },
  testPanel:       { marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 },
  testLabel:       { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 0, display: 'block' } as React.CSSProperties,
  testControls:    { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  testError:       { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--error)', margin: 0 },
  testRepliesList: { display: 'flex', flexDirection: 'column', gap: 8 },
  testReplyCard:   { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px' },
  testReplyHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  testReplyNum:    { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--orange)' },
  testReplyText:   { color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.8, margin: 0 },
}
