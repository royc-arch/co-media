'use client'

import { useEffect, useState } from 'react'
import { useSearchParams }     from 'next/navigation'
import Link                    from 'next/link'

// ── Types ──────────────────────────────────────────────────────────────────────

interface LocationSetting {
  location_name:       string
  display_name:        string
  account_name:        string
  auto_reply_enabled:  boolean
  reply_tone:          string
  custom_instructions: string | null
  prompt_hints:        string | null
}

interface Review {
  name:         string
  reviewer:     { displayName: string }
  starRating:   string
  comment?:     string
  createTime:   string
  reviewReply?: { comment: string }
}

type Tone   = 'professional' | 'friendly' | 'casual'
type Length = 'recommended' | 'condense' | 'medium' | 'detailed'

// Two-round AI Style trainer state
type TrainPhase = 'setup' | 'r1loading' | 'r1' | 'r2loading' | 'r2' | 'done'
interface TrainState {
  phase:     TrainPhase
  r1Replies: string[]
  r1Pick:    string | null
  r2Replies: string[]
  insight:   string
}

const LENGTH_LABELS: Record<Length, string> = {
  recommended: 'Recommended',
  condense:    'Condense · ~250',
  medium:      'Medium · ~500',
  detailed:    'Detailed · ~750',
}

const STAR_LABELS = ['1 star', '2 stars', '3 stars', '4 stars', '5 stars']
const STAR_MAP: Record<string, number> = { ONE:1, TWO:2, THREE:3, FOUR:4, FIVE:5 }
const NUM_TO_STAR: Record<number, string> = { 1:'ONE', 2:'TWO', 3:'THREE', 4:'FOUR', 5:'FIVE' }

// ── Sub-components ─────────────────────────────────────────────────────────────

