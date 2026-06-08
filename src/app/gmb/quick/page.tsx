'use client'

import { useEffect, useState, useRef, Suspense } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

// ── Types ──────────────────────────────────────────────────────────────────────

interface GmbStyle {
  id:            string
  location_name: string
  name:          string
  stars:         number
  apply_mask:    number | null
  style_text:    string
  override_text: string | null
}

interface BulkRow {
  name:      string
  stars:     number
  styleCode: string
  review:    string
}

interface BulkResult {
  row:   BulkRow
  reply: string | null
  error: string | null
}

type Length = 'recommended' | 'condense' | 'medium' | 'detailed'

const LENGTH_OPTIONS: { value: Length; label: string }[] = [
  { value: 'recommended', label: 'Auto' },
  { value: 'condense',    label: 'Short · ~250' },
  { value: 'medium',      label: 'Medium · ~500' },
  { value: 'detailed',    label: 'Long · ~750' },
]

const NUM_TO_STAR: Record<number, string> = { 1:'ONE', 2:'TWO', 3:'THREE', 4:'FOUR', 5:'FIVE' }

function starStr(n: number) { return '★'.repeat(n) + '☆'.repeat(5 - n) }

// ── CSV helpers ────────────────────────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
      else { inQuotes = !inQuotes }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current.trim())
  return result
}

function parseCSV(text: string): BulkRow[] {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const rows: BulkRow[] = []
  let startIdx = 0
  if (lines.length > 0) {
    const first = parseCSVLine(lines[0])
    const f0 = first[0]?.toLowerCase() ?? ''
    if (f0.includes('name') || f0.includes('reviewer') || isNaN(Number(first[1]?.trim()))) {
      startIdx = 1
    }
  }
  for (let i = startIdx; i < lines.length; i++) {
    const parts = parseCSVLine(lines[i])
    if (parts.length < 4) continue
    const name      = parts[0] ?? ''
    const stars     = Math.min(5, Math.max(1, parseInt(parts[1]) || 5))
    const styleCode = parts[2] ?? ''
    const review    = parts[3] ?? ''
    if (!review) continue
    rows.push({ name, stars, styleCode, review })
  }
  return rows
}

