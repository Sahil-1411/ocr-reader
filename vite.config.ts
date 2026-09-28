import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig, type PluginOption } from 'vite'

/**
 * Cross-origin isolation.
 *
 * ONNX Runtime's multi-threaded WASM backend needs `SharedArrayBuffer`, which
 * browsers only expose on a cross-origin-isolated page — meaning both
 * `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy:
 * require-corp`. Threads are worth roughly a 2–3× speedup on the detector.
 *
 * The catch is that `require-corp` also blocks *every* cross-origin subresource
 * that does not opt in with `Cross-Origin-Resource-Policy` — including the CDN
 * the models are fetched from. So isolation and CDN-hosted models are mutually
 * exclusive, and the right default depends on how you deploy:
 *
 *   · **Off (default).** Models load from any CDN, the WASM backend runs
 *     single-threaded. Works everywhere, including static hosts that cannot set
 *     headers at all (plain GitHub Pages). Slower, but never broken.
 *
 *   · **On.** Set `VITE_CROSS_ORIGIN_ISOLATED=1` *and* self-host the model files
 *     under `public/models/`. Faster, but a same-origin model path is then
 *     mandatory — a CDN URL will fail to fetch.
 *
 * Note this only configures the dev server. In production the same two headers
 * must be set by your host; `vercel.json`, `netlify.toml` and `_headers` all
 * support this. Without them the app still runs, single-threaded.
 */
const crossOriginIsolated = process.env.VITE_CROSS_ORIGIN_ISOLATED === '1'

const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
} as const

function crossOriginIsolationPlugin(): PluginOption {
  return {
    name: 'ocr-cross-origin-isolation',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        for (const [key, value] of Object.entries(ISOLATION_HEADERS)) {
          res.setHeader(key, value)
        }
        next()
      })
    },
    // `vite preview` is where people check a production build, so it needs the
    // same treatment or the build appears to behave differently from dev.
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        for (const [key, value] of Object.entries(ISOLATION_HEADERS)) {
          res.setHeader(key, value)
        }
        next()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    ...(crossOriginIsolated ? [crossOriginIsolationPlugin()] : []),
  ],

  worker: {
    // The OCR worker uses static ESM imports, so it must be emitted as a module
    // rather than wrapped in the legacy IIFE format.
    format: 'es',
  },

  optimizeDeps: {
    /**
     * opencv.js **must** be pre-bundled. It looks like a candidate for
     * `exclude` — it is a 10 MB CommonJS file with the WASM embedded as base64
     * and no bare imports to rewrite, so pre-bundling it is slow and seemingly
     * pointless. Excluding it breaks the app.
     *
     * The reason is its UMD preamble, which ends `}(this, function () {...}))`
     * and falls through to `root.cv = factory()` when it finds neither `define`
     * nor `exports`. Served raw as an ES module, top-level `this` is `undefined`
     * under strict mode, so that assignment throws
     * `Cannot set properties of undefined (setting 'cv')` and OpenCV never
     * loads. Pre-bundling wraps it in esbuild's CommonJS shim, which supplies
     * `exports` and `module` so the UMD takes its `module.exports = cv` branch
     * instead.
     *
     * Listing it explicitly also covers the worker: the dependency is only
     * reachable through a dynamic `import()` inside `opencv/loader.ts`, which
     * the scanner does not always follow.
     */
    include: ['@techstark/opencv-js', 'tesseract.js'],
  },

  build: {
    // The OpenCV chunk is legitimately ~10 MB. Warning about it on every build
    // just trains you to ignore the warning that matters.
    chunkSizeWarningLimit: 12_000,
    rollupOptions: {
      output: {
        // Rolldown takes the function form only — the object map that Rollup
        // accepted is not part of its `manualChunks` type.
        manualChunks(id: string) {
          // Keep the two heavyweight runtimes in their own chunks so the app
          // shell paints before either has finished downloading. Together they
          // are ~25 MB uncompressed, which dwarfs everything else in the build.
          if (id.includes('@techstark/opencv-js')) return 'opencv'
          if (id.includes('onnxruntime-web')) return 'onnxruntime'
          return undefined
        },
      },
    },
  },
})
