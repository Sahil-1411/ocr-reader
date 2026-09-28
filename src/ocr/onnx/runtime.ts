/**
 * Configuring ONNX Runtime Web, once, for the whole worker.
 *
 * This module owns every global knob ORT has. The detector and the recogniser
 * only ever ask it for a session, which keeps the "how does this runtime boot"
 * problem in one file instead of being duplicated — and subtly diverging —
 * between two model wrappers.
 *
 * Three decisions here are worth more than the code that implements them:
 *
 *   · **We import `onnxruntime-web/wasm`, not `onnxruntime-web`.** The bare root
 *     import resolves to the JSEP build, which pulls a 28 MB binary (5.5 MB
 *     brotli) and was announced deprecated in ORT 1.29. The `/wasm` subpath is
 *     the CPU-only build: 73 kB of JS and a 14.2 MB binary that compresses to
 *     3.0 MB. On a phone on mobile data that difference is the whole app.
 *
 *   · **`wasmPaths` is set explicitly, including `mjs`.** See the long comment
 *     on `configureWasmAssets` — getting this wrong costs you a silent,
 *     errorless hang that no stack trace will ever point at.
 *
 *   · **WASM is the execution provider, not WebGPU.** WebGPU is faster where it
 *     works, but it does not work on any Safari — and Safari is most of the
 *     phones that will photograph a ticket. It is available as an opt-in.
 *
 * Nothing in here touches the DOM, so the module is safe to evaluate inside a
 * Web Worker — and, just as importantly, safe to be re-evaluated inside an
 * Emscripten pthread worker, which is a thing that genuinely happens (again,
 * see `configureWasmAssets`).
 */

import * as ort from 'onnxruntime-web/wasm'
import type { InferenceSession, Tensor } from 'onnxruntime-web'
import wasmBinaryUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import wasmGlueUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url'

import { looksLikeOnnx } from '../models/cache'
import type { RuntimeInfo } from './contracts'

/**
 * The shape of an ONNX Runtime Web entry point, as far as this module cares.
 *
 * `onnxruntime-web/wasm` and `onnxruntime-web/webgpu` are *separate bundles*
 * that each inline their own copy of `onnxruntime-common`. They therefore have
 * separate `env` objects and, critically, separate `Tensor` classes — so once a
 * bundle is chosen, every tensor and every session must come from that same
 * one. That is the entire reason this type exists and the reason callers build
 * tensors with `float32Tensor` rather than importing `Tensor` themselves.
 */
type OrtModule = typeof ort

/**
 * How long to wait for the WASM backend to fetch and compile, in milliseconds.
 * Zero means "no timeout", which is both ORT's own default and the only safe
 * value here.
 *
 * A non-zero `initTimeout` is not a "fail fast and try again" knob, because
 * losing the race is unrecoverable. `initializeWebAssemblyAndOrtRuntime` wraps
 * the whole init in `try { … } catch (e) { aborted = true; throw e }`, and
 * every later call then throws `previous call to 'initWasm()' failed` — for the
 * life of the worker, for *both* models. The inner `initializeWebAssembly` is
 * worse still: the timeout branch throws without ever clearing `initializing`.
 *
 * So a timeout does not turn a slow download into a retry; it turns a slow
 * download into a permanently dead runtime. The 3.0 MB brotli binary genuinely
 * takes a minute or more on a weak mobile link, which is exactly when that
 * would fire. Note also that none of this is covered by `initRuntime`'s own
 * retry-on-failure logic: ORT does not touch the WASM backend until the first
 * `InferenceSession.create`, long after `setup()` has resolved.
 */
const INIT_TIMEOUT_MS = 0

