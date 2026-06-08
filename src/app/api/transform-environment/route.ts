/**
 * POST /api/transform-environment  (multipart/form-data)
 * Fields: image1 (File|url), image2 (File|url), jobId, intensity, upscale?
 *
 * Atmosphere / environment transfer (generative).
 * The goal is to re-create the OVERALL VIBE of the reference — its mood,
 * lighting character, colour palette and decor language — on the user's space.
 * The model is given the reference as an actual image and creative latitude to
 * reinterpret decor (lighting, plants, table styling, finishes) so the room
 * belongs to the reference's environment, while keeping the same kind of space,
 * rough layout and camera framing.
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

IMAGE 1 is the user's space — a restaurant / dining interior.
IMAGE 2 is the ATMOSPHERE REFERENCE — the target environment, mood and vibe.

GOAL: Reimagine IMAGE 1 so it FEELS like the environment of IMAGE 2. Capture IMAGE 2's overall atmosphere — its mood, lighting character, colour palette, materials and decor language — and apply that whole "vibe" to IMAGE 1. The result should read as the SAME room, redesigned to live in IMAGE 2's world.

You have creative freedom over decor and finishes to achieve the vibe. Lighting fixtures, table settings, plants and flowers, wall and surface materials, textures and props MAY be reinterpreted, replaced or restyled so they belong to the reference's environment. Do not feel bound to keep every object identical — make the space feel authentically like IMAGE 2.

KEEP recognisable (do not redesign these):
- the general type and scale of the space
- the rough spatial layout — where the bar / counter / tables / windows roughly are
- the camera angle and framing

MATCH from IMAGE 2:
- overall brightness level — bright & airy vs. dark & moody. Read the reference's actual brightness and follow it; do NOT default to a dark/moody look.
- lighting quality, direction and warmth
- colour temperature, colour grade and contrast
- the material, texture and styling language

Do NOT copy IMAGE 2's exact room or its specific objects one-to-one — capture its ENVIRONMENT and atmosphere, then express it in IMAGE 1's space.

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
          input_fidelity: 'low',     // give the model latitude to restyle decor
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
