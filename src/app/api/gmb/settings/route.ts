/**
 * GET  /api/gmb/settings?locationName=...   → fetch settings for a location
 * POST /api/gmb/settings                    → upsert settings (add/update location)
 * DELETE /api/gmb/settings?locationName=... → remove a location
 */
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const locationName = new URL(request.url).searchParams.get('locationName')

  let query = supabase
    .from('gmb_settings')
    .select('*')
    .eq('user_id', user.id)

  if (locationName) query = query.eq('location_name', locationName)

  const { data, error } = await query
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ settings: data })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json() as {
    accountName:         string
    locationName:        string
    displayName:         string
    autoReplyEnabled?:   boolean
    replyTone?:          string
    customInstructions?: string
    promptHints?:        string
  }

  const admin = createAdminClient()
  const { error } = await admin.from('gmb_settings').upsert({
    user_id:             user.id,
    account_name:        body.accountName,
    location_name:       body.locationName,
    display_name:        body.displayName,
    auto_reply_enabled:  body.autoReplyEnabled ?? false,
    reply_tone:          body.replyTone ?? 'professional',
    custom_instructions: body.customInstructions ?? null,
    prompt_hints:        body.promptHints ?? null,
    updated_at:          new Date().toISOString(),
  }, { onConflict: 'user_id,location_name' })

  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ ok: true })
}

export async function DELETE(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const locationName = new URL(request.url).searchParams.get('locationName')
  if (!locationName) return Response.json({ error: 'locationName required' }, { status: 400 })

  const admin = createAdminClient()
  const { error } = await admin
    .from('gmb_settings')
    .delete()
    .eq('user_id', user.id)
    .eq('location_name', locationName)

  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ ok: true })
}
