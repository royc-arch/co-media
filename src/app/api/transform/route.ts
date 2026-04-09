/**
 * POST /api/transform  (multipart/form-data)
 * Fields: image1 (File), image2 (File), jobId (string)
 *
 * Goal: apply the lighting, atmosphere, and vibe of Image 2 (reference)
 *       to Image 1 (original food photo).
 *
 * Pipeline:
 *   1. Upload both images to Supabase Storage
 *   2. GPT-4o-mini analyses Image 2 → one-sentence atmosphere description
 *   3. gpt-image-1 edits Image 1 using that description
 *        - input_fidelity: 'high'  → food content fully preserved
 *        - no background removal, no masking, no hallucination
 *   4. Upload result + update job
 *
 * No separate subject/background extraction needed — gpt-image-1 understands
 * the scene semantically and applies only the requested atmosphere changes.
 */

import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextRequest }       from 'next/server'
import OpenAI, { toFile }   from 'openai'
import sharp                 from 'sharp'

export const maxDuration = 300

// ── Style category definitions ────────────────────────────────────────────────

type StyleCategory =
  | 'moody_fine_dining'
  | 'clean_fresh'
  | 'warm_comfort'
  | 'commercial_vivid'
  | 'soft_lifestyle'

function classifyStyle(s: { saturation: number; contrast: number; density: number; softness: number }): StyleCategory {
  if (s.density >= 7 && s.saturation >= 6 && s.softness <= 6)           return 'commercial_vivid'
  if (s.saturation >= 6 && s.contrast >= 4 && s.contrast <= 6 && s.density >= 4 && s.density <= 6) return 'commercial_vivid'
  if (s.contrast >= 7 && s.saturation <= 6 && s.density <= 6)           return 'moody_fine_dining'
  if (s.softness >= 7 && s.contrast <= 5 && s.density <= 6)             return 'soft_lifestyle'
  if (s.saturation <= 4 && s.contrast <= 5 && s.density <= 5)           return 'clean_fresh'
  if (Math.abs(s.saturation - 5) <= 1.5 && Math.abs(s.contrast - 5) <= 1.5 && s.softness <= 6) return 'warm_comfort'
  return 'clean_fresh'
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
    direction:    'Apply warm golden ambient light, soft directional fill, inviting brightness. Colour temperature 3000–3500K amber-white. Gentle soft-edged shadows. Background remains visible and warm — do not crush it.',
    prohibitions: 'Do NOT crush the background to black. Do NOT apply dramatic single-source lighting. Do NOT cool the colour temperature. Do NOT add heavy vignette.',
  },
  commercial_vivid: {
    direction:    'Apply high-saturation punchy lighting, strong specular highlights on food surface, clean bright background. Maximum colour separation. Crisp sharp texture rendering. Multiple controlled light sources allowed.',
    prohibitions: 'Do NOT mute or desaturate colours. Do NOT add moody dark atmosphere. Do NOT soften highlights or reduce contrast.',
  },
  soft_lifestyle: {
    direction:    'Apply soft window light or golden-hour diffusion, gentle wrap-around lighting. Muted warm or pastel tones, airy relaxed atmosphere. Minimal harsh shadows. Slight softness in highlights.',
    prohibitions: 'Do NOT add hard directional light. Do NOT over-saturate or punch colours. Do NOT apply heavy contrast or dark vignette.',
  },
}

// ── Category-specific atmosphere prompts ──────────────────────────────────────

