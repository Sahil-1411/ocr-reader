/**
 * Which neural weights the pipeline runs, where they come from, and the
 * numeric constants that go with them.
 *
 * This file is deliberately the only place in `src/ocr` that knows a URL or a
 * magic threshold. Everything else takes a `ModelBundle` and asks this module
 * what that bundle's preprocessing and post-processing constants are, because
 * **those constants are properties of the weights, not of the algorithm**. The
 * DB post-process thresholds, the input normalisation, the resize rule, the CTC
 * class count and even the index of the digit `0` all change when you swap one
 * `.onnx` for another. Hard-coding any of them somewhere else is how a pipeline
 * ends up silently reading `8` as `3` after a "harmless" model upgrade.
 *
 * Provenance
 * ----------
 * Every URL below was fetched (status, `Content-Length` and CORS headers
 * recorded), every `.onnx` was confirmed to be a real ONNX protobuf rather than
 * an HTML error page or a Git-LFS pointer, and every model was loaded and run
 * under ONNX Runtime Web before it was written down here. Sizes in `approxBytes`
 * are the measured `Content-Length` of the primary URL, so the download progress
 * bar is honest rather than a guess.
 *
 * Two rules about URLs that are not negotiable:
 *
 *   · **Never a HuggingFace `/blob/` URL.** `huggingface.co/<repo>/blob/main/f`
 *     is a *web page*; it returns HTTP 200 with HTML. Only `/resolve/main/f`
 *     returns the file. `cache.ts` would catch it (`looksLikeOnnx` rejects a
 *     leading `<`), but the failure would be a mysterious mirror-exhausted error.
 *
 *   · **Never the CDN URL a `/resolve/` link redirects to.** Large files there
 *     302 to `https://us.aws.cdn.hf.co/xet-bridge-us/...` with `Expires` and
 *     `Signature` query parameters. Those signatures expire in hours. Always
 *     link the stable `huggingface.co/.../resolve/main/...` URL and let `fetch`
 *     follow the redirect — it does, and the final hop carries
 *     `access-control-allow-origin: *`.
 *
 * A note on cross-origin isolation
 * --------------------------------
 * ONNX Runtime Web only gets WASM threads when `crossOriginIsolated` is true,
 * which requires serving the app with `COOP: same-origin` + `COEP:
 * require-corp`. Turning those headers on *breaks every cross-origin fetch in
 * this file*, because under `require-corp` a third-party response must carry
 * `Cross-Origin-Resource-Policy: cross-origin` and neither HuggingFace's CDN nor
 * jsDelivr sends it. That is not a bug to work around, it is the trade the
 * platform offers: multithreaded inference or CDN-hosted weights, pick one. If
 * you pick threads, mirror the files locally and wrap the bundle in
 * {@link withSelfHostedModels}; {@link SELF_HOSTED_MANIFEST} is the download
 * list for the script that does it.
 */

import type { BatchNormalization } from '../opencv/crop'
import type { DetectorOptions, ModelBundle, ModelSource, RecognizerOptions } from '../types'

/* -------------------------------------------------------------------------- */
/* Preset shapes                                                               */
/* -------------------------------------------------------------------------- */

/**
 * How a detector's input image must be sized.
 *
 * PaddleOCR's `DetResizeForTest` is really three different operators chosen by
 * which keyword its config passes, and they do not round the same way:
 *
 *   · `resize_long: N`  → `resize_image_type2`: scale so the **long** side is N,
 *     then round each side **up to a multiple of 128** (`max_stride = 128`).
 *   · `limit_side_len: N` + `limit_type` → `resize_image_type0`: scale so the
 *     long (`max`) or short (`min`) side hits N, then round each side to the
 *     **nearest multiple of 32**, with a hard ceiling of 4000 px per side.
 *
 * The distinction is easy to miss — most JS ports use 32 everywhere — and it is
 * worth getting right because the DB probability map is produced at input
 * resolution: a different input grid shifts every box edge by a pixel or two,
 * which on the two-digit crops this app makes is a real accuracy difference.
 * Both sizes remain legal inputs (the graphs are fully convolutional), so a
 * mismatch degrades quietly instead of throwing.
 */
export interface DetectorResizeRule {
  mode: 'resize-long' | 'limit-side-len'
  /** Target long side for `resize-long`; `limit_side_len` for the other mode. */
  sideLen: number
  /**
   * For `limit-side-len`: `max` scales the long side down to `sideLen`, `min`
   * scales the short side up to it. Unused by `resize-long`.
   */
  limitType: 'max' | 'min'
  /** Each side is rounded to a multiple of this after scaling. */
  sizeMultiple: number
  /** Hard ceiling per side, from PaddleOCR's `max_side_limit`. */
  maxSideLimit: number
}

/** The DBNet post-processing constants published with a specific detector. */
export interface DbPostProcessPreset {
  /** `thresh`: binarises the probability map before contour tracing. */
  binaryThreshold: number
  /** `box_thresh`: minimum mean probability inside a candidate box. */
  boxThreshold: number
  /** `unclip_ratio`: Vatti expansion applied to the shrunk DB polygon. */
  unclipRatio: number
  /** `max_candidates`: hard cap on traced contours, a runtime guard. */
  maxCandidates: number
  /** Dilate the binary map before tracing — recovers broken thin strokes. */
  useDilation: boolean
  /**
   * `fast` scores a box by the mean probability inside its bounding rect;
   * `slow` masks the exact polygon. `fast` is what PaddleOCR ships and is
   * several times cheaper per box.
   */
  scoreMode: 'fast' | 'slow'
}

export interface DetectorPreset {
  /** Matches `ModelSource.id` — this is the join key after a structured clone. */
  modelId: string
  /** Input normalisation, in the exact form `packBatch` consumes. */
  normalization: BatchNormalization
  resize: DetectorResizeRule
  db: DbPostProcessPreset
  /** Where these numbers were read from, so they can be re-checked. */
  provenance: string
}

