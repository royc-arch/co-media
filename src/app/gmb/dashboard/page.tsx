'use client'

import { useEffect, useState, useMemo, useRef, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
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
  hasPhoto?:    boolean
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
}

interface BulkReviewItem {
  review:  Review
  reply:   string
  error:   string | null
  posted:  boolean
  skipped: boolean
}

type BulkPhase = 'idle' | 'generating' | 'confirm' | 'posting' | 'done'
type TimeFilter  = '1m' | '3m' | '6m' | 'all'
type CountLimit  = 50 | 100 | 'all'

function starStr(n: number) { return '★'.repeat(n) + '☆'.repeat(5 - n) }



/** Parse "name||stars||[min_stars||]styleText" (handles both 3-part and 4-part formats). */
function parsePromptHints(raw: string | null): { label: string | null; style: string } {
  if (!raw) return { label: null, style: '' }
  const parts = raw.split('||')
  if (parts.length >= 4 && !isNaN(parseInt(parts[2]))) {
    const n    = parseInt(parts[1]) || 5
    const star = '★'.repeat(n) + '☆'.repeat(5 - n)
    return { label: `${parts[0]} ${star}`, style: parts.slice(3).join('||') }
  }
  if (parts.length >= 3) {
    const n    = parseInt(parts[1]) || 5
    const star = '★'.repeat(n) + '☆'.repeat(5 - n)
    return { label: `${parts[0]} ${star}`, style: parts.slice(2).join('||') }
  }
  return { label: null, style: raw }
}
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

// Wrap the search-param-reading component in Suspense so the production
// build doesn't fail with the useSearchParams prerender error (Next 16).
export default function GmbDashboardPage() {
  return (
    <Suspense fallback={null}>
      <GmbDashboardInner />
    </Suspense>
  )
}