const ATMOSPHERE_PROMPTS: Record<StyleCategory, string> = {
  moody_fine_dining: `You are a professional lighting director. Analyse the lighting in this image. Focus on:
- KEY LIGHT: exact clock position, vertical angle, hard or soft quality
- SHADOW DEPTH: how deep and dark the shadows are
- CONTRAST STRUCTURE: how light and dark areas are distributed
- SUBJECT ISOLATION: how the subject separates from the background
- COLOUR TEMPERATURE: warm or cool cast
- VIGNETTE: presence and strength

Output 3–5 sentences. No bullet points. No background description.`,

  clean_fresh: `You are a professional lighting director. Analyse the lighting in this image. Focus on:
- EXPOSURE LEVEL: how bright the overall image is
- BACKGROUND BRIGHTNESS: how light and clean the background reads
- LIGHT DIFFUSION: how soft and even the light spreads
- COLOR SEPARATION: how distinct and clean individual colours appear
- SHADOW SOFTNESS: how gentle any shadows are

Output 3–5 sentences. No bullet points. No vignette description.`,

  warm_comfort: `You are a professional lighting director. Analyse the lighting in this image. Focus on:
- COLOUR TEMPERATURE: precise warmth, Kelvin estimate
- FOOD COLOR BIAS: how the light shifts food colours (orange, amber, golden)
- LIGHT SOFTNESS: how diffused and gentle the light feels
- MIDTONE CONTRAST: contrast in the mid-brightness range

Output 3–5 sentences. No bullet points. No vignette description.`,

  commercial_vivid: `You are a professional lighting director. Analyse the lighting in this image. Focus on:
- COLOR INTENSITY: how vivid and saturated colours appear
- CONTRAST POP: how punchy the light-dark separation is
- STRUCTURE CLARITY: how sharp and defined the food edges are
- HIGHLIGHT APPEAL: how glossy and appetising the highlights on food look
- SHADOW CONTROL: whether shadows are kept shallow

Output 3–5 sentences. No bullet points. Ignore light source direction and emotional mood.`,

  soft_lifestyle: `You are a professional lighting director. Analyse the lighting in this image. Focus on:
- SOFTNESS: how diffused and gentle the overall light feels
- LIGHT DIFFUSION: how broadly the light wraps around subjects
- CONTRAST REDUCTION: how flat and low-contrast the image is
- AIRINESS: how light and open the image feels
- COLOR LIGHTNESS: how pale or muted the colours are

Output 3–5 sentences. No bullet points. Ignore sharp highlights and structure detail.`,
}

// ── Food analysis types ────────────────────────────────────────────────────────

export type FoodAnalysis = {
  dish_name:             string
  primary_type:          string
  secondary_types:       string[]
  visual_features:       string[]
  optimization_keywords: string[]
  quality_score:         number   // 0–10: overall visual quality of the original image
  editing_plan: {
    light:     string[]
    texture:   string[]
    color:     string[]
    structure: string[]
  }
  parameter_directions: Record<string, string>
}

// ── Food analysis prompt ───────────────────────────────────────────────────────

