/**
 * GET /api/gmb/locations?accountName=accounts/123456789
 * Lists GMB locations under an account.
 * Tries the newer Business Information API first, falls back to v4.
 */
import { createClient }             from '@/lib/supabase/server'
import { getValidAccessToken, gmbFetch } from '@/lib/gmb'
import { NextRequest }              from 'next/server'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const accountName = request.nextUrl.searchParams.get('accountName')
  if (!accountName) return Response.json({ error: 'accountName required' }, { status: 400 })

  const accountId = accountName.split('/')[1]

  try {
    const token = await getValidAccessToken(user.id)

    // Try the newer Business Information API first
    const urlsToTry = [
      // New split API (post-2022)
      `https://mybusinessbusinessinformation.googleapis.com/v1/accounts/${accountId}/locations?pageSize=100&readMask=name,title,storefrontAddress`,
      // Legacy v4
      `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations?pageSize=100`,
    ]

    let locations: Array<{ name: string; label: string; address: string }> = []
    let lastError = ''

    for (const url of urlsToTry) {
      try {
        const data = await gmbFetch(token, url) as {
          locations?: Array<{
            name:             string
            title?:           string       // Business Information API field
            locationName?:    string       // v4 field
            storefrontAddress?: { addressLines?: string[]; locality?: string }
            address?:         { addressLines?: string[] }
          }>
        }

        if (data.locations && data.locations.length > 0) {
          locations = data.locations.map(loc => ({
            name:    loc.name,
            label:   loc.title ?? loc.locationName ?? loc.name,
            address: [
              ...(loc.storefrontAddress?.addressLines ?? loc.address?.addressLines ?? []),
              loc.storefrontAddress?.locality ?? '',
            ].filter(Boolean).join(', '),
          }))
          break
        }
        // Empty list is still a success — no need to try next URL
        break
      } catch (e) {
        lastError = `${url} → ${e instanceof Error ? e.message : String(e)}`
      }
    }

    if (locations.length > 0) {
      return Response.json({ locations })
    }

    return Response.json({
      locations: [],
      error: lastError || 'No locations found for this account.',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ locations: [], error: msg })
  }
}
