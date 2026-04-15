'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'

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

export default function GmbPage() {
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
    await fetch(`/api/gmb/settings?locationName=${encodeURIComponent(locationName)}`, {
      method: 'DELETE',
    })
    setLocations(prev => prev.filter(l => l.location_name !== locationName))
    setDeleting(null)
  }

  return (
    <div style={s.page}>
      <div style={s.glow} />

      <nav style={s.nav}>
        <Link href="/" style={s.navBrand}>
          <span style={s.navIcon}>◈</span>
          <span style={s.navName}>Co.Media</span>
        </Link>
        <span style={s.navSep}>/</span>
        <span style={s.navCrumb}>Review Reply</span>
      </nav>

      <main style={s.main}>
        <div style={s.header}>
          <p style={s.headerEyebrow}>Google My Business</p>
          <h1 style={s.headerTitle}>Review Reply</h1>
          <p style={s.headerDesc}>
            Connect your business account to auto-reply to customer reviews with AI.
          </p>
        </div>

        {errorParam && (
          <div style={s.errorBanner}>
            <span style={{ color: 'var(--error)', fontSize: 14 }}>⚠</span>
            <span>
              {ERROR_MESSAGES[errorParam] ?? 'An error occurred. Please try again.'}
              {errorDetail && (
                <span style={{ display: 'block', fontSize: 11, opacity: 0.7, marginTop: 4, wordBreak: 'break-all' }}>
                  {errorDetail}
                </span>
              )}
            </span>
          </div>
        )}

        {loading ? (
          <div style={s.loadWrap}><div style={s.spinner} /></div>

        ) : !oauthConnected ? (
          /* ── Step 1: authorize with Google ── */
          <div style={s.connectCard}>
            <div style={s.stepBadge}>Step 1 of 2</div>
            <div style={s.connectIcon}>◎</div>
            <h2 style={s.connectTitle}>Authorize Google My Business</h2>
            <p style={s.connectDesc}>
              Sign in with the Google account that manages your business listing.
              We request permission to read and reply to reviews — nothing else.
            </p>
            <a href="/api/gmb/connect" className="btn btn-gold" style={{ marginTop: 8 }}>
              Connect with Google
            </a>
            <p style={s.connectNote}>Your tokens are stored securely and never shared.</p>
          </div>

        ) : locations.length === 0 ? (
          /* ── Step 2: add first location ── */
          <div style={s.connectCard}>
            <div style={s.stepBadge}>Step 2 of 2</div>
            <div style={{ ...s.connectIcon, color: 'var(--success)' }}>◉</div>
            <div style={s.connectedBadge}>
              <span style={s.connectedDot} />
              Google authorized
            </div>
            <h2 style={s.connectTitle}>Add your first location</h2>
            <p style={s.connectDesc}>
              Search for your restaurant to link it to your Google reviews.
            </p>
            <Link href="/gmb/setup" className="btn btn-gold" style={{ marginTop: 8 }}>
              Add Location
            </Link>
          </div>

        ) : (
          /* ── Connected + locations ── */
          <div style={s.locationsWrap}>
            <div style={s.locationsHeader}>
              <div>
                <h2 style={s.locationsTitle}>Connected Locations</h2>
                <div style={s.connectedBadge}>
                  <span style={s.connectedDot} />
                  Google authorized
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button onClick={handleReconnect} style={s.reconnectBtn} title="Switch Google account">
                  ↺ Reconnect
                </button>
                <Link href="/gmb/setup" className="btn btn-ghost" style={{ fontSize: 11 }}>
                  + Add Location
                </Link>
              </div>
            </div>

            <div style={s.locationsList}>
              {locations.map(loc => (
                <div key={loc.location_name} style={s.locationCard}>
                  <div style={s.locationLeft}>
                    <span style={s.locationIcon}>◉</span>
                    <div>
                      <p style={s.locationName}>{loc.display_name}</p>
                      <p style={s.locationId}>{loc.location_name}</p>
                    </div>
                  </div>
                  <div style={s.locationRight}>
                    <span style={{
                      ...s.badge,
                      ...(loc.auto_reply_enabled ? s.badgeActive : s.badgeOff),
                    }}>
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

            <div style={{ marginTop: 24 }}>
              <Link href="/gmb/dashboard" className="btn btn-gold">
                Open Dashboard
              </Link>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: 'radial-gradient(ellipse 100% 60% at 50% 0%, #fff8f5 0%, var(--bg) 60%)',
    position: 'relative', overflow: 'hidden',
  },
  glow: {
    position: 'absolute', top: 0, left: '50%',
    transform: 'translateX(-50%)',
    width: 800, height: 300,
    background: 'radial-gradient(ellipse, var(--orange-glow) 0%, transparent 70%)',
    pointerEvents: 'none', filter: 'blur(40px)',
  },
  nav: {
    position: 'relative', zIndex: 2,
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '20px 32px',
    borderBottom: '1px solid var(--border)',
    background: 'rgba(244,246,250,0.8)',
    backdropFilter: 'blur(8px)',
  },
  navBrand: {
    display: 'flex', alignItems: 'center', gap: 8,
    color: 'var(--text)', textDecoration: 'none',
  },
  navIcon: { color: 'var(--orange)', fontSize: 18 },
  navName: {
    fontFamily: 'var(--font-display)',
    fontSize: 18, fontWeight: 700, color: 'var(--text)',
  },
  navSep:  { color: 'var(--text-muted)', fontSize: 16 },
  navCrumb: {
    fontFamily: 'var(--font-mono)', fontSize: 11,
    letterSpacing: '0.1em', textTransform: 'uppercase',
    color: 'var(--text-muted)',
  },
  main: {
    position: 'relative', zIndex: 1,
    maxWidth: 680, margin: '0 auto', padding: '60px 24px',
  },
  header: { textAlign: 'center', marginBottom: 40 },
  headerEyebrow: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10, letterSpacing: '0.18em',
    textTransform: 'uppercase',
    color: 'var(--orange)', marginBottom: 10,
  },
  headerTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: 42, fontWeight: 800,
    color: 'var(--text)', lineHeight: 1.1, marginBottom: 14,
  },
  headerDesc: {
    color: 'var(--text-secondary)',
    fontSize: 14, lineHeight: 1.7,
    maxWidth: 440, margin: '0 auto',
  },
  errorBanner: {
    display: 'flex', alignItems: 'center', gap: 10,
    background: 'rgba(239,68,68,0.06)',
    border: '1px solid rgba(239,68,68,0.2)',
    borderRadius: 6, padding: '12px 16px',
    color: 'var(--text-secondary)',
    fontSize: 13, marginBottom: 24,
    fontFamily: 'var(--font-mono)',
  },
  loadWrap: {
    display: 'flex', justifyContent: 'center', padding: '60px 0',
  },
  spinner: {
    width: 24, height: 24,
    border: '2px solid var(--border)',
    borderTopColor: 'var(--orange)',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  connectCard: {
    background: 'var(--card)',
    border: '1px solid var(--border)',
    borderRadius: 12, padding: '48px 40px',
    textAlign: 'center', boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', gap: 14,
  },
  stepBadge: {
    fontFamily: 'var(--font-mono)',
    fontSize: 9, letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color: 'var(--text-muted)',
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: 20, padding: '4px 12px',
  },
  connectIcon: { fontSize: 40, color: 'var(--orange)', lineHeight: 1 },
  connectedBadge: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontFamily: 'var(--font-mono)',
    fontSize: 10, letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: 'var(--success)',
  },
  connectedDot: {
    width: 7, height: 7, borderRadius: '50%',
    background: 'var(--success)',
    flexShrink: 0,
    display: 'block',
  },
  connectTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: 26, fontWeight: 700, color: 'var(--text)',
  },
  connectDesc: {
    color: 'var(--text-secondary)',
    fontSize: 13, lineHeight: 1.7, maxWidth: 380,
  },
  connectNote: {
    color: 'var(--text-muted)',
    fontSize: 10, letterSpacing: '0.08em',
    textTransform: 'uppercase', marginTop: 4,
  },
  locationsWrap: {},
  locationsHeader: {
    display: 'flex', alignItems: 'flex-start',
    justifyContent: 'space-between', marginBottom: 16, gap: 12,
  },
  locationsTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: 22, fontWeight: 700,
    color: 'var(--text)', marginBottom: 6,
  },
  locationsList: { display: 'flex', flexDirection: 'column', gap: 10 },
  locationCard: {
    background: 'var(--card)',
    border: '1px solid var(--border)',
    borderRadius: 8, padding: '16px 20px',
    display: 'flex', alignItems: 'center',
    justifyContent: 'space-between',
    boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
  },
  locationLeft: { display: 'flex', alignItems: 'center', gap: 14 },
  locationIcon: { color: 'var(--orange)', fontSize: 20 },
  locationName: {
    fontFamily: 'var(--font-display)',
    fontSize: 16, fontWeight: 600, color: 'var(--text)',
  },
  locationId: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10, color: 'var(--text-muted)', marginTop: 2,
  },
  locationRight: { display: 'flex', alignItems: 'center', gap: 12 },
  badge: {
    fontFamily: 'var(--font-mono)',
    fontSize: 9, letterSpacing: '0.1em',
    textTransform: 'uppercase',
    padding: '4px 10px', borderRadius: 20, border: '1px solid',
  },
  badgeActive: {
    color: 'var(--success)',
    borderColor: 'rgba(22,163,74,0.3)',
    background: 'rgba(22,163,74,0.06)',
  },
  badgeOff: {
    color: 'var(--text-muted)',
    borderColor: 'var(--border)', background: 'transparent',
  },
  reconnectBtn: {
    background: 'none',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '5px 10px',
    fontSize: 11,
    color: 'var(--text-muted)',
    cursor: 'pointer',
    fontFamily: 'var(--font-mono)',
  },
  deleteBtn: {
    background: 'none',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '5px 9px',
    fontSize: 11,
    color: 'var(--text-muted)',
    cursor: 'pointer',
    transition: 'border-color 0.15s, color 0.15s',
  },
}
