/**
 * GET /api/gmb/discover
 * Tries every known API combination to return the user's GBP locations.
 * Designed to work even when v4/accounts returns 404.
 */
import { createClient }             from '@/lib/supabase/server'
import { createAdminClient }        from '@/lib/supabase/admin'
import { getValidAccessToken, gmbFetch } from '@/lib/gmb'

interface LocResult {
  locationName: string    // full resource path
  displayName:  string
  address:      string
  accountName:  string
}

async function tryUrl(token: string, url: string): Promise<unknown | null> {
  try {
    return await gmbFetch(token, url)
  } catch {
    return null
  }
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const errors: string[] = []

  try {
    const token = await getValidAccessToken(user.id)
    const locations: LocResult[] = []

    // ── Step 1: Discover account IDs ─────────────────────────────────────────
    const accountIds: string[] = []

    // Try Account Management API (official post-2022)
    const amRes = await tryUrl(token, 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20') as { accounts?: Array<{ name: string }> } | null
    if (amRes?.accounts?.length) {
      amRes.accounts.forEach(a => accountIds.push(a.name.split('/')[1]))
    } else {
      errors.push('accountmanagement/v1/accounts: no result')
    }

    // Try legacy v4 accounts
    const v4Res = await tryUrl(token, 'https://mybusiness.googleapis.com/v4/accounts?pageSize=20') as { accounts?: Array<{ name: string }> } | null
    if (v4Res?.accounts?.length) {
      v4Res.accounts.forEach(a => {
        const id = a.name.split('/')[1]
        if (!accountIds.includes(id)) accountIds.push(id)
      })
    } else {
      errors.push('mybusiness/v4/accounts: no result')
    }

    // Also check stored account from previous settings
    const admin = createAdminClient()
    const { data: settings } = await admin
      .from('gmb_settings')
      .select('account_name')
      .eq('user_id', user.id)
      .limit(10)

    if (settings?.length) {
      settings.forEach(s => {
        if (s.account_name) {
          const id = s.account_name.split('/')[1]
          if (id && !accountIds.includes(id)) accountIds.push(id)
        }
      })
    }

    // ── Step 2: List locations under each account ─────────────────────────────
    for (const accountId of accountIds) {
      // Business Information API (new, post-2022)
      const biRes = await tryUrl(
        token,
        `https://mybusinessbusinessinformation.googleapis.com/v1/accounts/${accountId}/locations?pageSize=100&readMask=name,title,storefrontAddress`
      ) as { locations?: Array<{ name: string; title?: string; storefrontAddress?: { addressLines?: string[]; locality?: string } }> } | null

      if (biRes?.locations?.length) {
        biRes.locations.forEach(loc => {
          // BI API returns "locations/{id}" — reconstruct full path with accountId
          const locId = loc.name.startsWith('locations/')
            ? loc.name.split('/')[1]
            : loc.name.split('/').pop() ?? loc.name
          const fullLocationName = `accounts/${accountId}/locations/${locId}`
          locations.push({
            locationName: fullLocationName,
            displayName:  loc.title ?? loc.name,
            address: [
              ...(loc.storefrontAddress?.addressLines ?? []),
              loc.storefrontAddress?.locality ?? '',
            ].filter(Boolean).join(', '),
            accountName: `accounts/${accountId}`,
          })
        })
        continue
      }

      // Legacy v4 (probably 404, but try anyway)
      const v4LocRes = await tryUrl(
        token,
        `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations?pageSize=100`
      ) as { locations?: Array<{ name: string; locationName?: string }> } | null

      if (v4LocRes?.locations?.length) {
        v4LocRes.locations.forEach(loc => {
          locations.push({
            locationName: loc.name,
            displayName:  loc.locationName ?? loc.name,
            address:      '',
            accountName: `accounts/${accountId}`,
          })
        })
      }
    }

    // ── Step 3: Wildcard attempt (accounts/-/locations) ─────────────────────
    // Always run — catches locations under accounts not returned by Account
    // Management API (e.g. location-group accounts, managed accounts, etc.)
    const seenLocationNames = new Set(locations.map(l => l.locationName))

    // Try v4 wildcard first (most widely supported)
    const v4WildcardRes = await tryUrl(
      token,
      'https://mybusiness.googleapis.com/v4/accounts/-/locations?pageSize=100'
    ) as { locations?: Array<{ name: string; locationName?: string }> } | null

    if (v4WildcardRes?.locations?.length) {
      v4WildcardRes.locations.forEach(loc => {
        if (seenLocationNames.has(loc.name)) return
        seenLocationNames.add(loc.name)
        const parts = loc.name.split('/')
        locations.push({
          locationName: loc.name,
          displayName:  loc.locationName ?? loc.name,
          address:      '',
          accountName:  parts.slice(0, 2).join('/'),
        })
      })
    } else {
      errors.push('v4 wildcard locations: no result')
    }

    // Also try Business Information API wildcard for richer data (address, title)
    const biWildcardRes = await tryUrl(
      token,
      'https://mybusinessbusinessinformation.googleapis.com/v1/accounts/-/locations?pageSize=100&readMask=name,title,storefrontAddress'
    ) as { locations?: Array<{ name: string; title?: string; storefrontAddress?: { addressLines?: string[]; locality?: string } }> } | null

    if (biWildcardRes?.locations?.length) {
      biWildcardRes.locations.forEach(loc => {
        // BI wildcard returns "locations/{id}" without account — skip these
        // since we can't build a valid Reviews API path without the accountId.
        // Locations found in Step 2 already cover the full-path case.
        if (!loc.name.startsWith('accounts/')) return
        if (seenLocationNames.has(loc.name)) return
        seenLocationNames.add(loc.name)
        const parts = loc.name.split('/')
        locations.push({
          locationName: loc.name,
          displayName:  loc.title ?? loc.name,
          address: [
            ...(loc.storefrontAddress?.addressLines ?? []),
            loc.storefrontAddress?.locality ?? '',
          ].filter(Boolean).join(', '),
          accountName: parts.slice(0, 2).join('/'),
        })
      })
    } else {
      errors.push('BI wildcard locations: no result')
    }

    if (!v4WildcardRes?.locations?.length && !biWildcardRes?.locations?.length) {
      errors.push('wildcard locations: no result from any API')
    }

    return Response.json({
      locations,
      accountIds,
      errors,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return Response.json({ error: message, locations: [], accountIds: [], errors }, { status: 500 })
  }
}
