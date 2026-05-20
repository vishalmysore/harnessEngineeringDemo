import { defineConfig } from 'vite'

export default defineConfig(({ command }) => ({
  root: 'src',
  base: command === 'build' ? '/harnessEngineeringDemo/' : '/',
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true
  }
}))
