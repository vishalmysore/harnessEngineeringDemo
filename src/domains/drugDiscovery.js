import { verifyOutput } from '../feedback/verification.js'
import tracer from '../feedback/tracer.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Mock data ──────────────────────────────────────────────────

const COMPOUNDS = {
  COMP001: { id:'COMP001', name:'NX-7741', class:'Selective Kinase Inhibitor', targetProtein:'EGFR/HER2', indication:'Non-small cell lung cancer (NSCLC)', mw:456.7, stage:'Preclinical', inVitroIC50:'12 nM', selectivity:'High (>200× over off-targets)', solubility:'Moderate (42 µg/mL in PBS)' },
  COMP002: { id:'COMP002', name:'RB-2240', class:'Beta-Lactam Antibiotic (Novel)', targetProtein:'PBP2a (MRSA)', indication:'Methicillin-resistant Staphylococcus aureus', mw:389.4, stage:'Late Preclinical', inVitroMIC:'0.25 µg/mL vs MRSA', selectivity:'Narrow spectrum (Gram-positive)', solubility:'High (>500 µg/mL)' },
  COMP003: { id:'COMP003', name:'QT-9901', class:'PARP Inhibitor', targetProtein:'PARP1/2', indication:'BRCA-mutated ovarian cancer', mw:512.6, stage:'Preclinical', inVitroIC50:'8 nM', selectivity:'Moderate (some PARP3 activity)', solubility:'Low (8 µg/mL) — formulation challenge' },
  COMP004: { id:'COMP004', name:'DM-3350', class:'CNS Penetrant mGluR5 NAM', targetProtein:'mGluR5', indication:"Fragile X syndrome / Alzheimer's disease", mw:334.2, stage:'Lead Optimisation', inVitroIC50:'45 nM', selectivity:'High (>1000× vs mGluR1)', solubility:'High (>1000 µg/mL)' },
}

const TOXICOLOGY = {
  COMP001: { ld50:'920 mg/kg (oral rat)', hepatotoxicityScore:0.21, amesTest:'Negative', hERG_IC50:'>40 µM (safe)', reproTox:'Not assessed', genotoxicity:'Negative (MN assay)', maxToleratedDose:'500 mg/kg (14-day rat study)' },
  COMP002: { ld50:'1200 mg/kg (oral rat)', hepatotoxicityScore:0.09, amesTest:'Negative', hERG_IC50:'>50 µM (safe)', reproTox:'No signal (EFD study)',   genotoxicity:'Negative (MN + CA assay)', maxToleratedDose:'1000 mg/kg (14-day rat study)' },
  COMP003: { ld50:'280 mg/kg (oral rat)', hepatotoxicityScore:0.78, amesTest:'Negative', hERG_IC50:'6.2 µM (CONCERN)', reproTox:'Embryotoxic (EFD)',      genotoxicity:'Negative', maxToleratedDose:'80 mg/kg (MTD reached — liver enzyme elevation)' },
  COMP004: { ld50:'750 mg/kg (oral rat)', hepatotoxicityScore:0.33, amesTest:'Negative', hERG_IC50:'18 µM (borderline)', reproTox:'Not assessed',          genotoxicity:'Negative', maxToleratedDose:'400 mg/kg (14-day rat study)' },
}

const REGULATORY = {
  NSCLC:           { pathway:'505(b)(1) NDA', orphanStatus:false, precedent:'Erlotinib, Osimertinib approved as 1st-line', clinicalTimeline:'IND→Phase 1: 12 months after toxicology package complete', keyRequirements:['GLP tox (rat+dog)','ADMET','CMC dossier'] },
  MRSA:            { pathway:'505(b)(1) NDA + QIDP designation', orphanStatus:false, precedent:'Ceftaroline, Dalbavancin approved', clinicalTimeline:'IND→Phase 1: 10 months (QIDP fast-track eligible)', keyRequirements:['GLP tox','Microbiological profile','Resistance study'] },
  'Ovarian Cancer':{ pathway:'505(b)(1) NDA', orphanStatus:true, precedent:'Olaparib, Niraparib approved', clinicalTimeline:'IND filing delayed — additional tox studies required first', keyRequirements:['Resolve hepatotoxicity signal','Cardiac safety (hERG remediation)','Reproductive tox'] },
  "Fragile X":     { pathway:'505(b)(2) NDA', orphanStatus:true, precedent:'No approved mGluR5 NAM — first-in-class opportunity', clinicalTimeline:'IND→Phase 1: 14 months (CNS studies required)', keyRequirements:['BBB penetration confirmation','CNS safety pharmacology','Cardiac monitoring (hERG borderline)'] },
}

