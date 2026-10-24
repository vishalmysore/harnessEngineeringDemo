/**
 * scripts/real-model-screenshot.mjs — load a real WebLLM model in Chrome
 * (WebGPU) and capture one live run on the Harness page.
 *
 * Requires: npm i puppeteer-core --no-save ; dev server running (npm run dev).
 * Downloads the model once into PROFILE_DIR, so later runs start fast.
 *
 *   node scripts/real-model-screenshot.mjs
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dirname, '../docs/screenshots/harness')
mkdirSync(OUT, { recursive: true })

const CHROME  = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE    = process.env.BASE_URL || 'http://localhost:5173'
const PROFILE = process.env.PROFILE_DIR || resolve(__dirname, '../.chrome-webgpu-profile')
const MODEL   = process.env.MODEL_ID || 'Llama-3.2-1B-Instruct-q4f32_1-MLC'

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: PROFILE,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--window-size=1440,1000'],
  defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
  protocolTimeout: 900000,
})
const page = await browser.newPage()
await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle0' })
await page.evaluate(() => localStorage.removeItem('healthcare_harness_memories'))

console.log('WebGPU:', await page.evaluate(async () => !!(navigator.gpu && await navigator.gpu.requestAdapter())))

await page.select('#modelSelect', MODEL)
await page.click('#loadModelBtn')
await page.waitForFunction(() => /ready/i.test(document.querySelector('#modelStatus').textContent)
  || /error|fail/i.test(document.querySelector('#modelStatus').textContent), { timeout: 900000, polling: 2000 })
console.log(await page.$eval('#modelStatus', el => el.textContent))
await page.screenshot({ path: resolve(OUT, '15-real-model-loaded.png'), clip: { x: 0, y: 0, width: 1440, height: 150 } })

await page.select('#domainSelect', process.env.DOMAIN || 'healthcare')
await page.select('#scenarioSelect', process.env.SCENARIO || 'C')
const t0 = Date.now()
await page.click('#executeBtn')
await page.waitForFunction(() => !document.querySelector('#executeBtn').disabled, { timeout: 900000, polling: 2000 })
console.log('run seconds:', (Date.now() - t0) / 1000)
await page.$eval('#traceContainer', el => { el.scrollTop = 0 })
await page.screenshot({ path: resolve(OUT, '16-real-model-run.png') })
console.log(await page.$eval('#traceContainer', el => el.innerText))

await browser.close()
