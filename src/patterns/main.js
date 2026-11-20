/**
 * main.js — Agent Patterns Lab page controller.
 * Model loader (shared worker/llm.js), pattern picker, run/stop, live matrix.
 */
import { WEBLLM_MODELS, loadModel, getModelStatus, getLoadedModelId } from '../utils/llm.js'
import { createGraph } from './graph.js'
import { makeRun, StopError, esc } from './runtime.js'
import { PATTERNS, GROUPS } from './catalog.js'

// Small, fast models first: patterns make many calls.
const MODELS = [
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', name: 'Qwen 2.5 1.5B (~1.6 GB) — Recommended' },
  { id: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC', name: 'Qwen 2.5 1.5B f32 (~1.9 GB) — Intel / no-f16 GPUs' },
  { id: 'Qwen2.5-0.5B-Instruct-q4f32_1-MLC', name: 'Qwen 2.5 0.5B (~0.9 GB) — Fastest, weakest' },
  ...WEBLLM_MODELS,
].filter((m, i, a) => a.findIndex(x => x.id === m.id) === i)

const RESULTS_KEY = 'agent_patterns_lab_results'
const $ = (id) => document.getElementById(id)
const fmtS = (ms) => `${(ms / 1000).toFixed(1)}s`

let current = PATTERNS[0]
let running = null
let graph = null

// ── results store ─────────────────────────────────────────────
const loadResults = () => { try { return JSON.parse(localStorage.getItem(RESULTS_KEY) || '{}') } catch { return {} } }
const saveResults = (r) => { try { localStorage.setItem(RESULTS_KEY, JSON.stringify(r)) } catch { /* private mode */ } }

function renderMatrix() {
  const res = loadResults()
  const models = [...new Set(Object.values(res).map(r => r.model))]
  $('matrixModel').textContent = models.length ? models.map(m => m.replace(/-MLC$/, '')).join(', ') : 'your model'
  const rows = PATTERNS.map(p => {
    const r = res[p.id]
    const live = r
      ? `<td class="num">${r.calls}</td><td class="num">${(r.promptTokens + r.completionTokens).toLocaleString()}<small> (${r.completionTokens.toLocaleString()} out)</small></td><td class="num">${fmtS(r.wallMs)}</td><td class="outcome ${r.ok ? 'o-ok' : 'o-bad'}">${esc(r.outcome)}</td>`
      : `<td class="num dim">—</td><td class="num dim">—</td><td class="num dim">—</td><td class="dim"><button class="link-btn" data-run="${p.id}">run it</button></td>`
    return `<tr class="${p.id === current.id ? 'sel' : ''}"><td><button class="link-btn strong" data-pick="${p.id}">${esc(p.name)}</button></td><td>${esc(p.control)}</td><td>${esc(p.bestUse)}</td><td>${esc(p.tradeoff)}</td>${live}</tr>`
  }).join('')
  $('matrix').innerHTML = `<thead><tr><th>Pattern</th><th>Control flow</th><th>Best use</th><th>Primary trade-off</th><th class="live">LLM calls</th><th class="live">Tokens</th><th class="live">Wall time</th><th class="live">Outcome</th></tr></thead><tbody>${rows}</tbody>`
  $('matrix').querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => { select(b.dataset.pick); window.scrollTo({ top: 0, behavior: 'smooth' }) }))
  $('matrix').querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => { select(b.dataset.run); window.scrollTo({ top: 0, behavior: 'smooth' }); run() }))
}

// ── nav + stage ───────────────────────────────────────────────
function renderNav() {
  const res = loadResults()
  $('patternNav').innerHTML = GROUPS.map(g => `<div class="nav-group"><div class="nav-group-name">${esc(g.name)}</div>${
    PATTERNS.filter(p => p.group === g.id).map(p => `<button class="nav-item ${p.id === current.id ? 'active' : ''}" data-id="${p.id}"><span>${esc(p.name)}</span>${res[p.id] ? `<i class="${res[p.id].ok ? 'ok' : 'bad'}">●</i>` : ''}</button>`).join('')
  }</div>`).join('')
  $('patternNav').querySelectorAll('.nav-item').forEach(b => b.addEventListener('click', () => select(b.dataset.id)))
}

function select(id) {
  if (running) return
  current = PATTERNS.find(p => p.id === id) || PATTERNS[0]
  history.replaceState(null, '', `#${current.id}`)
  $('pGroup').textContent = GROUPS.find(g => g.id === current.group).name
  $('pName').textContent = current.name
  $('pBadges').innerHTML = `<span class="badge">${esc(current.control)}</span><span class="badge">best for: ${esc(current.bestUse)}</span><span class="badge warn">trade-off: ${esc(current.tradeoff)}</span>`
  $('pUsecase').textContent = current.usecase
  $('pExplain').innerHTML = current.explain
  const inp = current.input
  $('pInput').classList.toggle('hidden', !inp)
  if (inp) {
    $('pInputLabel').textContent = inp.label
    $('pInputSample').innerHTML = inp.samples.map((s, i) => `<option value="${i}">Sample ${i + 1}: ${esc(s.slice(0, 70))}…</option>`).join('')
    $('pInputText').value = inp.samples[0]
  }
  graph.reset(current.graph)
  $('controls').className = 'pl-controls hidden'; $('controls').innerHTML = ''
  $('result').className = 'pattern-result hidden'; $('result').innerHTML = ''
  $('trace').innerHTML = '<div class="trace-empty-sub">Run this pattern to stream its trace.</div>'
  const r = loadResults()[current.id]
  $('runStats').innerHTML = r ? `Last run on ${esc(r.model.replace(/-MLC$/, ''))}: ${r.calls} LLM calls · ${(r.promptTokens + r.completionTokens).toLocaleString()} tokens · ${fmtS(r.wallMs)} · ${esc(r.outcome)}` : ''
  renderNav(); renderMatrix()
}

