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

// Multi-round suggest state per review
type SuggestPhase = 'setup' | 'r1loading' | 'r1' | 'r2loading' | 'r2' | 'editing'
interface SuggestState {
  phase:      SuggestPhase
  r1Replies:  string[]
  r1Pick:     string | null
  r2Replies:  string[]
  insight:    string
}

const LENGTH_LABELS: Record<Length, string> = {
  recommended: 'Recommended',
  condense:    'Condense · ~250',
  medium:      'Medium · ~500',
  detailed:    'Detailed · ~750',
}

const STAR_MAP: Record<string, number> = { ONE:1, TWO:2, THREE:3, FOUR:4, FIVE:5 }

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
  const [loadingLocs,    setLoadingLocs]    = useState(true)
  const [loadingRevs,    setLoadingRevs]    = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [replyingTo,     setReplyingTo]     = useState<string | null>(null)
  const [replyTexts,     setReplyTexts]     = useState<Record<string, string>>({})
  const [sendingReply,   setSendingReply]   = useState<string | null>(null)
  const [error,          setError]          = useState('')

  // AI suggest — per review state
  const [suggestStates, setSuggestStates] = useState<Record<string, SuggestState>>({})
  const [keywords,      setKeywords]      = useState<Record<string, string>>({})
  const [replyLength,   setReplyLength]   = useState<Record<string, Length>>({})

  // ── Helpers ────────────────────────────────────────────────────────────────

  function patchSuggest(reviewName: string, patch: Partial<SuggestState>) {
    setSuggestStates(prev => ({
      ...prev,
      [reviewName]: {
        phase: 'setup', r1Replies: [], r1Pick: null, r2Replies: [], insight: '',
        ...(prev[reviewName] ?? {}),
        ...patch,
      },
    }))
  }

  function closeSuggest(reviewName: string) {
    setSuggestStates(prev => { const n = { ...prev }; delete n[reviewName]; return n })
  }

  function kwList(reviewName: string): string[] {
    return (keywords[reviewName] ?? '').split(',').map(k => k.trim()).filter(Boolean)
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

  // ── Load reviews when location changes ─────────────────────────────────────

  useEffect(() => {
    if (!activeLoc) return
    const loc = locations.find(l => l.location_name === activeLoc)
    if (loc) setSettings({ ...loc })

    setLoadingRevs(true)
    setReviews([])
    setSuggestStates({})
    fetch(`/api/gmb/reviews?locationName=${encodeURIComponent(activeLoc)}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) setError(`Reviews API error: ${d.error}`)
        setReviews(d.reviews ?? [])
      })
      .catch(() => setError('Failed to load reviews.'))
      .finally(() => setLoadingRevs(false))
  }, [activeLoc, locations])

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
      closeSuggest(reviewName)
      setReplyTexts(prev => { const n = { ...prev }; delete n[reviewName]; return n })
    } else {
      setError('Failed to post reply.')
    }
    setSendingReply(null)
  }

  // ── AI Suggest: Round 1 generate / refresh ─────────────────────────────────

  async function generateR1(review: Review) {
    patchSuggest(review.name, { phase: 'r1loading', r1Replies: [], r1Pick: null, r2Replies: [] })
    try {
      const res = await fetch('/api/gmb/suggest-reply', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reviewText:         review.comment ?? '',
          reviewAuthor:       review.reviewer?.displayName ?? 'Guest',
          starRating:         review.starRating,
          keywords:           kwList(review.name),
          length:             replyLength[review.name] ?? 'recommended',
          customInstructions: settings?.custom_instructions ?? '',
          promptHints:        settings?.prompt_hints ?? '',
        }),
      })
      const d = await res.json() as { replies?: string[]; error?: string }
      if (d.replies?.length) {
        patchSuggest(review.name, { phase: 'r1', r1Replies: d.replies })
      } else {
        setError(`AI generate failed: ${d.error ?? 'unknown'}`)
        patchSuggest(review.name, { phase: 'setup' })
      }
    } catch {
      setError('AI generate failed.')
      patchSuggest(review.name, { phase: 'setup' })
    }
  }

  // ── AI Suggest: user picks from Round 1 → trigger Round 2 ─────────────────

  async function pickR1(review: Review, picked: string) {
    patchSuggest(review.name, { phase: 'r2loading', r1Pick: picked, r2Replies: [] })
    try {
      const res = await fetch('/api/gmb/suggest-reply/refine', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selectedReply:      picked,
          reviewText:         review.comment ?? '',
          reviewAuthor:       review.reviewer?.displayName ?? 'Guest',
          starRating:         review.starRating,
          keywords:           kwList(review.name),
          length:             replyLength[review.name] ?? 'recommended',
          customInstructions: settings?.custom_instructions ?? '',
          promptHints:        settings?.prompt_hints ?? '',
        }),
      })
      const d = await res.json() as { replies?: string[]; insight?: string; error?: string }
      if (d.replies?.length) {
        patchSuggest(review.name, { phase: 'r2', r2Replies: d.replies, insight: d.insight ?? '' })
      } else {
        setError(`AI refine failed: ${d.error ?? 'unknown'}`)
        patchSuggest(review.name, { phase: 'r1' })
      }
    } catch {
      setError('AI refine failed.')
      patchSuggest(review.name, { phase: 'r1' })
    }
  }

  // ── AI Suggest: refresh Round 2 (same r1Pick, new variations) ─────────────

  async function refreshR2(review: Review) {
    const r1Pick = suggestStates[review.name]?.r1Pick
    if (!r1Pick) return
    patchSuggest(review.name, { phase: 'r2loading', r2Replies: [] })
    try {
      const res = await fetch('/api/gmb/suggest-reply/refine', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selectedReply:      r1Pick,
          reviewText:         review.comment ?? '',
          reviewAuthor:       review.reviewer?.displayName ?? 'Guest',
          starRating:         review.starRating,
          keywords:           kwList(review.name),
          length:             replyLength[review.name] ?? 'recommended',
          customInstructions: settings?.custom_instructions ?? '',
          promptHints:        settings?.prompt_hints ?? '',
        }),
      })
      const d = await res.json() as { replies?: string[]; insight?: string; error?: string }
      if (d.replies?.length) {
        patchSuggest(review.name, { phase: 'r2', r2Replies: d.replies, insight: d.insight ?? '' })
      } else {
        setError(`AI refine failed: ${d.error ?? 'unknown'}`)
        patchSuggest(review.name, { phase: 'r2' })
      }
    } catch {
      patchSuggest(review.name, { phase: 'r2' })
    }
  }

  // ── AI Suggest: user picks from Round 2 → fill editor + learn ─────────────

  async function pickR2(review: Review, picked: string) {
    const r1Pick = suggestStates[review.name]?.r1Pick ?? ''
    setReplyTexts(prev => ({ ...prev, [review.name]: picked }))
    setReplyingTo(review.name)
    patchSuggest(review.name, { phase: 'editing', r2Replies: [] })

    // Learn in background — non-blocking
    fetch('/api/gmb/suggest-reply/learn', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        r1Pick,
        r2Pick:       picked,
        reviewText:   review.comment ?? '',
        locationName: activeLoc,
      }),
    }).then(r => r.json()).then(d => {
      if (d.hints && settings) {
        const updated = { ...settings, prompt_hints: d.hints }
        setSettings(updated)
        setLocations(prev => prev.map(l =>
          l.location_name === activeLoc ? updated : l
        ))
      }
    }).catch(() => {/* non-fatal */})
  }

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

              {settings.prompt_hints && (
                <>
                  <p style={s.settingLabel}>Learned Style <span style={{ color: 'var(--success)', marginLeft: 4 }}>●</span></p>
                  <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                    {settings.prompt_hints}
                  </p>
                  <button
                    onClick={() => setSettings(p => p ? { ...p, prompt_hints: null } : p)}
                    style={{ marginTop: 6, fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                  >
                    Clear learned style
                  </button>
                </>
              )}

              <button
                onClick={saveSettings}
                disabled={savingSettings}
                className="btn btn-gold"
                style={{ width: '100%', marginTop: 14 }}
              >
                {savingSettings ? 'Saving…' : 'Save Settings'}
              </button>
            </div>
          )}
        </aside>

        {/* ── Main content ──────────────────────────────────────────────────── */}
        <main style={s.main}>
          {error && <div style={s.errorBanner}>⚠ {error}</div>}

          {/* Stats */}
          {reviews.length > 0 && (
            <div style={s.stats}>
              <div style={s.statCard}>
                <span style={s.statNum}>{reviews.length}</span>
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
          )}

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
            <div style={s.reviewsList}>
              {reviews.map(review => {
                const ss        = suggestStates[review.name]
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

                    {/* ── Reply area (only for unreplied) ────────────────── */}
                    {!review.reviewReply && (
                      <div style={s.replySection}>

                        {/* Default action buttons */}
                        {!ss && !isReplying && (
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button
                              onClick={() => setReplyingTo(review.name)}
                              className="btn btn-ghost"
                              style={{ fontSize: 11, padding: '7px 16px' }}
                            >
                              Write Reply
                            </button>
                            <button
                              onClick={() => patchSuggest(review.name, { phase: 'setup' })}
                              className="btn btn-ghost"
                              style={{ fontSize: 11, padding: '7px 16px', color: 'var(--orange)', borderColor: 'var(--orange)' }}
                            >
                              AI Suggest
                            </button>
                          </div>
                        )}

                        {/* ── AI Suggest panel ─────────────────────────── */}
                        {ss && (
                          <div style={s.suggestWrap}>

                            {/* Setup phase */}
                            {ss.phase === 'setup' && (
                              <div style={s.suggestPanel}>
                                <div style={s.suggestPanelHeader}>
                                  <span style={s.suggestTitle}>AI Suggest</span>
                                  <button onClick={() => closeSuggest(review.name)} style={s.closeBtn}>✕</button>
                                </div>

                                <p style={s.suggestLabel}>Keywords <span style={{ opacity: 0.5, textTransform: 'none', letterSpacing: 0 }}>(optional, comma-separated)</span></p>
                                <input
                                  placeholder="e.g. all-you-can-eat, sushi, value"
                                  value={keywords[review.name] ?? ''}
                                  onChange={e => setKeywords(p => ({ ...p, [review.name]: e.target.value }))}
                                  style={{ fontSize: 12, marginBottom: 12 }}
                                />

                                <p style={s.suggestLabel}>Reply length</p>
                                <div style={s.lengthGroup}>
                                  {(Object.keys(LENGTH_LABELS) as Length[]).map(len => (
                                    <button
                                      key={len}
                                      onClick={() => setReplyLength(p => ({ ...p, [review.name]: len }))}
                                      style={{ ...s.lengthBtn, ...((replyLength[review.name] ?? 'recommended') === len ? s.lengthBtnActive : {}) }}
                                    >
                                      {LENGTH_LABELS[len]}
                                    </button>
                                  ))}
                                </div>

                                <button
                                  onClick={() => generateR1(review)}
                                  className="btn btn-gold"
                                  style={{ marginTop: 14, fontSize: 11, padding: '8px 22px' }}
                                >
                                  Generate 5 options
                                </button>
                              </div>
                            )}

                            {/* Round 1 loading */}
                            {ss.phase === 'r1loading' && (
                              <div style={s.loadingPanel}>
                                <div style={s.spinner} />
                                <span style={s.loadingText}>Generating 5 variations…</span>
                              </div>
                            )}

                            {/* Round 1 select */}
                            {ss.phase === 'r1' && (
                              <div style={s.suggestPanel}>
                                <div style={s.suggestPanelHeader}>
                                  <span style={s.suggestTitle}>Round 1 — Pick the best match</span>
                                  <button onClick={() => closeSuggest(review.name)} style={s.closeBtn}>✕</button>
                                </div>
                                <div style={s.replyCards}>
                                  {ss.r1Replies.map((reply, i) => (
                                    <div key={i} style={s.replyCard}>
                                      <div style={s.replyCardNum}>{i + 1}</div>
                                      <p style={s.replyCardText}>{reply}</p>
                                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                                        <span style={s.charHint}>{reply.length} chars</span>
                                        <button
                                          onClick={() => pickR1(review, reply)}
                                          className="btn btn-gold"
                                          style={{ fontSize: 10, padding: '5px 14px' }}
                                        >
                                          Choose this
                                        </button>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                                <div style={{ marginTop: 12, display: 'flex', justifyContent: 'center' }}>
                                  <button
                                    onClick={() => generateR1(review)}
                                    className="btn btn-ghost"
                                    style={{ fontSize: 11, padding: '7px 18px' }}
                                  >
                                    None of these — Refresh
                                  </button>
                                </div>
                              </div>
                            )}

                            {/* Round 2 loading */}
                            {ss.phase === 'r2loading' && (
                              <div style={s.loadingPanel}>
                                <div style={s.spinner} />
                                <span style={s.loadingText}>Refining based on your pick…</span>
                              </div>
                            )}

                            {/* Round 2 select */}
                            {ss.phase === 'r2' && (
                              <div style={s.suggestPanel}>
                                <div style={s.suggestPanelHeader}>
                                  <span style={s.suggestTitle}>Round 2 — Pick the best refined version</span>
                                  <button onClick={() => closeSuggest(review.name)} style={s.closeBtn}>✕</button>
                                </div>
                                {ss.insight && (
                                  <p style={s.insightText}>
                                    <span style={{ color: 'var(--orange)', marginRight: 4 }}>●</span>
                                    {ss.insight}
                                  </p>
                                )}
                                <div style={s.replyCards}>
                                  {ss.r2Replies.map((reply, i) => (
                                    <div key={i} style={s.replyCard}>
                                      <div style={s.replyCardNum}>{i + 1}</div>
                                      <p style={s.replyCardText}>{reply}</p>
                                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                                        <span style={s.charHint}>{reply.length} chars</span>
                                        <button
                                          onClick={() => pickR2(review, reply)}
                                          className="btn btn-gold"
                                          style={{ fontSize: 10, padding: '5px 14px' }}
                                        >
                                          Choose this
                                        </button>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                                <div style={{ marginTop: 12, display: 'flex', justifyContent: 'center', gap: 10 }}>
                                  <button
                                    onClick={() => patchSuggest(review.name, { phase: 'r1' })}
                                    className="btn btn-ghost"
                                    style={{ fontSize: 11, padding: '7px 18px' }}
                                  >
                                    Back to Round 1
                                  </button>
                                  <button
                                    onClick={() => refreshR2(review)}
                                    className="btn btn-ghost"
                                    style={{ fontSize: 11, padding: '7px 18px' }}
                                  >
                                    None of these — Refresh
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Manual / AI-populated reply editor */}
                        {isReplying && (
                          <div style={s.replyInputWrap}>
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
                                onClick={() => { setReplyingTo(null); closeSuggest(review.name) }}
                                className="btn btn-ghost"
                                style={{ fontSize: 11, padding: '7px 16px' }}
                              >
                                Cancel
                              </button>
                              <button
                                onClick={() => {
                                  setReplyingTo(null)
                                  patchSuggest(review.name, { phase: 'setup' })
                                }}
                                className="btn btn-ghost"
                                style={{ fontSize: 11, padding: '7px 14px', color: 'var(--orange)', borderColor: 'var(--orange)' }}
                              >
                                Re-generate
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

  main:      { flex: 1, minWidth: 0 },
  errorBanner: { background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 6, padding: '12px 16px', color: 'var(--text-secondary)', fontSize: 13, fontFamily: 'var(--font-mono)', marginBottom: 20 },
  stats:     { display: 'flex', gap: 12, marginBottom: 24 },
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
  replyInputWrap:{},
  charCount:     { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', textAlign: 'right', marginBottom: 10 },
  replyActions:  { display: 'flex', justifyContent: 'flex-end', gap: 8 },

  // AI Suggest
  suggestWrap: { marginTop: 4 },
  suggestPanel: { background: 'rgba(242,56,1,0.03)', border: '1px solid rgba(242,56,1,0.15)', borderRadius: 8, padding: '16px' },
  suggestPanelHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  suggestTitle: { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--orange)' },
  closeBtn:     { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 13, padding: '2px 4px', lineHeight: 1 },
  suggestLabel: { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6 },
  lengthGroup:  { display: 'flex', flexWrap: 'wrap', gap: 6 },
  lengthBtn:    { padding: '5px 12px', fontFamily: 'var(--font-mono)', fontSize: 10, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 5, cursor: 'pointer', color: 'var(--text-muted)', transition: 'all 0.15s' },
  lengthBtnActive: { background: 'rgba(242,56,1,0.08)', borderColor: 'var(--orange)', color: 'var(--orange)' },
  loadingPanel: { display: 'flex', alignItems: 'center', gap: 10, padding: '16px', background: 'rgba(242,56,1,0.03)', border: '1px solid rgba(242,56,1,0.15)', borderRadius: 8 },
  loadingText:  { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' },
  insightText:  { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 12, padding: '8px 10px', background: 'rgba(22,163,74,0.05)', border: '1px solid rgba(22,163,74,0.15)', borderRadius: 5 },
  replyCards:   { display: 'flex', flexDirection: 'column', gap: 10 },
  replyCard:    { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 7, padding: '14px' },
  replyCardNum: { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.1em', color: 'var(--orange)', marginBottom: 6 },
  replyCardText:{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.7 },
  charHint:     { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' },
}
