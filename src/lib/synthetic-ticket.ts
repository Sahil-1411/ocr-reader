/**
 * A synthetic ticket generator, used to verify the pipeline end to end.
 *
 * Without a reference image there is no way to tell a pipeline that works from
 * one that merely runs. This module renders a three-column ticket with known
 * contents, then deliberately damages it the way a phone camera would — a heavy
 * red watermark over the numbers, perspective from holding the camera at an
 * angle, a few degrees of tilt, an uneven lighting gradient, sensor noise and
 * JPEG-ish softening — and hands back both the damaged image *and* the ground
 * truth. Anything the pipeline reports can then be scored automatically.
 *
 * Browser-only: it needs a canvas. The maths it relies on lives in
 * `./homography`, which is plain TypeScript and is unit-tested separately.
 */

import {
  homographyFromQuads,
  warpPerspectiveRGBA,
  type Pt,
} from './homography'

/* -------------------------------------------------------------------------- */
/* Spec                                                                        */
/* -------------------------------------------------------------------------- */

export interface WatermarkSpec {
  enabled: boolean
  /** Text stamped diagonally across the ticket. */
  text: string
  /** CSS colour. Red is the case called out in the brief, but any hue works. */
  color: string
  /** 0–1. Real watermarks sit around 0.25–0.5. */
  alpha: number
  rotationDeg: number
  /** How many times the text is tiled across the page. */
  repeats: number
  /** Draw concentric rings behind the text, like a security seal. */
  rings: boolean
}

export interface DistortionSpec {
  /** In-plane tilt, degrees. Positive rotates counter-clockwise. */
  rotationDeg: number
  /**
   * 0 = flat-on, 1 = extreme keystone. Around 0.12 looks like a normal
   * hand-held photo taken slightly off-axis.
   */
  perspective: number
  /** 0 = flat lighting, 1 = a hard bright-to-dark gradient across the frame. */
  lighting: number
  /** Standard deviation of additive Gaussian noise, in 0–255 units. */
  noise: number
  /** Gaussian blur radius in pixels, applied before distortion. */
  blur: number
  /** Fractional margin of background around the warped ticket. */
  margin: number
  /** Background colour outside the ticket — the surface it is lying on. */
  background: string
}

export interface TicketSpec {
  /** Ground truth, column-major: `columns[0]` is the leftmost column. */
  columns: string[][]
  width: number
  height: number
  fontPx: number
  title: string
  watermark: WatermarkSpec
  distortion: DistortionSpec
  /** Any integer; the same seed always produces the same image. */
  seed: number
}

export interface SyntheticTicket {
  canvas: HTMLCanvasElement
  imageData: ImageData
  /** What the pipeline should recover, in order. */
  groundTruth: string[][]
  /** Where the ticket's corners ended up in the distorted image. */
  quad: [Pt, Pt, Pt, Pt]
  spec: TicketSpec
}

/* -------------------------------------------------------------------------- */
/* Defaults                                                                    */
/* -------------------------------------------------------------------------- */

/** A 3×10 keno-style ticket with numbers 1–80, zero-padded. */
export function defaultColumns(rows = 10): string[][] {
  const columns: string[][] = [[], [], []]
  let n = 1
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < rows; r++) {
      columns[c].push(String(((n - 1) % 80) + 1).padStart(2, '0'))
      n += 7 // spread the values so repeated digits do not dominate
    }
  }
  return columns
}

export const DEFAULT_TICKET_SPEC: TicketSpec = {
  columns: defaultColumns(),
  width: 900,
  height: 1200,
  fontPx: 46,
  title: 'KENO  ·  QUICK PICK',
  watermark: {
    enabled: true,
    text: 'VOID',
    color: '#d81f2a',
    alpha: 0.38,
    rotationDeg: -28,
    repeats: 3,
    rings: true,
  },
  distortion: {
    rotationDeg: 4.5,
    perspective: 0.12,
    lighting: 0.45,
    noise: 4,
    blur: 0.6,
    margin: 0.12,
    background: '#c9c4bb',
  },
  seed: 1,
}

