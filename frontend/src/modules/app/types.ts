import type { RefObject } from 'react'

import type { StageMap } from '../../lib/stage-state'
import type { WordBox } from '../../ocr/layout/rows'
import type { PdfPage } from '../../lib/pdf-to-images'
import type { OcrResult } from '../../ocr/types'
import type { PageRows } from '../../components/ResultView'
import type { ExportPage, PageFailure } from '../../lib/export'

export type Phase = 'idle' | 'booting' | 'running' | 'done' | 'error'

/** One page's reading: as read, as edited, and which rows were edited. */
export interface PageRead {
  result: OcrResult
  readResult: OcrResult
  edited: ReadonlySet<number>
  /**
   * Rows the user has accepted by hand. A row the checks flagged is still
   * flagged in the data; this says someone has since looked at it and it
   * reads as printed.
   */
  validated: ReadonlySet<number>
  /** The words the page was read from, for the viewer's text overlay. */
  words: readonly WordBox[]
}

export const NO_EDITS: ReadonlySet<number> = new Set()
export const NO_WORDS: readonly WordBox[] = []

export function resultTitle(result: OcrResult): string {
  if (result.title) return result.title
  switch (result.kind) {
    case 'inventory':
      return 'Inventory Summary'
    case 'settlements':
      return 'Pack Settlements'
    case 'invoice':
      return 'Invoice Breakdown'
    case 'table':
      return 'Invoice'
    default: {
      const unreachable: never = result.kind
      return unreachable
    }
  }
}

/** The reading session the page layout renders. */
export interface ReceiptSession {
  stages: StageMap
  pages: ReadonlyMap<number, PageRead>
  pageErrors: ReadonlyMap<number, string>
  error: string | null
  hasPreview: boolean
  fileName: string | null
  imageDimensions: { width: number; height: number } | null
  pdfPages: PdfPage[]
  currentPage: number
  isPdfMode: boolean
  pdfProcessingPage: number | null
  previewRef: RefObject<HTMLCanvasElement | null>
  result: OcrResult | null
  edited: ReadonlySet<number>
  /** Rows of the page on screen the user has accepted by hand. */
  validated: ReadonlySet<number>
  /** The words the page on screen was read from, for the text overlay. */
  words: readonly WordBox[]
  busy: boolean
  unread: number[]
  pageError: string | undefined
  /** Pages the export has no rows for, with why, for the skipped log. */
  failures: PageFailure[]
  exportPages: ExportPage[]
  tablePages: PageRows[]
  onFile: (file: File) => Promise<void>
  onEditPage: (pageIndex: number, rowIndex: number, cellIndex: number, value: string) => void
  /** Accept every row of the page on screen that is still waiting on a look. */
  validateAll: () => void
  resetEdits: () => void
  cancel: () => void
  readRemaining: () => void
  clearCurrent: () => void
  switchPdfPage: (pageIndex: number) => void
}
