/**
 * The CTC text recogniser.
 *
 * This wraps a PaddleOCR-family recognition model (the default bundle is
 * `en_PP-OCRv5_mobile_rec`) behind {@link TextRecognizer}. Four things about
 * these models are counter-intuitive enough that getting any one of them wrong
 * produces confident nonsense rather than an error, so each is handled
 * explicitly below and explained where it happens:
 *
 *   · **The exported graph emits probabilities, not logits.** `rec_ctc_head.py`
 *     applies `F.softmax(..., axis=2)` whenever the module is not training, and
 *     that softmax is baked into the ONNX export. Every "mask the classes you
 *     don't want with -Infinity" recipe on the internet is therefore wrong here:
 *     -Infinity in probability space is not a small probability, and a second
 *     softmax over an already-normalised distribution flattens it so far that
 *     every confidence collapses towards 1/C. We detect the convention at
 *     runtime and renormalise instead of re-softmaxing.
 *
 *   · **The input height is baked into the graph.** The v3/v4/v5 recognisers
 *     declare `[N, 3, 48, W]`; feeding 32 throws inside the WASM runtime with an
 *     unhelpful message. `inputHeight` is therefore read from the session's own
 *     metadata rather than taken from the options, and the pipeline crops to
 *     whatever we report.
 *
 *   · **The padding value is mid-grey, not white and not black.** PaddleOCR
 *     right-pads with `np.zeros` *after* normalising, and because normalisation
 *     is `(p/255 - 0.5) / 0.5`, a normalised zero is pixel 127.5. On this app's
 *     crops — one or two digits in a 320px-wide tensor — roughly 85% of what the
 *     model sees is padding, so the wrong value is not a rounding error: black
 *     padding reads as a solid stroke and the model emits trailing garbage.
 *
 *   · **The digit class indices are only contiguous for the English charsets.**
 *     They are 1..10 for `en_PP-OCRv5` and `en_dict.txt`, but scattered across
 *     26, 93, 25, 94, 632, 631, 933, 29, 27, 1109 for the 6625-class Chinese
 *     charset. Assuming 1..10 there yields fluent, wrong numbers. We only take
 *     the shortcut for head widths we have actually verified, and otherwise
 *     derive the indices from the dictionary.
 */

import type { InferenceSession, Tensor } from 'onnxruntime-web'

import { fetchCharset, fetchModel } from '../models/cache'
import type { BatchNormalization, Crop } from '../opencv/crop'
import type { CV } from '../opencv/loader'
import { using } from '../opencv/scope'
import type { ModelBundle, RecognizedText, RecognizerOptions } from '../types'
import type { TextRecognizer } from './contracts'
import { createSession, float32Tensor, releaseSession, runSingleInput } from './runtime'

/** Used in every error message this module produces, so it is worth naming once. */
const LABEL = 'recogniser'

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `RecResizeImg` normalises with `(pixel / 255 - 0.5) / 0.5`, i.e. it maps the
 * byte range onto [-1, 1]. This is *not* the ImageNet normalisation the detector
 * uses; the two models genuinely disagree and swapping them costs accuracy
 * silently rather than loudly.
 */
const REC_MEAN = [0.5, 0.5, 0.5] as const
const REC_STD = [0.5, 0.5, 0.5] as const

/**
 * `CTCLabelDecode.add_special_char` does `dict_character = ['blank'] + dict`,
 * and `get_ignored_tokens()` returns `[0]`. Blank is therefore index 0 for every
 * PaddleOCR export, including the mirrors that ship a pre-expanded dictionary
 * with a placeholder glyph sitting in slot 0.
 */
const CTC_BLANK_INDEX = 0

/** Placeholder occupying the blank slot; never emitted, so its value is arbitrary. */
const BLANK_TOKEN = '\u0000'

