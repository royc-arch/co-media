'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type Mode = 'signin' | 'signup'

const FEATURES = [
  { icon: '◈', text: 'AI-powered food photo style transfer' },
  { icon: '▶', text: 'Cinematic dish video showcase' },
  { icon: '◎', text: 'Auto-reply to Google reviews' },
  { icon: '⊙', text: 'Saved reference library' },
]

export default function AuthPage() {
  const router   = useRouter()
  const supabase = createClient()

  const [mode,       setMode]       = useState<Mode>('signin')
  const [email,      setEmail]      = useState('')
  const [password,   setPassword]   = useState('')
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState('')
  const [magicSent,  setMagicSent]  = useState(false)

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
        email, password,
        options: { emailRedirectTo: `${location.origin}/auth/callback` },
      })
      if (error) { setError(error.message); setLoading(false); return }
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
    <div style={s.page}>
      {/* ── Left panel — brand ── */}
      <div style={s.left}>
        {/* Ambient glows */}
        <div style={s.glowTop} />
        <div style={s.glowBottom} />

        <div style={s.leftInner}>
          {/* Logo */}
          <div style={s.logo}>
            <span style={s.logoMark}>◈</span>
            <span style={s.logoText}>Co.Media</span>
          </div>

          <div style={s.leftBody}>
            <h1 style={s.headline}>
              Your food,<br />
              <span style={s.headlineAccent}>elevated.</span>
            </h1>
            <p style={s.subline}>
              AI-powered tools for restaurants and food businesses —
              from photo retouching to cinematic video and automated review replies.
            </p>

            <div style={s.features}>
              {FEATURES.map(f => (
                <div key={f.text} style={s.featureRow}>
                  <span style={s.featureIcon}>{f.icon}</span>
                  <span style={s.featureText}>{f.text}</span>
                </div>
              ))}
            </div>
          </div>

          <p style={s.leftFooter}>
            Trusted by forward-thinking restaurants
          </p>
        </div>
      </div>

      {/* ── Right panel — form ── */}
      <div style={s.right}>
        <div style={s.formWrap} className="animate-fade-up">
          <div style={s.formHeader}>
            <h2 style={s.formTitle}>
              {mode === 'signin' ? 'Welcome back' : 'Create account'}
            </h2>
            <p style={s.formSubtitle}>
              {mode === 'signin'
                ? 'Sign in to your Co.Media workspace'
                : 'Start your free Co.Media account'}
            </p>
          </div>

          {/* Mode toggle */}
          <div style={s.toggle}>
            {(['signin', 'signup'] as Mode[]).map(m => (
              <button
                key={m}
                onClick={() => { setMode(m); setError('') }}
                style={{ ...s.toggleBtn, ...(mode === m ? s.toggleActive : {}) }}
              >
                {m === 'signin' ? 'Sign In' : 'Sign Up'}
              </button>
            ))}
          </div>

          {magicSent ? (
            <div style={s.magicConfirm}>
              <div style={s.magicIcon}>✉</div>
              <p style={s.magicTitle}>Check your inbox</p>
              <p style={s.magicDesc}>
                We sent a magic link to <strong>{email}</strong>.
                Click it to sign in instantly.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} style={s.form}>
              <div style={s.field}>
                <label style={s.label}>Email address</label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  placeholder="you@restaurant.com"
                  autoComplete="email"
                />
              </div>

              <div style={s.field}>
                <label style={s.label}>Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  minLength={6}
                  placeholder="••••••••"
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                />
              </div>

              {error && (
                <div style={s.errorMsg}>
                  <span>⚠</span> {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="btn btn-gold"
                style={{ width: '100%', marginTop: 4, padding: '12px 22px' }}
              >
                {loading
                  ? 'Working…'
                  : mode === 'signin' ? 'Sign In' : 'Create Account'}
              </button>

              <div style={s.divider}>
                <span style={s.dividerLine} />
                <span style={s.dividerText}>or</span>
                <span style={s.dividerLine} />
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

          <p style={s.terms}>
            By continuing, you agree to our Terms of Service and Privacy Policy.
          </p>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: {
    display: 'flex',
    minHeight: '100vh',
  },

  /* ── Left ── */
  left: {
    flex: '0 0 44%',
    background: '#0F1117',
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
    overflow: 'hidden',
  },
  glowTop: {
    position: 'absolute', top: '-10%', left: '-10%',
    width: 500, height: 500,
    background: 'radial-gradient(circle, rgba(242,56,1,0.18) 0%, transparent 65%)',
    pointerEvents: 'none',
    filter: 'blur(30px)',
  },
  glowBottom: {
    position: 'absolute', bottom: '0%', right: '-5%',
    width: 400, height: 400,
    background: 'radial-gradient(circle, rgba(255,174,20,0.10) 0%, transparent 65%)',
    pointerEvents: 'none',
    filter: 'blur(40px)',
  },
  leftInner: {
    position: 'relative', zIndex: 1,
    flex: 1,
    display: 'flex', flexDirection: 'column',
    padding: '40px 48px',
  },
  logo: {
    display: 'flex', alignItems: 'center', gap: 10,
    marginBottom: 'auto',
  },
  logoMark: { color: 'var(--orange)', fontSize: 22 },
  logoText: {
    fontFamily: 'var(--font-display)',
    fontSize: 22, fontWeight: 800,
    color: '#FFFFFF', letterSpacing: '-0.02em',
  },
  leftBody: {
    paddingBottom: 60,
  },
  headline: {
    fontFamily: 'var(--font-display)',
    fontSize: 52, fontWeight: 800,
    color: '#FFFFFF',
    letterSpacing: '-0.03em',
    lineHeight: 1.05,
    marginBottom: 20,
  },
  headlineAccent: {
    background: 'linear-gradient(90deg, var(--orange) 0%, var(--orange-light) 100%)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  },
  subline: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 14, lineHeight: 1.75,
    marginBottom: 36, maxWidth: 340,
  },
  features: {
    display: 'flex', flexDirection: 'column', gap: 14,
  },
  featureRow: {
    display: 'flex', alignItems: 'center', gap: 14,
  },
  featureIcon: {
    color: 'var(--orange)', fontSize: 15,
    width: 20, flexShrink: 0,
  },
  featureText: {
    color: 'rgba(255,255,255,0.65)',
    fontFamily: 'var(--font-mono)',
    fontSize: 12, letterSpacing: '0.02em',
  },
  leftFooter: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10, letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: 'rgba(255,255,255,0.2)',
  },

  /* ── Right ── */
  right: {
    flex: 1,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg)',
    padding: '40px 24px',
  },
  formWrap: {
    width: '100%', maxWidth: 400,
  },
  formHeader: {
    marginBottom: 28,
  },
  formTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: 30, fontWeight: 800,
    color: 'var(--text)',
    marginBottom: 6,
  },
  formSubtitle: {
    color: 'var(--text-muted)',
    fontSize: 13, lineHeight: 1.5,
  },
  toggle: {
    display: 'flex',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: 3, gap: 3,
    marginBottom: 24,
  },
  toggleBtn: {
    flex: 1, padding: '8px 0',
    background: 'transparent', border: 'none',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
    fontSize: 11, letterSpacing: '0.09em',
    textTransform: 'uppercase',
    cursor: 'pointer', borderRadius: 6,
    transition: 'all 0.15s',
  },
  toggleActive: {
    background: '#FFFFFF',
    color: 'var(--text)',
    boxShadow: 'var(--shadow-sm)',
  },
  form: {
    display: 'flex', flexDirection: 'column', gap: 16,
  },
  field: {
    display: 'flex', flexDirection: 'column', gap: 6,
  },
  label: {
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-mono)',
    fontSize: 11, letterSpacing: '0.06em',
    fontWeight: 500,
  },
  errorMsg: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: 'rgba(239,68,68,0.06)',
    border: '1px solid rgba(239,68,68,0.2)',
    borderRadius: 6, padding: '10px 14px',
    color: 'var(--error)', fontSize: 12,
    fontFamily: 'var(--font-mono)',
  },
  divider: {
    display: 'flex', alignItems: 'center', gap: 12,
  },
  dividerLine: {
    flex: 1, height: 1,
    background: 'var(--border)', display: 'block',
  },
  dividerText: {
    color: 'var(--text-muted)',
    fontSize: 10, letterSpacing: '0.1em',
    textTransform: 'uppercase',
  },
  magicConfirm: {
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', gap: 12,
    padding: '32px 0', textAlign: 'center',
  },
  magicIcon: {
    width: 56, height: 56, borderRadius: '50%',
    background: 'var(--orange-glow)',
    border: '1px solid rgba(242,56,1,0.2)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 22, color: 'var(--orange)',
  },
  magicTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: 20, fontWeight: 700,
    color: 'var(--text)',
  },
  magicDesc: {
    color: 'var(--text-muted)',
    fontSize: 13, lineHeight: 1.6,
  },
  terms: {
    color: 'var(--text-muted)',
    fontSize: 10, textAlign: 'center',
    marginTop: 24, lineHeight: 1.6,
    letterSpacing: '0.02em',
  },
}