/** One place a recogniser's character dictionary can be obtained. */
export interface CharsetSource {
  url: string
  /**
   * `lines` — one character per line, the classic PaddleOCR `*_dict.txt`. This
   * is what `parseCharset()` in `cache.ts` handles.
   *
   * `paddle-inference-yml` — the charset is embedded in a PaddleX
   * `inference.yml` as a `character_dict:` YAML sequence. **`parseCharset()`
   * cannot read this**; it needs the small dedicated parser described on
   * {@link EN_PPOCRV5_REC_PRESET}.
   */
  format: 'lines' | 'paddle-inference-yml'
  /** Insert the CTC blank at index 0 after parsing. */
  prependBlank: boolean
  /** Append a space character at the end after parsing. */
  appendSpace: boolean
  /** Entries in the parsed file, *before* blank/space are added. */
  rawEntries: number
  /**
   * Entries after assembly. This MUST equal the model's output class count, and
   * asserting it is the single cheapest way to catch a charset/weights mismatch
   * — which otherwise manifests as confident, plausible, wrong digits.
   */
  expectedClasses: number
  note: string
}

export type DigitChar = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'

export interface RecognizerPreset {
  modelId: string
  normalization: BatchNormalization
  /**
   * Baked into the graph for every modern PP-OCR recogniser — feeding a
   * different height throws at session run time rather than degrading.
   */
  inputHeight: number
  /** Width the crop is padded to; `rec_image_shape[2]` in PaddleOCR terms. */
  maxInputWidth: number
  /** Last dimension of the model's output tensor. */
  outputClasses: number
  /** Index of the CTC blank. PaddleOCR always prepends it, so always 0. */
  blankIndex: number
  /** Ordered dictionary sources, primary first. */
  charsets: readonly CharsetSource[]
  /**
   * Class index of each digit, for digit-constrained CTC decoding.
   *
   * This lives on the preset rather than in the decoder because it is **not** a
   * property of CTC or of PaddleOCR — it is a property of one dictionary file.
   * The English dictionaries happen to start with `0`–`9`, so digits land on a
   * tidy contiguous 1..10. The 6625-class Chinese dictionary scatters them
   * across 25..1109 in no order at all, because they are simply wherever they
   * fell in a file sorted by Chinese-corpus frequency. Anything that assumes
   * 1..10 and then meets the Chinese weights produces high-confidence nonsense,
   * which is far worse than an error.
   */
  digitIndices: Readonly<Record<DigitChar, number>>
  provenance: string
}

/**
 * A `ModelBundle` plus everything the stages need to use it correctly.
 *
 * It extends rather than replaces `ModelBundle` because that type is the shared
 * contract (and the worker-message payload) and must not change. The extra
 * fields are plain data, so the whole thing survives `postMessage`'s structured
 * clone — but code on the receiving side is typed as `ModelBundle`, so it should
 * call {@link resolveBundle} rather than casting.
 */
export interface TicketModelBundle extends ModelBundle {
  id: string
  /** Short label for a model picker. */
  label: string
  /** One sentence on when to choose this bundle. */
  description: string
  detectorPreset: DetectorPreset
  recognizerPreset: RecognizerPreset
  /** Detector + recogniser bytes, for a "this will download N MB" prompt. */
  approxTotalBytes: number
}

/* -------------------------------------------------------------------------- */
/* Normalisation constants                                                     */
/* -------------------------------------------------------------------------- */

/**
 * ImageNet statistics, applied to **B, G, R** planes in that order.
 *
 * Every PP-OCR `inference.yml` declares `DecodeImage{img_mode: BGR}` because the
 * reference pipeline reads images with `cv2.imread`. The mean/std triple is
 * published in RGB order upstream but PaddleOCR applies it positionally to the
 * BGR-ordered array, so the pairing below (0.485 with blue) looks wrong and is
 * exactly what the weights were fitted against. `packBatch` reproduces it by
 * reversing the *plane* index, which is why the numbers here stay in published
 * order and `channelOrder` carries the swap.
 *
 * Getting this backwards costs recall specifically on the images this app
 * targets: a red watermark lives almost entirely in the R and B channels, so
 * swapping them changes the detector's input exactly where the signal is
 * ambiguous.
 */
const IMAGENET_BGR: BatchNormalization = {
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
  channels: 3,
  channelOrder: 'bgr',
  // Detector input is a single full-page image, never a padded batch, so this
  // value is never read. Zero keeps it obviously inert.
  padValue: 0,
}

/**
 * RapidOCR's own detector normalisation: plain `(x/255 - 0.5) / 0.5`.
 *
 * Two mutually incompatible detector normalisations are in the wild and both are
 * "correct" — PaddlePaddle's official configs say ImageNet stats, RapidOCR's
 * shipped config says 0.5/0.5. Which one is right depends on which export the
 * weights came from, so it is recorded per model rather than globally.
 */
const HALF_HALF_BGR: BatchNormalization = {
  mean: [0.5, 0.5, 0.5],
  std: [0.5, 0.5, 0.5],
  channels: 3,
  channelOrder: 'bgr',
  padValue: 0,
}

/**
 * Recogniser normalisation for every PP-OCR CTC model: `(x/255 - 0.5) / 0.5`.
 *
 * `padValue: 0` is load-bearing. PaddleOCR allocates the batch with `np.zeros`
 * and writes the normalised crop into the left of it, so its padding is
 * normalised zero — mid-grey, pixel 127.5 — not white and not black. Every crop
 * this app produces is one or two digits inside a 320-px-wide tensor, so the
 * padding is the overwhelming majority of what the model sees; padding with
 * black reads as ink and reliably appends phantom characters.
 */
const PPOCR_REC_NORMALIZATION: BatchNormalization = {
  mean: [0.5, 0.5, 0.5],
  std: [0.5, 0.5, 0.5],
  channels: 3,
  channelOrder: 'bgr',
  padValue: 0,
}

/* -------------------------------------------------------------------------- */
/* Model sources                                                               */
/* -------------------------------------------------------------------------- */

/**
 * PP-OCRv5 mobile detector — the default.
 *
 * Chosen over the smaller v6 tiny because it is the most recent detector with a
 * published, self-consistent config (weights + `inference.yml` + DB thresholds
 * all from one release) and it measured 314 ms per page at 736×960 on WASM,
 * which is acceptable given the rest of the pipeline. Its probability map comes
 * out at full input resolution, so no upsampling step is needed.
 *
 * The mirror is a third-party re-export of the same architecture. It is **not**
 * byte-identical (4,766,440 B vs 4,826,518 B), so it is a genuine fallback, not
 * a copy: it loads, its graph I/O matches, and its preprocessing is assumed
 * equal because it is the same upstream Paddle model. If the primary ever goes
 * away for good, re-verify the mirror's thresholds before trusting it.
 */
