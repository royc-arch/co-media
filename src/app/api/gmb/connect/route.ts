import { createClient } from '@/lib/supabase/server'
import { createOAuthClient } from '@/lib/gmb'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.redirect(new URL('/auth', request.url))
  }

  const oauth2Client = createOAuthClient()
  const state = crypto.randomUUID()

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent', // always return refresh_token
    scope:       ['https://www.googleapis.com/auth/business.manage'],
    state,
  })

  const response = NextResponse.redirect(authUrl)
  response.cookies.set('gmb_oauth_state', state, {
    httpOnly: true,
    maxAge:   600,
    sameSite: 'lax',
    path:     '/',
  })
  return response
}
