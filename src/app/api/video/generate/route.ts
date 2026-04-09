/**
 * POST /api/video/generate
 * Body: multipart/form-data
 *   image     File   — subject food photo (required)
 *   reference File?  — style/atmosphere reference (optional)
 *   showcase  string — hero_push | orbit | birdview | detail | three_act
 *   duration  string — "10" | "15"  (ignored for three_act, always 5s × 4 clips)
 *
 * Returns: SSE stream
 *   event: progress  data: { step: string, message: string }
 *   event: done      data: { taskId?: string, clipTaskIds?: string[], videoJobId: string }
 *   event: error     data: { message: string }
 */

import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextRequest }       from 'next/server'
import OpenAI, { toFile }   from 'openai'
import Replicate             from 'replicate'
import sharp                 from 'sharp'
import crypto                from 'crypto'

export const maxDuration = 300

// ── Kling JWT ─────────────────────────────────────────────────────────────────

function klingJWT(): string {
  const accessKey = process.env.KLING_ACCESS_KEY!
  const secretKey = process.env.KLING_SECRET_KEY!
  const now       = Math.floor(Date.now() / 1000)
  const header    = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload   = Buffer.from(JSON.stringify({ iss: accessKey, exp: now + 1800, nbf: now - 5 })).toString('base64url')
  const sig       = crypto.createHmac('sha256', secretKey).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
}

// ── Showcase prompts ──────────────────────────────────────────────────────────

type ShowcaseType = 'hero_push' | 'orbit' | 'birdview' | 'detail' | 'three_act'

// Structured camera config per showcase type
// Format follows: subject → static constraint → shot → camera movement → lighting → rhythm → quality
const SHOWCASE_CAMERA: Record<Exclude<ShowcaseType, 'three_act'>, {
  shot:     string
  movement: string
  rhythm:   string
}> = {
  hero_push: {
    shot:     'medium shot, camera at table height 10–15 degrees above horizontal, full composition visible in frame',
    movement: 'slow dolly-in along the optical Z-axis only, no subject tracking, no lateral drift, no reframing — the entire composition scales up uniformly, camera travels approximately 25–35% closer over the full 5 seconds',
    rhythm:   'opens with full composition in frame → steady uniform push → ends with composition 25–35% larger, every element still visible',
  },
  orbit: {
    shot:     'medium shot, camera at 20 degrees above horizontal, constant height throughout, dish centered in frame',
    movement: 'camera rotate — very slow rotation around the dish, approximately 35 degrees total over 5 seconds, constant radius and height, dish stays centered in frame throughout',
    rhythm:   'starts at frontal view → slow camera rotate → ends 35 degrees to the right of starting position',
  },
  birdview: {
    shot:     'starts as medium shot at 25 degrees above horizontal facing dish from front, dish centered in frame',
    movement: 'camera arcs upward in a smooth continuous movement along a vertical arc, dish stays centered throughout the arc, ends at pure 90 degree overhead top-down position',
    rhythm:   'low front angle establishing view → smooth upward arc → pure top-down flat-lay overhead reveal at clip end',
  },
  detail: {
    shot:     'extreme macro close-up from first frame, lens already 8–12cm from food surface, ultra-shallow depth of field with 2–3cm focus plane, background fully out of focus',
    movement: 'Camera very slowly and smoothly slide horizontally from left to right, approximately 3–5mm total travel over 5 seconds, stays at macro distance throughout, no vertical movement, no push, no zoom, no camera shake',
    rhythm:   'holds the macro frame perfectly still for the full duration — texture and surface detail fill the frame throughout',
  },
}

function buildShowcasePrompt(
  showcaseKey: Exclude<ShowcaseType, 'three_act'>,
  dishSubject: string,
  dishExclude: string,
): string {
  const cam         = SHOWCASE_CAMERA[showcaseKey]
  const staticLine  = [
    'dish completely static, no food movement',
    dishExclude ? `do NOT show ${dishExclude}` : '',
    'no steam, no sauce drip, no liquid movement, no deformation',
  ].filter(Boolean).join(', ')

  return [
    dishSubject,
    staticLine,
    cam.shot,
    cam.movement,
    'lighting and color temperature preserved from input image, no changes to atmosphere or color grading',
    `rhythm: ${cam.rhythm}`,
    'preserve exact plating and food arrangement, 4K high definition, premium food commercial',
  ].join('. ')
}


// ── Style classification ──────────────────────────────────────────────────────