/* -------------------------------------------------------------------------- */
/* Deterministic RNG                                                           */
/* -------------------------------------------------------------------------- */

/** mulberry32 — small, fast, and good enough for image noise. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Box–Muller, so the noise is actually Gaussian rather than uniform. */
function gaussian(next: () => number): number {
  const u = Math.max(next(), Number.EPSILON)
  const v = next()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('synthetic-ticket: 2D canvas context unavailable')
  return ctx
}

/** Draw the clean, undistorted ticket. */
function drawCleanTicket(spec: TicketSpec): HTMLCanvasElement {
  const { width, height, fontPx, columns } = spec
  const canvas = createCanvas(width, height)
  const ctx = context2d(canvas)

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)

  // Outer rule, like a printed ticket border.
  ctx.strokeStyle = '#111111'
  ctx.lineWidth = 3
  ctx.strokeRect(24, 24, width - 48, height - 48)

  ctx.fillStyle = '#111111'
  ctx.textBaseline = 'middle'

  ctx.font = `600 ${Math.round(fontPx * 0.62)}px ui-monospace, "SF Mono", Menlo, monospace`
  ctx.textAlign = 'center'
  ctx.fillText(spec.title, width / 2, 82)

  ctx.beginPath()
  ctx.moveTo(48, 118)
  ctx.lineTo(width - 48, 118)
  ctx.stroke()

  // Numbers. Three evenly spaced columns, monospaced so digit widths are equal.
  ctx.font = `700 ${fontPx}px ui-monospace, "SF Mono", Menlo, monospace`
  const columnCount = columns.length
  const usableTop = 175
  const usableBottom = height - 90
  const columnWidth = (width - 96) / columnCount

  for (let c = 0; c < columnCount; c++) {
    const cx = 48 + columnWidth * (c + 0.5)
    const rows = columns[c]
    const step = rows.length > 1 ? (usableBottom - usableTop) / (rows.length - 1) : 0
    for (let r = 0; r < rows.length; r++) {
      ctx.fillText(rows[r], cx, usableTop + step * r)
    }
  }

  // Footer, so the detector has some non-numeric text to reject.
  ctx.font = `400 ${Math.round(fontPx * 0.4)}px ui-monospace, Menlo, monospace`
  ctx.fillText('NOT A VALID RECEIPT — SAMPLE', width / 2, height - 48)

  if (spec.watermark.enabled) drawWatermark(ctx, spec)

  return canvas
}

