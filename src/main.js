import { runAgent } from './execution/orchestrator.js'
import { saveCorrection, clearAllMemories, getAllMemories } from './information/memoryManager.js'
import tracer from './feedback/tracer.js'
import { PROVIDERS, setLLMConfig, getLLMConfig, getDefaultProxy, testConnection } from './utils/llm.js'

const SCENARIOS = {
  A: {
    id: 'A',
    title: 'Elderly Patient — Hypertension + Cold Meds',
    patientId: 'P001',
    description: 'Mrs. Martha Johnson, 75-year-old female with hypertension and mild CKD (eGFR 58), currently on Lisinopril. Presents requesting over-the-counter cold medication containing a decongestant (pseudoephedrine) and ibuprofen for body aches.',
    complaint: 'nasal congestion, body aches, mild fever — requesting cold medication and pain relief',
    requestedMeds: ['Pseudoephedrine', 'Ibuprofen'],
    tags: ['elderly', 'hypertension', 'lisinopril', 'cold', 'nsaid'],
  },
  B: {
    id: 'B',
    title: 'Diabetic Patient — Post-Dental Pain',
    patientId: 'P002',
    description: 'Mr. Raj Patel, 55-year-old male with Type 2 Diabetes on Metformin. Requesting pain relief following a dental extraction. History of heavy alcohol consumption.',
    complaint: 'moderate post-extraction dental pain — requesting ibuprofen or stronger analgesic',
    requestedMeds: ['Ibuprofen', 'Acetaminophen'],
    tags: ['diabetes', 'metformin', 'alcohol', 'pain', 'dental'],
  },
  C: {
    id: 'C',
    title: 'Child Patient — Strep Throat + Penicillin Allergy',
    patientId: 'P003',
    description: 'Tommy Garcia, 8-year-old male, 25kg. Rapid antigen test confirmed strep throat. Parent requesting antibiotics. CRITICAL: documented anaphylaxis to Penicillin.',
    complaint: 'strep throat confirmed, fever 38.5°C, sore throat — parent requesting amoxicillin',
    requestedMeds: ['Amoxicillin'],
    tags: ['pediatric', 'child', 'strep', 'antibiotic', 'penicillin', 'allergy'],
  },
  D: {
    id: 'D',
    title: 'Anticoagulated Patient — Aspirin Request',
    patientId: 'P004',
    description: 'Mr. Wei Chen, 62-year-old male with atrial fibrillation on Warfarin (INR 2.4, therapeutic). Also on Metoprolol. Requesting aspirin for tension headache.',
    complaint: 'tension headache — requesting aspirin for pain relief',
    requestedMeds: ['Aspirin'],
    tags: ['warfarin', 'anticoagulant', 'aspirin', 'headache', 'bleeding', 'afib'],
  },
}

let currentCarePlan = null
let currentScenario = null
let agentRunning = false
let traceUnsubscribe = null

// ── LLM Config helpers ─────────────────────────────────────────

function syncConfigFromUI() {
  const providerId = document.getElementById('provider').value
  const apiKey     = document.getElementById('apiKey').value.trim()
  const model      = document.getElementById('modelName').value.trim()
  const proxyUrl   = document.getElementById('proxyUrl').value.trim() || getDefaultProxy()
  setLLMConfig({ provider: providerId, apiKey, model, proxyUrl })
}

function populateProviderModels(providerId) {
  const providerDef = PROVIDERS.find(p => p.id === providerId)
  const modelSelect = document.getElementById('modelName')
  modelSelect.innerHTML = ''
  if (providerDef) {
    providerDef.models.forEach(m => {
      const opt = document.createElement('option')
      opt.value = m.id
      opt.textContent = m.name
      modelSelect.appendChild(opt)
    })
    document.getElementById('apiKey').placeholder = providerDef.keyPlaceholder
    const noKey = providerId === 'mock'
    document.getElementById('apiKey').disabled = noKey
    document.getElementById('apiKey').style.opacity = noKey ? '0.4' : '1'
  }
}

function syncConfigToUI() {
  const cfg = getLLMConfig()
  document.getElementById('provider').value = cfg.provider
  populateProviderModels(cfg.provider)
  if (cfg.model) document.getElementById('modelName').value = cfg.model
  document.getElementById('apiKey').value = cfg.apiKey || ''
  document.getElementById('proxyUrl').value = cfg.proxyUrl || getDefaultProxy()
}

// ── Trace panel ────────────────────────────────────────────────

function clearTrace() {
  const container = document.getElementById('traceContainer')
  container.innerHTML = ''
}

