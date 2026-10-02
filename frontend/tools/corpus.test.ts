/**
 * Read every document in `tools/corpus/` and compare the result with the last
 * one recorded beside it.
 *
 * The readers here are geometry, not a parser for one vendor's form: a rule
 * that squares a column on one invoice decides a different column on the next.
 * That is not a fault to be designed out — a page of words carries no other
 * evidence — but it does mean a change cannot be judged on the page that
 * prompted it. The only way to know what a change did is to read every page
 * that has ever been read and look at what moved.
 *
 * So this is not a pass/fail gate on correctness. It is a diff. A failure
 * means "this document reads differently than it did", which may be the whole
 * point of the change; the test prints what moved so it can be judged, and
 * `UPDATE_CORPUS=1` records the new reading once it has been.
 *
 *     pnpm --dir frontend exec vitest run tools/corpus.test.ts
 *     UPDATE_CORPUS=1 pnpm --dir frontend exec vitest run tools/corpus.test.ts
 *
 * The documents are invoices with live account numbers and figures on them, so
 * `tools/corpus/` is excluded from the repository exactly as
 * `public/samples/` and `fixtures/ground-truth.json` are. Drop PDFs in, and
 * the snapshots are written next to them. With no corpus the test skips, so a
 * checkout without one still runs green.
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'

import { textItemsToWords, type PdfTextRun } from '../src/lib/pdf-text'
import type { ColumnGuide } from '../src/ocr/layout/columns'
import { assembleReceipt } from '../src/ocr/receipt/assemble'
import type { OcrResult } from '../src/ocr/types'

const require = createRequire(import.meta.url)
GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs'),
).href

const CORPUS = join(import.meta.dirname, 'corpus')
const update = Boolean(process.env.UPDATE_CORPUS)

/** The dpi the app rasterises and reads a PDF's text layer at. */
const DPI = 200

function documents(): string[] {
  if (!existsSync(CORPUS)) return []
  return readdirSync(CORPUS)
    .filter((name) => name.toLowerCase().endsWith('.pdf'))
    .sort()
}

/**
 * Read one PDF the way the app does, including carrying a page's settled
 * column edges to the page after it.
 */
async function read(path: string): Promise<OcrResult[]> {
  const data = new Uint8Array(readFileSync(path))
  const pdf = await getDocument({ data, disableFontFace: true }).promise
  const results: OcrResult[] = []
  let guide: ColumnGuide | null = null
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number)
    const viewport = page.getViewport({ scale: DPI / 72 })
    const text = await page.getTextContent()
    const runs: PdfTextRun[] = []
    for (const item of text.items) {
      if (!('str' in item) || !item.str) continue
      runs.push({
        str: item.str,
        transform: item.transform.map((value: number) => Number(value) || 0),
        width: Number(item.width) || 0,
        height: Number(item.height) || 0,
      })
    }
    const result = assembleReceipt(
      textItemsToWords(runs, viewport.transform),
      {
        reader: 'pdf text',
        watermarkSuppressed: false,
        watermarkPixelRatio: 0,
        sourceSize: { width: viewport.width, height: viewport.height },
        timingsMs: {},
      },
      0.5,
      guide,
    )
    if (result.kind === 'table' && result.columnBounds?.length === result.headers.length) {
      guide = { headers: result.headers, bounds: result.columnBounds }
    }
    results.push(result)
  }
  return results
}

/**
 * The reading as lines of text, one row per line.
 *
 * Text rather than JSON because this file is read by a person deciding whether
 * a change was an improvement, and a row that moved one cell should show as
 * one changed line. Timings, confidences and page sizes are left out: they
 * differ run to run and say nothing about the reading.
 */
function snapshot(pages: readonly OcrResult[]): string {
  const out: string[] = []
  pages.forEach((page, index) => {
    out.push(`# page ${index + 1}  ${page.kind}`)
    if (page.kind !== 'table') {
      out.push(...rowsOfOther(page))
      return
    }
    out.push(`headers  ${page.headers.join(' | ')}`)
    // No row number: one row dropped at the top of a page would renumber
    // every row under it, and the diff would be the whole page rather than
    // the one line that changed.
    for (const row of page.tableRows) {
      out.push(`row  ${row.cells.map((cell) => cell.trim()).join(' | ')}`)
    }
    for (const entry of page.skipped ?? []) out.push(`skip  ${entry.reason}  ${entry.text}`)
  })
  return `${out.join('\n')}\n`
}

/** A page no table reader claimed, in whatever shape its own reader returns. */
function rowsOfOther(page: OcrResult): string[] {
  const rows = (page as { rows?: Array<{ label?: string; amount?: string }> }).rows
  if (!rows) return []
  return rows.map((row) => `      ${row.label ?? ''} | ${row.amount ?? ''}`)
}

/**
 * The lines that moved, as `-` what was read before and `+` what is read now.
 *
 * Written out here rather than left to the test runner because the runner
 * compares two two-hundred-line arrays and prints the first few elements of
 * each, which says nothing. What is worth reading is the handful of rows that
 * changed, and only a diff finds those: a row dropped at the top of a page
 * shifts every row under it, and comparing line by line at the same index
 * would report the whole page.
 */
function drift(before: string, after: string, most = 40): string {
  const was = before.split('\n')
  const now = after.split('\n')
  // Longest common subsequence, over lines. The snapshots are a few hundred
  // lines, so the table costs nothing and the result is the smallest set of
  // changes rather than the first alignment that happens to work.
  const common: number[][] = Array.from({ length: was.length + 1 }, () =>
    new Array<number>(now.length + 1).fill(0),
  )
  for (let a = was.length - 1; a >= 0; a -= 1) {
    for (let b = now.length - 1; b >= 0; b -= 1) {
      common[a]![b] =
        was[a] === now[b]
          ? common[a + 1]![b + 1]! + 1
          : Math.max(common[a + 1]![b]!, common[a]![b + 1]!)
    }
  }
  const out: string[] = []
  let a = 0
  let b = 0
  while (a < was.length && b < now.length) {
    if (was[a] === now[b]) {
      a += 1
      b += 1
    } else if (common[a + 1]![b]! >= common[a]![b + 1]!) {
      out.push(`- ${was[a]}`)
      a += 1
    } else {
      out.push(`+ ${now[b]}`)
      b += 1
    }
  }
  for (; a < was.length; a += 1) out.push(`- ${was[a]}`)
  for (; b < now.length; b += 1) out.push(`+ ${now[b]}`)
  const shown = out.slice(0, most)
  if (out.length > most) shown.push(`… and ${out.length - most} more changed lines`)
  return shown.join('\n')
}

const corpus = documents()

describe.skipIf(corpus.length === 0)('corpus', () => {
  it('has something to read', () => {
    expect(corpus.length).toBeGreaterThan(0)
  })

  for (const name of corpus) {
    it(`reads ${name} as it did before`, async () => {
      const taken = snapshot(await read(join(CORPUS, name)))
      const path = join(CORPUS, `${name}.snap.txt`)
      if (update || !existsSync(path)) {
        mkdirSync(CORPUS, { recursive: true })
        writeFileSync(path, taken)
        return
      }
      const recorded = readFileSync(path, 'utf8')
      if (taken === recorded) return
      // The whole new reading as well as the diff: the diff says what moved,
      // and the file is there to be opened, read in full, and copied over the
      // snapshot by hand if only some of the change was wanted.
      writeFileSync(join(CORPUS, `${name}.actual.txt`), taken)
      expect(
        `${name} reads differently (UPDATE_CORPUS=1 to record it):\n${drift(recorded, taken)}`,
      ).toBe('')
    }, 180_000)
  }
})