type StyleCategory = 'moody_fine_dining' | 'clean_fresh' | 'warm_comfort' | 'commercial_vivid' | 'soft_lifestyle'

function classifyStyle(s: { saturation: number; contrast: number; density: number; softness: number }): StyleCategory {
  if (s.density >= 7 && s.saturation >= 6 && s.softness <= 6)                                     return 'commercial_vivid'
  if (s.saturation >= 6 && s.contrast >= 4 && s.contrast <= 6 && s.density >= 4 && s.density <= 6) return 'commercial_vivid'
  if (s.contrast >= 7 && s.saturation <= 6 && s.density <= 6)                                      return 'moody_fine_dining'
  if (s.softness >= 7 && s.contrast <= 5 && s.density <= 6)                                        return 'soft_lifestyle'
  if (s.saturation <= 4 && s.contrast <= 5 && s.density <= 5)                                      return 'clean_fresh'
  if (Math.abs(s.saturation - 5) <= 1.5 && Math.abs(s.contrast - 5) <= 1.5 && s.softness <= 6)   return 'warm_comfort'
  return 'clean_fresh'
}

const ATMOSPHERE_PROMPTS: Record<StyleCategory, string> = {
  moody_fine_dining: `You are a professional lighting director. Analyse the lighting in this image. Focus on: KEY LIGHT position and quality, SHADOW DEPTH, CONTRAST STRUCTURE, SUBJECT ISOLATION, COLOUR TEMPERATURE, VIGNETTE strength. Output 3–5 sentences. No bullet points. No background description.`,
  clean_fresh:       `You are a professional lighting director. Analyse the lighting in this image. Focus on: EXPOSURE LEVEL, BACKGROUND BRIGHTNESS, LIGHT DIFFUSION, COLOR SEPARATION, SHADOW SOFTNESS. Output 3–5 sentences. No bullet points.`,
  warm_comfort:      `You are a professional lighting director. Analyse the lighting in this image. Focus on: COLOUR TEMPERATURE (Kelvin), FOOD COLOR BIAS (orange/amber/golden), LIGHT SOFTNESS, MIDTONE CONTRAST. Output 3–5 sentences. No bullet points.`,
  commercial_vivid:  `You are a professional lighting director. Analyse the lighting in this image. Focus on: COLOR INTENSITY, CONTRAST POP, STRUCTURE CLARITY, HIGHLIGHT APPEAL on food, SHADOW CONTROL. Output 3–5 sentences. No bullet points.`,
  soft_lifestyle:    `You are a professional lighting director. Analyse the lighting in this image. Focus on: SOFTNESS, LIGHT DIFFUSION, CONTRAST REDUCTION, AIRINESS, COLOR LIGHTNESS. Output 3–5 sentences. No bullet points.`,
}

const STYLE_DIRECTION: Record<StyleCategory, { direction: string; prohibitions: string }> = {
  moody_fine_dining: {
    direction:    'Apply single directional key light, deep fill shadows, strong vignette, high contrast ratio. Background should be crushed to near-black. Warm tungsten or cool dramatic colour cast.',
    prohibitions: 'Do NOT brighten the background. Do NOT add ambient fill light. Do NOT flatten contrast. Do NOT soften shadows.',
  },
  clean_fresh: {
    direction:    'Apply soft diffused daylight, high ambient light, minimal shadows, neutral to cool colour temperature. Bright even exposure across the entire scene. No vignette.',
    prohibitions: 'Do NOT darken the background. Do NOT add dramatic directional shadows. Do NOT apply warm or amber tones. Do NOT add vignette.',
  },
  warm_comfort: {
    direction:    'Apply warm golden ambient light, soft directional fill, inviting brightness. Colour temperature 3000–3500K. Gentle soft-edged shadows. Background remains visible and warm.',
    prohibitions: 'Do NOT crush the background to black. Do NOT apply dramatic single-source lighting. Do NOT cool the colour temperature. Do NOT add heavy vignette.',
  },
  commercial_vivid: {
    direction:    'Apply high-saturation punchy lighting, strong specular highlights on food surface, clean bright background. Maximum colour separation. Crisp sharp texture rendering.',
    prohibitions: 'Do NOT mute or desaturate colours. Do NOT add moody dark atmosphere. Do NOT soften highlights or reduce contrast.',
  },
  soft_lifestyle: {
    direction:    'Apply soft window light or golden-hour diffusion, gentle wrap-around lighting. Muted warm or pastel tones, airy relaxed atmosphere. Minimal harsh shadows.',
    prohibitions: 'Do NOT add hard directional light. Do NOT over-saturate or punch colours. Do NOT apply heavy contrast or dark vignette.',
  },
}

