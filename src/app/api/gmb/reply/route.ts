/**
 * POST /api/gmb/reply
 * Body: { reviewName: string, comment: string }
 *
 * reviewName format: "accounts/{accountId}/locations/{locationId}/reviews/{reviewId}"
 */
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getValidAccessToken, gmbFetch } from '@/lib/gmb'
import { NextRequest } from 'next/server'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { reviewName, comment } = await request.json() as {
    reviewName: string
    comment:    string
  }

  if (!reviewName || !comment?.trim()) {
    return Response.json({ error: 'reviewName and comment required' }, { status: 400 })
  }

  try {
    const token = await getValidAccessToken(user.id)

    // Try new Reviews API first, fall back to v4
    const urlsToTry = [
      `https://mybusinessreviews.googleapis.com/v1/${reviewName}/reply`,
      `https://mybusiness.googleapis.com/v4/${reviewName}/reply`,
    ]

    let succeeded = false
    let lastError = ''

    for (const url of urlsToTry) {
      try {
        await gmbFetch(token, url, { method: 'PUT', body: JSON.stringify({ comment }) })
        succeeded = true
        break
      } catch (e) {
        lastError = `${url} → ${e instanceof Error ? e.message : String(e)}`
      }
    }

    if (!succeeded) {
      throw new Error(`All reply endpoints failed.\nLast error: ${lastError}`)
    }

    const admin = createAdminClient()
    await admin.from('gmb_reviews').update({
      replied:    true,
      reply_text: comment,
    }).eq('review_name', reviewName).eq('user_id', user.id)

    return Response.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return Response.json({ error: message }, { status: 500 })
  }
}
