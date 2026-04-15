/**
 * GET /api/gmb/status
 * Returns whether the user has a Google OAuth token stored
 * and how many locations they have configured.
 *
 * { oauthConnected: boolean, locations: LocationSetting[] }
 */
import { createClient } from '@/lib/supabase/server'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  // Check for an OAuth token
  const { data: conn } = await supabase
    .from('gmb_connections')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle()

  // Fetch saved locations
  const { data: settings } = await supabase
    .from('gmb_settings')
    .select('location_name, display_name, auto_reply_enabled')
    .eq('user_id', user.id)

  return Response.json({
    oauthConnected: !!conn,
    locations: settings ?? [],
  })
}
