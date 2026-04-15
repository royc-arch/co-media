/**
 * GET /api/gmb/reviews?locationName=accounts/{accountId}/locations/{locationId}
 */
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getValidAccessToken, gmbFetch } from '@/lib/gmb'
import { NextRequest } from 'next/server'

interface GmbReview {
  name:           string
  reviewId:       string
  reviewer:       { displayName: string }
  starRating:     string
  comment?:       string
  createTime:     string
  reviewReply?:   { comment: string }
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const locationName = new URL(request.url).searchParams.get('locationName')
  if (!locationName) return Response.json({ error: 'locationName required' }, { status: 400 })

  // Expect "accounts/{accountId}/locations/{locationId}"
  const parts = locationName.split('/')
  if (parts.length !== 4 || parts[0] !== 'accounts' || parts[2] !== 'locations') {
    return Response.json({ error: `Invalid locationName: ${locationName}` }, { status: 400 })
  }
  const [, accountId, , locationId] = parts

  try {
    const token = await getValidAccessToken(user.id)

    // Try new Reviews API first, fall back to v4
    const urlsToTry = [
      `https://mybusinessreviews.googleapis.com/v1/accounts/${accountId}/locations/${locationId}/reviews?pageSize=50`,
      `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews?pageSize=50`,
    ]

    let data: { reviews?: GmbReview[] } | null = null
    const allErrors: string[] = []

    for (const url of urlsToTry) {
      try {
        data = await gmbFetch(token, url) as { reviews?: GmbReview[] }
        break
      } catch (e) {
        allErrors.push(`${url} → ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    if (!data) {
      throw new Error(`All review endpoints failed for ${locationName}.\n${allErrors.join('\n')}`)
    }

    const reviews = data.reviews ?? []

    const admin = createAdminClient()
    if (reviews.length > 0) {
      await admin.from('gmb_reviews').upsert(
        reviews.map(r => ({
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

    return Response.json({ reviews })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return Response.json({ error: message }, { status: 500 })
  }
}