// ── Dish analysis ─────────────────────────────────────────────────────────────

interface DishAnalysis {
  motion:  string  // detailed cinematic motion description for Kling
  exclude: string  // physics to explicitly exclude
}

function buildDishAnalysisPrompt(dishName?: string): string {
  const dishLine = dishName
    ? `The dish is: ${dishName}. Use the image as supplementary context.`
    : 'Identify the dish from the image.'

  return `You are a food cinematographer writing a Kling AI video subject description. The camera will move — the dish will NOT move.

${dishLine}

Describe the dish's visual appearance as a static subject:
- Key ingredients visible on the surface with their exact textures (e.g. glossy, matte, crispy, translucent, caramelised)
- How light interacts with the surface (specular highlights, subsurface scatter, reflections, sheen)
- Dominant colors and material qualities specific to THIS dish
25–40 words. English only. Describe appearance and light physics only — NOT movement. No adjectives like "beautiful" or "delicious".

Also list any visual effects that must NOT appear in the video (e.g. rising steam for cold dishes, dripping sauce for dry dishes, bubbles for still drinks). Empty string if none apply.

Output strict JSON only, no markdown:
{"motion": "...", "exclude": "..."}`
}

async function analyzeDish(imageBase64: string, openai: OpenAI, dishName?: string): Promise<DishAnalysis> {
  const result = await openai.chat.completions.create({
    model:      'gpt-4o-mini',
    max_tokens: 200,
    messages:   [{
      role:    'user',
      content: [
        { type: 'text',      text:      buildDishAnalysisPrompt(dishName) },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: 'low' } },
      ],
    }],
  })

  try {
    const raw = result.choices[0].message.content?.trim() ?? ''
    const m   = raw.match(/\{[\s\S]*\}/)
    if (m) return JSON.parse(m[0]) as DishAnalysis
  } catch { /* fall through to default */ }

  return { motion: 'subtle specular highlight movement on food surface', exclude: '' }
}

// ── Detail macro crop ─────────────────────────────────────────────────────────

async function cropDetailRegion(
  imageBuf:    Buffer,
  openai:      OpenAI,
  dishName?:   string,
  manualCrop?: { x: number; y: number; w: number; h: number },
): Promise<Buffer> {
  const meta = await sharp(imageBuf).metadata()
  const W    = meta.width  ?? 1000
  const H    = meta.height ?? 1000

  // Manual crop from UI — skip GPT entirely
  if (manualCrop && manualCrop.w > 0.02 && manualCrop.h > 0.02) {
    const left   = Math.max(0, Math.round(manualCrop.x * W))
    const top    = Math.max(0, Math.round(manualCrop.y * H))
    const width  = Math.min(Math.round(manualCrop.w * W), W - left)
    const height = Math.min(Math.round(manualCrop.h * H), H - top)
    console.log(`[cropDetailRegion] manual: left=${left} top=${top} width=${width} height=${height}`)
    return sharp(imageBuf)
      .extract({ left, top, width, height })
      .resize(1280, 1280, { fit: 'inside', withoutEnlargement: false })
      .jpeg({ quality: 92 })
      .toBuffer()
  }

  const b64    = imageBuf.toString('base64')
  const result = await openai.chat.completions.create({
    model:      'gpt-4o',
    max_tokens: 400,
    messages:   [{
      role:    'user',
      content: [
        {
          type: 'text',
          text: `You are a food photographer choosing a macro close-up crop. Think step by step before giving coordinates.

STEP 1 — List every distinct food item visible and its approximate location:
e.g. "sushi roll: left-center, citrus garnish: bottom-right, cocktail: top-right"

STEP 2 — Identify the PRIMARY subject:
${dishName ? `The user specified: "${dishName}". This is the primary subject. Focus on it.` : `Pick the main dish (largest food item, or the one with the richest texture). Ignore garnishes, decorations, and drinks unless they are the only food present.`}

STEP 3 — Output the CENTER POINT of the primary subject as fractions (0.0–1.0):
{"cx": 0.5, "cy": 0.5, "size": 0.45}
- cx, cy = center of the PRIMARY subject
- size = 0.4 for tight macro, 0.5 for slightly wider (use 0.5 if unsure)
- cx/cy must point at food flesh/surface — NOT plate rim, table, background, or garnish

Show your step 1 and step 2 reasoning, then end with the JSON on the last line.`,
        },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'high' } },
      ],
    }],
  })

  let crop = { cx: 0.5, cy: 0.5, size: 0.45 }
  try {
    const raw = result.choices[0].message.content?.trim() ?? ''
    console.log('[cropDetailRegion] GPT reasoning:', raw)
    const m   = raw.match(/\{[\s\S]*\}/)
    if (m) crop = JSON.parse(m[0])
  } catch { /* use default center crop */ }

  const halfW  = Math.round((crop.size * W) / 2)
  const halfH  = Math.round((crop.size * H) / 2)
  const cx     = Math.round(crop.cx * W)
  const cy     = Math.round(crop.cy * H)
  const left   = Math.max(0, Math.min(cx - halfW, W - halfW * 2))
  const top    = Math.max(0, Math.min(cy - halfH, H - halfH * 2))
  const width  = Math.min(halfW * 2, W - left)
  const height = Math.min(halfH * 2, H - top)

  console.log(`[cropDetailRegion] crop: left=${left} top=${top} width=${width} height=${height}`)

  return sharp(imageBuf)
    .extract({ left, top, width, height })
    .resize(1024, 1024, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 92 })
    .toBuffer()
}