const PP_OCRV5_MOBILE_DET: ModelSource = {
  id: 'pp-ocrv5-mobile-det',
  name: 'PP-OCRv5 mobile detector',
  urls: [
    'https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/main/inference.onnx',
    'https://huggingface.co/xberg-io/paddleocr-onnx-models/resolve/main/v2/det/mobile.onnx',
  ],
  approxBytes: 4_826_518,
}

/**
 * PP-OCRv6 tiny detector — 1.7 MB and the fastest tested (205 ms vs 314 ms).
 *
 * Worth switching to on low-end phones or metered connections. Its DB thresholds
 * are *much* looser than v5's and the two sets are not interchangeable in either
 * direction; see {@link PP_OCRV6_TINY_DET_PRESET}.
 */
const PP_OCRV6_TINY_DET: ModelSource = {
  id: 'pp-ocrv6-tiny-det',
  name: 'PP-OCRv6 tiny detector',
  urls: [
    'https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det_onnx/resolve/main/inference.onnx',
    'https://huggingface.co/xberg-io/paddleocr-onnx-models/resolve/main/v6/det/tiny/model.onnx',
  ],
  approxBytes: 1_780_590,
}

/**
 * Chinese PP-OCRv4 detector, served from npm via jsDelivr.
 *
 * Kept only as an availability fallback for networks that block
 * `huggingface.co` outright — jsDelivr is a different origin with immutable,
 * version-pinned URLs. It is the same size and speed class as v5 and slightly
 * older. Note that its graph output is named `sigmoid_0.tmp_0` rather than
 * `fetch_name_0`, which is precisely why nothing in this codebase may hard-code
 * a tensor name: read `session.outputNames[0]`.
 */
const CH_PP_OCRV4_DET: ModelSource = {
  id: 'ch-pp-ocrv4-det',
  name: 'PP-OCRv4 Chinese detector (jsDelivr)',
  urls: [
    'https://cdn.jsdelivr.net/npm/@gutenye/ocr-models@1.4.2/assets/ch_PP-OCRv4_det_infer.onnx',
  ],
  approxBytes: 4_745_517,
}

/**
 * English PP-OCRv5 mobile recogniser — the default.
 *
 * The decisive property for a ticket reader is not size but its 438-class
 * English-only charset: digits sit at a contiguous 1..10, so digit-constrained
 * decoding is a ten-entry argmax instead of a 6625-entry one, and there are no
 * Chinese glyphs for a watermark fragment to be misread as. Verified end to end:
 * with the charset assembled as described below it decoded `3456`,
 * `1234567890`, `07` and `19` exactly.
 *
 * The mirror is again a re-export (7,843,511 B vs 7,848,423 B) whose manifest
 * agrees on 438 classes.
 */
const EN_PP_OCRV5_MOBILE_REC: ModelSource = {
  id: 'en-pp-ocrv5-mobile-rec',
  name: 'PP-OCRv5 English mobile recogniser',
  urls: [
    'https://huggingface.co/PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx/resolve/main/inference.onnx',
    'https://huggingface.co/xberg-io/paddleocr-onnx-models/resolve/main/v2/rec/en_mobile/model.onnx',
  ],
  approxBytes: 7_848_423,
}

/**
 * `en_number_mobile_v2.0` — 1.9 MB, 9 ms per crop, five times faster than v5.
 *
 * A 2021-era PP-OCRv1 model, and it shows: noticeably weaker on marginal glyphs.
 * Its redeeming feature for this app is that it was trained on English *and
 * digits* only (97 classes), so on clean, well-separated ticket print it is
 * nearly free. Its input height is **32, not 48**, and the graph declares fully
 * dynamic dimensions — feeding it 48 does not throw, it just returns degraded
 * output. That silent-failure mode is why `inputHeight` is a preset field that
 * the recogniser must read rather than a constant.
 */
const EN_NUMBER_MOBILE_V2_REC: ModelSource = {
  id: 'en-number-mobile-v2-rec',
  name: 'PP-OCR en_number_mobile v2.0 recogniser',
  urls: [
    'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv1/en_number_mobile_v2.0_rec_infer.onnx',
  ],
  approxBytes: 1_882_607,
}

/**
 * Chinese PP-OCRv4 recogniser, 10.8 MB, 6625 classes.
 *
 * The availability fallback's recogniser. Almost everything about it is worse
 * here — nearly twice the download, 56 ms per crop, and a huge charset whose
 * digit indices are scattered — but it is on a different CDN from everything
 * else, which is the entire point of keeping it.
 */
const CH_PP_OCRV4_REC: ModelSource = {
  id: 'ch-pp-ocrv4-rec',
  name: 'PP-OCRv4 Chinese recogniser (jsDelivr)',
  urls: [
    'https://cdn.jsdelivr.net/npm/@gutenye/ocr-models@1.4.2/assets/ch_PP-OCRv4_rec_infer.onnx',
  ],
  approxBytes: 10_822_323,
}

/* -------------------------------------------------------------------------- */
/* Charset sources                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The authoritative charset for `en_PP-OCRv5_mobile_rec`.
 *
 * **This is not a dictionary file.** Unlike every earlier PaddleOCR release,
 * which shipped a `*_dict.txt` of one character per line, PaddleX embeds this
 * model's charset inside its `inference.yml` as a YAML sequence:
 *
 * ```yaml
 * PostProcess:
 *   name: CTCLabelDecode
 *   character_dict:
 *     - '0'
 *     - '1'
 *     ...
 * ```
 *
 * So `parseCharset()` from `cache.ts` — which splits on newlines — must not be
 * pointed at it. The recogniser needs a small parser that takes the text after
 * `character_dict:`, keeps lines beginning with `- `, strips YAML quoting
 * (`''` unescapes to `'`, double-quoted scalars are JSON strings), and stops at
 * the first non-list line. That yields exactly 436 entries; the runtime charset
 * is then `['<blank>', ...436, ' ']` = 438, matching the model's output
 * dimension.
 *
 * The order of those two insertions is the classic PP-OCR off-by-one: PaddleOCR
 * appends the space at the *end* of the dictionary and only then inserts the
 * blank at index 0. Prepend blank and forget the space, and everything decodes
 * correctly until the first space; insert the space at index 1 instead, and
 * every index past it shifts by one and the output becomes confident garbage.
 */
const EN_PPOCRV5_CHARSET_YML: CharsetSource = {
  url: 'https://huggingface.co/PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx/resolve/main/inference.yml',
  format: 'paddle-inference-yml',
  prependBlank: true,
  appendSpace: true,
  rawEntries: 436,
  expectedClasses: 438,
  note:
    'PaddleX inference.yml; charset is a YAML character_dict sequence, not one-per-line text. ' +
    'Requires the YAML-scalar parser, NOT parseCharset().',
}

