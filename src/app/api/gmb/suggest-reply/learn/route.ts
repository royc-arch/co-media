/**
 * POST /api/gmb/suggest-reply/learn
 * Saves style from Round 1 + Round 2 picks.
 *   1. Generates a short name + style note via GPT.
 *   2. Inserts a row into gmb_styles (the style library).
 *   3. Sets it as the active style in gmb_settings.prompt_hints.
 * Body: { r1Pick, r2Pick, reviewText, locationName, sampleStars }
 * Returns: { ok: true, hints: string, styleId: string }
 *
 * prompt_hints / gmb_styles storage format: "name||stars||styleText"
 */
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextRequest }       from 'next/server'
import OpenAI               from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { r1Pick, r2Pick, reviewText, locationName, sampleStars } = await request.json() as {
    r1Pick:       string
    r2Pick:       string
    reviewText:   string
    locationName: string
    sampleStars?: number
  }

  const stars = sampleStars ?? 5

  const system = `
You are analyzing a restaurant owner's reply style preferences.

For this review:
"${reviewText}"

The owner was shown 5 reply options and picked:
ROUND 1 PICK: "${r1Pick}"

Then they were shown 5 refined options and picked:
ROUND 2 PICK: "${r2Pick}"

Based on both selections, return a JSON object with two fields:

1. "name": A short 2–4 word style label that captures the personality of these picks.
   Examples: "Warm & Direct", "Casual & Brief", "Personal Touch", "Low-Key Friendly"
   Do NOT use generic labels like "Professional" or "Friendly" alone.

2. "style": A concise style note (2–3 sentences) that captures:
   - What tone/voice this owner prefers
   - Any structural patterns (how they open, how direct they are, formality level)
   - What to avoid based on what they didn't pick
   Start with "This owner prefers…"
   Write it as a direct instruction to the AI.

Return ONLY valid JSON: { "name": "...", "style": "..." }
  `.trim()

  try {
    const res = await openai.chat.completions.create({
      model:           'gpt-4o-mini',
      messages:        [{ role: 'user', content: system }],
      max_tokens:      200,
      temperature:     0.3,
      response_format: { type: 'json_object' },
    })

    const parsed = JSON.parse(res.choices[0].message.content ?? '{}') as { name?: string; style?: string }
    const name   = (parsed.name  ?? 'My Style').trim()
    const style  = (parsed.style ?? '').trim()

    if (!style) return Response.json({ ok: true, hints: '', styleId: null })

    const admin     = createAdminClient()
    const applyMask = 1 << (stars - 1)          // default: exact match
    const hints     = `${name}||${stars}||${applyMask}||${style}`

    // 1. Save to style library
    const { data: newStyle, error: insertErr } = await admin
      .from('gmb_styles')
      .insert({
        user_id:       user.id,
        location_name: locationName,
        name,
        stars,
        apply_mask:    1 << (stars - 1),  // default: exact match
        style_text:    style,
      })
      .select()
      .single()

    if (insertErr) {
      console.error('[suggest/learn] insert gmb_styles:', insertErr)
      return Response.json({ error: `Failed to save style: ${insertErr.message}` }, { status: 500 })
    }

    // 2. Set as active in settings
    const { error: updateErr } = await admin
      .from('gmb_settings')
      .update({ prompt_hints: hints, updated_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .eq('location_name', locationName)

    if (updateErr) {
      console.error('[suggest/learn] update gmb_settings:', updateErr)
      // Non-fatal — style is saved, just couldn't set as active
    }

    return Response.json({ ok: true, hints, styleId: newStyle?.id ?? null })
  } catch (err) {
    console.error('[suggest/learn]', err)
    return Response.json({ ok: true, hints: '', styleId: null })
  }
}
