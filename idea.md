# Image ReTouch — Product Requirements

## Overview

A web application built for **restaurant owners and food photographers**. Users upload two images:
- **Image 1** — their food photo (the shot to transform)
- **Image 2** — a reference food photo (the desired lighting, atmosphere, and style)

The AI analyzes Image 2's lighting setup — key light position, contrast ratio, background treatment, color temperature, and atmosphere — then re-lights Image 1 to match. The output is Image 1 re-lit and re-atmosphered to match the editorial quality of Image 2, while preserving the original food, plating, and composition exactly.

The app is deployed as a standalone Next.js application on Vercel and embedded into a single WordPress page via iframe.

---

## Target Users

Restaurant owners and in-house photographers who:
- Shoot food photos on iPhone or entry-level cameras under available light
- Have a reference photo (competitor, editorial, or past shoot) showing the desired editorial quality
- Cannot afford a professional re-shoot but want to elevate their photos for menus, social media, and marketing

The primary transformation is **lighting and atmosphere** — not color filtering or style effects.

---

## What "Good Output" Means

The successful transformation must:
1. **Preserve** — the food, plating, garnishes, plate shape, composition, and dish identity
2. **Transform** — the lighting setup, background darkness, shadow character, color temperature, contrast ratio, and overall atmosphere

Example of a successful transformation (see `/Original.JPG`, `/Reference.png`, `/Output.png`):
- Original: sushi rolls photographed under flat fluorescent kitchen lighting, bright background, no drama
- Reference: fine dining salmon dish with warm tungsten spotlight from upper-left, near-black background, deep shadows, Michelin editorial feel
- Output: same sushi rolls, but now lit with warm directional spotlight, crushed dark background, defined shadows, editorial fine dining atmosphere — food and composition unchanged

The background can change from bright to near-black. The lighting can change completely. This is **re-lighting**, not color grading.

---

## Core User Flow

1. User visits the WordPress page and sees the embedded app
2. User logs in or signs up via Supabase Auth (email/password or magic link)
3. User uploads Image 1 (their food photo) and Image 2 (lighting/style reference)
4. Both images are uploaded to the server, stored in Supabase Storage (scoped to the authenticated user)
5. GPT-4o Vision analyzes Image 2 → extracts lighting profile (key light position, angle, contrast, shadow character, background treatment, color temperature, atmosphere)
6. GPT-4o Vision analyzes Image 1 → extracts food subject description (dishes, plating, garnishes, composition)
7. `gpt-image-1` applies the lighting profile to Image 1 using an edit prompt built from both analyses
8. Output image is stored in Supabase Storage and linked to the user's account
9. User previews and downloads the result
10. All past results are accessible in a personal history/gallery

---

## AI Pipeline — Lighting Analysis

### Step 5: Reference Lighting Profile (GPT-4o on Image 2)

The GPT-4o prompt must extract a **structured lighting profile**, not a generic aesthetic description. Key fields:

| Field | Description | Example |
|-------|-------------|---------|
| `key_light_position` | Clock position or compass direction | `upper-left`, `10 o'clock` |
| `key_light_angle` | Vertical angle from horizontal | `45°`, `30°` |
| `key_light_character` | Hard/soft, focused/diffused | `soft tungsten spot, slight diffusion` |
| `shadow_direction` | Where shadows fall | `falling right, slightly toward camera` |
| `shadow_depth` | Shadow density | `deep, near-black fill shadows` |
| `contrast_ratio` | Subject vs. shadow brightness | `very high — 8:1 to 12:1` |
| `background_treatment` | How background is handled | `crushed near-black, gradient from dish outward` |
| `color_temperature` | Warmth of the light | `warm tungsten 2800–3200K, amber cast` |
| `ambient_level` | How much fill light | `minimal, almost none` |
| `vignette` | Edge darkening | `strong, graduated from center` |
| `atmosphere` | One-phrase editorial descriptor | `luxury omakase, Michelin editorial` |
| `texture_treatment` | How surface detail is rendered | `enhanced specular highlights on food surface` |

### Step 6: Food Subject Description (GPT-4o on Image 1)

The GPT-4o prompt must extract:
- Exact food items and their positions on the plate
- Plate/vessel shape, material, and color
- Garnishes, sauces, and decorative elements
- Camera angle (overhead, 45°, side-on)
- Any existing light source direction visible in the shot

This description anchors what `gpt-image-1` must preserve exactly.

### Step 7: Edit Prompt Construction

The edit prompt must:
1. **Lead with domain context** — "Professional fine dining food photography relighting"
2. **State the lighting transformation explicitly** — use precise photography terms (key light, fill light, contrast ratio, color temperature)
3. **Anchor the food identity** — list the specific food items to preserve
4. **Allow aggressive atmosphere change** — do NOT constrain to "subtle" or "conservative" adjustments; the background can go from bright to black
5. **Use style anchors** — terms like "Michelin-style", "omakase editorial", "fine dining spotlight" carry strong training signal for `gpt-image-1`

