import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextRequest }       from 'next/server'

export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return new Response('Unauthorized', { status: 401 })

  const { data, error: dbError } = await supabase
    .from('saved_references')
    .select('*')
    .order('created_at', { ascending: false })

  if (dbError) return new Response(dbError.message, { status: 500 })
  return Response.json(data ?? [])
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return new Response('Unauthorized', { status: 401 })

  const formData = await request.formData()
  const name     = ((formData.get('name') as string | null) ?? '').trim() || 'Untitled'
  const file     = formData.get('file') as File | null
  if (!file) return new Response('Missing file', { status: 400 })

  const admin = createAdminClient()
  const id    = crypto.randomUUID()
  const buf   = Buffer.from(await file.arrayBuffer())
  const path  = `${user.id}/references/${id}.jpg`

  const { error: uploadError } = await admin.storage
    .from('images')
    .upload(path, buf, { contentType: 'image/jpeg', upsert: true })
  if (uploadError) return new Response(uploadError.message, { status: 500 })

  const image_url = admin.storage.from('images').getPublicUrl(path).data.publicUrl

  const { data, error: insertError } = await admin
    .from('saved_references')
    .insert({ id, user_id: user.id, name, image_url })
    .select()
    .single()
  if (insertError) return new Response(insertError.message, { status: 500 })

  return Response.json(data, { status: 201 })
}
