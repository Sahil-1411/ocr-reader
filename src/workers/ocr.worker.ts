/**
 * The OCR worker.
 *
 * OpenCV and the per-pixel watermark pass live here so they do not freeze the
 * page. The English reader stays on the main thread: it starts a worker of its
 * own, and this worker cannot start that second one.
 */

/// <reference lib="webworker" />

import { loadOpenCV, checkCapabilities, type CV } from '../ocr/opencv/loader'
import { prepareReceiptPage, ReceiptCancelled } from '../ocr/receipt/pipeline'
import type { OcrOptions, WorkerRequest, WorkerResponse } from '../ocr/types'

const ctx = self as unknown as DedicatedWorkerGlobalScope

interface WorkerState {
  cv: CV
  warnings: string[]
}

let state: WorkerState | null = null
let initPromise: Promise<WorkerState> | null = null

/** Run ids the main thread has asked us to abandon. */
const cancelled = new Set<number>()

function post(message: WorkerResponse, transfer?: Transferable[]): void {
  ctx.postMessage(message, transfer ?? [])
}

async function initialise(): Promise<WorkerState> {
  if (state) return state
  if (initPromise) return initPromise

  initPromise = (async () => {
    const warnings: string[] = []
    const cv = await loadOpenCV()
    const capabilities = checkCapabilities(cv)
    if (!capabilities.ok) {
      throw new Error(
        `This OpenCV.js build is missing functions the pipeline needs: ${capabilities.missingRequired.join(', ')}`,
      )
    }
    if (capabilities.missingOptional.length > 0) {
      warnings.push(
        `OpenCV build lacks optional functions (${capabilities.missingOptional.join(', ')}); ` +
          'the pipeline will use its fallbacks.',
      )
    }

    state = { cv, warnings }
    return state
  })().catch((error: unknown) => {
    initPromise = null
    throw error
  })

  return initPromise
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

ctx.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const message = event.data

  if (message.type === 'cancel') {
    cancelled.add(message.id)
    return
  }

  if (message.type === 'init') {
    // Tell the page the worker is alive before OpenCV finishes compiling.
    // `handleInit` posts `ready` again once OpenCV is actually usable; the
    // client resolves on the first of these, and a run waits on `initPromise`.
    post({ type: 'ready', id: message.id, executionProvider: 'tesseract' })
    void handleInit(message.id)
    return
  }

  if (message.type === 'run') {
    void handleRun(message.id, message.image, message.options)
  }
})

async function handleInit(id: number): Promise<void> {
  try {
    await initialise()
    post({ type: 'ready', id, executionProvider: 'tesseract' })
  } catch (error) {
    post({
      type: 'error',
      id,
      message: errorText(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
  }
}

async function handleRun(
  id: number,
  image: { width: number; height: number; data: ArrayBuffer },
  options: OcrOptions,
): Promise<void> {
  try {
    post({
      type: 'progress',
      id,
      event: { stage: 'init', status: 'start', message: 'loading OpenCV' },
    })
    const ready = state ?? (await initPromise)
    if (!ready) {
      throw new Error('The OCR worker received a run request before it was initialised')
    }
    post({
      type: 'progress',
      id,
      event: { stage: 'init', status: 'done', message: 'OpenCV ready' },
    })

    const pixels = new Uint8ClampedArray(image.data)
    const prepared = await prepareReceiptPage(
      { width: image.width, height: image.height, data: pixels },
      { cv: ready.cv },
      options,
      {
        onProgress: (event) => post({ type: 'progress', id, event }),
        onDebugImage: (debugImage) =>
          post({ type: 'debug', id, image: debugImage }, [debugImage.data.buffer]),
        isCancelled: () => cancelled.has(id),
      },
    )

    if (ready.warnings.length > 0) {
      prepared.warnings.unshift(...ready.warnings)
    }

    if (cancelled.has(id)) {
      cancelled.delete(id)
      return
    }

    const buffer = prepared.image.data.buffer
    const transferable = buffer instanceof ArrayBuffer ? buffer : new Uint8ClampedArray(prepared.image.data).buffer
    post(
      {
        type: 'prepared',
        id,
        page: {
          width: prepared.image.width,
          height: prepared.image.height,
          data: transferable,
          tiltCorrected: prepared.tiltCorrected,
          perspectiveCorrected: prepared.perspectiveCorrected,
          watermarkSuppressed: prepared.watermarkSuppressed,
          rotationAngleDeg: prepared.rotationAngleDeg,
          documentQuad: prepared.documentQuad,
          sourceSize: prepared.sourceSize,
          rectifiedSize: prepared.rectifiedSize,
          watermarkPixelRatio: prepared.watermarkPixelRatio,
          warnings: prepared.warnings,
          timingsMs: prepared.timingsMs,
        },
      },
      [transferable],
    )
  } catch (error) {
    if (error instanceof ReceiptCancelled) {
      cancelled.delete(id)
      return
    }
    post({
      type: 'error',
      id,
      message: errorText(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
  } finally {
    cancelled.delete(id)
  }
}