/**
 * A plain-text mirror of the same 438-class charset, **already expanded**.
 *
 * Verified line by line: 438 lines, no trailing newline, `#` standing in for the
 * blank at index 0, the official 436 entries at 1..436 byte-for-byte, and a
 * literal single space on the last line. Because the blank and space are already
 * present, `prependBlank` and `appendSpace` are both false — getting that
 * backwards here would produce 440 classes against a 438-class model, which the
 * length assertion catches immediately.
 *
 * It is the secondary source rather than the primary for one reason: the repo it
 * lives in uses *inconsistent* conventions across its own dictionaries (its
 * Arabic and v6 dicts are unexpanded), so only this specific file is trustworthy
 * and only because it was compared against the official YAML. Prefer it when you
 * want to avoid shipping a YAML parser; treat the official `inference.yml` as
 * the source of truth either way.
 */
const EN_PPOCRV5_CHARSET_TXT: CharsetSource = {
  url: 'https://huggingface.co/xberg-io/paddleocr-onnx-models/resolve/main/v2/rec/en_mobile/dict.txt',
  format: 'lines',
  prependBlank: false,
  appendSpace: false,
  rawEntries: 438,
  expectedClasses: 438,
  note:
    "Pre-expanded mirror: index 0 is a '#' placeholder for the CTC blank, index 437 is a space. " +
    'Verified identical to the official character_dict at indices 1..436.',
}

/**
 * PaddleOCR's `en_dict.txt`: 95 lines, digits on lines 1–10.
 *
 * Pinned to the `v2.7.0` tag rather than a branch tip, so the file cannot change
 * under us. Two traps live in this 190-byte file: it *does* end with a newline,
 * and its last line is a literal single space. A parser that trims before it
 * filters — `split('\n').map((l) => l.trim()).filter(Boolean)`, the shape
 * everyone reaches for — therefore drops the space along with the trailing empty
 * line and yields 94 entries, giving 96 classes against a 97-class model.
 * `parseCharset()` in `cache.ts` handles both correctly: it pops only a trailing
 * empty line and never trims.
 */
const EN_DICT_CHARSET: CharsetSource = {
  url: 'https://cdn.jsdelivr.net/gh/PaddlePaddle/PaddleOCR@v2.7.0/ppocr/utils/en_dict.txt',
  format: 'lines',
  prependBlank: true,
  appendSpace: true,
  rawEntries: 95,
  expectedClasses: 97,
  note: 'Ends with a newline AND its final entry is a literal space — do not filter empty strings.',
}

/**
 * `ppocr_keys_v1.txt`: the 6623-entry Chinese dictionary.
 *
 * The mirror image of the trap above — this file has **no** trailing newline, so
 * a parser that unconditionally drops the last element loses the final entry,
 * and one that filters empty strings drops nothing but would have on the other
 * file. Its first line is a literal apostrophe, which is also easy to lose.
 */
const PPOCR_KEYS_V1_CHARSET: CharsetSource = {
  url: 'https://cdn.jsdelivr.net/npm/@gutenye/ocr-models@1.4.2/assets/ppocr_keys_v1.txt',
  format: 'lines',
  prependBlank: true,
  appendSpace: true,
  rawEntries: 6623,
  expectedClasses: 6625,
  note: 'No trailing newline; first entry is a literal apostrophe. 6623 + blank + space = 6625.',
}

/* -------------------------------------------------------------------------- */
/* Detector presets                                                            */
/* -------------------------------------------------------------------------- */

/**
 * PP-OCRv5 mobile detector.
 *
 * Every number is verbatim from the model's own `inference.yml`, except the
 * rounding multiple: the yml says `DetResizeForTest{resize_long: 960}`, and in
 * PaddleOCR that keyword selects `resize_image_type2`, which rounds **up to a
 * multiple of 128**. The widely copied "round to 32" rule belongs to the
 * `limit_side_len` path this config does not use. The yml's TensorRT dynamic
 * shapes independently confirm the working range (32×32 to 4000×4000).
 *
 * `useDilation: false` matches PaddleOCR's default. RapidOCR enables it; on
 * ticket print, which is thick and high-contrast after watermark suppression,
 * dilation mostly merges adjacent numbers in a column into one box, which is the
 * one failure this pipeline cannot recover from.
 */
export const PP_OCRV5_MOBILE_DET_PRESET: DetectorPreset = {
  modelId: PP_OCRV5_MOBILE_DET.id,
  normalization: IMAGENET_BGR,
  resize: {
    mode: 'resize-long',
    sideLen: 960,
    limitType: 'max',
    sizeMultiple: 128,
    maxSideLimit: 4000,
  },
  db: {
    binaryThreshold: 0.3,
    boxThreshold: 0.6,
    unclipRatio: 1.5,
    maxCandidates: 1000,
    useDilation: false,
    scoreMode: 'fast',
  },
  provenance:
    'PaddlePaddle/PP-OCRv5_mobile_det_onnx/inference.yml (DBPostProcess thresh 0.3, box_thresh 0.6, ' +
    'max_candidates 1000, unclip_ratio 1.5; DetResizeForTest resize_long 960 → resize_image_type2, stride 128)',
}

/**
 * PP-OCRv6 tiny detector — **not** interchangeable with the v5 numbers above.
 *
 * Its published thresholds are dramatically looser: `thresh` 0.2 instead of 0.3
 * and `box_thresh` 0.4 instead of 0.6. Run this model with v5's `box_thresh` and
 * most boxes are discarded, which reads exactly like a broken model rather than
 * a misconfigured one. The compensating `max_candidates` of 3000 exists because
 * a lower binary threshold traces many more contours.
 *
 * The one value not taken from the yml is the resize rule: v6's config sets
 * `DetResizeForTest: null`, so PaddleOCR falls back to `DetResizeForTest`'s own
 * constructor defaults — `limit_side_len 736`, `limit_type 'min'`, multiples of
 * 32 — which is also what RapidOCR ships. That is an inference from the library's
 * defaults rather than a published value, so it is the first thing to question if
 * this detector underperforms.
 */
