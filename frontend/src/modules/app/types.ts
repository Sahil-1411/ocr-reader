import type { RefObject } from 'react'

import type { StageMap } from '../../lib/stage-state'
import type { PdfPage } from '../../lib/pdf-to-images'
import type { OcrResult } from '../../ocr/types'
import type { PageRows } from '../../components/ResultView'
import type { ExportPage } from '../../lib/export'

export type Phase = 'idle' | 'booting' | 'running' | 'done' | 'error'

/** One page's reading: as read, as edited, and which rows were edited. */
export interface PageRead {
  result: OcrResult
  readResult: OcrResult
  edited: ReadonlySet<number>
}

export const NO_EDITS: ReadonlySet<number> = new Set()

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
  busy: boolean
  unread: number[]
  pageError: string | undefined
  exportPages: ExportPage[]
  tablePages: PageRows[]
  onFile: (file: File) => Promise<void>
  onEditPage: (pageIndex: number, rowIndex: number, cellIndex: number, value: string) => void
  resetEdits: () => void
  cancel: () => void
  readRemaining: () => void
  clearCurrent: () => void
  switchPdfPage: (pageIndex: number) => void
}
