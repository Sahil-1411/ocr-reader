/**
 * DBNet text detection (PP-OCRv5_mobile_det) on ONNX Runtime Web.
 *
 * The model is a fully-convolutional differentiable-binarization detector: it
 * consumes a normalised NCHW image and emits a single-channel probability map at
 * the *same* spatial resolution as its input. Everything interesting happens
 * afterwards, in the postprocess — turning that probability map into quads is
 * where every published port of PaddleOCR goes wrong, so each step below cites
 * the PaddleOCR source it reproduces and says what breaks when it is off.
 *
 * Four details are worth reading before touching this file:
 *
 *   · **The model eats BGR.** PaddleOCR decodes with `cv2.imread`, so the
 *     ImageNet mean/std are applied to the B, G, R planes *in that index order*.
 *     The pairing is arguably wrong, but it is what the weights were fitted to,
 *     and on a ticket whose watermark lives almost entirely in the red channel
 *     it is the difference between suppressing the overprint and amplifying it.
 *
 *   · **The preprocessing constants belong to the weights, not to this file.**
 *     Two mutually incompatible detector normalisations are in the wild and both
 *     are "correct": PaddlePaddle's official configs say ImageNet statistics,
 *     RapidOCR's shipped config (which is the lineage the `@gutenye` PP-OCRv4
 *     weights come through) says a flat `(x/255 - 0.5)/0.5`. The resize stride
 *     splits the same way — 128 for the `resize_long` path, 32 for the
 *     `limit_side_len` path. `models/registry.ts` already records both per model
 *     in `DetectorPreset`, so they are read from there rather than hardcoded;
 *     the values below are only the fallback for a model the registry has never
 *     heard of. Mixing the two costs recall exactly where this app cannot afford
 *     it — faint digits left behind after watermark suppression.
 *
 *   · **The DB head already applies sigmoid at inference.** `det_db_head.py`
 *     ends with `x = F.sigmoid(x)` when not training, so the output is already in
 *     [0, 1]. A second sigmoid squeezes everything towards 0.62, the 0.3 binary
 *     threshold then fires on the entire page, and you get one contour the size
 *     of the image.
 *
 *   · **`cv.boxPoints` does not exist in OpenCV.js.** It is simply not in
 *     `platforms/js/opencv_js.config.py`. The corners are computed in JS here
 *     rather than via `cv.RotatedRect.points`, because that helper lives in the
 *     JS glue rather than the WASM binary and its presence varies by build.
 *
 *   · **`cv.minAreaRect`'s angle range is build-dependent** — [0, 90) on OpenCV
 *     4.5.0–4.12.0, [-90, 0) on current 4.x HEAD. Any code that branches on the
 *     sign silently deskews by 90° on the other build, so angles are folded into
 *     (-45, 45] before anyone looks at them.
 */

import type { InferenceSession } from 'onnxruntime-web'

import { fetchModel } from '../models/cache'
import { detectorPresetFor } from '../models/registry'
import type { CV } from '../opencv/loader'
import { using } from '../opencv/scope'
import type { Box, DetectedBox, DetectorOptions, ModelBundle, Point } from '../types'
import type { TextDetector } from './contracts'
import { createSession, float32Tensor, releaseSession, runSingleInput } from './runtime'

type Mat = InstanceType<CV['Mat']>
type Quad = [Point, Point, Point, Point]

/* -------------------------------------------------------------------------- */
/* Preprocessing constants — per weights, not per file                         */
/* -------------------------------------------------------------------------- */

/**
 * Everything about turning a page `Mat` into this model's input tensor.
 *
 * All of it is a property of *the weights*, not of DBNet, which is why none of
 * it is hardcoded in the resize/pack functions below. `DetectorOptions` cannot
 * carry these — it is the user-tunable surface, and a slider must not be able to
 * put the normalisation out of step with the checkpoint — so they come from
 * `models/registry.ts`'s `DetectorPreset`, keyed on `ModelSource.id`.
 */
