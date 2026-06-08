/**
 * POST /api/transform-combo  (multipart/form-data)
 * Fields: image1 (File|url), image2 (File|url), jobId, intensity, food_analysis?, face_analysis?
 *
 * Pipeline:
 *   1. Upload both images to Supabase Storage
 *   2. GPT-4o-mini → identify elements (people vs food, composition)
 *   3. Parallel:
 *        a. GPT-4o-mini → score reference pixels → classify style
 *        b. GPT-4o-mini → food analysis (if has_food)
 *        c. GPT-4o-mini → face/skin analysis (if has_people)
 *   4. GPT-4o-mini → category-specific atmosphere analysis of reference
 *   5. gpt-image-1 → style transfer with combined food + face optimization
 */

import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextRequest }       from 'next/server'
import OpenAI, { toFile }   from 'openai'
import sharp                 from 'sharp'

export const maxDuration = 300

// ── Style category (shared pattern) ──────────────────────────────────────────

type StyleCategory =
  | 'moody_fine_dining'
  | 'clean_fresh'
  | 'warm_comfort'
  | 'commercial_vivid'
  | 'soft_lifestyle'

function classifyStyle(s: { saturation: number; contrast: number; density: number; softness: number }): StyleCategory {
  if (s.density >= 7 && s.saturation >= 6 && s.softness <= 6)                                       return 'commercial_vivid'
  if (s.saturation >= 6 && s.contrast >= 4 && s.contrast <= 6 && s.density >= 4 && s.density <= 6) return 'commercial_vivid'
  if (s.contrast >= 7 && s.saturation <= 6 && s.density <= 6)                                       return 'moody_fine_dining'
  if (s.softness >= 7 && s.contrast <= 5 && s.density <= 6)                                         return 'soft_lifestyle'
  if (s.saturation <= 4 && s.contrast <= 5 && s.density <= 5)                                       return 'clean_fresh'
  if (Math.abs(s.saturation - 5) <= 1.5 && Math.abs(s.contrast - 5) <= 1.5 && s.softness <= 6)     return 'warm_comfort'
  return 'clean_fresh'
}

const STYLE_DIRECTION: Record<StyleCategory, { direction: string; prohibitions: string }> = {
  moody_fine_dining: {
    direction:    'Apply single directional key light, deep fill shadows, strong vignette, high contrast ratio. Background crushed to near-black. Warm tungsten or cool dramatic colour cast.',
    prohibitions: 'Do NOT brighten the background. Do NOT add ambient fill light. Do NOT flatten contrast. Do NOT soften shadows.',
  },
  clean_fresh: {
    direction:    'Apply soft diffused daylight, high ambient light, minimal shadows, neutral to cool colour temperature. Bright even exposure. No vignette.',
    prohibitions: 'Do NOT darken the background. Do NOT add dramatic directional shadows. Do NOT apply warm tones. Do NOT add vignette.',
  },
  warm_comfort: {
    direction:    'Apply warm golden ambient light, soft directional fill, inviting brightness. Colour temperature 3000–3500K. Gentle soft-edged shadows. Background visible and warm.',
    prohibitions: 'Do NOT crush background to black. Do NOT apply dramatic single-source lighting. Do NOT cool colour temperature. Do NOT add heavy vignette.',
  },
  commercial_vivid: {
    direction:    'Apply high-saturation punchy lighting, strong specular highlights, clean bright background. Maximum colour separation. Crisp sharp texture rendering.',
    prohibitions: 'Do NOT mute or desaturate colours. Do NOT add moody dark atmosphere. Do NOT soften highlights or reduce contrast.',
  },
  soft_lifestyle: {
    direction:    'Apply soft window light or golden-hour diffusion, gentle wrap-around lighting. Muted warm or pastel tones, airy relaxed atmosphere. Minimal harsh shadows.',
    prohibitions: 'Do NOT add hard directional light. Do NOT over-saturate. Do NOT apply heavy contrast or dark vignette.',
  },
}

