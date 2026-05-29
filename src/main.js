import { runAgent } from './execution/orchestrator.js'
import { saveCorrection, clearAllMemories, getAllMemories } from './information/memoryManager.js'
import tracer from './feedback/tracer.js'
import { WEBLLM_MODELS, loadModel, getModelStatus, setMockMode, isMockMode } from './utils/llm.js'
import DOMAINS from './domains/index.js'

let currentPlan     = null
let currentScenario = null
let currentDomain   = null
let agentRunning    = false
let traceUnsub      = null

// ── Model loading ─────────────────────────────────────────────

function setModelStatus(type, msg) {
  const el = document.getElementById('modelStatus')
  el.textContent = msg
  el.className   = `test-result test-result-${type}`
}

async function handleLoadModel() {
  const modelId = document.getElementById('modelSelect').value
  const btn     = document.getElementById('loadModelBtn')
  const prog    = document.getElementById('modelProgress')
  const fill    = document.getElementById('modelProgressFill')
  const label   = document.getElementById('modelProgressLabel')

  btn.disabled    = true
  btn.textContent = '⟳ Loading…'
  prog.classList.remove('hidden')
  fill.style.width = '0%'
  label.textContent = 'Initialising…'
  document.getElementById('modelStatus').className = 'test-result hidden'

  try {
    await loadModel(modelId, (ev) => {
      if (ev.type === 'device') {
        label.textContent = 'WebGPU detected — starting download…'
      } else if (ev.type === 'downloading') {
        fill.style.width  = `${ev.progress}%`
        label.textContent = `Downloading… ${ev.progress}%`
      } else if (ev.type === 'phase' && ev.phase === 'compile') {
        label.textContent = 'Compiling WebGPU shaders… (1–5 min on first load, cached after)'
        fill.style.width  = '95%'
      } else if (ev.type === 'ready') {
        fill.style.width  = '100%'
        label.textContent = 'Ready'
      }
    })
    setModelStatus('ok', `✅ Model ready: ${modelId}`)
  } catch (err) {
    setModelStatus('fail', `❌ ${err.message}`)
  } finally {
    btn.disabled    = false
    btn.textContent = '⬇ Load Model'
    setTimeout(() => prog.classList.add('hidden'), 1500)
  }
}

// ── Domain management ─────────────────────────────────────────

function getActiveDomain() {
  return DOMAINS[document.getElementById('domainSelect').value] || DOMAINS.healthcare
}

function updateDomainUI() {
  const domain = getActiveDomain()
  currentDomain = domain

  document.documentElement.style.setProperty('--domain-color', domain.color)
  document.getElementById('domainDesc').textContent     = domain.description
  document.getElementById('reviewerLabel').textContent  = domain.reviewerLabel

  const sel = document.getElementById('scenarioSelect')
  sel.innerHTML = ''
  Object.values(domain.scenarios).forEach(s => {
    const o = document.createElement('option')
    o.value       = s.id
    o.textContent = `${s.id} — ${s.title}`
    sel.appendChild(o)
  })

  updateScenarioInfo()
  clearTrace()
  document.getElementById('clinicianPanel').innerHTML = waitingMsg()
}

function updateScenarioInfo() {
  const domain   = getActiveDomain()
  const id       = document.getElementById('scenarioSelect').value
  const scenario = domain.scenarios[id]
  if (!scenario) return
  document.getElementById('scenarioDesc').textContent = scenario.description
  document.getElementById('scenarioTags').textContent = `Tags: ${(scenario.tags || []).join(' · ')}`
}

// ── Trace panel ───────────────────────────────────────────────

function clearTrace() { document.getElementById('traceContainer').innerHTML = '' }

const LAYER_MAP = {
  'layer:info':        { label:'INFO LAYER',        cls:'trace-info' },
  'layer:execution':   { label:'EXECUTION LAYER',   cls:'trace-exec' },
  'layer:feedback':    { label:'FEEDBACK LAYER',    cls:'trace-feedback' },
  'guardrail:critical':{ label:'GUARDRAIL ⛔',      cls:'trace-critical' },
  'guardrail:high':    { label:'GUARDRAIL 🔴',      cls:'trace-high' },
  'guardrail:moderate':{ label:'GUARDRAIL 🟡',      cls:'trace-moderate' },
  'guardrail:dosage':  { label:'GUARDRAIL 💊',      cls:'trace-dosage' },
  'guardrail:allergy': { label:'ALLERGY ALERT 🚨',  cls:'trace-allergy' },
  'agent:start':       { label:'AGENT START',       cls:'trace-start' },
  'agent:error':       { label:'AGENT ERROR',       cls:'trace-error' },
  'agent:complete':    { label:'AGENT COMPLETE ✓',  cls:'trace-complete' },
}