interface Preprocessing {
  /** Subtracted per plane after scaling to [0, 1]. */
  mean: readonly [number, number, number]
  /** Divides per plane after the mean is subtracted. */
  std: readonly [number, number, number]
  /** Plane order fed to the graph; `mean`/`std` stay in published order. */
  channelOrder: 'rgb' | 'bgr'
  /** Each axis is rounded to a multiple of this after scaling. */
  stride: number
  /**
   * `resize_image_type2` (the `resize_long` path) rounds **up**;
   * `resize_image_type0` (the `limit_side_len` path) rounds to **nearest**.
   */
  rounding: 'up' | 'nearest'
  /**
   * `resize_image_type0` applies the ratio only when the page already exceeds
   * the limit; `resize_image_type2` always applies it, upscaling a small page to
   * the training scale rather than feeding it at its native size.
   */
  shrinkOnly: boolean
  /** `max_side_limit`, a guard against a pathological source asking for a 40 000-pixel tensor. */
  maxSide: number
}

/**
 * What to use when the registry has never heard of this model id.
 *
 * These are PP-OCRv5_mobile_det's own numbers, from
 * `PaddlePaddle/PP-OCRv5_mobile_det_onnx/inference.yml`:
 * `DecodeImage{ img_mode: BGR }`, `DetResizeForTest{ resize_long: 960 }`,
 * `NormalizeImage{ mean: [0.485,0.456,0.406], std: [0.229,0.224,0.225],
 * scale: 1./255., order: hwc }`. It is the default bundle, so it is the least
 * surprising thing to assume — but it is an assumption, and a PP-OCRv4 export
 * from the RapidOCR lineage wants a flat 0.5/0.5 instead.
 *
 * The stride is the single most easily mis-copied number here. `resize_long`
 * selects `resize_image_type2`, which rounds each axis **up to a multiple of
 * 128**; the familiar round-to-nearest-32 rule belongs to `resize_image_type0`,
 * which this config does not use. Using 32 still runs — the graph is fully
 * convolutional — but it is not the geometry the weights were calibrated on, and
 * the probability map comes out subtly blurrier at the blob edges, which costs
 * small boxes at the `boxThreshold` gate.
 *
 * `maxSide` is the TensorRT dynamic-shape ceiling from the same yml
 * (`x`: min [1,3,32,32], opt [1,3,736,736], max [1,3,4000,4000]).
 */
const DEFAULT_PREPROCESSING: Preprocessing = {
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
  channelOrder: 'bgr',
  stride: 128,
  rounding: 'up',
  shrinkOnly: false,
  maxSide: 4000,
}

/**
 * Resolve a model's preprocessing from the registry, or fall back.
 *
 * `DetectorPreset.resize.mode` is the join between the two PaddleOCR resize
 * functions: `resize-long` is `resize_image_type2` (round up, always rescale),
 * anything else is `resize_image_type0` (round to nearest, only shrink). The
 * *target* long side still comes from `DetectorOptions.limitSideLen` rather than
 * from `preset.resize.sideLen`, because `applyDetectorPreset` deliberately
 * withholds `sideLen` for the `limitType: 'min'` presets — see the long comment
 * there for why a short-side floor must not be read as a long-side budget.
 */
function preprocessingFor(modelId: string): Preprocessing {
  const preset = detectorPresetFor(modelId)
  if (!preset) return DEFAULT_PREPROCESSING

  if (preset.normalization.channels !== 3) {
    throw new Error(
      `The ${modelId} detector preset declares ${preset.normalization.channels} input ` +
        'channel(s); this module packs a 3-plane NCHW tensor and would feed the graph ' +
        'the wrong shape.',
    )
  }

  const longSideRule = preset.resize.mode === 'resize-long'
  return {
    mean: preset.normalization.mean,
    std: preset.normalization.std,
    channelOrder: preset.normalization.channelOrder,
    stride: preset.resize.sizeMultiple,
    rounding: longSideRule ? 'up' : 'nearest',
    shrinkOnly: !longSideRule,
    maxSide: preset.resize.maxSideLimit,
  }
}