const ATMOSPHERE_PROMPTS: Record<StyleCategory, string> = {
  moody_fine_dining: `You are a professional lighting director. Analyse the lighting in this image:
- KEY LIGHT: position, angle, hard or soft quality
- SHADOW DEPTH: how deep and dark
- CONTRAST STRUCTURE: light-dark distribution
- COLOUR TEMPERATURE: warm or cool cast
- VIGNETTE: presence and strength
Output 3–5 sentences. No bullet points.`,

  clean_fresh: `You are a professional lighting director. Analyse the lighting in this image:
- EXPOSURE LEVEL: overall brightness
- BACKGROUND BRIGHTNESS: how clean the background reads
- LIGHT DIFFUSION: how soft and even the light spreads
- COLOR SEPARATION: how distinct and clean individual colours appear
Output 3–5 sentences. No bullet points.`,

  warm_comfort: `You are a professional lighting director. Analyse the lighting in this image:
- COLOUR TEMPERATURE: precise warmth, Kelvin estimate
- AMBIENT WARMTH: how light shifts surface colours
- LIGHT SOFTNESS: how diffused and gentle the light feels
- MIDTONE CONTRAST: contrast in mid-brightness range
Output 3–5 sentences. No bullet points.`,

  commercial_vivid: `You are a professional lighting director. Analyse the lighting in this image:
- COLOR INTENSITY: how vivid and saturated colours appear
- CONTRAST POP: how punchy the light-dark separation is
- SURFACE CLARITY: how sharp and defined edges are
- SHADOW CONTROL: whether shadows are kept shallow
Output 3–5 sentences. No bullet points.`,

  soft_lifestyle: `You are a professional lighting director. Analyse the lighting in this image:
- SOFTNESS: how diffused and gentle the overall light feels
- AIRINESS: how light and open the image feels
- CONTRAST REDUCTION: how flat and low-contrast the image is
- COLOR LIGHTNESS: how pale or muted the colours are
Output 3–5 sentences. No bullet points.`,
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type Identification = {
  has_people:       boolean
  people_count:     number
  has_food:         boolean
  food_description: string
  composition:      string
  face_visibility:  string   // 'clear' | 'partial' | 'obscured' | 'none'
}

export type FoodAnalysis = {
  dish_name:             string
  primary_type:          string
  secondary_types:       string[]
  visual_features:       string[]
  optimization_keywords: string[]
  quality_score:         number
  editing_plan: {
    light:     string[]
    texture:   string[]
    color:     string[]
    structure: string[]
  }
  parameter_directions:  Record<string, string>
}

export type FaceAnalysis = {
  people_count:         number
  primary_issue:        string
  quality_score:        number
  editing_plan:         string[]
  parameter_directions: Record<string, string>
}

export type ComboAnalysis = {
  identification: Identification
  food:           FoodAnalysis | null
  face:           FaceAnalysis | null
}

// ── Prompts ───────────────────────────────────────────────────────────────────

const IDENTIFICATION_PROMPT = `You are analyzing a photo. Identify all key elements.

Output STRICT JSON only:

{
  "has_people": false,
  "people_count": 0,
  "has_food": false,
  "food_description": "",
  "composition": "",
  "face_visibility": "none"
}

face_visibility options: "clear" / "partial" / "obscured" / "none"

Rules:
- ALL values in English
- Output ONLY JSON`

const FOOD_ANALYSIS_PROMPT = `You are a professional food image optimization AI.
Analyze this food image based on VISUAL PROPERTIES only.

Output STRICT JSON:

{
  "dish_name": "",
  "primary_type": "",
  "secondary_types": [],
  "visual_features": [],
  "optimization_keywords": [],
  "quality_score": 0,
  "editing_plan": {
    "light": [],
    "texture": [],
    "color": [],
    "structure": []
  },
  "parameter_directions": {
    "highlights": "",
    "shadows": "",
    "contrast": "",
    "whites": "",
    "blacks": "",
    "clarity": "",
    "sharpness": "",
    "vibrance": "",
    "saturation": "",
    "temperature": ""
  }
}

Primary types: High Reflective / Rough Texture / Multi-color Mix / Single Color / Semi-transparent / High Fat / Dry Matte / Creamy Soft / Liquid Soup / Layered Structure

Quality score 0–10:
- 8–10: Professionally shot, minimal intervention needed
- 4–7:  Decent, targeted improvement needed
- 0–3:  Needs comprehensive enhancement

Directions: increase / decrease / slightly increase / slightly decrease / keep moderate / reduce aggressively

Rules:
- ALL output in English
- Output ONLY JSON`

const FACE_ANALYSIS_PROMPT = `You are a professional portrait retouching AI specializing in dining and food photography contexts.

Analyze the people/faces visible in this photo. Focus ONLY on skin and face quality for style transfer purposes.

Assess these parameters:
- skin_clarity: is skin sharp/defined, blurry, over-exposed, or lost in light?
- skin_vitality: does skin look healthy and rosy, or pale/sallow/dull/lifeless?
- skin_brightness: is skin too dark, too bright, or well-exposed?
- skin_smoothness: is skin texture quality good or rough/uneven?
- facial_contrast: are features well-defined with depth, or flat and lost?
- eye_clarity: are eyes sharp and bright, or soft/dull/lost?
- overall_tone: is skin tone warm, cool, or neutral overall?

Quality score (0–10):
- 8–10: Skin looks naturally healthy, well-lit, no intervention needed
- 4–7:  Specific issues that could be improved
- 0–3:  Pale, flat, blurry, or poorly lit — needs comprehensive enhancement

Directions: increase / decrease / slightly increase / slightly decrease / keep moderate

Output STRICT JSON only:

{
  "people_count": 0,
  "primary_issue": "",
  "quality_score": 0,
  "editing_plan": [],
  "parameter_directions": {
    "skin_clarity": "",
    "skin_vitality": "",
    "skin_brightness": "",
    "skin_smoothness": "",
    "facial_contrast": "",
    "eye_clarity": "",
    "overall_tone": ""
  }
}

Rules:
- ALL output in English
- Output ONLY JSON`

// ── Build optimization prompts ─────────────────────────────────────────────────

function buildFoodOptPrompt(food: FoodAnalysis): string {
  const score = food.quality_score ?? 5
  const tier  = score >= 7 ? 'high' : score >= 4 ? 'mid' : 'low'

  const tonePrefix =
    tier === 'high'
      ? `Food quality is already high (score ${score}/10). Apply enhancements conservatively.`
      : tier === 'mid'
      ? `Food quality is decent (score ${score}/10). Apply targeted enhancements.`
      : `Food quality needs significant improvement (score ${score}/10). Apply comprehensive enhancements.`

  const editingLines = [
    ...food.editing_plan.light,
    ...food.editing_plan.texture,
    ...food.editing_plan.color,
    ...food.editing_plan.structure,
  ].map(l => `- ${l}`).join('\n')

  const paramEntries   = Object.entries(food.parameter_directions)
  const relevantParams = tier === 'high'
    ? paramEntries.filter(([, v]) => v !== 'keep moderate')
    : paramEntries

  if (tier === 'high' && relevantParams.length === 0) {
    return `FOOD: score ${score}/10 — no food-specific adjustments needed. Preserve food appearance exactly.`
  }

  const paramLines = relevantParams.map(([k, v]) => `- ${k}: ${v}`).join('\n')

  return `FOOD SECTION (${food.primary_type}):
${tonePrefix}

Key visual features: ${food.visual_features.join(', ')}

Editing objectives:
${editingLines}

Parameter adjustment directions:
${paramLines}`
}

function buildFaceOptPrompt(face: FaceAnalysis): string {
  const score = face.quality_score ?? 5
  const tier  = score >= 7 ? 'high' : score >= 4 ? 'mid' : 'low'

  if (tier === 'high') {
    const relevant = Object.entries(face.parameter_directions).filter(([, v]) => v !== 'keep moderate')
    if (relevant.length === 0) {
      return `SKIN/PEOPLE SECTION: score ${score}/10 — skin quality already high. Apply only lighting consistency from reference.`
    }
    return `SKIN/PEOPLE SECTION (score ${score}/10 — conservative):
Primary issue: ${face.primary_issue}
${relevant.map(([k, v]) => `- ${k}: ${v}`).join('\n')}`
  }

  const planLines  = face.editing_plan.map(l => `- ${l}`).join('\n')
  const paramLines = Object.entries(face.parameter_directions)
    .filter(([, v]) => v !== 'keep moderate')
    .map(([k, v]) => `- ${k}: ${v}`).join('\n')

  return `SKIN/PEOPLE SECTION (${face.people_count} ${face.people_count === 1 ? 'person' : 'people'}, score ${score}/10):
Primary issue: ${face.primary_issue}

Skin editing objectives:
${planLines}

Skin parameter directions:
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

  const formData        = await request.formData()
  const image1File      = formData.get('image1')         as File | null
  const image2File      = formData.get('image2')         as File | null
  const image1UrlIn     = formData.get('image1_url')     as string | null
  const image2UrlIn     = formData.get('image2_url')     as string | null
  const jobId           = formData.get('jobId')          as string | null
  const intensity       = Math.min(100, Math.max(10, Number(formData.get('intensity') ?? 80)))
  const foodAnalysisRaw = formData.get('food_analysis')  as string | null
  const faceAnalysisRaw = formData.get('face_analysis')  as string | null

  let providedFoodAnalysis: FoodAnalysis | null = null
  let providedFaceAnalysis: FaceAnalysis | null = null
  if (foodAnalysisRaw) try { providedFoodAnalysis = JSON.parse(foodAnalysisRaw) } catch { /* ignore */ }
  if (faceAnalysisRaw) try { providedFaceAnalysis = JSON.parse(faceAnalysisRaw) } catch { /* ignore */ }

  if ((!image1File && !image1UrlIn) || (!image2File && !image2UrlIn) || !jobId)
    return new Response('Missing required fields', { status: 400 })

  const openai  = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const admin   = createAdminClient()
  const encoder = new TextEncoder()

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
          const { error } = await admin.storage.from('images').upload(path, buf, { contentType: type, upsert: true })
          if (error) throw new Error(`Storage upload failed: ${error.message}`)
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

        // ── Step 2: Identify elements ─────────────────────────────────
        send('progress', { step: 'identifying', message: 'Identifying people and food…' })

        let identification: Identification = {
          has_people: true, people_count: 1,
          has_food: true,   food_description: 'food items visible',
          composition: 'mixed scene', face_visibility: 'clear',
        }

        // Only re-identify if we don't already have both analyses (re-apply scenario)
        const needsIdentify = !providedFoodAnalysis || !providedFaceAnalysis
        if (needsIdentify) {
          try {
            const identResult = await openai.chat.completions.create({
              model: 'gpt-4o-mini', max_tokens: 200,
              messages: [{
                role: 'user',
                content: [
                  { type: 'text', text: IDENTIFICATION_PROMPT },
                  { type: 'image_url', image_url: { url: image1Url, detail: 'low' } },
                ],
              }],
            })
            const raw   = identResult.choices[0].message.content?.trim() ?? ''
            const match = raw.match(/\{[\s\S]*\}/)
            if (match) identification = JSON.parse(match[0])
          } catch { /* use defaults */ }
        }

        // ── Step 3: Parallel analysis ─────────────────────────────────
        send('progress', { step: 'analyzing', message: 'Analysing food and people…' })

        const scoringCall = openai.chat.completions.create({
          model: 'gpt-4o-mini', max_tokens: 100,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: `Score PIXELS only. Output strict JSON: {"saturation":0,"contrast":0,"density":0,"softness":0}` },
              { type: 'image_url', image_url: { url: image2Url, detail: 'low' } },
            ],
          }],
        })

        const foodCall = (!providedFoodAnalysis && identification.has_food)
          ? openai.chat.completions.create({
              model: 'gpt-4o-mini', max_tokens: 1000,
              messages: [{
                role: 'user',
                content: [
                  { type: 'text', text: FOOD_ANALYSIS_PROMPT + (identification.food_description ? `\n\nContext: ${identification.food_description}` : '') },
                  { type: 'image_url', image_url: { url: image1Url, detail: 'high' } },
                ],
              }],
            })
          : Promise.resolve(null)

        const faceCall = (!providedFaceAnalysis && identification.has_people && identification.face_visibility !== 'none')
          ? openai.chat.completions.create({
              model: 'gpt-4o-mini', max_tokens: 600,
              messages: [{
                role: 'user',
                content: [
                  { type: 'text', text: FACE_ANALYSIS_PROMPT },
                  { type: 'image_url', image_url: { url: image1Url, detail: 'high' } },
                ],
              }],
            })
          : Promise.resolve(null)

        const [scoringResult, foodResult, faceResult] = await Promise.all([scoringCall, foodCall, faceCall])

        // Parse scoring
        let styleCategory: StyleCategory = 'warm_comfort'
        try {
          const raw = scoringResult.choices[0].message.content?.trim() ?? ''
          const match = raw.match(/\{[\s\S]*\}/)
          if (match) styleCategory = classifyStyle(JSON.parse(match[0]))
        } catch { /* use default */ }

        // Parse food analysis
        let foodAnalysis: FoodAnalysis | null = providedFoodAnalysis
        if (!foodAnalysis && foodResult) {
          const raw = foodResult.choices[0].message.content?.trim() ?? ''
          try {
            const match = raw.match(/\{[\s\S]*\}/)
            if (match) foodAnalysis = JSON.parse(match[0])
          } catch { /* continue */ }
        }

        // Parse face analysis
        let faceAnalysis: FaceAnalysis | null = providedFaceAnalysis
        if (!faceAnalysis && faceResult) {
          const raw = faceResult.choices[0].message.content?.trim() ?? ''
          try {
            const match = raw.match(/\{[\s\S]*\}/)
            if (match) faceAnalysis = JSON.parse(match[0])
          } catch { /* continue */ }
        }

        // ── Step 4: Atmosphere analysis ───────────────────────────────
        send('progress', { step: 'analyzing-reference', message: 'Reading reference style…' })

        const atmosphereResult = await openai.chat.completions.create({
          model: 'gpt-4o-mini', max_tokens: 300,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: ATMOSPHERE_PROMPTS[styleCategory] },
              { type: 'image_url', image_url: { url: image2Url, detail: 'low' } },
            ],
          }],
        })

        const atmosphere = atmosphereResult.choices[0].message.content?.trim()
          ?? 'professional food photography with warm, inviting atmosphere'

        const foodOptPrompt = foodAnalysis ? buildFoodOptPrompt(foodAnalysis) : ''
        const faceOptPrompt = faceAnalysis ? buildFaceOptPrompt(faceAnalysis) : ''
        const styleGuide    = STYLE_DIRECTION[styleCategory]

        const intensityDesc =
          intensity >= 90 ? 'Apply at full strength — completely transform the lighting to match the reference atmosphere.' :
          intensity >= 70 ? 'Apply at strong strength — reference atmosphere clearly dominant.' :
          intensity >= 50 ? 'Apply at moderate strength — blend halfway between original and reference.' :
          intensity >= 30 ? 'Apply subtly — gentle shift toward reference, mostly preserve original.' :
                            'Apply very subtly — barely perceptible shift, faint hint of reference.'

        // ── Step 5: Style transfer ────────────────────────────────────
        send('progress', { step: 'generating', message: 'Applying style transfer…' })

        const origPng  = await sharp(image1Buf).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).png().toBuffer()
        const origFile = await toFile(origPng, 'original.png', { type: 'image/png' })

        const hasFaceSection = faceAnalysis && identification.has_people && identification.face_visibility !== 'none'

        const prompt = `Professional photo retouching — style transfer for a scene containing ${identification.has_food ? 'food' : ''}${identification.has_food && identification.has_people ? ' and ' : ''}${identification.has_people ? 'people' : ''}.

Style classification: ${styleCategory}
Lighting direction: ${styleGuide.direction}

Target atmosphere (from reference image): ${atmosphere}

Application intensity (${intensity}%): ${intensityDesc}

CRITICAL RULES FOR PEOPLE (if any people are present):
- Do NOT alter facial structure, proportions, bone shape, or identity of any person — ever
- Do NOT add or remove people
- Apply ONLY: skin tone warmth shift, overall brightness/clarity on face, consistent with the reference atmosphere
- Facial enhancement must look completely natural — no plastic, no smoothing artifacts
- Preserve natural skin texture

What to KEEP exactly:
- All food items, plating, and garnishes — unchanged in content and placement
- All people's facial identity and structure — unchanged
- All background elements, props, and decor — unchanged
- Composition and framing — identical

What to ADJUST (toward reference style):
- Overall lighting and color grade to match target atmosphere
- ${styleGuide.prohibitions}

${foodOptPrompt}

${hasFaceSection ? faceOptPrompt : ''}

The result must look like the same photo taken with better lighting and professional retouching — same scene, same people, same food, transformed atmosphere and enhanced quality.`

        const editResult = await openai.images.edit({
          model:          'gpt-image-1.5',
          image:          origFile,
          prompt,
          input_fidelity: 'high',
          quality:        'high',
          size:           'auto',
          output_format:  'png',
        })

        const imgData = editResult.data?.[0]
        let outputBuffer: Buffer
        if (imgData?.b64_json)  outputBuffer = Buffer.from(imgData.b64_json, 'base64')
        else if (imgData?.url)  outputBuffer = await fetchBuffer(imgData.url)
        else throw new Error('gpt-image-1 returned no image data')

        // ── Step 6: Upload result ─────────────────────────────────────
        const outputUrl = await upload(outputBuffer, 'output', 'image/png')
        await admin.from('jobs').update({ output_url: outputUrl, status: 'done' }).eq('id', jobId)

        const comboAnalysis: ComboAnalysis = { identification, food: foodAnalysis, face: faceAnalysis }
        send('done', { outputUrl, comboAnalysis, styleCategory })

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