function appendTrace(event, data) {
  const container = document.getElementById('traceContainer')

  // Remove empty state on first entry
  const empty = container.querySelector('.trace-empty')
  if (empty) empty.remove()

  const layerMap = {
    'layer:info':        { label: 'INFO LAYER',       cls: 'trace-info' },
    'layer:execution':   { label: 'EXECUTION LAYER',  cls: 'trace-exec' },
    'layer:feedback':    { label: 'FEEDBACK LAYER',   cls: 'trace-feedback' },
    'guardrail:critical':{ label: 'GUARDRAIL ⛔',     cls: 'trace-critical' },
    'guardrail:high':    { label: 'GUARDRAIL 🔴',     cls: 'trace-high' },
    'guardrail:moderate':{ label: 'GUARDRAIL 🟡',     cls: 'trace-moderate' },
    'guardrail:dosage':  { label: 'GUARDRAIL 💊',     cls: 'trace-dosage' },
    'guardrail:allergy': { label: 'ALLERGY ALERT 🚨', cls: 'trace-allergy' },
    'agent:start':       { label: 'AGENT START',      cls: 'trace-start' },
    'agent:error':       { label: 'AGENT ERROR',      cls: 'trace-error' },
    'agent:complete':    { label: 'AGENT COMPLETE ✓', cls: 'trace-complete' },
  }

  const meta = layerMap[event] || { label: event.toUpperCase(), cls: 'trace-default' }
  const text = typeof data === 'string' ? data : JSON.stringify(data).substring(0, 140) + '...'
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })

  const entry = document.createElement('div')
  entry.className = `trace-entry ${meta.cls}`
  entry.innerHTML = `<span class="trace-time">${time}</span><span class="trace-label">[${meta.label}]</span><span class="trace-msg">${escapeHtml(text)}</span>`
  container.appendChild(entry)
  container.scrollTop = container.scrollHeight
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ── Clinician desk ─────────────────────────────────────────────

function renderCarePlan(plan) {
  const panel = document.getElementById('clinicianPanel')

  const medsHtml = (plan.medications || []).map(m =>
    `<div class="med-card">
      <strong>${escapeHtml(m.name)}</strong>
      <span class="med-dose">${escapeHtml(m.dose || '')} — ${escapeHtml(m.frequency || '')}</span>
      <span class="med-dur">Duration: ${escapeHtml(m.duration || 'As directed')}</span>
    </div>`
  ).join('')

  const warningsHtml = (plan.warnings || []).map(w =>
    `<div class="warning-item">⚠ ${escapeHtml(w)}</div>`
  ).join('')

  const nonPharmHtml = (plan.non_pharmacological || []).map(r =>
    `<li>${escapeHtml(r)}</li>`
  ).join('')

  panel.innerHTML = `
    <div class="care-plan-header">
      <h3>Care Plan — Pending Clinician Review</h3>
      <div class="review-badge">⚕ Physician Sign-Off Required</div>
    </div>
    <div class="plan-section">
      <label>Patient Summary</label>
      <p>${escapeHtml(plan.patient_summary || '')}</p>
    </div>
    <div class="plan-section">
      <label>Diagnosis</label>
      <p>${escapeHtml(plan.diagnosis_hypothesis || '')}</p>
    </div>
    <div class="plan-section">
      <label>Medications</label>
      ${medsHtml || '<p class="empty">No medications prescribed.</p>'}
    </div>
    ${warningsHtml ? `<div class="plan-section warnings-section"><label>Warnings &amp; Interactions</label>${warningsHtml}</div>` : ''}
    ${nonPharmHtml ? `<div class="plan-section"><label>Non-Pharmacological</label><ul class="non-pharm">${nonPharmHtml}</ul></div>` : ''}
    <div class="plan-section">
      <label>Clinical Reasoning</label>
      <p>${escapeHtml(plan.reason || '')}</p>
    </div>
    <div class="plan-section">
      <label>Follow-Up</label>
      <p>${escapeHtml(plan.follow_up || 'Return if symptoms worsen or do not improve.')}</p>
    </div>
    <div class="hitl-actions">
      <button id="approveBtn" class="btn btn-approve">✓ Approve Plan</button>
      <button id="rejectBtn" class="btn btn-reject">✗ Reject &amp; Correct</button>
    </div>
    <div id="correctionBox" class="correction-box hidden">
      <label>What did the agent miss or get wrong?</label>
      <textarea id="correctionText" rows="3" placeholder="e.g. Should have recommended azithromycin 250mg for penicillin-allergic patients…"></textarea>
      <button id="submitCorrection" class="btn btn-submit">Submit Correction to Memory</button>
    </div>
  `

  document.getElementById('approveBtn').addEventListener('click', handleApprove)
  document.getElementById('rejectBtn').addEventListener('click', handleReject)
}

function handleApprove() {
  appendTrace('layer:feedback', 'Clinician APPROVED care plan. Trajectory score: 1.0. No corrections needed.')
  document.getElementById('approveBtn').disabled = true
  document.getElementById('rejectBtn').disabled = true
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
  const tags = currentScenario?.tags || []
  saveCorrection({ text, tags, scenario: currentScenario?.id })
  appendTrace('layer:feedback', `Clinician correction saved to memory. Tags: [${tags.join(', ')}]. This will improve future iterations.`)
  document.getElementById('correctionBox').classList.add('hidden')
  document.getElementById('rejectBtn').disabled = true
  document.getElementById('rejectBtn').textContent = '✗ Correction Saved'
  showMemoryCount()
}

