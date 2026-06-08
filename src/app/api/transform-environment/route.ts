/**
 * POST /api/transform-environment  (multipart/form-data)
 * Fields: image1 (File|url), image2 (File|url), jobId, intensity, upscale?
 *
 * Atmosphere / environment transfer (generative).
 * The goal is to re-light and re-mood the user's space so it FEELS like the
 * reference's environment (mood, lighting, colour grade, ambiance), while
 * KEEPING the layout, object positions, and the shape & material of the tables
 * and furniture unchanged. input_fidelity 'high' locks geometry; the prompt
 * pushes the atmosphere change. Faces / tiny details are not preserved.
 *
 * Pipeline:
 *   1. Upload both images to Supabase Storage
 *   2. gpt-image-1.5 images.edit with BOTH images (source + atmosphere reference)
 *   3. Optional Real-ESRGAN HD upscale
 */

import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextRequest }       from 'next/server'
import OpenAI, { toFile }   from 'openai'
import Replicate             from 'replicate'
import sharp                 from 'sharp'

export const maxDuration = 300

// Kept for backwards compatibility with the page's type import.
export type EnvironmentAnalysis = {
  space_type:    string
  primary_mood:  string
  quality_score: number
  editing_plan: {
    lighting:   string[]
    atmosphere: string[]
    color:      string[]
    texture:    string[]
  }
  parameter_directions: Record<string, string>
}

// ── Atmosphere-transfer prompt ──────────────────────────────────────────────────
// The reference is supplied as an image (see the edit call), so the prompt only
// has to set the goal, the creative latitude, and what to keep recognisable.

function buildTransferPrompt(intensity: number): string {
  const strength =
    intensity >= 90 ? 'Fully commit to the reference environment.' :
    intensity >= 70 ? 'Strongly adopt the reference environment.'  :
    intensity >= 50 ? 'Moderately adopt the reference environment, keeping more of the original.' :
    intensity >= 30 ? 'Lightly nudge toward the reference environment.' :
                      'Apply only a subtle hint of the reference environment.'

  return `You are given TWO images.

IMAGE 1 is the user's space — a restaurant / dining interior. This is the room to keep.
IMAGE 2 is the ATMOSPHERE REFERENCE — the target environment, mood and vibe.

GOAL: Re-light and re-mood IMAGE 1 so it FEELS like the environment of IMAGE 2. Transfer IMAGE 2's whole atmosphere — its mood, lighting character and direction, colour temperature, colour grade, contrast and overall ambiance — onto IMAGE 1, so the room feels like it lives in IMAGE 2's world. Be bold with the ATMOSPHERE; this is the point.

PRESERVE EXACTLY from IMAGE 1 — these must NOT change:
- the overall spatial layout and composition
- the position of every object and piece of furniture — do not move, add or remove tables, chairs, counters, fixtures or props
- the SHAPE and MATERIAL of the tables and furniture (e.g. the same wood stays the same wood, same shape)
- architectural structure and proportions, camera angle and framing

YOU MAY freely change to achieve the vibe:
- lighting — brightness, warmth, direction, pools of light, shadows, glow, reflections
- overall colour grade, contrast and atmosphere
- ambient mood and the feel of surfaces (without changing what the objects ARE or where they sit)
Faces and tiny incidental details do NOT need to be preserved.

MATCH IMAGE 2's overall brightness level — if the reference is bright & airy, the result must be bright & airy; if it is dark & moody, the result must be dark & moody. Read the reference's actual brightness and follow it; do NOT default to a dark look.

Do NOT copy IMAGE 2's room, furniture or objects into the result. IMAGE 2 is ONLY an atmosphere reference — keep IMAGE 1's own objects, in their own places, in their own shapes.

${strength}`
}

// ─────────────────────────────────────────────────────────────────────────────

