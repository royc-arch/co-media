/**
 * POST /api/video/stitch
 * Body: { videoJobId: string, videoUrls: string[] }
 *
 * Downloads MP4 clips, concatenates with ffmpeg, uploads the result
 * to Supabase Storage, updates video_jobs, and returns the final video URL.
 *
 * Returns: { videoUrl: string }
 */

import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextRequest }       from 'next/server'
import ffmpegInstaller       from '@ffmpeg-installer/ffmpeg'
import { execFile }          from 'child_process'
import { promisify }         from 'util'
import fs                    from 'fs/promises'
import path                  from 'path'
import os                    from 'os'

export const maxDuration = 120

const execFileAsync = promisify(execFile)

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return new Response('Unauthorized', { status: 401 })

  const body = await request.json() as {
    videoJobId?: string
    videoUrls?: string[]
    useTransitions?: boolean
    clipDurations?: number[]
    fadeDuration?: number
  }
  const { videoJobId, videoUrls, useTransitions = false, clipDurations, fadeDuration = 0.5 } = body

  if (!videoJobId || !Array.isArray(videoUrls) || videoUrls.length < 2) {
    return Response.json({ error: 'Missing videoJobId or videoUrls' }, { status: 400 })
  }

  // Guard: if the ffmpeg binary couldn't be resolved, fail loudly here rather
  // than crashing deep inside execFile.
  if (!ffmpegInstaller?.path) {
    return Response.json(
      { error: 'Video stitching is unavailable: the ffmpeg binary is missing.' },
      { status: 503 },
    )
  }

  const admin  = createAdminClient()
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'retouch-stitch-'))

  try {
    // ── Download each clip ────────────────────────────────────────────
    const clipPaths: string[] = []
    for (let i = 0; i < videoUrls.length; i++) {
      const res = await fetch(videoUrls[i])
      if (!res.ok) throw new Error(`Failed to download clip ${i + 1} (HTTP ${res.status})`)
      const buf      = Buffer.from(await res.arrayBuffer())
      const clipPath = path.resolve(tmpDir, `clip${i}.mp4`)
      await fs.writeFile(clipPath, buf)
      clipPaths.push(clipPath)
    }

    // ── Write concat list (relative filenames, run ffmpeg from tmpDir) ─
    const listPath    = path.resolve(tmpDir, 'list.txt')
    const outputPath  = path.resolve(tmpDir, 'output.mp4')
    const listContent = clipPaths
      .map((_, i) => `file 'clip${i}.mp4'`)
      .join('\n')
    await fs.writeFile(listPath, listContent, 'utf8')

    // ── Run ffmpeg ────────────────────────────────────────────────────
    if (useTransitions && clipPaths.length > 1) {
      // Crossfade between clips using xfade filter with per-clip durations
      const F     = fadeDuration
      const parts: string[] = []
      let prev            = '[0:v]'
      let runningOffset   = 0
      for (let i = 1; i < clipPaths.length; i++) {
        const D      = (clipDurations?.[i - 1]) ?? 5
        runningOffset += D - F
        const offset = runningOffset.toFixed(2)
        const out    = i === clipPaths.length - 1 ? '[vout]' : `[v${i}]`
        parts.push(`${prev}[${i}:v]xfade=transition=fade:duration=${F}:offset=${offset}${out}`)
        prev = out
      }
      await execFileAsync(
        ffmpegInstaller.path,
        [
          ...clipPaths.flatMap(p => ['-i', path.basename(p)]),
          '-filter_complex', parts.join(';'),
          '-map', '[vout]',
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
          '-movflags', '+faststart',
          '-y', 'output.mp4',
        ],
        { cwd: tmpDir },
      )
    } else {
      await execFileAsync(
        ffmpegInstaller.path,
        [
          '-f', 'concat',
          '-safe', '0',
          '-i', 'list.txt',
          '-c', 'copy',
          '-movflags', '+faststart',
          '-y',
          'output.mp4',
        ],
        { cwd: tmpDir },
      )
    }

    // ── Upload to Supabase ────────────────────────────────────────────
    const outputBuf   = await fs.readFile(outputPath)
    const storagePath = `${user.id}/video/${videoJobId}/final.mp4`

    const { error: uploadError } = await admin.storage
      .from('images')
      .upload(storagePath, outputBuf, { contentType: 'video/mp4', upsert: true })
    if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`)

    const videoUrl = admin.storage.from('images').getPublicUrl(storagePath).data.publicUrl

    // ── Update video_jobs ─────────────────────────────────────────────
    await admin.from('video_jobs')
      .update({ status: 'done', video_url: videoUrl })
      .eq('id', videoJobId)

    return Response.json({ videoUrl })

  } catch (err) {
    console.error('[video/stitch] error:', err)
    try {
      await admin.from('video_jobs').update({ status: 'failed' }).eq('id', videoJobId)
    } catch { /* ignore */ }
    return Response.json(
      { error: err instanceof Error ? err.message : 'Stitch failed' },
      { status: 500 },
    )
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}
