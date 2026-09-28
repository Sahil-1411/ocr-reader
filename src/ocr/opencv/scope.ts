/**
 * Deterministic lifetime management for OpenCV.js handles.
 *
 * OpenCV.js allocates every `Mat`, `MatVector`, `RotatedRect` and friend inside
 * the WASM heap. Those allocations are *not* reachable by the JavaScript garbage
 * collector, so anything you forget to `.delete()` leaks until the tab is
 * closed. A single 1600×1200 RGBA `Mat` is ~7.7 MB; leaking a handful of them
 * per frame will hard-crash a phone browser within a few images.
 *
 * Every function in `src/ocr/opencv/**` therefore allocates through a scope:
 *
 * ```ts
 * const out = using(scope => {
 *   const gray = scope.add(new cv.Mat())
 *   cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
 *   return scope.keep(gray.clone())   // survives the scope
 * })
 * ```
 *
 * Everything registered with `add` is released on the way out — including when
 * the body throws — while anything passed to `keep` is handed back to the
 * caller, who becomes responsible for it.
 */

/** Anything with an OpenCV-style manual destructor. */
export interface Deletable {
  delete(): void
  /** OpenCV sets this to `true` once the handle has been freed. */
  isDeleted?(): boolean
}

export class MatScope {
  #tracked: Deletable[] = []
  #kept = new Set<Deletable>()
  #closed = false

  /** Register a handle for release when the scope ends. Returns it unchanged. */
  add<T extends Deletable>(handle: T): T {
    if (this.#closed) {
      throw new Error('MatScope.add called after the scope was released')
    }
    this.#tracked.push(handle)
    return handle
  }

  /** Register several handles at once. */
  addAll<T extends Deletable>(...handles: T[]): T[] {
    for (const h of handles) this.add(h)
    return handles
  }

  /**
   * Exempt a handle from automatic release so it can outlive the scope.
   * The caller takes ownership and must delete it themselves.
   */
  keep<T extends Deletable>(handle: T): T {
    this.#kept.add(handle)
    return handle
  }

  /**
   * Release everything tracked but not kept. Safe to call twice; handles that
   * OpenCV has already freed are skipped, and a destructor that throws never
   * prevents the remaining handles from being released.
   */
  release(): void {
    if (this.#closed) return
    this.#closed = true
    // Reverse order: later allocations may be views onto earlier ones.
    for (let i = this.#tracked.length - 1; i >= 0; i--) {
      const handle = this.#tracked[i]
      if (this.#kept.has(handle)) continue
      safeDelete(handle)
    }
    this.#tracked.length = 0
    this.#kept.clear()
  }

  /** Number of handles that would be released right now. Used by leak tests. */
  get pendingCount(): number {
    return this.#tracked.filter((h) => !this.#kept.has(h)).length
  }
}

/**
 * Release a handle, tolerating null, double-free and destructors that throw.
 * Never let cleanup failures mask the real error.
 */
export function safeDelete(handle: Deletable | null | undefined): void {
  if (!handle) return
  try {
    if (typeof handle.isDeleted === 'function' && handle.isDeleted()) return
    handle.delete()
  } catch {
    /* already freed, or freed by a parent container — nothing to do */
  }
}

/** Release a list of handles, tolerating nulls and double-frees. */
export function deleteAll(handles: Array<Deletable | null | undefined>): void {
  for (const h of handles) safeDelete(h)
}

/**
 * Run `body` with a scope whose allocations are released on exit, including
 * when `body` throws. Values passed to `scope.keep(...)` survive.
 */
export function using<T>(body: (scope: MatScope) => T): T {
  const scope = new MatScope()
  try {
    return body(scope)
  } finally {
    scope.release()
  }
}

/** Async counterpart of {@link using}. */
export async function usingAsync<T>(
  body: (scope: MatScope) => Promise<T>,
): Promise<T> {
  const scope = new MatScope()
  try {
    return await body(scope)
  } finally {
    scope.release()
  }
}