function appendTrace(event, data) {
  const container = document.getElementById('traceContainer')
  container.querySelector('.trace-empty')?.remove()
  const meta = LAYER_MAP[event] || { label: event.toUpperCase(), cls:'trace-default' }
  const text = typeof data === 'string' ? data : JSON.stringify(data).substring(0, 140) + '...'
  const time = new Date().toLocaleTimeString('en-US', { hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' })
  const el   = document.createElement('div')
  el.className = `trace-entry ${meta.cls}`
  el.innerHTML = `<span class="trace-time">${time}</span><span class="trace-label">[${meta.label}]</span><span class="trace-msg">${esc(text)}</span>`
  container.appendChild(el)
  container.scrollTop = container.scrollHeight
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }

// ── Output render ─────────────────────────────────────────────

function waitingMsg() {
  return `<div class="waiting-msg"><div class="waiting-icon">⚕</div><p>Output will appear here after agent analysis completes.</p><p class="waiting-sub">Human-in-the-loop review before any recommendation is finalised.</p></div>`
}

function renderPlan(plan, domain) {
  const panel = document.getElementById('clinicianPanel')

  const recsHtml = (plan.recommendations || []).map(r => {
    const pCls = r.priority === 'high' ? 'rec-high' : r.priority === 'low' ? 'rec-low' : 'rec-medium'
    return `<div class="rec-card ${pCls}">
      <strong>${esc(r.item || r.name || 'Recommendation')}</strong>
      <span class="rec-detail">${esc(r.detail || r.dose || '')}</span>
    </div>`
  }).join('')

  const warnHtml = (plan.warnings || []).map(w => `<div class="warning-item">⚠ ${esc(w)}</div>`).join('')
  const nonHtml  = (plan.non_action_items || plan.non_pharmacological || []).map(r => `<li>${esc(r)}</li>`).join('')

  panel.innerHTML = `
    <div class="care-plan-header">
      <h3>${esc(domain.reviewerLabel)} — Pending Review</h3>
      <div class="review-badge" style="border-color:var(--domain-color);color:var(--domain-color)">⚑ Sign-Off Required</div>
    </div>
    <div class="plan-section"><label>Summary</label><p>${esc(plan.summary || plan.patient_summary || '')}</p></div>
    <div class="plan-section"><label>Assessment</label><p>${esc(plan.assessment || plan.diagnosis_hypothesis || '')}</p></div>
    <div class="plan-section"><label>Recommendations</label>${recsHtml || '<p class="empty">No recommendations generated.</p>'}</div>
    ${warnHtml ? `<div class="plan-section warnings-section"><label>Warnings &amp; Risks</label>${warnHtml}</div>` : ''}
    ${nonHtml  ? `<div class="plan-section"><label>Supporting Actions</label><ul class="non-pharm">${nonHtml}</ul></div>` : ''}
    <div class="plan-section"><label>Reasoning</label><p>${esc(plan.reasoning || plan.reason || '')}</p></div>
    <div class="plan-section"><label>Follow-Up</label><p>${esc(plan.follow_up || 'Reassess as needed.')}</p></div>
    <div class="hitl-actions">
      <button id="approveBtn" class="btn btn-approve">✓ Approve</button>
      <button id="rejectBtn"  class="btn btn-reject">✗ Reject &amp; Correct</button>
    </div>
    <div id="correctionBox" class="correction-box hidden">
      <label>What did the agent miss or get wrong?</label>
      <textarea id="correctionText" rows="3" placeholder="Describe the issue — this will be saved to memory to improve future runs…"></textarea>
      <button id="submitCorrection" class="btn btn-submit">Submit Correction to Memory</button>
    </div>
  `
  document.getElementById('approveBtn').addEventListener('click', handleApprove)
  document.getElementById('rejectBtn').addEventListener('click', handleReject)
}

function handleApprove() {
  appendTrace('layer:feedback', 'Reviewer APPROVED recommendation. Trajectory score: 1.0.')
  document.getElementById('approveBtn').disabled = true
  document.getElementById('rejectBtn').disabled  = true
  document.getElementById('approveBtn').textContent = '✓ Approved'
  document.getElementById('approveBtn').classList.add('approved')
  showMemoryCount()
}

function handleReject() {
  document.getElementById('correctionBox').classList.remove('hidden')
  document.getElementById('submitCorrection').addEventListener('click', submitCorrection, { once: true })
}

function submitCorrection() {
  const text = document.getElementById('correctionText').value.trim()
  if (!text) return
  saveCorrection({ text, tags: currentScenario?.tags || [], scenario: currentScenario?.id, domain: currentDomain?.id })
  appendTrace('layer:feedback', `Correction saved to memory. Tags: [${(currentScenario?.tags||[]).join(', ')}]. Improves future iterations.`)
  document.getElementById('correctionBox').classList.add('hidden')
  document.getElementById('rejectBtn').disabled = true
  document.getElementById('rejectBtn').textContent = '✗ Correction Saved'
  showMemoryCount()
}

function showMemoryCount() {
  const n = getAllMemories().length
  document.getElementById('memoryBadge').textContent = `${n} correction${n !== 1 ? 's' : ''} in memory`
}

// ── Execute ────────────────────────────────────────────────────

async function executeAgent() {
  if (agentRunning) return

  if (!isMockMode() && getModelStatus() !== 'ready') {
    alert('Please load a local model first (or enable Mock mode to test without a GPU).')
    return
  }

  const domain   = getActiveDomain()
  const scenario = domain.scenarios[document.getElementById('scenarioSelect').value]
  currentDomain   = domain
  currentScenario = scenario
  agentRunning    = true
  currentPlan     = null

  document.getElementById('executeBtn').disabled    = true
  document.getElementById('executeBtn').textContent = '⟳ Running…'
  clearTrace()
  document.getElementById('clinicianPanel').innerHTML = `<div class="waiting-msg"><div class="waiting-icon">⟳</div><p>Agent analysing — events streaming in real time…</p></div>`

  if (traceUnsub) traceUnsub()
  traceUnsub = tracer.subscribe('*', (event, data) => appendTrace(event, data))

  try {
    const result  = await runAgent(scenario, domain)
    currentPlan   = result.plan
    renderPlan(currentPlan, domain)
  } catch (err) {
    appendTrace('agent:error', err.message)
    document.getElementById('clinicianPanel').innerHTML = `<div class="error-msg">⛔ ${esc(err.message)}</div>`
  } finally {
    agentRunning = false
    document.getElementById('executeBtn').disabled    = false
    document.getElementById('executeBtn').textContent = '▶ Execute Agent'
  }
}

// ── Init ──────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Populate model selector
  const modelSel = document.getElementById('modelSelect')
  WEBLLM_MODELS.forEach(m => {
    const o = document.createElement('option')
    o.value       = m.id
    o.textContent = m.name
    modelSel.appendChild(o)
  })

  // Domain dropdown
  const domSel = document.getElementById('domainSelect')
  Object.values(DOMAINS).forEach(d => {
    const o = document.createElement('option')
    o.value       = d.id
    o.textContent = `${d.icon} ${d.name}`
    domSel.appendChild(o)
  })

  updateDomainUI()
  showMemoryCount()

  document.getElementById('loadModelBtn').addEventListener('click', handleLoadModel)

  document.getElementById('mockToggle').addEventListener('change', (e) => {
    setMockMode(e.target.checked)
    document.getElementById('loadModelBtn').disabled    = e.target.checked
    document.getElementById('modelSelect').disabled     = e.target.checked
  })

  domSel.addEventListener('change', updateDomainUI)
  document.getElementById('scenarioSelect').addEventListener('change', updateScenarioInfo)
  document.getElementById('executeBtn').addEventListener('click', executeAgent)
  document.getElementById('resetMemoryBtn').addEventListener('click', () => {
    if (confirm('Clear all saved corrections from local memory?')) {
      clearAllMemories()
      showMemoryCount()
      appendTrace('layer:info', 'Local memory reset.')
    }
  })
})
