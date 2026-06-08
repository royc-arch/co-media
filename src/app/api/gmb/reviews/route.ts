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
  name:               string
  reviewer:           { displayName: string }
  starRating:         string
  comment?:           string
  createTime:         string
  reviewReply?:       { comment: string }
  reviewMediaItems?:  { mediaFormat?: string }[]  // present if reviewer uploaded photos
}

const PAGE_SIZE = 30

// ── GET: read from cache ──────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const url          = new URL(request.url)
  const locationName = url.searchParams.get('locationName')
  const reviewName   = url.searchParams.get('reviewName')
  const page         = parseInt(url.searchParams.get('page') ?? '0', 10)
  const limit        = parseInt(url.searchParams.get('limit') ?? String(PAGE_SIZE), 10)

  // ── Single review fetch ───────────────────────────────────────────────────
  if (reviewName) {
    const { data, error } = await supabase
      .from('gmb_reviews')
      .select('*')
      .eq('user_id', user.id)
      .eq('review_name', reviewName)
      .single()

    if (error) return Response.json({ error: error.message }, { status: error.code === 'PGRST116' ? 404 : 500 })

    const review: GmbReview = {
      name:        data.review_name,
      reviewer:    { displayName: data.author ?? 'Anonymous' },
      starRating:  data.rating,
      comment:     data.comment ?? undefined,
      createTime:  data.review_time ?? data.created_at,
      reviewReply: data.replied && data.reply_text ? { comment: data.reply_text } : undefined,
    }
    return Response.json({ review })
  }

  // ── Paginated list ────────────────────────────────────────────────────────
  if (!locationName) return Response.json({ error: 'locationName required' }, { status: 400 })

  const unreplied     = url.searchParams.get('unreplied') === 'true'
  const repliedParam  = url.searchParams.get('replied')   // 'true' | 'false' | null
  const removedParam  = url.searchParams.get('removed') === 'true'
  const starsParam    = url.searchParams.get('stars') ?? null  // e.g. "ONE,TWO,THREE"
  const since         = url.searchParams.get('since') ?? null
  const effectiveLim  = parseInt(url.searchParams.get('limit') ?? String(unreplied ? 200 : PAGE_SIZE), 10)
  const from = page * effectiveLim
  const to   = from + effectiveLim - 1

  let base = supabase
    .from('gmb_reviews')
    .select('*', { count: 'exact' })
    .eq('user_id', user.id)
    .eq('location_name', locationName)
    .order('review_time', { ascending: false })

  if (removedParam) {
    base = base.eq('removed_from_google', true)
  } else {
    base = base.eq('removed_from_google', false)
    if (unreplied || repliedParam === 'false') base = base.eq('replied', false)
    else if (repliedParam === 'true')          base = base.eq('replied', true)
  }

  if (starsParam) {
    const starList = starsParam.split(',').map(s => s.trim()).filter(Boolean)
    if (starList.length > 0 && starList.length < 5) base = base.in('rating', starList)
  }

  const withSince = since ? base.gte('review_time', since) : base

  // Run page query + three DB-level counts in parallel (counts ignore stars/since — they're sidebar totals)
  const [pageResult, repliedRes, unrepliedRes, removedRes] = await Promise.all([
    withSince.range(from, to),
    supabase.from('gmb_reviews')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('location_name', locationName)
      .eq('removed_from_google', false)
      .eq('replied', true),
    supabase.from('gmb_reviews')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('location_name', locationName)
      .eq('removed_from_google', false)
      .eq('replied', false),
    supabase.from('gmb_reviews')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('location_name', locationName)
      .eq('removed_from_google', true),
  ])

  const { data, count, error } = pageResult
  if (error) return Response.json({ error: error.message }, { status: 500 })

  // Map DB rows back to GmbReview shape for the frontend
  const reviews: (GmbReview & { hasPhoto?: boolean })[] = (data ?? []).map(r => ({
    name:        r.review_name,
    reviewer:    { displayName: r.author ?? 'Anonymous' },
    starRating:  r.rating,
    comment:     r.comment ?? undefined,
    createTime:  r.review_time ?? r.created_at,
    reviewReply: r.replied && r.reply_text ? { comment: r.reply_text } : undefined,
    hasPhoto:    r.has_photo ?? false,
  }))

  return Response.json({
    reviews,
    total:          count ?? 0,
    repliedCount:   repliedRes.count   ?? 0,
    unrepliedCount: unrepliedRes.count ?? 0,
    removedCount:   removedRes.count   ?? 0,
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
    // Once a working base URL is found, stick with it — pageTokens are tied to the API version
    let lockedBaseUrl: string | null = null

    do {
      const qs = `pageSize=50${pageToken ? `&pageToken=${pageToken}` : ''}`

      // On page 1, try both endpoints. On subsequent pages, only use the locked one.
      const urlsToTry: string[] = lockedBaseUrl
        ? [`${lockedBaseUrl}?${qs}`]
        : [
            `https://mybusinessreviews.googleapis.com/v1/accounts/${accountId}/locations/${locationId}/reviews?${qs}`,
            `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews?${qs}`,
          ]

      let data: { reviews?: GmbReview[]; nextPageToken?: string } | null = null
      const errors: string[] = []

      for (const url of urlsToTry) {
        try {
          data = await gmbFetch(token, url) as typeof data
          // Lock to this base URL for all subsequent pages
          if (!lockedBaseUrl) lockedBaseUrl = url.split('?')[0]
          break
        } catch (e) {
          errors.push(`${url} → ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      if (!data) throw new Error(`All endpoints failed.\n${errors.join('\n')}`)

      const pageData = data as { reviews?: GmbReview[]; nextPageToken?: string }
      allReviews.push(...(pageData.reviews ?? []))
      pageToken = pageData.nextPageToken
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
            has_photo:     !!(r.reviewMediaItems?.length),
          })),
          { onConflict: 'review_name' }
        )
      }
    }

    // Detect removed reviews: anything in cache that Google no longer returns
    const googleNames = new Set(allReviews.map(r => r.name))
    const { data: cached } = await admin
      .from('gmb_reviews')
      .select('review_name')
      .eq('user_id', user.id)
      .eq('location_name', locationName)
      .eq('removed_from_google', false)

    let removedCount = 0
    if (cached && cached.length > 0) {
      const removedNames = cached
        .map((r: { review_name: string }) => r.review_name)
        .filter((name: string) => !googleNames.has(name))
      if (removedNames.length > 0) {
        await admin.from('gmb_reviews')
          .update({ removed_from_google: true })
          .in('review_name', removedNames)
          .eq('user_id', user.id)
        removedCount = removedNames.length
      }
    }

    return Response.json({ synced: allReviews.length, removedCount })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return Response.json({ error: message }, { status: 500 })
  }
}