/**
 * Head widths for which we have verified that '0'..'9' occupy ten *contiguous*
 * class indices, mapped to the index of '0'.
 *
 * This table exists purely so that digits-only recognition can skip the
 * dictionary download entirely — a ticket reader that keeps working when the
 * charset host is unreachable is worth more than the handful of bytes saved.
 * Anything not listed here falls through to deriving the indices from the real
 * dictionary, which is the only safe answer for the Chinese charset.
 *
 *   438 — en_PP-OCRv5_mobile_rec: 1 blank + 436 dict entries + 1 space.
 *          Dict entries 0..9 are '0'..'9', so the model indices are 1..10.
 *    97 — en_number_mobile_v2.0_rec with en_dict.txt: 1 + 95 + 1, same layout.
 */
const CONTIGUOUS_DIGIT_HEADS = new Map<number, number>([
  [438, 1],
  [97, 1],
])

/** Below this the crop is too narrow for the model's 8× temporal downsampling. */
const MIN_PAD_WIDTH = 16

/** A timestep's classes must sum to this (±tolerance) for the output to be probabilities. */
const PROBABILITY_SUM_TOLERANCE = 0.05

/* -------------------------------------------------------------------------- */
/* Public entry point                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `ModelBundle` has no slot for digit indices, but the registry may grow one.
 * Reading it structurally means we pick it up automatically if it appears,
 * without editing the shared type contract — and without pretending the field
 * exists today.
 */
type DigitAwareBundle = ModelBundle & { digitIndices?: readonly number[] }

