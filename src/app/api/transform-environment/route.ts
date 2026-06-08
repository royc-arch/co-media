/**
 * POST /api/transform-environment  (multipart/form-data)
 * Fields: image1 (File|url), image2 (File|url), jobId, intensity, env_analysis?
 *
 * Pipeline:
 *   1. Upload both images to Supabase Storage
 *   2. Parallel:
 *      A. GPT-4o-mini → extract StyleDimensions from reference (lighting paradigm,
 *         contrast, highlights, shadows, colour temp, surface tones, grade, sources)
 *      B. GPT-4o-mini → analyse source environment (8-param panel for UI)
 *   3. Build dynamic prompt from extracted dimensions
 *   4. gpt-image-1 → style transfer
 */

import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextRequest }       from 'next/server'
import OpenAI, { toFile }   from 'openai'
import Replicate             from 'replicate'
import sharp                 from 'sharp'

export const maxDuration = 300

// ── Style dimensions — extracted from any reference image ──────────────────────

export type SubjectAdjustment = {
  brightness: string
  color:      string
  rule:       string
}

export type StyleDimensions = {
  lighting_paradigm:       string  // chiaroscuro / soft ambient / high-key / dramatic directional / etc.
  brightness_distribution: string  // dramatic pools / even ambient / side gradient / overhead wash / etc.
  contrast_ratio:          string  // extreme / high / moderate / low / flat
  highlight_treatment:     string  // preserved bright / slightly compressed / flat
  shadow_depth:            string  // near-black / deep soft / moderate / shallow / minimal
  color_temperature:       string  // e.g. "2700K warm tungsten amber"
  dominant_surface_tones:  string  // e.g. "dark charcoal walls, warm wood table tops, dark concrete floor"
  color_grade_style:       string  // warm film / neutral clean / cool editorial / golden cinematic / etc.
  light_source_types:      string  // e.g. "focused overhead spotlights, subtle floor accent"
  light_directionality:    string  // e.g. "top-down concentrated on surfaces"
  post_processing_feel:    string  // e.g. "slight shadow lift, preserved highlights, warm grade, vignette"
  subjects: {
    table_tops:    SubjectAdjustment
    walls_ceiling: SubjectAdjustment
    floor:         SubjectAdjustment
    light_fixtures:{ rule: string }
  }
}

// ── Style extraction prompt ────────────────────────────────────────────────────