export const PP_OCRV6_TINY_DET_PRESET: DetectorPreset = {
  modelId: PP_OCRV6_TINY_DET.id,
  normalization: IMAGENET_BGR,
  resize: {
    mode: 'limit-side-len',
    sideLen: 736,
    limitType: 'min',
    sizeMultiple: 32,
    maxSideLimit: 4000,
  },
  db: {
    binaryThreshold: 0.2,
    boxThreshold: 0.4,
    unclipRatio: 1.4,
    maxCandidates: 3000,
    useDilation: false,
    scoreMode: 'fast',
  },
  provenance:
    'PaddlePaddle/PP-OCRv6_tiny_det_onnx/inference.yml (thresh 0.2, box_thresh 0.4, unclip_ratio 1.4, ' +
    'max_candidates 3000; DetResizeForTest null → PaddleOCR defaults 736/min/×32)',
}

/**
 * PP-OCRv4 Chinese detector as packaged by `@gutenye/ocr-models`.
 *
 * These weights reach us through the RapidOCR/JS-port lineage rather than a
 * PaddleX release, and that lineage's shipped config uses the 0.5/0.5
 * normalisation with `limit_side_len 736 / limit_type min`, not ImageNet stats.
 * Mixing the two normalisations is not catastrophic — the network still fires —
 * but it costs recall exactly where this app cannot afford it: faint, low-contrast
 * digits left behind after watermark suppression.
 *
 * `useDilation: true` and `unclip_ratio 1.6` are RapidOCR's production tuning,
 * kept here because these thresholds were tuned together with that normalisation.
 */
export const CH_PP_OCRV4_DET_PRESET: DetectorPreset = {
  modelId: CH_PP_OCRV4_DET.id,
  normalization: HALF_HALF_BGR,
  resize: {
    mode: 'limit-side-len',
    sideLen: 736,
    limitType: 'min',
    sizeMultiple: 32,
    maxSideLimit: 4000,
  },
  db: {
    binaryThreshold: 0.3,
    boxThreshold: 0.5,
    unclipRatio: 1.6,
    maxCandidates: 1000,
    useDilation: true,
    scoreMode: 'fast',
  },
  provenance:
    "RapidOCR python/rapidocr/config.yaml Det section (limit_side_len 736, limit_type 'min', " +
    'mean/std 0.5, thresh 0.3, box_thresh 0.5, unclip_ratio 1.6, use_dilation true, score_mode fast)',
}

/* -------------------------------------------------------------------------- */
/* Recogniser presets                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Digit indices for any dictionary that begins `0,1,2,…,9` with the CTC blank
 * prepended — true for both English PP-OCR dictionaries used here.
 */
const CONTIGUOUS_DIGITS: Readonly<Record<DigitChar, number>> = {
  '0': 1,
  '1': 2,
  '2': 3,
  '3': 4,
  '4': 5,
  '5': 6,
  '6': 7,
  '7': 8,
  '8': 9,
  '9': 10,
}

export const EN_PPOCRV5_REC_PRESET: RecognizerPreset = {
  modelId: EN_PP_OCRV5_MOBILE_REC.id,
  normalization: PPOCR_REC_NORMALIZATION,
  // Fixed in the graph as [N,3,48,W]; anything else throws at run time.
  inputHeight: 48,
  maxInputWidth: 320,
  outputClasses: 438,
  blankIndex: 0,
  charsets: [EN_PPOCRV5_CHARSET_YML, EN_PPOCRV5_CHARSET_TXT],
  digitIndices: CONTIGUOUS_DIGITS,
  provenance:
    'PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx: graph output [N,T,438]; inference.yml character_dict has ' +
    "436 entries starting '0'..'9','A'..; runtime charset ['<blank>', ...436, ' '] verified to decode " +
    'synthetic digit strings exactly.',
}

export const EN_NUMBER_MOBILE_V2_REC_PRESET: RecognizerPreset = {
  modelId: EN_NUMBER_MOBILE_V2_REC.id,
  normalization: PPOCR_REC_NORMALIZATION,
  // 32, not 48. The graph accepts 48 without complaint and returns worse text.
  inputHeight: 32,
  maxInputWidth: 320,
  outputClasses: 97,
  blankIndex: 0,
  charsets: [EN_DICT_CHARSET],
  digitIndices: CONTIGUOUS_DIGITS,
  provenance:
    'SWHL/RapidOCR PP-OCRv1/en_number_mobile_v2.0_rec_infer.onnx: output [N,T,97]; en_dict.txt 95 lines ' +
    '+ blank + space = 97; trained at height 32.',
}

/**
 * The 6625-class Chinese recogniser.
 *
 * The digit map below is the whole reason `digitIndices` is a per-bundle field.
 * These indices are the 1-based line numbers of each digit in
 * `ppocr_keys_v1.txt` (1-based because the blank is prepended at 0, which
 * happens to make line number and class index coincide). They are scattered —
 * `'4'` is at 632 and `'9'` at 1109 — because the dictionary is ordered by
 * Chinese corpus frequency, not by character.
 */
export const CH_PPOCRV4_REC_PRESET: RecognizerPreset = {
  modelId: CH_PP_OCRV4_REC.id,
  normalization: PPOCR_REC_NORMALIZATION,
  inputHeight: 48,
  maxInputWidth: 320,
  outputClasses: 6625,
  blankIndex: 0,
  charsets: [PPOCR_KEYS_V1_CHARSET],
  digitIndices: {
    '0': 26,
    '1': 93,
    '2': 25,
    '3': 94,
    '4': 632,
    '5': 631,
    '6': 933,
    '7': 29,
    '8': 27,
    '9': 1109,
  },
  provenance:
    '@gutenye/ocr-models@1.4.2 ch_PP-OCRv4_rec_infer.onnx: output [N,T,6625]; digit indices are the ' +
    '1-based line numbers of each digit in ppocr_keys_v1.txt.',
}

/* -------------------------------------------------------------------------- */
/* Bundles                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The default: PP-OCRv5 mobile detector + English PP-OCRv5 recogniser.
 *
 * ~12.7 MB of weights, roughly 314 ms for detection plus 47 ms per number on a
 * desktop WASM build (budget two to four times that on a mid-range phone). Both
 * halves come from the same PaddleX release, so their configs agree with each
 * other, and the English charset keeps digit-constrained decoding to a ten-class
 * argmax.
 *
 * `charsetUrl` points at an `inference.yml`, **not** a line-per-character
 * dictionary — see {@link EN_PPOCRV5_CHARSET_YML} before loading it, and prefer
 * `recognizerPreset.charsets` over this single field, which exists only because
 * it is part of the shared `ModelBundle` contract.
 */
