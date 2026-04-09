import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextRequest }       from 'next/server'

type Ctx = { params: Promise<{ id: string }> }

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return new Response('Unauthorized', { status: 401 })

  const admin = createAdminClient()

  // Verify ownership then delete
  const { data: ref } = await admin
    .from('saved_references')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .single()
  if (!ref) return new Response('Not found', { status: 404 })

  await admin.storage.from('images').remove([`${user.id}/references/${id}.jpg`])
  await admin.from('saved_references').delete().eq('id', id)

  return new Response(null, { status: 204 })
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return new Response('Unauthorized', { status: 401 })

  const { name } = await req.json() as { name?: string }
  if (!name?.trim()) return new Response('Name required', { status: 400 })

  const admin = createAdminClient()
  const { data, error: updateError } = await admin
    .from('saved_references')
    .update({ name: name.trim() })
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single()
  if (updateError) return new Response(updateError.message, { status: 500 })

  return Response.json(data)
}
