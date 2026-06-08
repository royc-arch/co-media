/**
 * POST /api/gmb/suggest-reply/refine
 * Round 2: analyzes the user's Round 1 selection and generates 5 refined variations.
 * Body: { selectedReply, reviewText, reviewAuthor, starRating, keywords, length, context, customInstructions, promptHints }
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

function extractFirstName(author: string): string | null {
  if (!author) return null
  const first = author.trim().split(/\s+/)[0]
  if (!/^[a-zA-ZÀ-ÿ''-]{2,25}$/.test(first)) return null
  if (first.length > 3 && first === first.toUpperCase()) return null
  const skip = new Set(['anonymous', 'user', 'customer', 'guest', 'reviewer', 'local', 'google'])
  if (skip.has(first.toLowerCase())) return null
  return first
}

function extractStyleHints(raw?: string): string {
  if (!raw) return ''
  const parts = raw.split('||')
  if (parts.length >= 4 && !isNaN(parseInt(parts[2]))) return parts.slice(3).join('||')
  if (parts.length >= 3) return parts.slice(2).join('||')
  return raw
}

function styleAppliesTo(raw: string | undefined, reviewStars: number): boolean {
  if (!raw) return true
  const parts = raw.split('||')
  const styleStars = parseInt(parts[1])
  if (isNaN(styleStars)) return true
  const mask = (parts.length >= 4 && !isNaN(parseInt(parts[2])))
    ? parseInt(parts[2])
    : 1 << (styleStars - 1)
  return ((mask >> (reviewStars - 1)) & 1) === 1
}

function filterBannedWords(text: string): string {
  return text
    .replace(/\bthrilled\b/gi, 'glad')
    .replace(/I can't thank you enough\b[^.!?]*/gi, 'Really appreciate it')
    .replace(/thank you so much for (?:your )?(?:such )?(?:thoughtful|kind|wonderful|detailed|lovely)\s+(?:feedback|review|words|comment)[^.!?]*/gi, 'Really glad you shared that')
    .replace(/thanks? for the (?:stars?|rating|review)[^.!?]*/gi, 'Really appreciate it')
}

