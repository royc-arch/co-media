/**
 * GET /api/gmb/discover-account
 * Tries to auto-discover the user's GMB account(s) from their OAuth token.
 * Returns { accounts: [{name, label}] } on success,
 * or      { accounts: [], quotaExceeded: true } when quota is 0.
 */
import { createClient }              from '@/lib/supabase/server'
import { getValidAccessToken, gmbFetch } from '@/lib/gmb'

interface AccountV1 {
  name:        string   // "accounts/123456789"
  accountName: string   // display name
  type:        string
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const token = await getValidAccessToken(user.id)

    // Try Account Management API v1
    let lastError = ''
    try {
      const res = await gmbFetch(
        token,
        'https://mybusinessaccountmanagement.googleapis.com/v1/accounts'
      ) as { accounts?: AccountV1[] }

      const accounts = (res.accounts ?? []).map(a => ({
        name:  a.name,
        label: a.accountName,
      }))
      if (accounts.length > 0) return Response.json({ accounts })
      lastError = 'Account Management API returned 0 accounts'
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }

    // Fallback: try legacy v4 accounts endpoint
    try {
      const res2 = await gmbFetch(
        token,
        'https://mybusiness.googleapis.com/v4/accounts'
      ) as { accounts?: AccountV1[] }

      const accounts = (res2.accounts ?? []).map(a => ({
        name:  a.name,
        label: a.accountName,
      }))
      if (accounts.length > 0) return Response.json({ accounts })
    } catch (e2) {
      const msg2 = e2 instanceof Error ? e2.message : String(e2)
      lastError = `v1: ${lastError} | v4: ${msg2}`
    }

    const quotaExceeded = lastError.includes('429') || lastError.toLowerCase().includes('quota')
    return Response.json({ accounts: [], quotaExceeded, error: lastError }, { status: 200 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ accounts: [], error: msg })
  }
}
