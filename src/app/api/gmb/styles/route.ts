/**
 * GET    /api/gmb/styles?locationName=...  — list saved styles for a location
 * POST   /api/gmb/styles                   — create new style
 * PATCH  /api/gmb/styles?id=...            — update override_text for a style
 * DELETE /api/gmb/styles?id=...            — delete a style
 * PUT    /api/gmb/styles                   — set a style as active (updates gmb_settings.prompt_hints)
 */
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextRequest }       from 'next/server'

export interface GmbStyle {
  id:            string
  location_name: string
  name:          string
  stars:         number
  style_text:    string
  override_text: string | null
  keywords:      string | null
  context:       string | null
  created_at:    string
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const locationName = new URL(request.url).searchParams.get('locationName')
  let query = supabase
    .from('gmb_styles')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (locationName) query = query.eq('location_name', locationName)

  const { data, error } = await query
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ styles: data ?? [] })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json() as {
    locationName: string
    name:         string
    stars:        number
    styleText:    string
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('gmb_styles')
    .insert({
      user_id:       user.id,
      location_name: body.locationName,
      name:          body.name,
      stars:         body.stars,
      style_text:    body.styleText,
    })
    .select()
    .single()

  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ style: data })
}

export async function PATCH(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const id           = new URL(request.url).searchParams.get('id')
  if (!id) return Response.json({ error: 'id required' }, { status: 400 })

  const body = await request.json() as {
    overrideText?: string | null
    applyMask?:    number | null
    keywords?:     string | null
    context?:      string | null
  }

  const patch: Record<string, unknown> = {}
  if (body.overrideText !== undefined) patch.override_text = body.overrideText ?? null
  if (body.applyMask    !== undefined) patch.apply_mask    = body.applyMask    ?? null
  if (body.keywords     !== undefined) patch.keywords      = body.keywords     ?? null
  if (body.context      !== undefined) patch.context       = body.context      ?? null

  const admin = createAdminClient()
  const { error } = await admin
    .from('gmb_styles')
    .update(patch)
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ ok: true })
}

export async function DELETE(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const id = new URL(request.url).searchParams.get('id')
  if (!id) return Response.json({ error: 'id required' }, { status: 400 })

  const admin = createAdminClient()
  const { error } = await admin
    .from('gmb_styles')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ ok: true })
}

export async function PUT(request: NextRequest) {
  // Set a style as active — copies its text into gmb_settings.prompt_hints
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { id, locationName } = await request.json() as { id: string; locationName: string }

  // Fetch the style
  const { data: style, error: fetchErr } = await supabase
    .from('gmb_styles')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .single()

  if (fetchErr || !style) return Response.json({ error: 'Style not found' }, { status: 404 })

  const applyMask = (style as { apply_mask?: number | null }).apply_mask ?? (1 << (style.stars - 1))
  const hints = `${style.name}||${style.stars}||${applyMask}||${style.style_text}`

  const admin = createAdminClient()
  const { error } = await admin
    .from('gmb_settings')
    .update({ prompt_hints: hints, updated_at: new Date().toISOString() })
    .eq('user_id', user.id)
    .eq('location_name', locationName)

  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ ok: true, hints })
}
