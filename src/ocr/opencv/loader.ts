/**
 * Loading OpenCV.js exactly once, with a readiness contract that actually holds.
 *
 * `@techstark/opencv-js` is an Emscripten UMD bundle with the WebAssembly binary
 * embedded, so there are no `wasmPaths` to configure and it works unmodified
 * inside a Web Worker. What it does *not* have is a single, stable readiness
 * signal — depending on how the build was modularised, the default export is
 * either an already-initialised module, a promise, or a module that will invoke
 * `onRuntimeInitialized` later. Touching `cv.Mat` before that point throws a
 * bare `BindingError` with no explanation.
 *
 * So we handle all three shapes, and we time out rather than hanging forever:
 * a 10 MB bundle that silently never initialises is the single most confusing
 * failure this app can have.
 */

import type cvTypes from '@techstark/opencv-js'

/** The OpenCV namespace, typed from the package's own declarations. */
export type CV = typeof cvTypes

/** Milliseconds to wait for the WASM runtime before giving up. */
const INIT_TIMEOUT_MS = 60_000

let loadPromise: Promise<CV> | null = null
let loaded: CV | null = null

interface MaybeEmscripten {
  Mat?: unknown
  then?: (onFulfilled: (value: unknown) => void, onRejected?: (reason: unknown) => void) => void
  onRuntimeInitialized?: () => void
  onAbort?: (reason: unknown) => void
}

/**
 * Strip the Emscripten module's `then` method.
 *
 * This is not a nicety — without it the loader hangs forever, and the symptom is
 * maddening: no error, no timeout, just a worker that never reports ready.
 *
 * Emscripten's `MODULARIZE` output makes the Module object itself a *thenable*
 * whose `then` resolves with the Module. JavaScript treats any object with a
 * callable `then` as a promise, and unwraps it recursively: the moment such an
 * object is used as a resolution value — returned from an `async` function,
 * passed to `resolve()`, or `await`ed — the runtime calls `then` again on the
 * result, gets the Module back, calls `then` again, and never settles.
 *
 * Once the runtime is initialised the thenable has served its purpose, so
 * removing it is safe and is the standard remedy.
 */
function detachThenable(module: MaybeEmscripten): void {
  if (typeof module.then !== 'function') return
  try {
    delete module.then
  } catch {
    // Frozen or non-configurable: overwrite instead. Anything non-callable is
    // enough to stop the promise machinery treating it as a thenable.
    module.then = undefined
  }
}

/**
 * Hide `then` even when the property cannot be deleted.
 *
 * `resolve(module)` walks `then` and, if it is still callable, waits on the
 * module forever. A proxy that reports no `then` stops that walk while every
 * OpenCV function stays available.
 */
