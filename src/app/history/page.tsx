import { createClient } from '@/lib/supabase/server'
import { redirect }      from 'next/navigation'
import type { Job, VideoJob } from '@/types'
import WorksClient from './HistoryClient'

export default async function WorksPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth')

  const [{ data: jobs }, { data: videoJobs }] = await Promise.all([
    supabase.from('jobs')
      .select('*').eq('user_id', user.id).order('created_at', { ascending: false }),
    supabase.from('video_jobs')
      .select('*').eq('user_id', user.id).order('created_at', { ascending: false })
      .then(r => r, () => ({ data: [] })),
  ])

  return (
    <WorksClient
      jobs={(jobs as Job[]) ?? []}
      videoJobs={(videoJobs as VideoJob[]) ?? []}
    />
  )
}
