/**
 * GET /api/cron/gmb-autoreply
 * Runs every 30 minutes via Vercel Cron.
 * location_name format: "accounts/{accountId}/locations/{locationId}"
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { getValidAccessToken, gmbFetch, TONE_PROMPTS } from '@/lib/gmb'
import { NextRequest } from 'next/server'
import OpenAI from 'openai'

export const maxDuration = 300

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

interface GmbReview {
  name:         string
  reviewer:     { displayName: string }
  starRating:   string
  comment?:     string
  createTime:   string
  reviewReply?: { comment: string }
}

const STAR_MAP: Record<string, number> = {
  ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5,
}

async function generateReply(
  review: { author: string; rating: string; comment: string | null },
  tone: string,
  customInstructions: string | null
): Promise<string> {
  const stars = STAR_MAP[review.rating] ?? 3
  const systemPrompt = [
    `You are writing a reply on behalf of a restaurant/business owner to a Google review.`,
    TONE_PROMPTS[tone] ?? TONE_PROMPTS.professional,
    `Keep the reply concise (2-4 sentences). Do not use emojis excessively.`,
    `Do not mention specific food items unless the reviewer did. Do not make promises.`,
    customInstructions ? `Additional instructions: ${customInstructions}` : '',
  ].filter(Boolean).join(' ')

  const userPrompt = `Review by ${review.author} (${stars}/5 stars):\n"${review.comment ?? '(no comment)'}"\n\nWrite a reply:`

  const res = await openai.chat.completions.create({
    model:    'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
    max_tokens: 200,
  })

  return res.choices[0].message.content?.trim() ?? 'Thank you for your review!'
}

export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()

  const { data: locations } = await admin
    .from('gmb_settings')
    .select('user_id, account_name, location_name, reply_tone, custom_instructions')
    .eq('auto_reply_enabled', true)

  if (!locations?.length) return Response.json({ processed: 0 })

  let totalReplied = 0

  for (const loc of locations) {
    try {
      const token = await getValidAccessToken(loc.user_id)

      // location_name: "accounts/{accountId}/locations/{locationId}"
      const parts      = loc.location_name.split('/')
      const accountId  = parts[1]
      const locationId = parts[3]

      if (!accountId || !locationId) {
        console.error(`Skipping invalid location_name: ${loc.location_name}`)
        continue
      }

      // Try new Reviews API first, fall back to v4
      let data: { reviews?: GmbReview[] } | null = null
      for (const url of [
        `https://mybusinessreviews.googleapis.com/v1/accounts/${accountId}/locations/${locationId}/reviews?pageSize=50`,
        `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews?pageSize=50`,
      ]) {
        try { data = await gmbFetch(token, url) as { reviews?: GmbReview[] }; break }
        catch { /* try next */ }
      }

      const reviews = data?.reviews ?? []

      for (const review of reviews) {
        if (review.reviewReply) continue

        const { data: cached } = await admin
          .from('gmb_reviews')
          .select('replied')
          .eq('review_name', review.name)
          .single()

        if (cached?.replied) continue

        const comment = await generateReply(
          {
            author:  review.reviewer?.displayName ?? 'Guest',
            rating:  review.starRating,
            comment: review.comment ?? null,
          },
          loc.reply_tone ?? 'professional',
          loc.custom_instructions ?? null
        )

        // Try new API then v4 for reply
        for (const url of [
          `https://mybusinessreviews.googleapis.com/v1/${review.name}/reply`,
          `https://mybusiness.googleapis.com/v4/${review.name}/reply`,
        ]) {
          try {
            await gmbFetch(token, url, { method: 'PUT', body: JSON.stringify({ comment }) })
            break
          } catch { /* try next */ }
        }

        await admin.from('gmb_reviews').upsert({
          user_id:       loc.user_id,
          location_name: loc.location_name,
          review_name:   review.name,
          author:        review.reviewer?.displayName ?? null,
          rating:        review.starRating,
          comment:       review.comment ?? null,
          replied:       true,
          reply_text:    comment,
          review_time:   review.createTime,
        }, { onConflict: 'review_name' })

        totalReplied++
      }
    } catch (err) {
      console.error(`Auto-reply failed for ${loc.location_name}:`, err)
    }
  }

  return Response.json({ processed: totalReplied })
}
