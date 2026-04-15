'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Job, VideoJob } from '@/types'
import Image from 'next/image'
import { Suspense } from 'react'

type Filter = 'all' | 'photos' | 'videos'

const SHOWCASE_LABELS: Record<string, string> = {
  hero_push:  'Hero Push',
  orbit:      'Orbit',
  atmosphere: 'Atmosphere',
  dynamic:    'Dynamic',
}

export default function WorksClient({ jobs, videoJobs }: { jobs: Job[]; videoJobs: VideoJob[] }) {
  return (
    <Suspense>
      <WorksInner jobs={jobs} videoJobs={videoJobs} />
    </Suspense>
  )
}

function WorksInner({ jobs, videoJobs }: { jobs: Job[]; videoJobs: VideoJob[] }) {
  const router   = useRouter()
  const params   = useSearchParams()
  const supabase = createClient()
  const filter   = (params.get('filter') ?? 'all') as Filter

  async function signOut() {
    await supabase.auth.signOut()
    router.push('/auth')
    router.refresh()
  }

  function setFilter(f: Filter) {
    const p = new URLSearchParams(params.toString())
    if (f === 'all') p.delete('filter')
    else p.set('filter', f)
    router.replace(`/history?${p}`)
  }

  const donePhotos = jobs.filter(j => j.status === 'done')
  const doneVideos = videoJobs.filter(v => v.status === 'done')
  const totalDone  = donePhotos.length + doneVideos.length
  const totalOther = (jobs.length - donePhotos.length) + (videoJobs.length - doneVideos.length)

  const showPhotos = filter === 'all' || filter === 'photos'
  const showVideos = filter === 'all' || filter === 'videos'

  type AnyItem = { _type: 'photo'; data: Job } | { _type: 'video'; data: VideoJob }
  const items: AnyItem[] = [
    ...(showPhotos ? jobs.map(j     => ({ _type: 'photo' as const, data: j     })) : []),
    ...(showVideos ? videoJobs.map(v => ({ _type: 'video' as const, data: v })) : []),
  ].sort((a, b) =>
    new Date(b.data.created_at).getTime() - new Date(a.data.created_at).getTime()
  )

  return (
    <div style={s.page}>
      <main style={s.main}>
        {/* ── Page header ── */}
        <div style={s.pageHeader} className="animate-fade-up">
          <div>
            <p style={s.eyebrow}>Your workspace</p>
            <h1 style={s.title}>Works</h1>
          </div>
          <div style={s.headerStats}>
            {jobs.length + videoJobs.length > 0 && (
              <>
                <div style={s.statPill}>
                  <span style={{ ...s.statDot, background: 'var(--success)' }} />
                  {totalDone} completed
                </div>
                {totalOther > 0 && (
                  <div style={s.statPill}>
                    <span style={{ ...s.statDot, background: 'var(--warning)', animation: 'pulse-gold 1.5s ease-in-out infinite' }} />
                    {totalOther} in progress
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* ── Filter tabs ── */}
        {(jobs.length + videoJobs.length > 0) && (
          <div style={s.filterRow} className="animate-fade-up">
            {([
              ['all',    `All`,     jobs.length + videoJobs.length],
              ['photos', `Photos`,  jobs.length],
              ['videos', `Videos`,  videoJobs.length],
            ] as [Filter, string, number][]).map(([key, label, count]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                style={{
                  ...s.filterBtn,
                  ...(filter === key ? s.filterBtnActive : {}),
                }}
              >
                {label}
                <span style={{
                  ...s.filterCount,
                  ...(filter === key ? s.filterCountActive : {}),
                }}>
                  {count}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* ── Grid ── */}
        {items.length === 0 ? (
          <div style={s.empty} className="animate-fade-up">
            <div style={s.emptyIconWrap}>
              <span style={s.emptyIcon}>◈</span>
            </div>
            <p style={s.emptyTitle}>
              {filter === 'photos' ? 'No photo works yet.' :
               filter === 'videos' ? 'No video works yet.' :
               'Your works will appear here.'}
            </p>
            <p style={s.emptyDesc}>
              {filter === 'videos'
                ? 'Create a cinematic video from your dish photos.'
                : 'Apply AI style transfer to your food photography.'}
            </p>
            <a
              href={filter === 'videos' ? '/showcase' : '/'}
              className="btn btn-gold"
              style={{ marginTop: 8 }}
            >
              {filter === 'videos' ? 'Create Video' : 'Start Transforming'}
            </a>
          </div>
        ) : (
          <div style={s.grid}>
            {items.map((item, i) =>
              item._type === 'photo'
                ? <PhotoCard key={item.data.id} job={item.data}              index={i} />
                : <VideoCard key={item.data.id} job={item.data as VideoJob}  index={i} />
            )}
          </div>
        )}
      </main>
    </div>
  )
}

// ── Photo card ─────────────────────────────────────────────────────────────────

function PhotoCard({ job, index }: { job: Job; index: number }) {
  const date = new Date(job.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const time = new Date(job.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

  return (
    <div
      style={{ ...s.card, animationDelay: `${index * 40}ms` }}
      className="animate-fade-up"
    >
      <div style={s.cardHeader}>
        <span className="badge badge-default">
          <span style={{ color: 'var(--orange)' }}>◈</span> Photo
        </span>
        <span style={s.cardTime}>{date}</span>
      </div>

      <div style={s.imageRow}>
        <div style={s.imageSlot}>
          <p style={s.imageLabel}>Subject</p>
          <div style={s.imageFrame}>
            <Image src={job.image1_url} alt="Subject" fill style={{ objectFit: 'cover' }} sizes="120px" />
          </div>
        </div>
        <div style={s.arrowWrap}>
          <span style={s.arrow}>→</span>
        </div>
        <div style={s.imageSlot}>
          <p style={s.imageLabel}>Reference</p>
          <div style={s.imageFrame}>
            <Image src={job.image2_url} alt="Reference" fill style={{ objectFit: 'cover' }} sizes="120px" />
          </div>
        </div>
      </div>

      <div style={s.resultWrap}>
        {job.status === 'done' && job.output_url ? (
          <>
            <p style={s.imageLabel}>Result</p>
            <a href={`/history/${job.id}`} style={s.resultLink}>
              <div style={s.resultFrame}>
                <Image
                  src={job.output_url} alt="Result" fill
                  style={{ objectFit: 'cover' }} sizes="(max-width: 768px) 90vw, 400px"
                />
                <div style={s.resultOverlay}>
                  <span style={s.resultOverlayText}>View →</span>
                </div>
              </div>
            </a>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <a href={`/history/${job.id}`} className="btn btn-gold" style={{ fontSize: 10, padding: '8px 18px' }}>
                Open
              </a>
              <a
                href={job.output_url} download target="_blank" rel="noopener noreferrer"
                className="btn btn-ghost" style={{ fontSize: 10, padding: '8px 18px' }}
              >
                Download
              </a>
            </div>
          </>
        ) : (
          <StatusBadge status={job.status} />
        )}
      </div>

      <CardFooter time={time} />
    </div>
  )
}

// ── Video card ─────────────────────────────────────────────────────────────────

function VideoCard({ job, index }: { job: VideoJob; index: number }) {
  const date = new Date(job.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const time = new Date(job.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

  return (
    <div
      style={{ ...s.card, animationDelay: `${index * 40}ms` }}
      className="animate-fade-up"
    >
      <div style={s.cardHeader}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="badge badge-default">
            <span style={{ color: 'var(--teal)' }}>▶</span> Video
          </span>
          {job.showcase && (
            <span className="badge badge-default">
              {SHOWCASE_LABELS[job.showcase] ?? job.showcase}
            </span>
          )}
          {job.duration && (
            <span className="badge badge-default">{job.duration}s</span>
          )}
        </div>
        <span style={s.cardTime}>{date}</span>
      </div>

      <div style={s.videoThumbWrap}>
        <div style={s.videoThumb}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={job.output_url ?? job.subject_url} alt="Subject"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
          {job.status === 'done' && (
            <div style={s.playOverlay}>
              <div style={s.playBtn}>▶</div>
            </div>
          )}
        </div>
      </div>

      {job.status === 'done' && job.video_url ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <a
            href={job.video_url} target="_blank" rel="noopener noreferrer"
            className="btn btn-gold" style={{ fontSize: 10, padding: '8px 18px' }}
          >
            Watch
          </a>
          <a
            href={job.video_url} download="food-showcase.mp4"
            target="_blank" rel="noopener noreferrer"
            className="btn btn-ghost" style={{ fontSize: 10, padding: '8px 18px' }}
          >
            Download
          </a>
        </div>
      ) : (
        <StatusBadge
          status={job.status}
          label={job.status === 'processing' ? 'Co.Media AI is rendering…' : undefined}
        />
      )}

      <CardFooter time={time} />
    </div>
  )
}

// ── Shared sub-components ──────────────────────────────────────────────────────

function StatusBadge({ status, label }: { status: string; label?: string }) {
  if (status === 'processing') return (
    <div style={s.statusBadge}>
      <span style={s.statusDot} />
      {label ?? 'Processing'}
    </div>
  )
  if (status === 'failed') return (
    <span className="badge badge-error">✕ Failed</span>
  )
  return (
    <span className="badge badge-default">◌ Pending</span>
  )
}

function CardFooter({ time }: { time: string }) {
  return (
    <div style={s.cardFooter}>
      <span style={s.footerTime}>{time}</span>
    </div>
  )
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: 'var(--bg)',
  },
  main: {
    maxWidth: 1160, margin: '0 auto',
    padding: '48px 24px 80px',
  },

  /* Page header */
  pageHeader: {
    display: 'flex', alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginBottom: 32, flexWrap: 'wrap', gap: 16,
  },
  eyebrow: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10, letterSpacing: '0.16em',
    textTransform: 'uppercase',
    color: 'var(--orange)',
    marginBottom: 6,
  },
  title: {
    fontFamily: 'var(--font-display)',
    fontSize: 40, fontWeight: 800,
    color: 'var(--text)',
    letterSpacing: '-0.02em',
  },
  headerStats: {
    display: 'flex', alignItems: 'center', gap: 10,
  },
  statPill: {
    display: 'inline-flex', alignItems: 'center', gap: 7,
    background: 'var(--card)', border: '1px solid var(--border)',
    borderRadius: 100, padding: '5px 12px',
    fontFamily: 'var(--font-mono)', fontSize: 11,
    color: 'var(--text-secondary)',
    boxShadow: 'var(--shadow-xs)',
  },
  statDot: {
    width: 6, height: 6, borderRadius: '50%',
    display: 'inline-block', flexShrink: 0,
  },

  /* Filters */
  filterRow: {
    display: 'flex', gap: 6, marginBottom: 28,
  },
  filterBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 7,
    padding: '7px 16px',
    background: 'var(--card)', border: '1px solid var(--border)',
    borderRadius: 100,
    fontFamily: 'var(--font-mono)', fontSize: 11,
    letterSpacing: '0.06em',
    color: 'var(--text-muted)', cursor: 'pointer',
    transition: 'all 0.15s',
    boxShadow: 'var(--shadow-xs)',
  },
  filterBtnActive: {
    background: 'var(--orange)',
    borderColor: 'var(--orange)',
    color: '#FFFFFF',
    boxShadow: '0 2px 8px var(--orange-glow)',
  },
  filterCount: {
    background: 'var(--border)', color: 'var(--text-muted)',
    fontSize: 9, fontWeight: 600,
    padding: '2px 6px', borderRadius: 100, minWidth: 18,
    textAlign: 'center' as const,
  },
  filterCountActive: {
    background: 'rgba(255,255,255,0.25)', color: '#FFFFFF',
  },

  /* Empty state */
  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    padding: '80px 0', gap: 12, textAlign: 'center',
  },
  emptyIconWrap: {
    width: 72, height: 72, borderRadius: '50%',
    background: 'var(--orange-glow)',
    border: '1px solid rgba(242,56,1,0.15)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    marginBottom: 8,
  },
  emptyIcon: { color: 'var(--orange)', fontSize: 30 },
  emptyTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: 22, fontWeight: 700,
    color: 'var(--text)',
  },
  emptyDesc: {
    color: 'var(--text-muted)', fontSize: 13,
    lineHeight: 1.6, maxWidth: 320,
  },

  /* Grid */
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: 20,
  },

  /* Card */
  card: {
    background: 'var(--card)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
    padding: 20,
    display: 'flex', flexDirection: 'column', gap: 16,
    boxShadow: 'var(--shadow-sm)',
    transition: 'box-shadow 0.2s, border-color 0.2s',
  },
  cardHeader: {
    display: 'flex', alignItems: 'center',
    justifyContent: 'space-between', gap: 8,
  },
  cardTime: {
    fontFamily: 'var(--font-mono)', fontSize: 10,
    color: 'var(--text-muted)', letterSpacing: '0.04em',
  },

  /* Image slots */
  imageRow:  { display: 'flex', alignItems: 'flex-end', gap: 10 },
  imageSlot: { flex: 1, display: 'flex', flexDirection: 'column', gap: 5 },
  imageLabel: {
    fontFamily: 'var(--font-mono)',
    fontSize: 9, letterSpacing: '0.14em',
    textTransform: 'uppercase', color: 'var(--text-muted)',
  },
  imageFrame: {
    position: 'relative', width: '100%', paddingBottom: '75%',
    background: 'var(--surface)', borderRadius: 'var(--radius)',
    overflow: 'hidden', border: '1px solid var(--border)',
  },
  arrowWrap: {
    paddingBottom: '37.5%', display: 'flex',
    alignItems: 'flex-end', justifyContent: 'center',
  },
  arrow: { color: 'var(--text-muted)', fontSize: 14, marginBottom: 14 },

  /* Result */
  resultWrap: { display: 'flex', flexDirection: 'column', gap: 6 },
  resultLink: { display: 'block', textDecoration: 'none', borderRadius: 'var(--radius)' },
  resultFrame: {
    position: 'relative', width: '100%', paddingBottom: '56.25%',
    background: 'var(--surface)', borderRadius: 'var(--radius)',
    overflow: 'hidden', border: '1px solid var(--border)',
  },
  resultOverlay: {
    position: 'absolute', inset: 0,
    background: 'transparent',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'background 0.2s',
    opacity: 0,
  },
  resultOverlayText: {
    color: '#fff', fontFamily: 'var(--font-mono)',
    fontSize: 12, letterSpacing: '0.08em',
    background: 'rgba(0,0,0,0.5)',
    padding: '6px 14px', borderRadius: 20,
  },

  /* Video thumb */
  videoThumbWrap: {},
  videoThumb: {
    position: 'relative', width: '100%', paddingBottom: '56.25%',
    background: 'var(--surface)', borderRadius: 'var(--radius)',
    overflow: 'hidden', border: '1px solid var(--border)',
  },
  playOverlay: {
    position: 'absolute', inset: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(0,0,0,0.25)',
  },
  playBtn: {
    width: 44, height: 44, borderRadius: '50%',
    background: 'rgba(255,255,255,0.92)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: '#0F1117', fontSize: 14, paddingLeft: 2,
    boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
  },

  /* Status */
  statusBadge: {
    display: 'inline-flex', alignItems: 'center', gap: 8,
    padding: '8px 14px',
    background: 'var(--card-hover)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-muted)', fontSize: 11,
    fontFamily: 'var(--font-mono)', letterSpacing: '0.06em',
  },
  statusDot: {
    width: 7, height: 7, borderRadius: '50%',
    background: 'var(--orange)',
    animation: 'pulse-gold 1.5s ease-in-out infinite',
    display: 'inline-block', flexShrink: 0,
  },

  /* Footer */
  cardFooter: {
    display: 'flex', justifyContent: 'flex-end',
    paddingTop: 8, borderTop: '1px solid var(--border)',
  },
  footerTime: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10, color: 'var(--text-muted)',
    letterSpacing: '0.04em',
  },
}