/** Stamp the coloured watermark on top of the printed numbers. */
function drawWatermark(ctx: CanvasRenderingContext2D, spec: TicketSpec): void {
  const { width, height } = spec
  const wm = spec.watermark

  ctx.save()
  ctx.globalAlpha = wm.alpha
  ctx.fillStyle = wm.color
  ctx.strokeStyle = wm.color

  if (wm.rings) {
    const cx = width / 2
    const cy = height / 2
    ctx.lineWidth = 10
    for (let i = 0; i < 4; i++) {
      ctx.beginPath()
      ctx.arc(cx, cy, Math.min(width, height) * (0.18 + i * 0.075), 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  ctx.translate(width / 2, height / 2)
  ctx.rotate((wm.rotationDeg * Math.PI) / 180)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `900 ${Math.round(width * 0.24)}px ui-sans-serif, system-ui, sans-serif`

  const span = height * 0.9
  const step = wm.repeats > 1 ? span / (wm.repeats - 1) : 0
  const start = wm.repeats > 1 ? -span / 2 : 0
  for (let i = 0; i < wm.repeats; i++) {
    ctx.fillText(wm.text, 0, start + step * i)
  }

  ctx.restore()
}

/* -------------------------------------------------------------------------- */
/* Distortion                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build the destination quad: a keystone from `perspective`, then an in-plane
 * rotation from `rotationDeg`, positioned inside a margin.
 */
function buildTargetQuad(
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
  distortion: DistortionSpec,
  next: () => number,
): [Pt, Pt, Pt, Pt] {
  const k = distortion.perspective
  // Shrink the top edge and nudge one side — a camera held above and to the left.
  const topInset = srcW * k * (0.5 + 0.5 * next())
  const sideSkew = srcH * k * 0.35 * (next() - 0.5) * 2

  let quad: Pt[] = [
    { x: topInset, y: 0 },
    { x: srcW - topInset * 0.55, y: sideSkew * 0.4 },
    { x: srcW, y: srcH },
    { x: 0, y: srcH - sideSkew * 0.3 },
  ]

  // Normalise into a unit box, rotate about the centre, then fit to the output.
  const xs = quad.map((p) => p.x)
  const ys = quad.map((p) => p.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const spanX = Math.max(...xs) - minX || 1
  const spanY = Math.max(...ys) - minY || 1

  const theta = (-distortion.rotationDeg * Math.PI) / 180
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)

  quad = quad.map((p) => {
    const nx = (p.x - minX) / spanX - 0.5
    const ny = (p.y - minY) / spanY - 0.5
    return { x: nx * cos - ny * sin, y: nx * sin + ny * cos }
  })

  // Scale to fill the output minus the margin, preserving aspect.
  const rx = Math.max(...quad.map((p) => Math.abs(p.x)))
  const ry = Math.max(...quad.map((p) => Math.abs(p.y)))
  const usable = 1 - distortion.margin * 2
  const scale = Math.min((outW * usable) / (rx * 2), (outH * usable) / (ry * 2))

  return quad.map((p) => ({
    x: p.x * scale + outW / 2,
    y: p.y * scale + outH / 2,
  })) as [Pt, Pt, Pt, Pt]
}

/** Multiply in an uneven lighting gradient and add sensor noise, in place. */
function applyLightingAndNoise(
  image: ImageData,
  distortion: DistortionSpec,
  next: () => number,
): void {
  const { width, height, data } = image
  const strength = distortion.lighting

  // A diagonal gradient plus a soft radial falloff — closer to a real photo
  // than a single linear ramp, and it defeats a global threshold.
  const angle = next() * Math.PI * 2
  const gx = Math.cos(angle)
  const gy = Math.sin(angle)
  const cx = width / 2
  const cy = height / 2
  const maxR = Math.hypot(cx, cy) || 1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4

      const u = (x / width - 0.5) * gx + (y / height - 0.5) * gy
      const r = Math.hypot(x - cx, y - cy) / maxR
      // 1.0 at the bright side, down to ~1-strength at the dark corner.
      const gain = 1 - strength * (0.55 * (0.5 - u) + 0.45 * r * r)

      for (let ch = 0; ch < 3; ch++) {
        let v = data[i + ch] * gain
        if (distortion.noise > 0) v += gaussian(next) * distortion.noise
        data[i + ch] = v < 0 ? 0 : v > 255 ? 255 : v
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Render a distorted synthetic ticket together with its ground truth.
 *
 * The returned `groundTruth` is exactly what `OcrResult.columns[i].numbers`
 * should contain if the pipeline is working.
 */
export function renderSyntheticTicket(
  overrides: Partial<TicketSpec> = {},
): SyntheticTicket {
  const spec: TicketSpec = {
    ...DEFAULT_TICKET_SPEC,
    ...overrides,
    watermark: { ...DEFAULT_TICKET_SPEC.watermark, ...overrides.watermark },
    distortion: { ...DEFAULT_TICKET_SPEC.distortion, ...overrides.distortion },
    columns: overrides.columns ?? DEFAULT_TICKET_SPEC.columns,
  }

  const next = rng(spec.seed)
  const clean = drawCleanTicket(spec)

  // Optional softening, applied before the warp so it reads as lens blur rather
  // than a post-process artefact.
  let source = clean
  if (spec.distortion.blur > 0) {
    source = createCanvas(clean.width, clean.height)
    const bctx = context2d(source)
    bctx.filter = `blur(${spec.distortion.blur}px)`
    bctx.drawImage(clean, 0, 0)
    bctx.filter = 'none'
  }

  const outW = Math.round(spec.width * (1 + spec.distortion.margin * 2))
  const outH = Math.round(spec.height * (1 + spec.distortion.margin * 2))

  const srcQuad: [Pt, Pt, Pt, Pt] = [
    { x: 0, y: 0 },
    { x: clean.width, y: 0 },
    { x: clean.width, y: clean.height },
    { x: 0, y: clean.height },
  ]
  const dstQuad = buildTargetQuad(
    clean.width,
    clean.height,
    outW,
    outH,
    spec.distortion,
    next,
  )

  const h = homographyFromQuads(srcQuad, dstQuad)
  if (!h) throw new Error('synthetic-ticket: degenerate distortion quad')

  const srcData = context2d(source).getImageData(0, 0, source.width, source.height)

  const bg = parseColor(spec.distortion.background)
  const warped = warpPerspectiveRGBA(srcData, h, outW, outH, bg)
  applyLightingAndNoise(warped, spec.distortion, next)

  const canvas = createCanvas(outW, outH)
  context2d(canvas).putImageData(warped, 0, 0)

  return {
    canvas,
    imageData: warped,
    groundTruth: spec.columns.map((c) => [...c]),
    quad: dstQuad,
    spec,
  }
}

/** Resolve a CSS colour string to RGBA bytes via a 1×1 scratch canvas. */
function parseColor(css: string): [number, number, number, number] {
  const canvas = createCanvas(1, 1)
  const ctx = context2d(canvas)
  ctx.fillStyle = css
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  return [r, g, b, a]
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                     */
/* -------------------------------------------------------------------------- */

export interface TicketScore {
  /** Fraction of ground-truth numbers recovered in the right column and order. */
  accuracy: number
  /** Numbers present in the truth but missing from the output. */
  missing: string[]
  /** Numbers the pipeline produced that are not in the truth. */
  spurious: string[]
  /** Per-column exact-match flags. */
  columnExact: boolean[]
  /** True when every column matched exactly, including order. */
  perfect: boolean
}

/**
 * Score a pipeline result against the ground truth.
 *
 * Uses per-column edit distance rather than set comparison, because getting the
 * *order* right is part of the requirement — a column that returns the correct
 * numbers shuffled is still a failure.
 */
export function scoreAgainstTruth(
  actual: readonly (readonly string[])[],
  truth: readonly (readonly string[])[],
): TicketScore {
  const columnExact: boolean[] = []
  let matched = 0
  let total = 0
  const missing: string[] = []
  const spurious: string[] = []

  const columnCount = Math.max(actual.length, truth.length)
  for (let c = 0; c < columnCount; c++) {
    const got = actual[c] ?? []
    const want = truth[c] ?? []
    total += want.length

    columnExact.push(
      got.length === want.length && got.every((v, i) => v === want[i]),
    )

    // Longest common subsequence keeps order-sensitivity while tolerating a
    // single dropped or inserted row without cascading a mismatch.
    const lcs = longestCommonSubsequence(got, want)
    matched += lcs

    const wantCounts = tally(want)
    for (const v of got) {
      const n = wantCounts.get(v) ?? 0
      if (n > 0) wantCounts.set(v, n - 1)
      else spurious.push(v)
    }
    for (const [v, n] of wantCounts) for (let i = 0; i < n; i++) missing.push(v)
  }

  return {
    accuracy: total === 0 ? (actual.flat().length === 0 ? 1 : 0) : matched / total,
    missing,
    spurious,
    columnExact,
    perfect: columnExact.every(Boolean) && columnExact.length > 0,
  }
}

function tally(values: readonly string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1)
  return m
}

function longestCommonSubsequence(
  a: readonly string[],
  b: readonly string[],
): number {
  if (a.length === 0 || b.length === 0) return 0
  let prev = new Uint32Array(b.length + 1)
  let cur = new Uint32Array(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    const swap = prev
    prev = cur
    cur = swap
    cur.fill(0)
  }
  return prev[b.length]
}
