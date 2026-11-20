/**
 * runtime.js — the execution context every pattern runs through.
 *
 * Every `ctx.llm()` is a REAL WebLLM generation on the model loaded in the page
 * (same worker + llm.js as the harness and loop pages). Every `ctx.tool()` calls the
 * REAL domain tool functions from src/domains/. Nothing here is scripted: the graph
 * lights up from what actually happened, and the metrics are measured.
 *
 * WebLLM runs one engine per tab, so generations are serialised through a queue.
 * Fan-out patterns still dispatch their calls concurrently (Promise.all) — the
 * graph shows workers as "queued" until the GPU picks them up.
 */
import { callLLMWithTools, extractText, onGeneration } from '../utils/llm.js'

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const now = () => new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
export const compact = (o) => JSON.stringify(o)
export const short = (s, n = 260) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }

// ── parsing helpers for small-model output ────────────────────
/** First JSON object/array in a reply — tolerant of code fences, prose around it, trailing commas. */
export function firstJSON(text, want = 'any') {
  const t = String(text || '').replace(/```(?:json)?/gi, '')
  const opens = want === 'array' ? ['['] : want === 'object' ? ['{'] : ['{', '[']
  for (let i = 0; i < t.length; i++) {
    if (!opens.includes(t[i])) continue
    const open = t[i], close = open === '{' ? '}' : ']'
    let depth = 0, inStr = false
    for (let j = i; j < t.length; j++) {
      const c = t[j]
      if (inStr) { if (c === '\\') j++; else if (c === '"') inStr = false; continue }
      if (c === '"') inStr = true
      else if (c === open) depth++
      else if (c === close && --depth === 0) {
        const raw = t.slice(i, j + 1)
        for (const cand of [raw, raw.replace(/,\s*([}\]])/g, '$1'), raw.replace(/'/g, '"').replace(/,\s*([}\]])/g, '$1')]) {
          try { return JSON.parse(cand) } catch (_) { /* try next */ }
        }
        break
      }
    }
  }
  return null
}

/** Which of `labels` appears first in the text (whole word, case-insensitive). */
export function pickLabel(text, labels) {
  const t = String(text || '').toUpperCase()
  let best = null, bestAt = Infinity
  for (const l of labels) {
    const m = new RegExp(`(^|[^A-Z_])${l.toUpperCase()}([^A-Z_]|$)`).exec(t)
    if (m && m.index < bestAt) { best = l; bestAt = m.index }
  }
  return best
}

// ── LLM queue (one WebGPU engine per tab) ─────────────────────
let chain = Promise.resolve()
function enqueue(fn) {
  const p = chain.then(fn)
  chain = p.catch(() => {})
  return p
}

export class StopError extends Error { constructor() { super('Stopped by user') } }

/**
 * Build a run context bound to one pattern run.
 * els: { trace, controls, result }  graph: createGraph() instance
 */
export function makeRun({ graph, els }) {
  let stopped = false
  const metrics = { calls: 0, promptTokens: 0, completionTokens: 0, llmMs: 0, t0: performance.now() }
  const unsub = onGeneration(({ latencyMs, usage }) => {
    metrics.calls++
    metrics.llmMs += latencyMs || 0
    metrics.promptTokens += usage?.prompt_tokens || 0
    metrics.completionTokens += usage?.completion_tokens || 0
  })

  function line(cls, label, msg, detail) {
    els.trace.querySelector('.trace-empty-sub')?.remove()
    const el = document.createElement('div')
    el.className = `trace-entry ${cls}`
    el.innerHTML = `<span class="trace-time">${now()}</span><span class="trace-label">[${esc(label)}]</span><span class="trace-msg">${esc(msg)}${detail ? `<span class="trace-detail">${esc(detail)}</span>` : ''}</span>`
    els.trace.appendChild(el)
    els.trace.scrollTop = els.trace.scrollHeight
    return el
  }

  const ctx = {
    metrics,
    get stopped() { return stopped },
    stop() { stopped = true },
    check() { if (stopped) throw new StopError() },
    finish() { unsub(); metrics.wallMs = performance.now() - metrics.t0; return metrics },

    log(kind, msg, detail) {
      const map = {
        step:  ['trace-focus', '◆ PATTERN'], ok: ['trace-complete', 'OK'], warn: ['trace-high', '!'],
        note:  ['trace-default', '·'], gate: ['trace-moderate', 'GATE'], rule: ['trace-dosage', 'RULE'],
        human: ['trace-allergy', 'HUMAN'], route: ['trace-exec', 'ROUTE'], handoff: ['trace-exec', 'HANDOFF'],
      }
      const [cls, label] = map[kind] || map.note
      return line(cls, label, msg, detail)
    },
    node: (id, state, sub) => graph.set(id, state, sub),
    take: (s, t, bad) => graph.take(s, t, bad),
    addNodes: (nodes, edges) => graph.add(nodes, edges),

    /** One real model generation. */
    async llm({ node, system, user, maxTokens = 256, temperature = 0.2, label }) {
      ctx.check()
      if (node) graph.set(node, 'queued')
      return enqueue(async () => {
        ctx.check()
        if (node) graph.set(node, 'running')
        const tag = label || node || 'LLM'
        line('trace-info', 'LLM ▸', `${tag} — prompt ${user.length} chars · T=${temperature} · max ${maxTokens} tok`)
        const t0 = performance.now()
        const resp = await callLLMWithTools([{ role: 'user', content: user }], system, [], null, { max_tokens: maxTokens, temperature })
        const text = extractText(resp)
        const secs = ((performance.now() - t0) / 1000).toFixed(1)
        const toks = resp.usage?.completion_tokens
        line('trace-exec', 'LLM ◂', `${tag} · ${secs}s${toks ? ` · ${toks} tok` : ''}`, short(text, 420))
        if (node) graph.set(node, 'done')
        return text
      })
    },

    /** Call a real domain tool function. */
    tool(node, domain, name, ...args) {
      ctx.check()
      if (node) graph.set(node, 'running')
      const result = domain.toolFns[name](...args)
      line('trace-feedback', 'TOOL', `${name}(${args.map(a => JSON.stringify(a)).join(', ')})`, short(compact(result), 300))
      if (node) graph.set(node, result?.error ? 'fail' : 'done')
      return result
    },

    /** A programmatic check between steps. */
    gate(node, pass, msg) {
      graph.set(node, pass ? 'pass' : 'fail', pass ? 'PASS' : 'FAIL')
      line(pass ? 'trace-complete' : 'trace-high', pass ? 'GATE ✓' : 'GATE ✗', msg)
      return pass
    },

    /** Pause for a human. options: [{label, value, cls}] ; withText adds a feedback box. */
    decide(prompt, options, { withText = false, placeholder = '' } = {}) {
      return new Promise((resolve, reject) => {
        const c = els.controls
        c.innerHTML = `<div class="decide-prompt">${esc(prompt)}</div>${withText ? `<textarea class="decide-text" rows="2" placeholder="${esc(placeholder)}"></textarea>` : ''}<div class="decide-btns"></div>`
        const btns = c.querySelector('.decide-btns')
        options.forEach(o => {
          const b = document.createElement('button')
          b.className = `btn ${o.cls || 'btn-reset'}`
          b.textContent = o.label
          b.dataset.value = o.value
          b.addEventListener('click', () => {
            const text = c.querySelector('.decide-text')?.value?.trim() || ''
            c.innerHTML = ''
            resolve({ value: o.value, text })
          }, { once: true })
          btns.appendChild(b)
        })
        c.classList.remove('hidden')
        ctx._rejectDecide = () => { c.innerHTML = ''; reject(new StopError()) }
      })
    },

    /** Render the pattern's final output card. */
    result(title, html, tone = 'ok') {
      els.result.className = `pattern-result tone-${tone}`
      els.result.innerHTML = `<div class="result-title">${esc(title)}</div><div class="result-body">${html}</div>`
    },
  }
  return ctx
}

export { esc }
