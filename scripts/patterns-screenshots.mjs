/**
 * scripts/patterns-screenshots.mjs — run every pattern on the Agent Patterns Lab
 * with a real WebLLM model (headless Chrome + WebGPU) and save one screenshot per
 * pattern, plus the filled selection matrix.
 *
 * Requires: npm i puppeteer-core --no-save
 * Defaults to the live GitHub Pages site; set BASE_URL=http://localhost:5173 for dev.
 * PROFILE_DIR should be a short path (Chrome CacheStorage fails under long paths).
 *
 *   node scripts/patterns-screenshots.mjs              # all patterns
 *   ONLY=react,hitl node scripts/patterns-screenshots.mjs
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dirname, '../docs/screenshots/patterns')
mkdirSync(OUT, { recursive: true })

const CHROME  = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE    = process.env.BASE_URL || 'https://vishalmysore.github.io/harnessEngineeringDemo'
const PROFILE = process.env.PROFILE_DIR || 'C:/wspchrome'
const MODEL   = process.env.MODEL_ID || 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC'
const ORDER   = ['augmented', 'react', 'evalopt', 'chain', 'routing', 'sectioning', 'voting',
                 'orchestrator', 'hierarchical', 'swarm', 'hitl', 'detcontrol']
const ONLY    = process.env.ONLY ? process.env.ONLY.split(',') : ORDER
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: PROFILE,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--window-size=1440,1000'],
  defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
  protocolTimeout: 1800000,
})
const page = await browser.newPage()
page.on('pageerror', e => console.log('  [pageerror]', e.message))
await page.goto(`${BASE}/patterns.html`, { waitUntil: 'networkidle0' })
if (!process.env.KEEP_RESULTS) {
  await page.evaluate(() => Object.keys(localStorage).filter(k => /pattern/i.test(k)).forEach(k => localStorage.removeItem(k)))
  await page.reload({ waitUntil: 'networkidle0' })
}
console.log('WebGPU:', await page.evaluate(async () => !!(navigator.gpu && await navigator.gpu.requestAdapter())))

await page.screenshot({ path: resolve(OUT, '00-landing.png') })

const pickModel = await page.$$eval('#modelSelect option', (os, m) => os.some(o => o.value === m), MODEL)
if (pickModel) await page.select('#modelSelect', MODEL)
await page.click('#loadModelBtn')
await page.waitForFunction(() => !document.querySelector('#loadModelBtn').disabled && /ready|❌/i.test(document.querySelector('#modelStatus').textContent),
  { timeout: 1800000, polling: 2000 })
console.log(await page.$eval('#modelStatus', el => el.textContent))

let n = 1
for (const id of ORDER) {
  if (!ONLY.includes(id)) { n++; continue }
  const num = String(n++).padStart(2, '0')
  await page.click(`#patternNav .nav-item[data-id="${id}"]`)
  await sleep(400)
  const t0 = Date.now()
  await page.click('#runBtn')
  let decisions = 0
  // wait for the run to finish, answering any human-in-the-loop pauses
  while (true) {
    await sleep(1500)
    const done = await page.$eval('#runBtn', b => !b.disabled)
    if (done) break
    const hasDecide = await page.$('#controls .decide-btns button')
    if (hasDecide) {
      decisions++
      await page.$eval('#controls', el => el.scrollIntoView({ block: 'center' }))
      await sleep(300)
      await page.screenshot({ path: resolve(OUT, `${num}-${id}-pause${decisions}.png`) })
      const reject = await page.$('#controls .btn-reject')
      if (id === 'hitl' && decisions === 1 && reject) {
        await page.type('#controls .decide-text', 'Too blunt. Say clearly that the claim is on hold for a fraud review, not denied, and list what documents the claimant should send.')
        await reject.click()
      } else {
        await page.click('#controls .decide-btns button')
      }
    }
    if (Date.now() - t0 > 900000) { console.log('  timeout', id); break }
  }
  await page.evaluate(() => window.scrollTo(0, 0))
  await sleep(500)
  const stats = await page.$eval('#runStats', el => el.textContent.trim())
  const title = await page.$eval('#result', el => el.querySelector('.result-title')?.textContent || '')
  console.log(`  ✓ ${num} ${id} — ${title} — ${stats}`)
  await page.screenshot({ path: resolve(OUT, `${num}-${id}.png`) })
}

const matrix = await page.$('#matrix')
await matrix.evaluate(el => el.closest('section, .card, div').scrollIntoView())
await sleep(400)
const sec = await page.evaluateHandle(() => document.querySelector('#matrix').closest('section') || document.querySelector('#matrix').parentElement)
await sec.screenshot({ path: resolve(OUT, '13-selection-matrix.png') })
console.log('  ✓ matrix')
console.log(await page.$eval('#matrix', el => el.innerText))

await browser.close()
