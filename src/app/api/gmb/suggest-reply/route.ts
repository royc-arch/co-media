/**
 * POST /api/gmb/suggest-reply
 * Generates an AI reply preview for a review. Does NOT post to Google.
 * Body: { reviewText, reviewAuthor, starRating, keywords, length, tone, customInstructions }
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
  } = await request.json() as {
    reviewText:          string
    reviewAuthor:        string
    starRating:          string   // 'ONE'–'FIVE'
    keywords:            string[]
    length:              Length
    customInstructions?: string
  }

  const STAR_MAP: Record<string, number> = { ONE:1, TWO:2, THREE:3, FOUR:4, FIVE:5 }
  const stars = STAR_MAP[starRating] ?? 3

  // Compute target character count
  const reviewLen = (reviewText ?? '').length
  const targetChars = length === 'recommended'
    ? reviewLen + 250
    : LENGTH_CHARS[length]

  const keywordLine = keywords?.length
    ? `You MUST naturally embed these keywords near the beginning of your reply: ${keywords.join(', ')}.`
    : ''

  const system = `
You are writing a reply on behalf of a restaurant owner to a customer review.
You are a real, warm, enthusiastic person — NOT a corporate AI.

STRICT RULES — break any of these and the reply is rejected:
1. Start with genuine appreciation for the review (not generic "Thank you for your review!").
2. Use oral, conversational language. Write how a real person talks, not writes.
3. NO emojis or special icons of any kind.
4. NO dramatic, over-the-top words (e.g. amazing, spectacular, incredible, fantastic, delightful).
5. Do NOT sound robotic or formulaic.
6. Do NOT mention the business name.
7. Do NOT repeat the reviewer's exact words back to them.
8. Do NOT give definitions or explanations (e.g. do NOT say "our all-you-can-eat experience means...").
9. Friendly and enthusiastic — but genuine, not exaggerated.
10. Keep the reply under ${targetChars} characters (this is a hard limit).
${keywordLine}
${customInstructions ? `Additional instructions: ${customInstructions}` : ''}
  `.trim()

  const user_prompt = `
Review by ${reviewAuthor} (${stars}/5 stars):
"${reviewText ?? '(no comment)'}"

Write a reply following ALL the rules above. Output only the reply text — no quotes, no labels.
  `.trim()

  try {
    const res = await openai.chat.completions.create({
      model:    'gpt-4o',
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user_prompt },
      ],
      max_tokens:  400,
      temperature: 0.8,
    })

    const reply = res.choices[0].message.content?.trim() ?? ''
    return Response.json({ reply })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return Response.json({ error: message }, { status: 500 })
  }
}
