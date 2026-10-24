/**
 * scripts/harness-screenshots.mjs — capture the walkthrough screenshots for the
 * main Harness Engineering page against the running dev server.
 *
 * Requires (dev-only, not a project dependency):
 *   npm i puppeteer-core --no-save
 * Uses the system Chrome; run the dev server first: npm run dev
 *
 *   node scripts/harness-screenshots.mjs
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dirname, '../docs/screenshots/harness')
mkdirSync(OUT, { recursive: true })

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = process.env.BASE_URL || 'http://localhost:5173'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--window-size=1440,1000'],
  defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
})

async function shoot(page, name, opts = {}) {
  await page.screenshot({ path: resolve(OUT, `${name}.png`), ...opts })
  console.log('  ✓', name)
}
async function shootEl(page, selector, name) {
  const el = await page.$(selector)
  await el.screenshot({ path: resolve(OUT, `${name}.png`) })
  console.log('  ✓', name)
}

async function pick(page, domain, scenario) {
  await page.select('#domainSelect', domain)
  await sleep(200)
  await page.select('#scenarioSelect', scenario)
  await sleep(200)
}
async function execute(page) {
  await page.click('#executeBtn')
  await page.waitForFunction(() => !document.querySelector('#executeBtn').disabled, { timeout: 60000 })
  await sleep(500)
  // scroll the trace to the top so the full run reads top-down
  await page.$eval('#traceContainer', el => { el.scrollTop = 0 })
}

const page = await browser.newPage()
await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle0' })
await page.evaluate(() => localStorage.removeItem('healthcare_harness_memories'))
await page.reload({ waitUntil: 'networkidle0' })
await sleep(500)

// 01 landing page, nothing run yet
await shoot(page, '01-landing', { fullPage: true })
// 02 model loader strip
await shoot(page, '02-model-loader', { clip: { x: 0, y: 0, width: 1440, height: 150 } })

await page.$eval('#mockToggle', el => { if (!el.checked) el.click() })
await sleep(200)

// 03–05 healthcare C: child with penicillin anaphylaxis
await pick(page, 'healthcare', 'C')
await execute(page)
await shoot(page, '03-healthcare-allergy-run', { fullPage: true })
await shootEl(page, '.panel-trace', '04-trace-panel')
await shootEl(page, '.panel-clinician', '05-review-desk')

// 06–07 reject & correct → correction stored in memory
await page.click('#rejectBtn')
await sleep(200)
await page.type('#correctionText', 'Penicillin anaphylaxis: never suggest any beta-lactam, including cephalosporins. Use azithromycin or clindamycin and document the allergy on the script.')
await shootEl(page, '.panel-clinician', '06-reject-and-correct')
await page.click('#submitCorrection')
await sleep(400)
await shoot(page, '07-correction-saved', { clip: { x: 0, y: 0, width: 1440, height: 1000 } })

// 08 re-run the same case — the Information layer finds the correction
await execute(page)
await shootEl(page, '.panel-trace', '08-memory-recalled')

// 09 healthcare D: warfarin + aspirin
await pick(page, 'healthcare', 'D')
await execute(page)
await shoot(page, '09-healthcare-warfarin', { fullPage: true })

// 10 insurance A: high fraud risk
await pick(page, 'insurance', 'A')
await execute(page)
await shoot(page, '10-insurance-fraud', { fullPage: true })

// 11 insurance C: payout above policy limit
await pick(page, 'insurance', 'C')
await execute(page)
await shootEl(page, '.panel-clinician', '11-insurance-limit-review')

// 12 career D: laid-off technician → CNC
await pick(page, 'career', 'D')
await execute(page)
await shoot(page, '12-career-retraining', { fullPage: true })

// 13 drug discovery C: hepatotoxicity block
await pick(page, 'drugDiscovery', 'C')
await execute(page)
await shoot(page, '13-drug-hepatotox-block', { fullPage: true })

// 14 drug discovery approve
await page.click('#approveBtn')
await sleep(300)
await shootEl(page, '.panel-clinician', '14-drug-approved')

// leave the shared store clean
await page.evaluate(() => localStorage.removeItem('healthcare_harness_memories'))

await browser.close()
console.log('\nDone →', OUT)
