/**
 * POST /api/gmb/suggest-reply/refine
 * Round 2: analyzes the user's Round 1 selection and generates 5 refined variations.
 * Body: { selectedReply, reviewText, reviewAuthor, starRating, keywords, length, customInstructions, promptHints }
 * Returns: { replies: string[], insight: string }
 */
import { createClient } from '@/lib/supabase/server'
import { NextRequest }  from 'next/server'
import OpenAI          from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

type Length = 'recommended' | 'condense' | 'medium' | 'detailed'
const LENGTH_CHARS: Record<Exclude<Length, 'recommended'>, number> = {
  condense: 250, medium: 500, detailed: 750,
}
const STAR_MAP: Record<string, number> = { ONE:1, TWO:2, THREE:3, FOUR:4, FIVE:5 }

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const {
    selectedReply,
    reviewText,
    reviewAuthor,
    starRating,
    keywords,
    length,
    customInstructions,
    promptHints,
  } = await request.json() as {
    selectedReply:        string
    reviewText:           string
    reviewAuthor:         string
    starRating:           string
    keywords:             string[]
    length:               Length
    customInstructions?:  string
    promptHints?:         string
  }

  const stars       = STAR_MAP[starRating] ?? 3
  const reviewLen   = (reviewText ?? '').length
  const targetChars = length === 'recommended' ? reviewLen + 250 : LENGTH_CHARS[length]

  const keywordLine = keywords?.length
    ? `Keywords to embed near the beginning: ${keywords.join(', ')}.`
    : ''

  const system = `
You are a writing coach helping refine restaurant review replies.

The user was shown 5 reply variations and selected this one as closest to their preferred style:

SELECTED REPLY:
"${selectedReply}"

ORIGINAL REVIEW (${stars}/5 stars by ${reviewAuthor}):
"${reviewText ?? '(no comment)'}"

Your task:
1. Analyze what makes the selected reply work — identify 1-2 key stylistic qualities (tone, structure, opening style, word choice, how natural it sounds).
2. Generate 5 NEW refined variations that build on those qualities. They must be meaningfully different from each other and from the selected reply — not just paraphrases.

All replies must follow these rules:
- Start with genuine appreciation (not generic).
- Oral, conversational — sounds like a real person, not a press release.
- NO emojis. NO dramatic words (amazing, spectacular, incredible, etc).
- Do NOT mention the business name. Do NOT repeat reviewer's exact words.
- Under ${targetChars} characters each (hard limit).
${keywordLine}
${customInstructions ? `Owner's instructions: ${customInstructions}` : ''}
${promptHints ? `Known style preference: ${promptHints}` : ''}

Return ONLY valid JSON with this exact structure:
{
  "insight": "one concise sentence describing what made the selected reply work",
  "replies": ["reply1", "reply2", "reply3", "reply4", "reply5"]
}
  `.trim()

  try {
    const res = await openai.chat.completions.create({
      model:           'gpt-4o',
      messages:        [{ role: 'user', content: system }],
      max_tokens:      2000,
      temperature:     0.85,
      response_format: { type: 'json_object' },
    })

    const raw  = res.choices[0].message.content ?? '{}'
    const data = JSON.parse(raw) as { insight?: string; replies?: string[] }

    const replies = (data.replies ?? []).slice(0, 5)
    const insight = data.insight ?? ''

    if (!replies.length) throw new Error('GPT returned no refined replies')
    return Response.json({ replies, insight })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}