export async function createRecognizer(
  models: ModelBundle,
  options: RecognizerOptions,
): Promise<TextRecognizer> {
  const weights = await fetchModel(models.recognizer)

  // Sessions and tensors both come from `runtime.ts` rather than from a direct
  // ORT import. `InferenceSession.run` validates its feeds with `instanceof
  // Tensor`, and the CPU and WebGPU bundles each carry their own copy of that
  // class, so a tensor built here from a second import of the library would be
  // rejected with an error that reads like corrupt data.
  const session = await createSession(weights, LABEL)

  const inputShape = tensorShapeOf(session.inputMetadata)
  const outputShape = tensorShapeOf(session.outputMetadata)

  // [N, 3, H, W] — H is a hard constant in the graph for every PP-OCR v3/v4/v5
  // recogniser. Trusting the graph over the caller is what stops a stale
  // `inputHeight: 32` in the options from throwing inside the WASM runtime.
  const graphHeight = staticDim(inputShape, 2)
  const inputHeight = graphHeight ?? Math.max(1, Math.round(options.inputHeight))

  // [N, T, C]. C is static in every export we have inspected, which is what lets
  // us pick the digit indices without downloading the dictionary.
  const graphClassCount = staticDim(outputShape, 2)

  // PaddleOCR overrides its own width heuristic with the graph's width whenever
  // the ONNX input pins that dimension (`predict_rec.py`, the `use_onnx` branch).
  const graphWidth = staticDim(inputShape, 3)

  const charsetLoader = createCharsetLoader(models, graphClassCount)

  /**
   * Resolved lazily, because the whole point of the shortcut above is to make
   * the common case (digits only, known head width) need no network at all.
   * Whichever path runs first wins and is then reused for the session's life.
   */
  let vocabulary: Vocabulary | null = null
  const vocabularyFor = async (digitsOnly: boolean): Promise<Vocabulary> => {
    // A complete charset answers either kind of request; a synthetic
    // digits-only one can only answer a digits-only request.
    if (vocabulary && (vocabulary.complete || digitsOnly)) return vocabulary

    const next = await resolveVocabulary(
      models as DigitAwareBundle,
      digitsOnly,
      graphClassCount,
      charsetLoader,
    )
    // Keep the more capable of the two, so switching `digitsOnly` off and on
    // again does not re-fetch the dictionary.
    if (!vocabulary || next.complete) vocabulary = next
    return next
  }

  /**
   * Whether the head emits probabilities or logits. PP-OCR exports emit
   * probabilities, but a re-export with the softmax stripped is a real
   * possibility, and the two demand opposite masking strategies — so we measure
   * it on the first real output instead of assuming.
   */
  let outputsProbabilities: boolean | null = null

  const normalization: BatchNormalization = {
    mean: REC_MEAN,
    std: REC_STD,
    channels: 3,
    // Declarative only — this module packs its own tensor (see `packCrops`),
    // but these must describe what it actually does so a caller inspecting the
    // recogniser is not misled.
    channelOrder: 'bgr',
    padValue: 0,
  }

  let released = false

  return {
    name: models.recognizer.name,
    normalization,
    inputHeight,

    async recognize(
      cv: CV,
      crops: readonly Crop[],
      callOptions: RecognizerOptions,
    ): Promise<RecognizedText[]> {
      // Index-aligned by construction: every crop gets a slot up front and a
      // failure only ever overwrites that slot with an empty reading.
      const results: RecognizedText[] = crops.map(() => emptyReading())
      if (crops.length === 0) return results

      const digitsOnly = callOptions.digitsOnly
      const vocab = await vocabularyFor(digitsOnly)

      const padWidth =
        graphWidth ??
        Math.max(MIN_PAD_WIDTH, Math.round(callOptions.maxInputWidth) || MIN_PAD_WIDTH)

      // Batching is honoured because it costs nothing here — every crop is
      // padded to the same width, so N of them stack into one tensor with an
      // extra loop index. It is not expected to help: measured throughput on the
      // WASM backend is flat at ~47 ms/crop from batch 1 to batch 8, because the
      // kernels are already saturating a single core.
      const batchSize = Math.max(1, Math.floor(callOptions.batchSize) || 1)

      // A swallowed batch failure is otherwise completely invisible: the slots
      // keep their empty readings, the pipeline records them as `empty-text`,
      // and nothing anywhere says why. `runtime.ts` calls this out by name on
      // `runSingleInput` — a two-input export, an out-of-memory `RangeError` on
      // mobile Safari, or a malformed crop would all surface as "0 of 60 boxes
      // read as numbers" with no trace at all. So every failure is logged.
      //
      // Logged, but never thrown. `pipeline.ts` wraps this call in
      // `try { … } finally { recognizerScope.release() }` with **no catch**, so
      // anything that escapes here unwinds all the way out of `runPipeline` and
      // the caller loses the entire `OcrResult` — the detector's box geometry in
      // `rawDetections`, every `processingMeta` flag, every accumulated warning.
      // That is the wrong trade for a transient fault, and the arithmetic makes
      // it worse than it looks: `batchSize` defaults to 8, so a ticket with
      // eight or fewer crops is a *single* batch, and "every batch failed" is
      // then just "one allocation failed". Only a `RecognizerConfigurationError`
      // — a mismatch that would otherwise emit confidently shifted digits — is
      // worth destroying the run for.
      let batches = 0
      let failures = 0
      let firstFailure: unknown = null

      for (let start = 0; start < crops.length; start += batchSize) {
        const chunk = crops.slice(start, start + batchSize)
        batches++

        try {
          const data = packCrops(cv, chunk, inputHeight, padWidth)
          const input = float32Tensor(data, [chunk.length, 3, inputHeight, padWidth])
          const head = await runSingleInput(session, input, LABEL)

          const [batch, timesteps, classCount] = readHeadDims(head)
          const scores = head.data as Float32Array

          if (vocab.charset.length !== classCount) {
            // Refusing here is the whole point of carrying the charset around:
            // a mismatch means every index we are about to look up is shifted,
            // which produces plausible-looking wrong digits rather than an error.
            throw new RecognizerConfigurationError(
              `Charset/model mismatch: the model emits ${classCount} classes but the ` +
                `charset has ${vocab.charset.length} entries. Decoding would silently ` +
                'shift every character. Check ModelBundle.charsetUrl and prependBlank.',
            )
          }

          outputsProbabilities ??= looksLikeProbabilities(scores, timesteps, classCount)

          const allowed = digitsOnly ? vocab.allowedForDigits : null
          if (digitsOnly && !allowed) {
            throw new RecognizerConfigurationError(
              'Digit-restricted decoding was requested but the digit class indices ' +
                'could not be resolved from the model or its dictionary.',
            )
          }

          for (let n = 0; n < Math.min(batch, chunk.length); n++) {
            results[start + n] = decodeSequence(
              scores,
              n * timesteps * classCount,
              timesteps,
              classCount,
              vocab.charset,
              allowed,
              outputsProbabilities,
            )
          }
        } catch (error) {
          // One bad batch must not lose the rest of the ticket. The slots for
          // this chunk keep their empty readings, and the pipeline records them
          // as `empty-text` detections rather than dropping the boxes.
          if (error instanceof RecognizerConfigurationError) throw error

          failures++
          if (firstFailure === null) firstFailure = error
          console.warn(
            `The ${LABEL} failed on crops ${start}…${start + chunk.length - 1} of ` +
              `${crops.length}; they will read back empty. ${describeError(error)}`,
          )
        }
      }

      // A single-batch call has already logged everything there is to say, so the
      // summary is only worth the console line when several batches ran and the
      // per-batch warnings may be scattered among them. Either way `results`
      // stays fully index-aligned with `crops`: every slot that was not decoded
      // holds the empty reading it was seeded with, which is what
      // `TextRecognizer.recognize` promises and what `pipeline.ts` turns into
      // `empty-text` detections that keep their box geometry.
      if (failures > 0 && batches > 1) {
        console.warn(
          `The ${LABEL} failed on ${failures} of ${batches} batches ` +
            `(${crops.length} crops); those crops read back empty. ` +
            `First failure: ${describeError(firstFailure)}`,
        )
      }

      return results
    },

    dispose(): void {
      if (released) return
      released = true
      // Releasing is async but the contract is synchronous. `releaseSession`
      // never rejects, so there is nothing to handle here.
      void releaseSession(session, LABEL)
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

interface Vocabulary {
  /** Index → character. Length must equal the model's class count. */
  charset: string[]
  /** Model class indices of '0'..'9' in that order, or `null` if unknown. */
  digitIndices: number[] | null
  /** Blank + digits, the set the digit-restricted decode is allowed to emit. */
  allowedForDigits: Int32Array | null
  /** True when `charset` holds the real dictionary rather than digits-only stubs. */
  complete: boolean
}

type CharsetLoader = () => Promise<string[]>

/**
 * Memoised charset fetch. The dictionary is a few kilobytes and Cache Storage
 * already de-duplicates it across sessions, but a second in-flight fetch during
 * a burst of crops would still be wasteful.
 */
function createCharsetLoader(
  models: ModelBundle,
  graphClassCount: number | null,
): CharsetLoader {
  let pending: Promise<string[]> | null = null

  return () => {
    pending ??= (async () => {
      const lines = await fetchCharset(models.charsetUrl)
      const dictionary = parseYamlCharacterDict(lines) ?? lines
      return assembleCharset(dictionary, models.prependBlank, graphClassCount)
    })().catch((error: unknown) => {
      pending = null // a transient network failure must not be cached forever
      throw error
    })

    return pending
  }
}

async function resolveVocabulary(
  models: DigitAwareBundle,
  digitsOnly: boolean,
  graphClassCount: number | null,
  loadCharset: CharsetLoader,
): Promise<Vocabulary> {
  if (digitsOnly && graphClassCount !== null) {
    // Preference order: whatever the registry tells us, then a head width we
    // have verified. Both avoid the dictionary download entirely.
    const supplied = validateDigitIndices(models.digitIndices, graphClassCount)
    const contiguous = supplied ?? contiguousDigitIndices(graphClassCount)

    if (contiguous) {
      return digitsOnlyVocabulary(contiguous, graphClassCount)
    }
  }

  // Everything else needs the real dictionary: either the caller wants
  // arbitrary text, or this is a head width whose digit placement we refuse to
  // guess (the 6625-class Chinese charset being exactly that case).
  const charset = await loadCharset()
  const digitIndices = findDigitIndices(charset)

  return {
    charset,
    digitIndices,
    allowedForDigits: digitIndices ? allowedSet(digitIndices) : null,
    complete: true,
  }
}

/**
 * A charset that contains nothing but the blank and the ten digits.
 *
 * Every other slot is an empty string, which is harmless: digit-restricted
 * decoding can never select those classes, and the length still satisfies the
 * `charset.length === classCount` guard that protects against index drift.
 */
function digitsOnlyVocabulary(digitIndices: number[], classCount: number): Vocabulary {
  const charset = new Array<string>(classCount).fill('')
  charset[CTC_BLANK_INDEX] = BLANK_TOKEN
  for (let d = 0; d < 10; d++) charset[digitIndices[d]] = String(d)

  return {
    charset,
    digitIndices,
    allowedForDigits: allowedSet(digitIndices),
    complete: false,
  }
}

/**
 * The classes digit-restricted decoding may emit.
 *
 * Blank is non-negotiable. Drop it and two things break at once: repeated digits
 * collapse, because CTC needs a blank frame between them to mark a boundary and
 * "11" comes back as "1"; and every frame is forced to emit *some* digit, so the
 * quiet padding at the end of a short crop turns into a run of invented numbers.
 */
function allowedSet(digitIndices: readonly number[]): Int32Array {
  return Int32Array.from([CTC_BLANK_INDEX, ...digitIndices])
}

function contiguousDigitIndices(classCount: number): number[] | null {
  const zero = CONTIGUOUS_DIGIT_HEADS.get(classCount)
  if (zero === undefined) return null
  return Array.from({ length: 10 }, (_, i) => zero + i)
}

function validateDigitIndices(
  supplied: readonly number[] | undefined,
  classCount: number,
): number[] | null {
  if (!supplied || supplied.length !== 10) return null
  const out: number[] = []
  for (const index of supplied) {
    if (!Number.isInteger(index) || index <= CTC_BLANK_INDEX || index >= classCount) return null
    out.push(index)
  }
  return out
}

/** Locate '0'..'9' in a full charset. Returns `null` unless all ten are present exactly once. */
function findDigitIndices(charset: readonly string[]): number[] | null {
  const found = new Map<string, number>()
  for (let i = 1; i < charset.length; i++) {
    const glyph = charset[i]
    if (glyph.length === 1 && glyph >= '0' && glyph <= '9' && !found.has(glyph)) {
      found.set(glyph, i)
    }
  }
  if (found.size !== 10) return null
  return Array.from({ length: 10 }, (_, d) => found.get(String(d)) as number)
}

/**
 * Build the runtime charset from a raw dictionary.
 *
 * PaddleOCR's order is `['blank'] + dict + [' ']` — the blank is *prepended* and
 * the space is *appended*, which is easy to get backwards and produces a charset
 * that is correct everywhere except at the two ends. Rather than guess whether
 * `use_space_char` was on, we let the model's own class count decide: the
 * dictionary either already accounts for every class, or it is exactly one short
 * and the missing entry is the trailing space.
 */
function assembleCharset(
  dictionary: readonly string[],
  prependBlank: boolean,
  classCount: number | null,
): string[] {
  const base = prependBlank ? [BLANK_TOKEN, ...dictionary] : [...dictionary]

  if (classCount === null) return base
  if (base.length === classCount) return base
  if (base.length + 1 === classCount) return [...base, ' ']

  throw new RecognizerConfigurationError(
    `The character dictionary does not fit the model: ${dictionary.length} entries ` +
      `(${base.length} after ${prependBlank ? 'prepending' : 'not prepending'} the CTC blank) ` +
      `against ${classCount} output classes. Decoding with a mismatched charset shifts ` +
      'every character, so it is refused.',
  )
}

/* -------------------------------------------------------------------------- */
/* YAML dictionary parsing                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Extract a `character_dict:` block sequence from PaddleX's `inference.yml`.
 *
 * The English v5 recogniser does not ship a plain `.txt` dictionary — its 436
 * entries live inside the model's YAML config, as a block sequence of scalars
 * that includes quoted and escaped values (`''''` for an apostrophe, `"\t"` for
 * a tab). A naive `split('\n')` loses those, and losing even one entry shifts
 * every index after it, so the parser below unquotes properly and the caller
 * still checks the final length against the model's class count.
 *
 * Returns `null` when the text is not a YAML config at all, which is the signal
 * to treat the lines as a one-character-per-line dictionary instead.
 */
function parseYamlCharacterDict(lines: readonly string[]): string[] | null {
  const start = lines.findIndex((line) => /^\s*character_dict\s*:\s*$/.test(line))
  if (start === -1) return null

  const entries: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    // A blank line ends the sequence. Continuing past it risks swallowing a
    // *different* list further down the file, which would look like success.
    if (lines[i].trim().length === 0) break

    const match = /^\s*-(?:[ \t]+(.*))?$/.exec(lines[i])
    if (!match) break // a sibling key — the sequence is over

    entries.push(unquoteYamlScalar(match[1] ?? ''))
  }

  return entries.length > 0 ? entries : null
}

function unquoteYamlScalar(raw: string): string {
  // YAML strips trailing whitespace from plain scalars, and a quoted scalar may
  // legitimately be followed by some, so trim before testing for quotes.
  const value = raw.replace(/\s+$/, '')

  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      // YAML double-quoted scalars use JSON's escape vocabulary for everything
      // this dictionary actually contains (\t, \\, \", \uXXXX).
      return JSON.parse(value) as string
    } catch {
      return value.slice(1, -1)
    }
  }
  return value
}