// ── Tool functions ──────────────────────────────────────────────

export function getCompoundProfile(compoundId) {
  const c = COMPOUNDS[compoundId]
  if (!c) return { error: `Compound ${compoundId} not found.` }
  return { ...c }
}

export function assessToxicologyProfile(compoundId) {
  const t = TOXICOLOGY[compoundId]
  if (!t) return { error: `No toxicology data for ${compoundId}.` }
  return { compoundId, ...t }
}

export function checkRegulatoryPathway(indication) {
  const r = REGULATORY[indication]
  if (!r) return { error: `No regulatory data for indication: ${indication}`, availableIndications: Object.keys(REGULATORY) }
  return { indication, ...r }
}

// ── Guardrails ─────────────────────────────────────────────────

function validateToolOutput(name, result) {
  if (name === 'assessToxicologyProfile') {
    if (result.hepatotoxicityScore >= 0.7) {
      const msg = `HEPATOTOXICITY FLAG: Score ${result.hepatotoxicityScore} exceeds 0.7 threshold — significant liver toxicity signal. IND filing BLOCKED until resolved. Structural modification required.`
      tracer.publish('guardrail:critical', msg)
      return { safe: false, severity:'CRITICAL', warning: msg, forceRevision: true }
    }
    if (result.hepatotoxicityScore >= 0.5) {
      const msg = `HEPATOTOXICITY WARNING: Score ${result.hepatotoxicityScore} — elevated liver signal. Additional mechanistic studies required before IND.`
      tracer.publish('guardrail:high', msg)
      return { safe: false, severity:'HIGH', warning: msg, forceRevision: true }
    }
    if (result.amesTest === 'Positive') {
      const msg = `MUTAGENICITY FLAG: Positive Ames test — compound is mutagenic. IND filing BLOCKED. Structural redesign required to eliminate mutagenic moiety.`
      tracer.publish('guardrail:critical', msg)
      return { safe: false, severity:'CRITICAL', warning: msg, forceRevision: true }
    }
    const hERGVal = parseFloat(result.hERG_IC50)
    if (!isNaN(hERGVal) && hERGVal < 10) {
      const msg = `hERG CARDIAC SAFETY FLAG: IC50 ${result.hERG_IC50} — below 10 µM threshold. QT prolongation risk. Cardiac safety studies required.`
      tracer.publish('guardrail:high', msg)
      return { safe: false, severity:'HIGH', warning: msg, forceRevision: true }
    }
    if (!isNaN(hERGVal) && hERGVal < 30) {
      const msg = `hERG BORDERLINE: IC50 ${result.hERG_IC50} — between 10–30 µM. Cardiac monitoring recommended in Phase 1.`
      tracer.publish('guardrail:moderate', msg)
      return { safe: true, severity:'MODERATE', warning: msg, forceRevision: false }
    }
    if (result.reproTox && result.reproTox !== 'Not assessed' && result.reproTox !== 'No signal (EFD study)') {
      const msg = `REPRODUCTIVE TOXICITY SIGNAL: ${result.reproTox} — additional studies and label warning required.`
      tracer.publish('guardrail:high', msg)
      return { safe: false, severity:'HIGH', warning: msg, forceRevision: true }
    }
  }
  return { safe: true }
}

