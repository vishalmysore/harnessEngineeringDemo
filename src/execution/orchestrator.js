import {
  TOOL_SCHEMAS_OPENAI, TOOL_SCHEMAS_ANTHROPIC, TOOL_FNS,
  checkDrugInteraction, fetchPatientVitals, calculateDosage,
} from '../information/tools.js'
import { retrieveRelevantMemories } from '../information/memoryManager.js'
import { validateToolCall, validateToolOutput, validateFinalPlan } from './guardrails.js'
import { verifyCarePlan, extractCarePlan } from '../feedback/verification.js'
import tracer from '../feedback/tracer.js'
import {
  callLLMWithTools, extractToolCalls, extractText, getRawMessage,
  formatToolResult, appendToolResults, appendCorrectionMessage, isMockMode,
} from '../utils/llm.js'

const MAX_ITERATIONS = 10

function buildSystemPrompt(memories) {
  const memorySection = memories.length > 0
    ? memories.map(m => `• [${m.tags.join('/')}] ${m.text}`).join('\n')
    : 'No relevant past corrections found.'

  return `You are a Clinical Decision Support AI Assistant operating within a Healthcare Agent Harness (Etna Labs Framework). Your role is to analyze patient cases and generate safe, evidence-based care plans.

CORE PROTOCOL:
1. ALWAYS call fetchPatientVitals first to retrieve current medications, allergies, and vitals.
2. Call checkDrugInteraction for EACH combination of current medications + requested medications.
3. Call calculateDosage for any weight-based medication before recommending it.
4. If a GUARDRAIL WARNING appears in a tool result, you MUST revise your recommendation to exclude the flagged medication and suggest a safe alternative.
5. NEVER prescribe a medication a patient is allergic to.

RETRIEVED MEMORY FROM PAST CLINICIAN CORRECTIONS:
${memorySection}

FINAL OUTPUT FORMAT:
After all tool calls are complete, output a JSON care plan wrapped in \`\`\`json ... \`\`\` with this exact structure:
{
  "patient_summary": "Brief demographic and condition overview",
  "primary_complaint": "What the patient reported",
  "diagnosis_hypothesis": "Most likely clinical diagnosis",
  "medications": [
    { "name": "Drug name", "dose": "Amount and unit", "frequency": "Dosing schedule", "duration": "Treatment length", "contraindications_checked": true }
  ],
  "warnings": ["Any safety concerns, interactions, or precautions"],
  "non_pharmacological": ["Non-drug recommendations"],
  "reason": "Clinical reasoning summary",
  "duration": "Overall treatment duration",
  "doctor_review": true,
  "follow_up": "When to return or seek emergency care"
}

CRITICAL: doctor_review must ALWAYS be true.`
}

function executeTool(name, args) {
  const fn = TOOL_FNS[name]
  if (!fn) throw new Error(`Unknown tool: ${name}`)
  return fn(...Object.values(args))
}

// ── Mock simulation (no real LLM needed) ──────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function getMockAlternative(contraindicated, vitals) {
  if (contraindicated === 'aspirin' && vitals.currentMedications?.some(m => m.toLowerCase().includes('warfarin'))) {
    return [{ name: 'Acetaminophen (Tylenol)', dose: '500mg', frequency: 'every 6 hours as needed', duration: '3–5 days', contraindications_checked: true }]
  }
  if (['ibuprofen', 'pseudoephedrine'].includes(contraindicated) && vitals.conditions?.includes('Hypertension')) {
    const subs = {
      ibuprofen:      [{ name: 'Acetaminophen (Tylenol)', dose: '500mg', frequency: 'every 6 hours', duration: '5 days', contraindications_checked: true }],
      pseudoephedrine:[{ name: 'Saline nasal spray', dose: 'As directed', frequency: '3–4 times daily', duration: '7 days', contraindications_checked: true }],
    }
    return subs[contraindicated] || []
  }
  if (contraindicated === 'amoxicillin' && vitals.allergies?.map(a => a.toLowerCase()).includes('penicillin')) {
    return [{ name: 'Azithromycin (Z-Pack)', dose: '500mg day 1, then 250mg', frequency: 'once daily', duration: '5 days', contraindications_checked: true }]
  }
  return []
}

