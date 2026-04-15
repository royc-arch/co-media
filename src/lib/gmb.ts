import { google } from 'googleapis'
import { createAdminClient } from './supabase/admin'

export function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  )
}

/** Returns a valid access token, refreshing if needed. */
export async function getValidAccessToken(userId: string): Promise<string> {
  const admin = createAdminClient()
  const { data: conn, error } = await admin
    .from('gmb_connections')
    .select('access_token, refresh_token, expires_at')
    .eq('user_id', userId)
    .single()

  if (error || !conn) throw new Error('No GMB connection found')

  const expiresAt = new Date(conn.expires_at).getTime()
  if (expiresAt - Date.now() > 5 * 60 * 1000) return conn.access_token

  const oauth2Client = createOAuthClient()
  oauth2Client.setCredentials({ refresh_token: conn.refresh_token })
  const { credentials } = await oauth2Client.refreshAccessToken()

  await admin.from('gmb_connections').update({
    access_token: credentials.access_token!,
    expires_at:   new Date(credentials.expiry_date!).toISOString(),
  }).eq('user_id', userId)

  return credentials.access_token!
}

/** Authenticated fetch against any Google API. */
export async function gmbFetch(
  accessToken: string,
  url: string,
  options: RequestInit = {}
): Promise<unknown> {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`GMB API ${res.status}: ${body}`)
  }
  return res.json()
}

/** Extract the trailing ID segment from a resource name.
 *  e.g. "accounts/123/locations/ChIJ" → "ChIJ"
 */
export function resourceId(name: string): string {
  return name.split('/').pop() ?? name
}

export const TONE_PROMPTS: Record<string, string> = {
  professional: 'Respond in a professional, courteous tone suitable for a business.',
  friendly:     'Respond in a warm, friendly tone as if talking to a regular customer.',
  casual:       'Respond in a casual, conversational tone. Keep it short and genuine.',
}
