/**
 * Minimal projective-transform maths, in plain TypeScript.
 *
 * OpenCV does the real perspective correction inside the pipeline. This module
 * exists for the other direction: the synthetic ticket generator needs to *apply*
 * a known distortion so we can check that the pipeline undoes it. Keeping it
 * dependency-free means the fixtures can be generated in a plain Node test run
 * without booting a WASM runtime.
 */

export type Matrix3x3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
]

export interface Pt {
  x: number
  y: number
}

/**
 * Solve a dense linear system `A·x = b` by Gaussian elimination with partial
 * pivoting. `a` is row-major and is consumed (copied internally).
 */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i]])

  for (let col = 0; col < n; col++) {
    // Partial pivot: the largest magnitude entry keeps the elimination stable.
    let pivot = col
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null // singular
    if (pivot !== col) {
      const tmp = m[pivot]
      m[pivot] = m[col]
      m[col] = tmp
    }

    const d = m[col][col]
    for (let c = col; c <= n; c++) m[col][c] /= d

    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = m[r][col]
      if (f === 0) continue
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c]
    }
  }

  return m.map((row) => row[n])
}

/**
 * Compute the homography mapping four source points onto four destination
 * points, using the standard DLT formulation with `h22` fixed to 1.
 *
 * Each correspondence contributes two rows:
 *
 *     x' = (h00·x + h01·y + h02) / (h20·x + h21·y + 1)
 *     y' = (h10·x + h11·y + h12) / (h20·x + h21·y + 1)
 *
 * cross-multiplied into linear form. Returns `null` when the points are
 * degenerate (three collinear, or a repeated point).
 */
export function homographyFromQuads(
  src: readonly [Pt, Pt, Pt, Pt],
  dst: readonly [Pt, Pt, Pt, Pt],
): Matrix3x3 | null {
  const a: number[][] = []
  const b: number[] = []

  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]
    const { x: u, y: v } = dst[i]
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y])
    b.push(u)
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y])
    b.push(v)
  }

  const h = solve(a, b)
  if (!h) return null
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]
}

/** Apply a homography to a point. Returns `null` if the point maps to infinity. */
export function applyHomography(h: Matrix3x3, p: Pt): Pt | null {
  const w = h[6] * p.x + h[7] * p.y + h[8]
  if (Math.abs(w) < 1e-12) return null
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / w,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / w,
  }
}

/** Invert a 3×3 matrix. Returns `null` when it is singular. */
export function invert3x3(m: Matrix3x3): Matrix3x3 | null {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-12) return null

  const inv = 1 / det
  return [
    A * inv,
    (c * h - b * i) * inv,
    (b * f - c * e) * inv,
    B * inv,
    (a * i - c * g) * inv,
    (c * d - a * f) * inv,
    C * inv,
    (b * g - a * h) * inv,
    (a * e - b * d) * inv,
  ]
}

/**
 * Warp `src` into a `dstWidth × dstHeight` buffer using inverse mapping with
 * bilinear sampling.
 *
 * `h` maps *source* coordinates to *destination* coordinates; the function
 * inverts it internally so every output pixel is filled (forward mapping would
 * leave holes). Pixels whose source falls outside the image are filled with
 * `background`.
 */
export function warpPerspectiveRGBA(
  src: ImageData,
  h: Matrix3x3,
  dstWidth: number,
  dstHeight: number,
  background: readonly [number, number, number, number] = [255, 255, 255, 255],
): ImageData {
  const hInv = invert3x3(h)
  if (!hInv) throw new Error('warpPerspectiveRGBA: homography is not invertible')

  const out = new ImageData(dstWidth, dstHeight)
  const dst = out.data
  const s = src.data
  const sw = src.width
  const sh = src.height

  for (let y = 0; y < dstHeight; y++) {
    for (let x = 0; x < dstWidth; x++) {
      const di = (y * dstWidth + x) * 4

      // Sample at the pixel centre; using the integer corner biases the result
      // by half a pixel, which shows up as a visible shift at low resolution.
      const px = x + 0.5
      const py = y + 0.5
      const w = hInv[6] * px + hInv[7] * py + hInv[8]
      if (Math.abs(w) < 1e-12) {
        dst[di] = background[0]
        dst[di + 1] = background[1]
        dst[di + 2] = background[2]
        dst[di + 3] = background[3]
        continue
      }
      const sx = (hInv[0] * px + hInv[1] * py + hInv[2]) / w - 0.5
      const sy = (hInv[3] * px + hInv[4] * py + hInv[5]) / w - 0.5

      if (sx < -1 || sy < -1 || sx > sw || sy > sh) {
        dst[di] = background[0]
        dst[di + 1] = background[1]
        dst[di + 2] = background[2]
        dst[di + 3] = background[3]
        continue
      }

      const x0 = Math.floor(sx)
      const y0 = Math.floor(sy)
      const fx = sx - x0
      const fy = sy - y0

      for (let ch = 0; ch < 4; ch++) {
        const p00 = samplePixel(s, sw, sh, x0, y0, ch, background[ch])
        const p10 = samplePixel(s, sw, sh, x0 + 1, y0, ch, background[ch])
        const p01 = samplePixel(s, sw, sh, x0, y0 + 1, ch, background[ch])
        const p11 = samplePixel(s, sw, sh, x0 + 1, y0 + 1, ch, background[ch])
        const top = p00 + (p10 - p00) * fx
        const bottom = p01 + (p11 - p01) * fx
        dst[di + ch] = Math.round(top + (bottom - top) * fy)
      }
    }
  }

  return out
}

function samplePixel(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  x: number,
  y: number,
  channel: number,
  fallback: number,
): number {
  if (x < 0 || y < 0 || x >= w || y >= h) return fallback
  return data[(y * w + x) * 4 + channel]
}
