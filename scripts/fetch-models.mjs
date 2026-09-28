/**
 * Download the OCR model weights into `public/models/` for self-hosting.
 *
 * You need this when you turn on cross-origin isolation. Isolation is what lets
 * ONNX Runtime use multiple WASM threads (worth roughly 2–3× on the detector),
 * but `Cross-Origin-Embedder-Policy: require-corp` also blocks every
 * cross-origin subresource that does not opt in — including the CDN the models
 * normally come from. Self-hosting is the way to have both.
 *
 *   node --experimental-strip-types scripts/fetch-models.mjs
 *   node --experimental-strip-types scripts/fetch-models.mjs --bundle ppocr-v6-tiny
 *
 * The URLs come from `src/ocr/models/registry.ts` rather than being duplicated
 * here, so the registry stays the single source of truth. Every download is
 * verified to be a real ONNX protobuf before it is written — a CDN that answers
 * a 404 with a styled HTML page still returns HTTP 200, and ONNX Runtime's
 * failure mode for "this is HTML, not a model" is an opaque WASM abort.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const OUT_DIR = join(ROOT, 'public', 'models')

const registry = await import('../src/ocr/models/registry.ts')

/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const args = { bundle: null, force: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--bundle') args.bundle = argv[++i]
    else if (argv[i] === '--force') args.force = true
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  console.log(`Usage: node --experimental-strip-types scripts/fetch-models.mjs [options]

  --bundle <id>   Which model bundle to fetch. Default: the recommended one.
  --force         Re-download even if the file is already present.
  --help          Show this message.

Available bundles:
${registry.MODEL_BUNDLES.map((b) => `  ${b.id.padEnd(24)} ${b.description ?? ''}`).join('\n')}`)
  process.exit(0)
}

const bundle = args.bundle
  ? registry.bundleById(args.bundle)
  : registry.resolveBundle(registry.DEFAULT_MODEL_BUNDLE)

if (!bundle) {
  console.error(`Unknown bundle "${args.bundle}".`)
  console.error(`Known ids: ${registry.MODEL_BUNDLES.map((b) => b.id).join(', ')}`)
  process.exit(1)
}

/** An ONNX file is a protobuf whose first field is `ir_version`, so it starts 0x08. */
function looksLikeOnnx(buffer) {
  if (buffer.length < 16) return false
  const head = buffer.subarray(0, 24).toString('latin1')
  if (head.startsWith('<')) return false
  if (head.startsWith('version https://git-lfs')) return false
  if (head.trimStart().startsWith('{')) return false
  return buffer[0] === 0x08
}

function humanBytes(n) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} kB`
}

/**
 * Try each mirror in turn. Model hosting is the least reliable part of a
 * client-side ML app: CDNs rate-limit, HuggingFace occasionally serves LFS
 * pointer files, and corporate proxies block specific domains.
 */
async function download(urls, { validateOnnx }) {
  const failures = []
  for (const url of urls) {
    try {
      // HuggingFace `/resolve/` URLs 302 to a presigned CDN host, so redirects
      // must be followed rather than hardcoded.
      const response = await fetch(url, { redirect: 'follow' })
      if (!response.ok) {
        failures.push(`${url} → HTTP ${response.status}`)
        continue
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      if (validateOnnx && !looksLikeOnnx(buffer)) {
        failures.push(`${url} → not an ONNX file (starts ${JSON.stringify(buffer.subarray(0, 24).toString('latin1'))})`)
        continue
      }
      return { buffer, url }
    } catch (error) {
      failures.push(`${url} → ${error.message}`)
    }
  }
  throw new Error(`all sources failed:\n${failures.map((f) => `      · ${f}`).join('\n')}`)
}

/** The local filename the app expects, matching `withSelfHostedModels`. */
function localNameFor(url) {
  const name = new URL(url).pathname.split('/').filter(Boolean).pop() ?? 'model.onnx'
  return name
}

await mkdir(OUT_DIR, { recursive: true })

const jobs = [
  { label: 'detector', urls: bundle.detector.urls, validateOnnx: true, id: bundle.detector.id },
  { label: 'recogniser', urls: bundle.recognizer.urls, validateOnnx: true, id: bundle.recognizer.id },
]

for (const charset of bundle.recognizerPreset.charsets ?? []) {
  jobs.push({ label: 'charset', urls: [charset.url], validateOnnx: false, id: charset.url })
}

console.log(`Fetching "${bundle.id}" into public/models/\n`)

let total = 0
let failed = 0

for (const job of jobs) {
  const name = localNameFor(job.urls[0])
  const target = join(OUT_DIR, name)
  process.stdout.write(`  ${job.label.padEnd(11)} ${name} … `)
  try {
    const { buffer, url } = await download(job.urls, { validateOnnx: job.validateOnnx })
    await writeFile(target, buffer)
    total += buffer.length
    console.log(`${humanBytes(buffer.length)}${url !== job.urls[0] ? '  (mirror)' : ''}`)
  } catch (error) {
    failed++
    console.log('FAILED')
    console.log(`    ${error.message}`)
  }
}

console.log(`\n${humanBytes(total)} written to public/models/`)

if (failed > 0) {
  console.error(`\n${failed} file(s) could not be fetched. The app will fall back to the CDN for those.`)
  process.exit(1)
}

console.log(`
Next steps for a cross-origin-isolated deploy:

  1. Point the app at the local copies:

       import { DEFAULT_MODEL_BUNDLE, withSelfHostedModels } from './ocr/models/registry'
       const bundle = withSelfHostedModels(resolveBundle(DEFAULT_MODEL_BUNDLE))

  2. Run with isolation enabled:

       VITE_CROSS_ORIGIN_ISOLATED=1 pnpm dev

  3. In production, set both headers on your host:

       Cross-Origin-Opener-Policy: same-origin
       Cross-Origin-Embedder-Policy: require-corp

     GitHub Pages cannot set response headers, so isolation is not available there.`)
