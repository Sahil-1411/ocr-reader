/**
 * Fetching and caching model weights.
 *
 * The detector and recogniser together are a few megabytes. Re-downloading them
 * on every page load would make the app feel broken on a phone, so they go into
 * the Cache Storage API — which, unlike `localStorage`, holds binary data
 * without base64 inflation and has no 5 MB ceiling.
 *
 * Cache Storage is unavailable in a few real situations (Firefox private
 * browsing throws on `caches.open`, and non-secure origins have no `caches` at
 * all), so every path here degrades to a plain `fetch` rather than failing.
 */

import type { ModelSource } from '../types'

const CACHE_NAME = 'ticket-ocr-models-v1'

export interface FetchProgress {
  /** Bytes received so far. */
  loaded: number
  /** Total bytes, or `null` when the server sends no `Content-Length`. */
  total: number | null
  /** Where the bytes came from. */
  source: 'cache' | 'network'
  url: string
}

export interface FetchModelOptions {
  onProgress?: (progress: FetchProgress) => void
  signal?: AbortSignal
  /** Skip the cache entirely. Useful when a cached entry is suspected bad. */
  bypassCache?: boolean
}

async function openCache(): Promise<Cache | null> {
  try {
    if (typeof caches === 'undefined') return null
    return await caches.open(CACHE_NAME)
  } catch {
    return null
  }
}

/**
 * An ONNX file is a protobuf. The first field is `ir_version` (field 1, varint),
 * so a valid file starts with byte `0x08`. HTML error pages start with `<`, and
 * a Git LFS pointer starts with the ASCII `version https://git-lfs`.
 *
 * Checking this matters: a CDN that answers a 404 with a styled HTML page still
 * returns HTTP 200 in some configurations, and ONNX Runtime's failure mode for
 * "this is HTML, not a model" is an opaque WASM abort with no useful message.
 */
export function looksLikeOnnx(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 16) return false
  const head = new Uint8Array(buffer, 0, Math.min(64, buffer.byteLength))

  if (head[0] === 0x3c) return false // '<' — HTML or XML
  const ascii = String.fromCharCode(...head.subarray(0, 24))
  if (ascii.startsWith('version https://git-lfs')) return false
  if (ascii.trimStart().startsWith('{')) return false // JSON error body

  return head[0] === 0x08
}

/** Thrown when a URL resolved but did not contain a usable model. */
export class ModelIntegrityError extends Error {
  readonly url: string
  readonly detail: string

  constructor(url: string, detail: string) {
    super(`Model at ${url} is not a valid ONNX file: ${detail}`)
    this.name = 'ModelIntegrityError'
    this.url = url
    this.detail = detail
  }
}

async function readWithProgress(
  response: Response,
  url: string,
  onProgress?: (p: FetchProgress) => void,
): Promise<ArrayBuffer> {
  const header = response.headers.get('content-length')
  const total = header ? Number.parseInt(header, 10) : null

  if (!response.body || !onProgress) return response.arrayBuffer()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      loaded += value.byteLength
      onProgress({ loaded, total, source: 'network', url })
    }
  }

  const out = new Uint8Array(loaded)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out.buffer
}

/**
 * Fetch one URL, validating that what came back is actually a model.
 *
 * Responses are cached only after they pass validation, so a captive-portal
 * login page can never get pinned in the cache as "the detector model".
 */
async function fetchOne(
  url: string,
  options: FetchModelOptions,
): Promise<ArrayBuffer> {
  const cache = options.bypassCache ? null : await openCache()

  if (cache) {
    try {
      const hit = await cache.match(url)
      if (hit) {
        const buffer = await hit.arrayBuffer()
        if (looksLikeOnnx(buffer)) {
          options.onProgress?.({
            loaded: buffer.byteLength,
            total: buffer.byteLength,
            source: 'cache',
            url,
          })
          return buffer
        }
        await cache.delete(url) // poisoned entry — drop it and refetch
      }
    } catch {
      /* cache read failed; fall through to the network */
    }
  }

  const response = await fetch(url, {
    signal: options.signal,
    // Models are content-addressed by version in their URL, so a long-lived
    // HTTP cache is safe and saves a revalidation round-trip.
    cache: 'default',
    mode: 'cors',
    credentials: 'omit',
  })

  if (!response.ok) {
    throw new ModelIntegrityError(url, `HTTP ${response.status} ${response.statusText}`)
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('text/html')) {
    throw new ModelIntegrityError(url, `server returned ${contentType}`)
  }

  const buffer = await readWithProgress(response.clone(), url, options.onProgress)

  if (!looksLikeOnnx(buffer)) {
    const preview = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(48, buffer.byteLength)))
    throw new ModelIntegrityError(url, `unexpected leading bytes: ${JSON.stringify(preview)}`)
  }

  if (cache) {
    try {
      await cache.put(url, response)
    } catch {
      /* quota exceeded or private mode — the model still works this session */
    }
  }

  return buffer
}

/**
 * Fetch a model, trying each mirror in turn.
 *
 * Model hosting is the least reliable part of a client-side ML app: CDNs rate
 * limit, HuggingFace occasionally serves LFS pointers, and corporate proxies
 * block specific domains. Every source therefore carries a list of URLs and the
 * first one that yields a valid model wins.
 */
export async function fetchModel(
  source: ModelSource,
  options: FetchModelOptions = {},
): Promise<ArrayBuffer> {
  const failures: string[] = []

  for (const url of source.urls) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    try {
      return await fetchOne(url, options)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      failures.push(`${url} — ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  throw new Error(
    `Could not load the ${source.name} model from any of its ${source.urls.length} sources:\n` +
      failures.map((f) => `  · ${f}`).join('\n'),
  )
}

/**
 * Fetch the recogniser's character dictionary.
 *
 * Cached as text rather than through the ONNX path above, since it is tiny and
 * has none of the same failure modes.
 */
export async function fetchCharset(
  url: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const cache = await openCache()

  if (cache) {
    try {
      const hit = await cache.match(url)
      if (hit) {
        const parsed = parseCharset(await hit.text())
        if (parsed.length > 0) return parsed
        await cache.delete(url)
      }
    } catch {
      /* fall through */
    }
  }

  const response = await fetch(url, { signal, mode: 'cors', credentials: 'omit' })
  if (!response.ok) {
    throw new Error(`Could not load the character dictionary (HTTP ${response.status}) from ${url}`)
  }

  const text = await response.clone().text()
  const parsed = parseCharset(text)
  if (parsed.length === 0) {
    throw new Error(`The character dictionary at ${url} was empty or unparseable`)
  }

  if (cache) {
    try {
      await cache.put(url, response)
    } catch {
      /* non-fatal */
    }
  }

  return parsed
}

/**
 * Parse a PaddleOCR-style dictionary: one character per line.
 *
 * Only the trailing newline is stripped — a line containing a single space is a
 * *space character* in the charset, and trimming it would silently shift every
 * subsequent index by one, which shows up as text that is almost-but-not-quite
 * right and is miserable to debug.
 */
export function parseCharset(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

/** Drop every cached model. Exposed for a "something is wrong" reset button. */
export async function clearModelCache(): Promise<void> {
  try {
    if (typeof caches !== 'undefined') await caches.delete(CACHE_NAME)
  } catch {
    /* nothing to do */
  }
}
