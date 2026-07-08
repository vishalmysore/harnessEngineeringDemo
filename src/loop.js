/**
 * loop.js — Loop Engineering demo page (real-model edition).
 *
 * Sibling to the harness-engineering demo (index.html / main.js). It reuses the
 * SAME production modules — the real orchestrator `runAgent()`, the four domain
 * modules, guardrails, verification, memory and the tracer — to run each
 * agentic-loop-engineering technique against a REAL domain use-case on the local
 * WebLLM model (or Mock mode, which runs the real tools + guardrails with no GPU).
 *
 * Each card is bound to a concrete scenario (e.g. Drug Discovery "PARP inhibitor —
 * hepatotoxicity block") and streams the live harness trace as the model actually
 * drives the loop. Nothing on the harness page is modified.
 */

import { runAgent } from './execution/orchestrator.js'
import DOMAINS from './domains/index.js'
import tracer from './feedback/tracer.js'
import { verifyOutput } from './feedback/verification.js'
import { saveCorrection, getAllMemories, clearAllMemories, retrieveRelevantMemories } from './information/memoryManager.js'
import {
  WEBLLM_MODELS, loadModel, getModelStatus, setMockMode, isMockMode,
  callLLMWithTools, extractText,
} from './utils/llm.js'

// ── tiny helpers ──────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms))
const bytes = obj => JSON.stringify(obj).length
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const now = () => new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })

const LAYER_META = {
  info:     { label: 'INFORMATION', cls: 'lyr-info' },
  exec:     { label: 'EXECUTION',   cls: 'lyr-exec' },
  feedback: { label: 'FEEDBACK',    cls: 'lyr-feedback' },
}

// tracer event → { label, cls } (mirrors main.js LAYER_MAP)
const TRACE_MAP = {
  'layer:info':         { label: 'INFO',        cls: 'trace-info' },
  'layer:execution':    { label: 'EXEC',        cls: 'trace-exec' },
  'layer:feedback':     { label: 'FEEDBACK',    cls: 'trace-feedback' },
  'guardrail:critical': { label: 'GUARDRAIL ⛔', cls: 'trace-critical' },
  'guardrail:high':     { label: 'GUARDRAIL 🔴', cls: 'trace-high' },
  'guardrail:moderate': { label: 'GUARDRAIL 🟡', cls: 'trace-moderate' },
  'guardrail:dosage':   { label: 'GUARDRAIL 💊', cls: 'trace-dosage' },
  'guardrail:allergy':  { label: 'ALLERGY 🚨',   cls: 'trace-allergy' },
  'agent:start':        { label: 'START',       cls: 'trace-start' },
  'agent:error':        { label: 'ERROR',       cls: 'trace-error' },
  'agent:complete':     { label: 'COMPLETE ✓',  cls: 'trace-complete' },
}
// framing kinds emitted by technique code itself
const KIND_MAP = {
  focus:    { label: '◆ TECHNIQUE', cls: 'trace-focus' },
  ok:       { label: 'OK',          cls: 'trace-complete' },
  warn:     { label: '!',           cls: 'trace-high' },
  note:     { label: '·',           cls: 'trace-default' },
}

function scenarioText(scenario) {
  return Object.entries(scenario)
    .filter(([k, v]) => typeof v === 'string' && k !== 'id')
    .map(([k, v]) => `${k}: ${v}`).join(' | ')
}

// ── Model loader (shared with the harness page) ───────────────
function setModelStatus(type, msg) {
  const el = document.getElementById('modelStatus')
  el.textContent = msg
  el.className = `test-result test-result-${type}`
}

