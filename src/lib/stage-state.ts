/**
 * View model for the pipeline's progress stream.
 *
 * Kept out of the component file so that module can export only components —
 * React Fast Refresh silently stops working for a file that mixes the two.
 */

import type { ProgressEvent, StageName, StageStatus } from '../ocr/types'

export interface StageState {
  status: StageStatus
  message?: string
  elapsedMs?: number
}

export type StageMap = Partial<Record<StageName, StageState>>

/** Fold one progress event into the per-stage view model. */
export function reduceProgress(state: StageMap, event: ProgressEvent): StageMap {
  return {
    ...state,
    [event.stage]: {
      status: event.status,
      message: event.message,
      elapsedMs: event.elapsedMs,
    },
  }
}
