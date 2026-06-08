'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'

// ── Types ──────────────────────────────────────────────────────────────────────

interface LocationSetting {
  location_name:      string
  display_name:       string
  auto_reply_enabled: boolean
}

const ERROR_MESSAGES: Record<string, string> = {
  access_denied:  'Google access was denied. Please try again.',
  invalid_state:  'Session expired. Please try again.',
  missing_tokens: 'Could not retrieve tokens from Google. Please try again.',
  db_error:       'Failed to save Google credentials to database.',
}

// ── Inner component (needs useSearchParams) ────────────────────────────────────

function GmbPageInner() {
  const searchParams = useSearchParams()
  const errorParam   = searchParams.get('error')
  const errorDetail  = searchParams.get('detail')

  const [oauthConnected, setOauthConnected] = useState(false)
  const [locations,      setLocations]      = useState<LocationSetting[]>([])
  const [loading,        setLoading]        = useState(true)
  const [deleting,       setDeleting]       = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/gmb/status')
      .then(r => r.json())
      .then(d => {
        setOauthConnected(!!d.oauthConnected)
        setLocations(d.locations ?? [])
      })
      .finally(() => setLoading(false))
  }, [])

  async function handleReconnect() {
    await fetch('/api/gmb/disconnect', { method: 'POST' })
    window.location.href = '/api/gmb/connect'
  }

  async function deleteLocation(locationName: string) {
    if (!confirm('Remove this location?')) return
    setDeleting(locationName)
    await fetch(`/api/gmb/settings?locationName=${encodeURIComponent(locationName)}`, { method: 'DELETE' })
    setLocations(prev => prev.filter(l => l.location_name !== locationName))
    setDeleting(null)
  }

  // Google card CTA
  const googleCard = loading ? null : !oauthConnected ? (
    <a href="/api/gmb/connect" className="btn btn-ghost" style={s.googleCta}>
      Connect Google →
    </a>
  ) : locations.length === 0 ? (
    <Link href="/gmb/setup" className="btn btn-ghost" style={s.googleCta}>
      Add Location →
    </Link>
  ) : (
    <Link href={`/gmb/dashboard?loc=${encodeURIComponent(locations[0].location_name)}`} className="btn btn-ghost" style={s.googleCta}>
      Open Dashboard →
    </Link>
  )

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
        <span style={s.navCrumb}>Review Reply</span>
      </nav>

      <main style={s.main}>

        {/* ── Hero ── */}
        <div style={s.hero}>
          <p style={s.heroEyebrow}>AI · Review Reply</p>
          <h1 style={s.heroTitle}>Every review,<br />replied.</h1>
          <p style={s.heroDesc}>
            Train the AI in your own voice. Paste any review and get tailored replies in seconds — or connect Google for hands-free auto-replies.
          </p>
        </div>

        {/* Error banner */}
        {errorParam && (
          <div style={s.errorBanner}>
            <span style={{ color: 'var(--error)' }}>⚠</span>
            <span>
              {ERROR_MESSAGES[errorParam] ?? 'An error occurred. Please try again.'}
              {errorDetail && (
                <span style={{ display: 'block', fontSize: 11, opacity: 0.7, marginTop: 4 }}>
                  {errorDetail}
                </span>
              )}
            </span>
          </div>
        )}

        {/* ── Two path cards ── */}
        <div style={s.pathGrid}>

          {/* Quick Reply — primary */}
          <div style={s.quickCard}>
            <div style={s.cardIcon}>◎</div>
            <div style={s.cardBadge}>No setup needed</div>
            <h2 style={s.cardTitle}>Quick Reply</h2>
            <p style={s.cardDesc}>
              Copy any customer review, paste it here, and get 5 AI-crafted replies in your style. Copy the best one and post it yourself.
            </p>
            <ul style={s.featureList}>
              <li style={s.featureItem}><span style={s.featureDot} />Works with any review platform</li>
              <li style={s.featureItem}><span style={s.featureDot} />Uses your trained reply style</li>
              <li style={s.featureItem}><span style={s.featureDot} />No Google connection required</li>
            </ul>
            <div style={{ marginTop: 'auto', paddingTop: 24 }}>
              <Link href="/gmb/quick" className="btn btn-gold" style={{ display: 'inline-block', fontSize: 13, padding: '11px 28px', textDecoration: 'none' }}>
                Try Quick Reply →
              </Link>
            </div>
          </div>

          {/* Auto-Reply — secondary */}
          <div style={s.autoCard}>
            <div style={{ ...s.cardIcon, color: 'var(--text-muted)' }}>◈</div>
            <div style={{ ...s.cardBadge, background: 'var(--surface)', color: 'var(--text-muted)' }}>
              {loading ? '…' : oauthConnected ? '● Connected' : 'Google required'}
            </div>
            <h2 style={s.cardTitle}>Auto-Reply</h2>
            <p style={s.cardDesc}>
              Connect your Google Business account to see all your reviews in one place and enable automatic AI replies.
            </p>
            <ul style={s.featureList}>
              <li style={s.featureItem}><span style={{ ...s.featureDot, background: 'var(--text-muted)' }} />Pulls all reviews from Google</li>
              <li style={s.featureItem}><span style={{ ...s.featureDot, background: 'var(--text-muted)' }} />Auto-reply with your saved style</li>
              <li style={s.featureItem}><span style={{ ...s.featureDot, background: 'var(--text-muted)' }} />Manage multiple locations</li>
            </ul>
            <div style={{ marginTop: 'auto', paddingTop: 24, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const }}>
              {loading ? <div style={s.spinner} /> : googleCard}
              {oauthConnected && (
                <button onClick={handleReconnect} style={s.reconnectBtn}>↺ Switch account</button>
              )}
            </div>
          </div>

        </div>

        {/* ── Style training prompt ── */}
        <div style={s.trainBanner}>
          <div>
            <p style={s.trainBannerLabel}>AI Reply Style</p>
            <p style={s.trainBannerDesc}>
              The AI learns how you like to reply — your tone, length, and voice. Train it once, use it everywhere.
            </p>
          </div>
          <Link href="/gmb/train" className="btn btn-ghost" style={{ fontSize: 11, whiteSpace: 'nowrap' as const, flexShrink: 0 }}>
            Manage Styles →
          </Link>
        </div>

        {/* ── Connected locations list ── */}
        {!loading && oauthConnected && locations.length > 0 && (
          <div style={s.locSection}>
            <div style={s.locHeader}>
              <div>
                <p style={s.locEyebrow}>Connected</p>
                <h3 style={s.locTitle}>Your Locations</h3>
              </div>
              <Link href="/gmb/setup" className="btn btn-ghost" style={{ fontSize: 11 }}>
                + Add Location
              </Link>
            </div>

            <div style={s.locList}>
              {locations.map(loc => (
                <div key={loc.location_name} style={s.locCard}>
                  <div style={s.locLeft}>
                    <span style={s.locDot} />
                    <div>
                      <p style={s.locName}>{loc.display_name}</p>
                      <p style={s.locId}>{loc.location_name}</p>
                    </div>
                  </div>
                  <div style={s.locRight}>
                    <span style={{ ...s.badge, ...(loc.auto_reply_enabled ? s.badgeOn : s.badgeOff) }}>
                      {loc.auto_reply_enabled ? 'Auto-reply ON' : 'Auto-reply OFF'}
                    </span>
                    <Link
                      href={`/gmb/dashboard?loc=${encodeURIComponent(loc.location_name)}`}
                      className="btn btn-ghost"
                      style={{ fontSize: 11, padding: '6px 14px' }}
                    >
                      Manage
                    </Link>
                    <button
                      onClick={() => deleteLocation(loc.location_name)}
                      disabled={deleting === loc.location_name}
                      style={s.deleteBtn}
                      title="Remove location"
                    >
                      {deleting === loc.location_name ? '…' : '✕'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

      </main>
    </div>
  )
}

export default function GmbPage() {
  return (
    <Suspense>
      <GmbPageInner />
    </Suspense>
  )
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page:    { minHeight: '100vh', background: 'var(--bg)', position: 'relative', overflow: 'hidden' },
  glow:    { position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)', width: 900, height: 400, background: 'radial-gradient(ellipse, var(--orange-glow) 0%, transparent 70%)', pointerEvents: 'none', filter: 'blur(50px)', zIndex: 0 },

  nav:      { position: 'relative', zIndex: 2, display: 'flex', alignItems: 'center', gap: 8, padding: '18px 32px', borderBottom: '1px solid var(--border)', background: 'rgba(244,246,250,0.85)', backdropFilter: 'blur(10px)' },
  navBrand: { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text)', textDecoration: 'none' },
  navIcon:  { color: 'var(--orange)', fontSize: 18 },
  navName:  { fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, color: 'var(--text)' },
  navSep:   { color: 'var(--text-muted)', fontSize: 16 },
  navCrumb: { fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)' },

  main:     { position: 'relative', zIndex: 1, maxWidth: 860, margin: '0 auto', padding: '64px 24px 80px' },

  hero:          { textAlign: 'center', marginBottom: 52 },
  heroEyebrow:   { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--orange)', marginBottom: 14 },
  heroTitle:     { fontFamily: 'var(--font-display)', fontSize: 52, fontWeight: 800, color: 'var(--text)', lineHeight: 1.1, marginBottom: 18 },
  heroDesc:      { color: 'var(--text-secondary)', fontSize: 15, lineHeight: 1.75, maxWidth: 520, margin: '0 auto' },

  errorBanner:   { display: 'flex', alignItems: 'flex-start', gap: 10, background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 8, padding: '14px 18px', color: 'var(--text-secondary)', fontSize: 13, fontFamily: 'var(--font-mono)', marginBottom: 32 },

  pathGrid:  { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 24 },

  // Quick Reply card
  quickCard: { background: 'var(--card)', border: '1px solid rgba(242,56,1,0.2)', borderRadius: 14, padding: '32px', boxShadow: '0 4px 24px rgba(242,56,1,0.07)', display: 'flex', flexDirection: 'column' },
  // Auto-Reply card
  autoCard:  { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, padding: '32px', boxShadow: '0 2px 12px rgba(0,0,0,0.04)', display: 'flex', flexDirection: 'column' },

  cardIcon:  { fontSize: 32, color: 'var(--orange)', marginBottom: 10, lineHeight: 1 },
  cardBadge: { display: 'inline-flex', alignItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', background: 'rgba(242,56,1,0.08)', color: 'var(--orange)', borderRadius: 20, padding: '4px 12px', marginBottom: 14, width: 'fit-content' },
  cardTitle: { fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 700, color: 'var(--text)', marginBottom: 12 },
  cardDesc:  { color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.75, marginBottom: 20 },

  featureList: { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 },
  featureItem: { display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' },
  featureDot:  { width: 5, height: 5, borderRadius: '50%', background: 'var(--orange)', flexShrink: 0, display: 'block' },

  googleCta:   { fontSize: 12, padding: '9px 20px', textDecoration: 'none', display: 'inline-block' },
  reconnectBtn:{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 12px', fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'var(--font-mono)' },

  trainBanner:     { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, padding: '20px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, marginBottom: 36 },
  trainBannerLabel:{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--orange)', marginBottom: 4 },
  trainBannerDesc: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6 },

  locSection: { marginTop: 8 },
  locHeader:  { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14, gap: 12 },
  locEyebrow: { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 4 },
  locTitle:   { fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700, color: 'var(--text)' },
  locList:    { display: 'flex', flexDirection: 'column', gap: 8 },
  locCard:    { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' },
  locLeft:    { display: 'flex', alignItems: 'center', gap: 14 },
  locDot:     { width: 8, height: 8, borderRadius: '50%', background: 'var(--orange)', flexShrink: 0, display: 'block' },
  locName:    { fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 600, color: 'var(--text)' },
  locId:      { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', marginTop: 2 },
  locRight:   { display: 'flex', alignItems: 'center', gap: 10 },

  badge:      { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '4px 10px', borderRadius: 20, border: '1px solid' },
  badgeOn:    { color: 'var(--success)', borderColor: 'rgba(22,163,74,0.3)', background: 'rgba(22,163,74,0.06)' },
  badgeOff:   { color: 'var(--text-muted)', borderColor: 'var(--border)', background: 'transparent' },

  deleteBtn:  { background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 9px', fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' },
  spinner:    { width: 18, height: 18, border: '2px solid var(--border)', borderTopColor: 'var(--orange)', borderRadius: '50%', animation: 'spin 0.8s linear infinite', flexShrink: 0 },
}