function resolveStyle(code: string, styles: GmbStyle[]): GmbStyle | null {
  const m = code.trim().match(/^#(\d+)$/i)
  if (!m) return null
  const idx = parseInt(m[1]) - 1
  return styles[idx] ?? null
}

function buildStyleHints(style: GmbStyle): string {
  const mask = style.apply_mask ?? (1 << (style.stars - 1))
  const base = `${style.name}||${style.stars}||${mask}||${style.style_text}`
  return style.override_text ? base + `\n\nCampaign instructions: ${style.override_text}` : base
}

function csvEscape(s: string): string {
  return `"${s.replace(/"/g, '""')}"`
}

// ── Inner component ────────────────────────────────────────────────────────────

function QuickReplyInner() {
  const router = useRouter()

  // Shared
  const [styles,        setStyles]        = useState<GmbStyle[]>([])
  const [loadingStyles, setLoadingStyles] = useState(true)
  const [error,         setError]         = useState('')

  // Mode
  const [bulkMode, setBulkMode] = useState(false)

  // Single mode
  const [reviewText, setReviewText] = useState('')
  const [stars,      setStars]      = useState(5)
  const [styleId,    setStyleId]    = useState('__none__')
  const [length,     setLength]     = useState<Length>('recommended')
  const [keywords,   setKeywords]   = useState('')
  const [context,    setContext]    = useState('')
  const [generating, setGenerating] = useState(false)
  const [replies,    setReplies]    = useState<string[]>([])
  const [copied,     setCopied]     = useState<number | null>(null)

  // Bulk mode
  const [bulkRows,       setBulkRows]       = useState<BulkRow[]>([])
  const [bulkResults,    setBulkResults]    = useState<BulkResult[]>([])
  const [bulkGenerating, setBulkGenerating] = useState(false)
  const [bulkProgress,   setBulkProgress]   = useState(0)
  const [bulkCopied,     setBulkCopied]     = useState<number | null>(null)
  const [dragOver,       setDragOver]       = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch('/api/gmb/styles')
      .then(r => r.json())
      .then(d => {
        if (d.error) { setError(d.error); return }
        setStyles(d.styles ?? [])
      })
      .catch(() => setError('Failed to load styles.'))
      .finally(() => setLoadingStyles(false))
  }, [])

  // ── Single mode ──────────────────────────────────────────────────────────────

  function buildPromptHints(): string {
    const style = styles.find(st => st.id === styleId)
    if (!style) return ''
    return buildStyleHints(style)
  }

  async function generate() {
    if (!reviewText.trim()) return
    setGenerating(true)
    setReplies([])
    setError('')
    try {
      const kws = keywords.split(',').map(k => k.trim()).filter(Boolean)
      const res = await fetch('/api/gmb/suggest-reply', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reviewText,
          reviewAuthor:       'Customer',
          starRating:         NUM_TO_STAR[stars],
          keywords:           kws,
          length,
          context:            context || undefined,
          customInstructions: '',
          promptHints:        buildPromptHints(),
          locationName:       styles.find(s => s.id === styleId)?.location_name,
        }),
      })
      const d = await res.json() as { replies?: string[]; error?: string }
      if (d.error) { setError(d.error); return }
      setReplies(d.replies ?? [])
    } catch {
      setError('Failed to generate. Please try again.')
    } finally {
      setGenerating(false)
    }
  }

  async function copy(text: string, idx: number) {
    await navigator.clipboard.writeText(text)
    setCopied(idx)
    setTimeout(() => setCopied(null), 2000)
  }

  // ── Bulk mode ────────────────────────────────────────────────────────────────

  function handleFileLoad(text: string) {
    const rows = parseCSV(text)
    setBulkRows(rows)
    setBulkResults([])
    setBulkProgress(0)
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => handleFileLoad(ev.target?.result as string)
    reader.readAsText(file)
    e.target.value = ''
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => handleFileLoad(ev.target?.result as string)
    reader.readAsText(file)
  }

  function downloadTemplate() {
    const lines = [
      'reviewer_name,stars,style_code,review_text',
      '"John S.",5,#1,"Great food and service! The staff was incredibly friendly."',
      '"Mary K.",4,#2,"Nice atmosphere but a bit slow during peak hours."',
      '"Alex T.",3,#1,"Food was okay, nothing special. Would try again."',
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = 'bulk_reply_template.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  async function generateBulk() {
    if (bulkRows.length === 0) return
    setBulkGenerating(true)
    setBulkProgress(0)
    setBulkResults([])
    const results: BulkResult[] = []
    for (let i = 0; i < bulkRows.length; i++) {
      const row   = bulkRows[i]
      const style = resolveStyle(row.styleCode, styles)
      const hints = style ? buildStyleHints(style) : ''
      try {
        const res = await fetch('/api/gmb/suggest-reply', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reviewText:         row.review,
            reviewAuthor:       row.name || 'Customer',
            starRating:         NUM_TO_STAR[row.stars] ?? 'FIVE',
            keywords:           [],
            length:             'recommended',
            context:            '',
            customInstructions: '',
            promptHints:        hints,
            locationName:       style?.location_name,
          }),
        })
        const d = await res.json() as { replies?: string[]; error?: string }
        results.push({ row, reply: d.replies?.[0] ?? null, error: d.error ?? null })
      } catch {
        results.push({ row, reply: null, error: 'Network error' })
      }
      setBulkProgress(i + 1)
      setBulkResults([...results])
    }
    setBulkGenerating(false)
  }

  async function copyBulk(text: string, idx: number) {
    await navigator.clipboard.writeText(text)
    setBulkCopied(idx)
    setTimeout(() => setBulkCopied(null), 2000)
  }

  function exportResults() {
    const lines = ['reviewer_name,stars,style_code,review_text,generated_reply']
    for (const r of bulkResults) {
      lines.push([
        csvEscape(r.row.name),
        String(r.row.stars),
        r.row.styleCode,
        csvEscape(r.row.review),
        r.reply ? csvEscape(r.reply) : '""',
      ].join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = 'bulk_replies.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const hasReview = reviewText.trim().length > 0
  const doneCount = bulkResults.filter(r => r.reply).length
  const allDone   = bulkResults.length === bulkRows.length && bulkRows.length > 0 && !bulkGenerating

  // ── Render ───────────────────────────────────────────────────────────────────

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
        <span style={s.navCrumb}>Quick Reply</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Link href="/gmb/train" className="btn btn-ghost" style={{ fontSize: 10, padding: '5px 12px' }}>
            My Styles
          </Link>
          <Link href="/gmb/dashboard" className="btn btn-ghost" style={{ fontSize: 10, padding: '5px 12px' }}>
            Dashboard
          </Link>
        </div>
      </nav>

      {/* Mode toggle */}
      <div style={s.modeBar}>
        <div style={s.modeTabs}>
          <button
            onClick={() => setBulkMode(false)}
            style={{ ...s.modeTab, ...(bulkMode ? {} : s.modeTabActive) }}
          >
            Single Reply
          </button>
          <button
            onClick={() => setBulkMode(true)}
            style={{ ...s.modeTab, ...(bulkMode ? s.modeTabBulkActive : s.modeTabBulk) }}
          >
            ⚡ Bulk Generate
          </button>
        </div>
      </div>

      {bulkMode ? (
        /* ── BULK MODE ─────────────────────────────────────────────────────── */
        <div style={s.bulkWrap}>

          {/* Header */}
          <div style={s.bulkHeader}>
            <p style={s.panelEyebrow}>Bulk Generate</p>
            <h2 style={s.panelTitle}>Generate replies for multiple reviews at once</h2>
          </div>

          {/* Style legend */}
          {!loadingStyles && styles.length > 0 && (
            <div style={s.legendCard}>
              <p style={{ ...s.fieldLabel, marginBottom: 12 }}>Style codes — use these in your CSV</p>
              <div style={s.legendGrid}>
                {styles.map((st, i) => (
                  <div key={st.id} style={s.legendItem}>
                    <span style={s.legendCode}>#{i + 1}</span>
                    <span style={s.legendName}>{st.name}</span>
                    <span style={s.legendStars}>{starStr(st.stars)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Upload card */}
          <div style={s.uploadCard}>
            <div style={s.uploadTop}>
              <div>
                <p style={{ ...s.fieldLabel, marginBottom: 8 }}>CSV format</p>
                <p style={s.csvFmt}>
                  <code style={s.code}>reviewer_name</code>
                  <span style={s.csvComma}>,</span>
                  <code style={s.code}>stars</code>
                  <span style={s.csvComma}>,</span>
                  <code style={s.code}>style_code</code>
                  <span style={s.csvComma}>,</span>
                  <code style={s.code}>review_text</code>
                </p>
                <p style={s.csvNote}>
                  Use <code style={s.code}>#1</code>, <code style={s.code}>#2</code>… as style codes matching the legend above.
                  One reply is generated per row.
                </p>
              </div>
              <button
                onClick={downloadTemplate}
                className="btn btn-ghost"
                style={{ fontSize: 10, padding: '8px 16px', whiteSpace: 'nowrap', flexShrink: 0, alignSelf: 'flex-start' }}
              >
                ↓ Download Template
              </button>
            </div>

            {/* Drop zone */}
            <div
              style={{ ...s.dropZone, ...(dragOver ? s.dropZoneOver : {}) }}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
            >
              <div style={s.dropIcon}>📄</div>
              <p style={s.dropTitle}>
                {bulkRows.length > 0
                  ? `${bulkRows.length} row${bulkRows.length !== 1 ? 's' : ''} loaded — drop another to replace`
                  : 'Drop your CSV here, or click to browse'}
              </p>
              <p style={s.dropHint}>.csv files only</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                style={{ display: 'none' }}
                onChange={onFileChange}
              />
            </div>
          </div>

          {/* Preview table */}
          {bulkRows.length > 0 && bulkResults.length === 0 && !bulkGenerating && (
            <div style={s.previewCard}>
              <div style={s.previewHeader}>
                <p style={{ ...s.fieldLabel, marginBottom: 0 }}>{bulkRows.length} review{bulkRows.length !== 1 ? 's' : ''} ready to process</p>
                <button
                  onClick={generateBulk}
                  className="btn btn-gold"
                  style={{ fontSize: 12, padding: '11px 28px' }}
                >
                  Generate {bulkRows.length} Repl{bulkRows.length !== 1 ? 'ies' : 'y'} →
                </button>
              </div>
              <div style={s.tableWrap}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      <th style={s.th}>#</th>
                      <th style={s.th}>Name</th>
                      <th style={s.th}>Stars</th>
                      <th style={s.th}>Style</th>
                      <th style={s.th}>Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bulkRows.map((row, i) => {
                      const resolved = resolveStyle(row.styleCode, styles)
                      const invalid  = row.styleCode && !resolved
                      return (
                        <tr key={i} style={i % 2 === 0 ? s.trEven : s.trOdd}>
                          <td style={{ ...s.td, color: 'var(--text-muted)', width: 32 }}>{i + 1}</td>
                          <td style={s.td}>{row.name || <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                          <td style={{ ...s.td, color: '#f59e0b', letterSpacing: -1 }}>{starStr(row.stars)}</td>
                          <td style={s.td}>
                            <span style={{ ...s.stylePill, ...(invalid ? s.stylePillErr : {}) }}>
                              {row.styleCode || <span style={{ color: 'var(--text-muted)' }}>none</span>}
                              {resolved && <span style={{ color: 'var(--text-muted)' }}> · {resolved.name}</span>}
                              {invalid   && <span style={{ color: 'var(--error)' }}> ✗ not found</span>}
                            </span>
                          </td>
                          <td style={{ ...s.td, maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {row.review.slice(0, 90)}{row.review.length > 90 ? '…' : ''}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Progress */}
          {(bulkGenerating || (bulkResults.length > 0 && !allDone)) && (
            <div style={s.progressCard}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <p style={{ ...s.fieldLabel, marginBottom: 0 }}>Generating replies…</p>
                <span style={s.progressCount}>{bulkProgress} / {bulkRows.length}</span>
              </div>
              <div style={s.progressTrack}>
                <div style={{ ...s.progressFill, width: `${(bulkProgress / bulkRows.length) * 100}%` }} />
              </div>
            </div>
          )}

          {/* Results */}
          {bulkResults.length > 0 && (
            <div style={s.resultsCard}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <p style={{ ...s.fieldLabel, marginBottom: 0 }}>
                  {doneCount} / {bulkRows.length} repl{bulkRows.length !== 1 ? 'ies' : 'y'} generated
                </p>
                {allDone && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={() => { setBulkRows([]); setBulkResults([]); setBulkProgress(0) }}
                      className="btn btn-ghost"
                      style={{ fontSize: 10, padding: '7px 14px' }}
                    >
                      ↺ New batch
                    </button>
                    <button
                      onClick={exportResults}
                      className="btn btn-gold"
                      style={{ fontSize: 10, padding: '7px 18px' }}
                    >
                      ↓ Export CSV
                    </button>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {bulkResults.map((r, i) => (
                  <div key={i} style={s.bulkResultRow}>
                    <div style={s.bulkResultMeta}>
                      <span style={s.bulkResultNum}>{i + 1}</span>
                      <span style={s.bulkResultName}>{r.row.name || 'Customer'}</span>
                      <span style={{ color: '#f59e0b', fontSize: 11, letterSpacing: -1 }}>{starStr(r.row.stars)}</span>
                      {r.row.styleCode && <span style={s.bulkResultCode}>{r.row.styleCode}</span>}
                    </div>
                    {r.reply ? (
                      <div style={s.bulkResultBody}>
                        <p style={s.bulkReplyText}>{r.reply}</p>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                          <button
                            onClick={() => copyBulk(r.reply!, i)}
                            className="btn btn-ghost"
                            style={{
                              fontSize: 10, padding: '5px 16px',
                              ...(bulkCopied === i ? { background: 'rgba(22,163,74,0.07)', borderColor: 'rgba(22,163,74,0.3)', color: 'var(--success)' } : {}),
                            }}
                          >
                            {bulkCopied === i ? '✓ Copied' : 'Copy'}
                          </button>
                        </div>
                      </div>
                    ) : r.error ? (
                      <p style={s.bulkResultError}>⚠ {r.error}</p>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 20px' }}>
                        <div style={{ ...s.spinner, width: 14, height: 14, borderWidth: 1.5 }} />
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>Generating…</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
      ) : (
        /* ── SINGLE MODE ───────────────────────────────────────────────────── */
        <div style={s.layout}>

          {/* Input panel */}
          <div style={s.inputPanel}>
            <p style={s.panelEyebrow}>Step 1 · Input</p>
            <h2 style={s.panelTitle}>Paste the review</h2>

            <textarea
              value={reviewText}
              onChange={e => setReviewText(e.target.value)}
              placeholder="Paste your customer's review here…"
              style={s.reviewTextarea}
              rows={6}
            />

            {/* Stars */}
            <p style={s.fieldLabel}>Star rating</p>
            <div style={s.starRow}>
              {[1,2,3,4,5].map(n => (
                <button key={n} onClick={() => setStars(n)}
                  style={{ ...s.starBtn, color: n <= stars ? '#f59e0b' : 'var(--border)' }}>
                  ★
                </button>
              ))}
              <span style={s.starHint}>{stars} star{stars !== 1 ? 's' : ''}</span>
            </div>

            {/* Style */}
            <p style={{ ...s.fieldLabel, marginTop: 16 }}>Reply style</p>
            {loadingStyles ? (
              <div style={s.spinner} />
            ) : styles.length === 0 ? (
              <div style={s.noStyleBox}>
                <span style={s.noStyleText}>No saved styles yet</span>
                <Link href="/gmb/train" style={s.trainLink}>+ Train a style →</Link>
              </div>
            ) : (
              <select
                value={styleId}
                onChange={e => {
                  if (e.target.value === '__create__') { router.push('/gmb/train'); return }
                  setStyleId(e.target.value)
                }}
                style={s.select}
              >
                <option value="__none__">No style · generic</option>
                {styles.map(st => (
                  <option key={st.id} value={st.id}>
                    {st.name} {starStr(st.stars)}{st.override_text ? ' · campaign' : ''}
                  </option>
                ))}
                <option disabled>──────────</option>
                <option value="__create__">Create A New Style</option>
              </select>
            )}

            {/* Length */}
            <p style={{ ...s.fieldLabel, marginTop: 18 }}>Reply length</p>
            <div style={s.lengthGroup}>
              {LENGTH_OPTIONS.map(opt => (
                <button key={opt.value} onClick={() => setLength(opt.value)}
                  style={{ ...s.lengthBtn, ...(length === opt.value ? s.lengthBtnActive : {}) }}>
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Keywords */}
            <p style={{ ...s.fieldLabel, marginTop: 18 }}>
              Keywords <span style={s.optional}>· optional</span>
            </p>
            <input
              type="text"
              value={keywords}
              onChange={e => setKeywords(e.target.value)}
              placeholder="loyalty program, happy hour (comma-separated)"
              style={s.input}
            />

            {/* Context */}
            <p style={{ ...s.fieldLabel, marginTop: 12 }}>
              Context <span style={s.optional}>· optional</span>
            </p>
            <input
              type="text"
              value={context}
              onChange={e => setContext(e.target.value)}
              placeholder="e.g. We had a special promotion that weekend"
              style={s.input}
            />

            {error && <div style={s.errorBanner}>⚠ {error}</div>}

            <button
              onClick={generate}
              disabled={generating || !hasReview}
              className="btn btn-gold"
              style={{ width: '100%', marginTop: 20, fontSize: 13, padding: '13px 0', opacity: hasReview ? 1 : 0.45, cursor: hasReview ? 'pointer' : 'not-allowed' }}
            >
              {generating ? 'Generating…' : 'Generate Replies →'}
            </button>
          </div>

          {/* Results panel */}
          <div style={s.resultsPanel}>
            <p style={s.panelEyebrow}>Step 2 · Pick & copy</p>
            <h2 style={s.panelTitle}>Your replies</h2>

            {generating ? (
              <div style={s.loadWrap}>
                <div style={{ ...s.spinner, width: 30, height: 30, borderWidth: 3 }} />
                <p style={s.loadText}>Crafting replies in your style…</p>
              </div>
            ) : replies.length === 0 ? (
              <div style={s.emptyResults}>
                <div style={s.emptyIcon}>◎</div>
                <p style={s.emptyTitle}>Replies appear here</p>
                <p style={s.emptyDesc}>
                  Paste a customer review and click <strong>Generate Replies</strong> to get 5 tailored options in your voice.
                </p>
              </div>
            ) : (
              <div>
                <div style={s.repliesList}>
                  {replies.map((reply, i) => {
                    const isCopied = copied === i
                    return (
                      <div key={i} style={s.replyCard}>
                        <div style={s.replyHeader}>
                          <span style={s.replyNum}>Option {i + 1}</span>
                          <span style={s.charCount}>{reply.length} chars</span>
                        </div>
                        <p style={s.replyText}>{reply}</p>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                          <button
                            onClick={() => copy(reply, i)}
                            className="btn btn-ghost"
                            style={{
                              fontSize: 11, padding: '6px 18px',
                              ...(isCopied ? { background: 'rgba(22,163,74,0.07)', borderColor: 'rgba(22,163,74,0.3)', color: 'var(--success)' } : {}),
                            }}
                          >
                            {isCopied ? '✓ Copied' : 'Copy'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
                <button
                  onClick={generate}
                  disabled={generating}
                  className="btn btn-ghost"
                  style={{ width: '100%', fontSize: 11, marginTop: 10 }}
                >
                  ↻ Regenerate all
                </button>
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  )
}

export default function QuickReplyPage() {
  return (
    <Suspense>
      <QuickReplyInner />
    </Suspense>
  )
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page:         { minHeight: '100vh', background: 'var(--bg)', position: 'relative' },
  glow:         { position: 'fixed', top: 0, left: '50%', transform: 'translateX(-50%)', width: 900, height: 220, background: 'radial-gradient(ellipse, var(--orange-glow) 0%, transparent 70%)', pointerEvents: 'none', filter: 'blur(50px)', zIndex: 0 },

  nav:          { position: 'sticky', top: 0, zIndex: 50, display: 'flex', alignItems: 'center', gap: 8, padding: '14px 24px', borderBottom: '1px solid var(--border)', background: 'rgba(244,246,250,0.92)', backdropFilter: 'blur(12px)' },
  navBrand:     { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text)', textDecoration: 'none' },
  navIcon:      { color: 'var(--orange)', fontSize: 18 },
  navName:      { fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 700, color: 'var(--text)' },
  navSep:       { color: 'var(--text-muted)', fontSize: 16 },
  navLink:      { fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--orange)', textDecoration: 'none' },
  navCrumb:     { fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)' },

  // Mode toggle
  modeBar:         { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px 24px 0', position: 'relative', zIndex: 1 },
  modeTabs:        { display: 'inline-flex', gap: 0, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, padding: 4, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' },
  modeTab:         { padding: '9px 22px', fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.06em', background: 'transparent', border: 'none', borderRadius: 7, cursor: 'pointer', color: 'var(--text-muted)', transition: 'all 0.15s' },
  modeTabActive:   { background: 'var(--surface)', color: 'var(--text)', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' },
  modeTabBulk:     { color: 'var(--orange)', opacity: 0.7 },
  modeTabBulkActive: { background: 'rgba(242,56,1,0.09)', color: 'var(--orange)', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' },

  // Single mode layout
  layout:       { display: 'grid', gridTemplateColumns: '420px 1fr', gap: 32, maxWidth: 1120, margin: '0 auto', padding: '28px 24px 36px', position: 'relative', zIndex: 1 },
  inputPanel:   { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '28px 28px 32px', boxShadow: '0 2px 12px rgba(0,0,0,0.05)', display: 'flex', flexDirection: 'column' },
  resultsPanel: { display: 'flex', flexDirection: 'column' },

  // Bulk mode layout
  bulkWrap:     { maxWidth: 860, margin: '0 auto', padding: '28px 24px 48px', position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', gap: 16 },
  bulkHeader:   { marginBottom: 4 },

  panelEyebrow: { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--orange)', marginBottom: 6 },
  panelTitle:   { fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, color: 'var(--text)', marginBottom: 0 },

  // Style legend
  legendCard:   { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, padding: '18px 20px' },
  legendGrid:   { display: 'flex', flexWrap: 'wrap', gap: 8 },
  legendItem:   { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6 },
  legendCode:   { fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--orange)' },
  legendName:   { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)' },
  legendStars:  { fontFamily: 'var(--font-mono)', fontSize: 10, color: '#f59e0b', letterSpacing: -1 },

  // Upload card
  uploadCard:   { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, padding: '20px 22px' },
  uploadTop:    { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 16 },
  csvFmt:       { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 8, flexWrap: 'wrap' as const },
  csvComma:     { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', margin: '0 2px' },
  csvNote:      { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6 },
  code:         { fontFamily: 'var(--font-mono)', fontSize: 10, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 5px', color: 'var(--text-secondary)' },

  dropZone:     { border: '2px dashed var(--border)', borderRadius: 8, padding: '32px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, cursor: 'pointer', transition: 'all 0.15s', userSelect: 'none' as const },
  dropZoneOver: { borderColor: 'var(--orange)', background: 'rgba(242,56,1,0.03)' },
  dropIcon:     { fontSize: 28, marginBottom: 4 },
  dropTitle:    { fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 600, color: 'var(--text)' },
  dropHint:     { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' },

  // Preview table
  previewCard:   { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, padding: '18px 20px' },
  previewHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  tableWrap:     { overflowX: 'auto' as const, borderRadius: 6 },
  table:         { width: '100%', borderCollapse: 'collapse' as const, fontFamily: 'var(--font-mono)', fontSize: 11 },
  th:            { padding: '8px 12px', textAlign: 'left' as const, fontWeight: 600, fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'var(--text-muted)', background: 'var(--surface)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' as const },
  td:            { padding: '9px 12px', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)', verticalAlign: 'top' as const },
  trEven:        {},
  trOdd:         { background: 'rgba(0,0,0,0.015)' },
  stylePill:     { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 10, color: 'var(--text-secondary)' },
  stylePillErr:  { borderColor: 'rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.04)' },

  // Progress
  progressCard:  { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, padding: '18px 22px' },
  progressCount: { fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--orange)' },
  progressTrack: { height: 5, background: 'var(--surface)', borderRadius: 99, overflow: 'hidden' },
  progressFill:  { height: '100%', background: 'var(--orange)', borderRadius: 99, transition: 'width 0.3s ease' },

  // Bulk results
  resultsCard:      { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, padding: '18px 20px' },
  bulkResultRow:    { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' },
  bulkResultMeta:   { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'rgba(0,0,0,0.02)' },
  bulkResultNum:    { fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, color: 'var(--orange)', background: 'rgba(242,56,1,0.08)', padding: '2px 7px', borderRadius: 4 },
  bulkResultName:   { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)', fontWeight: 600 },
  bulkResultCode:   { fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', background: 'var(--border)', padding: '2px 6px', borderRadius: 4 },
  bulkResultBody:   { padding: '14px 16px' },
  bulkReplyText:    { color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.8, margin: 0 },
  bulkResultError:  { padding: '14px 16px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--error)', margin: 0 },

  // Single mode shared
  reviewTextarea: { width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.75, outline: 'none', resize: 'vertical', marginBottom: 20, boxSizing: 'border-box' as const },
  fieldLabel:   { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8, display: 'block' },
  optional:     { textTransform: 'none', letterSpacing: 0, fontStyle: 'italic', fontWeight: 400 },
  starRow:      { display: 'flex', alignItems: 'center', gap: 2, marginBottom: 0 },
  starBtn:      { background: 'none', border: 'none', cursor: 'pointer', fontSize: 26, padding: '0 1px', transition: 'color 0.1s', lineHeight: 1 },
  starHint:     { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', marginLeft: 8 },
  select:       { width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 11, outline: 'none', cursor: 'pointer' },
  noStyleBox:   { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: 'var(--surface)', border: '1px dashed var(--border)', borderRadius: 6 },
  noStyleText:  { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' },
  trainLink:    { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--orange)', textDecoration: 'none', whiteSpace: 'nowrap' as const },
  lengthGroup:     { display: 'flex', gap: 6, flexWrap: 'wrap' as const },
  lengthBtn:       { padding: '6px 12px', fontFamily: 'var(--font-mono)', fontSize: 10, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 5, cursor: 'pointer', color: 'var(--text-muted)', transition: 'all 0.15s', whiteSpace: 'nowrap' as const },
  lengthBtnActive: { background: 'rgba(242,56,1,0.08)', borderColor: 'var(--orange)', color: 'var(--orange)' },
  input:        { width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 11, outline: 'none', boxSizing: 'border-box' as const },
  errorBanner:  { marginTop: 16, background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 6, padding: '10px 14px', color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'var(--font-mono)' },
  spinner:      { width: 22, height: 22, border: '2px solid var(--border)', borderTopColor: 'var(--orange)', borderRadius: '50%', animation: 'spin 0.8s linear infinite', flexShrink: 0 },
  loadWrap:     { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, flex: 1, minHeight: 320, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: 40 },
  loadText:     { fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)' },
  emptyResults: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', flex: 1, minHeight: 320, background: 'var(--card)', border: '1px dashed var(--border)', borderRadius: 12, padding: 48 },
  emptyIcon:    { fontSize: 40, color: 'var(--border)', marginBottom: 18, lineHeight: 1 },
  emptyTitle:   { fontFamily: 'var(--font-display)', fontSize: 19, fontWeight: 600, color: 'var(--text)', marginBottom: 10 },
  emptyDesc:    { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.75, maxWidth: 280 },
  repliesList:  { display: 'flex', flexDirection: 'column', gap: 12 },
  replyCard:    { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, padding: '18px 20px', display: 'flex', flexDirection: 'column', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' },
  replyHeader:  { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  replyNum:     { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--orange)' },
  charCount:    { fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)' },
  replyText:    { color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.8 },
}