const STYLE_EXTRACTION_PROMPT = `You are a professional lighting director and colorist.
Analyse this reference image and extract its lighting and atmosphere dimensions for use in a style transfer system.
Output STRICT JSON only — no explanation, no markdown, no code fences.

{
  "lighting_paradigm": "",
  "brightness_distribution": "",
  "contrast_ratio": "",
  "highlight_treatment": "",
  "shadow_depth": "",
  "color_temperature": "",
  "dominant_surface_tones": "",
  "color_grade_style": "",
  "light_source_types": "",
  "light_directionality": "",
  "post_processing_feel": "",
  "subjects": {
    "table_tops":    { "brightness": "", "color": "", "rule": "" },
    "walls_ceiling": { "brightness": "", "color": "", "rule": "" },
    "floor":         { "brightness": "", "color": "", "rule": "" },
    "light_fixtures":{ "rule": "" }
  }
}

Field guidance (be specific and descriptive, not generic):
- lighting_paradigm: the core lighting technique — chiaroscuro / soft ambient / high-key / dramatic directional / window light / candlelit / diffused natural / etc.
- brightness_distribution: how light spreads across the space — dramatic pools on surfaces only / even diffused ambient fill / side gradient from windows / overhead wash / mixed
- contrast_ratio: the gap between lightest and darkest areas — extreme / high / moderate / low / flat
- highlight_treatment: how bright are the lit surfaces — preserved bright (surfaces glow, highlights clearly visible and strong) / slightly compressed / flat (no visible highlights)
- shadow_depth: how dark are the unlit areas — near-black (almost no shadow detail) / deep soft-edged / moderate / shallow / minimal
- color_temperature: Kelvin + descriptor, e.g. "2700K warm tungsten amber" or "6000K cool daylight" or "3500K warm neutral white"
- dominant_surface_tones: describe the dominant colour tones of the main surfaces — walls, floor, table tops, ceiling. e.g. "dark charcoal walls, warm natural wood table tops, dark grey concrete floor, warm cedar ceiling".
- color_grade_style: the overall colour treatment — warm film / neutral clean / cool editorial / golden cinematic / desaturated matte / earthy warm / etc.
- light_source_types: what types of light sources are visible or implied — e.g. "focused overhead spotlights and subtle floor-level accent wash" or "large diffused north-facing window" or "pendant lamps with warm glow"
- light_directionality: how and where light falls — e.g. "top-down concentrated pools on surfaces" or "45-degree soft side window" or "omnidirectional ambient with no clear direction"
- post_processing_feel: the editing treatment — e.g. "slight shadow lift in deep darks, highlights preserved and bright, warm amber colour grade, subtle corner vignette" or "clean natural, minimal processing" or "high clarity on textures, rich colour saturation"

Subject guidance (describe what each surface looks like IN THE REFERENCE IMAGE):
- subjects.table_tops.brightness: brightness of table top surfaces — e.g. "bright warm glow" / "moderately lit" / "dark and shadowed"
- subjects.table_tops.color: colour tone of table top surfaces — e.g. "warm amber" / "golden honey" / "cool white"
- subjects.table_tops.rule: generation instruction — e.g. "preserve bright highlights, do NOT darken" / "keep moderately lit with warm tone"
- subjects.walls_ceiling.brightness: brightness of walls and ceiling — e.g. "near-black" / "dark grey" / "mid-tone ambient"
- subjects.walls_ceiling.color: colour tone of walls and ceiling — e.g. "neutral dark charcoal, no warm cast" / "cool dark grey" / "warm beige"
- subjects.walls_ceiling.rule: generation instruction — e.g. "push to near-black, strip ambient fill" / "keep dark with minimal ambient"
- subjects.floor.brightness: brightness of the floor — e.g. "dark" / "mid-tone" / "bright"
- subjects.floor.color: colour tone of the floor — e.g. "neutral dark grey" / "warm brown" / "cool slate"
- subjects.floor.rule: generation instruction — e.g. "dark neutral, retain minimal texture detail" / "moderate ambient fill, warm tone"
- subjects.light_fixtures.rule: how to treat pendant lights and ceiling fixtures — e.g. "preserve exact position, shape and warm glow — do not remove or alter" / "preserve shape, apply warm amber colour"

ALL values must be in English.`

// ── Build dynamic generation prompt from extracted dimensions ──────────────────