/**
 * A minimal valid WebAssembly module whose body contains `i8x16.splat`
 * (opcode prefix `0xfd`, `0x0f`). `WebAssembly.validate` rejects it outright on
 * an engine without fixed-width SIMD, which is the standard feature probe and
 * the same one ORT itself uses.
 *
 * This is not a performance hint, it is a hard gate. ORT 1.30 ships exactly
 * four binaries — `ort-wasm-simd-threaded{,.jsep,.asyncify,.jspi}.wasm` — and
 * every one of them is SIMD. The non-SIMD builds were deleted in 1.19, so there
 * is no scalar code path left to fall back to: `initializeWebAssembly` simply
 * throws `WebAssembly SIMD is not supported in the current environment`. We
 * report the answer in `processingMeta` so that failure is diagnosable instead
 * of mysterious.
 */
const SIMD_PROBE = Uint8Array.of(
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00, //             type:   () -> ()
  0x03, 0x02, 0x01, 0x00, //                         func:   one function, type 0
  0x0a, 0x09, 0x01, 0x07, 0x00, //                   code:   one body, 7 bytes
  0x41, 0x00, 0xfd, 0x0f, 0x1a, 0x0b, //             i32.const 0; i8x16.splat; drop; end
)

export interface RuntimeOptions {
  /**
   * Try the WebGPU execution provider before falling back to WASM.
   *
   * Off by default, and refused outright on Safari/iOS — see `pickWebGpu`.
   * Turning it on loads a second, larger ORT bundle, so it is worth it only on
   * a desktop that will process many images.
   */
  preferWebGpu?: boolean
}

/**
 * The module that actually serves sessions and tensors.
 *
 * Starts as the statically imported CPU build and is only ever replaced during
 * `initRuntime`, before any session exists — so the "all objects come from one
 * bundle" rule can never be violated halfway through a run.
 */
let active: OrtModule = ort

let info: RuntimeInfo | null = null
let initPromise: Promise<RuntimeInfo> | null = null

/**
 * Prepare ONNX Runtime and report what we actually got.
 *
 * Idempotent by contract: the first call configures the runtime and every later
 * call — including concurrent ones, including ones passing different options —
 * resolves to the same `RuntimeInfo`. Reconfiguring `ort.env` after a session
 * exists has no effect on that session and quietly desynchronises the reported
 * metadata from reality, so we refuse to do it rather than pretend.
 */
export function initRuntime(options: RuntimeOptions = {}): Promise<RuntimeInfo> {
  if (info) return Promise.resolve(info)
  if (initPromise) return initPromise

  initPromise = setup(options).catch((error) => {
    // A failed init is usually a failed asset fetch, which is worth retrying on
    // a flaky connection. Caching the rejection forever would turn one dropped
    // packet into a permanently dead worker.
    initPromise = null
    throw error
  })

  return initPromise
}

/** What `initRuntime` decided, or `null` if it has not been called yet. */
export function getRuntimeInfo(): RuntimeInfo | null {
  return info
}

async function setup(options: RuntimeOptions): Promise<RuntimeInfo> {
  const warnings: string[] = []

  const simd = detectSimd()
  if (!simd) {
    warnings.push(
      'This browser reports no WebAssembly SIMD support. Every binary ONNX Runtime 1.30 ' +
        'ships requires it, so the neural models will fail to load and the pipeline will ' +
        'fall back to classical detection without recognition.',
    )
  }

  const threads = resolveThreadCount(warnings)

  let module: OrtModule = ort
  let executionProviders: string[] = ['wasm']

  if (options.preferWebGpu) {
    const gpu = await loadWebGpuBundle(warnings)
    if (gpu) {
      module = gpu
      executionProviders = ['webgpu', 'wasm']
    }
  }

  if (module === ort) {
    configureWasmAssets(ort, wasmBinaryUrl, wasmGlueUrl)
  }

  module.env.wasm.numThreads = threads
  module.env.wasm.initTimeout = INIT_TIMEOUT_MS
  // Explicitly off, and explicitly commented, because turning it on looks like
  // an obvious win and is not. `env.wasm.proxy` moves inference to a worker ORT
  // spawns itself — but inside a worker it is a silent no-op (ORT gates it on
  // `typeof document !== 'undefined'`), and on the main thread of a bundled
  // Vite app it fails with 'no available backend found. ERR: [wasm]', because
  // the proxy worker is constructed from the app's own chunk URL. We already
  // run inside our own worker, which is exactly what proxy was invented for.
  module.env.wasm.proxy = false
  module.env.logLevel = 'warning'

  active = module

  info = {
    // The first entry is what ORT will try first; if the WebGPU EP then fails
    // at session creation, `createSession` rewrites this to the truth.
    executionProvider: executionProviders[0] ?? 'wasm',
    threads,
    simd,
    warnings,
  }
  return info
}