**Example prompt structure (for the successful sushi output):**

```
Professional fine dining food photography relighting.

FOOD TO PRESERVE (do not alter):
Three sushi rolls on a dark rectangular ridged plate: a crab roll on the left,
an avocado roll with purple orchid and tobiko in the center, an unagi roll on
the right. Preserve all garnishes, textures, and plating exactly.

LIGHTING TO APPLY:
Apply warm tungsten restaurant lighting. Soft directional key light from upper
left at 45°. Gentle but defined shadows falling to the right. High contrast
fine dining food photography. Low ambient light. Subtle vignette. Spotlight
effect centered on the dish. Enhanced texture and highlights on food surface.
Natural color rendering with warm amber cast (2800K). Luxury omakase atmosphere.
Dark moody background crushed to near-black. Editorial Michelin-style.
Crisp focus across the entire dish. Ultra-realistic lighting. 8k surface detail.
```

---

## Tech Stack

| Layer | Technology | Reason |
|-------|-----------|--------|
| Frontend + Backend | Next.js (App Router) | Single repo; API routes keep API keys server-side |
| Deployment | Vercel | Easiest Next.js hosting; embeddable via iframe into WordPress |
| WordPress integration | iframe embed | Cleanest way to host a Next.js app inside a WordPress page |
| Auth | Supabase Auth | Email/password or magic link; sessions scoped per user |
| Storage | Supabase Storage | Upload, store, and serve all images per user |
| AI — Analysis | GPT-4o Vision | Extract structured lighting profile and food subject description |
| AI — Generation | `gpt-image-1` (`images.edit`) | Re-light Image 1 using the original as base + lighting prompt |
| Database | Supabase Postgres | Store job history (input images, output image, timestamp) per user |

---

## Data Model

**users** — managed by Supabase Auth (built-in)

**jobs**
| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| user_id | uuid | FK to auth.users |
| image1_url | text | Supabase Storage URL for the original food photo |
| image2_url | text | Supabase Storage URL for the reference/style image |
| output_url | text | Supabase Storage URL for the transformed result |
| status | text | `pending`, `processing`, `done`, `failed` |
| created_at | timestamp | Job creation time |

---

## Key Considerations

- **Re-lighting, not grading:** The transformation is a full lighting replacement, not a Lightroom-style color correction. The edit prompt must allow dramatic changes to background brightness, contrast ratio, and color temperature.
- **Food identity preservation:** The food, plate, garnishes, and composition must survive the transformation unchanged. The edit prompt must explicitly enumerate what to preserve.
- **Lighting vocabulary matters:** GPT-4o analysis and the resulting edit prompt should use professional photography terminology — key light, fill ratio, color temperature in Kelvin, shadow character — because `gpt-image-1` responds to these terms with higher fidelity.
- **WordPress iframe:** Hosted on Vercel domain, embedded with `<iframe />`. Auth cookies work within iframe.
- **Upload flow:** Images are compressed client-side (≤1280px, JPEG 88%), sent as FormData to the Next.js API, and uploaded to Supabase Storage server-side via admin client. No direct client-to-Supabase Storage calls.
- **API keys:** All OpenAI and Supabase service-role calls happen server-side — never exposed to the client.
- **Row Level Security (RLS):** Supabase RLS policies ensure users can only read/write their own jobs and images.

---

## Decisions Made

- [x] Users must log in (Supabase Auth)
- [x] Transformed images are saved to a per-user history/gallery
- [x] Deployed to Vercel, embedded in WordPress via iframe
- [x] This is re-lighting + atmosphere replacement, not color grading
- [x] Food and composition are preserved; lighting and atmosphere are fully replaced
- [x] Images sent as FormData to server — no client-side Supabase Storage uploads
- [x] Client-side image compression (≤1280px) before upload to stay under Vercel's 4.5MB body limit

---

## Prompt Engineering Notes

### What works for gpt-image-1 food relighting

- **Specificity beats generality** — "soft directional key light from upper left at 45°" outperforms "dramatic lighting"
- **Style anchors are powerful** — "Michelin-style", "omakase editorial", "luxury fine dining" encode entire lighting/atmosphere packages
- **Explicit background instruction** — must say "dark moody background crushed to near-black" explicitly; vague instructions like "darker background" produce timid results
- **Surface detail language** — "enhanced texture and highlights on food surface", "8k detail" activates higher texture rendering fidelity
- **List the food** — naming the specific food items (avocado roll, tobiko, orchid garnish) anchors preservation and prevents the model from hallucinating substitutions

### What to avoid

- **Preservation-first framing** — phrases like "95% identical", "subtle adjustment", "conservative grade" suppress the model's willingness to perform the required dramatic lighting change
- **Generic mood words without light direction** — "moody" and "dramatic" alone are insufficient; always pair with a specific light source position
- **Lightroom/Camera Raw analogies** — these prime the model toward tonal adjustment, not re-lighting; avoid for this use case
