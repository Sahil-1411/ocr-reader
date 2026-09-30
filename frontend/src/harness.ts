/**
 * Offline harness: run the real pipeline over the sample receipts and print the
 * result.
 *
 * This exists because driving the app's file input from a test script fights
 * React's synthetic event system for no benefit, and because the interesting
 * question — "what does this actually extract from a real receipt?" — is worth
 * answering in a batch rather than one upload at a time.
 *
 * Dev-only. Vite's production build has a single `index.html` entry, so
 * `harness.html` and this module are never bundled into `dist/`.
 *
 * Open http://localhost:5273/harness.html
 */

import { fileToImageData } from './lib/image-io'
import { OcrClient } from './ocr/client'
import { toPublicJson } from './ocr/receipt/assemble'
import { DEFAULT_OPTIONS, type OcrResult } from './ocr/types'

const SAMPLES = [
  'pack-settlements.jpg',
  'inventory-summary.jpg',
  'weekly-invoice.jpg',
] as const

const statusEl = document.getElementById('status')!
const outEl = document.getElementById('out')!

const status = (text: string) => {
  statusEl.textContent = text
  // Mirrored to the console so an automated driver can read progress without
  // scraping the DOM.
  console.log('[harness]', text)
}

function report(name: string, body: string): void {
  const heading = document.createElement('h2')
  heading.textContent = name
  const pre = document.createElement('pre')
  pre.textContent = body
  outEl.append(heading, pre)
}

/** Compact view: the public JSON plus just enough meta to judge the run. */
function summarise(result: OcrResult) {
  const m = result.processingMeta
  return {
    ...toPublicJson(result),
    validation: result.validation.map((issue) => issue.message),
    processingMeta: {
      reader: m.reader,
      watermarkSuppressed: m.watermarkSuppressed,
      watermarkPixelRatio: Number(m.watermarkPixelRatio.toFixed(4)),
      sourceSize: m.sourceSize,
      words: m.wordCount,
      totalMs: Math.round(m.totalMs),
      timingsMs: Object.fromEntries(
        Object.entries(m.timingsMs).map(([k, v]) => [k, Math.round(v ?? 0)]),
      ),
      warnings: m.warnings,
    },
  }
}

declare global {
  interface Window {
    __harness: {
      done: boolean
      results: Record<string, unknown>
      errors: Record<string, string>
    }
  }
}

window.__harness = { done: false, results: {}, errors: {} }

async function main(): Promise<void> {
  const options = DEFAULT_OPTIONS
  const client = new OcrClient(options, {
    onReady: (provider) => status(`reader ready (${provider})`),
    onFatal: (error) => status(`fatal: ${error.message}`),
  })

  status('loading the English reader…')
  try {
    await client.ready()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    status(`init failed: ${message}`)
    window.__harness.errors._init = message
    window.__harness.done = true
    report('INIT FAILED', message)
    return
  }

  for (const name of SAMPLES) {
    status(`running ${name}…`)
    try {
      const response = await fetch(`/samples/${name}`)
      if (!response.ok) throw new Error(`sample not found (HTTP ${response.status})`)

      const loaded = await fileToImageData(await response.blob(), options.maxInputSize)
      const result = await client.run(loaded.imageData, {
        onProgress: (event) => {
          if (event.status === 'done' || event.status === 'skip') {
            console.log(`[harness] ${name} · ${event.stage} ${event.status}`, event.message ?? '')
          }
        },
      })

      const summary = summarise(result)
      window.__harness.results[name] = summary
      report(name, JSON.stringify(summary, null, 2))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      window.__harness.errors[name] = message
      report(`${name} — FAILED`, message)
      status(`${name} failed: ${message}`)
    }
  }

  window.__harness.done = true
  status('done')
  client.dispose()
}

void main()