function asRuntime(module: MaybeEmscripten): CV {
  detachThenable(module)
  return new Proxy(module, {
    get(target, prop, receiver) {
      if (prop === 'then') return undefined
      const value = Reflect.get(target, prop, receiver)
      if (typeof value === 'function') return (value as (...args: unknown[]) => unknown).bind(target)
      return value
    },
    has(target, prop) {
      if (prop === 'then') return false
      return Reflect.has(target, prop)
    },
  }) as unknown as CV
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/**
 * Load and initialise OpenCV.js.
 *
 * The import is dynamic so the 10 MB bundle becomes its own chunk, fetched only
 * when an image is actually processed rather than on first paint.
 */
export function loadOpenCV(): Promise<CV> {
  if (loaded) return Promise.resolve(loaded)
  if (loadPromise) return loadPromise

  loadPromise = (async () => {
    let mod: unknown
    try {
      mod = await withTimeout(
        import('@techstark/opencv-js'),
        INIT_TIMEOUT_MS,
        `OpenCV.js did not finish loading within ${INIT_TIMEOUT_MS / 1000}s.`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // opencv.js is a UMD bundle whose last resort is `root.cv = factory()`.
      // Evaluated as an ES module, top-level `this` is `undefined` under strict
      // mode and that assignment throws. It means the dependency was not
      // pre-bundled — see the `optimizeDeps.include` note in vite.config.ts.
      if (/Cannot set propert(y|ies) of undefined/.test(message)) {
        throw new Error(
          'OpenCV.js failed to initialise because it was loaded as a raw ES module. ' +
            "Add '@techstark/opencv-js' to `optimizeDeps.include` in vite.config.ts so Vite " +
            `pre-bundles its CommonJS wrapper, then restart the dev server. (${message})`,
        )
      }
      throw new Error(`Could not load OpenCV.js: ${message}`)
    }

    const candidate = ((mod as { default?: unknown }).default ?? mod) as MaybeEmscripten

    const cv = await waitForRuntime(candidate)
    loaded = cv
    return cv
  })().catch((error) => {
    // Let a later attempt retry rather than caching the rejection forever —
    // the usual cause is a transient chunk-load failure on a flaky connection.
    loadPromise = null
    throw error
  })

  return loadPromise
}

function waitForRuntime(candidate: MaybeEmscripten): Promise<CV> {
  // Already initialised — the common case on a second call within a session.
  if (candidate.Mat) {
    return Promise.resolve(asRuntime(candidate))
  }

  return new Promise<CV>((resolve, reject) => {
    let settled = false

    const finish = (value: unknown) => {
      if (settled) return
      const cv = (value ?? candidate) as MaybeEmscripten
      if (!cv.Mat) {
        fail(new Error('OpenCV.js reported ready but exposes no Mat constructor'))
        return
      }
      settled = true
      clearTimeout(timer)
      // Must happen before `resolve`, or the promise machinery re-enters the
      // thenable and this promise never settles. See `detachThenable`.
      resolve(asRuntime(cv))
    }

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }

    const timer = setTimeout(() => {
      fail(
        new Error(
          `OpenCV.js did not finish initialising within ${INIT_TIMEOUT_MS / 1000}s. ` +
            'This usually means the WebAssembly runtime was blocked — check for a ' +
            "Content-Security-Policy without 'wasm-unsafe-eval'.",
        ),
      )
    }, INIT_TIMEOUT_MS)

    // Emscripten calls this on a fatal runtime error; without it the timeout
    // above is the only thing that ever fires, 60 seconds later.
    candidate.onAbort = (reason: unknown) =>
      fail(new Error(`OpenCV.js aborted during initialisation: ${String(reason)}`))

    // Modularised builds resolve a promise.
    if (typeof candidate.then === 'function') {
      candidate.then(finish, (reason: unknown) =>
        fail(reason instanceof Error ? reason : new Error(String(reason))),
      )
      return
    }

    // Classic builds fire a callback.
    candidate.onRuntimeInitialized = () => finish(candidate)
  })
}

/**
 * Synchronous accessor for code that runs after `loadOpenCV()` has resolved.
 *
 * Passing `cv` through every call signature would be noisy; this keeps the
 * hot paths readable while still failing loudly if the order is ever wrong.
 */
export function getCV(): CV {
  if (!loaded) {
    throw new Error('OpenCV.js has not been loaded yet — await loadOpenCV() first')
  }
  return loaded
}

/** Whether OpenCV is ready, without triggering a load. */
export function isOpenCVReady(): boolean {
  return loaded !== null
}

/**
 * Report which of the functions this pipeline depends on are actually present.
 *
 * OpenCV.js is a custom Emscripten build and the set of compiled-in modules
 * varies between distributions — `inpaint` and `MSER`, for instance, are often
 * omitted. Checking up front turns "undefined is not a function" three stages
 * into a run into a clear message at startup.
 */
export const REQUIRED_CV_SYMBOLS = [
  'Mat',
  'MatVector',
  'matFromImageData',
  'cvtColor',
  'split',
  'merge',
  'inRange',
  'threshold',
  'adaptiveThreshold',
  'morphologyEx',
  'getStructuringElement',
  'GaussianBlur',
  'medianBlur',
  'Canny',
  'findContours',
  'approxPolyDP',
  'minAreaRect',
  'boxPoints',
  'contourArea',
  'arcLength',
  'getPerspectiveTransform',
  'warpPerspective',
  'getRotationMatrix2D',
  'warpAffine',
  'resize',
  'copyMakeBorder',
  'connectedComponentsWithStats',
  'divide',
  'subtract',
  'bitwise_and',
  'bitwise_not',
  'countNonZero',
  'reduce',
  'minMaxLoc',
  'normalize',
  'dilate',
  'erode',
] as const

/** Optional symbols — the pipeline degrades gracefully when these are absent. */
export const OPTIONAL_CV_SYMBOLS = ['createCLAHE', 'inpaint', 'bilateralFilter'] as const

export interface CapabilityReport {
  missingRequired: string[]
  missingOptional: string[]
  ok: boolean
}

export function checkCapabilities(cv: CV): CapabilityReport {
  const has = (name: string) =>
    (cv as unknown as Record<string, unknown>)[name] !== undefined

  const missingRequired = REQUIRED_CV_SYMBOLS.filter((n) => !has(n))
  const missingOptional = OPTIONAL_CV_SYMBOLS.filter((n) => !has(n))

  return {
    missingRequired,
    missingOptional: [...missingOptional],
    ok: missingRequired.length === 0,
  }
}
