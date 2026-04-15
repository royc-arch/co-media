/**
 * POST /api/gmb/discover-by-place
 * Uses the approved v4 API (no Account Management API needed) to look up the
 * real GMB resource name for a Place ID the authenticated user manages.
 *
 * Body: { placeId: string }
 * Returns: { locationName: string } or { error: string }
 */
import { createClient }             from '@/lib/supabase/server'
import { getValidAccessToken, gmbFetch } from '@/lib/gmb'
import { NextRequest }              from 'next/server'

interface GoogleLocation {
  name:     string   // "googleLocations/ChIJxxxx"
  location?: {
    name:         string   // "accounts/123/locations/456" ← what we need
    locationName?: string
  }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { placeId } = await request.json() as { placeId?: string }
  if (!placeId) return Response.json({ error: 'placeId required' }, { status: 400 })

  try {
    const token = await getValidAccessToken(user.id)

    const data = await gmbFetch(
      token,
      'https://mybusiness.googleapis.com/v4/googleLocations:search',
      {
        method: 'POST',
        body: JSON.stringify({
          resultCount: 5,
          location: { placeId },
        }),
      }
    ) as { googleLocations?: GoogleLocation[] }

    const locations = data.googleLocations ?? []

    // Find one where the user actually manages the location (has a resource name)
    const managed = locations.find(gl => !!gl.location?.name)

    if (!managed?.location?.name) {
      // Found on Google but user doesn't manage it — or no results
      const found = locations.length > 0
      return Response.json({
        error: found
          ? 'This business was found on Google but is not linked to your account. Make sure you\'re connected with the Google account that manages this business.'
          : 'No matching business found for this Place ID.',
      }, { status: 404 })
    }

    return Response.json({
      locationName: managed.location.name,   // "accounts/123/locations/456"
      displayName:  managed.location.locationName ?? '',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: msg }, { status: 500 })
  }
}