function validateFinalPlan(plan, toolResults) {
  const errors = []
  const tox = toolResults.find(r => r.name === 'assessToxicologyProfile')
  if (tox?.result?.hepatotoxicityScore >= 0.7) {
    const blockedInRecs = (plan.recommendations || []).some(r => r.item?.toLowerCase().includes('ind') || r.item?.toLowerCase().includes('phase 1'))
    if (blockedInRecs) errors.push('IND filing cannot be recommended when hepatotoxicity score ≥ 0.7 — structural modification must come first')
  }
  return { valid: errors.length === 0, errors }
}

// ── Mock simulation ─────────────────────────────────────────────

async function mockSimulate(scenario) {
  const toolResults = []
  const guardrailWarnings = []

  await sleep(300)
  tracer.publish('layer:info', `Mock mode: Retrieving compound profile for ${scenario.compoundId}...`)
  await sleep(400)
  const compound = getCompoundProfile(scenario.compoundId)
  toolResults.push({ name:'getCompoundProfile', args:{ compoundId:scenario.compoundId }, result:compound })
  tracer.publish('layer:execution', `Compound: ${compound.name} (${compound.class}) — Target: ${compound.targetProtein} — Indication: ${compound.indication}`)

  await sleep(350)
  tracer.publish('layer:execution', `Running toxicology assessment for ${compound.name}...`)
  await sleep(500)
  const tox = assessToxicologyProfile(scenario.compoundId)
  const toxGuard = validateToolOutput('assessToxicologyProfile', tox)
  if (toxGuard.warning) guardrailWarnings.push(toxGuard.warning)
  toolResults.push({ name:'assessToxicologyProfile', args:{ compoundId:scenario.compoundId }, result:tox })

  await sleep(300)
  tracer.publish('layer:execution', `Checking regulatory pathway for "${compound.indication}"...`)
  await sleep(400)
  const reg = checkRegulatoryPathway(compound.indication)
  toolResults.push({ name:'checkRegulatoryPathway', args:{ indication:compound.indication }, result:reg })

  await sleep(400)
  tracer.publish('layer:execution', 'Synthesising drug development recommendation...')

  const warnings = [...guardrailWarnings]
  const recommendations = []
  const isCriticallyBlocked = tox.hepatotoxicityScore >= 0.7 || tox.amesTest === 'Positive'
  const hERGVal = parseFloat(tox.hERG_IC50)
  const hERGConcern = !isNaN(hERGVal) && hERGVal < 10
  const hERGBorderline = !isNaN(hERGVal) && hERGVal >= 10 && hERGVal < 30
  const isBlocked = isCriticallyBlocked || hERGConcern || (tox.reproTox && !['Not assessed','No signal (EFD study)'].includes(tox.reproTox))

  if (isCriticallyBlocked) {
    if (tox.hepatotoxicityScore >= 0.7) {
      recommendations.push({ item:'Halt advancement — resolve hepatotoxicity signal', detail:`Score ${tox.hepatotoxicityScore} exceeds 0.7 threshold. Conduct mechanistic hepatotoxicity studies (DILI panel). Pursue structural modifications to reduce metabolic activation.`, priority:'high' })
      recommendations.push({ item:'SAR campaign to eliminate hepatotoxic moiety', detail:'Engage medicinal chemistry for analogue synthesis targeting reduced CYP3A4 metabolic activation', priority:'high' })
    }
    if (tox.amesTest === 'Positive') {
      recommendations.push({ item:'Halt advancement — mutagenicity positive', detail:'Structural redesign required. Identify and remove mutagenic functional group (e.g. nitro aromatic, Michael acceptor)', priority:'high' })
    }
  } else {
    if (!isBlocked) {
      recommendations.push({ item:`Proceed to IND-enabling studies`, detail:`Toxicology profile acceptable. Initiate GLP 28-day rat + dog studies. ${reg.keyRequirements?.join(', ')}`, priority:'high' })
      recommendations.push({ item:`Estimated IND filing timeline: ${reg.clinicalTimeline}`, detail:`Regulatory pathway: ${reg.pathway}. ${reg.orphanStatus ? 'ORPHAN DRUG designation eligible — apply immediately for fast-track.' : ''}`, priority:'high' })
    }
    if (hERGBorderline) {
      recommendations.push({ item:'Add cardiac monitoring to Phase 1 protocol', detail:`hERG IC50 ${tox.hERG_IC50} — borderline. Thorough QT study recommended before Phase 2 dose escalation.`, priority:'medium' })
    }
    if (tox.reproTox === 'Not assessed') {
      recommendations.push({ item:'Complete reproductive toxicology assessment', detail:'EFD study in rat required before IND if indication affects reproductive-age patients', priority:'medium' })
    }
    if (compound.solubility && compound.solubility.includes('Low')) {
      recommendations.push({ item:'Address formulation challenge', detail:`Low solubility (${compound.solubility}) — explore salt forms, nanoparticle formulation, or co-solvents for clinical dosing`, priority:'medium' })
    }
  }

  if (reg.precedent) recommendations.push({ item:'Benchmark against approved competitors', detail:reg.precedent, priority:'low' })

  const plan = {
    summary: `${compound.name} (${compound.class}) — ${compound.indication} — Stage: ${compound.stage}. In vitro IC50: ${compound.inVitroIC50 || compound.inVitroMIC || 'N/A'}.`,
    assessment: `Hepatotoxicity: ${tox.hepatotoxicityScore} (${tox.hepatotoxicityScore >= 0.7 ? 'BLOCKED' : tox.hepatotoxicityScore >= 0.5 ? 'CONCERN' : 'acceptable'}). Ames: ${tox.amesTest}. hERG: ${tox.hERG_IC50}. RepTox: ${tox.reproTox}. ${isBlocked ? 'ADVANCEMENT BLOCKED — safety issues must be resolved first.' : 'Safety profile supports advancement.'}`,
    recommendations,
    warnings,
    non_action_items: ['Update compound registry with safety data', 'Present findings at next SAC (Scientific Advisory Committee) meeting', 'File patent on compound structure if not already protected'],
    reasoning: `[MOCK] Decision based on toxicology screening (hepatotoxicity ${tox.hepatotoxicityScore}, Ames ${tox.amesTest}, hERG ${tox.hERG_IC50}) and regulatory pathway analysis for ${compound.indication}.`,
    requires_human_review: true,
    follow_up: isBlocked ? 'Re-evaluate after structural modification and repeat tox assays (estimated 6–12 months).' : `Initiate IND-enabling studies. Target IND filing: ${reg.clinicalTimeline || 'consult regulatory affairs'}.`,
  }

  return { plan, toolResults, guardrailWarnings, verification: verifyOutput(plan) }
}