/* -------------------------------------------------------------------------- */
/* Preprocessing                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Pack crops into one NCHW `Float32Array`.
 *
 * This deliberately does *not* use `packBatch` from `opencv/crop.ts`, even
 * though that helper now honours `padValue` and `channelOrder`. The difference
 * is the tensor width: `packBatch` sizes the batch to its widest member, while
 * PaddleOCR floors `max_wh_ratio` at 320/48 and therefore always builds a
 * 320-wide tensor. That is not a detail — `RecResizeImg` uses the same fixed
 * `[3, 48, 320]` shape during training, so every crop the weights ever saw had
 * the same amount of padding after it. A 64-wide tensor for a two-digit crop is
 * out of distribution, and it would also hand ORT a new input shape for every
 * batch. So the width is fixed and the pack is local.
 *
 * **Padding is mid-grey.** PaddleOCR builds the buffer with `np.zeros` *after*
 * normalising, so the pad region is a normalised zero, which under
 * `(p/255 - 0.5)/0.5` is pixel 127.5. Here the tensor starts life as
 * `Float32Array` zeros and the crop is written over the left edge of it, which
 * makes the padding provably that value with no arithmetic at all. White padding
 * would be a plausible guess and a wrong one; black padding reads as a solid
 * stroke and produces trailing garbage characters.
 *
 * **Channel order is BGR.** Every PP-OCR config declares `img_mode: BGR` because
 * the reference pipeline reads with `cv2.imread`, and the normalisation is
 * applied to the channels in that order. It happens to be a no-op for this app's
 * greyscale-derived page, but it stops being one the moment the pipeline feeds
 * the recogniser a colour crop.
 */
