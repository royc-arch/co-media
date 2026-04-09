'use client'

import { useState, useRef } from 'react'
import { useRouter }        from 'next/navigation'
import { createClient }     from '@/lib/supabase/client'
import type { SavedReference } from '@/types'

async function compressImage(file: File, maxPx = 1280): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new window.Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale  = Math.min(1, maxPx / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width  = Math.round(img.width  * scale)
      canvas.height = Math.round(img.height * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('Canvas unavailable')); return }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error('Compression failed')),
        'image/jpeg', 0.92,
      )
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')) }
    img.src = url
  })
}

export default function ReferencesClient({ initialRefs }: { initialRefs: SavedReference[] }) {
  const router   = useRouter()
  const supabase = createClient()

  const [refs,       setRefs]       = useState<SavedReference[]>(initialRefs)
  const [uploading,  setUploading]  = useState(false)
  const [editingId,  setEditingId]  = useState<string | null>(null)
  const [editName,   setEditName]   = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function signOut() {
    await supabase.auth.signOut()
    router.push('/auth')
    router.refresh()
  }

  async function handleUpload(file: File) {
    setUploading(true)
    try {
      const blob = await compressImage(file)
      const fd   = new FormData()
      fd.append('file', blob, 'reference.jpg')
      fd.append('name', file.name.replace(/\.[^/.]+$/, '') || 'Untitled')
      const res = await fetch('/api/references', { method: 'POST', body: fd })
      if (res.ok) {
        const saved: SavedReference = await res.json()
        setRefs(prev => [saved, ...prev])
      }
    } finally {
      setUploading(false)
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id)
    const res = await fetch(`/api/references/${id}`, { method: 'DELETE' })
    if (res.ok) setRefs(prev => prev.filter(r => r.id !== id))
    setDeletingId(null)
  }

  async function handleRename(id: string) {
    const trimmed = editName.trim()
    if (!trimmed) { setEditingId(null); return }
    const res = await fetch(`/api/references/${id}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: trimmed }),
    })
    if (res.ok) setRefs(prev => prev.map(r => r.id === id ? { ...r, name: trimmed } : r))
    setEditingId(null)
  }

  return (
    <div style={s.page}>

      {/* ── Header ─────────────────────────────────────────────────── */}
      <header style={s.header}>
        <div style={s.headerInner}>
          <a href="/" style={s.logo}>
            <span style={s.logoMark}>◈</span>
            <span style={s.logoName}>Co.Media</span>
          </a>
          <nav style={s.nav}>
            <a href="/"           style={s.navLink}>Style Transfer</a>
            <span style={s.navSep}>·</span>
            <a href="/showcase"   style={s.navLink}>Video Showcase</a>
            <span style={s.navSep}>·</span>
            <a href="/history"    style={s.navLink}>Works</a>
            <span style={s.navSep}>·</span>
            <a href="/references" style={{ ...s.navLink, color: 'var(--orange)' }}>References</a>
            <span style={s.navSep}>·</span>
            <button onClick={signOut} style={s.navBtn}>Sign Out</button>
          </nav>
        </div>
      </header>

      {/* ── Main ───────────────────────────────────────────────────── */}
      <main style={s.main}>

        <div style={s.pageHeader} className="animate-fade-up">
          <div>
            <h1 style={s.pageTitle}>Saved References</h1>
            <p style={s.pageSub}>
              {refs.length} reference{refs.length !== 1 ? 's' : ''} · select any when running a Style Transfer
            </p>
          </div>
          <button
            className="btn btn-gold"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? 'Uploading…' : '+ Add Reference'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            style={{ display: 'none' }}
            onChange={e => {
              const f = e.target.files?.[0]
              if (f) handleUpload(f)
              e.target.value = ''
            }}
          />
        </div>

        {refs.length === 0 ? (
          <div style={s.empty} className="animate-fade-up">
            <div style={s.emptyIcon}>◈</div>
            <p style={s.emptyTitle}>No saved references yet</p>
            <p style={s.emptyHint}>
              Save reference images here to reuse them instantly in style transfers —
              no re-uploading required.
            </p>
            <button
              className="btn btn-gold"
              onClick={() => fileRef.current?.click()}
              style={{ marginTop: 20 }}
            >
              + Upload First Reference
            </button>
          </div>
        ) : (
          <div style={s.grid} className="animate-fade-up">

            {/* Upload card */}
            <div
              style={s.addCard}
              onClick={() => !uploading && fileRef.current?.click()}
            >
              <div style={s.addIcon}>{uploading ? '…' : '+'}</div>
              <span style={s.addLabel}>{uploading ? 'Uploading…' : 'Add Reference'}</span>
            </div>

            {refs.map(ref => (
              <div key={ref.id} style={s.card}>

                {/* Thumbnail */}
                <div style={s.imgWrap}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={ref.image_url} alt={ref.name} style={s.img} />
                </div>

                {/* Card footer */}
                <div style={s.cardFoot}>
                  {editingId === ref.id ? (
                    <form
                      style={s.editForm}
                      onSubmit={e => { e.preventDefault(); handleRename(ref.id) }}
                    >
                      <input
                        autoFocus
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        style={s.nameInput}
                        onBlur={() => handleRename(ref.id)}
                        onKeyDown={e => e.key === 'Escape' && setEditingId(null)}
                      />
                    </form>
                  ) : (
                    <button
                      style={s.nameBtn}
                      onClick={() => { setEditingId(ref.id); setEditName(ref.name) }}
                      title="Click to rename"
                    >
                      {ref.name}
                    </button>
                  )}
                  <button
                    style={s.deleteBtn}
                    onClick={() => handleDelete(ref.id)}
                    disabled={deletingId === ref.id}
                    title="Delete"
                  >
                    {deletingId === ref.id ? '…' : '×'}
                  </button>
                </div>

              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page:       { minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column' },

  header:     { borderBottom: '1px solid rgba(255,255,255,0.08)', background: 'var(--header-bg)', position: 'sticky', top: 0, zIndex: 100 },
  headerInner:{ maxWidth: 1100, margin: '0 auto', padding: '0 24px', height: 56, display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  logo:       { display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none' },
  logoMark:   { color: 'var(--orange)', fontSize: 18 },
  logoName:   { fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em', color: '#FFFFFF' },

  nav:        { display: 'flex', alignItems: 'center', gap: 16 },
  navLink:    { color: 'rgba(255,255,255,0.55)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', textDecoration: 'none', transition: 'color 0.15s' },
  navSep:     { color: 'rgba(255,255,255,0.2)' },
  navBtn:     { background: 'none', border: 'none', color: 'rgba(255,255,255,0.55)', fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer', padding: 0 },

  main:       { flex: 1, maxWidth: 1100, margin: '0 auto', padding: '56px 24px 80px', width: '100%' },

  pageHeader: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 40, gap: 16 },
  pageTitle:  { fontFamily: 'var(--font-display)', fontSize: 36, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em', marginBottom: 6 },
  pageSub:    { color: 'var(--text-muted)', fontSize: 11, letterSpacing: '0.06em' },

  empty:      { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 24px', textAlign: 'center' },
  emptyIcon:  { fontSize: 36, color: 'var(--border-light)', marginBottom: 20 },
  emptyTitle: { fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, color: 'var(--text)', marginBottom: 10 },
  emptyHint:  { color: 'var(--text-muted)', fontSize: 12, maxWidth: 380, lineHeight: 1.7 },

  grid: {
    display:             'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap:                 20,
  },

  addCard: {
    border:         '1.5px dashed var(--border)',
    borderRadius:   8,
    minHeight:      220,
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            10,
    cursor:         'pointer',
    transition:     'border-color 0.2s, background 0.2s',
    background:     'var(--card)',
  },
  addIcon:  { fontSize: 28, color: 'var(--text-muted)' },
  addLabel: { fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)' },

  card: {
    borderRadius:  8,
    border:        '1px solid var(--border)',
    overflow:      'hidden',
    background:    'var(--card)',
    display:       'flex',
    flexDirection: 'column',
    transition:    'box-shadow 0.2s',
  },
  imgWrap: { aspectRatio: '4/3', overflow: 'hidden', background: 'var(--bg)' },
  img:     { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },

  cardFoot: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    padding:        '10px 12px',
    gap:            8,
    borderTop:      '1px solid var(--border)',
  },

  editForm:  { flex: 1, display: 'flex' },
  nameInput: {
    flex:          1,
    background:    'var(--bg)',
    border:        '1px solid var(--border-light)',
    borderRadius:  3,
    padding:       '3px 6px',
    fontFamily:    'var(--font-mono)',
    fontSize:      11,
    color:         'var(--text)',
    outline:       'none',
    width:         '100%',
  },
  nameBtn: {
    background:    'none',
    border:        'none',
    padding:       0,
    fontFamily:    'var(--font-mono)',
    fontSize:      11,
    color:         'var(--text-secondary)',
    cursor:        'pointer',
    textAlign:     'left',
    flex:          1,
    overflow:      'hidden',
    textOverflow:  'ellipsis',
    whiteSpace:    'nowrap',
  },
  deleteBtn: {
    background:    'none',
    border:        'none',
    color:         'var(--text-muted)',
    fontSize:      16,
    cursor:        'pointer',
    padding:       '0 2px',
    lineHeight:    1,
    flexShrink:    0,
    transition:    'color 0.15s',
  },
}
