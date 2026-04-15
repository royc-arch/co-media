'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

const NAV_LINKS = [
  { href: '/',          label: 'Studio'   },
  { href: '/showcase',  label: 'Showcase' },
  { href: '/history',   label: 'History'  },
  { href: '/gmb',       label: 'Reviews'  },
]

export default function Nav() {
  const router   = useRouter()
  const pathname = usePathname()
  const supabase = createClient()

  const [email,     setEmail]     = useState<string | null>(null)
  const [menuOpen,  setMenuOpen]  = useState(false)
  const [userOpen,  setUserOpen]  = useState(false)
  const [scrolled,  setScrolled]  = useState(false)
  const userRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => setEmail(user?.email ?? null))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Close user dropdown when clicking outside
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (userRef.current && !userRef.current.contains(e.target as Node)) {
        setUserOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  if (!email) return null

  async function signOut() {
    await supabase.auth.signOut()
    router.push('/auth')
    router.refresh()
  }

  const initial = email[0].toUpperCase()

  function isActive(href: string) {
    if (href === '/') return pathname === '/'
    return pathname.startsWith(href)
  }

  return (
    <nav style={{
      position: 'sticky', top: 0, zIndex: 200,
      background: scrolled
        ? 'rgba(15,17,23,0.96)'
        : '#0F1117',
      backdropFilter: 'blur(14px)',
      borderBottom: '1px solid rgba(255,255,255,0.07)',
      transition: 'background 0.2s',
    }}>
      <div style={{
        maxWidth: 1160, margin: '0 auto',
        padding: '0 24px', height: 56,
        display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', gap: 24,
      }}>

        {/* ── Logo ── */}
        <Link href="/" style={{
          display: 'flex', alignItems: 'center', gap: 9,
          textDecoration: 'none', flexShrink: 0,
        }}>
          <span style={{
            color: 'var(--orange)', fontSize: 20, lineHeight: 1,
          }}>◈</span>
          <span style={{
            fontFamily: 'var(--font-display)',
            fontSize: 19, fontWeight: 800,
            color: '#FFFFFF',
            letterSpacing: '-0.02em',
          }}>Co.Media</span>
        </Link>

        {/* ── Desktop links ── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4,
          flex: 1, justifyContent: 'center',
        }} className="nav-links-desktop">
          {NAV_LINKS.map(link => (
            <Link
              key={link.href}
              href={link.href}
              style={{
                position: 'relative',
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', gap: 4,
                padding: '4px 14px',
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: '0.09em',
                textTransform: 'uppercase',
                textDecoration: 'none',
                color: isActive(link.href)
                  ? '#FFFFFF'
                  : 'rgba(255,255,255,0.45)',
                transition: 'color 0.15s',
                borderRadius: 6,
              }}
              onMouseEnter={e => {
                if (!isActive(link.href))
                  (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.75)'
              }}
              onMouseLeave={e => {
                if (!isActive(link.href))
                  (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.45)'
              }}
            >
              {link.label}
              {isActive(link.href) && (
                <span style={{
                  position: 'absolute', bottom: -2,
                  left: '50%', transform: 'translateX(-50%)',
                  width: 20, height: 2,
                  background: 'linear-gradient(90deg, var(--orange), var(--orange-light))',
                  borderRadius: 2,
                }} />
              )}
            </Link>
          ))}
        </div>

        {/* ── Right side: user ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div ref={userRef} style={{ position: 'relative' }}>
            <button
              onClick={() => setUserOpen(v => !v)}
              style={{
                width: 32, height: 32, borderRadius: '50%',
                background: 'linear-gradient(135deg, var(--orange) 0%, var(--orange-light) 100%)',
                border: '2px solid rgba(255,255,255,0.15)',
                color: '#fff',
                fontFamily: 'var(--font-display)',
                fontSize: 13, fontWeight: 700,
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'border-color 0.15s',
                flexShrink: 0,
              }}
            >
              {initial}
            </button>

            {/* Dropdown */}
            {userOpen && (
              <div className="animate-slide-down" style={{
                position: 'absolute', top: 'calc(100% + 8px)', right: 0,
                background: '#1A1D27',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 10,
                padding: '8px',
                minWidth: 200,
                boxShadow: '0 16px 40px rgba(0,0,0,0.4)',
                zIndex: 300,
              }}>
                <div style={{
                  padding: '8px 12px 12px',
                  borderBottom: '1px solid rgba(255,255,255,0.07)',
                  marginBottom: 6,
                }}>
                  <p style={{
                    fontFamily: 'var(--font-mono)', fontSize: 10,
                    color: 'rgba(255,255,255,0.35)',
                    letterSpacing: '0.08em', textTransform: 'uppercase',
                    marginBottom: 3,
                  }}>Signed in as</p>
                  <p style={{
                    fontFamily: 'var(--font-mono)', fontSize: 12,
                    color: 'rgba(255,255,255,0.8)',
                    overflow: 'hidden', textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>{email}</p>
                </div>
                <button
                  onClick={signOut}
                  style={{
                    width: '100%', textAlign: 'left',
                    background: 'transparent', border: 'none',
                    padding: '8px 12px',
                    borderRadius: 6,
                    fontFamily: 'var(--font-mono)', fontSize: 11,
                    letterSpacing: '0.08em', textTransform: 'uppercase',
                    color: 'rgba(255,255,255,0.5)',
                    cursor: 'pointer',
                    transition: 'background 0.12s, color 0.12s',
                  }}
                  onMouseEnter={e => {
                    const el = e.currentTarget
                    el.style.background = 'rgba(239,68,68,0.1)'
                    el.style.color      = '#F87171'
                  }}
                  onMouseLeave={e => {
                    const el = e.currentTarget
                    el.style.background = 'transparent'
                    el.style.color      = 'rgba(255,255,255,0.5)'
                  }}
                >
                  Sign Out
                </button>
              </div>
            )}
          </div>

          {/* Mobile hamburger */}
          <button
            className="nav-hamburger"
            onClick={() => setMenuOpen(v => !v)}
            style={{
              background: 'none', border: 'none',
              color: 'rgba(255,255,255,0.6)',
              cursor: 'pointer', fontSize: 18,
              display: 'none', padding: 4,
            }}
          >
            {menuOpen ? '✕' : '☰'}
          </button>
        </div>
      </div>

      {/* ── Mobile menu ── */}
      {menuOpen && (
        <div className="animate-slide-down" style={{
          borderTop: '1px solid rgba(255,255,255,0.07)',
          padding: '12px 24px 16px',
          display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          {NAV_LINKS.map(link => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setMenuOpen(false)}
              style={{
                padding: '10px 12px',
                fontFamily: 'var(--font-mono)', fontSize: 12,
                letterSpacing: '0.1em', textTransform: 'uppercase',
                color: isActive(link.href) ? 'var(--orange)' : 'rgba(255,255,255,0.55)',
                textDecoration: 'none', borderRadius: 6,
                background: isActive(link.href) ? 'rgba(242,56,1,0.08)' : 'transparent',
              }}
            >
              {link.label}
            </Link>
          ))}
        </div>
      )}

      <style>{`
        @media (max-width: 640px) {
          .nav-links-desktop { display: none !important; }
          .nav-hamburger      { display: flex !important; }
        }
      `}</style>
    </nav>
  )
}