/**
 * Point ORT at its own runtime assets, by absolute URL.
 *
 * **This is not optional, and the failure mode if you skip it is brutal.**
 *
 * Emscripten starts each pthread by constructing `new Worker(<glue script>)`.
 * When the glue is inlined into the bundle — which it is, because every ESM
 * subpath of onnxruntime-web resolves to a `*.bundle.min.mjs` — "the glue
 * script" is *your own chunk*. Your module body is re-executed inside every
 * pthread worker, and the result is that the app hangs forever: no exception,
 * no console output, no rejected promise, nothing to attach a debugger to.
 *
 * Setting `wasmPaths.mjs` makes the pthreads load ORT's standalone glue asset
 * instead of your chunk, and threading works. So: whenever `numThreads` may
 * exceed 1, `mjs` must be set. We set it unconditionally — it costs nothing at
 * one thread and removes an entire category of "it works on my machine".
 *
 * Both URLs are resolved against `self.location` because `wasmPaths` entries
 * must be absolute. Vite's `?url` imports honour a non-`/` `base`, but they can
 * still come back relative, and a relative path here resolves against the wrong
 * origin inside the pthread worker.
 *
 * The `.wasm` and the glue must also match the JS bundle exactly: the CPU build
 * wants `ort-wasm-simd-threaded.*`, the WebGPU build wants the `.asyncify.*`
 * pair. Crossing them fails at init with an opaque abort.
 */
function configureWasmAssets(module: OrtModule, binaryUrl: string, glueUrl: string): void {
  module.env.wasm.wasmPaths = {
    wasm: absolute(binaryUrl),
    mjs: absolute(glueUrl),
  }
}

/**
 * How many threads the WASM backend may use.
 *
 * WebAssembly threads need `SharedArrayBuffer`, which browsers only expose on a
 * cross-origin-isolated page — that is, one served with both
 * `Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: require-corp`. Most static hosts send neither,
 * and GitHub Pages cannot send them at all, so single-threaded is the common
 * case rather than the exception.
 *
 * Asking for more threads than that without isolation is not merely useless:
 * ORT logs two warnings and resets the count to 1. Better to ask for what we
 * can actually have, and say so out loud.
 *
 * `crossOriginIsolated` is necessary but not sufficient — it is the *permission*
 * to have `SharedArrayBuffer`, not a guarantee that the engine exposes one.
 * Firefox with `javascript.options.shared_memory` off, and several embedded
 * WebViews, report isolation while leaving the constructor undefined. ORT itself
 * checks the constructor (`initializeWebAssembly` in wasm-factory.ts), silently
 * forces `numThreads = 1` and logs two warnings — so testing only isolation
 * would make `RuntimeInfo.threads` claim four threads on a machine running one,
 * which is precisely the number someone reads when asking why inference is slow.
 *
 * The `ceil(cores / 2)` cap matches ORT's own default heuristic. Half the
 * logical cores is roughly the physical core count on SMT machines, and
 * oversubscribing a phone's efficiency cores makes inference slower, not
 * faster.
 */
function resolveThreadCount(warnings: string[]): number {
  if (!isCrossOriginIsolated()) {
    warnings.push(
      'Running single-threaded because the page is not cross-origin isolated. ' +
        'Serving it with Cross-Origin-Opener-Policy: same-origin and ' +
        'Cross-Origin-Embedder-Policy: require-corp would enable multi-threaded inference.',
    )
    return 1
  }

  if (typeof SharedArrayBuffer === 'undefined') {
    warnings.push(
      'Running single-threaded: this page is cross-origin isolated but the browser ' +
        'still does not expose SharedArrayBuffer, which WebAssembly threads require.',
    )
    return 1
  }

  const cores = navigatorLike()?.hardwareConcurrency ?? 1
  return Math.max(1, Math.min(4, Math.ceil(cores / 2)))
}

