/**
 * GET /api/gmb/reviews
 *   Reads from Supabase cache (fast, paginated). Does NOT call Google.
 *   Query params: locationName, page (default 0), limit (default 30)
 *
 * POST /api/gmb/reviews
 *   Syncs reviews from Google → upserts into gmb_reviews cache.
 *   Body: { locationName }
 */
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getValidAccessToken, gmbFetch } from '@/lib/gmb'
import { NextRequest } from 'next/server'

interface GmbReview {
  name:         string
  reviewer:     { displayName: string }
  starRating:   string
  comment?:     string
  createTime:   string
  reviewReply?: { comment: string }
}

const PAGE_SIZE = 30

// ── GET: read from cache ──────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const url          = new URL(request.url)
  const locationName = url.searchParams.get('locationName')
  const page         = parseInt(url.searchParams.get('page') ?? '0', 10)
  const limit        = parseInt(url.searchParams.get('limit') ?? String(PAGE_SIZE), 10)

  if (!locationName) return Response.json({ error: 'locationName required' }, { status: 400 })

  const from = page * limit
  const to   = from + limit - 1

  const { data, count, error } = await supabase
    .from('gmb_reviews')
    .select('*', { count: 'exact' })
    .eq('user_id', user.id)
    .eq('location_name', locationName)
    .order('review_time', { ascending: false })
    .range(from, to)

  if (error) return Response.json({ error: error.message }, { status: 500 })

  // Map DB rows back to GmbReview shape for the frontend
  const reviews: GmbReview[] = (data ?? []).map(r => ({
    name:        r.review_name,
    reviewer:    { displayName: r.author ?? 'Anonymous' },
    starRating:  r.rating,
    comment:     r.comment ?? undefined,
    createTime:  r.review_time ?? r.created_at,
    reviewReply: r.replied && r.reply_text ? { comment: r.reply_text } : undefined,
  }))

  return Response.json({
    reviews,
    total:   count ?? 0,
    page,
    hasMore: (count ?? 0) > to + 1,
  })
}

// ── POST: sync from Google → upsert cache ─────────────────────────────────────

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { locationName } = await request.json() as { locationName: string }
  if (!locationName) return Response.json({ error: 'locationName required' }, { status: 400 })

  const parts = locationName.split('/')
  if (parts.length !== 4 || parts[0] !== 'accounts' || parts[2] !== 'locations') {
    return Response.json({ error: `Invalid locationName: ${locationName}` }, { status: 400 })
  }
  const [, accountId, , locationId] = parts

  try {
    const token      = await getValidAccessToken(user.id)
    const allReviews: GmbReview[] = []
    let pageToken: string | undefined

    do {
      const qs       = `pageSize=50${pageToken ? `&pageToken=${pageToken}` : ''}`
      const urlsToTry = [
        `https://mybusinessreviews.googleapis.com/v1/accounts/${accountId}/locations/${locationId}/reviews?${qs}`,
        `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews?${qs}`,
      ]

      let data: { reviews?: GmbReview[]; nextPageToken?: string } | null = null
      const errors: string[] = []

      for (const url of urlsToTry) {
        try {
          data = await gmbFetch(token, url) as typeof data
          break
        } catch (e) {
          errors.push(`${url} → ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      if (!data) throw new Error(`All endpoints failed.\n${errors.join('\n')}`)

      allReviews.push(...(data.reviews ?? []))
      pageToken = data.nextPageToken
    } while (pageToken)

    // Upsert into cache
    const admin = createAdminClient()
    if (allReviews.length > 0) {
      // Batch in chunks of 100 to avoid payload limits
      for (let i = 0; i < allReviews.length; i += 100) {
        const chunk = allReviews.slice(i, i + 100)
        await admin.from('gmb_reviews').upsert(
          chunk.map(r => ({
            user_id:       user.id,
            location_name: locationName,
            review_name:   r.name,
            author:        r.reviewer?.displayName ?? null,
            rating:        r.starRating,
            comment:       r.comment ?? null,
            replied:       !!r.reviewReply,
            reply_text:    r.reviewReply?.comment ?? null,
            review_time:   r.createTime,
          })),
          { onConflict: 'review_name' }
        )
      }
    }

    return Response.json({ synced: allReviews.length })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return Response.json({ error: message }, { status: 500 })
  }
}