export const DEFAULT_MODEL_BUNDLE: TicketModelBundle = {
  id: 'ppocr-v5-english',
  label: 'PP-OCRv5 English (recommended)',
  description:
    'Best accuracy on printed digits. ~12.7 MB download, English-only charset with contiguous digit classes.',
  detector: PP_OCRV5_MOBILE_DET,
  recognizer: EN_PP_OCRV5_MOBILE_REC,
  charsetUrl: EN_PPOCRV5_CHARSET_YML.url,
  prependBlank: EN_PPOCRV5_CHARSET_YML.prependBlank,
  detectorPreset: PP_OCRV5_MOBILE_DET_PRESET,
  recognizerPreset: EN_PPOCRV5_REC_PRESET,
  approxTotalBytes: PP_OCRV5_MOBILE_DET.approxBytes + EN_PP_OCRV5_MOBILE_REC.approxBytes,
}

/**
 * Same recogniser, the 1.7 MB v6 tiny detector: ~9.6 MB and ~100 ms faster per
 * page. The sensible default on a slow connection, at some cost in recall on
 * faint or small text.
 */
export const FAST_MODEL_BUNDLE: TicketModelBundle = {
  id: 'ppocr-v6tiny-english',
  label: 'PP-OCRv6 tiny detector + English v5 recogniser',
  description: 'Smaller and ~35% faster detection, slightly lower recall on faint print. ~9.6 MB.',
  detector: PP_OCRV6_TINY_DET,
  recognizer: EN_PP_OCRV5_MOBILE_REC,
  charsetUrl: EN_PPOCRV5_CHARSET_YML.url,
  prependBlank: EN_PPOCRV5_CHARSET_YML.prependBlank,
  detectorPreset: PP_OCRV6_TINY_DET_PRESET,
  recognizerPreset: EN_PPOCRV5_REC_PRESET,
  approxTotalBytes: PP_OCRV6_TINY_DET.approxBytes + EN_PP_OCRV5_MOBILE_REC.approxBytes,
}

/**
 * The 3.7 MB bundle: v6 tiny detector + the 2021 `en_number_mobile` recogniser.
 *
 * Under a third of the default's download and about five times faster per crop.
 * It is an old model and it is measurably weaker on ambiguous glyphs, so it is
 * offered rather than defaulted. Note the height-32 input — the recogniser must
 * read `inputHeight` from the preset or it will quietly produce worse text.
 */
export const ULTRA_LIGHT_MODEL_BUNDLE: TicketModelBundle = {
  id: 'ppocr-ultralight-number',
  label: 'Ultra-light (3.7 MB)',
  description:
    'Smallest and fastest. Older weights, weaker on marginal digits. Recogniser input height is 32.',
  detector: PP_OCRV6_TINY_DET,
  recognizer: EN_NUMBER_MOBILE_V2_REC,
  charsetUrl: EN_DICT_CHARSET.url,
  prependBlank: EN_DICT_CHARSET.prependBlank,
  detectorPreset: PP_OCRV6_TINY_DET_PRESET,
  recognizerPreset: EN_NUMBER_MOBILE_V2_REC_PRESET,
  approxTotalBytes: PP_OCRV6_TINY_DET.approxBytes + EN_NUMBER_MOBILE_V2_REC.approxBytes,
}

/**
 * Everything from jsDelivr instead of HuggingFace.
 *
 * Purely an availability hedge: ~15.6 MB, slower on both halves, and a
 * 6625-class charset whose digit indices are scattered. Use it when
 * `huggingface.co` is unreachable — corporate proxies block it far more often
 * than they block a general-purpose CDN.
 */
export const JSDELIVR_FALLBACK_BUNDLE: TicketModelBundle = {
  id: 'ppocr-v4-jsdelivr',
  label: 'PP-OCRv4 via jsDelivr (network fallback)',
  description:
    'Alternative CDN for networks that block HuggingFace. Larger, slower, Chinese charset. ~15.6 MB.',
  detector: CH_PP_OCRV4_DET,
  recognizer: CH_PP_OCRV4_REC,
  charsetUrl: PPOCR_KEYS_V1_CHARSET.url,
  prependBlank: PPOCR_KEYS_V1_CHARSET.prependBlank,
  detectorPreset: CH_PP_OCRV4_DET_PRESET,
  recognizerPreset: CH_PPOCRV4_REC_PRESET,
  approxTotalBytes: CH_PP_OCRV4_DET.approxBytes + CH_PP_OCRV4_REC.approxBytes,
}

/** Every bundle on offer, default first. */
export const MODEL_BUNDLES: readonly TicketModelBundle[] = [
  DEFAULT_MODEL_BUNDLE,
  FAST_MODEL_BUNDLE,
  ULTRA_LIGHT_MODEL_BUNDLE,
  JSDELIVR_FALLBACK_BUNDLE,
]

/* -------------------------------------------------------------------------- */
/* Lookups                                                                     */
/* -------------------------------------------------------------------------- */

const DETECTOR_PRESETS: readonly DetectorPreset[] = [
  PP_OCRV5_MOBILE_DET_PRESET,
  PP_OCRV6_TINY_DET_PRESET,
  CH_PP_OCRV4_DET_PRESET,
]

const RECOGNIZER_PRESETS: readonly RecognizerPreset[] = [
  EN_PPOCRV5_REC_PRESET,
  EN_NUMBER_MOBILE_V2_REC_PRESET,
  CH_PPOCRV4_REC_PRESET,
]

/** Find a detector's constants by `ModelSource.id`. */
export function detectorPresetFor(modelId: string): DetectorPreset | undefined {
  return DETECTOR_PRESETS.find((preset) => preset.modelId === modelId)
}

/** Find a recogniser's constants by `ModelSource.id`. */
export function recognizerPresetFor(modelId: string): RecognizerPreset | undefined {
  return RECOGNIZER_PRESETS.find((preset) => preset.modelId === modelId)
}

export function bundleById(id: string): TicketModelBundle | undefined {
  return MODEL_BUNDLES.find((bundle) => bundle.id === id)
}

