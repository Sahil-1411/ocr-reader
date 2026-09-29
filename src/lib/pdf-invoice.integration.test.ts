import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'

import { textItemsToWords, type PdfTextRun } from './pdf-text'
import { assembleReceipt } from '../ocr/receipt/assemble'

const require = createRequire(import.meta.url)
GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs'),
).href

function invoicePdf(): Uint8Array {
  const stream = [
    'BT',
    '/F1 11 Tf',
    '1 0 0 1 36 720 Tm (CASE QTY) Tj',
    '1 0 0 1 110 720 Tm (UNT QTY) Tj',
    '1 0 0 1 190 720 Tm (ITEM PART#) Tj',
    '1 0 0 1 310 720 Tm (UPC) Tj',
    '1 0 0 1 400 720 Tm (DESCRIPTION) Tj',
    '1 0 0 1 520 720 Tm (EXTENDED) Tj',
    '1 0 0 1 40 700 Tm (2) Tj',
    '1 0 0 1 116 700 Tm (24) Tj',
    '1 0 0 1 190 700 Tm (849-1706888) Tj',
    '1 0 0 1 300 700 Tm (012345678905) Tj',
    '1 0 0 1 400 700 Tm (WIDGET NAME) Tj',
    '1 0 0 1 520 700 Tm (48.00) Tj',
    '1 0 0 1 40 680 Tm (1) Tj',
    '1 0 0 1 116 680 Tm (6) Tj',
    '1 0 0 1 190 680 Tm (674-806801) Tj',
    '1 0 0 1 300 680 Tm (098765432109) Tj',
    '1 0 0 1 400 680 Tm (BIG ISLAND) Tj',
    '1 0 0 1 520 680 Tm (19.50) Tj',
    'ET',
  ].join('\n')
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (const object of objects) {
    offsets.push(body.length)
    body += object
  }
  const xref = body.length
  body += 'xref\n0 6\n0000000000 65535 f \n'
  for (let index = 1; index <= 5; index += 1) {
    body += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  }
  body += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return new TextEncoder().encode(body)
}

describe('pdf text layer invoice', () => {
  it('reads positioned invoice cells into the response columns', async () => {
    const pdf = await getDocument({ data: invoicePdf(), disableFontFace: true }).promise
    const page = await pdf.getPage(1)
    const viewport = page.getViewport({ scale: 200 / 72 })
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
    const words = textItemsToWords(runs, viewport.transform)
    const result = assembleReceipt(
      words,
      {
        reader: 'pdf text',
        watermarkSuppressed: false,
        watermarkPixelRatio: 0,
        sourceSize: { width: viewport.width, height: viewport.height },
        timingsMs: {},
      },
      0.5,
    )
    expect(result.kind).toBe('table')
    expect(result.tableRows.map((row) => row.cells)).toEqual([
      ['2', '24', '849-1706888', '012345678905', 'WIDGET NAME', '48.00'],
      ['1', '6', '674-806801', '098765432109', 'BIG ISLAND', '19.50'],
    ])
  })
})
