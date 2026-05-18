import {
  checkDrugInteraction, fetchPatientVitals, calculateDosage,
  TOOL_SCHEMAS_OPENAI, TOOL_SCHEMAS_ANTHROPIC, TOOL_FNS,
} from '../information/tools.js'
import { validateToolCall, validateToolOutput, validateFinalPlan } from '../execution/guardrails.js'
import { verifyOutput } from '../feedback/verification.js'
import tracer from '../feedback/tracer.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

function getMockAlternative(contraindicated, vitals) {
  if (contraindicated === 'aspirin' && vitals.currentMedications?.some(m => m.toLowerCase().includes('warfarin')))
    return [{ item: 'Acetaminophen (Tylenol) 500mg', detail: 'every 6 hours as needed — safe alternative for anticoagulated patients', priority: 'high' }]
  if (contraindicated === 'ibuprofen' && vitals.conditions?.includes('Hypertension'))
    return [{ item: 'Acetaminophen (Tylenol) 500mg', detail: 'every 6 hours — NSAIDs contraindicated with Lisinopril and CKD', priority: 'high' }]
  if (contraindicated === 'pseudoephedrine' && vitals.conditions?.includes('Hypertension'))
    return [{ item: 'Saline nasal spray', detail: '2 sprays per nostril 3–4× daily — decongestants raise BP', priority: 'medium' }]
  if (contraindicated === 'amoxicillin' && vitals.allergies?.map(a => a.toLowerCase()).includes('penicillin'))
    return [{ item: 'Azithromycin (Z-Pack) 500mg day 1 then 250mg', detail: 'once daily × 5 days — macrolide alternative for penicillin allergy', priority: 'high' }]
  return []
}

async function mockSimulate(scenario) {
  const toolResults = []
  const guardrailWarnings = []

  await sleep(300)
  tracer.publish('layer:info', 'Mock mode: Fetching patient vitals...')
  await sleep(400)
  const vitals = fetchPatientVitals(scenario.patientId)
  const vitalsGuard = validateToolOutput('fetchPatientVitals', vitals)
  if (vitalsGuard.warning) guardrailWarnings.push(vitalsGuard.warning)
  toolResults.push({ name: 'fetchPatientVitals', args: { patientId: scenario.patientId }, result: vitals })
  tracer.publish('layer:execution', `Patient: ${vitals.name}, ${vitals.age}yo. Meds: ${(vitals.currentMedications || []).join(', ') || 'none'}.`)

  const curMedNames = (vitals.currentMedications || []).map(m => m.split(' ')[0].toLowerCase())
  const allergyLow  = (vitals.allergies || []).map(a => a.toLowerCase())

  for (const reqMed of scenario.requestedMeds) {
    const reqLow = reqMed.toLowerCase()
    for (const cur of curMedNames) {
      await sleep(250)
      tracer.publish('layer:execution', `Invoking checkDrugInteraction("${cur}", "${reqLow}")...`)
      const result = checkDrugInteraction(cur, reqLow)
      const guard  = validateToolOutput('checkDrugInteraction', result)
      if (guard.warning) guardrailWarnings.push(guard.warning)
      toolResults.push({ name: 'checkDrugInteraction', args: { med1: cur, med2: reqLow }, result })
    }
    if (allergyLow.includes('penicillin') && reqLow === 'amoxicillin') {
      await sleep(200)
      tracer.publish('layer:execution', 'Checking cross-allergy: penicillin + amoxicillin...')
      const result = checkDrugInteraction('penicillin', 'amoxicillin')
      const guard  = validateToolOutput('checkDrugInteraction', result)
      if (guard.warning) guardrailWarnings.push(guard.warning)
      toolResults.push({ name: 'checkDrugInteraction', args: { med1: 'penicillin', med2: 'amoxicillin' }, result })
    }
  }

  const blockedMeds = new Set(
    toolResults.filter(r => r.name === 'checkDrugInteraction' && ['HIGH','CRITICAL'].includes(r.result.severity))
               .map(r => r.result.med2.toLowerCase())
  )

  for (const reqMed of scenario.requestedMeds) {
    const reqLow = reqMed.toLowerCase()
    const isAllergy = allergyLow.includes(reqLow) || (allergyLow.includes('penicillin') && reqLow === 'amoxicillin')
    if (!blockedMeds.has(reqLow) && !isAllergy) {
      await sleep(200)
      tracer.publish('layer:execution', `Invoking calculateDosage("${reqLow}", ${vitals.weightKg})...`)
      const result = calculateDosage(reqLow, vitals.weightKg)
      const guard  = validateToolOutput('calculateDosage', result)
      if (guard.warning) guardrailWarnings.push(guard.warning)
      toolResults.push({ name: 'calculateDosage', args: { medication: reqLow, weightKg: vitals.weightKg }, result })
    }
  }

  await sleep(400)
  tracer.publish('layer:execution', 'Synthesising care plan from tool results...')

  const warnings = []
  const recommendations = []

  for (const ir of toolResults.filter(r => r.name === 'checkDrugInteraction')) {
    if (ir.result.severity !== 'NONE')
      warnings.push(`${ir.result.severity} interaction: ${ir.result.med1} + ${ir.result.med2} — ${ir.result.recommendation}`)
  }
  for (const allergy of vitals.allergies || []) {
    for (const med of scenario.requestedMeds) {
      if (med.toLowerCase().includes(allergy.toLowerCase()) ||
          (allergy.toLowerCase() === 'penicillin' && med.toLowerCase() === 'amoxicillin'))
        warnings.push(`ALLERGY: Patient is allergic to ${allergy}. ${med} is absolutely contraindicated.`)
    }
  }

  for (const reqMed of scenario.requestedMeds) {
    const reqLow = reqMed.toLowerCase()
    const isAllergy = allergyLow.includes(reqLow) || (allergyLow.includes('penicillin') && reqLow === 'amoxicillin')
    const isBlocked = blockedMeds.has(reqLow)
    if (isAllergy || isBlocked) {
      recommendations.push(...getMockAlternative(reqLow, vitals))
    } else {
      const dr = toolResults.find(r => r.name === 'calculateDosage' && r.args.medication === reqLow)
      if (dr?.result?.recommendedDose)
        recommendations.push({ item: `${reqMed} ${dr.result.recommendedDose}${dr.result.unit}`, detail: `${dr.result.frequency} for 5–7 days`, priority: 'high' })
    }
  }

  const nonActionItems = ['Stay well hydrated and rest', 'Return if symptoms worsen or fever exceeds 39°C']
  if ((vitals.age || 0) > 65) nonActionItems.push('Fall precautions — monitor for dizziness')
  if ((vitals.conditions || []).includes('Hypertension')) nonActionItems.push('Avoid all OTC decongestants and NSAIDs')

  const plan = {
    summary: `${vitals.name}, ${vitals.age}yo. Conditions: ${(vitals.conditions||[]).join(', ')||'None'}. Current meds: ${(vitals.currentMedications||[]).join(', ')||'None'}. Allergies: ${(vitals.allergies||[]).join(', ')||'NKDA'}.`,
    assessment: `Presenting with: ${scenario.complaint}. ${warnings.length} safety concern(s) identified via drug interaction and allergy screening.`,
    recommendations,
    warnings,
    non_action_items: nonActionItems,
    reasoning: `[MOCK] Tool-driven analysis: ${blockedMeds.size} contraindicated med(s) replaced with safe alternatives. All interactions and allergies cross-checked.`,
    requires_human_review: true,
    follow_up: 'Return within 7 days or immediately if symptoms worsen.',
  }

  return { plan, toolResults, guardrailWarnings, verification: verifyOutput(plan) }
}