async function runMockAgent(scenario) {
  const toolResults = []
  const guardrailWarnings = []

  await sleep(300)
  tracer.publish('layer:info', 'Mock mode: Fetching patient vitals from mock database...')
  await sleep(400)
  const vitals = fetchPatientVitals(scenario.patientId)
  const vitalsGuard = validateToolOutput('fetchPatientVitals', vitals)
  if (vitalsGuard.warning) guardrailWarnings.push(vitalsGuard.warning)
  toolResults.push({ name: 'fetchPatientVitals', args: { patientId: scenario.patientId }, result: vitals })
  tracer.publish('layer:execution', `Patient: ${vitals.name}, ${vitals.age}yo. Current meds: ${(vitals.currentMedications || []).join(', ') || 'none'}.`)

  await sleep(300)
  tracer.publish('layer:execution', 'Mock mode: Checking all drug interaction pairs...')
  const currentMedNames = (vitals.currentMedications || []).map(m => m.split(' ')[0].toLowerCase())
  const allergyLow = (vitals.allergies || []).map(a => a.toLowerCase())

  for (const reqMed of scenario.requestedMeds) {
    const reqLow = reqMed.toLowerCase()

    for (const curMed of currentMedNames) {
      await sleep(250)
      tracer.publish('layer:execution', `Invoking checkDrugInteraction("${curMed}", "${reqLow}")...`)
      const result = checkDrugInteraction(curMed, reqLow)
      const guard = validateToolOutput('checkDrugInteraction', result)
      if (guard.warning) guardrailWarnings.push(guard.warning)
      toolResults.push({ name: 'checkDrugInteraction', args: { med1: curMed, med2: reqLow }, result })
    }

    if (allergyLow.includes('penicillin') && reqLow === 'amoxicillin') {
      await sleep(250)
      tracer.publish('layer:execution', 'Checking cross-allergy: penicillin + amoxicillin...')
      const result = checkDrugInteraction('penicillin', 'amoxicillin')
      const guard = validateToolOutput('checkDrugInteraction', result)
      if (guard.warning) guardrailWarnings.push(guard.warning)
      toolResults.push({ name: 'checkDrugInteraction', args: { med1: 'penicillin', med2: 'amoxicillin' }, result })
    }
  }

  const blockedMeds = new Set(
    toolResults
      .filter(r => r.name === 'checkDrugInteraction' && ['HIGH', 'CRITICAL'].includes(r.result.severity))
      .map(r => r.result.med2.toLowerCase())
  )

  await sleep(200)
  tracer.publish('layer:execution', 'Mock mode: Calculating dosages for safe medications...')
  for (const reqMed of scenario.requestedMeds) {
    const reqLow = reqMed.toLowerCase()
    const isAllergy = allergyLow.includes(reqLow) || (allergyLow.includes('penicillin') && reqLow === 'amoxicillin')
    if (!blockedMeds.has(reqLow) && !isAllergy) {
      await sleep(200)
      tracer.publish('layer:execution', `Invoking calculateDosage("${reqLow}", ${vitals.weightKg})...`)
      const result = calculateDosage(reqLow, vitals.weightKg)
      const guard = validateToolOutput('calculateDosage', result)
      if (guard.warning) guardrailWarnings.push(guard.warning)
      toolResults.push({ name: 'calculateDosage', args: { medication: reqLow, weightKg: vitals.weightKg }, result })
    }
  }

  await sleep(400)
  tracer.publish('layer:execution', 'Mock mode: Synthesising care plan from tool results...')

  const warnings = []
  const medications = []

  for (const ir of toolResults.filter(r => r.name === 'checkDrugInteraction')) {
    if (ir.result.severity !== 'NONE') {
      warnings.push(`${ir.result.severity} interaction: ${ir.result.med1} + ${ir.result.med2} — ${ir.result.recommendation}`)
    }
  }
  for (const allergy of vitals.allergies || []) {
    for (const med of scenario.requestedMeds) {
      if (med.toLowerCase().includes(allergy.toLowerCase()) ||
          (allergy.toLowerCase() === 'penicillin' && med.toLowerCase() === 'amoxicillin')) {
        warnings.push(`ALLERGY: Patient is allergic to ${allergy}. ${med} is absolutely contraindicated.`)
      }
    }
  }

  for (const reqMed of scenario.requestedMeds) {
    const reqLow = reqMed.toLowerCase()
    const isAllergy = allergyLow.includes(reqLow) || (allergyLow.includes('penicillin') && reqLow === 'amoxicillin')
    const isBlocked = blockedMeds.has(reqLow)

    if (isAllergy || isBlocked) {
      medications.push(...getMockAlternative(reqLow, vitals))
    } else {
      const dosageResult = toolResults.find(r => r.name === 'calculateDosage' && r.args.medication === reqLow)
      if (dosageResult?.result?.recommendedDose) {
        medications.push({
          name: reqMed,
          dose: `${dosageResult.result.recommendedDose}${dosageResult.result.unit}`,
          frequency: dosageResult.result.frequency,
          duration: '5–7 days as needed',
          contraindications_checked: true,
        })
      }
    }
  }

  const nonPharm = ['Stay hydrated and rest adequately', 'Monitor symptoms and return if not improved in 48–72 hours']
  if ((vitals.age || 0) > 65) nonPharm.push('Fall precautions — monitor for dizziness or balance changes')
  if ((vitals.conditions || []).includes('Hypertension')) nonPharm.push('Maintain low-sodium diet; avoid OTC decongestants')
  if ((vitals.conditions || []).some(c => c.toLowerCase().includes('diabetes'))) nonPharm.push('Monitor blood glucose closely during illness')

  const carePlan = {
    patient_summary: `${vitals.name}, ${vitals.age}yo. Conditions: ${(vitals.conditions || []).join(', ') || 'None'}. Current meds: ${(vitals.currentMedications || []).join(', ') || 'None'}. Allergies: ${(vitals.allergies || []).join(', ') || 'NKDA'}.`,
    primary_complaint: scenario.complaint,
    diagnosis_hypothesis: 'Clinical assessment based on presenting complaint and patient history',
    medications,
    warnings,
    non_pharmacological: nonPharm,
    reason: `[MOCK MODE] Care plan generated from real tool outputs (no LLM required). ${warnings.length} safety concern(s) detected and addressed by guardrails. ${blockedMeds.size + (allergyLow.length > 0 ? 1 : 0)} contraindicated medication(s) replaced with safe alternatives.`,
    duration: '5–7 days or as clinically appropriate',
    doctor_review: true,
    follow_up: 'Return within 7 days or immediately if symptoms worsen, fever exceeds 39°C, or new symptoms develop.',
  }

  return {
    carePlan,
    toolResults,
    guardrailWarnings,
    verification: verifyCarePlan(carePlan),
  }
}

