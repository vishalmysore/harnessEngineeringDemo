/**
 * scripts/screenshots.mjs — capture the article screenshots for the Loop
 * Engineering page against the running dev server (http://localhost:5173).
 *
 * Requires (dev-only, not a project dependency):
 *   npm i puppeteer-core --no-save
 * Uses the system Chrome; run the dev server first: npm run dev
 *
 *   node scripts/screenshots.mjs
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dirname, '../docs/screenshots')
mkdirSync(OUT, { recursive: true })

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = process.env.BASE_URL || 'http://localhost:5173'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--window-size=1400,1000'],
  defaultViewport: { width: 1400, height: 1000, deviceScaleFactor: 1 },
})

async function shoot(page, name, opts = {}) {
  await page.screenshot({ path: resolve(OUT, `${name}.png`), ...opts })
  console.log('  ✓', name)
}

async function cardHandle(page, n) {
  const cards = await page.$$('.tech-card')
  return cards[n - 1]
}
async function runCard(page, n, waitMs = 4500) {
  const card = await cardHandle(page, n)
  await card.$eval('.run-btn', b => b.click())
  await sleep(waitMs)
  return card
}

const page = await browser.newPage()

// ── Loop page ──────────────────────────────────────────────────
console.log('Loop page:')
await page.goto(`${BASE}/loop.html`, { waitUntil: 'networkidle0' })
await sleep(600)

// 01 full-page overview
await shoot(page, '01-overview-full', { fullPage: true })

// 02 header / model loader (top strip)
await shoot(page, '02-header', { clip: { x: 0, y: 0, width: 1400, height: 140 } })

// enable mock mode so the real orchestrator runs with no GPU
await page.$eval('#mockToggle', el => { if (!el.checked) el.click() })
await sleep(200)

// 03 single card explainer (card #1 termination, before running)
await (await cardHandle(page, 1)).screenshot({ path: resolve(OUT, '03-card-explainer.png') })
console.log('  ✓ 03-card-explainer')

// 04 guardrail card mid/after-run (#3 drugDiscovery hepatotox block)
{
  const card = await runCard(page, 3, 5000)
  await card.screenshot({ path: resolve(OUT, '04-guardrail-run.png') })
  console.log('  ✓ 04-guardrail-run')
}

// 05 memory card run (#6 healthcare penicillin — shows "Found N corrections")
{
  const card = await runCard(page, 6, 4500)
  await card.screenshot({ path: resolve(OUT, '05-memory-run.png') })
  console.log('  ✓ 05-memory-run')
}

// 06 HITL card with decision buttons visible (#9)
{
  const card = await cardHandle(page, 9)
  await card.$eval('.run-btn', b => b.click())
  // wait until the decide buttons appear
  for (let i = 0; i < 30; i++) { await sleep(300); const has = await card.$('.tech-controls button'); if (has) break }
  await card.screenshot({ path: resolve(OUT, '06-hitl-decision.png') })
  console.log('  ✓ 06-hitl-decision')
  // approve, then capture the closed loop
  const approve = await card.$$('.tech-controls button')
  if (approve[0]) { await approve[0].click(); await sleep(600) }
  await card.screenshot({ path: resolve(OUT, '07-hitl-approved.png') })
  console.log('  ✓ 07-hitl-approved')
}

// 08 retry card (#7 career) — real backoff/retry
{
  const card = await runCard(page, 7, 2500)
  await card.screenshot({ path: resolve(OUT, '08-retry-run.png') })
  console.log('  ✓ 08-retry-run')
}

// reset memory we seeded, to leave the shared store clean
await page.evaluate(() => localStorage.removeItem('healthcare_harness_memories'))

// ── Harness page (context shot) ────────────────────────────────
console.log('Harness page:')
await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle0' })
await sleep(500)
await shoot(page, '09-harness-page')

await browser.close()
console.log('\nDone →', OUT)
