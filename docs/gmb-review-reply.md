# GMB Review Reply — Feature Docs

## Overview

Allows business owners to connect their Google Business Profile, view all customer reviews, manually reply, and enable AI-powered auto-replies via a cron job.

---

## Current Features

- Google OAuth 2.0 connection (`business.manage` scope)
- Auto-discovery of GMB locations under the connected account
- Manual Profile ID entry as fallback
- Full review list with pagination (all pages, not just 50)
- Manual reply from dashboard
- AI auto-reply via cron (every 30 min on Vercel)
- Per-location settings: auto-reply toggle, reply tone, custom instructions
- Review cache in Supabase (`gmb_reviews` table)

---

## File Structure

```
src/
├── app/
│   ├── gmb/
│   │   ├── page.tsx               # Connect + location list
│   │   ├── setup/page.tsx         # Add location (discover or manual ID)
│   │   └── dashboard/page.tsx     # Reviews + settings UI
│   └── api/
│       ├── gmb/
│       │   ├── connect/route.ts          # Redirect to Google OAuth
│       │   ├── callback/route.ts         # Handle OAuth callback, save tokens
│       │   ├── disconnect/route.ts       # Delete OAuth tokens
│       │   ├── discover/route.ts         # Auto-discover GMB locations
│       │   ├── discover-account/route.ts # Find account ID from token
│       │   ├── reviews/route.ts          # Fetch + cache all reviews (paginated)
│       │   ├── reply/route.ts            # Post a reply to a review
│       │   ├── settings/route.ts         # GET/POST/DELETE location settings
│       │   └── status/route.ts           # Check OAuth + location connection status
│       └── cron/
│           └── gmb-autoreply/route.ts    # Cron job: auto-reply to new reviews
├── lib/
│   └── gmb.ts                     # OAuth client, token refresh, gmbFetch helper
supabase/
└── gmb-schema.sql                 # All three table definitions + RLS policies
```

---

## Database Schema

### `gmb_connections`
Stores OAuth tokens, one row per user.

| Column | Type | Notes |
|---|---|---|
| user_id | uuid | FK → auth.users |
| access_token | text | |
| refresh_token | text | |
| expires_at | timestamptz | Auto-refreshed when expired |

### `gmb_settings`
Per-location configuration.

| Column | Type | Notes |
|---|---|---|
| user_id | uuid | |
| account_name | text | `accounts/{accountId}` |
| location_name | text | `accounts/{accountId}/locations/{locationId}` |
| display_name | text | Business display name |
| auto_reply_enabled | boolean | Default false |
| reply_tone | text | `professional` / `friendly` / `casual` |
| custom_instructions | text | Extra prompt instructions for AI |

### `gmb_reviews`
Review cache + reply tracking.

| Column | Type | Notes |
|---|---|---|
| review_name | text | Full Google resource path (unique) |
| location_name | text | Which location |
| author | text | |
| rating | text | `ONE`–`FIVE` |
| comment | text | |
| replied | boolean | |
| reply_text | text | What was sent |
| review_time | timestamptz | |

---

## API Endpoints

### `GET /api/gmb/reviews?locationName=accounts/{id}/locations/{id}`
Fetches all reviews from Google (paginated), upserts into `gmb_reviews`, returns full list.

### `POST /api/gmb/reply`
Body: `{ reviewName, comment }`  
Posts reply to Google, updates `gmb_reviews.replied` + `reply_text`.

### `GET /api/cron/gmb-autoreply`
Protected by `Authorization: Bearer {CRON_SECRET}`.  
Loops all locations with `auto_reply_enabled = true`, fetches unreplied reviews, generates AI reply via GPT-4o-mini, posts to Google.

---

## Google API Notes

- **Account Management API** (`mybusinessaccountmanagement.googleapis.com/v1`) — discovers account IDs. Requires quota approval.
- **Business Information API** (`mybusinessbusinessinformation.googleapis.com/v1`) — lists locations. Returns `locations/{id}` short names; code prepends `accounts/{id}/` to build full path.
- **Reviews API** — uses `mybusiness.googleapis.com/v4` (old API, enabled in project). New API (`mybusinessreviews.googleapis.com/v1`) requires separate Google approval not yet granted.
- **Location name format required**: `accounts/{accountId}/locations/{locationId}` — all endpoints break if this is not a 4-part path.

---

## Cron Setup (Vercel)

`vercel.json`:
```json
{
  "crons": [{ "path": "/api/cron/gmb-autoreply", "schedule": "*/30 * * * *" }]
}
```
Env var required: `CRON_SECRET` — set in Vercel dashboard.

---

## Env Vars Required

| Var | Where |
|---|---|
| `GOOGLE_CLIENT_ID` | GCP OAuth 2.0 credentials |
| `GOOGLE_CLIENT_SECRET` | GCP OAuth 2.0 credentials |
| `GOOGLE_REDIRECT_URI` | e.g. `https://co-media.vercel.app/api/gmb/callback` |
| `OPENAI_API_KEY` | For AI reply generation |
| `CRON_SECRET` | Any random secret string |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (admin operations) |

---

## Planned Features

> Add new features below before implementing them.

### 1. AI-generated reply preview (before sending)
- On the dashboard, add an "AI Suggest" button next to each unreplied review
- Calls a new endpoint `POST /api/gmb/suggest-reply` with `{ reviewName, tone, customInstructions }`
- Returns a suggested reply that the user can edit before posting
- Does NOT auto-post — user still clicks "Post Reply"

### 2. Filter reviews by status / rating
- Filter tabs: All / Pending / Replied
- Filter by star rating: 1★ / 2★ / 3★ / 4★ / 5★
- Implemented client-side (no new API calls needed)

### 3. Edit existing reply
- Currently replied reviews show the reply text as read-only
- Add an "Edit" button to update the reply text
- Calls `PUT /api/gmb/reply` with updated comment
- Updates `gmb_reviews.reply_text` in Supabase

### 4. Reply tone per-review override
- When composing a manual reply, let user pick a tone for that specific reply
- Overrides the location-level default tone setting

### 5. Bulk auto-reply (manual trigger)
- "Auto-reply all pending" button on dashboard
- Calls a new endpoint `POST /api/gmb/bulk-reply` 
- Same logic as cron job but triggered on-demand for one location
- Shows a progress indicator while running
