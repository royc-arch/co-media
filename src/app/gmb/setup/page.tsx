'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

interface DiscoveredLocation {
  locationName: string
  displayName:  string
  address:      string
  accountName:  string
}

export default function GmbSetupPage() {
  const router = useRouter()

  const [loading,    setLoading]    = useState(true)
  const [locations,  setLocations]  = useState<DiscoveredLocation[]>([])
  const [selected,   setSelected]   = useState<DiscoveredLocation | null>(null)
  const [discErrors, setDiscErrors] = useState<string[]>([])

  const [profileIdInput,  setProfileIdInput]  = useState('')
  const [fetchingAccount, setFetchingAccount] = useState(false)

  const [displayName, setDisplayName] = useState('')
  const [saving,      setSaving]      = useState(false)
  const [error,       setError]       = useState('')

  useEffect(() => {
    fetch('/api/gmb/discover')
      .then(r => r.json())
      .then(d => {
        setLocations(d.locations ?? [])
        setDiscErrors(d.errors ?? [])
        if ((d.locations ?? []).length === 1) {
          const loc = d.locations[0] as DiscoveredLocation
          setSelected(loc)
          if (loc.displayName && !loc.displayName.startsWith('accounts/')) {
            setDisplayName(loc.displayName)
          }
        }
      })
      .catch(e => setDiscErrors([String(e)]))
      .finally(() => setLoading(false))
  }, [])

  // When user clicks "Use", look up the account ID automatically so we can
  // build the full "accounts/{accountId}/locations/{profileId}" path.
  async function handleManualId() {
    const raw = profileIdInput.trim()
    if (!raw) return

    const profileId = raw.startsWith('locations/')
      ? raw.split('/')[1]
      : raw

    setFetchingAccount(true)
    setError('')

    try {
      // Step 1: try full discovery (includes BI wildcard — different quota pool)
      const discoverRes  = await fetch('/api/gmb/discover')
      const discoverData = await discoverRes.json() as {
        locations?: DiscoveredLocation[]
        errors?:    string[]
      }

      const match = (discoverData.locations ?? []).find(loc =>
        loc.locationName.endsWith(`/${profileId}`)
      )

      if (match) {
        setSelected(match)
        if (match.displayName && !match.displayName.startsWith('accounts/')) {
          setDisplayName(match.displayName)
        }
        return
      }

      // Step 2: try Account Management API (needs quota > 0)
      const accountRes  = await fetch('/api/gmb/discover-account')
      const accountData = await accountRes.json() as {
        accounts?: Array<{ name: string; label: string }>
        error?:    string
      }

      if (accountData.accounts?.length) {
        const accountName  = accountData.accounts[0].name
        const locationName = `${accountName}/locations/${profileId}`
        setSelected({ locationName, displayName: '', address: '', accountName })
        return
      }

      // Both failed — show actionable error
      const apiErr = accountData.error ?? ''
      const isQuota = apiErr.includes('429') || apiErr.includes('quota') || apiErr.includes('QUOTA')
      setError(
        isQuota
          ? 'Google API quota is 0. Go to console.cloud.google.com → ' +
            'APIs & Services → My Business Account Management API → Quotas → ' +
            'request increase for "DefaultRequestsPerMinutePerProject".'
          : `Could not find account automatically. Raw error: ${apiErr || 'unknown'}`
      )
    } catch {
      setError('Request failed. Please try again.')
    } finally {
      setFetchingAccount(false)
    }
  }

  async function handleSave() {
    if (!selected)           { setError('Select or enter a location.'); return }
    if (!displayName.trim()) { setError('Business name is required.'); return }

    setSaving(true)
    setError('')

    const res = await fetch('/api/gmb/settings', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountName:  selected.accountName,
        locationName: selected.locationName,
        displayName:  displayName.trim(),
      }),
    })

    if (!res.ok) {
      const d = await res.json()
      setError(d.error ?? 'Failed to save.')
      setSaving(false)
      return
    }

    router.push('/gmb/dashboard')
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
        <Link href="/gmb" style={s.navLink}>Review Reply</Link>
        <span style={s.navSep}>/</span>
        <span style={s.navCrumb}>Add Location</span>
      </nav>

      <main style={s.main}>
        <div style={s.header}>
          <p style={s.eyebrow}>Connect Location</p>
          <h1 style={s.title}>Add your business</h1>
        </div>

        {error && <div style={s.errorBanner}>⚠ {error}</div>}

        <div style={s.card}>

          {loading && (
            <div style={s.detectRow}>
              <span style={sp} />
              <span style={s.detectText}>Scanning your Google Business Profile…</span>
            </div>
          )}

          {/* Auto-discovered locations */}
          {!loading && locations.length > 0 && (
            <div>
              <p style={s.fieldLabel}>Your business listings</p>
              <div style={s.locList}>
                {locations.map(loc => (
                  <button
                    key={loc.locationName}
                    onClick={() => {
                      setSelected(loc)
                      if (loc.displayName && !loc.displayName.startsWith('accounts/')) {
                        setDisplayName(loc.displayName)
                      }
                    }}
                    style={{ ...s.locItem, ...(selected?.locationName === loc.locationName ? s.locActive : {}) }}
                  >
                    <span style={{ color: 'var(--orange)', fontSize: 14, flexShrink: 0 }}>◉</span>
                    <span style={s.locText}>
                      <span style={s.locName}>{loc.displayName}</span>
                      {loc.address && <span style={s.locAddr}>{loc.address}</span>}
                      <span style={s.locId}>{loc.locationName}</span>
                    </span>
                    {selected?.locationName === loc.locationName && (
                      <span style={{ color: 'var(--success)', fontSize: 16, flexShrink: 0 }}>✓</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Manual Profile ID entry */}
          {!loading && (
            <div style={locations.length > 0 ? s.manualSection : undefined}>
              {locations.length > 0
                ? <p style={s.manualLabel}>Don't see your location? Enter Profile ID:</p>
                : <p style={s.fieldLabel}>Enter your Business Profile ID</p>
              }

              <div style={s.profileRow}>
                <input
                  value={profileIdInput}
                  onChange={e => setProfileIdInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleManualId()}
                  placeholder="e.g. 9819770212612189236"
                  style={{ flex: 1, marginBottom: 0, fontFamily: 'var(--font-mono)', fontSize: 13 }}
                />
                <button
                  onClick={handleManualId}
                  disabled={!profileIdInput.trim() || fetchingAccount}
                  className="btn btn-ghost"
                  style={{ fontSize: 11, padding: '6px 14px', flexShrink: 0 }}
                >
                  {fetchingAccount ? <span style={sp} /> : 'Use'}
                </button>
              </div>

              <p style={s.hint}>
                Google Business Profile → Settings → Advanced settings → Business Profile ID
              </p>

              {locations.length === 0 && discErrors.length > 0 && (
                <details style={{ marginTop: 12 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 11, opacity: 0.5, fontFamily: 'var(--font-mono)' }}>
                    Auto-discovery debug info
                  </summary>
                  <pre style={{ fontSize: 10, marginTop: 6, whiteSpace: 'pre-wrap', opacity: 0.5 }}>
                    {discErrors.join('\n')}
                  </pre>
                </details>
              )}
            </div>
          )}

          {/* Confirmation + display name */}
          {selected && (
            <>
              <div style={s.divider} />
              <div style={s.selectedBadge}>
                <span style={{ color: 'var(--success)' }}>✓</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
                  {selected.locationName}
                </span>
              </div>
              <div style={{ marginTop: 14 }}>
                <label style={s.fieldLabel}>Business display name</label>
                <input
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  placeholder="e.g. Okinawa Asian Cuisine"
                  style={{ marginTop: 8 }}
                  autoFocus
                />
              </div>
            </>
          )}

          <div style={s.footer}>
            <Link href="/gmb" className="btn btn-ghost">Cancel</Link>
            <button
              onClick={handleSave}
              disabled={saving || !selected || !displayName.trim() || loading}
              className="btn btn-gold"
            >
              {saving ? 'Saving…' : 'Add Location'}
            </button>
          </div>
        </div>
      </main>
    </div>
  )
}

const sp: React.CSSProperties = {
  display: 'inline-block', width: 14, height: 14, flexShrink: 0,
  border: '2px solid var(--border)', borderTopColor: 'var(--orange)',
  borderRadius: '50%', animation: 'spin 0.6s linear infinite',
}

const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: 'radial-gradient(ellipse 100% 50% at 50% 0%, #fff8f5 0%, var(--bg) 60%)',
    position: 'relative', overflow: 'hidden',
  },
  glow: {
    position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)',
    width: 700, height: 250,
    background: 'radial-gradient(ellipse, var(--orange-glow) 0%, transparent 70%)',
    pointerEvents: 'none', filter: 'blur(40px)',
  },
  nav: {
    position: 'relative', zIndex: 2, display: 'flex', alignItems: 'center', gap: 8,
    padding: '20px 32px', borderBottom: '1px solid var(--border)',
    background: 'rgba(244,246,250,0.8)', backdropFilter: 'blur(8px)',
  },
  navBrand: { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text)', textDecoration: 'none' },
  navIcon:  { color: 'var(--orange)', fontSize: 18 },
  navName:  { fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, color: 'var(--text)' },
  navSep:   { color: 'var(--text-muted)', fontSize: 16 },
  navLink:  { fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--orange)', textDecoration: 'none' },
  navCrumb: { fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)' },
  main:     { position: 'relative', zIndex: 1, maxWidth: 560, margin: '0 auto', padding: '60px 24px' },
  header:   { marginBottom: 32 },
  eyebrow:  { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--orange)', marginBottom: 8 },
  title:    { fontFamily: 'var(--font-display)', fontSize: 36, fontWeight: 800, color: 'var(--text)', lineHeight: 1.1 },
  errorBanner: {
    background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)',
    borderRadius: 6, padding: '12px 16px', color: 'var(--text-secondary)',
    fontSize: 13, fontFamily: 'var(--font-mono)', marginBottom: 20,
  },
  card: {
    background: 'var(--card)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius-xl)', padding: '28px', boxShadow: 'var(--shadow-md)',
  },
  detectRow:  { display: 'flex', alignItems: 'center', gap: 10 },
  detectText: { fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' },
  fieldLabel: { fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 700, color: 'var(--text)', display: 'block', marginBottom: 4 },
  locList:    { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 },
  locItem: {
    display: 'flex', alignItems: 'flex-start', gap: 10,
    background: 'var(--bg)', border: '1px solid var(--border)',
    borderRadius: 8, padding: '12px 14px', cursor: 'pointer',
    width: '100%', textAlign: 'left',
    transition: 'border-color 0.15s, background 0.15s',
  },
  locActive: {
    borderColor: 'var(--orange)', background: 'rgba(242,56,1,0.03)',
    boxShadow: '0 0 0 3px rgba(242,56,1,0.07)',
  },
  locText:  { display: 'flex', flexDirection: 'column', gap: 2, flex: 1 },
  locName:  { fontSize: 14, fontWeight: 600, color: 'var(--text)', fontFamily: 'var(--font-display)' },
  locAddr:  { fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' },
  locId:    { fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', opacity: 0.6, marginTop: 2 },
  manualSection: {
    marginTop: 20, paddingTop: 20,
    borderTop: '1px dashed var(--border)',
  },
  manualLabel: {
    fontFamily: 'var(--font-mono)', fontSize: 10,
    letterSpacing: '0.1em', textTransform: 'uppercase',
    color: 'var(--text-muted)', marginBottom: 10,
  },
  profileRow: { display: 'flex', alignItems: 'center', gap: 8 },
  hint: {
    fontFamily: 'var(--font-mono)', fontSize: 10,
    color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.6,
  },
  selectedBadge: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: 'rgba(22,163,74,0.05)', border: '1px solid rgba(22,163,74,0.2)',
    borderRadius: 6, padding: '8px 12px',
  },
  divider: { height: 1, background: 'var(--border)', margin: '20px 0' },
  footer:  { display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 20, marginTop: 20, borderTop: '1px solid var(--border)' },
}
