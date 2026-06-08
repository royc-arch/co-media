/**
 * POST /api/gmb/suggest-reply
 * Generates 5 AI reply variations. Does NOT post to Google.
 * Body: { reviewText, reviewAuthor, starRating, keywords, length, context, customInstructions, promptHints }
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

/**
 * Returns the reviewer's first name if it looks like a real human name,
 * otherwise null (so we don't address "FoodLover2023" or "Anonymous" by name).
 */
function extractFirstName(author: string): string | null {
  if (!author) return null
  const first = author.trim().split(/\s+/)[0]
  // Must be 2–25 chars, letters only (including accented), hyphens, apostrophes
  if (!/^[a-zA-ZÀ-ÿ''-]{2,25}$/.test(first)) return null
  // Reject all-caps strings longer than 3 chars (e.g. "JOHNSMITH")
  if (first.length > 3 && first === first.toUpperCase()) return null
  // Reject common non-name tokens
  const skip = new Set(['anonymous', 'user', 'customer', 'guest', 'reviewer', 'local', 'google'])
  if (skip.has(first.toLowerCase())) return null
  return first
}

/**
 * Strip the label prefix from promptHints, returning only the style text.
 * Handles both 3-part "name||stars||styleText" and 4-part "name||stars||min_stars||styleText".
 */
function extractStyleHints(raw?: string): string {
  if (!raw) return ''
  const parts = raw.split('||')
  if (parts.length >= 4 && !isNaN(parseInt(parts[2]))) return parts.slice(3).join('||')
  if (parts.length >= 3) return parts.slice(2).join('||')
  return raw
}

/**
 * Returns true if the style in promptHints should apply to a review with the given star count.
 * Format: "name||style_stars||apply_mask||styleText"  (4-part)
 *      or "name||style_stars||styleText"              (3-part legacy → exact match)
 * apply_mask: bitmask where bit N-1 corresponds to N-star reviews.
 * null / missing mask → exact match (style applies only to its training star count).
 */
function styleAppliesTo(raw: string | undefined, reviewStars: number): boolean {
  if (!raw) return true
  const parts = raw.split('||')
  const styleStars = parseInt(parts[1])
  if (isNaN(styleStars)) return true

  const mask = (parts.length >= 4 && !isNaN(parseInt(parts[2])))
    ? parseInt(parts[2])
    : 1 << (styleStars - 1) // legacy / default: exact match

  return ((mask >> (reviewStars - 1)) & 1) === 1
}

/**
 * Remove tag questions like "aren't they?", "isn't it?", "right?", "don't you think?" etc.
 * These are always fake-sounding in a review reply context.
 */
