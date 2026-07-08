import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

const securityHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig(({ command }) => ({
  root: 'src',
  base: command === 'build' ? '/harnessEngineeringDemo/' : '/',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      input: {
        // Existing harness-engineering demo — unchanged default entry.
        main: fileURLToPath(new URL('./src/index.html', import.meta.url)),
        // New loop-engineering demo — additive sibling page.
        loop: fileURLToPath(new URL('./src/loop.html', import.meta.url)),
      },
    },
  },
  worker: {
    format: 'es',
  },
  plugins: [
    {
      name: 'wasm-content-type',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm')
          if (req.url?.endsWith('.mjs'))  res.setHeader('Content-Type', 'application/javascript')
          for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v)
          next()
        })
      },
    },
  ],
  server:  { headers: securityHeaders },
  preview: { headers: securityHeaders },
}))