/**
 * Accept a preset that arrived on a bundle only if it belongs to those weights.
 *
 * `modelId` exists on both preset shapes for exactly this check, and skipping it
 * is how a stale preset gets through. The realistic way that happens is a caller
 * writing `{ ...DEFAULT_MODEL_BUNDLE, detector: PP_OCRV6_TINY_DET }`: the spread
 * carries v5's preset along, so v6 tiny runs with `box_thresh: 0.6` instead of
 * the 0.4 it publishes and discards most of its boxes — which looks like broken
 * weights, not a misconfiguration, and is therefore expensive to diagnose. The
 * same guard also rejects a malformed object that survived a structured clone
 * without a `modelId`, because an undefined id can never match.
 */
function presetForWeights<T extends { modelId: string }>(
  carried: T | undefined,
  modelId: string,
): T | undefined {
  if (!carried) return undefined
  return carried.modelId === modelId ? carried : undefined
}

/**
 * Recover the full preset-carrying bundle from a plain `ModelBundle`.
 *
 * The worker receives `ModelBundle` because that is what the message protocol
 * declares, and structured clone keeps the extra fields — but the *type* loses
 * them, and a caller that built a bundle by hand may genuinely not have them.
 * This resolves both cases: it trusts presets that are present on the object
 * *and that match the weights they claim to describe*, and otherwise looks them
 * up by model id.
 *
 * Throws rather than guessing when neither is available. There is no safe
 * default: applying v5's `box_thresh` to v6 tiny discards most boxes, and
 * applying the wrong digit map produces confident wrong numbers. A loud failure
 * at startup is strictly better than either.
 */
export function resolveBundle(bundle: ModelBundle): TicketModelBundle {
  const candidate = bundle as Partial<TicketModelBundle> & ModelBundle

  const carriedDetector = presetForWeights(candidate.detectorPreset, bundle.detector.id)
  const carriedRecognizer = presetForWeights(candidate.recognizerPreset, bundle.recognizer.id)

  const detectorPreset = carriedDetector ?? detectorPresetFor(bundle.detector.id)
  const recognizerPreset = carriedRecognizer ?? recognizerPresetFor(bundle.recognizer.id)

  if (!detectorPreset) {
    throw new Error(
      `No detector preset is registered for model id "${bundle.detector.id}"` +
        (candidate.detectorPreset
          ? ` (the bundle carried a preset for "${candidate.detectorPreset.modelId}", which ` +
            'belongs to different weights, so it was discarded rather than applied)'
          : '') +
        '. Add one to src/ocr/models/registry.ts — the DB thresholds and input normalisation ' +
        'are specific to each set of weights and cannot be defaulted.',
    )
  }
  if (!recognizerPreset) {
    throw new Error(
      `No recogniser preset is registered for model id "${bundle.recognizer.id}"` +
        (candidate.recognizerPreset
          ? ` (the bundle carried a preset for "${candidate.recognizerPreset.modelId}", which ` +
            'belongs to different weights, so it was discarded rather than applied)'
          : '') +
        '. Add one to src/ocr/models/registry.ts — the class count, input height and digit ' +
        'index map are specific to each set of weights and cannot be defaulted.',
    )
  }

  const known = bundleById(candidate.id ?? '')

  return {
    ...bundle,
    id: candidate.id ?? `${bundle.detector.id}+${bundle.recognizer.id}`,
    label: candidate.label ?? known?.label ?? bundle.recognizer.name,
    description: candidate.description ?? known?.description ?? '',
    detectorPreset,
    recognizerPreset,
    approxTotalBytes:
      candidate.approxTotalBytes ?? bundle.detector.approxBytes + bundle.recognizer.approxBytes,
  }
}

/**
 * Overlay a detector preset onto the user-facing options.
 *
 * `DetectorOptions` is what the UI exposes and what a caller may tune, so the
 * preset supplies the defaults rather than overriding deliberate choices — but
 * only for the fields a preset actually owns. `minBoxSize` is a pipeline concern
 * (it depends on how far the page was downscaled, not on the weights), so it is
 * passed through untouched.
 *
 * `limitSideLen` is the one field that cannot always be filled in, because
 * `DetectorOptions` can express exactly one resize rule — "scale the **long**
 * side to this" — and {@link DetectorResizeRule} carries two. A
 * `limit-side-len` preset with `limitType: 'min'` means the opposite of what
 * the field says: scale the **short** side *up* to `sideLen` and never
 * downscale. Copying its 736 into `limitSideLen` would tell the detector to
 * shrink a 1600×1200 page to roughly 736×576 where PaddleOCR would have fed it
 * at its native 1600×1216 — a linear factor of two on glyphs that are already
 * only a couple of dozen pixels tall, which is the difference between a box per
 * number and no boxes at all. Since a short-side *floor* never reduces the
 * input, leaving the caller's own long-side budget in place is the faithful
 * reading of the rule, not a compromise. Move this back into the preset the day
 * `DetectorOptions` grows a `limitType`.
 */
export function applyDetectorPreset(
  preset: DetectorPreset,
  options: DetectorOptions,
  overrides: Partial<DetectorOptions> = {},
): DetectorOptions {
  const longSideRule =
    preset.resize.mode === 'resize-long' || preset.resize.limitType === 'max'

  return {
    ...options,
    ...(longSideRule ? { limitSideLen: preset.resize.sideLen } : {}),
    binaryThreshold: preset.db.binaryThreshold,
    boxThreshold: preset.db.boxThreshold,
    unclipRatio: preset.db.unclipRatio,
    maxCandidates: preset.db.maxCandidates,
    ...overrides,
  }
}

/**
 * Overlay a recogniser preset onto the user-facing options.
 *
 * `inputHeight` is forced rather than merged: it is baked into the graph (48 for
 * every modern PP-OCR recogniser) and the one model that tolerates a wrong value
 * degrades silently instead of throwing. `digitsOnly` and `batchSize` stay with
 * the caller — the first is a product decision, and the second is irrelevant to
 * throughput on WASM anyway (measured: 47.3 ms per crop at batch 1, 47.7 at
 * batch 8), so it is only a latency/responsiveness knob.
 */
export function applyRecognizerPreset(
  preset: RecognizerPreset,
  options: RecognizerOptions,
  overrides: Partial<RecognizerOptions> = {},
): RecognizerOptions {
  return {
    ...options,
    inputHeight: preset.inputHeight,
    maxInputWidth: preset.maxInputWidth,
    ...overrides,
  }
}

/** The digit class indices, ordered `'0'` … `'9'`, for masked CTC decoding. */
export function digitClassIndices(preset: RecognizerPreset): number[] {
  const digits: DigitChar[] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
  return digits.map((digit) => preset.digitIndices[digit])
}