// ── Tool schemas ────────────────────────────────────────────────

const TOOL_SCHEMAS_OPENAI = [
  { type:'function', function:{ name:'getCompoundProfile', description:'Retrieve the drug compound profile: class, target protein, indication, molecular weight, potency (IC50/MIC), and development stage.', parameters:{ type:'object', properties:{ compoundId:{ type:'string', description:'Compound ID (COMP001–COMP004)' } }, required:['compoundId'] } } },
  { type:'function', function:{ name:'assessToxicologyProfile', description:'Get the full toxicology profile: LD50, hepatotoxicity score (0–1, >0.7 is critical), Ames mutagenicity, hERG cardiac safety, reproductive toxicity, and max tolerated dose.', parameters:{ type:'object', properties:{ compoundId:{ type:'string' } }, required:['compoundId'] } } },
  { type:'function', function:{ name:'checkRegulatoryPathway', description:'Retrieve FDA regulatory pathway, precedent drugs, IND timeline estimate, and key study requirements for a given therapeutic indication.', parameters:{ type:'object', properties:{ indication:{ type:'string', description:'Disease indication (e.g. "Non-small cell lung cancer", "MRSA")' } }, required:['indication'] } } },
]

const TOOL_SCHEMAS_ANTHROPIC = [
  { name:'getCompoundProfile', description:'Retrieve drug compound profile.', input_schema:{ type:'object', properties:{ compoundId:{ type:'string' } }, required:['compoundId'] } },
  { name:'assessToxicologyProfile', description:'Get full toxicology profile including hepatotoxicity, Ames test, hERG cardiac safety.', input_schema:{ type:'object', properties:{ compoundId:{ type:'string' } }, required:['compoundId'] } },
  { name:'checkRegulatoryPathway', description:'Get FDA regulatory pathway and IND timeline for a therapeutic indication.', input_schema:{ type:'object', properties:{ indication:{ type:'string' } }, required:['indication'] } },
]