function GmbDashboardInner() {
  const searchParams = useSearchParams()
  const router       = useRouter()
  const initLoc      = searchParams.get('loc') ?? ''

  const [locations,      setLocations]      = useState<LocationSetting[]>([])
  const [activeLoc,      setActiveLoc]      = useState(initLoc)
  const [settings,       setSettings]       = useState<LocationSetting | null>(null)
  const [reviews,        setReviews]        = useState<Review[]>([])
  const [totalReviews,   setTotalReviews]   = useState(0)
  const [repliedCount,   setRepliedCount]   = useState(0)
  const [unrepliedCount, setUnrepliedCount] = useState(0)
  const [removedCount,   setRemovedCount]   = useState(0)

  // ── List filters ────────────────────────────────────────────────────────────
  type ActiveFilter = 'all' | 'unreplied' | 'replied' | 'removed'
  const [activeFilter,   setActiveFilter]   = useState<ActiveFilter>('all')
  const [listTimeFilter, setListTimeFilter] = useState<TimeFilter>('all')
  // Star filter stored as bitmask: bit 0 = 1★, bit 4 = 5★  (0b11111 = all)
  const [listStarMask,      setListStarMask]      = useState<number>(0b11111)
  const [showStarDropdown,  setShowStarDropdown]  = useState(false)
  const [showTimeDropdown,  setShowTimeDropdown]  = useState(false)
  const starDropdownRef = useRef<HTMLDivElement>(null)
  const timeDropdownRef = useRef<HTMLDivElement>(null)
  const [hasMore,        setHasMore]        = useState(false)
  const [page,           setPage]           = useState(0)
  const [loadingLocs,    setLoadingLocs]    = useState(true)
  const [loadingRevs,    setLoadingRevs]    = useState(false)
  const [loadingMore,    setLoadingMore]    = useState(false)
  const [syncing,        setSyncing]        = useState(false)
  const [savingSettings,    setSavingSettings]    = useState(false)
  const [styles,            setStyles]            = useState<GmbStyle[]>([])
  const [settingStyleActive,setSettingStyleActive]= useState(false)
  const [error,             setError]             = useState('')

  // Bulk reply modal
  const [showBulkModal,    setShowBulkModal]    = useState(false)
  const [bulkTimeFilter,   setBulkTimeFilter]   = useState<TimeFilter>('1m')
  const [bulkCountLimit,   setBulkCountLimit]   = useState<CountLimit>(50)
  const [bulkStyleId,        setBulkStyleId]        = useState<string>('__none__')
  const [bulkStarFilter,     setBulkStarFilter]     = useState<Set<number>>(new Set([1,2,3,4,5]))
  const [bulkSkipNoComment,  setBulkSkipNoComment]  = useState(true)
  const [bulkItems,        setBulkItems]        = useState<BulkReviewItem[]>([])
  const [bulkPhase,        setBulkPhase]        = useState<BulkPhase>('idle')
  const [bulkGenProgress,  setBulkGenProgress]  = useState(0)
  const [bulkPostProgress, setBulkPostProgress] = useState(0)
  const [bulkError,        setBulkError]        = useState('')

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

  // ── Close star dropdown on outside click ──────────────────────────────────

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (starDropdownRef.current && !starDropdownRef.current.contains(e.target as Node)) {
        setShowStarDropdown(false)
      }
      if (timeDropdownRef.current && !timeDropdownRef.current.contains(e.target as Node)) {
        setShowTimeDropdown(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [])

  // ── Styles (reload only when location changes) ────────────────────────────

  useEffect(() => {
    if (!activeLoc) return
    fetch('/api/gmb/styles')
      .then(r => r.json())
      .then(d => setStyles(d.styles ?? []))
      .catch(() => {})
  }, [activeLoc])

  // ── Build list query string from all active filters ───────────────────────

  const buildListQS = useMemo(() => (pg: number): string => {
    const parts: string[] = [`locationName=${encodeURIComponent(activeLoc)}&page=${pg}`]
    if (activeFilter === 'removed')   parts.push('removed=true')
    else if (activeFilter === 'replied')   parts.push('replied=true')
    else if (activeFilter === 'unreplied') parts.push('replied=false')
    const since = getSinceDate(listTimeFilter)
    if (since) parts.push(`since=${encodeURIComponent(since)}`)
    if (listStarMask !== 0b11111) {
      const names = ['ONE','TWO','THREE','FOUR','FIVE'].filter((_,i) => ((listStarMask >> i) & 1) === 1)
      if (names.length > 0) parts.push(`stars=${names.join(',')}`)
    }
    return parts.join('&')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLoc, activeFilter, listTimeFilter, listStarMask])

  // ── Load reviews (page 0) when location or filters change ────────────────

  useEffect(() => {
    if (!activeLoc) return
    const loc = locations.find(l => l.location_name === activeLoc)
    if (loc) setSettings({ ...loc })

    setLoadingRevs(true)
    setError('')
    setReviews([])
    setPage(0)
    setHasMore(false)

    fetch(`/api/gmb/reviews?${buildListQS(0)}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) { setError(`Reviews API error: ${d.error}`); return }
        setReviews(d.reviews ?? [])
        setRepliedCount(d.repliedCount ?? 0)
        setUnrepliedCount(d.unrepliedCount ?? 0)
        setTotalReviews((d.repliedCount ?? 0) + (d.unrepliedCount ?? 0))
        setRemovedCount(d.removedCount ?? 0)
        setHasMore(d.hasMore ?? false)
      })
      .catch(() => setError('Failed to load reviews.'))
      .finally(() => setLoadingRevs(false))
  }, [activeLoc, locations, buildListQS])

  // ── Load more (next page) ──────────────────────────────────────────────────

  async function loadMore() {
    const nextPage = page + 1
    setLoadingMore(true)
    try {
      const res = await fetch(`/api/gmb/reviews?${buildListQS(nextPage)}`)
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
      setRepliedCount(fd.repliedCount ?? 0)
      setUnrepliedCount(fd.unrepliedCount ?? 0)
      setTotalReviews((fd.repliedCount ?? 0) + (fd.unrepliedCount ?? 0))
      setRemovedCount(fd.removedCount ?? 0)
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

  // ── Set active style ───────────────────────────────────────────────────────

  async function setActiveStyle(styleId: string) {
    if (styleId === '__none__') {
      setSettings(p => p ? { ...p, prompt_hints: null } : p)
      return
    }
    if (styleId === '__create__') { router.push('/gmb/train?loc=' + encodeURIComponent(activeLoc)); return }
    setSettingStyleActive(true)
    try {
      const res = await fetch('/api/gmb/styles', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id: styleId, locationName: activeLoc }),
      })
      const d = await res.json() as { hints?: string }
      if (d.hints) setSettings(p => p ? { ...p, prompt_hints: d.hints ?? null } : p)
    } finally {
      setSettingStyleActive(false)
    }
  }

  // ── Bulk reply helpers ────────────────────────────────────────────────────

  function getSinceDate(filter: TimeFilter): string | null {
    const now = new Date()
    if (filter === '1m') { now.setMonth(now.getMonth() - 1);  return now.toISOString() }
    if (filter === '3m') { now.setMonth(now.getMonth() - 3);  return now.toISOString() }
    if (filter === '6m') { now.setMonth(now.getMonth() - 6);  return now.toISOString() }
    return null
  }

  function getApplicableHints(reviewStars: number): string {
    const activeHints = settings?.prompt_hints ?? null
    if (activeHints) {
      const parts = activeHints.split('||')
      if (parts.length >= 4 && !isNaN(parseInt(parts[2]))) {
        const mask = parseInt(parts[2])
        if (((mask >> (reviewStars - 1)) & 1) === 1) return activeHints
      } else if (parts.length >= 3) {
        if ((parseInt(parts[1]) || 5) === reviewStars) return activeHints
      }
    }
    const match = styles.find(st => {
      const mask = st.apply_mask ?? (1 << (st.stars - 1))
      return ((mask >> (reviewStars - 1)) & 1) === 1
    })
    if (match) {
      const mask = match.apply_mask ?? (1 << (match.stars - 1))
      return `${match.name}||${match.stars}||${mask}||${match.style_text}`
    }
    return ''
  }

  /** When user picks a style in the bulk modal, auto-set the star filter to match its apply_mask. */
  function selectBulkStyle(id: string) {
    setBulkStyleId(id)
    if (id === '__none__') { setBulkStarFilter(new Set([1,2,3,4,5])); return }
    const st = styles.find(s => s.id === id)
    if (!st) return
    const mask = st.apply_mask ?? (1 << (st.stars - 1))
    const stars = new Set<number>([1,2,3,4,5].filter(n => ((mask >> (n - 1)) & 1) === 1))
    setBulkStarFilter(stars)
  }

  /** Get style hints for a specific review star count in bulk mode. */
  function getBulkHints(reviewStars: number): string {
    if (bulkStyleId === '__none__') return ''
    const st = styles.find(s => s.id === bulkStyleId)
    if (!st) return ''
    const mask = st.apply_mask ?? (1 << (st.stars - 1))
    if (((mask >> (reviewStars - 1)) & 1) === 0) return ''
    return `${st.name}||${st.stars}||${mask}||${st.style_text}`
  }

  function closeBulkModal() {
    if (bulkPhase === 'posting') return
    setShowBulkModal(false)
    setBulkPhase('idle')
    setBulkItems([])
    setBulkGenProgress(0)
    setBulkPostProgress(0)
    setBulkError('')
    setBulkStyleId('__none__')
    setBulkStarFilter(new Set([1,2,3,4,5]))
    setBulkSkipNoComment(true)
  }

  function updateBulkReply(index: number, text: string) {
    setBulkItems(prev => prev.map((it, i) => i === index ? { ...it, reply: text } : it))
  }

  async function fetchAndGenerate() {
    if (!activeLoc) return
    setBulkPhase('generating')
    setBulkGenProgress(0)
    setBulkItems([])
    setBulkError('')
    try {
      const since = getSinceDate(bulkTimeFilter)
      const qs    = `locationName=${encodeURIComponent(activeLoc)}&unreplied=true${since ? `&since=${encodeURIComponent(since)}` : ''}`
      const res   = await fetch(`/api/gmb/reviews?${qs}`)
      const d     = await res.json() as { reviews?: Review[]; error?: string }
      if (d.error) { setBulkError(d.error); setBulkPhase('idle'); return }
      const allUnreplied     = d.reviews ?? []
      // Filter by selected star ratings, optionally skip no-comment, then apply count limit
      const starFiltered     = allUnreplied.filter(r => bulkStarFilter.has(STAR_MAP[r.starRating] ?? 5))
      const commentFiltered  = bulkSkipNoComment ? starFiltered.filter(r => r.comment?.trim()) : starFiltered
      const unrepliedReviews = bulkCountLimit === 'all' ? commentFiltered : commentFiltered.slice(0, bulkCountLimit)
      if (unrepliedReviews.length === 0) { setBulkItems([]); setBulkPhase('confirm'); return }
      const results: BulkReviewItem[] = []
      for (let i = 0; i < unrepliedReviews.length; i++) {
        const review = unrepliedReviews[i]
        const stars  = STAR_MAP[review.starRating] ?? 5
        const hints  = getBulkHints(stars) || getApplicableHints(stars)
        try {
          const r  = await fetch('/api/gmb/suggest-reply', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              reviewText:         review.comment ?? '',
              reviewAuthor:       review.reviewer?.displayName ?? 'Customer',
              starRating:         review.starRating,
              keywords:           (() => {
                const st = bulkStyleId !== '__none__' ? styles.find(s => s.id === bulkStyleId) : null
                return st?.keywords ? st.keywords.split(',').map(k => k.trim()).filter(Boolean) : []
              })(),
              length:             'recommended',
              context:            (() => {
                const st = bulkStyleId !== '__none__' ? styles.find(s => s.id === bulkStyleId) : null
                return st?.context ?? ''
              })(),
              customInstructions: settings?.custom_instructions ?? '',
              promptHints:        hints,
              locationName:       activeLoc,
              hasPhoto:           review.hasPhoto ?? false,
            }),
          })
          const rd = await r.json() as { replies?: string[]; error?: string }
          results.push({ review, reply: rd.replies?.[0] ?? '', error: rd.error ?? null, posted: false, skipped: false })
        } catch {
          results.push({ review, reply: '', error: 'Network error', posted: false, skipped: false })
        }
        setBulkGenProgress(i + 1)
        setBulkItems([...results])
      }
      setBulkPhase('confirm')
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : 'Failed to fetch reviews')
      setBulkPhase('idle')
    }
  }

  async function postAllReplies() {
    const toPost = bulkItems.filter(it => it.reply.trim() && !it.error)
    if (toPost.length === 0) return
    setBulkPhase('posting')
    setBulkPostProgress(0)
    const updated = [...bulkItems]
    let count = 0
    for (let i = 0; i < updated.length; i++) {
      const item = updated[i]
      if (!item.reply.trim() || item.error) continue
      try {
        const res = await fetch('/api/gmb/reply', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reviewName: item.review.name, comment: item.reply }),
        })
        const rd = await res.json() as { ok?: boolean; error?: string; skipped?: boolean }
        updated[i] = { ...item, posted: !!rd.ok, skipped: !!rd.skipped, error: rd.skipped ? null : (rd.error ?? null) }
      } catch {
        updated[i] = { ...item, error: 'Network error' }
      }
      count++
      setBulkPostProgress(count)
      setBulkItems([...updated])
    }
    setBulkPhase('done')
    // Update stats counts based on what was actually posted / skipped
    const postedCount  = updated.filter(it => it.posted).length
    const skippedCount = updated.filter(it => it.skipped).length
    if (postedCount > 0) {
      setUnrepliedCount(prev => Math.max(0, prev - postedCount))
      setRepliedCount(prev => prev + postedCount)
    }
    if (skippedCount > 0) {
      setUnrepliedCount(prev => Math.max(0, prev - skippedCount))
      setRemovedCount(prev => prev + skippedCount)
    }
    // Refresh local review list to show replied badges
    setReviews(prev => prev.map(r => {
      const posted = updated.find(it => it.review.name === r.name && it.posted)
      return posted ? { ...r, reviewReply: { comment: posted.reply } } : r
    }))
  }

  // unrepliedCount and repliedCount come from DB (set by the API), not derived from loaded page

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

              <p style={s.settingLabel}>Custom Instructions</p>
              <textarea
                placeholder="e.g. Always mention our loyalty program…"
                value={settings.custom_instructions ?? ''}
                onChange={e => setSettings(p => p ? { ...p, custom_instructions: e.target.value } : p)}
                style={s.textarea}
                rows={3}
              />

              {/* Reply style selector */}
              <p style={s.settingLabel}>Reply Style</p>
              {styles.length === 0 ? (
                <button
                  onClick={() => router.push('/gmb/train?loc=' + encodeURIComponent(activeLoc))}
                  style={s.createStyleBtn}
                >
                  + Create your first AI Reply Style
                </button>
              ) : (() => {
                const activeHints = settings.prompt_hints
                const activeParts = activeHints?.split('||')
                const activeId    = styles.find(st =>
                  activeHints?.startsWith(`${st.name}||${st.stars}||`)
                )?.id ?? '__none__'

                return (
                  <div>
                    <select
                      value={settingStyleActive ? '' : activeId}
                      onChange={e => setActiveStyle(e.target.value)}
                      disabled={settingStyleActive}
                      style={{ ...s.select, opacity: settingStyleActive ? 0.6 : 1 }}
                    >
                      <option value="__none__">No style</option>
                      {styles.map(st => (
                        <option key={st.id} value={st.id}>
                          {st.name} {starStr(st.stars)}
                          {st.override_text ? ' · campaign' : ''}
                        </option>
                      ))}
                      <option disabled>──────────</option>
                      <option value="__create__">Create A New Style</option>
                    </select>

                    {/* Show active style label + override hint */}
                    {activeHints && activeParts && activeParts.length >= 3 && (
                      <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={s.learnedText}>
                          {activeParts[0]} {starStr(parseInt(activeParts[1]) || 5)}
                          {styles.find(st => st.id === activeId)?.override_text
                            ? <span style={{ color: 'var(--orange)', marginLeft: 4 }}>· campaign</span>
                            : null}
                        </span>
                        <button
                          onClick={() => setSettings(p => p ? { ...p, prompt_hints: null } : p)}
                          style={s.clearBtn}
                        >
                          Clear
                        </button>
                      </div>
                    )}

                  </div>
                )
              })()}

              <Link
                href={`/gmb/train`}
                style={s.manageStylesLink}
              >
                Manage styles →
              </Link>

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

          {/* Stats + sync */}
          <div style={s.statsRow}>
            <div style={s.stats}>
              <div
                style={{ ...s.statCard, cursor: 'pointer', ...(activeFilter === 'all' ? s.statCardActive : {}) }}
                onClick={() => setActiveFilter('all')}
              >
                <span style={s.statNum}>{totalReviews}</span>
                <span style={s.statLabel}>Total Reviews</span>
              </div>
              <div
                style={{ ...s.statCard, cursor: 'pointer', ...(activeFilter === 'unreplied' ? s.statCardActive : {}) }}
                onClick={() => setActiveFilter('unreplied')}
              >
                <span style={{ ...s.statNum, color: 'var(--error)' }}>{unrepliedCount}</span>
                <span style={s.statLabel}>Awaiting Reply</span>
              </div>
              <div
                style={{ ...s.statCard, cursor: 'pointer', ...(activeFilter === 'replied' ? s.statCardActive : {}) }}
                onClick={() => setActiveFilter('replied')}
              >
                <span style={{ ...s.statNum, color: 'var(--success)' }}>{repliedCount}</span>
                <span style={s.statLabel}>Replied</span>
              </div>
              {removedCount > 0 && (
                <div
                  style={{ ...s.statCard, cursor: 'pointer', ...(activeFilter === 'removed' ? s.statCardActive : {}) }}
                  onClick={() => setActiveFilter('removed')}
                >
                  <span style={{ ...s.statNum, color: 'var(--text-muted)' }}>{removedCount}</span>
                  <span style={s.statLabel}>Removed from Google</span>
                </div>
              )}
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

          {/* Filter bar */}
          <div style={s.listFilterBar}>
            {/* Time dropdown */}
            <div style={{ position: 'relative' }} ref={timeDropdownRef}>
              <button
                onClick={() => setShowTimeDropdown(p => !p)}
                style={{ ...s.listFilterSelect, cursor: 'pointer', background: listTimeFilter !== 'all' ? 'rgba(242,56,1,0.06)' : undefined, borderColor: listTimeFilter !== 'all' ? 'var(--orange)' : undefined, color: listTimeFilter !== 'all' ? 'var(--orange)' : undefined }}
              >
                {listTimeFilter === 'all' ? 'All time' : listTimeFilter === '1m' ? 'Last month' : listTimeFilter === '3m' ? 'Last 3 months' : 'Last 6 months'} ▾
              </button>
              {showTimeDropdown && (
                <div style={s.starDropdown}>
                  {([['all','All time'],['1m','Last month'],['3m','Last 3 months'],['6m','Last 6 months']] as const).map(([val, label]) => (
                    <div
                      key={val}
                      onClick={() => { setListTimeFilter(val); setShowTimeDropdown(false) }}
                      style={{ ...s.starDropdownItem, fontWeight: listTimeFilter === val ? 600 : 400, color: listTimeFilter === val ? 'var(--orange)' : 'var(--text)' }}
                    >
                      {label}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Star dropdown */}
            <div style={{ position: 'relative' }} ref={starDropdownRef}>
              <button
                onClick={() => setShowStarDropdown(p => !p)}
                style={{ ...s.listFilterSelect, cursor: 'pointer', background: listStarMask !== 0b11111 ? 'rgba(242,56,1,0.06)' : undefined, borderColor: listStarMask !== 0b11111 ? 'var(--orange)' : undefined, color: listStarMask !== 0b11111 ? 'var(--orange)' : undefined }}
              >
                {listStarMask === 0b11111
                  ? 'All stars ▾'
                  : listStarMask === 0
                    ? 'No stars ▾'
                    : [1,2,3,4,5].filter(n => ((listStarMask >> (n-1)) & 1) === 1).map(n => '★'.repeat(n)).join('  ') + ' ▾'
                }
              </button>
              {showStarDropdown && (
                <div style={s.starDropdown}>
                  {[5,4,3,2,1].map(n => {
                    const on = ((listStarMask >> (n - 1)) & 1) === 1
                    return (
                      <label key={n} style={s.starDropdownItem}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => setListStarMask(prev => prev ^ (1 << (n - 1)))}
                          style={{ margin: 0, accentColor: 'var(--orange)', cursor: 'pointer' }}
                        />
                        <span>{'★'.repeat(n)}</span>
                      </label>
                    )
                  })}
                  <div style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6, display: 'flex', gap: 6 }}>
                    <button onClick={() => setListStarMask(0b11111)} style={s.starDropdownAction}>All</button>
                    <button onClick={() => setListStarMask(0)}       style={s.starDropdownAction}>None</button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Bulk reply banner */}
          {unrepliedCount > 0 && (
            <div style={s.bulkBanner}>
              <div>
                <p style={s.bulkBannerTitle}>
                  {unrepliedCount} review{unrepliedCount !== 1 ? 's' : ''} awaiting reply
                </p>
                <p style={s.bulkBannerDesc}>
                  Generate and post AI replies to all unanswered reviews in one click.
                </p>
              </div>
              <button
                onClick={() => setShowBulkModal(true)}
                className="btn btn-gold"
                style={{ fontSize: 12, padding: '12px 26px', flexShrink: 0, whiteSpace: 'nowrap' }}
              >
                ⚡ Reply All Unanswered →
              </button>
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
            <>
            <div style={s.reviewsList}>
              {reviews.map(review => (
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

                  {/* Comment preview */}
                  {review.comment && (
                    <p style={{ ...s.reviewComment, WebkitLineClamp: 3, display: '-webkit-box', WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {review.comment}
                    </p>
                  )}

                  {/* Action */}
                  <div style={s.replySection}>
                    <Link
                      href={`/gmb/review?name=${encodeURIComponent(review.name)}`}
                      className="btn btn-ghost"
                      style={{ fontSize: 11, padding: '7px 16px', textDecoration: 'none', display: 'inline-block' }}
                    >
                      {review.reviewReply ? 'View Reply' : 'Write Reply'}
                    </Link>
                  </div>
                </div>
              ))}
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

      {/* ── Bulk Reply Modal ──────────────────────────────────────────────── */}
      {showBulkModal && (
        <div style={s.modalOverlay} onClick={e => { if (e.target === e.currentTarget) closeBulkModal() }}>
          <div style={s.modal}>

            {/* Modal header */}
            <div style={s.modalHeader}>
              <div>
                <p style={s.modalEyebrow}>Auto Reply</p>
                <h2 style={s.modalTitle}>Reply All Unanswered Reviews</h2>
              </div>
              {bulkPhase !== 'posting' && (
                <button onClick={closeBulkModal} style={s.modalClose}>✕</button>
              )}
            </div>

            {/* ── Phase: idle — pick time filter + count limit ── */}
            {bulkPhase === 'idle' && (
              <div style={s.modalBody}>
                <p style={s.modalSectionLabel}>Time range</p>
                <div style={s.filterGroup}>
                  {(['1m','3m','6m','all'] as TimeFilter[]).map(f => (
                    <button
                      key={f}
                      onClick={() => setBulkTimeFilter(f)}
                      style={{ ...s.filterBtn, ...(bulkTimeFilter === f ? s.filterBtnActive : {}) }}
                    >
                      {{ '1m': '1 Month', '3m': '3 Months', '6m': '6 Months', all: 'All time' }[f]}
                    </button>
                  ))}
                </div>
                <p style={{ ...s.modalSectionLabel, marginTop: 20 }}>Max reviews</p>
                <div style={s.filterGroup}>
                  {([50, 100, 'all'] as CountLimit[]).map(c => (
                    <button
                      key={String(c)}
                      onClick={() => setBulkCountLimit(c)}
                      style={{ ...s.filterBtn, ...(bulkCountLimit === c ? s.filterBtnActive : {}) }}
                    >
                      {c === 'all' ? 'All' : `Latest ${c}`}
                    </button>
                  ))}
                </div>

                <p style={{ ...s.modalSectionLabel, marginTop: 20 }}>Reply style</p>
                <select
                  value={bulkStyleId}
                  onChange={e => selectBulkStyle(e.target.value)}
                  style={{ ...s.select, width: '100%' }}
                >
                  <option value="__none__">No style</option>
                  {styles.map(st => (
                    <option key={st.id} value={st.id}>
                      {st.name} {starStr(st.stars)}
                    </option>
                  ))}
                </select>

                <p style={{ ...s.modalSectionLabel, marginTop: 20 }}>Star ratings to reply</p>
                <div style={s.filterGroup}>
                  {[5,4,3,2,1].map(n => (
                    <button
                      key={n}
                      onClick={() => setBulkStarFilter(prev => {
                        const next = new Set(prev)
                        next.has(n) ? next.delete(n) : next.add(n)
                        return next
                      })}
                      style={{ ...s.filterBtn, ...(bulkStarFilter.has(n) ? s.filterBtnActive : {}) }}
                    >
                      {'★'.repeat(n)}
                    </button>
                  ))}
                </div>

                <div
                  onClick={() => setBulkSkipNoComment(p => !p)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 20, cursor: 'pointer', userSelect: 'none' as const }}
                >
                  <div style={{ width: 36, height: 20, borderRadius: 10, background: bulkSkipNoComment ? 'var(--orange)' : 'var(--border)', position: 'relative' as const, transition: 'background 0.15s', flexShrink: 0 }}>
                    <span style={{ position: 'absolute' as const, top: 2, left: bulkSkipNoComment ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.15s', display: 'block' }} />
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
                    Skip reviews with no comment (rating only)
                  </span>
                </div>

                {bulkError && <p style={s.modalError}>⚠ {bulkError}</p>}
                <button
                  onClick={fetchAndGenerate}
                  className="btn btn-gold"
                  style={{ marginTop: 28, fontSize: 13, padding: '13px 32px', width: '100%' }}
                >
                  Fetch & Generate Replies →
                </button>
              </div>
            )}

            {/* ── Phase: generating ── */}
            {bulkPhase === 'generating' && (
              <div style={s.modalBody}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <p style={s.modalSectionLabel}>Generating replies…</p>
                  <span style={s.bulkProgressCount}>{bulkGenProgress} / {bulkItems.length > 0 ? bulkItems.length : '?'}</span>
                </div>
                {bulkItems.length > 0 && (
                  <div style={s.bulkProgressTrack}>
                    <div style={{ ...s.bulkProgressFill, width: `${(bulkGenProgress / (bulkItems.length || 1)) * 100}%` }} />
                  </div>
                )}
                {/* Live preview of generated items */}
                {bulkItems.length > 0 && (
                  <div style={{ ...s.bulkItemsList, marginTop: 20 }}>
                    {bulkItems.slice(-3).map((item, i) => (
                      <div key={i} style={s.bulkItemCard}>
                        <div style={s.bulkItemMeta}>
                          <span style={s.bulkItemAvatar}>{(item.review.reviewer?.displayName?.[0] ?? '?').toUpperCase()}</span>
                          <span style={s.bulkItemName}>{item.review.reviewer?.displayName ?? 'Anonymous'}</span>
                          <StarRating rating={item.review.starRating} />
                        </div>
                        {item.reply && <p style={s.bulkItemReplyPreview}>{item.reply.slice(0, 120)}…</p>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── Phase: confirm ── */}
            {bulkPhase === 'confirm' && (
              <div style={s.modalBody}>
                {bulkItems.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '40px 0' }}>
                    <p style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>
                      No unanswered reviews found
                    </p>
                    <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>
                      Try a wider time range or sync from Google first.
                    </p>
                    <button
                      onClick={() => setBulkPhase('idle')}
                      className="btn btn-ghost"
                      style={{ marginTop: 20, fontSize: 11 }}
                    >
                      ← Back
                    </button>
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                      <p style={s.modalSectionLabel}>
                        {bulkItems.length} repl{bulkItems.length !== 1 ? 'ies' : 'y'} ready — review and edit before posting
                      </p>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          onClick={() => setBulkPhase('idle')}
                          className="btn btn-ghost"
                          style={{ fontSize: 10, padding: '7px 14px' }}
                        >
                          ← Change range
                        </button>
                        <button
                          onClick={postAllReplies}
                          className="btn btn-gold"
                          style={{ fontSize: 12, padding: '9px 22px' }}
                        >
                          Post {bulkItems.filter(it => it.reply.trim() && !it.error).length} Repl{bulkItems.length !== 1 ? 'ies' : 'y'} →
                        </button>
                      </div>
                    </div>
                    <div style={s.bulkItemsList}>
                      {bulkItems.map((item, i) => (
                        <div key={i} style={s.bulkConfirmCard}>
                          {/* Review info */}
                          <div style={s.bulkConfirmMeta}>
                            <span style={s.bulkItemAvatar}>{(item.review.reviewer?.displayName?.[0] ?? '?').toUpperCase()}</span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                                <span style={s.bulkItemName}>{item.review.reviewer?.displayName ?? 'Anonymous'}</span>
                                <StarRating rating={item.review.starRating} />
                                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' }}>
                                  {timeAgo(item.review.createTime)}
                                </span>
                              </div>
                              {item.review.comment && (
                                <p style={s.bulkConfirmReview}>
                                  {item.review.comment.slice(0, 120)}{item.review.comment.length > 120 ? '…' : ''}
                                </p>
                              )}
                            </div>
                          </div>
                          {/* Editable reply */}
                          {item.error ? (
                            <p style={s.modalError}>⚠ {item.error}</p>
                          ) : (
                            <textarea
                              value={item.reply}
                              onChange={e => updateBulkReply(i, e.target.value)}
                              style={s.bulkReplyTextarea}
                              rows={3}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                      <button
                        onClick={postAllReplies}
                        className="btn btn-gold"
                        style={{ fontSize: 13, padding: '12px 32px' }}
                      >
                        Post {bulkItems.filter(it => it.reply.trim() && !it.error).length} Repl{bulkItems.length !== 1 ? 'ies' : 'y'} →
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ── Phase: posting ── */}
            {bulkPhase === 'posting' && (
              <div style={s.modalBody}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <p style={s.modalSectionLabel}>Posting replies to Google…</p>
                  <span style={s.bulkProgressCount}>{bulkPostProgress} / {bulkItems.filter(it => it.reply.trim() && !it.error).length}</span>
                </div>
                <div style={s.bulkProgressTrack}>
                  <div style={{
                    ...s.bulkProgressFill,
                    width: `${(bulkPostProgress / Math.max(1, bulkItems.filter(it => it.reply.trim()).length)) * 100}%`
                  }} />
                </div>
                <div style={{ ...s.bulkItemsList, marginTop: 20 }}>
                  {bulkItems.map((item, i) => (
                    <div key={i} style={{ ...s.bulkItemCard, opacity: item.posted || item.error ? 1 : 0.5 }}>
                      <div style={s.bulkItemMeta}>
                        <span style={s.bulkItemAvatar}>{(item.review.reviewer?.displayName?.[0] ?? '?').toUpperCase()}</span>
                        <span style={s.bulkItemName}>{item.review.reviewer?.displayName ?? 'Anonymous'}</span>
                        <StarRating rating={item.review.starRating} />
                        {item.posted && (
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--success)', marginLeft: 'auto' }}>✓ Posted</span>
                        )}
                        {item.skipped && (
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', marginLeft: 'auto' }}>— Skipped (deleted on Google)</span>
                        )}
                        {item.error && (
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--error)', marginLeft: 'auto' }}>✗ {item.error}</span>
                        )}
                        {!item.posted && !item.skipped && !item.error && (
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', marginLeft: 'auto' }}>Pending…</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Phase: done ── */}
            {bulkPhase === 'done' && (() => {
              const successCount = bulkItems.filter(it => it.posted).length
              const skipCount    = bulkItems.filter(it => it.skipped).length
              const failCount    = bulkItems.filter(it => it.error).length
              return (
                <div style={{ ...s.modalBody, textAlign: 'center', paddingTop: 32, paddingBottom: 40 }}>
                  <div style={{ fontSize: 44, marginBottom: 16, lineHeight: 1 }}>✓</div>
                  <p style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>
                    {successCount} repl{successCount !== 1 ? 'ies' : 'y'} posted
                  </p>
                  {skipCount > 0 && (
                    <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                      {skipCount} skipped — review{skipCount !== 1 ? 's were' : ' was'} deleted on Google
                    </p>
                  )}
                  {failCount > 0 && (
                    <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--error)', marginBottom: 12 }}>
                      {failCount} failed — check individual errors above
                    </p>
                  )}
                  <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', marginBottom: 28 }}>
                    Replies are now live on Google Maps.
                  </p>
                  <button onClick={closeBulkModal} className="btn btn-gold" style={{ fontSize: 13, padding: '12px 32px' }}>
                    Done
                  </button>
                </div>
              )
            })()}

          </div>
        </div>
      )}

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
  select:          { width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 11, outline: 'none', cursor: 'pointer' },
  createStyleBtn:  { width: '100%', padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--orange)', background: 'rgba(242,56,1,0.05)', border: '1px dashed rgba(242,56,1,0.35)', borderRadius: 6, cursor: 'pointer', textAlign: 'left', letterSpacing: '0.04em', transition: 'background 0.15s' },
  manageStylesLink: { display: 'block', marginTop: 10, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--orange)', textDecoration: 'none', letterSpacing: '0.06em', opacity: 0.85 },

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
  statCard:       { flex: 1, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, padding: '16px', display: 'flex', flexDirection: 'column', gap: 4, transition: 'border-color 0.15s, background 0.15s' },
  statCardActive: { borderColor: 'var(--orange)', background: 'rgba(242,56,1,0.04)' },
  statNum:        { fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 800, color: 'var(--text)', lineHeight: 1 },
  statLabel:      { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)' },
  listFilterBar:      { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 20 },
  listFilterSelect:   { padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', outline: 'none', transition: 'border-color 0.15s' },
  starDropdown:       { position: 'absolute' as const, top: 'calc(100% + 4px)', left: 0, zIndex: 200, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', boxShadow: '0 4px 16px rgba(0,0,0,0.1)', minWidth: 150 },
  starDropdownItem:   { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text)', cursor: 'pointer' },
  starDropdownAction: { flex: 1, padding: '4px 0', fontFamily: 'var(--font-mono)', fontSize: 10, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', color: 'var(--text-muted)' },
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

  // Bulk reply banner
  bulkBanner:       { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, background: 'linear-gradient(135deg, rgba(242,56,1,0.07) 0%, rgba(242,56,1,0.03) 100%)', border: '1px solid rgba(242,56,1,0.22)', borderRadius: 10, padding: '16px 20px', marginBottom: 20 },
  bulkBannerTitle:  { fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 700, color: 'var(--text)', marginBottom: 3 },
  bulkBannerDesc:   { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' },

  // Modal overlay + container
  modalOverlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(4px)', zIndex: 200, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 20px', overflowY: 'auto' },
  modal:        { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: 720, boxShadow: '0 24px 80px rgba(0,0,0,0.18)', flexShrink: 0 },
  modalHeader:  { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '24px 28px 0' },
  modalEyebrow: { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--orange)', marginBottom: 5 },
  modalTitle:   { fontFamily: 'var(--font-display)', fontSize: 21, fontWeight: 700, color: 'var(--text)' },
  modalClose:   { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 18, padding: '4px 8px', lineHeight: 1, borderRadius: 4 },
  modalBody:    { padding: '24px 28px 28px' },
  modalSectionLabel: { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 12 },
  modalError:   { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--error)', marginTop: 12 },

  // Time filter
  filterGroup:     { display: 'flex', gap: 8 },
  filterBtn:       { flex: 1, padding: '10px 0', fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 7, cursor: 'pointer', color: 'var(--text-muted)', transition: 'all 0.15s' },
  filterBtnActive: { background: 'rgba(242,56,1,0.08)', borderColor: 'var(--orange)', color: 'var(--orange)', fontWeight: 600 },

  // Bulk progress
  bulkProgressCount: { fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--orange)' },
  bulkProgressTrack: { height: 5, background: 'var(--surface)', borderRadius: 99, overflow: 'hidden', border: '1px solid var(--border)' },
  bulkProgressFill:  { height: '100%', background: 'var(--orange)', borderRadius: 99, transition: 'width 0.3s ease' },

  // Bulk items list
  bulkItemsList: { display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 460, overflowY: 'auto', paddingRight: 4 },
  bulkItemCard:  { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' },
  bulkItemMeta:  { display: 'flex', alignItems: 'center', gap: 10 },
  bulkItemAvatar: { width: 28, height: 28, borderRadius: '50%', background: 'linear-gradient(135deg, var(--orange) 0%, var(--orange-light) 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, flexShrink: 0 },
  bulkItemName:  { fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, color: 'var(--text)' },
  bulkItemReplyPreview: { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6, marginTop: 8 },

  // Confirm list
  bulkConfirmCard:   { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 },
  bulkConfirmMeta:   { display: 'flex', alignItems: 'flex-start', gap: 10 },
  bulkConfirmReview: { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6, marginTop: 3 },
  bulkReplyTextarea: { width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.65, outline: 'none', resize: 'vertical', boxSizing: 'border-box' as const },
}