/* -------------------------------------------------------------------------- */
/* Self-hosting                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Where a self-hosted copy of the weights is expected to live, relative to the
 * app root. Vite serves `public/models/*` from here verbatim.
 */
export const SELF_HOSTED_BASE = '/models/'

export interface SelfHostedAsset {
  /** File name under {@link SELF_HOSTED_BASE}. */
  fileName: string
  /** Canonical upstream URL to mirror from. */
  sourceUrl: string
  /**
   * Expected size in bytes, so a mirroring script can verify what it fetched.
   * `null` means the size was never measured — the CDNs that serve the text
   * dictionaries send them gzipped, so a `HEAD` reports the compressed length
   * rather than the file's own. A script must treat `null` as "do not check",
   * not as "zero bytes".
   */
  approxBytes: number | null
}

/**
 * The download list for a mirroring script.
 *
 * Keep the names stable: they are what {@link withSelfHostedModels} builds its
 * local URLs from, and a rename silently turns the local copy into a 404 that
 * then falls through to the remote URL — which is the exact situation
 * self-hosting was meant to avoid.
 */
export const SELF_HOSTED_MANIFEST: readonly SelfHostedAsset[] = [
  {
    fileName: 'pp-ocrv5-mobile-det.onnx',
    sourceUrl: PP_OCRV5_MOBILE_DET.urls[0],
    approxBytes: PP_OCRV5_MOBILE_DET.approxBytes,
  },
  {
    fileName: 'pp-ocrv6-tiny-det.onnx',
    sourceUrl: PP_OCRV6_TINY_DET.urls[0],
    approxBytes: PP_OCRV6_TINY_DET.approxBytes,
  },
  {
    fileName: 'ch-pp-ocrv4-det.onnx',
    sourceUrl: CH_PP_OCRV4_DET.urls[0],
    approxBytes: CH_PP_OCRV4_DET.approxBytes,
  },
  {
    fileName: 'en-pp-ocrv5-mobile-rec.onnx',
    sourceUrl: EN_PP_OCRV5_MOBILE_REC.urls[0],
    approxBytes: EN_PP_OCRV5_MOBILE_REC.approxBytes,
  },
  {
    fileName: 'en-number-mobile-v2-rec.onnx',
    sourceUrl: EN_NUMBER_MOBILE_V2_REC.urls[0],
    approxBytes: EN_NUMBER_MOBILE_V2_REC.approxBytes,
  },
  {
    fileName: 'ch-pp-ocrv4-rec.onnx',
    sourceUrl: CH_PP_OCRV4_REC.urls[0],
    approxBytes: CH_PP_OCRV4_REC.approxBytes,
  },
  {
    fileName: 'en-pp-ocrv5-rec.inference.yml',
    sourceUrl: EN_PPOCRV5_CHARSET_YML.url,
    approxBytes: 3_964,
  },
  {
    fileName: 'en-pp-ocrv5-rec.dict.txt',
    sourceUrl: EN_PPOCRV5_CHARSET_TXT.url,
    approxBytes: 1_419,
  },
  { fileName: 'en_dict.txt', sourceUrl: EN_DICT_CHARSET.url, approxBytes: 190 },
  { fileName: 'ppocr_keys_v1.txt', sourceUrl: PPOCR_KEYS_V1_CHARSET.url, approxBytes: 26_249 },
]

/** Reverse index: upstream URL → local file name. */
const LOCAL_NAME_BY_URL = new Map(
  SELF_HOSTED_MANIFEST.map((asset) => [asset.sourceUrl, asset.fileName]),
)

function localUrlFor(remoteUrl: string, base: string): string | null {
  const fileName = LOCAL_NAME_BY_URL.get(remoteUrl)
  return fileName ? `${base}${fileName}` : null
}

function rewriteSource(source: ModelSource, base: string, exclusive: boolean): ModelSource {
  const local = source.urls.map((url) => localUrlFor(url, base)).filter((url): url is string => url !== null)
  // Deduplicate: several mirrors of one model map to the same local file, and a
  // repeated URL would make `fetchModel` retry a 404 it has already seen.
  const unique = [...new Set(local)]
  return {
    ...source,
    urls: exclusive && unique.length > 0 ? unique : [...unique, ...source.urls],
  }
}

function rewriteCharsets(
  charsets: readonly CharsetSource[],
  base: string,
): readonly CharsetSource[] {
  return charsets.map((charset) => {
    const local = localUrlFor(charset.url, base)
    return local ? { ...charset, url: local } : charset
  })
}

export interface SelfHostOptions {
  /**
   * Defaults to {@link SELF_HOSTED_BASE}. A missing trailing slash is added
   * rather than trusted, see {@link withSelfHostedModels}.
   */
  base?: string
  /**
   * Drop the remote mirrors entirely instead of keeping them behind the local
   * copies. Set this on a cross-origin-isolated deploy: under `COEP:
   * require-corp` the remote fetches cannot succeed, so leaving them in the list
   * only turns a fast local failure into several slow network ones.
   */
  exclusive?: boolean
}

/**
 * Point a bundle at locally served copies of its weights.
 *
 * By default the local URLs are *prepended*, so a mirror that has not been
 * populated yet falls through to the CDN and the app still works — the usual
 * development case. Pass `exclusive` for a production build that sets COOP/COEP
 * to unlock WASM threads, where the CDN URLs cannot work at all.
 */
export function withSelfHostedModels(
  bundle: TicketModelBundle,
  options: SelfHostOptions = {},
): TicketModelBundle {
  // The base is concatenated with a bare file name, so `'/models'` would yield
  // `/modelspp-ocrv5-mobile-det.onnx`. Without `exclusive` that merely wastes a
  // 404 before the CDN fallback, but with it the malformed path is the *only*
  // URL left and the bundle becomes unloadable — a whole deployment broken by a
  // missing character. Normalising costs nothing and removes the trap.
  const rawBase = options.base ?? SELF_HOSTED_BASE
  const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`
  const exclusive = options.exclusive ?? false

  const charsets = rewriteCharsets(bundle.recognizerPreset.charsets, base)

  return {
    ...bundle,
    id: `${bundle.id}-self-hosted`,
    detector: rewriteSource(bundle.detector, base, exclusive),
    recognizer: rewriteSource(bundle.recognizer, base, exclusive),
    charsetUrl: localUrlFor(bundle.charsetUrl, base) ?? bundle.charsetUrl,
    recognizerPreset: { ...bundle.recognizerPreset, charsets },
  }
}