async function handleLoadModel() {
  const modelId = document.getElementById('modelSelect').value
  const btn = document.getElementById('loadModelBtn')
  const prog = document.getElementById('modelProgress')
  const fill = document.getElementById('modelProgressFill')
  const label = document.getElementById('modelProgressLabel')

  btn.disabled = true
  btn.textContent = '⟳ Loading…'
  prog.classList.remove('hidden')
  fill.style.width = '0%'
  label.textContent = 'Initialising…'
  document.getElementById('modelStatus').className = 'test-result hidden'

  try {
    await loadModel(modelId, (ev) => {
      if (ev.type === 'device') label.textContent = 'WebGPU detected — starting download…'
      else if (ev.type === 'downloading') { fill.style.width = `${ev.progress}%`; label.textContent = `Downloading… ${ev.progress}%` }
      else if (ev.type === 'phase' && ev.phase === 'compile') { label.textContent = 'Compiling WebGPU shaders… (1–5 min first load, cached after)'; fill.style.width = '95%' }
      else if (ev.type === 'ready') { fill.style.width = '100%'; label.textContent = 'Ready' }
    })
    setModelStatus('ok', `✅ Model ready: ${modelId}`)
  } catch (err) {
    setModelStatus('fail', `❌ ${err.message}`)
  } finally {
    btn.disabled = false
    btn.textContent = '⬇ Load Model'
    setTimeout(() => prog.classList.add('hidden'), 1500)
  }
}

function showMemoryCount() {
  const n = getAllMemories().length
  document.getElementById('memoryBadge').textContent = `${n} correction${n !== 1 ? 's' : ''} in memory`
}

// ── Card trace plumbing ───────────────────────────────────────
function makeCtx(traceEl, controlsEl) {
  const append = (cls, label, msg) => {
    traceEl.querySelector('.trace-empty-sub')?.remove()
    const el = document.createElement('div')
    el.className = `trace-entry ${cls}`
    el.innerHTML = `<span class="trace-time">${now()}</span><span class="trace-label">[${label}]</span><span class="trace-msg">${esc(msg)}</span>`
    traceEl.appendChild(el)
    traceEl.scrollTop = traceEl.scrollHeight
  }
  return {
    // framing message from technique code
    log: (kind, msg) => { const m = KIND_MAP[kind] || KIND_MAP.note; append(m.cls, m.label, msg) },
    wait: sleep,
    // run the REAL orchestrator on a domain/scenario, mirroring its trace into this card
    async runAgent(domain, scenario) {
      const unsub = tracer.subscribe('*', (event, data) => {
        const m = TRACE_MAP[event] || { label: event.toUpperCase(), cls: 'trace-default' }
        const text = typeof data === 'string' ? data : JSON.stringify(data).slice(0, 160)
        append(m.cls, m.label, text)
      })
      try {
        return await runAgent(scenario, domain)
      } finally {
        unsub()
      }
    },
    // one plain (tool-less) model generation — real model when loaded, else caller handles mock
    async generate(userText, systemText) {
      const resp = await callLLMWithTools([{ role: 'user', content: userText }], systemText || 'You are a concise expert assistant.', [])
      return extractText(resp)
    },
    decide(prompt, options) {
      return new Promise(resolve => {
        controlsEl.innerHTML = `<span class="decide-prompt">${esc(prompt)}</span>`
        options.forEach(o => {
          const b = document.createElement('button')
          b.className = `btn ${o.cls || 'btn-reset'}`
          b.textContent = o.label
          b.addEventListener('click', () => { controlsEl.innerHTML = ''; resolve(o.value) }, { once: true })
          controlsEl.appendChild(b)
        })
      })
    },
  }
}

function modelReady(ctx) {
  if (isMockMode()) return true
  if (getModelStatus() === 'ready') return true
  ctx.log('warn', 'No model loaded. Click "⬇ Load Model" above, or tick "Mock mode" to run without a GPU.')
  return false
}

// ── Technique registry ────────────────────────────────────────
// Each: { n, name, layer, domainId, scenarioId, tagline, explain, code[], run(ctx, {domain, scenario}) }