function StarRating({ rating }: { rating: string }) {
  const n = STAR_MAP[rating] ?? 0
  return (
    <span style={{ letterSpacing: 1, fontSize: 14 }}>
      {[1,2,3,4,5].map(i => (
        <span key={i} style={{ color: i <= n ? '#f59e0b' : 'var(--border)' }}>★</span>
      ))}
    </span>
  )
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const d    = Math.floor(diff / 86400000)
  if (d === 0) return 'Today'
  if (d === 1) return 'Yesterday'
  if (d < 30)  return `${d}d ago`
  if (d < 365) return `${Math.floor(d / 30)}mo ago`
  return `${Math.floor(d / 365)}y ago`
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function GmbDashboardPage() {
  const searchParams = useSearchParams()
  const initLoc      = searchParams.get('loc') ?? ''

  const [locations,      setLocations]      = useState<LocationSetting[]>([])
  const [activeLoc,      setActiveLoc]      = useState(initLoc)
  const [settings,       setSettings]       = useState<LocationSetting | null>(null)
  const [reviews,        setReviews]        = useState<Review[]>([])
  const [totalReviews,   setTotalReviews]   = useState(0)
  const [hasMore,        setHasMore]        = useState(false)
  const [page,           setPage]           = useState(0)
  const [loadingLocs,    setLoadingLocs]    = useState(true)
  const [loadingRevs,    setLoadingRevs]    = useState(false)
  const [loadingMore,    setLoadingMore]    = useState(false)
  const [syncing,        setSyncing]        = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [replyingTo,     setReplyingTo]     = useState<string | null>(null)
  const [replyTexts,     setReplyTexts]     = useState<Record<string, string>>({})
  const [sendingReply,   setSendingReply]   = useState<string | null>(null)
  const [error,          setError]          = useState('')

  // AI Style trainer
  const [showTrainer,   setShowTrainer]   = useState(false)
  const [trainState,    setTrainState]    = useState<TrainState>({ phase: 'setup', r1Replies: [], r1Pick: null, r2Replies: [], insight: '' })
  const [sampleReview,  setSampleReview]  = useState('')
  const [sampleStars,   setSampleStars]   = useState(5)
  const [trainKeywords, setTrainKeywords] = useState('')
  const [trainLength,   setTrainLength]   = useState<Length>('recommended')

  // ── Helpers ────────────────────────────────────────────────────────────────

  function patchTrain(patch: Partial<TrainState>) {
    setTrainState(prev => ({ ...prev, ...patch }))
  }

  function resetTrainer() {
    setTrainState({ phase: 'setup', r1Replies: [], r1Pick: null, r2Replies: [], insight: '' })
    setSampleReview('')
    setSampleStars(5)
    setTrainKeywords('')
    setTrainLength('recommended')
  }

  // ── Load locations ─────────────────────────────────────────────────────────

  useEffect(() => {
    fetch('/api/gmb/settings')
      .then(r => r.json())
      .then(d => {
        const locs: LocationSetting[] = d.settings ?? []
        setLocations(locs)
        if (!activeLoc && locs.length > 0) setActiveLoc(locs[0].location_name)
      })
      .finally(() => setLoadingLocs(false))
  }, [])

  // ── Load reviews (page 0) when location changes ───────────────────────────

  useEffect(() => {
    if (!activeLoc) return
    const loc = locations.find(l => l.location_name === activeLoc)
    if (loc) setSettings({ ...loc })

    setLoadingRevs(true)
    setReviews([])
    setPage(0)
    setHasMore(false)
    setTotalReviews(0)
    setShowTrainer(false)
    resetTrainer()

    fetch(`/api/gmb/reviews?locationName=${encodeURIComponent(activeLoc)}&page=0`)
      .then(r => r.json())
      .then(d => {
        if (d.error) { setError(`Reviews API error: ${d.error}`); return }
        setReviews(d.reviews ?? [])
        setTotalReviews(d.total ?? 0)
        setHasMore(d.hasMore ?? false)
      })
      .catch(() => setError('Failed to load reviews.'))
      .finally(() => setLoadingRevs(false))
  }, [activeLoc, locations])

  // ── Load more (next page) ──────────────────────────────────────────────────

  async function loadMore() {
    const nextPage = page + 1
    setLoadingMore(true)
    try {
      const res = await fetch(`/api/gmb/reviews?locationName=${encodeURIComponent(activeLoc)}&page=${nextPage}`)
      const d   = await res.json()
      if (d.reviews?.length) {
        setReviews(prev => [...prev, ...d.reviews])
        setPage(nextPage)
        setHasMore(d.hasMore ?? false)
      }
    } finally {
      setLoadingMore(false)
    }
  }

  // ── Sync from Google ───────────────────────────────────────────────────────

  async function syncFromGoogle() {
    setSyncing(true)
    setError('')
    try {
      const res = await fetch('/api/gmb/reviews', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ locationName: activeLoc }),
      })
      const d = await res.json()
      if (d.error) { setError(`Sync failed: ${d.error}`); return }

      // Reload page 0 after sync
      const fresh = await fetch(`/api/gmb/reviews?locationName=${encodeURIComponent(activeLoc)}&page=0`)
      const fd    = await fresh.json()
      setReviews(fd.reviews ?? [])
      setTotalReviews(fd.total ?? 0)
      setHasMore(fd.hasMore ?? false)
      setPage(0)
    } catch {
      setError('Sync failed.')
    } finally {
      setSyncing(false)
    }
  }

  // ── Save settings ──────────────────────────────────────────────────────────

  async function saveSettings() {
    if (!settings) return
    setSavingSettings(true)
    await fetch('/api/gmb/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountName:        settings.account_name,
        locationName:       settings.location_name,
        displayName:        settings.display_name,
        autoReplyEnabled:   settings.auto_reply_enabled,
        replyTone:          settings.reply_tone,
        customInstructions: settings.custom_instructions,
        promptHints:        settings.prompt_hints,
      }),
    })
    setSavingSettings(false)
    setLocations(prev => prev.map(l =>
      l.location_name === settings.location_name ? settings : l
    ))
  }

  // ── Post reply ─────────────────────────────────────────────────────────────

  async function postReply(reviewName: string) {
    const comment = replyTexts[reviewName]?.trim()
    if (!comment) return
    setSendingReply(reviewName)
    const res = await fetch('/api/gmb/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewName, comment }),
    })
    if (res.ok) {
      setReviews(prev => prev.map(r =>
        r.name === reviewName ? { ...r, reviewReply: { comment } } : r
      ))
      setReplyingTo(null)
      setReplyTexts(prev => { const n = { ...prev }; delete n[reviewName]; return n })
    } else {
      setError('Failed to post reply.')
    }
    setSendingReply(null)
  }

  // ── AI Style Trainer: Round 1 ──────────────────────────────────────────────

  async function trainGenerateR1() {
    if (!sampleReview.trim()) return
    patchTrain({ phase: 'r1loading', r1Replies: [], r1Pick: null, r2Replies: [] })
    const kws = trainKeywords.split(',').map(k => k.trim()).filter(Boolean)
    try {
      const res = await fetch('/api/gmb/suggest-reply', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reviewText:         sampleReview,
          reviewAuthor:       'Sample Customer',
          starRating:         NUM_TO_STAR[sampleStars],
          keywords:           kws,
          length:             trainLength,
          customInstructions: settings?.custom_instructions ?? '',
          promptHints:        settings?.prompt_hints ?? '',
        }),
      })
      const d = await res.json() as { replies?: string[]; error?: string }
      if (d.replies?.length) {
        patchTrain({ phase: 'r1', r1Replies: d.replies })
      } else {
        setError(`Generate failed: ${d.error ?? 'unknown'}`)
        patchTrain({ phase: 'setup' })
      }
    } catch {
      setError('Generate failed.')
      patchTrain({ phase: 'setup' })
    }
  }

  // ── AI Style Trainer: pick Round 1 → Round 2 ──────────────────────────────

  async function trainPickR1(picked: string) {
    patchTrain({ phase: 'r2loading', r1Pick: picked, r2Replies: [] })
    const kws = trainKeywords.split(',').map(k => k.trim()).filter(Boolean)
    try {
      const res = await fetch('/api/gmb/suggest-reply/refine', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selectedReply:      picked,
          reviewText:         sampleReview,
          reviewAuthor:       'Sample Customer',
          starRating:         NUM_TO_STAR[sampleStars],
          keywords:           kws,
          length:             trainLength,
          customInstructions: settings?.custom_instructions ?? '',
          promptHints:        settings?.prompt_hints ?? '',
        }),
      })
      const d = await res.json() as { replies?: string[]; insight?: string; error?: string }
      if (d.replies?.length) {
        patchTrain({ phase: 'r2', r2Replies: d.replies, insight: d.insight ?? '' })
      } else {
        setError(`Refine failed: ${d.error ?? 'unknown'}`)
        patchTrain({ phase: 'r1' })
      }
    } catch {
      patchTrain({ phase: 'r1' })
    }
  }

  // ── AI Style Trainer: refresh Round 2 ─────────────────────────────────────

  async function trainRefreshR2() {
    if (!trainState.r1Pick) return
    patchTrain({ phase: 'r2loading', r2Replies: [] })
    const kws = trainKeywords.split(',').map(k => k.trim()).filter(Boolean)
    try {
      const res = await fetch('/api/gmb/suggest-reply/refine', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selectedReply:      trainState.r1Pick,
          reviewText:         sampleReview,
          reviewAuthor:       'Sample Customer',
          starRating:         NUM_TO_STAR[sampleStars],
          keywords:           kws,
          length:             trainLength,
          customInstructions: settings?.custom_instructions ?? '',
          promptHints:        settings?.prompt_hints ?? '',
        }),
      })
      const d = await res.json() as { replies?: string[]; insight?: string; error?: string }
      if (d.replies?.length) {
        patchTrain({ phase: 'r2', r2Replies: d.replies, insight: d.insight ?? '' })
      } else {
        patchTrain({ phase: 'r2' })
      }
    } catch {
      patchTrain({ phase: 'r2' })
    }
  }

  // ── AI Style Trainer: pick Round 2 → learn + save ─────────────────────────

  async function trainPickR2(picked: string) {
    patchTrain({ phase: 'done' })
    try {
      const res = await fetch('/api/gmb/suggest-reply/learn', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          r1Pick:       trainState.r1Pick ?? '',
          r2Pick:       picked,
          reviewText:   sampleReview,
          locationName: activeLoc,
        }),
      })
      const d = await res.json() as { hints?: string }
      if (d.hints && settings) {
        const updated = { ...settings, prompt_hints: d.hints }
        setSettings(updated)
        setLocations(prev => prev.map(l =>
          l.location_name === activeLoc ? updated : l
        ))
      }
    } catch { /* non-fatal */ }
  }

  // Count from loaded reviews (approximate until all pages loaded)
  const unreplied = reviews.filter(r => !r.reviewReply).length
  const replied   = reviews.filter(r =>  r.reviewReply).length

  return (
    <div style={s.page}>
      <div style={s.glow} />

      {/* Nav */}
      <nav style={s.nav}>
        <Link href="/" style={s.navBrand}>
          <span style={s.navIcon}>◈</span>
          <span style={s.navName}>Co.Media</span>
        </Link>
        <span style={s.navSep}>/</span>
        <Link href="/gmb" style={s.navLink}>Review Reply</Link>
        <span style={s.navSep}>/</span>
        <span style={s.navCrumb}>Dashboard</span>
        <div style={{ marginLeft: 'auto' }}>
          <Link href="/gmb/setup" className="btn btn-ghost" style={{ fontSize: 10, padding: '6px 14px' }}>
            + Add Location
          </Link>
        </div>
      </nav>

      <div style={s.layout}>

        {/* ── Sidebar ──────────────────────────────────────────────────────── */}
        <aside style={s.sidebar}>

          {/* Location switcher */}
          <div style={s.sideSection}>
            <p style={s.sideLabel}>Locations</p>
            {loadingLocs ? <div style={s.spinner} /> : (
              <div style={s.locList}>
                {locations.map(loc => (
                  <button
                    key={loc.location_name}
                    onClick={() => setActiveLoc(loc.location_name)}
                    style={{ ...s.locBtn, ...(activeLoc === loc.location_name ? s.locBtnActive : {}) }}
                  >
                    <span style={s.locDot} />
                    <span style={s.locBtnName}>{loc.display_name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Auto-reply settings */}
          {settings && (
            <div style={s.sideSection}>
              <p style={s.sideLabel}>Auto-reply</p>

              <div style={s.toggleRow}>
                <span style={s.toggleLabel}>
                  {settings.auto_reply_enabled ? 'Enabled' : 'Disabled'}
                </span>
                <button
                  onClick={() => setSettings(p => p ? { ...p, auto_reply_enabled: !p.auto_reply_enabled } : p)}
                  style={{ ...s.toggleSwitch, background: settings.auto_reply_enabled ? 'var(--orange)' : 'var(--border)' }}
                >
                  <span style={{ ...s.toggleThumb, transform: settings.auto_reply_enabled ? 'translateX(18px)' : 'translateX(2px)' }} />
                </button>
              </div>

              <p style={s.settingLabel}>Reply Tone</p>
              <div style={s.toneGroup}>
                {(['professional', 'friendly', 'casual'] as Tone[]).map(tone => (
                  <button
                    key={tone}
                    onClick={() => setSettings(p => p ? { ...p, reply_tone: tone } : p)}
                    style={{ ...s.toneBtn, ...(settings.reply_tone === tone ? s.toneBtnActive : {}) }}
                  >
                    {tone}
                  </button>
                ))}
              </div>

              <p style={s.settingLabel}>Custom Instructions</p>
              <textarea
                placeholder="e.g. Always mention our loyalty program…"
                value={settings.custom_instructions ?? ''}
                onChange={e => setSettings(p => p ? { ...p, custom_instructions: e.target.value } : p)}
                style={s.textarea}
                rows={3}
              />

              {/* Learned style indicator */}
              {settings.prompt_hints && (
                <div style={s.learnedBox}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ ...s.settingLabel, margin: 0 }}>
                      Learned Style <span style={{ color: 'var(--success)' }}>●</span>
                    </span>
                    <button
                      onClick={() => setSettings(p => p ? { ...p, prompt_hints: null } : p)}
                      style={s.clearBtn}
                    >
                      Clear
                    </button>
                  </div>
                  <p style={s.learnedText}>{settings.prompt_hints}</p>
                </div>
              )}

              {/* Train style button */}
              <button
                onClick={() => { setShowTrainer(t => !t); resetTrainer() }}
                className="btn btn-ghost"
                style={{ width: '100%', marginTop: 12, fontSize: 10, color: 'var(--orange)', borderColor: 'var(--orange)' }}
              >
                {showTrainer ? 'Close Style Trainer' : 'Train AI Style'}
              </button>

              <button
                onClick={saveSettings}
                disabled={savingSettings}
                className="btn btn-gold"
                style={{ width: '100%', marginTop: 8 }}
              >
                {savingSettings ? 'Saving…' : 'Save Settings'}
              </button>
            </div>
          )}
        </aside>

        {/* ── Main content ──────────────────────────────────────────────────── */}
        <main style={s.main}>
          {error && <div style={s.errorBanner}>⚠ {error}</div>}

          {/* ── AI Style Trainer panel ─────────────────────────────────────── */}
          {showTrainer && (
            <div style={s.trainerCard}>
              <div style={s.trainerHeader}>
                <div>
                  <p style={s.trainerEyebrow}>Auto-reply</p>
                  <h2 style={s.trainerTitle}>Train AI Reply Style</h2>
                  <p style={s.trainerDesc}>
                    Enter a sample review, generate 5 reply options, pick the one that feels right,
                    then refine — the system learns your preferred style for all future auto-replies.
                  </p>
                </div>
              </div>

              {/* Setup */}
              {trainState.phase === 'setup' && (
                <div style={s.trainerBody}>
                  <p style={s.fieldLabel}>Sample review text</p>
                  <textarea
                    placeholder="Paste a real customer review or write a sample one…"
                    value={sampleReview}
                    onChange={e => setSampleReview(e.target.value)}
                    style={{ ...s.textarea, marginBottom: 12 }}
                    rows={3}
                  />

                  <p style={s.fieldLabel}>Star rating</p>
                  <div style={s.starRow}>
                    {[1,2,3,4,5].map(n => (
                      <button
                        key={n}
                        onClick={() => setSampleStars(n)}
                        style={{ ...s.starBtn, color: n <= sampleStars ? '#f59e0b' : 'var(--border)' }}
                      >
                        ★
                      </button>
                    ))}
                    <span style={s.starLabel}>{STAR_LABELS[sampleStars - 1]}</span>
                  </div>

                  <p style={s.fieldLabel} style={{ marginTop: 12 }}>Keywords to embed <span style={{ opacity: 0.5, fontWeight: 400 }}>(optional, comma-separated)</span></p>
                  <input
                    placeholder="e.g. all-you-can-eat, sushi, great value"
                    value={trainKeywords}
                    onChange={e => setTrainKeywords(e.target.value)}
                    style={{ fontSize: 12, marginBottom: 12 }}
                  />

                  <p style={s.fieldLabel}>Reply length</p>
                  <div style={s.lengthGroup}>
                    {(Object.keys(LENGTH_LABELS) as Length[]).map(len => (
                      <button
                        key={len}
                        onClick={() => setTrainLength(len)}
                        style={{ ...s.lengthBtn, ...(trainLength === len ? s.lengthBtnActive : {}) }}
                      >
                        {LENGTH_LABELS[len]}
                      </button>
                    ))}
                  </div>

                  <button
                    onClick={trainGenerateR1}
                    disabled={!sampleReview.trim()}
                    className="btn btn-gold"
                    style={{ marginTop: 16 }}
                  >
                    Generate 5 options
                  </button>
                </div>
              )}

              {/* Loading */}
              {(trainState.phase === 'r1loading' || trainState.phase === 'r2loading') && (
                <div style={s.loadingPanel}>
                  <div style={s.spinner} />
                  <span style={s.loadingText}>
                    {trainState.phase === 'r1loading' ? 'Generating 5 variations…' : 'Refining based on your pick…'}
                  </span>
                </div>
              )}

              {/* Round 1 */}
              {trainState.phase === 'r1' && (
                <div style={s.trainerBody}>
                  <p style={s.roundLabel}>Round 1 — Pick the reply that feels most like you</p>
                  <div style={s.replyCards}>
                    {trainState.r1Replies.map((reply, i) => (
                      <div key={i} style={s.replyCard}>
                        <div style={s.replyCardNum}>{i + 1}</div>
                        <p style={s.replyCardText}>{reply}</p>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                          <span style={s.charHint}>{reply.length} chars</span>
                          <button onClick={() => trainPickR1(reply)} className="btn btn-gold" style={{ fontSize: 10, padding: '5px 14px' }}>
                            Choose this
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop: 14, display: 'flex', gap: 10 }}>
                    <button onClick={() => patchTrain({ phase: 'setup' })} className="btn btn-ghost" style={{ fontSize: 11 }}>
                      Back to setup
                    </button>
                    <button onClick={trainGenerateR1} className="btn btn-ghost" style={{ fontSize: 11 }}>
                      None of these — Refresh
                    </button>
                  </div>
                </div>
              )}

              {/* Round 2 */}
              {trainState.phase === 'r2' && (
                <div style={s.trainerBody}>
                  <p style={s.roundLabel}>Round 2 — Pick the best refined version</p>
                  {trainState.insight && (
                    <p style={s.insightText}>
                      <span style={{ color: 'var(--orange)', marginRight: 4 }}>●</span>
                      {trainState.insight}
                    </p>
                  )}
                  <div style={s.replyCards}>
                    {trainState.r2Replies.map((reply, i) => (
                      <div key={i} style={s.replyCard}>
                        <div style={s.replyCardNum}>{i + 1}</div>
                        <p style={s.replyCardText}>{reply}</p>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                          <span style={s.charHint}>{reply.length} chars</span>
                          <button onClick={() => trainPickR2(reply)} className="btn btn-gold" style={{ fontSize: 10, padding: '5px 14px' }}>
                            Choose this
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop: 14, display: 'flex', gap: 10 }}>
                    <button onClick={() => patchTrain({ phase: 'r1' })} className="btn btn-ghost" style={{ fontSize: 11 }}>
                      Back to Round 1
                    </button>
                    <button onClick={trainRefreshR2} className="btn btn-ghost" style={{ fontSize: 11 }}>
                      None of these — Refresh
                    </button>
                  </div>
                </div>
              )}

              {/* Done */}
              {trainState.phase === 'done' && (
                <div style={s.donePanel}>
                  <span style={{ color: 'var(--success)', fontSize: 20 }}>✓</span>
                  <div>
                    <p style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>Style saved</p>
                    <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                      Your learned style has been saved. All future auto-replies for this location will follow it.
                      Click <strong>Save Settings</strong> in the sidebar to confirm.
                    </p>
                  </div>
                  <button onClick={resetTrainer} className="btn btn-ghost" style={{ fontSize: 11, marginTop: 8 }}>
                    Train again
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Stats + sync */}
          <div style={s.statsRow}>
            <div style={s.stats}>
              <div style={s.statCard}>
                <span style={s.statNum}>{totalReviews}</span>
                <span style={s.statLabel}>Total Reviews</span>
              </div>
              <div style={s.statCard}>
                <span style={{ ...s.statNum, color: 'var(--error)' }}>{unreplied}</span>
                <span style={s.statLabel}>Awaiting Reply</span>
              </div>
              <div style={s.statCard}>
                <span style={{ ...s.statNum, color: 'var(--success)' }}>{replied}</span>
                <span style={s.statLabel}>Replied</span>
              </div>
            </div>
            <button
              onClick={syncFromGoogle}
              disabled={syncing}
              className="btn btn-ghost"
              style={{ fontSize: 11, padding: '8px 16px', flexShrink: 0, alignSelf: 'flex-start' }}
            >
              {syncing ? 'Syncing…' : '↻ Sync from Google'}
            </button>
          </div>

          {/* Reviews */}
          {loadingRevs ? (
            <div style={s.loadWrap}>
              <div style={s.spinner} />
              <p style={s.loadText}>Loading reviews…</p>
            </div>
          ) : reviews.length === 0 ? (
            <div style={s.emptyCard}>
              <p style={s.emptyTitle}>No reviews yet</p>
              <p style={s.emptyDesc}>Reviews will appear here once customers leave them on Google.</p>
            </div>
          ) : (
            <>
            <div style={s.reviewsList}>
              {reviews.map(review => {
                const isReplying = replyingTo === review.name
                const isSending  = sendingReply === review.name

                return (
                  <div key={review.name} style={s.reviewCard}>

                    {/* Review header */}
                    <div style={s.reviewHeader}>
                      <div style={s.reviewAuthorWrap}>
                        <div style={s.reviewAvatar}>
                          {(review.reviewer?.displayName?.[0] ?? '?').toUpperCase()}
                        </div>
                        <div>
                          <p style={s.reviewAuthor}>{review.reviewer?.displayName ?? 'Anonymous'}</p>
                          <p style={s.reviewTime}>{timeAgo(review.createTime)}</p>
                        </div>
                      </div>
                      <div style={s.reviewMeta}>
                        <StarRating rating={review.starRating} />
                        <span style={{ ...s.reviewBadge, ...(review.reviewReply ? s.reviewBadgeReplied : s.reviewBadgePending) }}>
                          {review.reviewReply ? 'Replied' : 'Pending'}
                        </span>
                      </div>
                    </div>

                    {/* Comment */}
                    {review.comment && <p style={s.reviewComment}>{review.comment}</p>}

                    {/* Existing reply */}
                    {review.reviewReply && (
                      <div style={s.existingReply}>
                        <p style={s.existingReplyLabel}>Your reply</p>
                        <p style={s.existingReplyText}>{review.reviewReply.comment}</p>
                      </div>
                    )}

                    {/* Manual reply (unreplied only) */}
                    {!review.reviewReply && (
                      <div style={s.replySection}>
                        {!isReplying ? (
                          <button
                            onClick={() => setReplyingTo(review.name)}
                            className="btn btn-ghost"
                            style={{ fontSize: 11, padding: '7px 16px' }}
                          >
                            Write Reply
                          </button>
                        ) : (
                          <div>
                            <textarea
                              autoFocus
                              placeholder="Write your reply…"
                              value={replyTexts[review.name] ?? ''}
                              onChange={e => setReplyTexts(p => ({ ...p, [review.name]: e.target.value }))}
                              style={{ ...s.textarea, marginBottom: 6 }}
                              rows={4}
                            />
                            <p style={s.charCount}>{(replyTexts[review.name] ?? '').length} characters</p>
                            <div style={s.replyActions}>
                              <button
                                onClick={() => setReplyingTo(null)}
                                className="btn btn-ghost"
                                style={{ fontSize: 11, padding: '7px 16px' }}
                              >
                                Cancel
                              </button>
                              <button
                                onClick={() => postReply(review.name)}
                                disabled={!replyTexts[review.name]?.trim() || isSending}
                                className="btn btn-gold"
                                style={{ fontSize: 11, padding: '7px 20px' }}
                              >
                                {isSending ? 'Sending…' : 'Post Reply'}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Load more */}
            {hasMore && (
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: 20 }}>
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="btn btn-ghost"
                  style={{ fontSize: 11, padding: '9px 24px' }}
                >
                  {loadingMore ? 'Loading…' : `Load more (showing ${reviews.length} of ${totalReviews})`}
                </button>
              </div>
            )}
            {!hasMore && reviews.length > 0 && (
              <p style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', marginTop: 20 }}>
                All {totalReviews} reviews loaded
              </p>
            )}
            </>
          )}
        </main>
      </div>
    </div>
  )
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page:    { minHeight: '100vh', background: 'var(--bg)', position: 'relative' },
  glow:    { position: 'fixed', top: 0, left: '50%', transform: 'translateX(-50%)', width: 800, height: 200, background: 'radial-gradient(ellipse, var(--orange-glow) 0%, transparent 70%)', pointerEvents: 'none', filter: 'blur(50px)', zIndex: 0 },
  nav:     { position: 'sticky', top: 0, zIndex: 50, display: 'flex', alignItems: 'center', gap: 8, padding: '14px 24px', borderBottom: '1px solid var(--border)', background: 'rgba(244,246,250,0.92)', backdropFilter: 'blur(12px)' },
  navBrand:{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text)', textDecoration: 'none' },
  navIcon: { color: 'var(--orange)', fontSize: 18 },
  navName: { fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 700, color: 'var(--text)' },
  navSep:  { color: 'var(--text-muted)', fontSize: 16 },
  navLink: { fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--orange)', textDecoration: 'none' },
  navCrumb:{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)' },

  layout:  { display: 'flex', maxWidth: 1100, margin: '0 auto', padding: '32px 24px', gap: 28, position: 'relative', zIndex: 1 },
  sidebar: { width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 24 },
  sideSection: { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, padding: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' },
  sideLabel: { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 12 },
  locList: { display: 'flex', flexDirection: 'column', gap: 4 },
  locBtn:  { width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10, background: 'transparent', border: 'none', borderRadius: 6, padding: '8px 10px', cursor: 'pointer', transition: 'background 0.15s' },
  locBtnActive: { background: 'rgba(242,56,1,0.07)' },
  locDot:  { width: 6, height: 6, borderRadius: '50%', background: 'var(--orange)', flexShrink: 0 },
  locBtnName: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)' },
  toggleRow:  { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  toggleLabel:{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' },
  toggleSwitch: { width: 38, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', padding: 0 },
  toggleThumb:  { position: 'absolute', top: 3, width: 16, height: 16, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.3)', transition: 'transform 0.2s', display: 'block' },
  settingLabel: { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8, marginTop: 12 },
  toneGroup: { display: 'flex', gap: 6 },
  toneBtn:   { flex: 1, padding: '6px 4px', fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.08em', textTransform: 'capitalize', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 5, cursor: 'pointer', color: 'var(--text-muted)', transition: 'all 0.15s' },
  toneBtnActive: { background: 'rgba(242,56,1,0.08)', borderColor: 'var(--orange)', color: 'var(--orange)' },
  textarea: { width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.6, outline: 'none', resize: 'vertical' },
  learnedBox:  { marginTop: 12, padding: '10px 12px', background: 'rgba(22,163,74,0.05)', border: '1px solid rgba(22,163,74,0.2)', borderRadius: 6 },
  learnedText: { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6 },
  clearBtn:    { fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, letterSpacing: '0.06em' },

  main:      { flex: 1, minWidth: 0 },
  errorBanner: { background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 6, padding: '12px 16px', color: 'var(--text-secondary)', fontSize: 13, fontFamily: 'var(--font-mono)', marginBottom: 20 },

  // Trainer card
  trainerCard: { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '28px', marginBottom: 28, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  trainerHeader: { marginBottom: 20 },
  trainerEyebrow: { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--orange)', marginBottom: 6 },
  trainerTitle: { fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, color: 'var(--text)', marginBottom: 6 },
  trainerDesc:  { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.7 },
  trainerBody:  {},
  fieldLabel:   { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8, display: 'block' },
  starRow:   { display: 'flex', alignItems: 'center', gap: 4 },
  starBtn:   { background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, padding: '0 2px', transition: 'color 0.1s' },
  starLabel: { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', marginLeft: 6 },
  lengthGroup:  { display: 'flex', flexWrap: 'wrap', gap: 6 },
  lengthBtn:    { padding: '5px 12px', fontFamily: 'var(--font-mono)', fontSize: 10, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 5, cursor: 'pointer', color: 'var(--text-muted)', transition: 'all 0.15s' },
  lengthBtnActive: { background: 'rgba(242,56,1,0.08)', borderColor: 'var(--orange)', color: 'var(--orange)' },
  loadingPanel: { display: 'flex', alignItems: 'center', gap: 12, padding: '20px 0' },
  loadingText:  { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' },
  roundLabel:   { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--orange)', marginBottom: 14 },
  insightText:  { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 14, padding: '8px 12px', background: 'rgba(22,163,74,0.05)', border: '1px solid rgba(22,163,74,0.15)', borderRadius: 6 },
  replyCards:   { display: 'flex', flexDirection: 'column', gap: 10 },
  replyCard:    { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px' },
  replyCardNum: { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.12em', color: 'var(--orange)', marginBottom: 6 },
  replyCardText:{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.7 },
  charHint:     { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' },
  donePanel: { display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 8, padding: '24px 0' },

  statsRow:  { display: 'flex', gap: 16, alignItems: 'flex-start', marginBottom: 24 },
  stats:     { display: 'flex', gap: 12, flex: 1 },
  statCard:  { flex: 1, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, padding: '16px', display: 'flex', flexDirection: 'column', gap: 4 },
  statNum:   { fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 800, color: 'var(--text)', lineHeight: 1 },
  statLabel: { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)' },
  loadWrap:  { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '60px 0' },
  spinner:   { width: 22, height: 22, border: '2px solid var(--border)', borderTopColor: 'var(--orange)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' },
  loadText:  { color: 'var(--text-muted)', fontSize: 12, fontFamily: 'var(--font-mono)' },
  emptyCard: { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '48px', textAlign: 'center' },
  emptyTitle:{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700, color: 'var(--text)', marginBottom: 8 },
  emptyDesc: { color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.7 },
  reviewsList:   { display: 'flex', flexDirection: 'column', gap: 12 },
  reviewCard:    { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, padding: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' },
  reviewHeader:  { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, flexWrap: 'wrap', gap: 8 },
  reviewAuthorWrap: { display: 'flex', alignItems: 'center', gap: 12 },
  reviewAvatar:  { width: 36, height: 36, borderRadius: '50%', background: 'linear-gradient(135deg, var(--orange) 0%, var(--orange-light) 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 700, flexShrink: 0 },
  reviewAuthor:  { fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 600, color: 'var(--text)' },
  reviewTime:    { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', marginTop: 2 },
  reviewMeta:    { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 },
  reviewBadge:   { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '3px 9px', borderRadius: 20, border: '1px solid' },
  reviewBadgeReplied: { color: 'var(--success)', borderColor: 'rgba(22,163,74,0.3)', background: 'rgba(22,163,74,0.06)' },
  reviewBadgePending: { color: '#d97706', borderColor: 'rgba(217,119,6,0.3)', background: 'rgba(217,119,6,0.06)' },
  reviewComment: { color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.7, marginBottom: 12 },
  existingReply: { background: 'rgba(242,56,1,0.04)', border: '1px solid rgba(242,56,1,0.12)', borderLeft: '3px solid var(--orange)', borderRadius: '0 6px 6px 0', padding: '12px 14px', marginBottom: 8 },
  existingReplyLabel: { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--orange)', marginBottom: 6 },
  existingReplyText:  { color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.7 },
  replySection:  { marginTop: 4 },
  charCount:     { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', textAlign: 'right', marginBottom: 10 },
  replyActions:  { display: 'flex', justifyContent: 'flex-end', gap: 8 },
}
