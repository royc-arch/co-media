'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type Mode = 'signin' | 'signup'

export default function AuthPage() {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [magicSent, setMagicSent] = useState(false)

  const supabase = createClient()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    if (mode === 'signin') {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) { setError(error.message); setLoading(false); return }
      router.push('/')
      router.refresh()
    } else {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${location.origin}/auth/callback` },
      })
      if (error) { setError(error.message); setLoading(false); return }
      setError('')
      setLoading(false)
      alert('Check your email to confirm your account.')
    }
  }

  async function handleMagicLink() {
    if (!email) { setError('Enter your email first.'); return }
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${location.origin}/auth/callback` },
    })
    setLoading(false)
    if (error) { setError(error.message); return }
    setMagicSent(true)
  }

  return (
    <div style={styles.page}>
      {/* Ambient glow */}
      <div style={styles.glow} />

      <div style={styles.card} className="animate-fade-up">
        {/* Logo */}
        <div style={styles.logoWrap}>
          <span style={styles.logoIcon}>◈</span>
          <span style={styles.logoText}>Co.Media</span>
        </div>

        <p style={styles.tagline}>Transform your photos with AI style transfer</p>

        {/* Mode toggle */}
        <div style={styles.toggle}>
          <button
            style={{ ...styles.toggleBtn, ...(mode === 'signin' ? styles.toggleActive : {}) }}
            onClick={() => { setMode('signin'); setError('') }}
          >
            Sign In
          </button>
          <button
            style={{ ...styles.toggleBtn, ...(mode === 'signup' ? styles.toggleActive : {}) }}
            onClick={() => { setMode('signup'); setError('') }}
          >
            Sign Up
          </button>
        </div>

        {magicSent ? (
          <div style={styles.magicConfirm}>
            <span style={{ fontSize: 24 }}>✦</span>
            <p style={{ color: 'var(--gold)', fontFamily: 'var(--font-display)', fontSize: 18 }}>
              Magic link sent
            </p>
            <p style={{ color: 'var(--text-secondary)', fontSize: 12, marginTop: 4 }}>
              Check your inbox and click the link to sign in.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={styles.form}>
            <div style={styles.field}>
              <label style={styles.label}>Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                style={styles.input}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </div>

            <div style={styles.field}>
              <label style={styles.label}>Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                minLength={6}
                style={styles.input}
                placeholder="••••••••"
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              />
            </div>

            {error && <p style={styles.errorMsg}>{error}</p>}

            <button
              type="submit"
              disabled={loading}
              className="btn btn-gold"
              style={{ width: '100%', marginTop: 8 }}
            >
              {loading ? 'Working...' : mode === 'signin' ? 'Sign In' : 'Create Account'}
            </button>

            <div style={styles.divider}>
              <span style={styles.dividerLine} />
              <span style={styles.dividerText}>or</span>
              <span style={styles.dividerLine} />
            </div>

            <button
              type="button"
              onClick={handleMagicLink}
              disabled={loading}
              className="btn btn-ghost"
              style={{ width: '100%' }}
            >
              Send Magic Link
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    position: 'relative',
    overflow: 'hidden',
    background: 'radial-gradient(ellipse 80% 60% at 50% 40%, #161009 0%, var(--bg) 70%)',
  },
  glow: {
    position: 'absolute',
    top: '35%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: 600,
    height: 400,
    background: 'radial-gradient(ellipse, var(--gold-glow) 0%, transparent 70%)',
    pointerEvents: 'none',
    filter: 'blur(40px)',
  },
  card: {
    position: 'relative',
    zIndex: 1,
    width: '100%',
    maxWidth: 400,
    background: 'var(--card)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '40px 36px',
    boxShadow: '0 24px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03) inset',
  },
  logoWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
    justifyContent: 'center',
  },
  logoIcon: {
    color: 'var(--gold)',
    fontSize: 22,
    lineHeight: 1,
  },
  logoText: {
    fontFamily: 'var(--font-display)',
    fontSize: 28,
    fontWeight: 400,
    color: 'var(--text)',
    letterSpacing: '0.04em',
  },
  tagline: {
    textAlign: 'center',
    color: 'var(--text-muted)',
    fontSize: 11,
    letterSpacing: '0.08em',
    marginBottom: 28,
    textTransform: 'uppercase',
  },
  toggle: {
    display: 'flex',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    padding: 3,
    marginBottom: 24,
    gap: 3,
  },
  toggleBtn: {
    flex: 1,
    padding: '7px 0',
    background: 'transparent',
    border: 'none',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    cursor: 'pointer',
    borderRadius: 3,
    transition: 'all 0.15s',
  },
  toggleActive: {
    background: 'var(--card-hover)',
    color: 'var(--gold)',
    boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  label: {
    color: 'var(--text-muted)',
    fontSize: 10,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
  },
  input: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 3,
    padding: '10px 12px',
    color: 'var(--text)',
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
    outline: 'none',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  },
  errorMsg: {
    color: 'var(--error)',
    fontSize: 11,
    letterSpacing: '0.04em',
  },
  divider: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    margin: '4px 0',
  },
  dividerLine: {
    flex: 1,
    height: 1,
    background: 'var(--border)',
    display: 'block',
  },
  dividerText: {
    color: 'var(--text-muted)',
    fontSize: 10,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
  },
  magicConfirm: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    padding: '24px 0',
    textAlign: 'center',
    color: 'var(--gold)',
  },
}