const FOOD_ANALYSIS_PROMPT = `You are a professional food image optimization AI.

Your task is to analyze a food image based on its VISUAL PROPERTIES (not cuisine type), then classify it and generate optimization guidance for image editing.

---

## Step 1: Analyze Visual Attributes

Carefully analyze the image and identify:

- Surface reflectiveness (none / low / high)
- Texture type (smooth / rough / soft / liquid / layered)
- Color complexity (single-color / multi-color / high contrast)
- Moisture or oil level (dry / moist / oily)
- Transparency (opaque / semi-transparent / translucent)
- Temperature perception (cold / warm / hot)
- Structural focus (flat / detailed / layered / stacked)

---

## Step 2: Classify Food Type (Visual-Based)

Classify the dish into ONE primary type and up to TWO secondary types:

Available types:

- High Reflective (glossy / oily surface)
- Rough Texture (rough / crispy / textured surface)
- Multi-color Mix (multi-color / visually complex)
- Single Color (low color variation / flat tone)
- Semi-transparent (translucent / light-passing)
- High Fat (fatty / oily meat)
- Dry Matte (dry / matte surface)
- Creamy Soft (creamy / soft / smooth desserts)
- Liquid Soup (liquid dominant)
- Layered Structure (layered / stacked structure)

---

## Step 3: Assess Overall Quality

Score the overall visual quality of the food image from 0 to 10:

- 8–10: Already looks professionally shot and post-processed. Colours are rich, textures are sharp, lighting is well-controlled. Minimal or no intervention needed.
- 4–7:  Decent but has specific areas that would benefit from targeted improvement.
- 0–3:  Clearly needs comprehensive enhancement — flat colours, poor texture rendering, problematic lighting.

This score directly controls how aggressively the editing plan is applied.

## Step 4: Prioritization Logic

When assigning primary type and building the editing plan, follow this priority:

1. Fix visual problems first:
   - harsh highlights
   - oily reflections
   - muddy colors
   - flat tones

2. Then enhance strengths only where there is clear room for improvement:
   - texture
   - structure
   - freshness
   - translucency

3. If a parameter already looks professionally executed — output "keep moderate". Do NOT optimize for the sake of optimizing.

---

## Step 5: Generate Optimization Guidance

Output optimization guidance in 4 categories:

### 1. Light Handling
(e.g. reduce highlights, deepen shadows, control reflections)

### 2. Texture Enhancement
(e.g. increase clarity, enhance texture, soften edges)

### 3. Color Adjustment
(e.g. increase vibrance, reduce saturation, warm tone, separate colors)

### 4. Structure & Focus
(e.g. emphasize subject, enhance layering, reduce distractions)

---

## Step 6: Parameter Direction (NO NUMBERS)

Provide directional editing suggestions ONLY:
- increase
- decrease
- slightly increase
- slightly decrease
- keep moderate
- reduce aggressively

DO NOT provide numeric values.

---

## Output Format (STRICT JSON)

Return ONLY this JSON structure:

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

---

## Rules

- Do NOT describe the dish in a generic way (avoid obvious descriptions)
- Focus ONLY on visual optimization
- Be concise but precise
- Always prioritize fixing visual flaws first
- ALL output values must be in English — no Chinese characters anywhere in the JSON
- Do NOT output anything outside JSON`

// ── Build food optimization prompt from analysis ───────────────────────────────