function buildPromptFromDimensions(
  dims: StyleDimensions,
  intensity: number,
  envOptPrompt: string,
): string {
  const intensityDesc =
    intensity >= 90 ? 'full_strength' :
    intensity >= 70 ? 'strong' :
    intensity >= 50 ? 'moderate' :
    intensity >= 30 ? 'subtle' :
                      'very_subtle'

  const envSection = envOptPrompt
    ? `,\n  "source_space_adjustments": ${JSON.stringify(envOptPrompt)}`
    : ''

  return `Transform this dining environment to match the reference lighting style exactly.

STYLE_TRANSFER_SPEC: ${JSON.stringify({
    reference_style: {
      lighting_paradigm:       dims.lighting_paradigm,
      brightness_distribution: dims.brightness_distribution,
      contrast_ratio:          dims.contrast_ratio,
      highlight_treatment:     dims.highlight_treatment,
      shadow_depth:            dims.shadow_depth,
      color_temperature:       dims.color_temperature,
      dominant_surface_tones:  dims.dominant_surface_tones,
      color_grade_style:       dims.color_grade_style,
      light_source_types:      dims.light_source_types,
      light_directionality:    dims.light_directionality,
      post_processing_feel:    dims.post_processing_feel,
    },
    subjects: {
      table_tops:    dims.subjects.table_tops,
      walls_ceiling: dims.subjects.walls_ceiling,
      floor:         dims.subjects.floor,
      light_fixtures:dims.subjects.light_fixtures,
    },
    application: {
      intensity: `${intensity}%`,
      strength:  intensityDesc,
    },
    preserve: [
      'furniture layout and positions',
      'architectural structure and proportions',
      'all ceiling fixtures and light fittings — pendant lights, lamps, chandeliers — exact positions and shapes',
      'camera angle and framing',
      'identity of any people present',
    ],
    transform: [
      'apply subjects rules to each surface independently — each subject has its own brightness and colour target',
      'overall lighting atmosphere to match reference_style',
      'colour temperature and colour grade per reference_style',
      'overall contrast to match contrast_ratio value',
    ],
  }, null, 2)}${envSection}`
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

        // ── Step 2: Parallel — extract style dimensions + analyse source ──
        send('progress', { step: 'analyzing', message: 'Reading reference style…' })

        const dimsCall = openai.chat.completions.create({
          model: 'gpt-4o-mini', max_tokens: 600,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: STYLE_EXTRACTION_PROMPT },
              { type: 'image_url', image_url: { url: image2Url, detail: 'high' } },
            ],
          }],
        })

        const envAnalysisCall = !providedEnvAnalysis
          ? openai.chat.completions.create({
              model: 'gpt-4o-mini', max_tokens: 1000,
              messages: [{
                role: 'user',
                content: [
                  { type: 'text', text: ENVIRONMENT_ANALYSIS_PROMPT },
                  { type: 'image_url', image_url: { url: image1Url, detail: 'high' } },
                ],
              }],
            })
          : Promise.resolve(null)

        const [dimsResult, envAnalysisResult] = await Promise.all([dimsCall, envAnalysisCall])

        // Parse style dimensions
        let styleDimensions: StyleDimensions | null = null
        try {
          const raw   = dimsResult.choices[0].message.content?.trim() ?? ''
          const match = raw.match(/\{[\s\S]*\}/)
          if (match) styleDimensions = JSON.parse(match[0])
        } catch { /* continue with fallback */ }

        if (!styleDimensions) {
          // Fallback if extraction fails
          styleDimensions = {
            lighting_paradigm:       'warm ambient with directional accent',
            brightness_distribution: 'moderate ambient with some surface highlights',
            contrast_ratio:          'moderate',
            highlight_treatment:     'slightly compressed',
            shadow_depth:            'moderate',
            color_temperature:       '3000K warm neutral',
            dominant_surface_tones:  'warm neutral surfaces',
            color_grade_style:       'warm natural',
            light_source_types:      'overhead ambient and accent lighting',
            light_directionality:    'overhead diffused',
            post_processing_feel:    'natural, slight warmth',
            subjects: {
              table_tops:    { brightness: 'moderately lit warm', color: 'warm neutral', rule: 'keep warm and visible' },
              walls_ceiling: { brightness: 'dark moderate', color: 'neutral dark', rule: 'keep dark, minimal ambient' },
              floor:         { brightness: 'moderate', color: 'neutral warm', rule: 'retain texture detail' },
              light_fixtures:{ rule: 'preserve exact position, shape and glow' },
            },
          }
        }

        console.log('[transform-env] style_dimensions:', styleDimensions)

        // Parse source environment analysis
        let envAnalysis: EnvironmentAnalysis | null = providedEnvAnalysis
        if (!envAnalysis && envAnalysisResult) {
          const raw = envAnalysisResult.choices[0].message.content?.trim() ?? ''
          try {
            const match = raw.match(/\{[\s\S]*\}/)
            if (match) envAnalysis = JSON.parse(match[0])
          } catch { /* continue without analysis */ }
        }

        const envOptPrompt = envAnalysis ? buildEnvOptPrompt(envAnalysis) : ''

        // ── Step 3: Style transfer ────────────────────────────────────
        send('progress', { step: 'generating', message: 'Applying reference atmosphere…' })

        const origPng  = await sharp(image1Buf).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).png().toBuffer()
        const origFile = await toFile(origPng, 'original.png', { type: 'image/png' })

        const prompt = buildPromptFromDimensions(styleDimensions, intensity, envOptPrompt)

        const editResult = await openai.images.edit({
          model:          'gpt-image-1.5',
          image:          origFile,
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

        send('done', { outputUrl, hdOutputUrl, envAnalysis, styleDimensions })

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