function stripTagQuestions(text: string): string {
  return text
    .replace(/,\s*(isn't|aren't|doesn't|don't|didn't|won't|wouldn't|can't|couldn't|shouldn't|haven't|hasn't|right|correct)\s*(\w+\s*)?\?/gi, '.')
    .replace(/\b(isn't it|aren't they|isn't that right|right\?|don't you think|wouldn't you say|can you believe it|pretty great|not bad)\?/gi, '')
    .replace(/\.\s*\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function enforceLength(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const truncated = text.slice(0, maxChars)
  const lastEnd   = Math.max(
    truncated.lastIndexOf('.'),
    truncated.lastIndexOf('!'),
    truncated.lastIndexOf('?'),
  )
  if (lastEnd > maxChars * 0.5) return text.slice(0, lastEnd + 1).trim()
  const lastSpace = truncated.lastIndexOf(' ')
  return lastSpace > 0 ? truncated.slice(0, lastSpace).trim() : truncated
}

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
    context,
    customInstructions,
    promptHints,
    locationName,
    hasPhoto,
  } = await request.json() as {
    selectedReply:        string
    reviewText:           string
    reviewAuthor:         string
    starRating:           string
    keywords:             string[]
    length:               Length
    context?:             string
    customInstructions?:  string
    promptHints?:         string
    locationName?:        string
    hasPhoto?:            boolean
  }

  // Fetch last 6 posted replies for cross-review diversity
  let recentReplies: string[] = []
  if (locationName) {
    const { data: recent } = await supabase
      .from('gmb_reviews')
      .select('reply_text')
      .eq('user_id', user.id)
      .eq('location_name', locationName)
      .eq('replied', true)
      .not('reply_text', 'is', null)
      .order('review_time', { ascending: false })
      .limit(6)
    recentReplies = (recent ?? []).map(r => r.reply_text as string).filter(Boolean)
  }

  const stars       = STAR_MAP[starRating] ?? 3
  const reviewLen   = (reviewText ?? '').length
  const baseChars   = length === 'recommended'
    ? Math.max(150, Math.min(reviewLen + 250, 600))
    : LENGTH_CHARS[length]

  const styleHints   = styleAppliesTo(promptHints, stars) ? extractStyleHints(promptHints) : ''
  const hasCampaign  = styleHints.includes('\n\nCampaign instructions:')
  const targetChars  = hasCampaign ? baseChars + 200 : baseChars
  const approxWords  = Math.round(targetChars / 5.5)

  const firstName   = extractFirstName(reviewAuthor)
  const keywordLine = keywords?.length
    ? `Keywords to embed near the beginning: ${keywords.join(', ')}.`
    : ''

  const firstNameRule = firstName
    ? `FIRST NAME: The reviewer's name is "${firstName}". Naturally include their name in the opening of EVERY reply. Do NOT use it if it would feel forced.`
    : `Do NOT address the reviewer by name.`

  const contextRule = context
    ? `BUSINESS CONTEXT (background only — use this to understand what kind of business this is and avoid tone/direction mistakes, but do NOT quote it or force it into the reply): "${context}"`
    : ''

  const photoRule = hasPhoto
    ? `The reviewer uploaded photos with their review. Acknowledge this naturally and briefly — e.g. "The photos you shared really captured it." One short mention only, not the main point.`
    : ''

  const recentRepliesRule = recentReplies.length
    ? `DIVERSITY (critical): These are recent replies this owner has already posted. Do NOT reuse their sentence structures, openings, or phrasing:\n${recentReplies.map((r, i) => `${i + 1}. "${r}"`).join('\n')}`
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
- Start with genuine appreciation (not generic). BANNED openers: "I can't thank you enough", "Thank you so much for your thoughtful feedback", "What a wonderful review", "Thanks for the stars", "Thanks for the rating", or anything more effusive than the review deserves, or that references the star rating as a thing. Match the energy of the review — a short review gets a brief, natural opener, not an over-the-top thank-you.
- Oral, conversational — sounds like a real person, not a press release.
- NO emojis. NO dramatic words (amazing, spectacular, incredible, thrilled, etc).
- ABSOLUTELY NO rhetorical questions or tag questions — NEVER "isn't it?", "aren't they?", "right?", "don't you think?", "can you believe it?", "pretty great, huh?", or any sentence ending in "?" that isn't a genuine question. Every sentence must be a statement. BANNED.
- NO performative or cringe phrases — do NOT call staff "rockstars", "superstars", "heroes", or use rhetorical hype. Sound like a real person, not a marketing email.
- NO performative farewells or sign-offs — ABSOLUTELY BANNED: "Happy eating!", "Until then!", "Happy dining!", "Here's to many more!", "Keep enjoying!", "Take care!", "Cheers!", "Best wishes!", or any chipper slogan or trailing farewell tag. Instead, end with a simple, genuine invitation to return — something like "Hope to see you again soon" or "Would love to have you back." That line is the ending. Do NOT append anything after it.
- Do NOT mention the business name. Do NOT repeat reviewer's exact words.
- Do NOT comment on the review itself — NEVER say "short and sweet, just like your review", "what a detailed review", "thanks for taking the time to write this", or anything that treats the review as a piece of writing. Respond to what they experienced, not to how they wrote about it.
- If the reviewer left no comment (rating only), do NOT acknowledge the absence of words — NEVER say "even without words", "without a comment", "the rating speaks for itself". Just reply warmly and briefly as if they left a short positive note.
- LENGTH — HARD LIMIT: under ${targetChars} characters (≈ ${approxWords} words) each. Never go over. Shorter is fine, longer is not.
- ${firstNameRule}
${keywordLine}
${contextRule}
${customInstructions ? `Owner's instructions: ${customInstructions}` : ''}
${styleHints ? `Known style preference: ${styleHints}` : ''}
${photoRule}
${recentRepliesRule}

The 5 new replies must be GENUINELY DIFFERENT from each other — not paraphrases:
- Each reply must open differently (different first word, different sentence structure, different angle).
- Vary the sentence rhythm: some short and punchy, some longer and more flowing.
- Do NOT reuse the same key phrases, adjectives, or sentence templates across the 5 replies.
- A human reading all 5 should feel each one was written separately, not generated from a template.

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
    let replies: string[] = []
    let insight = ''
    try {
      const data = JSON.parse(raw) as Record<string, unknown>
      insight = typeof data.insight === 'string' ? data.insight : ''
      if (Array.isArray(data.replies)) {
        replies = data.replies.filter((x): x is string => typeof x === 'string')
      } else {
        const strings: string[] = []
        const collect = (v: unknown) => {
          if (typeof v === 'string' && v !== insight) { strings.push(v); return }
          if (Array.isArray(v))                        { v.forEach(collect); return }
          if (v && typeof v === 'object')              Object.values(v).forEach(collect)
        }
        collect(data)
        replies = strings
      }
    } catch { replies = [] }

    replies = replies.slice(0, 5).map(r => enforceLength(filterBannedWords(stripTagQuestions(r)), targetChars))
    if (!replies.length) throw new Error('GPT returned no refined replies')
    return Response.json({ replies, insight })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}