function packCrops(
  cv: CV,
  crops: readonly Crop[],
  height: number,
  width: number,
): Float32Array {
  const planeSize = height * width
  const data = new Float32Array(crops.length * 3 * planeSize)

  using((scope) => {
    for (let n = 0; n < crops.length; n++) {
      const source = crops[n].mat
      const rgb = scope.add(new cv.Mat())

      if (source.channels() === 3) {
        source.copyTo(rgb)
      } else {
        cv.cvtColor(
          source,
          rgb,
          source.channels() === 4 ? cv.COLOR_RGBA2RGB : cv.COLOR_GRAY2RGB,
        )
      }

      const pixels = rgb.data
      const stride = rgb.cols * 3
      // The crop should already be exactly `height` tall and no wider than
      // `width`, but clamping costs nothing and turns an upstream mistake into
      // a slightly cropped digit instead of an out-of-bounds read.
      const rows = Math.min(height, rgb.rows)
      const cols = Math.min(width, rgb.cols)

      const base = n * 3 * planeSize
      for (let y = 0; y < rows; y++) {
        const rowStart = y * stride
        const outRow = base + y * width
        for (let x = 0; x < cols; x++) {
          const p = rowStart + x * 3
          // Mats here are RGB; planes are written B, G, R.
          data[outRow + x] = (pixels[p + 2] / 255 - REC_MEAN[0]) / REC_STD[0]
          data[planeSize + outRow + x] = (pixels[p + 1] / 255 - REC_MEAN[1]) / REC_STD[1]
          data[2 * planeSize + outRow + x] = (pixels[p] / 255 - REC_MEAN[2]) / REC_STD[2]
        }
      }
    }
  })

  return data
}