export default {
  id: 'drugDiscovery',
  name: 'Drug Discovery',
  icon: '🔬',
  color: '#3fb950',
  reviewerLabel: 'Scientific Review Committee',
  description: 'Preclinical drug candidate assessment with toxicology screening, safety guardrails, and regulatory pathway analysis.',
  scenarios: {
    A: { id:'A', title:'Kinase Inhibitor — NSCLC (Clean Profile)', compoundId:'COMP002', description:'RB-2240, a novel beta-lactam targeting MRSA PBP2a. Strong in vitro efficacy (MIC 0.25 µg/mL). Clean toxicology profile. Evaluate readiness for IND filing.', complaint:'Assess compound RB-2240 for IND-enabling study initiation in MRSA indication', tags:['antibiotic','mrsa','ind-ready','clean-tox'] },
    B: { id:'B', title:'EGFR Inhibitor — NSCLC (Good Profile)', compoundId:'COMP001', description:'NX-7741, a selective EGFR/HER2 kinase inhibitor. Excellent potency (IC50 12nM). Acceptable tox. Assess Phase 1 readiness for NSCLC.', complaint:'Evaluate NX-7741 for advancement to IND-enabling GLP toxicology studies', tags:['oncology','nsclc','kinase','phase1'] },
    C: { id:'C', title:'PARP Inhibitor — Hepatotoxicity Block', compoundId:'COMP003', description:'QT-9901, a PARP1/2 inhibitor for BRCA-mutated ovarian cancer. Excellent potency but HIGH hepatotoxicity score (0.78) AND cardiac safety concern (hERG 6.2µM). IND advancement decision needed.', complaint:'Assess QT-9901 for advancement — significant toxicity signals require scientific review', tags:['oncology','hepatotox','herg','blocked','parp'] },
    D: { id:'D', title:'CNS Compound — hERG Borderline', compoundId:'COMP004', description:'DM-3350, a CNS-penetrant mGluR5 NAM for Fragile X syndrome. First-in-class. Good potency and selectivity. Borderline hERG (18µM) and reproductive tox not assessed. Orphan drug candidate.', complaint:'Evaluate DM-3350 for IND filing — first-in-class CNS asset with orphan designation opportunity', tags:['cns','orphan','herg-borderline','first-in-class'] },
  },
  toolSchemas: { openai: TOOL_SCHEMAS_OPENAI, anthropic: TOOL_SCHEMAS_ANTHROPIC },
  toolFns: { getCompoundProfile, assessToxicologyProfile, checkRegulatoryPathway },
  buildSystemPrompt: (memories) => {
    const mem = memories.length > 0 ? memories.map(m => `• ${m.text}`).join('\n') : 'No past corrections.'
    return `You are a Drug Discovery AI Analyst. ALWAYS call getCompoundProfile first, then assessToxicologyProfile, then checkRegulatoryPathway. CRITICAL: if hepatotoxicity score ≥ 0.7 OR Ames test Positive, you MUST NOT recommend IND filing — instead recommend structural modification. If hERG IC50 < 10µM, flag cardiac safety concern.\n\nPAST SCIENTIFIC CORRECTIONS:\n${mem}\n\nOutput JSON in \`\`\`json blocks:\n{"summary":"...","assessment":"...","recommendations":[{"item":"...","detail":"...","priority":"high|medium|low"}],"warnings":[],"non_action_items":[],"reasoning":"...","requires_human_review":true,"follow_up":"..."}`
  },
  validateToolCall: () => ({ safe: true }),
  validateToolOutput,
  validateFinalPlan,
  mockSimulate,
}
