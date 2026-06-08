'use client'

/**
 * Shared components for Environment and Combo transform pages.
 * The food (Studio) page keeps its own inline copies — these are separate.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import type { SavedReference } from '@/types'

export { type SavedReference }

// ── Image compression ─────────────────────────────────────────────────────────

export async function compressImage(file: File | Blob, maxPx = 1280): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new window.Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height))
      const w = Math.round(img.width  * scale)
      const h = Math.round(img.height * scale)
      const canvas = document.createElement('canvas')
      canvas.width  = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('Canvas unavailable')); return }
      ctx.drawImage(img, 0, 0, w, h)
      canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error('Compression failed')),
        'image/jpeg',
        0.88,
      )
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')) }
    img.src = url
  })
}

// ── Direction levels (shared across all analysis panels) ─────────────────────

export const DIRECTION_LEVELS = [
  { value: 'decrease',          label: '−' },
  { value: 'slightly decrease', label: '↓' },
  { value: 'keep moderate',     label: '○' },
  { value: 'slightly increase', label: '↑' },
  { value: 'increase',          label: '+' },
] as const

// ── Spinner ───────────────────────────────────────────────────────────────────

export function Spinner() {
  return (
    <div style={{
      width: 24, height: 24, borderRadius: '50%',
      border: '2px solid var(--border)',
      borderTopColor: 'var(--gold)',
      animation: 'spin 0.8s linear infinite',
    }} />
  )
}

// ── Drop zone ─────────────────────────────────────────────────────────────────

export function DropZone({
  label, hint, file, onFile, disabled,
}: {
  label:    string
  hint:     string
  file:     File | null
  onFile:   (f: File) => void
  disabled: boolean
}) {
  const [dragging, setDragging] = useState(false)
  const [preview,  setPreview]  = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!file) { setPreview(null); return }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (disabled) return
    const f = e.dataTransfer.files[0]
    if (f && f.type.startsWith('image/')) onFile(f)
  }, [disabled, onFile])

  const borderColor = dragging ? 'var(--gold-dim)' : file ? 'var(--border-light)' : 'var(--border)'
  const bg = dragging ? 'var(--card-hover)' : 'var(--card)'

  return (
    <div
      style={{ ...sz.zone, borderColor, background: bg, cursor: disabled ? 'default' : 'pointer' }}
      onClick={() => !disabled && inputRef.current?.click()}
      onDragOver={e => { e.preventDefault(); if (!disabled) setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f) }}
      />
      {preview ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt={label} style={sz.zonePreview} />
          <div style={sz.zoneBadge}>{label}</div>
        </>
      ) : (
        <div style={sz.zonePlaceholder}>
          <span style={sz.zonePlus}>+</span>
          <span style={sz.zoneLabel}>{label}</span>
          <span style={sz.zoneHint}>{hint}</span>
          <span style={sz.zoneFormats}>JPEG · PNG · WEBP</span>
        </div>
      )}
    </div>
  )
}

// ── Reference zone ────────────────────────────────────────────────────────────

export function ReferenceZone({
  file, savedRef, onFile, onSelectSavedRef, savedRefs, disabled,
}: {
  file:             File | null
  savedRef:         SavedReference | null
  onFile:           (f: File) => void
  onSelectSavedRef: (r: SavedReference) => void
  savedRefs:        SavedReference[]
  disabled:         boolean
}) {
  const [mode,     setMode]     = useState<'upload' | 'saved'>('upload')
  const [dragging, setDragging] = useState(false)
  const [preview,  setPreview]  = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!file) { setPreview(null); return }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (disabled) return
    const f = e.dataTransfer.files[0]
    if (f && f.type.startsWith('image/')) { onFile(f); setMode('upload') }
  }, [disabled, onFile])

  const activePreview = mode === 'upload' ? preview : (savedRef?.image_url ?? null)
  const hasSelection  = mode === 'upload' ? !!file  : !!savedRef
  const borderColor   = dragging ? 'var(--gold-dim)' : hasSelection ? 'var(--border-light)' : 'var(--border)'
  const bg = dragging ? 'var(--card-hover)' : 'var(--card)'

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 0, minHeight: 320 }}>
      {/* Tab bar */}
      <div style={rz.tabs}>
        <button style={{ ...rz.tab, ...(mode === 'upload' ? rz.tabActive : {}) }} onClick={() => setMode('upload')} disabled={disabled}>Upload</button>
        <button style={{ ...rz.tab, ...(mode === 'saved' ? rz.tabActive : {}) }} onClick={() => setMode('saved')} disabled={disabled}>
          Saved {savedRefs.length > 0 && `(${savedRefs.length})`}
        </button>
      </div>

      {/* Upload mode */}
      {mode === 'upload' && (
        <div
          style={{ ...sz.zone, borderColor, background: bg, cursor: disabled ? 'default' : 'pointer', borderTopLeftRadius: 0, borderTopRightRadius: 0 }}
          onClick={() => !disabled && inputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); if (!disabled) setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) { onFile(f); setMode('upload') } }} />
          {activePreview ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={activePreview} alt="Style Reference" style={sz.zonePreview} />
              <div style={sz.zoneBadge}>Style Reference</div>
            </>
          ) : (
            <div style={sz.zonePlaceholder}>
              <span style={sz.zonePlus}>+</span>
              <span style={sz.zoneLabel}>Style Reference</span>
              <span style={sz.zoneHint}>The look you want to apply</span>
              <span style={sz.zoneFormats}>JPEG · PNG · WEBP</span>
            </div>
          )}
        </div>
      )}

      {/* Saved mode */}
      {mode === 'saved' && (
        <div style={rz.savedPanel}>
          {savedRefs.length === 0 ? (
            <div style={rz.savedEmpty}>
              <span style={{ fontSize: 22, color: 'var(--border-light)' }}>◈</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
                No saved references.{' '}
                <button style={{ background: 'none', border: 'none', color: 'var(--orange)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11, padding: 0 }} onClick={() => setMode('upload')}>Upload one</button>
                {' '}or{' '}
                <a href="/references" style={{ color: 'var(--orange)' }}>manage references →</a>
              </span>
            </div>
          ) : (
            <div style={rz.savedGrid}>
              {savedRefs.map(ref => {
                const isSelected = savedRef?.id === ref.id
                return (
                  <div key={ref.id}
                    style={{ ...rz.savedItem, borderColor: isSelected ? 'var(--orange)' : 'var(--border)', boxShadow: isSelected ? '0 0 0 2px rgba(242,56,1,0.25)' : 'none' }}
                    onClick={() => !disabled && onSelectSavedRef(ref)}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={ref.image_url} alt={ref.name} style={rz.savedThumb} />
                    <span style={rz.savedName}>{ref.name}</span>
                    {isSelected && <div style={rz.selectedBadge}>✓</div>}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {mode === 'saved' && savedRef && (
        <div style={rz.savedPreviewBar}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={savedRef.image_url} alt={savedRef.name} style={rz.savedPreviewThumb} />
          <span style={rz.savedPreviewName}>{savedRef.name} selected</span>
        </div>
      )}
    </div>
  )
}

// ── Shared styles ─────────────────────────────────────────────────────────────

export const sz: Record<string, React.CSSProperties> = {
  page: {
    minHeight:       '100vh',
    background:      'var(--bg)',
    color:           'var(--text)',
    fontFamily:      'var(--font-mono)',
  },
  main: {
    maxWidth:        840,
    margin:          '0 auto',
    padding:         '48px 24px 80px',
    display:         'flex',
    flexDirection:   'column',
    alignItems:      'center',
    gap:             40,
  },
  hero: {
    textAlign:       'center',
    width:           '100%',
  },
  heroTitle: {
    fontFamily:      'var(--font-display)',
    fontSize:        48,
    fontWeight:      300,
    letterSpacing:   '0.04em',
    color:           'var(--text)',
    marginBottom:    16,
    lineHeight:      1.1,
  },
  heroSub: {
    color:           'var(--text-muted)',
    fontSize:        13,
    letterSpacing:   '0.04em',
    lineHeight:      1.6,
    maxWidth:        480,
    margin:          '0 auto',
  },
  uploadRow: {
    display:         'flex',
    gap:             24,
    width:           '100%',
    alignItems:      'flex-start',
  },
  arrowCol: {
    display:         'flex',
    alignItems:      'center',
    justifyContent:  'center',
    paddingTop:      140,
    flexShrink:      0,
  },
  arrowGlyph: {
    fontSize:        24,
    color:           'var(--border-light)',
    fontFamily:      'var(--font-mono)',
  },
  zone: {
    flex:            1,
    minHeight:       320,
    border:          '1px dashed',
    borderRadius:    6,
    display:         'flex',
    alignItems:      'center',
    justifyContent:  'center',
    position:        'relative' as const,
    overflow:        'hidden',
    transition:      'border-color 0.15s, background 0.15s',
  },
  zonePreview: {
    width:           '100%',
    height:          '100%',
    objectFit:       'cover' as const,
    position:        'absolute' as const,
    inset:           0,
  },
  zoneBadge: {
    position:        'absolute' as const,
    bottom:          10,
    left:            10,
    background:      'rgba(15,17,23,0.75)',
    border:          '1px solid rgba(255,255,255,0.15)',
    borderRadius:    4,
    padding:         '3px 8px',
    fontSize:        9,
    letterSpacing:   '0.1em',
    textTransform:   'uppercase' as const,
    color:           'rgba(255,255,255,0.7)',
  },
  zonePlaceholder: {
    display:         'flex',
    flexDirection:   'column' as const,
    alignItems:      'center',
    gap:             8,
    padding:         24,
    textAlign:       'center' as const,
  },
  zonePlus: {
    fontSize:        28,
    color:           'var(--border-light)',
    lineHeight:      1,
  },
  zoneLabel: {
    fontSize:        12,
    letterSpacing:   '0.08em',
    color:           'var(--text-secondary)',
    textTransform:   'uppercase' as const,
  },
  zoneHint: {
    fontSize:        10,
    color:           'var(--text-muted)',
    letterSpacing:   '0.04em',
  },
  zoneFormats: {
    fontSize:        9,
    color:           'var(--border-light)',
    letterSpacing:   '0.1em',
    textTransform:   'uppercase' as const,
    marginTop:       4,
  },
  belowUpload: {
    display:         'flex',
    flexDirection:   'column' as const,
    alignItems:      'center',
    gap:             10,
    minHeight:       60,
  },
  progressWrap: {
    display:         'flex',
    flexDirection:   'column' as const,
    alignItems:      'center',
    gap:             14,
    textAlign:       'center' as const,
  },
  progressLabel: {
    color:           'var(--text-secondary)',
    fontSize:        12,
    letterSpacing:   '0.06em',
  },
  progressHint: {
    color:           'var(--text-muted)',
    fontSize:        10,
    letterSpacing:   '0.08em',
    textTransform:   'uppercase' as const,
  },
  errorWrap: {
    display:         'flex',
    flexDirection:   'column' as const,
    alignItems:      'center',
    gap:             4,
    textAlign:       'center' as const,
    maxWidth:        400,
  },
  errorMsg: {
    color:           'var(--error)',
    fontSize:        12,
    letterSpacing:   '0.02em',
  },
  result: {
    display:         'flex',
    flexDirection:   'column' as const,
    alignItems:      'center',
    gap:             32,
    width:           '100%',
    maxWidth:        840,
  },
  resultTitle: {
    fontFamily:      'var(--font-display)',
    fontSize:        36,
    fontWeight:      300,
    color:           'var(--text)',
    letterSpacing:   '0.03em',
    marginBottom:    10,
    textAlign:       'center' as const,
  },
  resultSub: {
    color:           'var(--text-muted)',
    fontSize:        12,
    letterSpacing:   '0.04em',
    textAlign:       'center' as const,
  },
  resultImgWrap: {
    position:        'relative' as const,
    width:           '100%',
    paddingBottom:   '62.5%',
    background:      'var(--surface)',
    borderRadius:    6,
    overflow:        'hidden',
    border:          '1px solid var(--border)',
  },
  resultActions: {
    display:         'flex',
    gap:             12,
    flexWrap:        'wrap' as const,
    justifyContent:  'center',
  },
  compareStrip: {
    display:         'flex',
    gap:             10,
    width:           '100%',
    overflowX:       'auto' as const,
    paddingBottom:   4,
  },
  compareItem: {
    display:         'flex',
    flexDirection:   'column' as const,
    alignItems:      'center',
    gap:             5,
    flexShrink:      0,
  },
  compareThumb: {
    width:           72,
    height:          72,
    objectFit:       'cover' as const,
    borderRadius:    4,
    border:          '1px solid var(--border)',
  },
  compareLabel: {
    fontSize:        9,
    letterSpacing:   '0.08em',
    textTransform:   'uppercase' as const,
    color:           'var(--text-muted)',
  },
  compareSub: {
    fontSize:        9,
    color:           'var(--border-light)',
    letterSpacing:   '0.06em',
  },
  refRow: {
    display:         'flex',
    alignItems:      'center',
    gap:             16,
    width:           '100%',
  },
  refLabel: {
    fontFamily:      'var(--font-mono)',
    fontSize:        10,
    letterSpacing:   '0.12em',
    textTransform:   'uppercase' as const,
    color:           'var(--text-muted)',
    flexShrink:      0,
  },
  refThumbWrap: {
    position:        'relative' as const,
    width:           72,
    height:          72,
    borderRadius:    4,
    overflow:        'hidden',
    border:          '1px solid var(--border)',
    cursor:          'pointer',
    flexShrink:      0,
  },
  refThumb: {
    width:           '100%',
    height:          '100%',
    objectFit:       'cover' as const,
    display:         'block',
  },
  refThumbEmpty: {
    width:           '100%',
    height:          '100%',
    display:         'flex',
    alignItems:      'center',
    justifyContent:  'center',
    background:      'var(--surface)',
    color:           'var(--border-light)',
    fontSize:        20,
  },
  refThumbOverlay: {
    position:        'absolute' as const,
    inset:           0,
    background:      'rgba(0,0,0,0)',
    display:         'flex',
    alignItems:      'center',
    justifyContent:  'center',
    transition:      'background 0.2s',
  },
  refHint: {
    color:           'var(--text-muted)',
    fontSize:        10,
    letterSpacing:   '0.04em',
    lineHeight:      1.5,
  },
  intensityWrap: {
    width:           '100%',
    display:         'flex',
    flexDirection:   'column' as const,
    gap:             8,
  },
  intensityHeader: {
    display:         'flex',
    justifyContent:  'space-between',
    alignItems:      'center',
  },
  intensityLabel: {
    fontFamily:      'var(--font-mono)',
    fontSize:        10,
    letterSpacing:   '0.1em',
    textTransform:   'uppercase' as const,
    color:           'var(--text-muted)',
  },
  intensityValue: {
    fontFamily:      'var(--font-mono)',
    fontSize:        13,
    color:           'var(--gold)',
  },
  intensitySlider: {
    width:           '100%',
    accentColor:     'var(--gold)',
    cursor:          'pointer',
    height:          2,
  },
  intensityHints: {
    display:         'flex',
    justifyContent:  'space-between',
    marginTop:       6,
    fontSize:        9,
    letterSpacing:   '0.08em',
    textTransform:   'uppercase' as const,
    color:           'var(--text-muted)',
  },

  // Analysis panel shared styles
  analysisPanel: {
    width:           '100%',
    background:      'var(--surface)',
    border:          '1px solid var(--border)',
    borderRadius:    6,
    overflow:        'hidden',
  },
  analysisPanelHeader: {
    display:         'flex',
    justifyContent:  'space-between',
    alignItems:      'center',
    padding:         '14px 16px',
    cursor:          'pointer',
    userSelect:      'none' as const,
  },
  analysisPanelLeft: {
    display:         'flex',
    alignItems:      'center',
    gap:             12,
  },
  analysisPanelTitle: {
    fontFamily:      'var(--font-mono)',
    fontSize:        10,
    letterSpacing:   '0.12em',
    textTransform:   'uppercase' as const,
    color:           'var(--text-secondary)',
  },
  analysisPanelBody: {
    padding:         '0 16px 16px',
    display:         'flex',
    flexDirection:   'column' as const,
    gap:             16,
    borderTop:       '1px solid var(--border)',
  },
  tagCloud: {
    display:         'flex',
    flexWrap:        'wrap' as const,
    gap:             6,
    paddingTop:      12,
  },
  tag: {
    padding:         '3px 8px',
    borderRadius:    3,
    fontSize:        9,
    letterSpacing:   '0.08em',
    textTransform:   'uppercase' as const,
    border:          '1px solid',
  },
  paramGrid: {
    display:         'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap:             10,
  },
  paramRow: {
    display:         'flex',
    flexDirection:   'column' as const,
    gap:             5,
    background:      'var(--card)',
    borderRadius:    4,
    padding:         '8px 10px',
    border:          '1px solid var(--border)',
  },
  paramName: {
    fontFamily:      'var(--font-mono)',
    fontSize:        8,
    letterSpacing:   '0.1em',
    textTransform:   'uppercase' as const,
    color:           'var(--text-muted)',
  },
  paramBtns: {
    display:         'flex',
    gap:             3,
  },
}

const rz: Record<string, React.CSSProperties> = {
  tabs: {
    display:       'flex',
    background:    'var(--card)',
    borderRadius:  '6px 6px 0 0',
    border:        '1px solid var(--border)',
    borderBottom:  'none',
    overflow:      'hidden',
  },
  tab: {
    flex:          1,
    padding:       '8px 12px',
    background:    'transparent',
    border:        'none',
    borderBottom:  '2px solid transparent',
    fontFamily:    'var(--font-mono)',
    fontSize:      9,
    letterSpacing: '0.1em',
    textTransform: 'uppercase' as const,
    color:         'var(--text-muted)',
    cursor:        'pointer',
    transition:    'color 0.15s, border-color 0.15s',
  },
  tabActive: {
    color:        'var(--orange)',
    borderBottom: '2px solid var(--orange)',
  },
  savedPanel: {
    flex:         1,
    border:       '1px solid var(--border)',
    borderTop:    'none',
    borderRadius: '0 0 6px 6px',
    background:   'var(--card)',
    overflowY:    'auto',
    minHeight:    280,
    padding:      12,
  },
  savedEmpty: {
    height:         '100%',
    minHeight:      240,
    display:        'flex',
    flexDirection:  'column' as const,
    alignItems:     'center',
    justifyContent: 'center',
    gap:            12,
  },
  savedGrid: {
    display:             'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap:                 8,
  },
  savedItem: {
    position:     'relative' as const,
    borderRadius: 4,
    border:       '1.5px solid var(--border)',
    overflow:     'hidden',
    cursor:       'pointer',
    transition:   'border-color 0.15s, box-shadow 0.15s',
    background:   'var(--bg)',
  },
  savedThumb: {
    width:       '100%',
    aspectRatio: '4/3',
    objectFit:   'cover' as const,
    display:     'block',
  },
  savedName: {
    display:       'block',
    padding:       '5px 7px',
    fontSize:      9,
    letterSpacing: '0.06em',
    color:         'var(--text-muted)',
    overflow:      'hidden',
    textOverflow:  'ellipsis',
    whiteSpace:    'nowrap' as const,
  },
  selectedBadge: {
    position:       'absolute' as const,
    top:            6,
    right:          6,
    background:     'var(--orange)',
    color:          '#fff',
    borderRadius:   '50%',
    width:          18,
    height:         18,
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    fontSize:       10,
  },
  savedPreviewBar: {
    display:       'flex',
    alignItems:    'center',
    gap:           10,
    padding:       '8px 10px',
    background:    'rgba(242,56,1,0.06)',
    border:        '1px solid rgba(242,56,1,0.2)',
    borderRadius:  '0 0 6px 6px',
    marginTop:     -1,
  },
  savedPreviewThumb: {
    width:        36,
    height:       36,
    objectFit:    'cover' as const,
    borderRadius: 3,
    border:       '1px solid var(--border)',
  },
  savedPreviewName: {
    fontSize:      10,
    letterSpacing: '0.06em',
    color:         'var(--orange)',
  },
}

// ── Quality badge ─────────────────────────────────────────────────────────────

export function QualityBadge({ score }: { score: number }) {
  const tier  = score >= 7 ? 'high' : score >= 4 ? 'mid' : 'low'
  const label = tier === 'high' ? 'High Quality' : tier === 'mid' ? 'Good' : 'Needs Work'
  const color = tier === 'high' ? 'var(--gold)' : tier === 'mid' ? 'var(--text-muted)' : 'var(--error)'
  return (
    <span style={{
      padding:       '2px 8px',
      borderRadius:  3,
      border:        `1px solid ${color}`,
      color,
      fontSize:      9,
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
      fontFamily:    'var(--font-mono)',
    }}>
      {label} {score}/10
    </span>
  )
}

// ── Parameter direction row ───────────────────────────────────────────────────

export function ParamRow({
  name, value, onChange,
}: {
  name:     string
  value:    string
  onChange: (v: string) => void
}) {
  return (
    <div style={sz.paramRow}>
      <span style={sz.paramName}>{name.replace(/_/g, ' ')}</span>
      <div style={sz.paramBtns}>
        {DIRECTION_LEVELS.map(d => (
          <button
            key={d.value}
            onClick={() => onChange(d.value)}
            style={{
              flex:          1,
              padding:       '4px 0',
              background:    value === d.value ? 'rgba(255,174,20,0.15)' : 'transparent',
              border:        `1px solid ${value === d.value ? 'var(--gold-dim)' : 'var(--border)'}`,
              borderRadius:  3,
              color:         value === d.value ? 'var(--gold)' : 'var(--text-muted)',
              fontFamily:    'var(--font-mono)',
              fontSize:      11,
              cursor:        'pointer',
              transition:    'all 0.12s',
              minWidth:      0,
            }}
          >
            {d.label}
          </button>
        ))}
      </div>
    </div>
  )
}
