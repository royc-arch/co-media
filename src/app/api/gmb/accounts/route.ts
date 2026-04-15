/**
 * GET /api/gmb/accounts
 * Tries multiple Google APIs to return the user's GBP account(s).
 */
import { createClient }             from '@/lib/supabase/server'
import { getValidAccessToken, gmbFetch } from '@/lib/gmb'

interface AccountLike {
  name:        string
  accountName?: string
  title?:       string
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const token = await getValidAccessToken(user.id)

    const endpointsToTry = [
      // Official Account Management API (post-2022)
      'https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20',
      // Legacy v4 (sometimes works)
      'https://mybusiness.googleapis.com/v4/accounts?pageSize=20',
    ]

    const errors: string[] = []

    for (const url of endpointsToTry) {
      try {
        const res = await gmbFetch(token, url) as { accounts?: AccountLike[] }
        const accounts = (res.accounts ?? []).map(a => ({
          accountName:  a.name,
          accountLabel: a.accountName ?? a.title ?? a.name,
          accountId:    a.name.split('/')[1],
        }))
        if (accounts.length > 0) {
          return Response.json({ accounts })
        }
        // empty list — continue to next endpoint
      } catch (e) {
        errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    return Response.json({
      accounts: [],
      error: `Could not list accounts. Errors: ${errors.join(' | ')}`,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    if (message.includes('No GMB connection')) {
      return Response.json({ error: 'not_connected' }, { status: 404 })
    }
    return Response.json({ error: message }, { status: 500 })
  }
}