/**
 * Load the WebGPU build, or explain in `warnings` why we are not going to.
 *
 * WebGPU lives behind an opt-in for reasons that are about the web platform
 * rather than about ORT:
 *
 *   · ORT 1.30's own compatibility matrix still marks WebGPU unsupported on
 *     Safari (macOS and iOS) and on Chrome/Edge for iOS — every iOS browser is
 *     WebKit underneath.
 *   · There are open, unfixed WebKit bugs: onnxruntime#26827 (the WebKit
 *     process pins a core at 400% and grows past 14 GB after inference, even
 *     after `session.release()`, until the tab dies) and #27584 (a crash after
 *     roughly 500 WebGPU inferences on iOS 26.3). A user photographing a stack
 *     of tickets would reach both.
 *   · The WebGPU EP needs a different bundle *and* a different binary — the
 *     `.asyncify` wasm, 26.8 MB raw against the CPU build's 14.2 MB. Compiling
 *     that in-process is itself enough to OOM a low-RAM phone, which is the
 *     other reason it is not the default.
 *
 * Both the bundle and its assets are dynamically imported so that a build that
 * never opts in never ships them to the browser.
 */
async function loadWebGpuBundle(warnings: string[]): Promise<OrtModule | null> {
  if (isWebKit()) {
    warnings.push(
      'WebGPU was requested but is not usable on Safari or on any iOS browser; ' +
        'staying on the WebAssembly backend.',
    )
    return null
  }

  if (!(await hasWebGpuAdapter())) {
    warnings.push(
      'WebGPU was requested but no GPU adapter was available; ' +
        'staying on the WebAssembly backend.',
    )
    return null
  }

  try {
    const [module, binary, glue] = await Promise.all([
      import('onnxruntime-web/webgpu'),
      import('onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'),
      import('onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'),
    ])
    configureWasmAssets(module, binary.default, glue.default)
    return module
  } catch (error) {
    warnings.push(
      `WebGPU was requested but its runtime could not be loaded (${messageOf(error)}); ` +
        'staying on the WebAssembly backend.',
    )
    return null
  }
}

/**
 * `navigator.gpu` being present is not enough — `requestAdapter()` still
 * returns `null` on machines whose GPU is blocklisted by the browser, and on
 * some it throws. Only an actual adapter counts as support.
 */
