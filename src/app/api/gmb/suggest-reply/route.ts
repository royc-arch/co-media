/**
 * POST /api/gmb/suggest-reply
 * Generates 5 AI reply variations. Does NOT post to Google.
 * Body: { reviewText, reviewAuthor, starRating, keywords, length, customInstructions, promptHints }
 * Returns: { replies: string[] }
 */
import { createClient } from '@/lib/supabase/server'
import { NextRequest }  from 'next/server'
import OpenAI          from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

type Length = 'recommended' | 'condense' | 'medium' | 'detailed'

const LENGTH_CHARS: Record<Exclude<Length, 'recommended'>, number> = {
  condense: 250,
  medium:   500,
  detailed: 750,
}

const STAR_MAP: Record<string, number> = { ONE:1, TWO:2, THREE:3, FOUR:4, FIVE:5 }

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const {
    reviewText,
    reviewAuthor,
    starRating,
    keywords,
    length,
    customInstructions,
    promptHints,
  } = await request.json() as {
    reviewText:           string
    reviewAuthor:         string
    starRating:           string
    keywords:             string[]
    length:               Length
    customInstructions?:  string
    promptHints?:         string
  }

  const stars      = STAR_MAP[starRating] ?? 3
  const reviewLen  = (reviewText ?? '').length
  const targetChars = length === 'recommended' ? reviewLen + 250 : LENGTH_CHARS[length]

  const keywordLine = keywords?.length
    ? `You MUST embed these keywords naturally near the beginning of EVERY reply: ${keywords.join(', ')}.`
    : ''

  const system = `
You are writing replies on behalf of a restaurant owner to customer reviews.
You are a real, warm, enthusiastic person — NOT a corporate AI.

STRICT RULES — every reply must follow all of these:
1. Start with genuine appreciation (NOT generic "Thank you for your review!").
2. Oral, conversational language. Write how a real person talks, not writes.
3. NO emojis or special icons.
4. NO dramatic words (amazing, spectacular, incredible, fantastic, wonderful, delightful).
5. NOT robotic or formulaic.
6. Do NOT mention the business name.
7. Do NOT repeat the reviewer's exact words back to them.
8. Do NOT give definitions or explanations.
9. Friendly and enthusiastic — genuine, not exaggerated.
10. Each reply must be under ${targetChars} characters (hard limit).
${keywordLine}
${customInstructions ? `Owner's instructions: ${customInstructions}` : ''}
${promptHints ? `Learned style preference (important — follow this): ${promptHints}` : ''}

Generate exactly 5 DISTINCT reply variations. They must differ meaningfully in phrasing, structure, and opening — not just swap a word or two.

Return ONLY a valid JSON array with exactly 5 strings. No markdown, no explanation, no other text:
["reply1", "reply2", "reply3", "reply4", "reply5"]
  `.trim()

  const userMsg = `Review by ${reviewAuthor} (${stars}/5 stars):\n"${reviewText ?? '(no comment)'}"\n\nGenerate 5 distinct reply variations following all rules.`

  try {
    const res = await openai.chat.completions.create({
      model:       'gpt-4o',
      messages:    [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
      max_tokens:  2000,
      temperature: 0.9,
      response_format: { type: 'json_object' },
    })

    const raw = res.choices[0].message.content ?? '[]'
    // GPT might return { replies: [...] } or just [...] — handle both
    let replies: string[] = []
    try {
      const parsed = JSON.parse(raw)
      replies = Array.isArray(parsed) ? parsed : (parsed.replies ?? Object.values(parsed))
    } catch {
      replies = []
    }

    if (!replies.length) throw new Error('GPT returned no replies')
    return Response.json({ replies: replies.slice(0, 5) })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}