// ── Real-ESRGAN upscale ───────────────────────────────────────────────────────

async function upscaleIfNeeded(buf: Buffer): Promise<Buffer> {
  const meta      = await sharp(buf).metadata()
  const shortSide = Math.min(meta.width ?? 9999, meta.height ?? 9999)
  if (shortSide >= 1080) return buf  // already high-res enough

  console.log(`[upscale] ${meta.width}×${meta.height} — triggering Real-ESRGAN 4×`)
  try {
    const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN })
    const blob      = new Blob([new Uint8Array(buf)], { type: 'image/jpeg' })

    const output = await replicate.run(
      'nightmareai/real-esrgan:42fed1c4974146d4d2414e2be2c5277c7fcf05fcc3a73abf41610695738c1d7b',
      { input: { image: blob, scale: 4, face_enhance: false } },
    )

    // SDK v1 returns a URL object or string
    let upscaledBuf: Buffer
    if (output instanceof URL) {
      upscaledBuf = Buffer.from(await (await fetch(output.href)).arrayBuffer())
    } else if (typeof output === 'string') {
      upscaledBuf = Buffer.from(await (await fetch(output)).arrayBuffer())
    } else {
      // ReadableStream fallback
      const chunks: Uint8Array[] = []
      for await (const chunk of output as AsyncIterable<Uint8Array>) chunks.push(chunk)
      upscaledBuf = Buffer.concat(chunks)
    }

    const upMeta = await sharp(upscaledBuf).metadata()
    console.log(`[upscale] done — ${upMeta.width}×${upMeta.height}`)
    return upscaledBuf
  } catch (err) {
    console.error('[upscale] failed, using original:', err)
    return buf  // graceful fallback
  }
}

// ── SSE helper ────────────────────────────────────────────────────────────────

function sseEvent(type: string, data: object): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
}

// ── Kling image2video call ────────────────────────────────────────────────────