function buildFoodOptPrompt(food: FoodAnalysis): string {
  const score = food.quality_score ?? 5

  const tier =
    score >= 7 ? 'high' :
    score >= 4 ? 'mid'  : 'low'

  const tonePrefix =
    tier === 'high'
      ? `Original food quality is already high (score ${score}/10). Apply enhancements very conservatively — only address the specific issues listed below. Do not touch parameters that are already well-executed.`
      : tier === 'mid'
      ? `Food quality is decent (score ${score}/10). Apply targeted enhancements to the identified issues only. Leave well-executed aspects untouched.`
      : `Food quality needs significant improvement (score ${score}/10). Apply comprehensive enhancements across all identified issues.`

  // For high quality, skip editing lines where no real problem exists
  const editingLines = [
    ...food.editing_plan.light,
    ...food.editing_plan.texture,
    ...food.editing_plan.color,
    ...food.editing_plan.structure,
  ].map(l => `- ${l}`).join('\n')

  // For high quality, only include params that aren't already "keep moderate"
  const paramEntries = Object.entries(food.parameter_directions)
  const relevantParams = tier === 'high'
    ? paramEntries.filter(([, v]) => v !== 'keep moderate')
    : paramEntries

  if (tier === 'high' && relevantParams.length === 0) {
    return `Food quality assessment: score ${score}/10 — no food-specific adjustments needed. Preserve the original food appearance exactly.`
  }

  const paramLines = relevantParams.map(([k, v]) => `- ${k}: ${v}`).join('\n')

  return `Food visual optimization (${food.primary_type}):
${tonePrefix}

Key visual features: ${food.visual_features.join(', ')}

Editing objectives:
${editingLines}

Parameter adjustment directions:
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
  const image1File      = formData.get('image1')        as File | null
  const image2File      = formData.get('image2')        as File | null
  const image1UrlIn     = formData.get('image1_url')    as string | null
  const image2UrlIn     = formData.get('image2_url')    as string | null
  const jobId           = formData.get('jobId')         as string | null
  const intensity       = Math.min(100, Math.max(10, Number(formData.get('intensity') ?? 80)))
  const foodAnalysisRaw = formData.get('food_analysis') as string | null

  // If user has manually adjusted parameters, their version is passed back directly
  let providedFoodAnalysis: FoodAnalysis | null = null
  if (foodAnalysisRaw) {
    try { providedFoodAnalysis = JSON.parse(foodAnalysisRaw) } catch { /* ignore malformed */ }
  }

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
        console.log('[transform] started, jobId:', jobId)

        // ── Step 1: Upload both images ────────────────────────────────
        send('progress', { step: 'uploading', message: 'Uploading images…' })

        const image1Buf = image1File
          ? Buffer.from(await image1File.arrayBuffer())
          : await fetchBuffer(image1UrlIn!)
        const image2Buf = image2File
          ? Buffer.from(await image2File.arrayBuffer())
          : await fetchBuffer(image2UrlIn!)

        const upload = async (buf: Buffer, name: string, type = 'image/jpeg'): Promise<string> => {
          const ext  = type === 'image/png' ? 'png' : 'jpg'
          const path = `${user.id}/${jobId}/${name}.${ext}`
          const { error } = await admin.storage
            .from('images')
            .upload(path, buf, { contentType: type, upsert: true })
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

        // ── Step 2a: Score image2 + food analysis (parallel) ────────────
        send('progress', { step: 'analyzing', message: 'Analysing images…' })
        console.log('[transform] scoring reference + analysing food')

        const scoringCall = openai.chat.completions.create({
          model:      'gpt-4o-mini',
          max_tokens: 100,
          messages:   [{
            role:    'user',
            content: [
              {
                type: 'text',
                text: `You are scoring PIXELS only. Ignore what the food is. Ignore cultural meaning. Ignore emotional associations.

Score these 4 visual properties from 0 to 10:
- saturation: how vivid and colourful the image is
- contrast: separation between light and dark areas
- density: how crowded and busy the composition is
- softness: how soft, hazy, or diffused the image feels

Output strict JSON only: {"saturation":0,"contrast":0,"density":0,"softness":0}`,
              },
              { type: 'image_url', image_url: { url: image2Url, detail: 'low' } },
            ],
          }],
        })

        const foodAnalysisCall = !providedFoodAnalysis
          ? openai.chat.completions.create({
              model:      'gpt-4o-mini',
              max_tokens: 1000,
              messages:   [{
                role:    'user',
                content: [
                  { type: 'text', text: FOOD_ANALYSIS_PROMPT },
                  { type: 'image_url', image_url: { url: image1Url, detail: 'high' } },
                ],
              }],
            })
          : Promise.resolve(null)

        const [scoringResult, foodAnalysisResult] = await Promise.all([scoringCall, foodAnalysisCall])

        // Classify from scores
        let styleCategory: StyleCategory = 'warm_comfort'
        try {
          const raw = scoringResult.choices[0].message.content?.trim() ?? ''
          const jsonMatch = raw.match(/\{[\s\S]*\}/)
          if (jsonMatch) {
            const scores = JSON.parse(jsonMatch[0])
            styleCategory = classifyStyle(scores)
            console.log('[transform] scores:', scores)
          }
        } catch {
          console.warn('[transform] scoring parse failed, using default category')
        }

        // ── Step 2b: Category-specific atmosphere analysis ────────────
        console.log('[transform] style_category:', styleCategory)
        const atmosphereResult = await openai.chat.completions.create({
          model:      'gpt-4o-mini',
          max_tokens: 300,
          messages:   [{
            role:    'user',
            content: [
              { type: 'text', text: ATMOSPHERE_PROMPTS[styleCategory] },
              { type: 'image_url', image_url: { url: image2Url, detail: 'low' } },
            ],
          }],
        })

        const atmosphere = atmosphereResult.choices[0].message.content?.trim()
          ?? 'professional food photography with warm natural lighting'

        // Parse food analysis JSON (or use what user sent back)
        let foodAnalysis: FoodAnalysis | null = providedFoodAnalysis
        if (!foodAnalysis && foodAnalysisResult) {
          const raw = foodAnalysisResult.choices[0].message.content?.trim() ?? ''
          try {
            const jsonMatch = raw.match(/\{[\s\S]*\}/)
            if (jsonMatch) foodAnalysis = JSON.parse(jsonMatch[0])
          } catch {
            console.warn('[transform] food analysis parse failed:', raw.slice(0, 200))
          }
        }

        console.log('[transform] style_category:', styleCategory)
        console.log('[transform] atmosphere:', atmosphere)
        console.log('[transform] food analysis:', foodAnalysis?.primary_type ?? 'none')

        const foodOptPrompt = foodAnalysis ? buildFoodOptPrompt(foodAnalysis) : ''

        // ── Step 3: Relight with gpt-image-1 ─────────────────────────
        send('progress', { step: 'generating', message: 'Applying reference atmosphere…' })
        console.log('[transform] editing with gpt-image-1')

        const origPng = await sharp(image1Buf)
          .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
          .png()
          .toBuffer()

        const origFile = await toFile(origPng, 'original.png', { type: 'image/png' })

        const intensityDesc =
          intensity >= 90 ? 'Apply at full strength — completely transform the lighting to match the reference atmosphere.' :
          intensity >= 70 ? 'Apply at strong strength — the reference atmosphere should be clearly dominant, with only faint traces of the original lighting remaining.' :
          intensity >= 50 ? 'Apply at moderate strength — blend halfway between the original lighting and the reference atmosphere.' :
          intensity >= 30 ? 'Apply subtly — only a gentle shift toward the reference atmosphere, mostly preserve the original lighting character.' :
                            'Apply very subtly — barely perceptible shift, just a faint hint of the reference atmosphere.'

        const styleGuide = STYLE_DIRECTION[styleCategory]

        const prompt = `Professional food photo retouching — lighting, atmosphere, and food quality enhancement.

Style classification: ${styleCategory}
Lighting direction: ${styleGuide.direction}

Target atmosphere (from reference image): ${atmosphere}

Application intensity (${intensity}%): ${intensityDesc}

What to KEEP exactly as-is:
- Every food item, ingredient, garnish, plating, and plate shape — unchanged
- Every background object and prop — soy sauce bottles, chopsticks, condiment dishes, napkins, cutlery, decorations, anything present in the scene stays in the exact same position
- The original background surface, table material, and environment — unchanged
- Composition, camera angle, and framing — identical
- Do not add, remove, replace, or reposition any element in the scene

What to ADJUST (lighting only, not content):
- Relight the entire scene to exactly match the target atmosphere described above
- ${styleGuide.prohibitions}
- Relight the food with the same light direction, colour, and intensity as the target atmosphere
- Do NOT replace the background with a new one — only change how the existing background is lit

${foodOptPrompt}

The result must look like the exact same photo taken under different studio lighting and post-processed for maximum food appeal — same scene, same objects, different light and enhanced food quality.`

        const editResult = await openai.images.edit({
          model:  'gpt-image-1.5',
          image:  origFile,
          prompt,
          input_fidelity:  'high',
          quality:         'high',
          size:            'auto',
          output_format:   'png',
        })

        // ── Step 4: Extract output buffer ─────────────────────────────
        const imgData = editResult.data?.[0]
        let outputBuffer: Buffer

        if (imgData?.b64_json) {
          outputBuffer = Buffer.from(imgData.b64_json, 'base64')
        } else if (imgData?.url) {
          outputBuffer = await fetchBuffer(imgData.url)
        } else {
          throw new Error('gpt-image-1 returned no image data')
        }

        // ── Step 5: Upload result ─────────────────────────────────────
        const outputUrl = await upload(outputBuffer, 'output', 'image/png')
        await admin.from('jobs')
          .update({ output_url: outputUrl, status: 'done' })
          .eq('id', jobId)

        send('done', { outputUrl, foodAnalysis, styleCategory })

      } catch (err) {
        console.error('[transform] pipeline error:', err)
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
