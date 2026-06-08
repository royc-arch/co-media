/**
 * POST /api/transform-environment  (multipart/form-data)
 * Fields: image1 (File|url), image2 (File|url), jobId, intensity, upscale?
 *
 * Route A — NON-GENERATIVE colour/tone transfer.
 * Matches the reference photo's colour temperature, tonal palette and contrast
 * onto the source via Reinhard transfer in Lab space, then blends toward the
 * original by `intensity`. Geometry is never touched: architecture, furniture,
 * signage/text and people stay pixel-identical — only colour moves.
 *
 * Pipeline:
 *   1. Upload both images to Supabase Storage
 *   2. Reinhard colour transfer (reference stats → source), blended by intensity
 *   3. Optional Real-ESRGAN HD upscale
 */

import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextRequest }       from 'next/server'
import Replicate             from 'replicate'
import sharp                 from 'sharp'

export const maxDuration = 120

// Kept for backwards compatibility with the page's type import. The
// non-generative pipeline no longer produces a scene analysis.
export type EnvironmentAnalysis = {
  space_type:    string
  primary_mood:  string
  quality_score: number
  editing_plan: {
    lighting:   string[]
    atmosphere: string[]
    color:      string[]
    texture:    string[]
  }
  parameter_directions: Record<string, string>
}

// ── sRGB ⇄ Lab colour conversion (D65) ──────────────────────────────────────────

const Xn = 0.95047, Yn = 1.0, Zn = 1.08883

function srgbToLinear(c: number): number {
  c /= 255
  return c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92
}

function linearToByte(c: number): number {
  const v = c > 0.0031308 ? 1.055 * Math.pow(c, 1 / 2.4) - 0.055 : 12.92 * c
  return Math.max(0, Math.min(255, Math.round(v * 255)))
}

function fLab(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116
}

function fLabInv(t: number): number {
  const t3 = t * t * t
  return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787
}

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const rl = srgbToLinear(r), gl = srgbToLinear(g), bl = srgbToLinear(b)
  const x = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375
  const y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750
  const z = rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041
  const fx = fLab(x / Xn), fy = fLab(y / Yn), fz = fLab(z / Zn)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200
  const x = Xn * fLabInv(fx), y = Yn * fLabInv(fy), z = Zn * fLabInv(fz)
  const rl =  x * 3.2404542 + y * -1.5371385 + z * -0.4985314
  const gl =  x * -0.9692660 + y * 1.8760108 + z * 0.0415560
  const bl =  x * 0.0556434 + y * -0.2040259 + z * 1.0572252
  return [linearToByte(rl), linearToByte(gl), linearToByte(bl)]
}

type LabStats = { mL: number; ma: number; mb: number; sL: number; sa: number; sb: number }

// Per-channel mean/std of an RGB buffer in Lab space.
function labStats(data: Buffer | Uint8Array): LabStats {
  const n = (data.length / 3) | 0
  let sumL = 0, suma = 0, sumb = 0
  const lab = new Float32Array(n * 3)
  for (let p = 0, i = 0; p < n; p++, i += 3) {
    const [L, a, b] = rgbToLab(data[i], data[i + 1], data[i + 2])
    lab[i] = L; lab[i + 1] = a; lab[i + 2] = b
    sumL += L; suma += a; sumb += b
  }
  const mL = sumL / n, ma = suma / n, mb = sumb / n
  let vL = 0, va = 0, vb = 0
  for (let i = 0; i < lab.length; i += 3) {
    vL += (lab[i] - mL) ** 2
    va += (lab[i + 1] - ma) ** 2
    vb += (lab[i + 2] - mb) ** 2
  }
  return {
    mL, ma, mb,
    sL: Math.sqrt(vL / n) || 1,
    sa: Math.sqrt(va / n) || 1,
    sb: Math.sqrt(vb / n) || 1,
  }
}

// Reinhard colour transfer: remap source so its Lab mean/std match the
// reference, then blend toward the original by `t` (0–1). Geometry untouched.
async function colorTransfer(sourceBuf: Buffer, refBuf: Buffer, t: number): Promise<Buffer> {
  const { data: src, info } = await sharp(sourceBuf)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  // Reference downsampled — stats don't need full resolution.
  const { data: ref } = await sharp(refBuf)
    .removeAlpha()
    .resize(320, 320, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true })

  const s = labStats(src)
  const r = labStats(ref)

  const aL = r.sL / s.sL, aA = r.sa / s.sa, aB = r.sb / s.sb
  const out = Buffer.allocUnsafe(src.length)

  for (let i = 0; i < src.length; i += 3) {
    const [L, a, b] = rgbToLab(src[i], src[i + 1], src[i + 2])
    // Full Reinhard target…
    const Lt = (L - s.mL) * aL + r.mL
    const at = (a - s.ma) * aA + r.ma
    const bt = (b - s.mb) * aB + r.mb
    // …blended toward the original by intensity.
    const [or, og, ob] = labToRgb(
      L + (Lt - L) * t,
      a + (at - a) * t,
      b + (bt - b) * t,
    )
    out[i] = or; out[i + 1] = og; out[i + 2] = ob
  }

  return sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } })
    .png()
    .toBuffer()
}