function showMemoryCount() {
  const count = getAllMemories().length
  document.getElementById('memoryBadge').textContent = `${count} correction${count !== 1 ? 's' : ''} in memory`
}

// ── Scenario info ──────────────────────────────────────────────

function updateScenarioInfo() {
  const id = document.getElementById('scenarioSelect').value
  const scenario = SCENARIOS[id]
  document.getElementById('scenarioDesc').textContent = scenario.description
  document.getElementById('scenarioTags').textContent = `Tags: ${scenario.tags.join(' · ')}`
}

// ── Test Connection ────────────────────────────────────────────

async function handleTestConnection() {
  syncConfigFromUI()
  const cfg = getLLMConfig()
  const resultEl = document.getElementById('testResult')
  const testBtn  = document.getElementById('testBtn')

  if (cfg.provider !== 'mock' && !cfg.apiKey) {
    showTestResult('fail', '❌ Enter an API key first.')
    return
  }

  testBtn.disabled = true
  testBtn.textContent = '⟳ Testing…'
  resultEl.className = 'test-result hidden'

  try {
    const { text, latencyMs } = await testConnection()
    showTestResult('ok', `✅ Connected! Response: "${text.slice(0, 40)}" (${latencyMs}ms)`)
  } catch (err) {
    showTestResult('fail', `❌ ${err.message}`)
  } finally {
    testBtn.disabled = false
    testBtn.textContent = '🧪 Test'
  }
}

function showTestResult(status, message) {
  const el = document.getElementById('testResult')
  el.textContent = message
  el.className = `test-result test-result-${status}`
}

// ── Execute ────────────────────────────────────────────────────

async function executeAgent() {
  if (agentRunning) return
  syncConfigFromUI()
  const cfg = getLLMConfig()

  if (cfg.provider !== 'mock' && !cfg.apiKey) {
    alert('Please enter your API key above, or switch to Mock AI to test without a key.')
    return
  }

  const scenarioId = document.getElementById('scenarioSelect').value
  currentScenario = SCENARIOS[scenarioId]
  agentRunning = true
  currentCarePlan = null

  document.getElementById('executeBtn').disabled = true
  document.getElementById('executeBtn').textContent = '⟳ Running…'
  clearTrace()
  document.getElementById('clinicianPanel').innerHTML = `<div class="waiting-msg"><div class="waiting-icon">⟳</div><p>Waiting for agent to complete analysis…</p><p class="waiting-sub">Events stream in real time — color-coded by harness layer.</p></div>`

  // Subscribe to all tracer events
  if (traceUnsubscribe) traceUnsubscribe()
  traceUnsubscribe = tracer.subscribe('*', (event, data) => appendTrace(event, data))

  try {
    const result = await runAgent(currentScenario)
    currentCarePlan = result.carePlan
    renderCarePlan(currentCarePlan)
  } catch (err) {
    appendTrace('agent:error', err.message)
    document.getElementById('clinicianPanel').innerHTML = `<div class="error-msg">⛔ Agent error: ${escapeHtml(err.message)}</div>`
  } finally {
    agentRunning = false
    document.getElementById('executeBtn').disabled = false
    document.getElementById('executeBtn').textContent = '▶ Execute Agent'
  }
}

// ── Init ───────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Populate provider options
  const providerSelect = document.getElementById('provider')
  PROVIDERS.forEach(p => {
    const opt = document.createElement('option')
    opt.value = p.id
    opt.textContent = `${p.icon} ${p.name}`
    providerSelect.appendChild(opt)
  })

  // Load persisted config
  syncConfigToUI()
  updateScenarioInfo()
  showMemoryCount()

  providerSelect.addEventListener('change', () => {
    populateProviderModels(providerSelect.value)
    syncConfigFromUI()
  })

  document.getElementById('apiKey').addEventListener('input', syncConfigFromUI)
  document.getElementById('modelName').addEventListener('change', syncConfigFromUI)
  document.getElementById('proxyUrl').addEventListener('input', syncConfigFromUI)

  document.getElementById('scenarioSelect').addEventListener('change', updateScenarioInfo)
  document.getElementById('executeBtn').addEventListener('click', executeAgent)

  document.getElementById('testBtn').addEventListener('click', handleTestConnection)

  document.getElementById('resetMemoryBtn').addEventListener('click', () => {
    if (confirm('Clear all saved clinician corrections from local memory?')) {
      clearAllMemories()
      showMemoryCount()
      appendTrace('layer:info', 'Local memory reset. All clinician corrections cleared.')
    }
  })

  document.getElementById('resetProxyBtn').addEventListener('click', () => {
    document.getElementById('proxyUrl').value = getDefaultProxy()
    syncConfigFromUI()
  })
})