/* -------------------------------------------------------------------------- */
/* CTC decoding                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Does one timestep's class scores sum to 1?
 *
 * This is the cheapest reliable way to tell a softmaxed head from a raw-logit
 * one, and the answer decides how the digit mask has to be applied. Getting it
 * wrong is not a crash: re-softmaxing probabilities produces a near-uniform
 * distribution whose argmax is usually still right, so the text looks fine while
 * every confidence value becomes meaningless.
 */
function looksLikeProbabilities(
  scores: Float32Array,
  timesteps: number,
  classCount: number,
): boolean {
  if (timesteps === 0 || classCount === 0) return true

  let sum = 0
  for (let c = 0; c < classCount; c++) sum += scores[c]
  return Math.abs(sum - 1) < PROBABILITY_SUM_TOLERANCE
}

/**
 * Greedy CTC decode with an optional class restriction.
 *
 * **Masking.** With a softmaxed head, "set the disallowed classes to -Infinity"
 * is meaningless — the equivalent operation in probability space is to zero them
 * and renormalise over the survivors, which is exactly what softmax-with--Inf
 * computes. That is what happens below, and the argmax is taken over the
 * renormalised values.
 *
 * **Confidence.** The renormalised probability is inflated by construction: in
 * digits-only mode it divides by the mass of 11 classes instead of 438, so a
 * hopeless crop can report 0.95. We therefore rank with the renormalised value
 * but report the *original* probability of the chosen class. The difference is
 * the entire diagnostic signal: if the unrestricted argmax was a letter at
 * p = 0.9 while the best digit's raw probability is 0.03, the crop is not a
 * number at all, and only the raw value says so. `pipeline.ts` multiplies this
 * into the detector score and compares against `minConfidence`, so an honest
 * number here is what makes that gate work.
 *
 * **Collapsing.** PaddleOCR keeps the first frame of each repeated run and then
 * drops blanks (`selection[1:] = idx[1:] != idx[:-1]; selection &= idx != 0`).
 */
