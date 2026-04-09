import { createClient } from '@/lib/supabase/server'
import { redirect }      from 'next/navigation'
import ReferencesClient  from './ReferencesClient'

export default async function ReferencesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth')

  const { data: refs } = await supabase
    .from('saved_references')
    .select('*')
    .order('created_at', { ascending: false })

  return <ReferencesClient initialRefs={refs ?? []} />
}
