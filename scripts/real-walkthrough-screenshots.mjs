/**
 * scripts/real-walkthrough-screenshots.mjs — capture the article walkthrough on a
 * REAL WebLLM model (no mock mode). Loads the model once, then runs each case.
 *
 * Requires: npm i puppeteer-core --no-save ; dev server running (npm run dev).
 * The model is cached in PROFILE_DIR after the first download.
 *
 *   node scripts/real-walkthrough-screenshots.mjs
 *   STEPS=insurance-A,career-D node scripts/real-walkthrough-screenshots.mjs   # re-run some
 *
 * Writes PNGs to docs/screenshots/real/ and each run's trace + plan to
 * docs/screenshots/real/runs.json, so the article can quote what really happened.
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dirname, '../docs/screenshots/real')
mkdirSync(OUT, { recursive: true })
const RUNS_FILE = resolve(OUT, 'runs.json')

const CHROME  = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE    = process.env.BASE_URL || 'http://localhost:5173'
const PROFILE = process.env.PROFILE_DIR || resolve(__dirname, '../.chrome-webgpu-profile')
const MODEL   = process.env.MODEL_ID || 'Llama-3.2-3B-Instruct-q4f32_1-MLC'
const ONLY    = process.env.STEPS ? new Set(process.env.STEPS.split(',')) : null
const sleep = ms => new Promise(r => setTimeout(r, ms))
const runs = existsSync(RUNS_FILE) ? JSON.parse(readFileSync(RUNS_FILE, 'utf8')) : {}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: PROFILE,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--window-size=1440,1000'],
  defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
  protocolTimeout: 1800000,
})
const page = await browser.newPage()
await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle0' })
await page.evaluate(() => localStorage.removeItem('healthcare_harness_memories'))
await page.reload({ waitUntil: 'networkidle0' })

async function shoot(name, opts = {}) {
  await page.screenshot({ path: resolve(OUT, `${name}.png`), ...opts })
  console.log('  ✓', name)
}
async function shootEl(selector, name) {
  await (await page.$(selector)).screenshot({ path: resolve(OUT, `${name}.png`) })
  console.log('  ✓', name)
}
async function pick(domain, scenario) {
  await page.select('#domainSelect', domain)
  await sleep(200)
  await page.select('#scenarioSelect', scenario)
  await sleep(200)
}
async function execute(key) {
  const t0 = Date.now()
  await page.click('#executeBtn')
  await page.waitForFunction(() => !document.querySelector('#executeBtn').disabled, { timeout: 1800000, polling: 2000 })
  await sleep(500)
  await page.$eval('#traceContainer', el => { el.scrollTop = 0 })
  const seconds = Math.round((Date.now() - t0) / 1000)
  const trace = await page.$eval('#traceContainer', el => el.innerText)
  const review = await page.$eval('#clinicianPanel', el => el.innerText)
  runs[key] = { model: MODEL, seconds, trace, review }
  writeFileSync(RUNS_FILE, JSON.stringify(runs, null, 2))
  console.log(`  ${key}: ${seconds}s`)
}
const want = key => !ONLY || ONLY.has(key)

// ── load the model once ─────────────────────────────────────────
console.log('Loading', MODEL)
await page.select('#modelSelect', MODEL)
await page.click('#loadModelBtn')
await page.waitForFunction(() => /ready|❌/i.test(document.querySelector('#modelStatus').textContent),
  { timeout: 1800000, polling: 2000 })
console.log(' ', await page.$eval('#modelStatus', el => el.textContent))
await shoot('00-model-ready', { clip: { x: 0, y: 0, width: 1440, height: 150 } })
await sleep(4500) // let the "ready" notice fade before the run shots

// ── healthcare C: penicillin allergy, correction, memory recall ─
if (want('healthcare-C')) {
  await pick('healthcare', 'C')
  await execute('healthcare-C')
  await shoot('01-healthcare-allergy-run')
  await shootEl('.panel-trace', '02-trace-panel')
  await shootEl('.panel-clinician', '03-review-desk')

  if (!await page.$('#rejectBtn')) throw new Error('healthcare-C run ended without a review card')
  await page.click('#rejectBtn')
  await sleep(200)
  await page.type('#correctionText', 'Penicillin anaphylaxis: never suggest any beta-lactam, including cephalosporins. Use azithromycin or clindamycin and document the allergy on the script.')
  await shootEl('.panel-clinician', '04-reject-and-correct')
  await page.click('#submitCorrection')
  await sleep(400)
  await shoot('05-correction-saved')

  await execute('healthcare-C-recall')
  await shoot('06-memory-recalled')
}

// ── the other cases the article walks through ───────────────────
const cases = [
  ['healthcare-D',    'healthcare',    'D', '07-healthcare-warfarin'],
  ['insurance-A',     'insurance',     'A', '08-insurance-fraud'],
  ['insurance-C',     'insurance',     'C', '09-insurance-limit'],
  ['career-D',        'career',        'D', '10-career-retraining'],
  ['drugDiscovery-C', 'drugDiscovery', 'C', '11-drug-hepatotox-block'],
]
for (const [key, domain, scenario, shot] of cases) {
  if (!want(key)) continue
  await pick(domain, scenario)
  await execute(key)
  await shoot(shot)
  if (key === 'drugDiscovery-C' && await page.$('#approveBtn')) {
    await page.click('#approveBtn')
    await sleep(300)
    await shootEl('.panel-clinician', '12-drug-approved')
  }
}

await page.evaluate(() => localStorage.removeItem('healthcare_harness_memories'))
await browser.close()
console.log('\nDone →', OUT)