async function klingGenerate(b64: string, prompt: string, duration = '5'): Promise<string> {
  // Kling v3 only accepts 5 or 10 — map UI values to nearest supported
  const klarDur = parseInt(duration) <= 5 ? '5' : '10'

  const res  = await fetch('https://api.klingai.com/v1/videos/image2video', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${klingJWT()}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      model_name:     'kling-v3',
      image:          b64,
      prompt,
      duration:       klarDur,
      aspect_ratio:   'auto',
      generate_audio: false,
    }),
  })
  const json = await res.json()
  if (!res.ok || json.code !== 0) {
    console.error('[klingGenerate] Kling error response:', JSON.stringify(json))
    throw new Error(json.message ?? `Kling error (code ${json.code})`)
  }
  const taskId = json.data?.task_id
  if (!taskId) throw new Error('No task ID returned from Kling')
  return taskId
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return new Response('Unauthorized', { status: 401 })

  const formData  = await request.formData()
  const imageFile = formData.get('image')     as File | null
  const refFile   = formData.get('reference') as File | null
  const showcase          = (formData.get('showcase') as string | null) ?? 'hero_push'
  const duration          = (formData.get('duration') as string | null) ?? '5'
  const dishName          = (formData.get('dishName') as string | null) ?? undefined
  const clipDurationsRaw  = (formData.get('clipDurations') as string | null)
  const clipDurationsMap: Record<string, string> = clipDurationsRaw
    ? (JSON.parse(clipDurationsRaw) as Record<string, string>)
    : {}
  const detailCropRaw = (formData.get('detailCrop') as string | null)
  const manualDetailCrop = detailCropRaw
    ? (JSON.parse(detailCropRaw) as { x: number; y: number; w: number; h: number })
    : undefined

  if (!imageFile) return new Response('Missing image', { status: 400 })

  const validTypes: ShowcaseType[] = ['hero_push', 'orbit', 'birdview', 'detail', 'three_act']
  const showcaseType = (validTypes.includes(showcase as ShowcaseType)
    ? showcase : 'hero_push') as ShowcaseType

  const openai  = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const admin   = createAdminClient()
  const encoder = new TextEncoder()
  const jobId   = crypto.randomUUID()

  const stream = new ReadableStream({
    async start(controller) {
      const send = (type: string, data: object) =>
        controller.enqueue(encoder.encode(sseEvent(type, data)))

      try {
        // ── Step 1: Upload ────────────────────────────────────────────
        send('progress', { step: 'uploading', message: 'Uploading images…' })

        const imageBuf = Buffer.from(await imageFile.arrayBuffer())
        const refBuf   = refFile ? Buffer.from(await refFile.arrayBuffer()) : null

        const upload = async (buf: Buffer, name: string, type = 'image/jpeg'): Promise<string> => {
          const ext  = type === 'image/png' ? 'png' : 'jpg'
          const path = `${user.id}/video/${jobId}/${name}.${ext}`
          const { error } = await admin.storage
            .from('images')
            .upload(path, buf, { contentType: type, upsert: true })
          if (error) throw new Error(`Storage upload failed: ${error.message}`)
          return admin.storage.from('images').getPublicUrl(path).data.publicUrl
        }

        const subjectUrl = await upload(imageBuf, 'subject')
        const refUrl     = refBuf ? await upload(refBuf, 'reference') : null

        await admin.from('video_jobs').insert({
          id:          jobId,
          user_id:     user.id,
          subject_url: subjectUrl,
          showcase:    showcaseType,
          duration:    showcaseType === 'three_act'
            ? (['hero_push','orbit','birdview','detail'] as const).reduce((s, k) => {
                const d = clipDurationsMap[k]
                return d === '0' || !d ? s : s + parseInt(d)
              }, 0)
            : parseInt(['3','5','8'].includes(duration) ? duration : '5'),
          status:      'processing',
        })

        // ── Step 2: Dish analysis ─────────────────────────────────
        send('progress', { step: 'analyzing-dish', message: 'Analysing dish type for realistic motion…' })

        const subjectB64 = imageBuf.toString('base64')
        const dish       = await analyzeDish(subjectB64, openai, dishName)
        console.log('[video/generate] dish analysis:', JSON.stringify(dish))

        // ── Steps 3 & 4: Style transfer (if reference provided) ───────
        let videoImageBuf = imageBuf

        if (refBuf && refUrl) {
          send('progress', { step: 'analyzing', message: 'Analysing reference aesthetic…' })

          const scoringResult = await openai.chat.completions.create({
            model:      'gpt-4o-mini',
            max_tokens: 100,
            messages:   [{
              role:    'user',
              content: [
                {
                  type: 'text',
                  text: `You are scoring PIXELS only. Ignore what the food is. Ignore cultural meaning.
Score these 4 visual properties from 0 to 10:
- saturation: how vivid and colourful the image is
- contrast: separation between light and dark areas
- density: how crowded and busy the composition is
- softness: how soft, hazy, or diffused the image feels
Output strict JSON only: {"saturation":0,"contrast":0,"density":0,"softness":0}`,
                },
                { type: 'image_url', image_url: { url: refUrl, detail: 'low' } },
              ],
            }],
          })

          let styleCategory: StyleCategory = 'warm_comfort'
          try {
            const raw = scoringResult.choices[0].message.content?.trim() ?? ''
            const m   = raw.match(/\{[\s\S]*\}/)
            if (m) styleCategory = classifyStyle(JSON.parse(m[0]))
          } catch { /* keep default */ }

          const atmosphereResult = await openai.chat.completions.create({
            model:      'gpt-4o-mini',
            max_tokens: 300,
            messages:   [{
              role:    'user',
              content: [
                { type: 'text', text: ATMOSPHERE_PROMPTS[styleCategory] },
                { type: 'image_url', image_url: { url: refUrl, detail: 'low' } },
              ],
            }],
          })

          const atmosphere = atmosphereResult.choices[0].message.content?.trim()
            ?? 'professional food photography with warm natural lighting'

          send('progress', { step: 'transforming', message: 'Applying style transfer…' })

          const origPng  = await sharp(imageBuf)
            .resize(1536, 1536, { fit: 'inside', withoutEnlargement: true })
            .png()
            .toBuffer()
          const origFile = await toFile(origPng, 'original.png', { type: 'image/png' })
          const guide    = STYLE_DIRECTION[styleCategory]

          const editResult = await openai.images.edit({
            model:          'gpt-image-1.5',
            image:          origFile,
            prompt: `Professional food photo retouching — lighting and atmosphere enhancement.

Style classification: ${styleCategory}
Lighting direction: ${guide.direction}
Target atmosphere (from reference image): ${atmosphere}

What to KEEP exactly as-is:
- Every food item, ingredient, garnish, plating, and plate shape — unchanged
- Every background object, prop, surface, and environment — unchanged
- Composition, camera angle, and framing — identical
- Do not add, remove, replace, or reposition any element

What to ADJUST (lighting only):
- Relight the entire scene to match the target atmosphere
- ${guide.prohibitions}
- Do NOT replace the background — only change how the existing background is lit`,
            input_fidelity: 'high',
            quality:        'high',
            size:           'auto',
            output_format:  'png',
          })

          const imgData = editResult.data?.[0]
          if (imgData?.b64_json) {
            videoImageBuf = Buffer.from(imgData.b64_json, 'base64')
          } else if (imgData?.url) {
            const r = await fetch(imgData.url)
            videoImageBuf = Buffer.from(await r.arrayBuffer())
          } else {
            throw new Error('Style transfer returned no image data')
          }

          const outputUrl = await upload(videoImageBuf, 'output', 'image/png')
          await admin.from('video_jobs').update({ output_url: outputUrl }).eq('id', jobId)
        }

        // Upscale low-res images with Real-ESRGAN before sending to Kling
        const upscaledBuf = await upscaleIfNeeded(videoImageBuf)

        // Prepare high-quality JPEG for Kling (2048px max, quality 95)
        const klingBuf = await sharp(upscaledBuf)
          .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 95, mozjpeg: false })
          .toBuffer()
        const b64 = klingBuf.toString('base64')

        // ── Step 5: Generate video ────────────────────────────────────
        send('progress', { step: 'generating', message: 'Co.Media AI is working on your video…' })

        if (showcaseType === 'three_act') {
          // Generate only active (non-zero) clips in parallel
          const allKeys: Array<Exclude<ShowcaseType, 'three_act'>> = ['hero_push', 'orbit', 'birdview', 'detail']
          const activeKeys = allKeys.filter(key => clipDurationsMap[key] !== '0' && clipDurationsMap[key])
          if (activeKeys.length === 0) throw new Error('At least one clip must have a non-zero duration')
          const detailBuf = activeKeys.includes('detail')
            ? await cropDetailRegion(videoImageBuf, openai, dishName, manualDetailCrop)
            : null
          const clipTaskIds = await Promise.all(
            activeKeys.map(key => klingGenerate(
              key === 'detail' && detailBuf ? detailBuf.toString('base64') : b64,
              buildShowcasePrompt(key, dish.motion, dish.exclude),
              '5',
            ))
          )
          send('done', { clipTaskIds, videoJobId: jobId })
        } else if (showcaseType === 'detail') {
          const detailBuf = await cropDetailRegion(videoImageBuf, openai, dishName, manualDetailCrop)
          const prompt    = buildShowcasePrompt('detail', dish.motion, dish.exclude)
          const taskId    = await klingGenerate(detailBuf.toString('base64'), prompt, '5')
          await admin.from('video_jobs').update({ task_id: taskId }).eq('id', jobId)
          send('done', { taskId, videoJobId: jobId })
        } else {
          const prompt = buildShowcasePrompt(showcaseType, dish.motion, dish.exclude)
          const taskId = await klingGenerate(b64, prompt, '5')
          await admin.from('video_jobs').update({ task_id: taskId }).eq('id', jobId)
          send('done', { taskId, videoJobId: jobId })
        }

      } catch (err) {
        console.error('[video/generate] error:', err)
        const message = err instanceof Error ? err.message : 'An unexpected error occurred'
        try { await admin.from('video_jobs').update({ status: 'failed' }).eq('id', jobId) } catch {}
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