function decodeSequence(
  scores: Float32Array,
  offset: number,
  timesteps: number,
  classCount: number,
  charset: readonly string[],
  allowed: Int32Array | null,
  isProbability: boolean,
): RecognizedText {
  const chosen = new Int32Array(timesteps)
  const rawProbability = new Float32Array(timesteps)

  for (let t = 0; t < timesteps; t++) {
    const base = offset + t * classCount

    let best = CTC_BLANK_INDEX
    let bestRank = -Infinity
    let raw = 0

    if (isProbability) {
      // Zero the disallowed classes, then renormalise the survivors.
      let allowedMass = 0
      if (allowed) {
        for (let i = 0; i < allowed.length; i++) allowedMass += scores[base + allowed[i]]
      } else {
        for (let c = 0; c < classCount; c++) allowedMass += scores[base + c]
      }

      const scale = allowedMass > 0 ? 1 / allowedMass : 0
      if (allowed) {
        for (let i = 0; i < allowed.length; i++) {
          const c = allowed[i]
          const renormalised = scores[base + c] * scale
          if (renormalised > bestRank) {
            bestRank = renormalised
            best = c
            raw = scores[base + c]
          }
        }
      } else {
        for (let c = 0; c < classCount; c++) {
          const renormalised = scores[base + c] * scale
          if (renormalised > bestRank) {
            bestRank = renormalised
            best = c
            raw = scores[base + c]
          }
        }
      }
    } else {
      // Genuine logits. Here -Infinity masking *is* the right operation, and it
      // reduces to taking the argmax over the allowed logits alone. The honest
      // confidence still needs the UNMASKED softmax, so the full partition
      // function is accumulated too, shifted by the global maximum — shifting by
      // the allowed maximum instead would let a large disallowed logit overflow
      // `exp`.
      let globalMax = -Infinity
      for (let c = 0; c < classCount; c++) {
        if (scores[base + c] > globalMax) globalMax = scores[base + c]
      }

      let totalMass = 0
      for (let c = 0; c < classCount; c++) totalMass += Math.exp(scores[base + c] - globalMax)

      if (allowed) {
        for (let i = 0; i < allowed.length; i++) {
          const c = allowed[i]
          if (scores[base + c] > bestRank) {
            bestRank = scores[base + c]
            best = c
          }
        }
      } else {
        for (let c = 0; c < classCount; c++) {
          if (scores[base + c] > bestRank) {
            bestRank = scores[base + c]
            best = c
          }
        }
      }

      raw = totalMass > 0 ? Math.exp(scores[base + best] - globalMax) / totalMass : 0
    }

    chosen[t] = best
    rawProbability[t] = raw
  }

  let text = ''
  const charConfidences: number[] = []
  let confidenceSum = 0

  for (let t = 0; t < timesteps; t++) {
    if (t > 0 && chosen[t] === chosen[t - 1]) continue // same run — already emitted
    if (chosen[t] === CTC_BLANK_INDEX) continue

    const glyph = charset[chosen[t]]
    if (!glyph) continue // an unrestricted decode landed on an unmapped slot

    text += glyph
    charConfidences.push(rawProbability[t])
    confidenceSum += rawProbability[t]
  }

  return {
    // `text` is what `normalizeNumber` will clean up; `rawText` is preserved
    // verbatim so a debugging session can see what the model really emitted.
    text: text.trim(),
    rawText: text,
    confidence: charConfidences.length > 0 ? confidenceSum / charConfidences.length : 0,
    charConfidences,
  }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function emptyReading(): RecognizedText {
  return { text: '', rawText: '', confidence: 0, charConfidences: [] }
}

/**
 * A human-readable description of a thrown value.
 *
 * `error.message` alone is not enough: an Emscripten abort inside the WASM
 * runtime — the failure mode of record for a batch that dies mid-inference —
 * arrives as an `Error` with an empty message, which would render a warning that
 * names no cause at all. Falling back to `String(error)` at least yields the
 * constructor name, which is how a `RangeError` (the shape an out-of-memory
 * failure takes on mobile Safari) stays identifiable in a bug report.
 */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return `${error.name}: ${error.message}`
  return String(error)
}