/* -------------------------------------------------------------------------- */
/* Construction                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Download the detector weights and build a {@link TextDetector} around them.
 *
 * `options` is kept as the defaults for `detect`, which is handed a fresh
 * `DetectorOptions` on every call; the per-call values win, so a UI slider can
 * retune the thresholds without rebuilding the session.
 */
export async function createDetector(
  models: ModelBundle,
  options: DetectorOptions,
): Promise<TextDetector> {
  // Resolved before the download so a preset this module cannot honour (a
  // single-channel detector) fails immediately rather than after 4.8 MB.
  const preprocessing = preprocessingFor(models.detector.id)

  const weights = await fetchModel(models.detector)
  // `createSession` owns the execution-provider choice, the WebGPU→WASM retry
  // and the "these bytes are not a model" check, so none of that is repeated
  // here; it also guarantees `initRuntime` has configured `env.wasm` first.
  const session = await createSession(weights, models.detector.name)

  let disposed = false
  // ORT serialises concurrent `run` calls internally, but interleaving two
  // inferences on one session makes the WASM heap high-water mark the sum of
  // both tensors — enough to matter on a phone. One at a time.
  let queue: Promise<unknown> = Promise.resolve()

  return {
    name: models.detector.name,

    detect(cv: CV, page: Mat, callOptions: DetectorOptions): Promise<DetectedBox[]> {
      if (disposed) {
        return Promise.reject(new Error('The text detector has already been disposed'))
      }
      const merged: DetectorOptions = { ...options, ...callOptions }
      const result = queue.then(() =>
        runDetection(cv, session, models.detector.name, page, merged, preprocessing),
      )
      // Keep the chain alive after a failure, otherwise one bad image wedges
      // every later call behind a rejected promise.
      queue = result.catch(() => undefined)
      return result
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      // Release *behind* the queue, not alongside it. `session.release()` frees
      // the WASM-side session object, and an inference started before dispose is
      // still reading it — tearing it down mid-`run` is a use-after-free in the
      // Emscripten heap, which surfaces as a memory-access abort rather than a
      // catchable error. Setting `disposed` first means no new work can join the
      // chain, so this settles as soon as the in-flight image finishes.
      //
      // `queue` is always the `.catch(…)`-wrapped tail, so it never rejects, and
      // `releaseSession` is async but deliberately never rejects either — there
      // is nobody to await this on a teardown path.
      void queue.then(() => releaseSession(session, models.detector.name))
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Inference                                                                   */
/* -------------------------------------------------------------------------- */

async function runDetection(
  cv: CV,
  session: InferenceSession,
  label: string,
  page: Mat,
  options: DetectorOptions,
  preprocessing: Preprocessing,
): Promise<DetectedBox[]> {
  const pageWidth = page.cols
  const pageHeight = page.rows
  if (pageWidth < 1 || pageHeight < 1) return []

  const net = networkSize(pageWidth, pageHeight, options.limitSideLen, preprocessing)
  const input = toNetworkInput(cv, page, net.width, net.height, preprocessing)

  // `runSingleInput` reads the tensor names off the session. They are not
  // portable: the official PaddlePaddle v5/v6 exports call the output
  // `fetch_name_0`, the @gutenye PP-OCRv4 export calls it `sigmoid_0.tmp_0`,
  // and the 2021-era models use yet another name.
  const probability = await runSingleInput(
    session,
    float32Tensor(input, [1, 3, net.height, net.width]),
    label,
  )

  const map = probabilityMapShape(probability.dims)
  const data = probability.data
  if (!(data instanceof Float32Array)) {
    throw new Error(`Expected a float32 probability map, got ${probability.type}`)
  }
  if (data.length < map.width * map.height) {
    throw new Error(
      `Probability map is ${data.length} values but its dims imply ${map.width * map.height}`,
    )
  }

  return boxesFromProbabilityMap(cv, data, map, pageWidth, pageHeight, options)
}

/* -------------------------------------------------------------------------- */
/* Preprocessing                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Reproduce PaddleOCR's detection resize: scale the long side to `resizeLong`,
 * truncate, then round each axis to a multiple of the model's stride.
 *
 * Both of PaddleOCR's resize functions live here, selected by `preprocessing`:
 * `resize_image_type2` (the `resize_long` path) rounds **up** and always applies
 * the ratio, so a small page is upscaled to the training scale rather than fed
 * at its native size; `resize_image_type0` (the `limit_side_len` path) rounds to
 * **nearest** and only ever shrinks. Running one model's weights through the
 * other's geometry does not throw — the graph is fully convolutional — it just
 * shifts every blob edge by a pixel or two, which on two-digit crops is a real
 * accuracy difference.
 *
 * The two axes are rounded independently, so the aspect ratio is deliberately
 * distorted by up to one stride. That is why nothing downstream may use a single
 * scale factor — `boxesFromProbabilityMap` maps x and y back through their own
 * ratios, which is exactly what PaddleOCR's `box[:,0] / width * dest_width` does.
 */
function networkSize(
  srcWidth: number,
  srcHeight: number,
  resizeLong: number,
  preprocessing: Preprocessing,
): { width: number; height: number } {
  const longest = Math.max(srcWidth, srcHeight)
  const ratio =
    preprocessing.shrinkOnly && longest <= resizeLong ? 1 : resizeLong / longest
  return {
    width: toStride(Math.trunc(srcWidth * ratio), preprocessing),
    height: toStride(Math.trunc(srcHeight * ratio), preprocessing),
  }
}

function toStride(value: number, preprocessing: Preprocessing): number {
  const { stride, rounding, maxSide } = preprocessing
  const strided =
    rounding === 'up'
      ? Math.ceil(value / stride) * stride
      : Math.round(value / stride) * stride
  // The ceiling is floored back onto the stride grid: 4000 is not a multiple of
  // 128, and clamping to it would hand the graph the one un-strided side this
  // whole function exists to prevent.
  const ceiling = Math.max(stride, Math.floor(maxSide / stride) * stride)
  return Math.min(ceiling, Math.max(stride, strided))
}

/**
 * Resize the page and pack it as planar float32, normally in **BGR** order.
 *
 * `page` arrives as an RGB `Mat` (see `TextDetector.detect`), so under the usual
 * `channelOrder: 'bgr'` plane 0 takes the *third* byte of each pixel while still
 * being normalised with `mean[0]` / `std[0]`. That apparently-wrong pairing is
 * the point: PaddleOCR publishes the ImageNet triple in RGB order and then
 * applies it positionally to a `cv2.imread` BGR array, and the weights were
 * fitted against exactly that. Getting it backwards does not crash and does not
 * obviously degrade clean scans — it quietly costs recall on precisely the
 * coloured, low-contrast regions this pipeline exists to handle.
 */
function toNetworkInput(
  cv: CV,
  page: Mat,
  width: number,
  height: number,
  preprocessing: Preprocessing,
): Float32Array {
  return using((scope) => {
    const resized = scope.add(new cv.Mat())
    // cv2.resize's default is bilinear, and PaddleOCR never overrides it.
    cv.resize(page, resized, new cv.Size(width, height), 0, 0, cv.INTER_LINEAR)

    const rgb = scope.add(new cv.Mat())
    const channels = resized.channels()
    if (channels === 3) {
      resized.copyTo(rgb)
    } else {
      cv.cvtColor(resized, rgb, channels === 4 ? cv.COLOR_RGBA2RGB : cv.COLOR_GRAY2RGB)
    }

    const pixels = rgb.data
    const plane = width * height
    const out = new Float32Array(3 * plane)

    const { mean, std, channelOrder } = preprocessing
    // Byte offset within each RGB pixel that feeds plane 0, 1 and 2. Hoisted out
    // of the loop because this runs once per pixel of a ~1024×768 tensor.
    const bgr = channelOrder === 'bgr'
    const source0 = bgr ? 2 : 0
    const source2 = bgr ? 0 : 2

    for (let i = 0, p = 0; i < plane; i++, p += 3) {
      out[i] = (pixels[p + source0] / 255 - mean[0]) / std[0]
      out[plane + i] = (pixels[p + 1] / 255 - mean[1]) / std[1]
      out[2 * plane + i] = (pixels[p + source2] / 255 - mean[2]) / std[2]
    }

    return out
  })
}

/**
 * Read the map's spatial dims out of the tensor rather than assuming them.
 *
 * The DB head upsamples 4× from the 1/4-scale neck, so in practice the map is
 * exactly the network input size — but the mapping back to page coordinates
 * below divides by these numbers, so taking them from the tensor makes the whole
 * postprocess correct even if a future export emits a quarter-scale map.
 */
function probabilityMapShape(dims: readonly number[]): { width: number; height: number } {
  if (dims.length < 2) {
    throw new Error(`Probability map has an unusable shape [${dims.join(', ')}]`)
  }
  const width = dims[dims.length - 1]
  const height = dims[dims.length - 2]
  // A zero or negative spatial dim would pass the byte-count check below
  // (`length < 0` is never true) and then reach `new cv.Mat(0, 0, …)` and
  // `findContours`, where OpenCV.js aborts by throwing a raw heap pointer — an
  // integer, not an `Error`, which the pipeline renders as a bare number with
  // nothing in it to act on. Say what actually went wrong instead.
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error(
      `Probability map has no usable spatial extent (dims [${dims.join(', ')}]); ` +
        'the detector export is probably not a DB model emitting [N, 1, H, W].',
    )
  }
  return { width, height }
}

/* -------------------------------------------------------------------------- */
/* DB postprocessing                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Turn the probability map into page-space boxes.
 *
 * This is a port of `db_postprocess.py::boxes_from_bitmap` with the constants
 * from `tools/infer/utility.py` (the *inference* defaults — the `DBPostProcess`
 * class defaults of box_thresh 0.7 / unclip 2.0 are never used by PaddleOCR
 * itself and copying them gives an over-tight score gate and boxes ~35% too big).
 */
function boxesFromProbabilityMap(
  cv: CV,
  probability: Float32Array,
  map: { width: number; height: number },
  pageWidth: number,
  pageHeight: number,
  options: DetectorOptions,
): DetectedBox[] {
  const boxes: DetectedBox[] = []

  using((scope) => {
    const binary = scope.add(new cv.Mat(map.height, map.width, cv.CV_8UC1))
    const mask = binary.data
    for (let i = 0, n = map.width * map.height; i < n; i++) {
      // No sigmoid here — the exported graph already applied one.
      mask[i] = probability[i] > options.binaryThreshold ? 255 : 0
    }

    const contours = scope.add(new cv.MatVector())
    const hierarchy = scope.add(new cv.Mat())
    cv.findContours(binary, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE)

    const candidates = Math.min(contours.size(), Math.max(0, options.maxCandidates))

    for (let i = 0; i < candidates; i++) {
      const box = using((inner): DetectedBox | null => {
        const contour = inner.add(contours.get(i))
        // A rectangle needs three distinct points; anything less is a speck that
        // minAreaRect would turn into a degenerate rect anyway.
        if (contour.rows < 3) return null

        const rect = cv.minAreaRect(contour)

        // Gate 1: `sside < min_size` (3) on the *shrunk* rect, before unclip.
        const shortSide = Math.min(rect.size.width, rect.size.height)
        if (shortSide < options.minBoxSize) return null

        // PaddleOCR scores the pre-unclip quad against the RAW probabilities,
        // not the binarised mask, so a blob that only just cleared 0.3
        // everywhere is rejected while a confident one survives.
        const tight = orderMiniBox(rectCorners(rect))
        const score = meanProbabilityInside(probability, map, tight)
        // Written as a negated `>=` rather than `<` so that a NaN score fails the
        // gate. NaN compares false against everything, so `score < threshold`
        // would *admit* a poisoned box and write NaN into `DetectedBox.score` —
        // which then survives every downstream filter (`confidence <
        // minConfidence` is also false for NaN) and serialises as `null` in the
        // public JSON. A NaN probability map is not hypothetical: it is what a
        // half-overflowed fp16 WebGPU kernel or a badly quantised export
        // produces. Failing closed here means such a run reports "nothing
        // detected" and falls back to the classical detector, which is a
        // symptom someone can act on.
        if (!(score >= options.boxThreshold)) return null

        const expanded = unclip(rect, options.unclipRatio)

        // Gate 2: `sside < min_size + 2` (5) on the *expanded* rect. The two
        // gates are genuinely different numbers. Using 3 in both places lets
        // slivers of watermark edge through; using 5 in both drops real
        // single-digit boxes before they are ever expanded to their true size.
        const expandedShortSide = Math.min(expanded.size.width, expanded.size.height)
        if (expandedShortSide < options.minBoxSize + 2) return null

        const polygon = orderMiniBox(rectCorners(expanded)).map((point) =>
          toPageSpace(point, map, pageWidth, pageHeight),
        ) as Quad

        return {
          id: boxes.length,
          box: boundsOf(polygon),
          polygon,
          // Derived from the mapped quad rather than from `rect.angle`: the two
          // axes are scaled by slightly different ratios on the way back, which
          // shears the rectangle by a fraction of a degree. The crop stage warps
          // based on this value, so it should describe the quad it will actually
          // receive.
          angle: normalizeAngle(edgeAngle(polygon[0], polygon[1])),
          score,
        }
      })

      if (box) boxes.push(box)
    }
  })

  return boxes
}

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                            */
/* -------------------------------------------------------------------------- */

interface RotatedRectLike {
  center: { x: number; y: number }
  size: { width: number; height: number }
  angle: number
}

/**
 * The four corners of a rotated rectangle, computed in JS.
 *
 * `cv.boxPoints` is absent from OpenCV.js and `cv.RotatedRect.points` lives in
 * the JS glue rather than the WASM module, so its availability depends on how
 * the distribution was assembled. Twelve lines of trigonometry work everywhere.
 */
function rectCorners(rect: RotatedRectLike): Quad {
  const radians = (rect.angle * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const halfWidth = rect.size.width / 2
  const halfHeight = rect.size.height / 2

  const corner = (dx: number, dy: number): Point => ({
    x: rect.center.x + dx * cos - dy * sin,
    y: rect.center.y + dx * sin + dy * cos,
  })

  return [
    corner(-halfWidth, -halfHeight),
    corner(halfWidth, -halfHeight),
    corner(halfWidth, halfHeight),
    corner(-halfWidth, halfHeight),
  ]
}

/**
 * PaddleOCR's `get_mini_boxes` ordering: sort by x, then pair up by y to get
 * approximately top-left, top-right, bottom-right, bottom-left.
 *
 * "Approximately" is the operative word for a near-square box, where the x sort
 * is decided by sub-pixel noise — but the crop stage builds its perspective
 * transform from this order, so it has to match what the rest of the pipeline
 * (and PaddleOCR) expects: clockwise, starting top-left.
 */
function orderMiniBox(points: Quad): Quad {
  const byX = [...points].sort((a, b) => a.x - b.x)
  const [first, second] = byX[1].y > byX[0].y ? [0, 1] : [1, 0]
  const [third, fourth] = byX[3].y > byX[2].y ? [2, 3] : [3, 2]
  return [byX[first], byX[third], byX[fourth], byX[second]]
}

/**
 * The Vatti offset PaddleOCR applies, without a Clipper library.
 *
 * DB is trained on *shrunk* polygons, so the blobs in the probability map are
 * much smaller than the text: `make_shrink_map.py` erodes each ground-truth
 * polygon by `area * (1 - 0.4²) / perimeter`. The unclip undoes that with
 * `distance = area * unclipRatio / perimeter`.
 *
 * PaddleOCR feeds the quad through `pyclipper` with round joins and then
 * immediately re-runs `get_mini_boxes` on the result, which discards the rounded
 * corners — so for a rectangle the whole thing collapses to "grow by `distance`
 * on every side", i.e. (w + 2d) × (h + 2d) at the same centre and angle. The
 * corner arcs are tangent to the offset edges and contribute nothing to the
 * min-area rect, which makes this an exact replacement rather than an
 * approximation.
 *
 * For a typical two-digit keno crop of 46 × 26 at ratio 1.5 this is d ≈ 12.5,
 * nearly doubling the height. That looks alarming and is correct.
 */
function unclip(rect: RotatedRectLike, unclipRatio: number): RotatedRectLike {
  const { width, height } = rect.size
  const perimeter = 2 * (width + height)
  if (perimeter <= 0) return rect

  const distance = (width * height * unclipRatio) / perimeter
  return {
    center: rect.center,
    angle: rect.angle,
    size: { width: width + 2 * distance, height: height + 2 * distance },
  }
}

/**
 * `box_score_fast`: the mean **raw** probability inside the quad, evaluated over
 * the quad's axis-aligned bounding box and masked by the polygon.
 *
 * Scoring the binarised mask instead would return 1.0 for every candidate and
 * make `boxThreshold` a no-op — which presents as "the detector finds hundreds
 * of boxes and none of them are text".
 */
function meanProbabilityInside(
  probability: Float32Array,
  map: { width: number; height: number },
  quad: Quad,
): number {
  const xs = quad.map((p) => p.x)
  const ys = quad.map((p) => p.y)
  const xMin = clamp(Math.floor(Math.min(...xs)), 0, map.width - 1)
  const xMax = clamp(Math.ceil(Math.max(...xs)), 0, map.width - 1)
  const yMin = clamp(Math.floor(Math.min(...ys)), 0, map.height - 1)
  const yMax = clamp(Math.ceil(Math.max(...ys)), 0, map.height - 1)
  if (xMax < xMin || yMax < yMin) return 0

  // `orderMiniBox` can emit either winding depending on where the corners landed,
  // so the inside test is taken relative to the quad's own signed area instead of
  // assuming clockwise.
  let twiceArea = 0
  for (let i = 0; i < 4; i++) {
    const a = quad[i]
    const b = quad[(i + 1) & 3]
    twiceArea += a.x * b.y - b.x * a.y
  }
  const winding = twiceArea >= 0 ? 1 : -1

  let sum = 0
  let count = 0
  for (let y = yMin; y <= yMax; y++) {
    const centreY = y + 0.5
    for (let x = xMin; x <= xMax; x++) {
      const centreX = x + 0.5
      let inside = true
      for (let i = 0; i < 4; i++) {
        const a = quad[i]
        const b = quad[(i + 1) & 3]
        const cross = (b.x - a.x) * (centreY - a.y) - (b.y - a.y) * (centreX - a.x)
        if (cross * winding < 0) {
          inside = false
          break
        }
      }
      if (inside) {
        sum += probability[y * map.width + x]
        count++
      }
    }
  }

  return count > 0 ? sum / count : 0
}

/**
 * Map a probability-map coordinate back onto the page.
 *
 * The x and y ratios are applied separately because `networkSize` rounded the
 * two axes independently; collapsing them into one scale factor shears every box
 * by up to a stride's worth of aspect error.
 */
function toPageSpace(
  point: Point,
  map: { width: number; height: number },
  pageWidth: number,
  pageHeight: number,
): Point {
  return {
    x: clamp(Math.round((point.x / map.width) * pageWidth), 0, pageWidth),
    y: clamp(Math.round((point.y / map.height) * pageHeight), 0, pageHeight),
  }
}

function boundsOf(quad: Quad): Box {
  const xs = quad.map((p) => p.x)
  const ys = quad.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

/** Signed angle of the segment `from → to`, in degrees. */
function edgeAngle(from: Point, to: Point): number {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI
}

/**
 * Fold an angle into (-45, 45].
 *
 * A rotated rectangle is invariant under 90° turns, so "the same" box can be
 * reported as 3°, 93° or -87° depending on the OpenCV build and on which corner
 * the x sort happened to pick first. Normalising here means no caller ever has
 * to branch on the sign — the trap that silently rotates crops by a quarter turn
 * when the OpenCV version changes underneath.
 */
function normalizeAngle(degrees: number): number {
  let angle = degrees % 90
  if (angle > 45) angle -= 90
  if (angle <= -45) angle += 90
  return angle
}

function clamp(value: number, low: number, high: number): number {
  if (value < low) return low
  if (value > high) return high
  return value
}
