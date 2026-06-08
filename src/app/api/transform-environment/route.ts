/**
 * POST /api/transform-environment  (multipart/form-data)
 * Fields: image1 (File|url), image2 (File|url), jobId, intensity, env_analysis?
 *
 * Pipeline:
 *   1. Upload both images to Supabase Storage
 *   2. GPT-4o-mini → analyse the SOURCE space (8-param panel for the UI +
 *      light source-space adjustment hints)
 *   3. gpt-image-1.5 → style transfer with BOTH images as visual input:
 *      image 1 = the space to transform, image 2 = the lighting/atmosphere
 *      reference the model actually looks at (no lossy image→text step)
 */

import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextRequest }       from 'next/server'
import OpenAI, { toFile }   from 'openai'
import Replicate             from 'replicate'
import sharp                 from 'sharp'

export const maxDuration = 300

// ── Build the style-transfer prompt ────────────────────────────────────────────
// The reference is supplied to the model as an actual image (see the edit call),
// so the prompt only has to explain the ROLES of the two images and what to
// preserve — not describe the reference in words.

function buildTransferPrompt(intensity: number, envOptPrompt: string): string {
  const intensityDesc =
    intensity >= 90 ? 'full strength — fully match the reference' :
    intensity >= 70 ? 'strong'      :
    intensity >= 50 ? 'moderate'    :
    intensity >= 30 ? 'subtle'      :
                      'very subtle'

  const envSection = envOptPrompt
    ? `\n\nAdditional source-space adjustments (apply where they do not conflict with the reference):\n${envOptPrompt}`
    : ''

  return `You are given TWO images.

IMAGE 1 is the dining space to transform — this is the base. Keep it.
IMAGE 2 is the STYLE REFERENCE — use it ONLY as a lighting, colour and mood reference.

TASK: Re-light and colour-grade IMAGE 1 so its atmosphere matches IMAGE 2. Match IMAGE 2's:
- overall brightness level (bright & airy vs. dark & moody)
- lighting quality and direction (soft/even vs. dramatic/directional)
- colour temperature (warm/cool) and colour grade
- contrast and shadow depth

CRITICAL — match the OVERALL BRIGHTNESS of IMAGE 2. If IMAGE 2 is bright, high-key and airy, the result MUST be bright and airy. If IMAGE 2 is dark and moody, the result MUST be dark and moody. Do NOT default to a dark/moody look — read the reference's actual brightness and follow it.

PRESERVE from IMAGE 1 exactly (do not change):
- furniture layout and positions
- architectural structure and proportions
- every ceiling fixture and light fitting — positions and shapes
- camera angle and framing
- the identity of any people present

DO NOT copy any objects, furniture, materials, signage, tiles, or architecture FROM IMAGE 2 into the result. IMAGE 2 is only an atmosphere reference, never a source of content.

Application strength: ${intensity}% (${intensityDesc}).${envSection}`
}

// ── Environment analysis types ─────────────────────────────────────────────────

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

// ── Environment analysis prompt ────────────────────────────────────────────────

const ENVIRONMENT_ANALYSIS_PROMPT = `You are a professional restaurant and dining environment photography optimization AI.

Your task is to analyze a dining space or interior photo based on its VISUAL PROPERTIES, then generate optimization guidance for style transfer.

---

## Step 1: Identify the space

Identify:
- Space type: intimate dining room / open restaurant hall / outdoor terrace / bar / café / private room / other
- Primary mood: warm & cozy / dramatic & moody / clean & modern / rustic & earthy / airy & bright

---

## Step 2: Assess Overall Quality (0–10)

- 8–10: Well-lit, atmosphere reads clearly, surfaces have visible texture and depth. Minimal intervention needed.
- 4–7:  Decent but has specific lighting or color issues that could be improved.
- 0–3:  Flat, muddy, or poorly lit — needs comprehensive enhancement.

---

## Step 3: Generate Optimization Guidance

Output in 4 categories:

### Lighting
(ambient light quality, shadow behavior, directional light sources, any harsh or lost highlights)

### Atmosphere
(depth, mood clarity, environmental haze or fog, overall emotional tone)

### Color
(surface color warmth, saturation levels, color temperature consistency, any color cast issues)

### Texture
(surface detail quality: wood grain, stone, fabric, walls, flooring — sharp or muddy?)

---

## Step 4: Parameter Directions (NO NUMBERS)

Directions only:
- increase
- decrease
- slightly increase
- slightly decrease
- keep moderate
- reduce aggressively

If a parameter already looks well-executed — output "keep moderate".

---

## Output Format (STRICT JSON)

Return ONLY this JSON:

{
  "space_type": "",
  "primary_mood": "",
  "quality_score": 0,
  "editing_plan": {
    "lighting": [],
    "atmosphere": [],
    "color": [],
    "texture": []
  },
  "parameter_directions": {
    "overall_brightness": "",
    "ambient_light_warmth": "",
    "shadow_depth": "",
    "contrast_level": "",
    "color_saturation": "",
    "atmosphere_clarity": "",
    "texture_definition": "",
    "depth_rendering": "",
    "color_temperature": ""
  }
}

---

## Rules

- ALL output values must be in English
- Do NOT output anything outside JSON`

