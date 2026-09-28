# Ticket OCR

Reads multi-column number tickets — keno, lottery, bingo — from a photo, and returns
structured JSON. Everything runs in the browser: **no image ever leaves the device**.

It is built for the conditions these photos are actually taken in: a heavy coloured
watermark stamped over the numbers, the camera held at an angle, a few degrees of tilt,
and a lighting gradient across the page.

```json
{
  "columns": [
    { "columnIndex": 1, "numbers": ["12", "34", "56"] },
    { "columnIndex": 2, "numbers": ["78", "90", "11"] },
    { "columnIndex": 3, "numbers": ["22", "33", "44"] }
  ],
  "rawDetections": [ /* every box, with scores and why it was kept or dropped */ ],
  "processingMeta": {
    "tiltCorrected": true,
    "perspectiveCorrected": true,
    "watermarkSuppressed": true
  }
}
```

`processingMeta` carries considerably more than the three required flags — timings per
stage, the detected document quad, the execution provider actually used, and a `warnings`
array. See [The output contract](#the-output-contract).

## Quick start

```bash
pnpm install
pnpm dev
```

Open the app and press **Generate test ticket**. That renders a three-column ticket with
known contents, damages it (red `VOID` watermark at 38% opacity, 4.5° tilt, keystone
perspective, lighting gradient, sensor noise), runs the full pipeline, and scores the
result against the ground truth. It is the fastest way to confirm the whole chain works
end to end without hunting for a real ticket photo.

```bash
pnpm test        # unit tests for the deterministic stages
pnpm build       # typecheck + production build
```

## How it works

```
decode → perspective → watermark → deskew → detect → recognize → cluster → assemble
```

The order is load-bearing, and two steps in it are counter-intuitive.

**Perspective before everything.** Every later stage assumes a flat page. Deskewing a
trapezoid is meaningless — there is no single angle that levels it — and an ink threshold
tuned on a foreshortened edge is wrong everywhere else.

**Watermark before deskew**, which looks backwards but is not. The skew estimator needs a
clean binary mask of *the printed text*; run against the raw page it locks onto the
diagonal of the watermark stamp instead. Suppressing first costs nothing, because the mask
is needed downstream anyway.

**Detection runs on the cleaned page, never the original.** The detector never sees the
watermark at all. That is how "watermarks must never appear in the output" is met
structurally, rather than by filtering bad readings after the fact.

### Watermark suppression

The naive approaches both fail. *Threshold harder* — a red stamp at 40% opacity is
genuinely darker than paper, so any luminance threshold that removes it also removes the
thin parts of the digits. *Filter out red* — works until the ticket stock changes.

The property that separates them is **chroma**. Printed numbers are neutral; black ink
sits within a couple of units of the grey axis in CIELAB. Any watermark you can see as
coloured is, by definition, far from it. That holds for red, blue, green, a pink logo, an
orange seal — the rule is about colourfulness, not hue.

Four details make it work in practice:

1. **Grey-world white balance first.** A tungsten cast lifts chroma across the whole
   frame; without correcting it, a fixed threshold erases the print.
2. **A luminance floor.** Where a translucent stamp crosses a black digit the blend is
   *dark* red — high chroma, and masking it would punch a hole through the stroke exactly
   where the watermark is heaviest. Pixels below 42% luminance are never classified as
   watermark.
3. **Remove the colour, then estimate the background.** Backwards, and a background
   estimated from an image that still contains the watermark *encodes* it — dividing then
   re-injects it as a halo along its own strokes.
4. **Erode the chroma mask by a pixel.** JPEG 4:2:0 subsampling smears colour ~2px beyond
   the ink that produced it, so an un-eroded mask eats into adjacent black digits.

A safeguard backs the whole thing out: if colour suppression removes more than 65% of all
ink, the *print* is probably coloured rather than the watermark, and the stage reverts to
luminance-only and says so in `warnings`. A wrong answer with a warning beats a
confidently empty one.

The stage emits **two** images, because its consumers want opposite things. The neural
detector and recogniser were trained on photographs and use the anti-aliased gradient
along a stroke edge to separate `6` from `8` and `3` from `9`, so they get continuous-tone
greyscale. Deskew and the classical fallback detector get the hard binary mask.

### Column clustering

Assigning boxes to columns is one-dimensional, so it has an *exact* solution:
[Ckmeans.1d.dp](src/ocr/layout/cluster1d.ts) finds the provably optimal partition by
dynamic programming in `O(k·n²)`. No seeding, no restarts, no local minimum — the same
input always gives the same answer, which matters when the hard requirement is "never mix
numbers across columns".

Optimal is not the same as correct, though, and the interesting work is the validation
around it:

- **Two anchors are tried.** Centres are the obvious choice, but ticket numbers are
  usually left-aligned, and a column mixing `7` with `42` scatters its centres by half a
  glyph width — comparable to the gap between columns. Both centres and left edges are
  clustered and the better-separated fit wins.
- **Gap-splitting is the fallback.** Minimising variance is the wrong objective when one
  column is sparsely populated; splitting at the largest gaps handles that far better.
- **Box extents are the decisive check.** Every anchor-based metric is scale-free, so
  three "columns" whose anchors differ by two pixels score as *infinitely* well
  separated — zero internal spread, perfect split. Comparing the real horizontal extents
  of the boxes is what actually backs the promise.
- **`splitGain`** (`WSS(k)/WSS(k-1)`) catches the other failure: Ckmeans always returns
  exactly `k` non-empty clusters when `n ≥ k`, so three numbers in one column are happily
  reported as three columns unless you check how much variance the k-th split bought.

Within a column, boxes are grouped into rows by vertical overlap, then emitted top-down
and left-to-right within a row. A plain sort by `y` is enough for one number per line but
scrambles the moment a column holds a pair side by side.

## Models

Both models run through ONNX Runtime Web.

| Stage | Model | Size |
|---|---|---|
| Detection | PP-OCRv5 mobile (DBNet) | ~4.8 MB |
| Recognition | en_PP-OCRv5 mobile (CTC) | ~7.8 MB |

A text *detector* returns boxes, not strings — so a recognition stage is required to
produce `"12"` rather than a rectangle. Both are ONNX Runtime Web; see
[`src/ocr/models/registry.ts`](src/ocr/models/registry.ts) for the exact URLs, mirrors and
per-model post-processing thresholds.

Weights are fetched on first use and cached in the Cache Storage API, so subsequent loads
are instant. Every download is validated as a real ONNX protobuf before it is cached — a
CDN that answers 404 with a styled HTML page still returns HTTP 200, and ONNX Runtime's
failure mode for "this is HTML, not a model" is an opaque WASM abort.

**Digits-only mode** (the default) is a large accuracy win. Because the exported model
emits post-softmax *probabilities*, the disallowed classes are zeroed and each timestep
renormalised — not set to `-Infinity`, which only works on logits. The CTC blank stays in
the allowed set; without it, `11` collapses to `1`.

### Graceful degradation

Nothing here is load-bearing enough to break the app:

- Detector model fails to load → falls back to connected-component detection in OpenCV.
- Recogniser fails to load → boxes are still returned in `rawDetections`, `columns` is
  empty, and `warnings` explains why.
- No document quad found, or the page is already square-on → the warp is skipped and
  `perspectiveCorrected` is `false`.
- Projection profile is flat → no rotation, `tiltCorrected` is `false`.

Every skip is recorded, so a result always says what actually happened to the image rather
than what was intended.

## Deployment

The app works on any static host with no configuration. There is one decision worth
understanding.

ONNX Runtime's multi-threaded WASM backend needs `SharedArrayBuffer`, which requires
**cross-origin isolation** — both `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. Threads are worth roughly 2–3× on the
detector. But `require-corp` also blocks every cross-origin subresource that does not opt
in, *including the CDN the models come from*. The two are mutually exclusive:

| | Models | Threads | Notes |
|---|---|---|---|
| **Default** | CDN | 1 | Works everywhere, including GitHub Pages. Slower. |
| **Isolated** | self-hosted under `public/models/` | up to 4 | Faster. Set `VITE_CROSS_ORIGIN_ISOLATED=1` and set both headers on your host. |

`vite.config.ts` sets the headers for `dev` and `preview` when that variable is set; in
production your host must set them (`vercel.json`, `netlify.toml`, or a `_headers` file).
GitHub Pages cannot set response headers at all, so isolation is not available there.

> If you enable threads, `wasmPaths.mjs` **must** be set — it already is in
> [`src/ocr/onnx/runtime.ts`](src/ocr/onnx/runtime.ts). Without it Emscripten spawns its
> pthread workers from the app's own bundle and the pipeline hangs forever with no error.

WebGPU is **off by default and that is deliberate**: it is unsupported on Safari (iOS and
macOS) and Chrome on iOS, and there are open ONNX Runtime issues describing a WebKit
memory leak that grows to multiple gigabytes and a crash after sustained inference on iOS.
The WASM backend is used everywhere unless WebGPU is explicitly opted into.

## Tuning

Open **Settings** in the app. Every control maps to a field in
[`OcrOptions`](src/ocr/types.ts), so anything you find there can be set programmatically.

| Symptom | Try |
|---|---|
| Numbers disappear entirely | Raise **chroma threshold**, or turn off watermark suppression |
| Watermark still bleeding through | Lower **chroma threshold** |
| Faint print not detected | Raise **ink darkness** |
| Digits clipped mid-glyph | Raise **box expansion** |
| Neighbouring numbers merged | Lower **box expansion** |
| Small digits missed | Raise **detector input size** |
| Numbers assigned to the wrong column | Check `processingMeta.warnings` — usually residual tilt |
| Too slow on mobile | Lower **detector input size** and **max input size** |

Turn on **Emit debug images** to see the output of every stage. The difference between
"the numbers came out wrong" and "the watermark mask ate the digits" is one glance at the
strip.

## The output contract

```ts
interface OcrResult {
  columns: { columnIndex: number; numbers: string[] }[]
  rawDetections: Detection[]
  processingMeta: ProcessingMeta
}
```

`columns` always has exactly `cluster.columnCount` entries (3 by default), padding with
empty arrays rather than omitting them — indexing `columns[2]` should never be `undefined`
because the photo clipped a column. Set `cluster.allowFewerColumns` to opt out.

`rawDetections` keeps **every** box the detector found, including rejected ones, each with
its `detScore`, `recScore`, combined `confidence`, and a `rejectedReason` when it was
dropped. When a number is missing from `columns`, this is where the answer is.

The full type surface is in [`src/ocr/types.ts`](src/ocr/types.ts).

## Layout

```
src/
  ocr/
    types.ts          shared contract — imported everywhere, depends on nothing
    pipeline.ts       stage orchestration
    client.ts         main-thread handle on the worker
    opencv/           imaging: perspective, watermark, deskew, crops, fallback detector
                      scope.ts is the Mat lifetime discipline — read it first
    onnx/             runtime setup, DBNet detector, CTC recogniser
    layout/           optimal 1-D clustering, column assignment, text normalisation
    models/           model registry and the validating cache
  workers/            the worker the whole pipeline runs inside
  components/         React UI
  lib/                image I/O, homography, the synthetic ticket generator
```

**Memory.** OpenCV allocates in the WASM heap, which the JavaScript garbage collector
cannot see; anything not explicitly deleted leaks until the tab closes, and a single
1600×1200 RGBA `Mat` is ~7.7 MB. Every allocation in `src/ocr/opencv/**` goes through
[`MatScope`](src/ocr/opencv/scope.ts), which releases on exit including on the throw path.
If you add code there, use it.

## Known limitations

These are real, and worth knowing before you deploy:

- **A black or grey watermark is not suppressed by the chroma rule** — it has no chroma to
  detect. Large ones are removed by the background-division step; a dark stamp at the
  scale of the digits themselves will not be. `watermarkSuppressed` is computed from
  actual chroma coverage, so it reports this honestly rather than always claiming success.
- **Coloured print** (blue or green numbers rather than black) trips the safeguard and
  disables colour filtering for that image, so the watermark will show through. The
  warning says so.
- **The recogniser is English/digits.** Non-Latin ticket text needs a different model; the
  registry documents the trade-offs.
- **Batching does not help.** Measured at 47.3 ms/crop at batch 1 versus 47.7 ms/crop at
  batch 8 on the WASM backend, so crops are processed in a simple loop.
- **Accuracy on real tickets is unmeasured.** The synthetic self-test proves the pipeline
  works end to end against known ground truth, but synthetic damage is not real camera
  damage. Validate against your own photos before relying on it.