async function hasWebGpuAdapter(): Promise<boolean> {
  const gpu = navigatorLike()?.gpu
  if (!gpu) return false
  try {
    return (await gpu.requestAdapter()) != null
  } catch {
    return false
  }
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Compile a model into a session.
 *
 * `label` is only ever used in error messages, but it is the difference between
 * "the app failed to load a model" and "the recogniser's weights came back as
 * an HTML error page", so it is required rather than optional.
 *
 * Calls `initRuntime` itself: a caller that forgets would otherwise get a
 * session built against an unconfigured `env`, which is precisely the silent
 * threading hang described above.
 */
export async function createSession(
  bytes: ArrayBuffer,
  label: string,
): Promise<InferenceSession> {
  const runtime = await initRuntime()

  // ORT's failure mode for "these bytes are not a model" is a WASM abort with
  // no message, so check the protobuf header first and say something useful.
  // A CDN that answers 404 with a styled HTML page, and a Git LFS pointer file
  // served verbatim, both arrive here as HTTP 200 with plausible byte counts.
  if (!looksLikeOnnx(bytes)) {
    throw new Error(
      `The ${label} model data is not a valid ONNX file (${bytes.byteLength} bytes; ` +
        'it does not start with an ONNX protobuf header). The download probably ' +
        'returned an error page or a Git LFS pointer rather than the weights.',
    )
  }

  // Read the provider choice ONCE, into a local. `runtime` is the shared
  // singleton and the fallback below mutates `runtime.executionProvider`, while
  // the worker creates the detector and the recogniser concurrently
  // (`Promise.allSettled` in ocr.worker.ts). Re-reading the field in the catch
  // would mean that once the first session had fallen back to WASM, the second
  // one — which was still built with ['webgpu', 'wasm'] — would no longer
  // recognise itself as a WebGPU attempt, skip its own retry, and be lost
  // outright instead of recovered on the CPU path.
  const wantsWebGpu = runtime.executionProvider === 'webgpu'

  const sessionOptions: InferenceSession.SessionOptions = {
    executionProviders: wantsWebGpu ? ['webgpu', 'wasm'] : ['wasm'],
    // 'all' lets ORT fuse and constant-fold at load time. It costs a few hundred
    // milliseconds once per session and pays for itself on the second image.
    graphOptimizationLevel: 'all',
    // Inter-op parallelism ('parallel') is a no-op in the web build; all the
    // parallelism we get comes from `env.wasm.numThreads` inside each operator.
    // Saying 'sequential' explicitly documents that rather than implying a
    // choice we do not actually have.
    executionMode: 'sequential',
  }

  try {
    return await active.InferenceSession.create(bytes, sessionOptions)
  } catch (error) {
    if (wantsWebGpu) {
      // Some devices advertise an adapter and still fail during EP init. One
      // retry on the CPU path is much better than losing the model entirely.
      try {
        const fallback = await active.InferenceSession.create(bytes, {
          ...sessionOptions,
          executionProviders: ['wasm'],
        })
        runtime.executionProvider = 'wasm'
        runtime.warnings.push(
          `The WebGPU backend failed to initialise for the ${label} model ` +
            `(${messageOf(error)}); this run is using WebAssembly instead.`,
        )
        return fallback
      } catch {
        /* fall through and report the original failure */
      }
    }
    throw new Error(`Could not create the ${label} session: ${messageOf(error)}`)
  }
}

/**
 * Free a session's WASM heap.
 *
 * Deliberately never rejects: this is called from synchronous `dispose()`
 * methods on a teardown path, where an unhandled rejection would be reported as
 * a crash for something nobody can act on.
 */
export async function releaseSession(
  session: InferenceSession | null,
  label: string,
): Promise<void> {
  if (!session) return
  try {
    await session.release()
  } catch (error) {
    console.warn(`Releasing the ${label} session failed: ${messageOf(error)}`)
  }
}

/**
 * Build a float32 input tensor.
 *
 * Use this rather than importing `Tensor` directly. `InferenceSession.run`
 * validates its feeds with `instanceof Tensor`, and the CPU and WebGPU bundles
 * each carry their own copy of that class — so a tensor built from the wrong
 * bundle is rejected with a type error that reads as though the data were
 * malformed. This helper always uses whichever bundle is actually serving
 * sessions.
 */
export function float32Tensor(data: Float32Array, dims: readonly number[]): Tensor {
  return new active.Tensor('float32', data, dims)
}

/**
 * Run a model that takes exactly one input and read its first output.
 *
 * The names come from `session.inputNames` / `session.outputNames` rather than
 * being written down here. Every model this app might use names its tensors
 * differently — PaddleOCR calls its input `x`, the angle classifier's output is
 * `save_infer_model/scale_0.tmp_1`, and published documentation for both has
 * been wrong — so hardcoding a name is a guaranteed future breakage.
 *
 * The "exactly one input" part is enforced rather than assumed. Some CTC and
 * seq2seq exports take a second tensor (a sequence-length or attention-mask
 * input), and feeding such a graph only its first input makes ORT reject the
 * call with `input 'X' is missing in 'feeds'` — a message that names neither the
 * model nor the fact that this helper is the wrong tool for it. Worse, the
 * recogniser swallows per-batch failures by design, so an unlabelled throw there
 * surfaces as every crop reading back empty with no explanation anywhere. A
 * model with extra inputs must call `session.run` directly.
 */
export async function runSingleInput(
  session: InferenceSession,
  input: Tensor,
  label: string,
): Promise<Tensor> {
  const inputName = session.inputNames[0]
  const outputName = session.outputNames[0]
  if (!inputName || !outputName) {
    throw new Error(
      `The ${label} model exposes ${session.inputNames.length} inputs and ` +
        `${session.outputNames.length} outputs; this pipeline needs at least one of each.`,
    )
  }
  if (session.inputNames.length > 1) {
    throw new Error(
      `The ${label} model takes ${session.inputNames.length} inputs ` +
        `(${session.inputNames.join(', ')}), but this pipeline only knows how to feed ` +
        'one. Either point the model registry at a single-input export or give this ' +
        'model its own run path.',
    )
  }

  const outputs = await session.run({ [inputName]: input })
  const output = outputs[outputName]
  if (!output) {
    throw new Error(`The ${label} model produced no "${outputName}" output`)
  }
  return output
}

/* -------------------------------------------------------------------------- */
/* Environment probes                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The bits of `navigator` we use, declared structurally.
 *
 * `WorkerNavigator` and `Navigator` do not agree on which of these exist, and
 * this file is compiled with both the DOM and WebWorker libs loaded — so
 * reading them off a hand-written shape is both more honest about what is
 * actually guaranteed and immune to which declaration wins.
 */
interface NavigatorLike {
  hardwareConcurrency?: number
  userAgent?: string
  platform?: string
  maxTouchPoints?: number
  gpu?: { requestAdapter(): Promise<unknown> }
}

function navigatorLike(): NavigatorLike | undefined {
  return (globalThis as { navigator?: NavigatorLike }).navigator
}

function isCrossOriginIsolated(): boolean {
  return (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
}

/**
 * Is this engine WebKit?
 *
 * Every browser on iOS is WebKit regardless of its badge, so `CriOS` and
 * `EdgiOS` must be caught too — they carry `iPhone`/`iPad` in the UA, which the
 * first test covers. iPadOS 13+ reports itself as `Macintosh`, and the only
 * reliable tell is that a Mac does not have a touch screen.
 *
 * The desktop-Safari test is the classic one: Safari's UA contains `Safari`,
 * but so does every Chromium browser, which additionally contains `Chrome`.
 */
function isWebKit(): boolean {
  const nav = navigatorLike()
  const ua = nav?.userAgent ?? ''
  if (/iPhone|iPad|iPod/.test(ua)) return true
  if (nav?.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1) return true
  return /Safari/.test(ua) && !/Chrome|Chromium|Android|Edg\//.test(ua)
}

/**
 * Resolve an asset URL against the document/worker location.
 *
 * `env.wasm.wasmPaths` entries must be absolute. Vite's `?url` imports already
 * respect a non-root `base`, but they can be emitted relative, and a relative
 * path is resolved against the *pthread worker's* URL rather than ours once
 * Emscripten starts spawning threads.
 */
function absolute(url: string): string {
  const base = (globalThis as { location?: { href?: string } }).location?.href
  if (!base) return url
  try {
    return new URL(url, base).href
  } catch {
    return url
  }
}

function detectSimd(): boolean {
  try {
    return WebAssembly.validate(SIMD_PROBE)
  } catch {
    return false
  }
}

/**
 * A human-readable description of a thrown value.
 *
 * `error.message` alone is not enough here. This module's own failure mode of
 * record — an Emscripten abort while compiling a model — arrives as an `Error`
 * with an empty `message`, which would render `Could not create the detector
 * session: ` and leave the user with literally nothing to act on. Falling back
 * to `String(error)` at least yields the constructor name, and `name` is
 * appended when the message does not already carry it so that an `AbortError` or
 * a `RangeError` (the shape an out-of-memory failure takes on mobile Safari) is
 * still identifiable in a bug report.
 */
function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const message = error.message.trim()
  if (!message) return error.name ? `${error.name} (no message)` : String(error)
  return message.includes(error.name) ? message : `${error.name}: ${message}`
}
