/**
 * GET /api/gmb/search-places?q=<query>
 * Searches Google Places API for business listings matching the query.
 * Returns placeId, name, address — no Account Management API needed.
 */
import { createClient } from '@/lib/supabase/server'
import { NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const q = request.nextUrl.searchParams.get('q')?.trim()
  if (!q || q.length < 2) return Response.json({ places: [] })

  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) {
    return Response.json({ error: 'GOOGLE_MAPS_API_KEY not configured' }, { status: 500 })
  }

  const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json')
  url.searchParams.set('query', q)
  url.searchParams.set('type', 'establishment')
  url.searchParams.set('key', apiKey)

  const res = await fetch(url.toString())
  const data = await res.json() as {
    status: string
    results: Array<{
      place_id: string
      name: string
      formatted_address: string
    }>
    error_message?: string
  }

  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    return Response.json(
      { error: data.error_message ?? data.status },
      { status: 500 }
    )
  }

  return Response.json({
    places: (data.results ?? []).slice(0, 8).map(p => ({
      placeId:  p.place_id,
      name:     p.name,
      address:  p.formatted_address,
    })),
  })
}
