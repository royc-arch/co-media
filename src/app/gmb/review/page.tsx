'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams, useRouter }    from 'next/navigation'
import Link                              from 'next/link'

// ── Types ──────────────────────────────────────────────────────────────────────

interface Review {
  name:         string
  reviewer:     { displayName: string }
  starRating:   string
  comment?:     string
  createTime:   string
  reviewReply?: { comment: string }
  hasPhoto?:    boolean
}

interface LocationSetting {
  location_name:       string
  display_name:        string
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

type Length = 'recommended' | 'condense' | 'medium' | 'detailed'

const LENGTH_LABELS: Record<Length, string> = {
  recommended: 'Recommended · review length + 250',
  condense:    'Condense · ~250',
  medium:      'Medium · ~500',
  detailed:    'Detailed · ~750',
}

const STAR_MAP: Record<string, number> = { ONE:1, TWO:2, THREE:3, FOUR:4, FIVE:5 }

function starStr(n: number) {
  return '★'.repeat(n) + '☆'.repeat(5 - n)
}

function buildPromptHints(style: GmbStyle | null): string {
  if (!style) return ''
  const mask = style.apply_mask ?? (1 << (style.stars - 1))
  const base = `${style.name}||${style.stars}||${mask}||${style.style_text}`
  return style.override_text ? base + `\n\nCampaign instructions: ${style.override_text}` : base
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StarRating({ rating }: { rating: string }) {
  const n = STAR_MAP[rating] ?? 0
  return (
    <span style={{ letterSpacing: 1, fontSize: 16 }}>
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

// ── Inner page ─────────────────────────────────────────────────────────────────

function ReviewPageInner() {
  const searchParams = useSearchParams()
  const router       = useRouter()
  const reviewName   = searchParams.get('name') ?? ''
  const locationName = reviewName.split('/').slice(0, 4).join('/')

  const [review,       setReview]       = useState<Review | null>(null)
  const [settings,     setSettings]     = useState<LocationSetting | null>(null)
  const [styles,       setStyles]       = useState<GmbStyle[]>([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState('')

  // Reply state
  const [replyText,    setReplyText]    = useState('')
  const [sending,      setSending]      = useState(false)
  const [replyDone,    setReplyDone]    = useState(false)

  // AI suggest state
  const [showAI,       setShowAI]       = useState(false)
  const [selectedStyle,setSelectedStyle]= useState<GmbStyle | null>(null)
  const [keywords,     setKeywords]     = useState('')
  const [aiLength,     setAiLength]     = useState<Length>('recommended')
  const [aiContext,    setAiContext]    = useState('')
  const [generating,   setGenerating]   = useState(false)
  const [suggestions,  setSuggestions]  = useState<string[]>([])
  const [aiError,      setAiError]      = useState('')

  // ── Load ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!reviewName) return
    setLoading(true)
    Promise.all([
      fetch(`/api/gmb/reviews?reviewName=${encodeURIComponent(reviewName)}`).then(r => r.json()),
      locationName
        ? fetch(`/api/gmb/settings?locationName=${encodeURIComponent(locationName)}`).then(r => r.json())
        : Promise.resolve({ settings: [] }),
      locationName
        ? fetch(`/api/gmb/styles?locationName=${encodeURIComponent(locationName)}`).then(r => r.json())
        : Promise.resolve({ styles: [] }),
    ])
      .then(([revData, settData, styleData]) => {
        if (revData.error) { setError(revData.error); return }
        setReview(revData.review)
        if (revData.review?.reviewReply) setReplyText(revData.review.reviewReply.comment)
        const locs: LocationSetting[] = settData.settings ?? []
        if (locs.length) setSettings(locs[0])
        const savedStyles: GmbStyle[] = styleData.styles ?? []
        setStyles(savedStyles)
        if (savedStyles.length) setSelectedStyle(savedStyles[0])
      })
      .catch(() => setError('Failed to load review.'))
      .finally(() => setLoading(false))
  }, [reviewName, locationName])

  // ── Post reply ────────────────────────────────────────────────────────────

  async function postReply() {
    if (!replyText.trim() || !review) return
    setSending(true)
    setError('')
    try {
      const res = await fetch('/api/gmb/reply', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ reviewName: review.name, comment: replyText.trim() }),
      })
      const d = await res.json()
      if (d.error) { setError(d.error); return }
      setReview(prev => prev ? { ...prev, reviewReply: { comment: replyText.trim() } } : prev)
      setReplyDone(true)
    } finally {
      setSending(false)
    }
  }

  // ── AI suggest ────────────────────────────────────────────────────────────

  async function generateSuggestions() {
    if (!review) return
    setGenerating(true)
    setAiError('')
    setSuggestions([])
    const kws = keywords.split(',').map(k => k.trim()).filter(Boolean)
    try {
      const res = await fetch('/api/gmb/suggest-reply', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reviewText:         review.comment ?? '',
          reviewAuthor:       review.reviewer.displayName,
          starRating:         review.starRating,
          keywords:           kws,
          length:             aiLength,
          context:            aiContext,
          customInstructions: settings?.custom_instructions ?? '',
          promptHints:        buildPromptHints(selectedStyle),
          locationName,
          hasPhoto:           review.hasPhoto ?? false,
        }),
      })
      const d = await res.json() as { replies?: string[]; error?: string }
      if (d.replies?.length) {
        setSuggestions(d.replies)
      } else {
        setAiError(d.error ?? 'No suggestions returned.')
      }
    } catch {
      setAiError('Failed to generate suggestions.')
    } finally {
      setGenerating(false)
    }
  }

  // ── Style dropdown change ─────────────────────────────────────────────────

  function handleStyleChange(value: string) {
    if (value === '__create__') {
      router.push(`/gmb/train?loc=${encodeURIComponent(locationName)}`)
      return
    }
    if (value === '__none__') { setSelectedStyle(null); setKeywords(''); setAiContext(''); return }
    const found = styles.find(s => s.id === value)
    setSelectedStyle(found ?? null)
    if (found) {
      if (found.keywords) setKeywords(found.keywords)
      if (found.context)  setAiContext(found.context)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) return (
    <div style={s.page}>
      <div style={s.glow} />
      <nav style={s.nav}><NavBrand loc={locationName} /></nav>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0', gap: 12, alignItems: 'center' }}>
        <div style={s.spinner} /><span style={s.loadText}>Loading review…</span>
      </div>
    </div>
  )

  if (!review) return (
    <div style={s.page}>
      <div style={s.glow} />
      <nav style={s.nav}><NavBrand loc={locationName} /></nav>
      <div style={{ textAlign: 'center', padding: '80px 24px' }}>
        <p style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>
          {error || 'Review not found.'}
        </p>
      </div>
    </div>
  )

  const isReplied = !!(replyDone || review.reviewReply)

  return (
    <div style={s.page}>
      <div style={s.glow} />
      <nav style={s.nav}><NavBrand loc={locationName} /></nav>

      <div style={s.content}>
        {error && <div style={s.errorBanner}>⚠ {error}</div>}

        {/* Review card */}
        <div style={s.reviewCard}>
          <div style={s.reviewHeader}>
            <div style={s.reviewAuthorWrap}>
              <div style={s.reviewAvatar}>
                {(review.reviewer.displayName?.[0] ?? '?').toUpperCase()}
              </div>
              <div>
                <p style={s.reviewAuthor}>{review.reviewer.displayName}</p>
                <p style={s.reviewTime}>{timeAgo(review.createTime)}</p>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <StarRating rating={review.starRating} />
              <span style={{ ...s.badge, ...(isReplied ? s.badgeReplied : s.badgePending) }}>
                {isReplied ? 'Replied' : 'Pending'}
              </span>
            </div>
          </div>
          {review.comment
            ? <p style={s.reviewComment}>{review.comment}</p>
            : <p style={{ ...s.reviewComment, color: 'var(--text-muted)', fontStyle: 'italic' }}>(No comment)</p>
          }
        </div>

        {/* Reply section */}
        <div style={s.replyCard}>
          <p style={s.sectionLabel}>{isReplied ? 'Your Reply' : 'Write a Reply'}</p>

          {isReplied && !replyDone ? (
            <div>
              <p style={s.existingReplyText}>{review.reviewReply!.comment}</p>
              <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', marginTop: 8 }}>
                Reply posted to Google
              </p>
            </div>
          ) : replyDone ? (
            <div style={s.successBanner}>
              <span style={{ color: 'var(--success)', fontSize: 18, marginRight: 8 }}>✓</span>
              Reply posted to Google successfully.
            </div>
          ) : (
            <div>
              {/* AI toggle */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
                  {replyText.length > 0 ? `${replyText.length} characters` : ''}
                </span>
                <button
                  onClick={() => { setShowAI(p => !p); setSuggestions([]); setAiError('') }}
                  className="btn btn-ghost"
                  style={{ fontSize: 10, padding: '5px 14px', color: 'var(--orange)', borderColor: 'var(--orange)' }}
                >
                  {showAI ? 'Hide AI Suggest' : '✦ AI Suggest'}
                </button>
              </div>

              {/* AI suggest panel */}
              {showAI && (
                <div style={s.aiPanel}>
                  <p style={s.aiPanelLabel}>AI Reply Suggestions</p>

                  {/* Style selector */}
                  <p style={s.fieldLabel}>Reply style</p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                    <select
                      value={selectedStyle?.id ?? '__none__'}
                      onChange={e => handleStyleChange(e.target.value)}
                      style={s.select}
                    >
                      <option value="__none__">No style</option>
                      {styles.map(st => (
                        <option key={st.id} value={st.id}>
                          {st.name} {starStr(st.stars)}
                          {st.override_text ? '  ·  has campaign note' : ''}
                        </option>
                      ))}
                      <option value="__create__">+ Create new style →</option>
                    </select>
                    {styles.length === 0 && (
                      <Link
                        href={`/gmb/train?loc=${encodeURIComponent(locationName)}`}
                        style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--orange)', whiteSpace: 'nowrap' }}
                      >
                        Train a style first →
                      </Link>
                    )}
                  </div>

                  {/* Show override note if set */}
                  {selectedStyle?.override_text && (
                    <div style={s.overrideHint}>
                      <span style={{ color: 'var(--orange)', marginRight: 6 }}>◈</span>
                      Campaign note: {selectedStyle.override_text}
                    </div>
                  )}

                  <p style={s.fieldLabel}>Keywords <span style={{ opacity: 0.5, fontWeight: 400, textTransform: 'none' }}>(optional, comma-separated)</span></p>
                  <input
                    placeholder="e.g. all-you-can-eat, great value"
                    value={keywords}
                    onChange={e => setKeywords(e.target.value)}
                    style={{ ...s.input, marginBottom: 10 }}
                  />

                  <p style={s.fieldLabel}>Context <span style={{ opacity: 0.5, fontWeight: 400, textTransform: 'none' }}>(optional)</span></p>
                  <textarea
                    placeholder="e.g. Weekend brunch promotion…"
                    value={aiContext}
                    onChange={e => setAiContext(e.target.value)}
                    rows={2}
                    style={{ ...s.textarea, marginBottom: 10 }}
                  />

                  <p style={s.fieldLabel}>Reply length</p>
                  <div style={s.lengthGroup}>
                    {(Object.keys(LENGTH_LABELS) as Length[]).map(len => (
                      <button
                        key={len}
                        onClick={() => setAiLength(len)}
                        style={{ ...s.lengthBtn, ...(aiLength === len ? s.lengthBtnActive : {}) }}
                      >
                        {LENGTH_LABELS[len]}
                      </button>
                    ))}
                  </div>

                  <button
                    onClick={generateSuggestions}
                    disabled={generating}
                    className="btn btn-gold"
                    style={{ marginTop: 14, fontSize: 11 }}
                  >
                    {generating ? 'Generating…' : 'Generate 5 options'}
                  </button>

                  {aiError && (
                    <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--error)', marginTop: 8 }}>
                      {aiError}
                    </p>
                  )}

                  {/* Suggestions */}
                  {suggestions.length > 0 && (
                    <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {suggestions.map((reply, i) => (
                        <div key={i} style={s.suggestionCard}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                            <div style={{ flex: 1 }}>
                              <span style={s.suggestionNum}>{i + 1}</span>
                              <p style={s.suggestionText}>{reply}</p>
                              <span style={s.charHint}>{reply.length} chars</span>
                            </div>
                            <button
                              onClick={() => { setReplyText(reply); setShowAI(false) }}
                              className="btn btn-gold"
                              style={{ fontSize: 10, padding: '5px 14px', flexShrink: 0 }}
                            >
                              Use this
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <textarea
                placeholder="Write your reply…"
                value={replyText}
                onChange={e => setReplyText(e.target.value)}
                rows={5}
                style={{ ...s.textarea, marginTop: showAI ? 12 : 0 }}
              />
              <p style={s.charCount}>{replyText.length} characters</p>

              <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                <button onClick={() => router.back()} className="btn btn-ghost" style={{ fontSize: 11 }}>
                  Cancel
                </button>
                <button
                  onClick={postReply}
                  disabled={!replyText.trim() || sending}
                  className="btn btn-gold"
                  style={{ fontSize: 11 }}
                >
                  {sending ? 'Posting…' : 'Post Reply'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function NavBrand({ loc }: { loc: string }) {
  return (
    <>
      <Link href="/" style={s.navBrand}>
        <span style={s.navIcon}>◈</span>
        <span style={s.navName}>Co.Media</span>
      </Link>
      <span style={s.navSep}>/</span>
      <Link href="/gmb" style={s.navLink}>Review Reply</Link>
      <span style={s.navSep}>/</span>
      <Link
        href={loc ? `/gmb/dashboard?loc=${encodeURIComponent(loc)}` : '/gmb/dashboard'}
        style={s.navLink}
      >
        Dashboard
      </Link>
      <span style={s.navSep}>/</span>
      <span style={s.navCrumb}>Review</span>
    </>
  )
}

export default function ReviewPage() {
  return (
    <Suspense fallback={
      <div style={s.page}>
        <div style={s.glow} />
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
          <div style={s.spinner} />
        </div>
      </div>
    }>
      <ReviewPageInner />
    </Suspense>
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

  content: { maxWidth: 700, margin: '0 auto', padding: '36px 24px', position: 'relative', zIndex: 1 },

  reviewCard:   { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '24px', marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.04)' },
  reviewHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
  reviewAuthorWrap: { display: 'flex', alignItems: 'center', gap: 12 },
  reviewAvatar: { width: 40, height: 40, borderRadius: '50%', background: 'var(--orange)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, color: '#fff', flexShrink: 0 },
  reviewAuthor: { fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 600, color: 'var(--text)', margin: 0 },
  reviewTime:   { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', margin: 0, marginTop: 2 },
  reviewComment:{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.7, margin: 0 },
  badge:        { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '3px 8px', borderRadius: 4, border: '1px solid' },
  badgeReplied: { color: 'var(--success)', borderColor: 'var(--success)', background: 'rgba(34,197,94,0.08)' },
  badgePending: { color: '#f59e0b', borderColor: '#f59e0b', background: 'rgba(245,158,11,0.08)' },

  replyCard:    { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '24px', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' },
  sectionLabel: { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 16 },
  existingReplyText: { fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7, margin: 0, borderLeft: '3px solid var(--orange)', paddingLeft: 14 },

  aiPanel:      { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 16, marginBottom: 14 },
  aiPanelLabel: { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--orange)', marginBottom: 12 },
  fieldLabel:   { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6, display: 'block' },

  select:   { flex: 1, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 12, outline: 'none', cursor: 'pointer' },
  overrideHint: { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 12, padding: '7px 10px', background: 'rgba(242,56,1,0.05)', border: '1px solid rgba(242,56,1,0.15)', borderRadius: 5 },

  textarea:     { width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.6, outline: 'none', resize: 'vertical', boxSizing: 'border-box' as const },
  input:        { width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 12, outline: 'none', boxSizing: 'border-box' as const },
  lengthGroup:  { display: 'flex', flexDirection: 'column', gap: 5 },
  lengthBtn:    { textAlign: 'left', padding: '7px 12px', fontFamily: 'var(--font-mono)', fontSize: 10, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 5, cursor: 'pointer', color: 'var(--text-muted)', transition: 'all 0.15s' },
  lengthBtnActive: { background: 'rgba(242,56,1,0.07)', borderColor: 'var(--orange)', color: 'var(--orange)' },

  suggestionCard: { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' },
  suggestionNum:  { fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', display: 'block', marginBottom: 4 },
  suggestionText: { fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--text)', lineHeight: 1.65, margin: 0 },
  charHint:       { fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', display: 'block', marginTop: 6 },

  charCount:    { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', marginTop: 4, textAlign: 'right' },
  errorBanner:  { background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--error)', marginBottom: 16 },
  successBanner:{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 8, padding: '14px 16px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--success)', display: 'flex', alignItems: 'center' },
  spinner:  { width: 18, height: 18, border: '2px solid var(--border)', borderTopColor: 'var(--orange)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' },
  loadText: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' },
}
