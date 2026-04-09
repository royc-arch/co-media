/**
 * GET /api/video/status?taskId=xxx&videoJobId=xxx
 * Polls Kling for job status. When done, saves to video_jobs.
 * Returns: { status: 'processing' | 'done' | 'failed', videoUrl?: string }
 */

import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextRequest }       from 'next/server'
import crypto                from 'crypto'

function klingJWT(): string {
  const accessKey = process.env.KLING_ACCESS_KEY!
  const secretKey = process.env.KLING_SECRET_KEY!
  const now       = Math.floor(Date.now() / 1000)
  const header    = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload   = Buffer.from(JSON.stringify({ iss: accessKey, exp: now + 1800, nbf: now - 5 })).toString('base64url')
  const sig       = crypto.createHmac('sha256', secretKey).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return new Response('Unauthorized', { status: 401 })

  const taskId     = request.nextUrl.searchParams.get('taskId')
  const videoJobId = request.nextUrl.searchParams.get('videoJobId')
  if (!taskId) return Response.json({ error: 'Missing taskId' }, { status: 400 })

  const res  = await fetch(`https://api.klingai.com/v1/videos/image2video/${taskId}`, {
    headers: { 'Authorization': `Bearer ${klingJWT()}` },
  })
  const json = await res.json()

  console.log('[video/status] Kling response:', JSON.stringify(json).slice(0, 400))

  if (!res.ok || json.code !== 0) {
    if (videoJobId) {
      const admin = createAdminClient()
      try { await admin.from('video_jobs').update({ status: 'failed' }).eq('id', videoJobId) } catch { /* ignore */ }
    }
    return Response.json({ status: 'failed', error: json.message ?? 'Kling error' }, { status: 500 })
  }

  const taskStatus = json.data?.task_status as string | undefined

  // Kling uses 'succeed' for older models; v3 may use 'completed'
  const isDone   = taskStatus === 'succeed' || taskStatus === 'completed'
  const isFailed = taskStatus === 'failed'

  if (isDone) {
    const videoUrl = json.data?.task_result?.videos?.[0]?.url
    if (videoJobId && videoUrl) {
      const admin = createAdminClient()
      try {
        await admin.from('video_jobs')
          .update({ status: 'done', video_url: videoUrl })
          .eq('id', videoJobId)
      } catch (e) {
        console.error('[video/status] failed to update video_jobs:', e)
      }
    }
    return Response.json({ status: 'done', videoUrl })
  }

  if (isFailed) {
    if (videoJobId) {
      const admin = createAdminClient()
      try { await admin.from('video_jobs').update({ status: 'failed' }).eq('id', videoJobId) } catch { /* ignore */ }
    }
    return Response.json({ status: 'failed', error: json.data?.task_status_msg ?? 'Generation failed' })
  }

  return Response.json({ status: 'processing' })
}
