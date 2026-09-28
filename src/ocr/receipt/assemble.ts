/**
 * Pair words into the receipt JSON. No image work lives here, so the page can
 * run this after Tesseract without pulling OpenCV into the main bundle via
 * this module. The OpenCV import stays in the worker.
 */

import {
  chooseReceiptKind,
  fieldsFromWords,
  inventoryRowsFromWords,
  invoiceRowsFromWords,
  settlementRowsFromWords,
  type WordBox,
} from '../layout/rows'
import type { Detection, OcrResult, ProcessingMeta, ReceiptKind, StageName } from '../types'
import { validateInventory, validateInvoice, validateSettlements } from './validate'

/**
 * The pack count the settlements receipt prints below its table.
 *
 * `Packs Total Settled : 25` sits on a line with no pack code, so it never
 * becomes a row and has to be read back off the words. The reader splits it
 * unpredictably around the colon, so the digits are taken from the first
 * number that follows the phrase rather than from a fixed token position.
 */
function statedPackTotal(words: readonly WordBox[]): number | null {
  const ordered = [...words].sort((a, b) => a.y - b.y || a.x - b.x)
  const text = ordered.map((word) => word.text).join(' ')
  const match = /packs?\s*total\s*settled\s*:?\s*(\d{1,4})/i.exec(text)
  if (!match) return null
  const total = Number(match[1])
  return Number.isFinite(total) ? total : null
}

export interface PreparedFacts {
  tiltCorrected: boolean
  perspectiveCorrected: boolean
  watermarkSuppressed: boolean
  rotationAngleDeg: number
  documentQuad: ProcessingMeta['documentQuad']
  sourceSize: ProcessingMeta['sourceSize']
  rectifiedSize: ProcessingMeta['rectifiedSize']
  watermarkPixelRatio: number
  warnings: string[]
  timingsMs: Partial<Record<StageName, number>>
  /* --- which reader produced the words; defaults describe the Tesseract path --- */
  detectorModel?: string
  recognizerModel?: string
  detectorBackend?: ProcessingMeta['detectorBackend']
  executionProvider?: string
}

export function assembleReceipt(
  words: readonly WordBox[],
  facts: PreparedFacts,
  rowOverlapRatio: number,
  totalMs: number,
): OcrResult {
  const rows = inventoryRowsFromWords(words, rowOverlapRatio)
  const settlements = settlementRowsFromWords(words, rowOverlapRatio)
  const invoice = invoiceRowsFromWords(words, rowOverlapRatio)
  const kind = chooseReceiptKind(rows, settlements, invoice)
  const fields = kind === 'invoice' ? invoice : fieldsFromWords(words, rowOverlapRatio)
  const warnings = [...facts.warnings]
  if (words.length === 0) {
    warnings.push('No words were read. The page may be blank after watermark removal.')
  }

  const keptRows = kind === 'inventory' ? rows : []
  const keptSettlements = kind === 'settlements' ? settlements : []

  // Checked against the rows that are actually returned, so an issue's row
  // indices address the same array the caller sees.
  const validation =
    kind === 'inventory'
      ? validateInventory(keptRows)
      : kind === 'settlements'
        ? validateSettlements(keptSettlements, statedPackTotal(words))
        : validateInvoice(fields)
  // Surfaced in both places: `validation` for a UI that can highlight rows, and
  // `warnings` so a caller that only reads the meta still learns about it.
  warnings.push(...validation.map((issue) => issue.message))

  return {
    kind,
    rows: keptRows,
    settlements: keptSettlements,
    fields,
    columns: [],
    rawDetections: wordsToDetections(words),
    validation,
    processingMeta: {
      tiltCorrected: facts.tiltCorrected,
      perspectiveCorrected: facts.perspectiveCorrected,
      watermarkSuppressed: facts.watermarkSuppressed,
      rotationAngleDeg: facts.rotationAngleDeg,
      documentQuad: facts.documentQuad,
      sourceSize: facts.sourceSize,
      rectifiedSize: facts.rectifiedSize,
      watermarkPixelRatio: facts.watermarkPixelRatio,
      detectorModel: facts.detectorModel ?? 'tesseract-eng',
      recognizerModel: facts.recognizerModel ?? 'tesseract-eng',
      detectorBackend: facts.detectorBackend ?? 'tesseract',
      executionProvider: facts.executionProvider ?? 'tesseract',
      timingsMs: facts.timingsMs,
      totalMs,
      warnings,
    },
  }
}

/** The JSON shown in the app: one kind, and only that kind's columns. */
export function toPublicJson(result: OcrResult): { kind: ReceiptKind; rows: object[] } {
  switch (result.kind) {
    case 'inventory':
      return {
        kind: 'inventory',
        rows: result.rows.map(({ game, name, int, rec, act, set }) => ({
          game,
          name,
          int,
          rec,
          act,
          set,
        })),
      }
    case 'settlements':
      return {
        kind: 'settlements',
        rows: result.settlements.map(({ gamePack, name, dateSettled }) => ({
          gamePack,
          name,
          dateSettled,
        })),
      }
    case 'invoice':
      return {
        kind: 'invoice',
        rows: result.fields.map(({ label, value }) => ({ label, value })),
      }
    default: {
      const unreachable: never = result.kind
      return unreachable
    }
  }
}

function wordsToDetections(words: readonly WordBox[]): Detection[] {
  return words.map((word, id) => {
    const x = word.x
    const y = word.y
    return {
      id,
      box: { x, y, width: word.width, height: word.height },
      polygon: [
        { x, y },
        { x: x + word.width, y },
        { x: x + word.width, y: y + word.height },
        { x, y: y + word.height },
      ],
      angle: 0,
      score: word.confidence,
      text: word.text,
      rawText: word.text,
      detScore: word.confidence,
      recScore: word.confidence,
      confidence: word.confidence,
      columnIndex: null,
      rowIndex: null,
    }
  })
}