// ── Main agent loop ────────────────────────────────────────────

export async function runAgent(scenario, onStep = () => {}) {
  tracer.clearLogs()

  tracer.publish('agent:start', { scenario: scenario.title })
  tracer.publish('layer:info', `Initializing Information Layer for: ${scenario.title}`)

  const queryText = `${scenario.description} ${scenario.complaint} ${scenario.requestedMeds.join(' ')}`
  const memories = retrieveRelevantMemories(queryText)
  tracer.publish('layer:info',
    memories.length > 0
      ? `Searching past feedback logs... Found ${memories.length} relevant clinician correction(s).`
      : 'Searching past feedback logs... No prior corrections found for this case type.'
  )
  tracer.publish('layer:info', 'System prompt assembled with memory context and output constraints.')

  // ── Mock mode bypass ───────────────────────────────────────
  if (isMockMode()) {
    tracer.publish('layer:execution', '[MOCK MODE] Simulating full agentic loop with real tools — no LLM required.')
    const result = await runMockAgent(scenario)
    tracer.publish('layer:feedback', 'Running schema verification...')
    tracer.publish(result.verification.valid ? 'layer:feedback' : 'agent:error',
      result.verification.valid
        ? 'Schema verification PASSED. Clinical audit complete.'
        : `Schema issues: ${result.verification.errors.join('; ')}`
    )
    tracer.publish('agent:complete', result.carePlan)
    return result
  }

  // ── Real LLM agentic loop ──────────────────────────────────
  const systemPrompt = buildSystemPrompt(memories)

  const messages = [{
    role: 'user',
    content: `Patient Scenario: ${scenario.description}\n\nChief Complaint: ${scenario.complaint}\nPatient ID: ${scenario.patientId}\nRequested Medications: ${scenario.requestedMeds.join(', ')}\n\nAnalyze thoroughly using available tools, then generate a care plan.`,
  }]

  const toolResults = []
  const guardrailWarnings = []
  let iteration = 0

  tracer.publish('layer:execution', 'Starting agentic loop (Plan → Tool Call → Parse → Retry/Complete)...')

  while (iteration < MAX_ITERATIONS) {
    iteration++
    tracer.publish('layer:execution', `Iteration ${iteration}: Querying model...`)

    let response
    try {
      response = await callLLMWithTools(messages, systemPrompt, TOOL_SCHEMAS_OPENAI, TOOL_SCHEMAS_ANTHROPIC)
    } catch (err) {
      tracer.publish('agent:error', `LLM call failed: ${err.message}`)
      throw err
    }

    const toolCalls = extractToolCalls(response)

    if (!toolCalls || toolCalls.length === 0) {
      const rawText = extractText(response)
      tracer.publish('layer:execution', 'Agent completed reasoning. No further tool calls requested.')
      tracer.publish('layer:feedback', 'Running output verification and schema validation...')

      const carePlan = extractCarePlan(rawText)

      const finalGuardrail = validateFinalPlan(carePlan, toolResults)
      if (!finalGuardrail.valid) {
        tracer.publish('layer:feedback', `GUARDRAIL FINAL CHECK FAILED: ${finalGuardrail.errors.join(' | ')}`)
        const correctionMsg = `GUARDRAIL SYSTEM OVERRIDE (Iteration ${iteration}): Your care plan contains violations:\n${finalGuardrail.errors.map(e => `- ${e}`).join('\n')}\n\nRevise and output corrected JSON.`
        appendCorrectionMessage(messages, getRawMessage(response), correctionMsg)
        continue
      }

      const verification = verifyCarePlan(carePlan)
      tracer.publish('layer:feedback',
        verification.valid
          ? 'Schema verification PASSED. Clinical audit complete.'
          : `Schema issues: ${verification.errors.join('; ')}`
      )

      tracer.publish('agent:complete', carePlan)
      return { carePlan, toolResults, guardrailWarnings, verification, rawText }
    }

    const processedToolResults = []

    for (const tc of toolCalls) {
      const { id, name, args } = tc
      tracer.publish('layer:execution', `Invoking ${name}(${JSON.stringify(args)})...`)

      const guardCall = validateToolCall(name, args)
      if (!guardCall.safe) {
        tracer.publish('layer:feedback', `GUARDRAIL BLOCKED tool call: ${guardCall.reason}`)
        const blockedResult = { error: `Guardrail blocked: ${guardCall.reason}` }
        toolResults.push({ name, args, result: blockedResult, blocked: true })
        processedToolResults.push({ id, name, result: blockedResult, formatted: formatToolResult(id, name, blockedResult) })
        continue
      }

      let result
      try {
        result = executeTool(name, args)
      } catch (err) {
        result = { error: err.message }
      }

      const outputCheck = validateToolOutput(name, result)
      if (outputCheck.warning) {
        guardrailWarnings.push(outputCheck.warning)
        result._guardrail = { severity: outputCheck.severity, warning: outputCheck.warning }
        if (outputCheck.forceRevision) {
          result._guardrail.instruction = 'You MUST NOT prescribe this combination. Suggest a safe alternative.'
        }
      } else {
        tracer.publish('layer:execution', `Tool result: ${name} OK`)
      }

      toolResults.push({ name, args, result })
      processedToolResults.push({ id, name, result, formatted: formatToolResult(id, name, result) })
    }

    appendToolResults(messages, getRawMessage(response), processedToolResults)
  }

  throw new Error(`Agent did not complete after ${MAX_ITERATIONS} iterations.`)
}