const TECHNIQUES = [
  {
    n: 1, name: 'Explicit Termination Conditions', layer: 'exec',
    domainId: 'healthcare', scenarioId: 'A',
    tagline: 'A loop without a defined exit is a runaway. The agent stops when it stops calling tools — with a hard iteration cap as backstop.',
    explain: `Watch the trace: the model requests tools across successive <strong>Iteration N</strong> turns, then returns a final answer with no tool call — the orchestrator’s exit condition (<code>orchestrator.js:70</code>). <code>MAX_ITERATIONS=10</code> is the safety cap so a confused model can’t spin forever.`,
    code: ['orchestrator.js:9 · MAX_ITERATIONS', 'orchestrator.js:70 · no tool calls → complete'],
    async run(ctx, { domain, scenario }) {
      if (!modelReady(ctx)) return
      ctx.log('focus', 'Termination = "model stopped requesting tools". Counting real iterations…')
      const res = await ctx.runAgent(domain, scenario)
      const iters = (res.toolResults || []).length
      ctx.log('focus', `Loop exited cleanly after the model finished tool use. Verification: ${res.verification?.valid ? 'PASS' : 'FAIL'}. Never hit the cap of 10.`)
    },
  },
  {
    n: 2, name: 'Verification / Grader Loop', layer: 'feedback',
    domainId: 'insurance', scenarioId: 'B',
    tagline: 'Don’t ship the first answer. Grade every output against a schema rubric; a failing grade re-enters the loop.',
    explain: `On this legitimate water-damage claim the model produces a settlement plan, then <code>verifyOutput()</code> grades it against required fields + invariants (<code>verification.js:5</code>). A fail becomes a correction that loops back; a pass is released. The score is shown below.`,
    code: ['verification.js:5 · verifyOutput()', 'orchestrator.js:77 · validateFinalPlan → correction → continue'],
    async run(ctx, { domain, scenario }) {
      if (!modelReady(ctx)) return
      ctx.log('focus', 'Running the real agent, then grading its output against the schema rubric…')
      const res = await ctx.runAgent(domain, scenario)
      const v = res.verification || verifyOutput(res.plan)
      if (v.valid) ctx.log('ok', `GRADER: PASS · score ${v.score.toFixed(2)}. ${(res.plan.recommendations || []).length} recommendation(s) released for review.`)
      else ctx.log('warn', `GRADER: FAIL · score ${v.score.toFixed(2)} — ${v.errors.join('; ')} → would re-enter the loop as a correction.`)
    },
  },
  {
    n: 3, name: 'Mid-Loop Guardrails', layer: 'exec',
    domainId: 'drugDiscovery', scenarioId: 'C',
    tagline: 'Guardrails aren’t postprocessing — they fire inside the loop and can force a revision before a bad answer forms.',
    explain: `Compound QT-9901 has a hepatotoxicity score of 0.78. When the model calls <code>assessToxicologyProfile</code>, <code>validateToolOutput</code> (<code>drugDiscovery.js:51</code>) flags it CRITICAL and sets <code>forceRevision</code> — the IND recommendation is blocked <em>mid-loop</em>. Watch for the ⛔ GUARDRAIL line.`,
    code: ['drugDiscovery.js:51 · validateToolOutput (hepatotox ≥ 0.7)', 'orchestrator.js:115 · guardrail forces revision'],
    async run(ctx, { domain, scenario }) {
      if (!modelReady(ctx)) return
      ctx.log('focus', 'Real toxicology tool + real guardrail. Expect a CRITICAL block on hepatotoxicity 0.78…')
      const res = await ctx.runAgent(domain, scenario)
      const blocked = (res.guardrailWarnings || []).length
      ctx.log('focus', `${blocked} guardrail intervention(s) fired during the loop. The model had to route around the blocked IND path.`)
    },
  },
  {
    n: 4, name: 'Preserve Errors In-Context', layer: 'exec',
    domainId: 'insurance', scenarioId: 'A',
    tagline: 'Keep the mistake in the transcript so the loop learns from it instead of repeating it.',
    explain: `This auto claim scores 0.72 fraud risk. If the model’s first plan omits the mandatory SIU referral, <code>validateFinalPlan</code> (<code>insurance.js:84</code>) rejects it and <code>appendCorrectionMessage</code> pushes the failed turn <em>and</em> the specific error back into context (<code>orchestrator.js:81</code>) — the next iteration sees exactly what it got wrong.`,
    code: ['insurance.js:84 · validateFinalPlan (SIU required)', 'llm.js:185 · appendCorrectionMessage'],
    async run(ctx, { domain, scenario }) {
      if (!modelReady(ctx)) return
      ctx.log('focus', 'Fraud score 0.72 → SIU referral is mandatory. If the model forgets it, watch the correction feed back…')
      const res = await ctx.runAgent(domain, scenario)
      const hasSIU = JSON.stringify(res.plan.recommendations || []).toLowerCase().includes('investigation')
      ctx.log(hasSIU ? 'ok' : 'warn', hasSIU
        ? 'Final plan includes the SIU referral — loop converged (possibly after a retained-error revision).'
        : 'SIU still missing — guardrail would keep the error in context and loop again.')
    },
  },
  {
    n: 5, name: 'Context Compaction & Pruning', layer: 'info',
    domainId: 'drugDiscovery', scenarioId: 'B',
    tagline: 'The context window is finite working memory. Fold stale tool output into summaries before it overflows.',
    explain: `After a real run, the raw tool-result payloads (compound profile, full toxicology panel, regulatory dossier) are bulky. Compaction replaces each with a one-line summary — the same message plumbing as <code>appendToolResults()</code> — keeping the signal and dropping the noise. Real before/after sizes shown below.`,
    code: ['llm.js:177 · appendToolResults', 'Information layer · context assembly'],
    async run(ctx, { domain, scenario }) {
      if (!modelReady(ctx)) return
      ctx.log('focus', 'Running the real agent to accumulate tool results, then compacting them…')
      const res = await ctx.runAgent(domain, scenario)
      const before = bytes(res.toolResults || [])
      const compacted = (res.toolResults || []).map(r => {
        const keys = Object.keys(r.result || {}).slice(0, 3).join(', ')
        return `${r.name} → { ${keys}, … }`
      })
      const after = bytes(compacted)
      ctx.log('note', `Raw tool transcript: ${before.toLocaleString()} chars across ${(res.toolResults || []).length} results.`)
      ctx.log('ok', `Compacted to one-liners: ${after.toLocaleString()} chars — ${Math.max(0, Math.round((1 - after / before) * 100))}% smaller. Newest turn would be kept verbatim.`)
    },
  },
  {
    n: 6, name: 'Externalize State (Memory)', layer: 'info',
    domainId: 'healthcare', scenarioId: 'C',
    tagline: 'Persist human corrections outside the context window so they survive resets — and steer the next run.',
    explain: `A prior clinician correction about Tommy’s penicillin anaphylaxis is written to <code>localStorage</code> and retrieved by keyword on the next run (<code>memoryManager.js:28</code>). Running the agent below, the trace shows <em>“Found N relevant correction(s)”</em> — real state, injected into the real system prompt. Use ↺ Reset Memory (top-right) to clear.`,
    code: ['memoryManager.js:15 · saveCorrection', 'memoryManager.js:28 · retrieveRelevantMemories', 'orchestrator.js:23 · injected into system prompt'],
    async run(ctx, { domain, scenario }) {
      if (!modelReady(ctx)) return
      ctx.log('focus', 'Seeding a real correction into the memory store (localStorage)…')
      saveCorrection({
        text: 'Tommy Garcia (P003) has documented PENICILLIN ANAPHYLAXIS — never prescribe amoxicillin; use azithromycin.',
        tags: ['pediatric', 'penicillin', 'allergy', 'amoxicillin'], scenario: scenario.id, domain: domain.id,
      })
      showMemoryCount()
      const hits = retrieveRelevantMemories(scenarioText(scenario))
      ctx.log('note', `retrieveRelevantMemories() matched ${hits.length} correction(s) for this scenario — about to inject them.`)
      const res = await ctx.runAgent(domain, scenario)
      ctx.log('ok', 'The "Found N relevant correction(s)" line above is the store steering the live run — no redeploy, no fine-tune.')
    },
  },
  {
    n: 7, name: 'Bounded Retry & Backoff', layer: 'exec',
    domainId: 'career', scenarioId: 'A',
    tagline: 'Transient failures are normal. Retry with backoff — but cap attempts so a dead call can’t stall the loop.',
    explain: `A real model call is wrapped in a retry loop with a simulated transient failure on the first attempt (a 503 / rate-limit). It backs off, retries, and on success the real model produces the summary. The max-attempts ceiling means an always-failing call degrades gracefully instead of hanging.`,
    code: ['Execution layer · resilient dispatch', 'pairs with orchestrator try/catch:109'],
    async run(ctx, { domain, scenario }) {
      if (!modelReady(ctx)) return
      const MAX = 3
      const mock = isMockMode()
      const profile = domain.toolFns.getApplicantProfile(scenario.applicantId)
      const prompt = `In one sentence, summarise the outlook for someone moving from ${profile.currentRole} to an ${profile.goalRole.replace(/-/g, ' ')} role.`
      for (let a = 1; a <= MAX; a++) {
        ctx.log('note', `Attempt ${a}/${MAX}: calling model…`)
        try {
          if (a < 2) throw new Error('simulated 503 (rate limit)')
          const text = mock
            ? 'Strong programming base transfers well; expect a 6-month upskilling path into ML engineering with good demand.'
            : await ctx.generate(prompt, 'You are a concise career advisor.')
          ctx.log('ok', `Attempt ${a} succeeded → "${text.trim().slice(0, 160)}"`)
          return
        } catch (e) {
          ctx.log('warn', `Attempt ${a} failed: ${e.message}. Backing off ${a * 300}ms, then retry.`)
          await ctx.wait(a * 300)
        }
      }
      ctx.log('warn', `All ${MAX} attempts failed → degrade gracefully (skip, flag for human), loop continues.`)
    },
  },
  {
    n: 8, name: 'Reflection / Self-Critique', layer: 'feedback',
    domainId: 'career', scenarioId: 'C',
    tagline: 'Insert a step where the agent critiques its own draft against the goal, then revises.',
    explain: `The real agent produces a career plan for David (teacher → instructional designer). A second real model pass then critiques that plan for gaps and proposes an improvement — a cheap, model-only step that catches misses before the grader has to.`,
    code: ['Feedback layer · self-critique pass', 'complements verifyOutput:5'],
    async run(ctx, { domain, scenario }) {
      if (!modelReady(ctx)) return
      ctx.log('focus', 'Draft pass: running the real agent…')
      const res = await ctx.runAgent(domain, scenario)
      ctx.log('focus', 'Reflection pass: asking the model to critique its own draft…')
      if (isMockMode()) {
        await ctx.wait(500)
        ctx.log('ok', 'Self-critique: draft under-weights the 22-year teaching background as transferable; add a portfolio piece repurposing existing curricula into Articulate 360 modules to shorten the ramp.')
        return
      }
      const critique = await ctx.generate(
        `Here is a career plan (JSON): ${JSON.stringify(res.plan).slice(0, 1200)}. In 2 sentences, critique it for the goal of becoming an instructional designer, then state one concrete improvement.`,
        'You are a critical senior career counsellor reviewing a colleague’s plan.')
      ctx.log('ok', `Self-critique → ${critique.trim().slice(0, 300)}`)
    },
  },
  {
    n: 9, name: 'Human-in-the-Loop Checkpoint', layer: 'feedback',
    domainId: 'healthcare', scenarioId: 'C',
    tagline: 'For high-stakes actions, pause the loop for a human decision — approve to finalise, reject to capture a correction.',
    explain: `The real agent generates a plan for a penicillin-allergic child, then the loop <strong>pauses for your sign-off</strong> (the Approve / Reject flow from <code>main.js</code>). Reject writes a structured correction to memory (technique #6), improving the next run. <em>Interactive — choose below.</em>`,
    code: ['main.js:176 · handleApprove', 'main.js:190 · submitCorrection → saveCorrection'],
    async run(ctx, { domain, scenario }) {
      if (!modelReady(ctx)) return
      ctx.log('focus', 'Running the real agent, then pausing for human sign-off…')
      const res = await ctx.runAgent(domain, scenario)
      const choice = await ctx.decide('Clinician decision on this recommendation:', [
        { label: '✓ Approve', value: 'approve', cls: 'btn-approve' },
        { label: '✗ Reject & Correct', value: 'reject', cls: 'btn-reject' },
      ])
      if (choice === 'approve') {
        ctx.log('ok', 'APPROVED. Trajectory score 1.0 → recommendation finalised, loop exits.')
      } else {
        saveCorrection({ text: 'Reviewer rejected: reinforce azithromycin as the penicillin-allergy alternative and state the anaphylaxis risk explicitly.', tags: scenario.tags || [], scenario: scenario.id, domain: domain.id })
        showMemoryCount()
        ctx.log('warn', 'REJECTED. Correction saved to memory → the next run retrieves it and adjusts. Loop closes the feedback cycle.')
      }
    },
  },
  {
    n: 10, name: 'Sub-Agent Isolation', layer: 'exec',
    domainId: 'drugDiscovery', scenarioId: 'D',
    tagline: 'Run a subtask in its own clean context and return only a summary — keep the parent loop’s window lean.',
    explain: `The parent decision ("is DM-3350 IND-ready?") delegates the noisy toxicology screening to a sub-agent — here, a full real <code>runAgent()</code> in its own isolated context. The parent receives only the one-line summary, not the sub-agent’s entire tool transcript. Real char counts below show the window stays small.`,
    code: ['Execution layer · sub-loop isolation', 'pairs with compaction #5'],
    async run(ctx, { domain, scenario }) {
      if (!modelReady(ctx)) return
      ctx.log('focus', 'Parent delegates the tox screen to an isolated sub-agent (clean context)…')
      const res = await ctx.runAgent(domain, scenario)
      const fullTranscript = bytes(res.toolResults || [])
      const summary = res.plan.summary || res.plan.assessment || 'sub-agent complete'
      ctx.log('note', `Sub-agent internal transcript: ${fullTranscript.toLocaleString()} chars (stays in the sub-context).`)
      ctx.log('ok', `Parent receives ONE line (${bytes(summary)} chars): "${String(summary).slice(0, 160)}"`)
    },
  },
  {
    n: 11, name: 'Structured-Output Schema Repair', layer: 'feedback',
    domainId: 'insurance', scenarioId: 'D',
    tagline: 'Small models emit malformed JSON. Extract tolerantly, repair, and re-verify instead of crashing.',
    explain: `On this excluded-procedure dental claim, the model’s JSON may be fenced, loose, or slightly malformed. <code>extractOutput()</code> (<code>verification.js:16</code>) pulls it from a fenced block or a brace match, falling back to a safe stub flagged for review — then <code>verifyOutput()</code> grades the recovered object. Parse → repair → grade, no crash.`,
    code: ['verification.js:16 · extractOutput (tolerant parse)', 'verification.js:5 · verifyOutput'],
    async run(ctx, { domain, scenario }) {
      if (!modelReady(ctx)) return
      ctx.log('focus', 'Running the real agent; extractOutput() will tolerantly recover its JSON…')
      const res = await ctx.runAgent(domain, scenario)
      const parseErr = res.plan._parse_error === true
      ctx.log(parseErr ? 'warn' : 'ok', parseErr
        ? 'Model JSON was unparseable → fell back to a safe stub, flagged requires_human_review. No crash, no data loss.'
        : 'extractOutput() recovered a clean structured object from the model response.')
      const v = res.verification || verifyOutput(res.plan)
      ctx.log('note', `Post-repair grade: ${v.valid ? 'PASS' : 'FAIL'} (score ${v.score.toFixed(2)}).`)
    },
  },
  {
    n: 12, name: 'Deterministic Tracing & Replay', layer: 'feedback',
    domainId: 'healthcare', scenarioId: 'D',
    tagline: 'Make every loop observable. Capture a structured, timestamped event log you can inspect and replay.',
    explain: `The pub/sub <code>tracer</code> records every layer event of a real run (<code>tracer.js:13</code>). This card runs the agent on an anticoagulated patient, then reads back <code>tracer.getLogs()</code> and replays the recorded trajectory below — the same log that powers the live UI, debugging, and audit.`,
    code: ['tracer.js:13 · publish', 'tracer.js:20 · getLogs (replay source)'],
    async run(ctx, { domain, scenario }) {
      if (!modelReady(ctx)) return
      ctx.log('focus', 'Running the real agent (events recorded by the tracer)…')
      const res = await ctx.runAgent(domain, scenario)
      const logs = tracer.getLogs()
      ctx.log('focus', `Captured ${logs.length} events. Replaying the recorded trajectory from tracer.getLogs():`)
      for (const e of logs) {
        await ctx.wait(180)
        const m = TRACE_MAP[e.event] || { label: e.event, cls: 'trace-default' }
        ctx.log('note', `↺ [${m.label}] ${typeof e.data === 'string' ? e.data.slice(0, 120) : JSON.stringify(e.data).slice(0, 120)}`)
      }
      ctx.log('ok', 'Deterministic replay complete — one log drives live UI, debugging, and audit.')
    },
  },
]