// ─────────────────────────────────────────────────────────────────────────────

function sseEvent(type: string, data: object): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch (${res.status}): ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return new Response('Unauthorized', { status: 401 })

  const formData    = await request.formData()
  const image1File  = formData.get('image1')     as File | null
  const image2File  = formData.get('image2')     as File | null
  const image1UrlIn = formData.get('image1_url') as string | null
  const image2UrlIn = formData.get('image2_url') as string | null
  const jobId       = formData.get('jobId')      as string | null
  const intensity   = Math.min(100, Math.max(10, Number(formData.get('intensity') ?? 80)))
  const upscale     = formData.get('upscale') === '1'

  if ((!image1File && !image1UrlIn) || (!image2File && !image2UrlIn) || !jobId)
    return new Response('Missing required fields', { status: 400 })

  const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN })
  const admin     = createAdminClient()
  const encoder   = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const send = (type: string, data: object) =>
        controller.enqueue(encoder.encode(sseEvent(type, data)))

      try {
        // ── Step 1: Upload ────────────────────────────────────────────
        send('progress', { step: 'uploading', message: 'Uploading images…' })

        const image1Buf = image1File ? Buffer.from(await image1File.arrayBuffer()) : await fetchBuffer(image1UrlIn!)
        const image2Buf = image2File ? Buffer.from(await image2File.arrayBuffer()) : await fetchBuffer(image2UrlIn!)

        const upload = async (buf: Buffer, name: string, type = 'image/jpeg'): Promise<string> => {
          const ext  = type === 'image/png' ? 'png' : 'jpg'
          const path = `${user.id}/${jobId}/${name}.${ext}`
          let { error } = await admin.storage.from('images').upload(path, buf, { contentType: type, upsert: true })
          if (error?.message === 'fetch failed') {
            console.warn('[transform-env] storage upload fetch failed, retrying…', { name })
            await new Promise(r => setTimeout(r, 1000))
            ;({ error } = await admin.storage.from('images').upload(path, buf, { contentType: type, upsert: true }))
          }
          if (error) {
            console.error('[transform-env] storage upload error:', { name, error })
            throw new Error(`Storage upload failed: ${error.message}`)
          }
          return admin.storage.from('images').getPublicUrl(path).data.publicUrl
        }

        const [image1Url, image2Url] = await Promise.all([
          upload(image1Buf, 'original'),
          upload(image2Buf, 'reference'),
        ])

        await admin.from('jobs').upsert({
          id: jobId, user_id: user.id,
          image1_url: image1Url, image2_url: image2Url,
          status: 'processing',
        })

        // ── Step 2: Colour/tone transfer (geometry untouched) ─────────
        send('progress', { step: 'generating', message: 'Matching reference colour & tone…' })

        const outputBuffer = await colorTransfer(image1Buf, image2Buf, intensity / 100)
        const outputUrl    = await upload(outputBuffer, 'output', 'image/png')

        // ── Step 3: Optional HD upscale via Replicate Real-ESRGAN ────
        let hdOutputUrl: string | null = null
        if (upscale) {
          send('progress', { step: 'upscaling', message: 'Enhancing to HD…' })
          try {
            const hdResult = await replicate.run(
              'nightmareai/real-esrgan:42fed1c4974146d4d2414e2be2c5277c7fcf05fcc3a73abf41610695738c1d7b',
              { input: { image: outputUrl, scale: 4, face_enhance: false } }
            )
            const hdUrl = Array.isArray(hdResult) ? String(hdResult[0]) : String(hdResult)
            if (hdUrl) {
              const hdBuf = await fetchBuffer(hdUrl)
              hdOutputUrl = await upload(hdBuf, 'output_hd', 'image/png')
            }
          } catch (err) {
            console.warn('[transform-env] HD upscale failed, skipping:', err)
          }
        }

        await admin.from('jobs').update({ output_url: outputUrl, status: 'done' }).eq('id', jobId)

        send('done', { outputUrl, hdOutputUrl })

      } catch (err) {
        const message = err instanceof Error ? err.message : 'An unexpected error occurred'
        try { await admin.from('jobs').update({ status: 'failed' }).eq('id', jobId) } catch {}
        send('error', { message })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
    },
  })
}
