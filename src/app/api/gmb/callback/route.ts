import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createOAuthClient } from '@/lib/gmb'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code  = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  if (error) {
    return NextResponse.redirect(new URL('/gmb?error=access_denied', request.url))
  }

  const savedState = request.cookies.get('gmb_oauth_state')?.value
  if (!code || !state || state !== savedState) {
    return NextResponse.redirect(new URL('/gmb?error=invalid_state', request.url))
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.redirect(new URL('/auth', request.url))
  }

  const oauth2Client = createOAuthClient()
  const { tokens } = await oauth2Client.getToken(code)

  if (!tokens.access_token || !tokens.refresh_token) {
    return NextResponse.redirect(new URL('/gmb?error=missing_tokens', request.url))
  }

  const admin = createAdminClient()
  const { error: upsertError } = await admin.from('gmb_connections').upsert({
    user_id:       user.id,
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    new Date(tokens.expiry_date!).toISOString(),
  }, { onConflict: 'user_id' })

  if (upsertError) {
    console.error('[gmb/callback] upsert failed:', upsertError)
    return NextResponse.redirect(
      new URL(`/gmb?error=db_error&detail=${encodeURIComponent(upsertError.message)}`, request.url)
    )
  }

  const response = NextResponse.redirect(new URL('/gmb/setup', request.url))
  response.cookies.delete('gmb_oauth_state')
  return response
}
