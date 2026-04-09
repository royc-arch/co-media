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
  const router     = useRouter()
  const params     = useSearchParams()
  const supabase   = createClient()
  const filter     = (params.get('filter') ?? 'all') as Filter

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

  const donePhotos  = jobs.filter(j => j.status === 'done')
  const doneVideos  = videoJobs.filter(v => v.status === 'done')
  const totalDone   = donePhotos.length + doneVideos.length
  const totalOther  = (jobs.length - donePhotos.length) + (videoJobs.length - doneVideos.length)

  const showPhotos  = filter === 'all' || filter === 'photos'
  const showVideos  = filter === 'all' || filter === 'videos'

  // Merge and sort by created_at
  type AnyItem = { _type: 'photo'; data: Job } | { _type: 'video'; data: VideoJob }
  const items: AnyItem[] = [
    ...(showPhotos ? jobs.map(j => ({ _type: 'photo' as const, data: j })) : []),
    ...(showVideos ? videoJobs.map(v => ({ _type: 'video' as const, data: v })) : []),
  ].sort((a, b) =>
    new Date(b.data.created_at).getTime() - new Date(a.data.created_at).getTime()
  )

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <a href="/" style={styles.logo}>
            <span style={styles.logoIcon}>◈</span>
            <span style={styles.logoText}>Co.Media</span>
          </a>
          <nav style={styles.nav}>
            <a href="/" style={styles.navLink}>Style Transfer</a>
            <span style={styles.navDivider}>·</span>
            <a href="/showcase" style={styles.navLink}>Video Showcase</a>
            <span style={styles.navDivider}>·</span>
            <a href="/history" style={{ ...styles.navLink, color: 'var(--orange)' }}>Works</a>
            <span style={styles.navDivider}>·</span>
            <a href="/references" style={styles.navLink}>References</a>
            <span style={styles.navDivider}>·</span>
            <button onClick={signOut} style={styles.signOutBtn}>Sign Out</button>
          </nav>
        </div>
      </header>

      <main style={styles.main}>
        <div style={styles.pageHeader} className="animate-fade-up">
          <h1 style={styles.pageTitle}>Works</h1>
          <p style={styles.pageSubtitle}>
            {jobs.length + videoJobs.length === 0
              ? 'No works yet'
              : `${totalDone} completed · ${totalOther} in progress`}
          </p>
        </div>

        {/* Filter tabs */}
        {(jobs.length + videoJobs.length > 0) && (
          <div style={styles.filterRow} className="animate-fade-up">
            {([
              ['all',    `All (${jobs.length + videoJobs.length})`],
              ['photos', `Photos (${jobs.length})`],
              ['videos', `Videos (${videoJobs.length})`],
            ] as [Filter, string][]).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                style={{
                  ...styles.filterBtn,
                  borderColor: filter === key ? 'var(--gold)'       : 'var(--border)',
                  color:       filter === key ? 'var(--gold)'       : 'var(--text-muted)',
                  background:  filter === key ? 'var(--gold-glow)'  : 'transparent',
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {items.length === 0 ? (
          <div style={styles.empty} className="animate-fade-up">
            <span style={styles.emptyIcon}>◈</span>
            <p style={styles.emptyText}>
              {filter === 'photos' ? 'No photo works yet.' :
               filter === 'videos' ? 'No video works yet.' :
               'Your works will appear here.'}
            </p>
            <a href={filter === 'videos' ? '/showcase' : '/'} className="btn btn-gold" style={{ marginTop: 20 }}>
              {filter === 'videos' ? 'Create Video' : 'Start Transforming'}
            </a>
          </div>
        ) : (
          <div style={styles.grid}>
            {items.map((item, i) =>
              item._type === 'photo'
                ? <PhotoCard key={item.data.id} job={item.data}         index={i} />
                : <VideoCard key={item.data.id} job={item.data as VideoJob} index={i} />
            )}
          </div>
        )}
      </main>
    </div>
  )
}

// ── Photo card ────────────────────────────────────────────────────────────────

function PhotoCard({ job, index }: { job: Job; index: number }) {
  const date = new Date(job.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const time = new Date(job.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

  return (
    <div style={{ ...styles.card, animationDelay: `${index * 50}ms` }} className="animate-fade-up">
      <div style={styles.cardTypeBadge}>
        <span style={{ color: 'var(--gold-dim)' }}>◈</span> Photo
      </div>

      <div style={styles.imageRow}>
        <div style={styles.imageSlot}>
          <label style={styles.imageLabel}>Subject</label>
          <div style={styles.imageFrame}>
            <Image src={job.image1_url} alt="Subject" fill style={{ objectFit: 'cover' }} sizes="120px" />
          </div>
        </div>
        <div style={styles.arrowWrap}>
          <span style={styles.arrow}>→</span>
        </div>
        <div style={styles.imageSlot}>
          <label style={styles.imageLabel}>Reference</label>
          <div style={styles.imageFrame}>
            <Image src={job.image2_url} alt="Reference" fill style={{ objectFit: 'cover' }} sizes="120px" />
          </div>
        </div>
      </div>

      <div style={styles.resultWrap}>
        {job.status === 'done' && job.output_url ? (
          <>
            <label style={styles.imageLabel}>Result</label>
            <a href={`/history/${job.id}`} style={styles.resultLink}>
              <div style={styles.resultFrame}>
                <Image
                  src={job.output_url} alt="Result" fill
                  style={{ objectFit: 'cover' }} sizes="(max-width: 768px) 90vw, 400px"
                />
              </div>
            </a>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <a href={`/history/${job.id}`} className="btn btn-gold" style={{ fontSize: 10 }}>Open</a>
              <a href={job.output_url} download target="_blank" rel="noopener noreferrer"
                 className="btn btn-ghost" style={{ fontSize: 10 }}>Download</a>
            </div>
          </>
        ) : (
          <StatusBadge status={job.status} />
        )}
      </div>

      <CardFooter date={date} time={time} />
    </div>
  )
}

// ── Video card ────────────────────────────────────────────────────────────────

function VideoCard({ job, index }: { job: VideoJob; index: number }) {
  const date = new Date(job.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const time = new Date(job.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

  return (
    <div style={{ ...styles.card, animationDelay: `${index * 50}ms` }} className="animate-fade-up">
      <div style={styles.cardTypeBadge}>
        <span style={{ color: 'var(--teal)' }}>▶</span> Video
        {job.showcase && (
          <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>
            {SHOWCASE_LABELS[job.showcase] ?? job.showcase}
          </span>
        )}
        {job.duration && (
          <span style={{ color: 'var(--text-muted)' }}> · {job.duration}s</span>
        )}
      </div>

      {/* Subject thumbnail */}
      <div style={styles.videoThumbWrap}>
        <div style={styles.videoThumb}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={job.output_url ?? job.subject_url}
            alt="Subject"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
          {job.status === 'done' && (
            <div style={styles.playOverlay}>
              <div style={styles.playIcon}>▶</div>
            </div>
          )}
        </div>
      </div>

      {/* Video result */}
      {job.status === 'done' && job.video_url ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <a
            href={job.video_url} target="_blank" rel="noopener noreferrer"
            className="btn btn-gold" style={{ fontSize: 10 }}
          >
            Watch
          </a>
          <a
            href={job.video_url} download="food-showcase.mp4"
            target="_blank" rel="noopener noreferrer"
            className="btn btn-ghost" style={{ fontSize: 10 }}
          >
            Download
          </a>
        </div>
      ) : (
        <StatusBadge status={job.status} label={job.status === 'processing' ? 'Co.Media AI is rendering…' : undefined} />
      )}

      <CardFooter date={date} time={time} />
    </div>
  )
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function StatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <div style={styles.statusBadge} data-status={status}>
      {status === 'processing' && (
        <><span style={styles.statusDot} />{label ?? 'Processing'}</>
      )}
      {status === 'failed'  && '✕ Failed'}
      {status === 'pending' && '◌ Pending'}
    </div>
  )
}

function CardFooter({ date, time }: { date: string; time: string }) {
  return (
    <div style={styles.cardFooter}>
      <span style={styles.cardDate}>{date}</span>
      <span style={styles.cardTime}>{time}</span>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column' },
  header: {
    borderBottom: '1px solid var(--border)', background: 'var(--header-bg)',
    backdropFilter: 'blur(12px)', position: 'sticky', top: 0, zIndex: 100,
  },
  headerInner: {
    maxWidth: 1100, margin: '0 auto', padding: '0 24px', height: 56,
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  },
  logo: { display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none', color: '#FFFFFF' },
  logoIcon: { color: 'var(--orange)', fontSize: 18 },
  logoText: { fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em', color: '#FFFFFF' },
  nav:         { display: 'flex', alignItems: 'center', gap: 16 },
  navLink: {
    color: 'rgba(255,255,255,0.55)', fontSize: 11, letterSpacing: '0.1em',
    textTransform: 'uppercase', transition: 'color 0.15s', textDecoration: 'none',
  },
  navDivider: { color: 'rgba(255,255,255,0.2)' },
  signOutBtn: {
    background: 'none', border: 'none', color: 'rgba(255,255,255,0.55)', fontFamily: 'var(--font-mono)',
    fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer', padding: 0,
  },
  main:       { maxWidth: 1100, margin: '0 auto', padding: '60px 24px 80px', width: '100%' },
  pageHeader: { marginBottom: 32 },
  pageTitle: {
    fontFamily: 'var(--font-display)', fontSize: 42, fontWeight: 300,
    color: 'var(--text)', letterSpacing: '0.02em', lineHeight: 1.1,
  },
  pageSubtitle: {
    color: 'var(--text-muted)', fontSize: 12, letterSpacing: '0.08em',
    textTransform: 'uppercase', marginTop: 8,
  },
  filterRow: { display: 'flex', gap: 8, marginBottom: 32 },
  filterBtn: {
    padding: '6px 16px', border: '1px solid', borderRadius: 20,
    fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.1em',
    textTransform: 'uppercase', cursor: 'pointer', transition: 'all 0.15s',
  },
  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    padding: '80px 0', gap: 12, textAlign: 'center',
  },
  emptyIcon: { color: 'var(--gold-dim)', fontSize: 36, opacity: 0.4 },
  emptyText: { color: 'var(--text-muted)', fontSize: 13, letterSpacing: '0.06em' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 24 },
  card: {
    background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, padding: 20,
    display: 'flex', flexDirection: 'column', gap: 16, transition: 'border-color 0.2s',
  },
  cardTypeBadge: {
    fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.1em',
    textTransform: 'uppercase', color: 'var(--text-muted)',
    display: 'flex', alignItems: 'center', gap: 6,
  },
  imageRow:   { display: 'flex', alignItems: 'flex-end', gap: 12 },
  imageSlot:  { flex: 1, display: 'flex', flexDirection: 'column', gap: 6 },
  imageLabel: { color: 'var(--text-muted)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase' },
  imageFrame: {
    position: 'relative', width: '100%', paddingBottom: '75%',
    background: 'var(--surface)', borderRadius: 3, overflow: 'hidden', border: '1px solid var(--border)',
  },
  arrowWrap:  { paddingBottom: '37.5%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  arrow:      { color: 'var(--gold-dim)', fontSize: 16, marginBottom: 16 },
  resultWrap: { display: 'flex', flexDirection: 'column', gap: 6 },
  resultLink: { display: 'block', textDecoration: 'none' },
  resultFrame: {
    position: 'relative', width: '100%', paddingBottom: '56.25%',
    background: 'var(--surface)', borderRadius: 3, overflow: 'hidden', border: '1px solid var(--border)',
  },
  videoThumbWrap: { position: 'relative' },
  videoThumb: {
    position: 'relative', width: '100%', paddingBottom: '56.25%',
    background: 'var(--surface)', borderRadius: 3, overflow: 'hidden', border: '1px solid var(--border)',
  },
  playOverlay: {
    position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
    justifyContent: 'center', background: 'rgba(0,0,0,0.3)',
  },
  playIcon: {
    width: 40, height: 40, borderRadius: '50%',
    background: 'rgba(110,201,180,0.9)', display: 'flex', alignItems: 'center',
    justifyContent: 'center', color: '#0A0807', fontSize: 14, paddingLeft: 2,
  },
  statusBadge: {
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px',
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3,
    color: 'var(--text-muted)', fontSize: 11, letterSpacing: '0.08em',
  },
  statusDot: {
    width: 6, height: 6, borderRadius: '50%', background: 'var(--gold)',
    animation: 'pulse-gold 1.5s ease-in-out infinite', display: 'inline-block',
  },
  cardFooter: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    paddingTop: 8, borderTop: '1px solid var(--border)',
  },
  cardDate: { color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.08em' },
  cardTime: { color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.06em' },
}