function stripTagQuestions(text: string): string {
  // Matches ", [optional words] tag-question?" patterns mid/end of sentence
  return text
    // Comma-attached tag questions: ", isn't it?", ", aren't they?", ", right?"
    .replace(/,\s*(isn't|aren't|doesn't|don't|didn't|won't|wouldn't|can't|couldn't|shouldn't|haven't|hasn't|right|correct)\s*(\w+\s*)?\?/gi, '.')
    // Stand-alone tag phrases before punctuation
    .replace(/\b(isn't it|aren't they|isn't that right|right\?|don't you think|wouldn't you say|can you believe it|pretty great|not bad)\?/gi, '')
    // Clean up any double punctuation or trailing spaces left behind
    .replace(/\.\s*\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Replace banned AI-sounding words with natural alternatives. */
function filterBannedWords(text: string): string {
  return text
    .replace(/\bthrilled\b/gi, 'glad')
    .replace(/I can't thank you enough\b[^.!?]*/gi, 'Really appreciate it')
    .replace(/thank you so much for (?:your )?(?:such )?(?:thoughtful|kind|wonderful|detailed|lovely)\s+(?:feedback|review|words|comment)[^.!?]*/gi, 'Really glad you shared that')
    .replace(/thanks? for the (?:stars?|rating|review)[^.!?]*/gi, 'Really appreciate it')
}

/** Trim a reply to fit within maxChars, cutting at the nearest sentence end. */
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

  // Fetch last 6 posted replies for this location to enforce cross-review diversity
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

  // Apply style only if its apply_mask bit for the current review star is set
  const styleHints = styleAppliesTo(promptHints, stars) ? extractStyleHints(promptHints) : ''

  // If there's a campaign note, add extra room so the campaign content isn't squeezed out
  const hasCampaign  = styleHints.includes('\n\nCampaign instructions:')
  const targetChars  = hasCampaign ? baseChars + 200 : baseChars
  const approxWords  = Math.round(targetChars / 5.5)

  // Extract first name only if it looks like a real human name
  const firstName = extractFirstName(reviewAuthor)

  const keywordLine = keywords?.length
    ? `You MUST embed these keywords naturally near the beginning of EVERY reply: ${keywords.join(', ')}.`
    : ''

  const firstNameRule = firstName
    ? `FIRST NAME: The reviewer's first name is "${firstName}". Naturally include their name in the opening of EVERY reply (e.g. "Thank you so much, ${firstName}!" or "Really appreciate it, ${firstName}"). Do NOT use it if it would feel forced.`
    : `Do NOT address the reviewer by name.`

  const contextRule = context
    ? `BUSINESS CONTEXT (background only — use this to understand what kind of business this is and avoid tone/direction mistakes, but do NOT quote it or force it into the reply): "${context}"`
    : ''

  const photoRule = hasPhoto
    ? `The reviewer uploaded photos with their review. Acknowledge this naturally and briefly — e.g. "The photos you shared really captured it" or "Love that you got some shots of the food." Do NOT make it the main point. One short mention is enough.`
    : ''

  const recentRepliesRule = recentReplies.length
    ? `DIVERSITY (critical): These are recent replies this owner has already posted. Do NOT reuse their sentence structures, openings, or phrasing — the new replies must feel clearly different:\n${recentReplies.map((r, i) => `${i + 1}. "${r}"`).join('\n')}`
    : ''

  const system = `
You are writing replies on behalf of a restaurant owner to customer reviews.
You are a real, warm, enthusiastic person — NOT a corporate AI.

STRICT RULES — every reply must follow all of these:
1. Start with genuine appreciation (NOT generic "Thank you for your review!"). BANNED openers: "I can't thank you enough", "Thank you so much for your thoughtful feedback", "What a wonderful review", "We're so grateful for your kind words", "Thanks for the stars", "Thanks for the rating", or any opener that sounds more effusive than the review deserves, or that references the star rating as a thing. If the review is short (a few words), the opening must also be brief and natural — match the energy of the review, do not over-thank.
2. Oral, conversational language. Write how a real person talks, not writes.
3. NO emojis or special icons.
4. NO dramatic words (amazing, spectacular, incredible, fantastic, wonderful, delightful, thrilled).
5. ABSOLUTELY NO rhetorical questions or tag questions — NEVER write things like "isn't it?", "aren't they?", "right?", "don't you think?", "isn't that great?", "can you believe it?", "pretty great, huh?", or ANY sentence ending in a question mark that isn't a genuine question to the reviewer. This sounds fake and salesy. BANNED. Every sentence must be a statement.
5b. NO performative hype — NEVER call staff "rockstars", "superstars", "heroes", "legends". NEVER use phrases that sound like a marketing email or a pep rally.
5c. NO performative farewells or sign-offs — ABSOLUTELY BANNED: "Happy eating!", "Until then!", "Happy dining!", "Here's to many more!", "Keep enjoying!", "Take care!", "Cheers!", "Best wishes!", or any chipper slogan or trailing farewell tag. Instead, end with a simple, genuine invitation to return — something like "Hope to see you again soon" or "Would love to have you back." That line is the ending. Do NOT append anything after it.
6. NOT robotic or formulaic.
7. Do NOT mention the business name.
8. Do NOT repeat the reviewer's exact words back to them.
8b. Do NOT comment on the review itself — NEVER say things like "short and sweet, just like your review", "what a detailed review", "thanks for taking the time to write this", or anything that draws attention to the review as a piece of writing. Respond to what they said, not to the act of saying it.
8c. If the reviewer left no comment (rating only), do NOT acknowledge the absence of words — NEVER say "even without words", "without a comment", "the rating speaks for itself", or anything that points out they didn't write anything. Just reply warmly and briefly as if they left a short positive note.
9. Do NOT give definitions or explanations.
10. Friendly and enthusiastic — genuine, not exaggerated.
11. LENGTH — HARD LIMIT: each reply must be under ${targetChars} characters (≈ ${approxWords} words). Stop writing when you reach this limit. Never go over. Shorter is fine, longer is not allowed.
12. ${firstNameRule}
${keywordLine}
${contextRule}
${customInstructions ? `Owner's instructions: ${customInstructions}` : ''}
${styleHints ? `Learned style preference (important — follow this): ${styleHints}` : ''}
${photoRule}
${recentRepliesRule}

Generate exactly 5 reply variations. CRITICAL — they must be GENUINELY DIFFERENT from each other, not paraphrases:
- Each reply must open differently (different first word, different sentence structure, different angle of appreciation).
- Vary the sentence rhythm: some short and punchy, some longer and more flowing.
- Vary which specific detail from the review each reply focuses on.
- Do NOT reuse the same key phrases, adjectives, or sentence templates across replies. If reply 1 says "really glad", reply 2 must not say it.
- A human reading all 5 should feel each one was written separately by a real person, not generated from a template.

Return a JSON object with a "replies" key containing exactly 5 strings:
{"replies": ["reply1", "reply2", "reply3", "reply4", "reply5"]}
  `.trim()

  const userMsg = `Review by ${reviewAuthor} (${stars}/5 stars):\n"${reviewText ?? '(no comment)'}"\n\nGenerate 5 distinct reply variations following all rules. Remember: UNDER ${targetChars} characters each.${context ? ` Context to include: "${context}"` : ''}`

  try {
    const res = await openai.chat.completions.create({
      model:           'gpt-4o',
      messages:        [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
      max_tokens:      2000,
      temperature:     0.9,
      response_format: { type: 'json_object' },
    })

    const raw = res.choices[0].message.content ?? '{}'
    let replies: string[] = []
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        // bare array (shouldn't happen with json_object mode, but handle it)
        replies = parsed.filter((x): x is string => typeof x === 'string')
      } else if (Array.isArray(parsed.replies)) {
        replies = (parsed.replies as unknown[]).filter((x): x is string => typeof x === 'string')
      } else {
        // GPT used some other key or nested structure — collect all leaf strings
        const strings: string[] = []
        const collect = (v: unknown) => {
          if (typeof v === 'string') { strings.push(v); return }
          if (Array.isArray(v))      { v.forEach(collect); return }
          if (v && typeof v === 'object') Object.values(v).forEach(collect)
        }
        collect(parsed)
        replies = strings
      }
    } catch {
      replies = []
    }

    if (!replies.length) throw new Error('GPT returned no replies')

    // Server-side enforcement: strip tag questions, replace banned words, then trim to length limit
    const enforced = replies.slice(0, 5).map(r => enforceLength(filterBannedWords(stripTagQuestions(String(r))), targetChars))
    return Response.json({ replies: enforced })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}
