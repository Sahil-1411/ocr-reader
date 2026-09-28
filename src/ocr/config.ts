/**
 * The pipeline's self-configuration.
 *
 * There is no settings UI, so everything that would otherwise be a dial has to
 * be decided from the document instead of by the user. Two choices carry the
 * weight:
 *
 *   · `columnCount: 'auto'` — these documents range from a two-column invoice to
 *     a six-column inventory table, so any fixed count is wrong for most of them.
 *   · `autoFieldType: true` — with nobody to declare a schema, each column's
 *     type is inferred from its own contents. That is what lets a date column be
 *     repaired as dates while the name column beside it is left untouched.
 *
 * The detector and recogniser constants come from the active model bundle rather
 * than from generic defaults: they belong to a specific set of weights, and
 * guessing them looks exactly like a broken model.
 *
 * Shared between the app and the offline harness so both exercise the same
 * configuration — a harness that measures a different setup measures nothing.
 */

import { mergeOptions } from './client'
import {
  applyDetectorPreset,
  applyRecognizerPreset,
  DEFAULT_MODEL_BUNDLE,
  resolveBundle,
} from './models/registry'
import type { ModelBundle, OcrOptions } from './types'

export function buildDefaultOptions(
  bundleInput: ModelBundle = DEFAULT_MODEL_BUNDLE,
  overrides: Partial<OcrOptions> = {},
): OcrOptions {
  const bundle = resolveBundle(bundleInput)
  const base = mergeOptions({
    debug: false,
    cluster: {
      columnCount: 'auto',
      maxColumns: 8,
      allowFewerColumns: true,
      autoFieldType: true,
      rowOverlapRatio: 0.5,
    },
    ...overrides,
  })

  return {
    ...base,
    detector: applyDetectorPreset(bundle.detectorPreset, base.detector),
    recognizer: applyRecognizerPreset(bundle.recognizerPreset, base.recognizer),
  }
}
