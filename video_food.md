# Food Showcase Video — Product Requirements

## Overview

An extension of the Image ReTouch pipeline. After a food image has been retouched, users can generate a short cinematic showcase video from the result.

The flow:
1. User uploads original food photo + optional atmosphere reference image
2. AI retouches the food photo (existing pipeline)
3. System analyses the dish and recommends a showcase type
4. User confirms or switches to a different showcase type
5. Kling API generates the video from the retouched image

---

## User Flow

```
Upload food photo + (optional) atmosphere reference
→ AI retouch (existing)
→ Result page: retouched image shown
→ System recommends showcase type with reasoning
→ User selects showcase type (can override recommendation)
→ "Generate Video" button
→ Kling generates video
→ User previews and downloads
```

---

## Showcase Types (User-Visible)

### 1. Hero Push
- **Camera:** Slow cinematic push in toward the dish
- **Motion:** Subtle steam, slight highlight movement
- **Feel:** Universal, most stable, menu-ready
- **Best for:** Any dish, high-end restaurants, menu videos, e-commerce

### 2. Orbit
- **Camera:** Gentle orbit around the dish (very slow — fast = deformation)
- **Motion:** Parallax movement, light shift
- **Feel:** Premium, 360° showcase
- **Best for:** Hero dishes, tasting menus, cover shots

### 3. Atmosphere
- **Camera:** Minimal or no camera movement
- **Motion:** Light flicker, subtle shadow movement, steam
- **Feel:** Moody, brand-level, editorial
- **Best for:** Dark/moody dishes, Michelin-style, brand advertising

### 4. Dynamic
- **Camera:** Slight dolly or static
- **Motion:** Sauce dripping, cheese pull, steam rising, highlight pop
- **Feel:** Appetite-driven, social media energy
- **Best for:** Social content, fast casual, visually active dishes
- **⚠️ Risk:** Highest deformation risk — requires strong protection prompts

---

## Prompt Architecture (All Types)

Every prompt follows this fixed structure, in this order:

```
[1. PROTECT]  preserve dish, no change in plating, maintain food texture
[2. CAMERA]   {type-specific camera motion}
[3. MOTION]   {type-specific subtle effects}
[4. QUALITY]  cinematic lighting, shallow depth of field, premium food commercial
```

### Per-Type Prompt Templates

**Hero Push**
```
preserve dish, no change in plating, maintain food texture,
slow cinematic push in, camera moves toward dish,
subtle steam, slight highlight movement,
cinematic lighting, shallow depth of field, premium food commercial
```

**Orbit**
```
preserve dish, no change in plating, maintain food texture,
very slow gentle orbit around dish, preserve plating throughout,
light shift, subtle parallax,
cinematic lighting, shallow depth of field, premium food commercial
```

**Atmosphere**
```
preserve dish, no change in plating, maintain food texture,
minimal camera movement, near-static,
subtle steam, light flicker, dramatic shadow movement, moody atmosphere,
cinematic lighting, shallow depth of field, premium food commercial
```

**Dynamic**
```
preserve dish, no change in plating, maintain food texture,
realistic physics only, no deformation, no morphing,
subtle sauce movement, gentle steam rising, highlight pop,
cinematic lighting, shallow depth of field, premium food commercial
```

---

## Auto-Recommendation Logic

System analyses the retouched image and recommends a showcase type:

| Dish Characteristic | Recommended Type |
|---------------------|-----------------|
| Dark/moody style (moody_fine_dining) | Atmosphere |
| Liquid elements (sauce, soup, broth) | Dynamic |
| Multi-component / platter / high-end | Orbit |
| Everything else | Hero Push (default) |

Recommendation is shown on the result page with a one-line reason.
User can override by selecting any other type before generating.

---

## Video Generation

**API:** Kling AI (image-to-video)

**Input:** Retouched image (PNG) from existing pipeline

**Settings:**
- Duration: 5 seconds
- Aspect ratio: match input image
- Quality: high

**Output:** MP4 video file, stored in Supabase Storage, linked to the job

---

## UI — Result Page Additions

After retouch is complete, below the existing output:

1. **Showcase Recommendation Card**
   - Shows recommended type + one-line reason
   - Four type buttons (Hero Push / Orbit / Atmosphere / Dynamic)
   - Active type highlighted

2. **"Generate Video" Button**
   - Triggers Kling API call
   - Shows progress (Kling jobs are async — poll for completion)

3. **Video Player**
   - Inline preview once complete
   - Download button (MP4)

---

## Key Constraints

- Protection prompts (`preserve dish, no change in plating`) are mandatory on every type — non-negotiable
- Orbit must always use `very slow` — fast orbit causes deformation
- Dynamic type requires additional deformation guards (`realistic physics only, no deformation, no morphing`)
- Atmosphere reference image (if provided) informs the prompt's lighting/mood description, same as the retouch pipeline
- Video is generated from the **retouched image**, not the original upload