// ── Build env optimization section from source analysis ────────────────────────

function buildEnvOptPrompt(env: EnvironmentAnalysis): string {
  const score = env.quality_score ?? 5
  const tier  = score >= 7 ? 'high' : score >= 4 ? 'mid' : 'low'

  const tonePrefix =
    tier === 'high'
      ? `Source space quality already high (score ${score}/10). Apply enhancements conservatively.`
      : tier === 'mid'
      ? `Source space quality decent (score ${score}/10). Apply targeted enhancements.`
      : `Source space needs significant improvement (score ${score}/10). Apply comprehensive enhancements.`

  const editingLines = [
    ...env.editing_plan.lighting,
    ...env.editing_plan.atmosphere,
    ...env.editing_plan.color,
    ...env.editing_plan.texture,
  ].map(l => `- ${l}`).join('\n')

  const paramEntries   = Object.entries(env.parameter_directions)
  const relevantParams = tier === 'high'
    ? paramEntries.filter(([, v]) => v !== 'keep moderate')
    : paramEntries

  if (tier === 'high' && relevantParams.length === 0)
    return `Source quality ${score}/10 — no specific adjustments needed.`

  const paramLines = relevantParams.map(([k, v]) => `- ${k}: ${v}`).join('\n')

  return `${tonePrefix}

Editing objectives:
${editingLines}

Parameter directions:
${paramLines}`
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

  const formData       = await request.formData()
  const image1File     = formData.get('image1')      as File | null
  const image2File     = formData.get('image2')      as File | null
  const image1UrlIn    = formData.get('image1_url')  as string | null
  const image2UrlIn    = formData.get('image2_url')  as string | null
  const jobId          = formData.get('jobId')       as string | null
  const intensity      = Math.min(100, Math.max(10, Number(formData.get('intensity') ?? 80)))
  const upscale        = formData.get('upscale') === '1'
  const envAnalysisRaw = formData.get('env_analysis') as string | null

  let providedEnvAnalysis: EnvironmentAnalysis | null = null
  if (envAnalysisRaw) {
    try { providedEnvAnalysis = JSON.parse(envAnalysisRaw) } catch { /* ignore */ }
  }

  if ((!image1File && !image1UrlIn) || (!image2File && !image2UrlIn) || !jobId)
    return new Response('Missing required fields', { status: 400 })

  const openai     = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const replicate  = new Replicate({ auth: process.env.REPLICATE_API_TOKEN })
  const admin      = createAdminClient()
  const encoder    = new TextEncoder()

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

        // ── Step 2: Analyse the SOURCE space (UI panel + opt hints) ────
        send('progress', { step: 'analyzing', message: 'Analysing your space & reading reference…' })

        let envAnalysis: EnvironmentAnalysis | null = providedEnvAnalysis
        if (!envAnalysis) {
          const envAnalysisResult = await openai.chat.completions.create({
            model: 'gpt-4o-mini', max_tokens: 1000,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: ENVIRONMENT_ANALYSIS_PROMPT },
                { type: 'image_url', image_url: { url: image1Url, detail: 'high' } },
              ],
            }],
          })
          const raw = envAnalysisResult.choices[0].message.content?.trim() ?? ''
          try {
            const match = raw.match(/\{[\s\S]*\}/)
            if (match) envAnalysis = JSON.parse(match[0])
          } catch { /* continue without analysis */ }
        }

        const envOptPrompt = envAnalysis ? buildEnvOptPrompt(envAnalysis) : ''

        // ── Step 3: Style transfer — model sees BOTH images ───────────
        send('progress', { step: 'generating', message: 'Applying reference atmosphere…' })

        const toPng = (buf: Buffer) =>
          sharp(buf).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).png().toBuffer()

        const [origPng, refPng] = await Promise.all([toPng(image1Buf), toPng(image2Buf)])
        const origFile = await toFile(origPng, 'original.png',  { type: 'image/png' })
        const refFile  = await toFile(refPng,  'reference.png', { type: 'image/png' })

        const prompt = buildTransferPrompt(intensity, envOptPrompt)

        const editResult = await openai.images.edit({
          model:          'gpt-image-1.5',
          image:          [origFile, refFile],
          prompt,
          input_fidelity: 'high',
          quality:        'high',
          size:           '1536x1024',
          output_format:  'png',
        })

        const imgData = editResult.data?.[0]
        let outputBuffer: Buffer
        if (imgData?.b64_json)     outputBuffer = Buffer.from(imgData.b64_json, 'base64')
        else if (imgData?.url)     outputBuffer = await fetchBuffer(imgData.url)
        else throw new Error('gpt-image-1 returned no image data')

        // ── Step 4: Upload result ─────────────────────────────────────
        const outputUrl = await upload(outputBuffer, 'output', 'image/png')

        // ── Step 5: Optional HD upscale via Replicate Real-ESRGAN ────
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

        send('done', { outputUrl, hdOutputUrl, envAnalysis })

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