function sseEvent(type: string, data: object): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch (${res.status}): ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return new Response('Unauthorized', { status: 401 })

  const formData    = await request.formData()
  const image1File  = formData.get('image1')     as File | null
  const image2File  = formData.get('image2')     as File | null
  const image1UrlIn = formData.get('image1_url') as string | null
  const image2UrlIn = formData.get('image2_url') as string | null
  const jobId       = formData.get('jobId')      as string | null
  const intensity   = Math.min(100, Math.max(10, Number(formData.get('intensity') ?? 80)))
  const upscale     = formData.get('upscale') === '1'

  if ((!image1File && !image1UrlIn) || (!image2File && !image2UrlIn) || !jobId)
    return new Response('Missing required fields', { status: 400 })

  const openai    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN })
  const admin     = createAdminClient()
  const encoder   = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const send = (type: string, data: object) =>
        controller.enqueue(encoder.encode(sseEvent(type, data)))

      try {
        // ── Step 1: Upload ────────────────────────────────────────────
        send('progress', { step: 'uploading', message: 'Uploading images…' })

        const image1Buf = image1File ? Buffer.from(await image1File.arrayBuffer()) : await fetchBuffer(image1UrlIn!)
        const image2Buf = image2File ? Buffer.from(await image2File.arrayBuffer()) : await fetchBuffer(image2UrlIn!)

        const upload = async (buf: Buffer, name: string, type = 'image/jpeg'): Promise<string> => {
          const ext  = type === 'image/png' ? 'png' : 'jpg'
          const path = `${user.id}/${jobId}/${name}.${ext}`
          let { error } = await admin.storage.from('images').upload(path, buf, { contentType: type, upsert: true })
          if (error?.message === 'fetch failed') {
            console.warn('[transform-env] storage upload fetch failed, retrying…', { name })
            await new Promise(r => setTimeout(r, 1000))
            ;({ error } = await admin.storage.from('images').upload(path, buf, { contentType: type, upsert: true }))
          }
          if (error) {
            console.error('[transform-env] storage upload error:', { name, error })
            throw new Error(`Storage upload failed: ${error.message}`)
          }
          return admin.storage.from('images').getPublicUrl(path).data.publicUrl
        }

        const [image1Url, image2Url] = await Promise.all([
          upload(image1Buf, 'original'),
          upload(image2Buf, 'reference'),
        ])

        await admin.from('jobs').upsert({
          id: jobId, user_id: user.id,
          image1_url: image1Url, image2_url: image2Url,
          status: 'processing',
        })

        // ── Step 2: Atmosphere transfer — model sees BOTH images ──────
        send('progress', { step: 'generating', message: 'Recreating the reference atmosphere…' })

        const toPng = (buf: Buffer) =>
          sharp(buf).resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).png().toBuffer()

        const [origPng, refPng] = await Promise.all([toPng(image1Buf), toPng(image2Buf)])
        const origFile = await toFile(origPng, 'original.png',  { type: 'image/png' })
        const refFile  = await toFile(refPng,  'reference.png', { type: 'image/png' })

        const editResult = await openai.images.edit({
          model:          'gpt-image-1.5',
          image:          [origFile, refFile],
          prompt:         buildTransferPrompt(intensity),
          input_fidelity: 'high',    // lock layout, object positions, table shape & material
          quality:        'high',
          size:           'auto',    // keep the source's aspect / framing
          output_format:  'png',
        })

        const imgData = editResult.data?.[0]
        let outputBuffer: Buffer
        if (imgData?.b64_json)     outputBuffer = Buffer.from(imgData.b64_json, 'base64')
        else if (imgData?.url)     outputBuffer = await fetchBuffer(imgData.url)
        else throw new Error('gpt-image returned no image data')

        // ── Step 3: Upload result ─────────────────────────────────────
        const outputUrl = await upload(outputBuffer, 'output', 'image/png')

        // ── Step 4: Optional HD upscale via Replicate Real-ESRGAN ────
        let hdOutputUrl: string | null = null
        if (upscale) {
          send('progress', { step: 'upscaling', message: 'Enhancing to HD…' })
          try {
            const hdResult = await replicate.run(
              'nightmareai/real-esrgan:42fed1c4974146d4d2414e2be2c5277c7fcf05fcc3a73abf41610695738c1d7b',
              { input: { image: outputUrl, scale: 4, face_enhance: false } }
            )
            const hdUrl = Array.isArray(hdResult) ? String(hdResult[0]) : String(hdResult)
            if (hdUrl) {
              const hdBuf = await fetchBuffer(hdUrl)
              hdOutputUrl = await upload(hdBuf, 'output_hd', 'image/png')
            }
          } catch (err) {
            console.warn('[transform-env] HD upscale failed, skipping:', err)
          }
        }

        await admin.from('jobs').update({ output_url: outputUrl, status: 'done' }).eq('id', jobId)

        send('done', { outputUrl, hdOutputUrl })

      } catch (err) {
        const message = err instanceof Error ? err.message : 'An unexpected error occurred'
        try { await admin.from('jobs').update({ status: 'failed' }).eq('id', jobId) } catch {}
        send('error', { message })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
    },
  })
}
