/**
 * POST /api/gmb/suggest-reply/learn
 * Saves the user's style preferences learned from their Round 1 + Round 2 selections.
 * Body: { r1Pick, r2Pick, reviewText, locationName }
 * Returns: { ok: true, hints: string }
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

  const { r1Pick, r2Pick, reviewText, locationName } = await request.json() as {
    r1Pick:       string
    r2Pick:       string
    reviewText:   string
    locationName: string
  }

  const system = `
You are analyzing a restaurant owner's reply style preferences.

For this review:
"${reviewText}"

The owner was shown 5 reply options and picked:
ROUND 1 PICK: "${r1Pick}"

Then they were shown 5 refined options and picked:
ROUND 2 PICK: "${r2Pick}"

Based on both selections, write a concise style note (2-3 sentences maximum) that captures:
- What tone/voice this owner prefers
- Any structural patterns (how they open, how direct they are, formality level)
- What to avoid based on what they didn't pick

This note will be injected into future AI prompts to guide reply generation for this business.
Write it as a direct instruction to the AI, starting with "This owner prefers..."

Return ONLY the style note text. No JSON, no labels, no explanation.
  `.trim()

  try {
    const res = await openai.chat.completions.create({
      model:       'gpt-4o-mini',
      messages:    [{ role: 'user', content: system }],
      max_tokens:  150,
      temperature: 0.3,
    })

    const hints = res.choices[0].message.content?.trim() ?? ''
    if (!hints) return Response.json({ ok: true, hints: '' })

    // Save to gmb_settings.prompt_hints
    const admin = createAdminClient()
    await admin
      .from('gmb_settings')
      .update({ prompt_hints: hints, updated_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .eq('location_name', locationName)

    return Response.json({ ok: true, hints })
  } catch (err) {
    // Non-fatal — learning failure shouldn't block the user
    console.error('[suggest/learn]', err)
    return Response.json({ ok: true, hints: '' })
  }
}
