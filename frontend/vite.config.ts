import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'

// The page calls `/read` on its own host. In dev and preview that host is Vite,
// so those two paths are forwarded to python/serve.py.
const pythonReader = {
  '/health': 'http://127.0.0.1:8756',
  '/read': 'http://127.0.0.1:8756',
  '/document': 'http://127.0.0.1:8756',
  '/page': 'http://127.0.0.1:8756',
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  server: { proxy: pythonReader },
  preview: { proxy: pythonReader },
})