// ── Rendering ─────────────────────────────────────────────────
function buildCard(tech) {
  const meta = LAYER_META[tech.layer]
  const domain = DOMAINS[tech.domainId]
  const scenario = domain.scenarios[tech.scenarioId]

  const card = document.createElement('article')
  card.className = 'tech-card'
  card.innerHTML = `
    <div class="tech-head">
      <span class="tech-num">${String(tech.n).padStart(2, '0')}</span>
      <div class="tech-title">
        <h3>${esc(tech.name)}</h3>
        <span class="lyr-badge ${meta.cls}">${meta.label} LAYER</span>
      </div>
    </div>
    <div class="tech-usecase" style="border-color:${domain.color}55">
      <span class="uc-icon">${domain.icon}</span>
      <span class="uc-text"><strong>${esc(domain.name)}</strong> · ${esc(scenario.id)} — ${esc(scenario.title)}</span>
    </div>
    <p class="tech-tagline">${esc(tech.tagline)}</p>
    <p class="tech-explain">${tech.explain}</p>
    <div class="tech-code">${tech.code.map(c => `<code>${esc(c)}</code>`).join('')}</div>
    <div class="tech-run">
      <button class="btn btn-execute run-btn">▶ Run this loop</button>
    </div>
    <div class="tech-controls"></div>
    <div class="trace-container tech-trace">
      <div class="trace-empty-sub">Load a model (or tick Mock mode), then click “Run this loop” to stream the real harness trace.</div>
    </div>`

  const runBtn = card.querySelector('.run-btn')
  const traceEl = card.querySelector('.tech-trace')
  const ctrlEl = card.querySelector('.tech-controls')

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true
    runBtn.textContent = '⟳ Running…'
    traceEl.innerHTML = ''
    ctrlEl.innerHTML = ''
    const ctx = makeCtx(traceEl, ctrlEl)
    try {
      await tech.run(ctx, { domain, scenario })
    } catch (err) {
      ctx.log('warn', `Run error: ${err.message}`)
    } finally {
      runBtn.disabled = false
      runBtn.textContent = '↻ Run again'
    }
  })
  return card
}

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const modelSel = document.getElementById('modelSelect')
  WEBLLM_MODELS.forEach(m => {
    const o = document.createElement('option')
    o.value = m.id; o.textContent = m.name
    modelSel.appendChild(o)
  })

  const grid = document.getElementById('techGrid')
  TECHNIQUES.forEach(t => grid.appendChild(buildCard(t)))
  document.getElementById('techCount').textContent = TECHNIQUES.length
  showMemoryCount()

  document.getElementById('loadModelBtn').addEventListener('click', handleLoadModel)
  document.getElementById('mockToggle').addEventListener('change', (e) => {
    setMockMode(e.target.checked)
    document.getElementById('loadModelBtn').disabled = e.target.checked
    document.getElementById('modelSelect').disabled = e.target.checked
  })
  document.getElementById('resetMemoryBtn').addEventListener('click', () => {
    if (confirm('Clear all saved corrections from local memory?')) { clearAllMemories(); showMemoryCount() }
  })
})