export default {
  id: 'healthcare',
  name: 'Healthcare',
  icon: '⚕',
  color: '#58a6ff',
  reviewerLabel: 'Clinician Review',
  description: 'Clinical decision support with drug interaction checking, dosage calculation, and patient safety guardrails.',
  scenarios: {
    A: { id:'A', title:'Elderly Patient — Hypertension + Cold Meds', patientId:'P001', description:'Mrs. Martha Johnson, 75yo with hypertension and mild CKD (eGFR 58), on Lisinopril. Requesting decongestant (pseudoephedrine) and ibuprofen for body aches.', complaint:'nasal congestion, body aches, mild fever — requesting cold meds and pain relief', requestedMeds:['Pseudoephedrine','Ibuprofen'], tags:['elderly','hypertension','lisinopril','nsaid'] },
    B: { id:'B', title:'Diabetic Patient — Post-Dental Pain', patientId:'P002', description:'Mr. Raj Patel, 55yo, Type 2 Diabetes on Metformin. Post-extraction dental pain. History of heavy alcohol use.', complaint:'moderate post-extraction pain — requesting analgesic', requestedMeds:['Ibuprofen','Acetaminophen'], tags:['diabetes','metformin','alcohol','pain'] },
    C: { id:'C', title:'Child — Strep Throat + Penicillin Allergy', patientId:'P003', description:'Tommy Garcia, 8yo, 25kg. Strep confirmed by rapid test. Parent requesting amoxicillin. CRITICAL: documented penicillin anaphylaxis.', complaint:'strep throat, fever 38.5°C — parent requesting amoxicillin', requestedMeds:['Amoxicillin'], tags:['pediatric','strep','penicillin','allergy'] },
    D: { id:'D', title:'Anticoagulated Patient — Aspirin Request', patientId:'P004', description:'Mr. Wei Chen, 62yo, atrial fibrillation on Warfarin (INR 2.4). Requesting aspirin for tension headache.', complaint:'tension headache — requesting aspirin', requestedMeds:['Aspirin'], tags:['warfarin','aspirin','bleeding','afib'] },
  },
  toolSchemas: { openai: TOOL_SCHEMAS_OPENAI, anthropic: TOOL_SCHEMAS_ANTHROPIC },
  toolFns: TOOL_FNS,
  buildSystemPrompt: (memories) => {
    const mem = memories.length > 0 ? memories.map(m => `• [${m.tags.join('/')}] ${m.text}`).join('\n') : 'No past corrections.'
    return `You are a Clinical Decision Support AI. ALWAYS call fetchPatientVitals first, then checkDrugInteraction for every current + requested medication pair, then calculateDosage for weight-based meds. Guardrail warnings in tool results mean you MUST suggest a safe alternative.\n\nPAST CLINICIAN CORRECTIONS:\n${mem}\n\nOutput JSON in \`\`\`json blocks:\n{"summary":"...","assessment":"...","recommendations":[{"item":"...","detail":"...","priority":"high|medium|low"}],"warnings":[],"non_action_items":[],"reasoning":"...","requires_human_review":true,"follow_up":"..."}`
  },
  validateToolCall,
  validateToolOutput,
  validateFinalPlan,
  mockSimulate,
}
