import { defineConfig } from 'vite'

export default defineConfig(({ command }) => ({
  root: 'src',
  base: command === 'build' ? '/harnessEngineeringDemo/' : '/',
  build: {
    outDir: '../dist',
    emptyOutDir: true
  }
}))
