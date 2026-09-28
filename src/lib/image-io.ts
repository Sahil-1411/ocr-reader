/**
 * Getting pixels in and out of the browser reliably.
 *
 * Two things here are easy to get wrong and both produce "works on my laptop,
 * fails on every phone" bugs:
 *
 *   1. **EXIF orientation.** Photos from a phone camera are almost always stored
 *      in the sensor's native landscape orientation with an EXIF tag saying how
 *      to rotate them. `<img>` honours that tag; drawing to a canvas historically
 *      did not. A sideways ticket defeats column clustering completely, so we ask
 *      `createImageBitmap` for `imageOrientation: 'from-image'` and fall back to
 *      an `<img>` element, which applies the tag itself.
 *
 *   2. **Input size.** A modern phone shoots 12 MP. Running the whole pipeline at
 *      that resolution is several seconds of pointless work — the detector
 *      downsamples to ~960 px anyway — and on iOS the canvas area limit will
 *      silently hand back a blank bitmap. Everything is capped on the way in.
 */

export interface LoadedImage {
  imageData: ImageData
  /** Size actually used, after the cap. */
  width: number
  height: number
  /** Size before the cap, for reporting. */
  naturalWidth: number
  naturalHeight: number
  /** `width / naturalWidth`. 1 when no downscale was needed. */
  scale: number
}

/** iOS Safari refuses to allocate canvases beyond roughly 16.7 M pixels. */
const MAX_CANVAS_PIXELS = 16_000_000

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function get2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not acquire a 2D canvas context')
  return ctx
}

/** Fit `w × h` inside a `maxSize` square, never scaling up. */
export function fitWithin(
  w: number,
  h: number,
  maxSize: number,
): { width: number; height: number; scale: number } {
  const longest = Math.max(w, h)
  let scale = longest > maxSize ? maxSize / longest : 1

  // Second guard: even within maxSize, keep the total pixel count sane.
  if (w * scale * h * scale > MAX_CANVAS_PIXELS) {
    scale = Math.sqrt(MAX_CANVAS_PIXELS / (w * h))
  }

  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale,
  }
}

/**
 * Decode a user-supplied image file into `ImageData`, honouring EXIF
 * orientation and capping the longest side at `maxSize`.
 */
export async function fileToImageData(
  file: Blob,
  maxSize = 1600,
): Promise<LoadedImage> {
  const source = await decode(file)
  const naturalWidth = source.width
  const naturalHeight = source.height

  const { width, height, scale } = fitWithin(naturalWidth, naturalHeight, maxSize)

  const canvas = makeCanvas(width, height)
  const ctx = get2d(canvas)
  // Let the browser do the resampling — it is box-filtered and far better than
  // a single bilinear step when the downscale factor is large.
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, width, height)

  if ('close' in source && typeof source.close === 'function') source.close()

  return {
    imageData: ctx.getImageData(0, 0, width, height),
    width,
    height,
    naturalWidth,
    naturalHeight,
    scale,
  }
}

type DecodedSource = ImageBitmap | HTMLImageElement

async function decode(file: Blob): Promise<DecodedSource> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      // Older Safari rejects the options bag outright rather than ignoring it.
      try {
        return await createImageBitmap(file)
      } catch {
        /* fall through to the <img> path */
      }
    }
  }
  return decodeViaImageElement(file)
}

function decodeViaImageElement(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not decode that file as an image'))
    }
    img.src = url
  })
}

/** Copy `ImageData`, so a buffer can be transferred without losing the original. */
export function cloneImageData(image: ImageData): ImageData {
  return new ImageData(new Uint8ClampedArray(image.data), image.width, image.height)
}

/** Paint `ImageData` into a canvas element, resizing it to match. */
export function drawImageDataTo(
  canvas: HTMLCanvasElement,
  image: { width: number; height: number; data: Uint8ClampedArray },
): void {
  canvas.width = image.width
  canvas.height = image.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  // Re-wrap rather than assuming we were handed a real ImageData: the worker
  // sends plain transferable buffers, which structured-clone does not revive
  // into ImageData on every engine. `createImageData` also sidesteps the
  // ArrayBuffer/SharedArrayBuffer typing split under cross-origin isolation.
  const target = ctx.createImageData(image.width, image.height)
  target.data.set(image.data)
  ctx.putImageData(target, 0, 0)
}

/** Render `ImageData` to a canvas and return it, for thumbnails and downloads. */
export function imageDataToCanvas(image: ImageData): HTMLCanvasElement {
  const canvas = makeCanvas(image.width, image.height)
  get2d(canvas).putImageData(image, 0, 0)
  return canvas
}