async function run() {
  if (running) return
  if (getModelStatus() !== 'ready') {
    setModelStatus('fail', '⬆ Load a model first — every pattern runs on the real model.')
    $('loadModelBtn').classList.add('pulse'); setTimeout(() => $('loadModelBtn').classList.remove('pulse'), 2400)
    return
  }
  const p = current
  graph.reset(p.graph)
  $('trace').innerHTML = ''
  $('controls').className = 'pl-controls hidden'; $('controls').innerHTML = ''
  $('result').className = 'pattern-result hidden'
  $('runStats').textContent = 'Running…'
  $('runBtn').disabled = true; $('runBtn').textContent = '⟳ Running…'; $('stopBtn').disabled = false
  document.body.classList.add('is-running')
  const ctx = makeRun({ graph, els: { trace: $('trace'), controls: $('controls'), result: $('result') } })
  running = ctx
  ctx.log('step', `${p.name} — ${p.usecase} · model ${getLoadedModelId()}`)
  let outcome, ok = true
  try {
    const r = await p.run(ctx, p.input ? $('pInputText').value : undefined)
    // a pattern may return { text, ok } or a plain outcome string
    outcome = typeof r === 'object' ? r.text : String(r)
    ok = typeof r === 'object' ? !!r.ok : !/fail|miss|invalid|not |no |open|ungrounded|misroute|rejected|human/i.test(outcome)
  } catch (err) {
    ok = false
    outcome = err instanceof StopError ? 'Stopped' : `Error: ${err.message}`
    ctx.log('warn', outcome)
    if (!(err instanceof StopError)) ctx.result('Run error', `<p>${esc(err.message)}</p>`, 'bad')
  }
  const m = ctx.finish()
  running = null
  $('runBtn').disabled = false; $('runBtn').textContent = '↻ Run again'; $('stopBtn').disabled = true
  document.body.classList.remove('is-running')
  $('controls').classList.add('hidden')
  ctx.log(ok ? 'ok' : 'warn', `Done: ${outcome} · ${m.calls} LLM calls · ${(m.promptTokens + m.completionTokens).toLocaleString()} tokens · ${fmtS(m.wallMs)}`)
  if (outcome !== 'Stopped') {
    const all = loadResults()
    all[p.id] = { model: getLoadedModelId(), calls: m.calls, promptTokens: m.promptTokens, completionTokens: m.completionTokens, wallMs: m.wallMs, outcome, ok, at: new Date().toISOString() }
    saveResults(all)
  }
  $('runStats').textContent = `${m.calls} LLM calls · ${(m.promptTokens + m.completionTokens).toLocaleString()} tokens (${m.completionTokens.toLocaleString()} generated) · ${fmtS(m.wallMs)} wall · ${fmtS(m.llmMs)} on the GPU`
  renderNav(); renderMatrix()
}

// ── model loader (same flow as the harness + loop pages) ──────
function setModelStatus(type, msg) {
  const el = $('modelStatus')
  el.textContent = msg
  el.className = `test-result test-result-${type}`
  if (type === 'ok') setTimeout(() => { if (el.textContent === msg) el.classList.add('hidden') }, 4000)
}

async function handleLoadModel() {
  const modelId = $('modelSelect').value
  const btn = $('loadModelBtn'), prog = $('modelProgress'), fill = $('modelProgressFill'), label = $('modelProgressLabel')
  btn.disabled = true; btn.textContent = '⟳ Loading…'
  prog.classList.remove('hidden'); fill.style.width = '0%'; label.textContent = 'Initialising…'
  $('modelStatus').className = 'test-result hidden'
  try {
    await loadModel(modelId, (ev) => {
      if (ev.type === 'device') label.textContent = 'WebGPU detected — starting download…'
      else if (ev.type === 'downloading') { fill.style.width = `${ev.progress}%`; label.textContent = `Downloading… ${ev.progress}%` }
      else if (ev.type === 'phase' && ev.phase === 'compile') { label.textContent = 'Compiling WebGPU shaders… (first load only)'; fill.style.width = '95%' }
      else if (ev.type === 'ready') { fill.style.width = '100%'; label.textContent = 'Ready' }
    })
    setModelStatus('ok', `✅ Model ready: ${modelId}`)
    $('gpuNote').innerHTML = `Model <b>${esc(modelId)}</b> is loaded. Pick a pattern and press <b>▶ Run pattern</b>.`
  } catch (err) {
    setModelStatus('fail', `❌ ${err.message}`)
  } finally {
    btn.disabled = false; btn.textContent = '⬇ Load Model'
    setTimeout(() => prog.classList.add('hidden'), 1500)
  }
}

// ── init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  MODELS.forEach(m => { const o = document.createElement('option'); o.value = m.id; o.textContent = m.name; $('modelSelect').appendChild(o) })
  graph = createGraph($('graph'))
  $('loadModelBtn').addEventListener('click', handleLoadModel)
  $('runBtn').addEventListener('click', run)
  $('stopBtn').addEventListener('click', () => { if (running) { running.stop(); running._rejectDecide?.(); $('stopBtn').disabled = true } })
  $('clearMatrixBtn').addEventListener('click', () => { saveResults({}); select(current.id) })
  $('pInputSample').addEventListener('change', (e) => { $('pInputText').value = current.input.samples[+e.target.value] })
  window.addEventListener('resize', () => graph.fit())
  select(location.hash.slice(1) || PATTERNS[0].id)
})

// handy for scripted validation runs
window.__patternsLab = { select, run, isRunning: () => !!running, patterns: PATTERNS.map(p => p.id) }