function tensorShapeOf(
  metadata: readonly InferenceSession.ValueMetadata[],
): ReadonlyArray<number | string> | null {
  const first = metadata[0]
  if (!first || !first.isTensor) return null
  return first.shape
}

/** A dimension's value when the graph pins it, or `null` when it is symbolic. */
function staticDim(
  shape: ReadonlyArray<number | string> | null,
  axis: number,
): number | null {
  if (!shape) return null
  const value = shape[axis]
  return typeof value === 'number' && value > 0 ? value : null
}

function readHeadDims(head: Tensor): [number, number, number] {
  // The decode reads the head through `head.data as Float32Array`. That cast is
  // unchecked at runtime, so a head exported as float16 would hand the decoder a
  // `Uint16Array` whose raw bit patterns it would happily argmax over: no throw,
  // no warning, just wrong digits with meaningless confidences. Every model in
  // the registry emits float32; anything else is a configuration mistake and
  // must say so rather than be reinterpreted.
  if (head.type !== 'float32') {
    throw new RecognizerConfigurationError(
      `Expected the recogniser head to be float32 but it is "${head.type}". ` +
        'Decoding would reinterpret its raw bytes as probabilities. Point the ' +
        'model registry at a float32 export.',
    )
  }

  const dims = head.dims
  if (dims.length !== 3) {
    throw new RecognizerConfigurationError(
      `Expected the recogniser head to be [N, T, C] but it is [${dims.join(', ')}]`,
    )
  }
  return [dims[0], dims[1], dims[2]]
}

/**
 * Raised for problems that will repeat identically on every remaining batch — a
 * charset that does not fit the model, a head of the wrong rank, a digit mask
 * that could not be resolved.
 *
 * These are worth failing the whole call for. Surfacing them once is far more
 * useful than quietly handing back a ticket with no numbers on it, whereas a
 * transient allocation failure or a single malformed crop should only cost the
 * batch it happened in.
 */
export class RecognizerConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecognizerConfigurationError'
  }
}
