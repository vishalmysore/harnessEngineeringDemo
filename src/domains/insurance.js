import { verifyOutput } from '../feedback/verification.js'
import tracer from '../feedback/tracer.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Mock data ──────────────────────────────────────────────────

const CLAIMS = {
  CLM001: { id:'CLM001', type:'Auto Collision', amount:8500, policyId:'POL001', claimDate:'2025-11-15', description:'Rear-end collision at low speed (~5mph). Claimant reports whiplash and bumper damage.', priorClaims:3, lastClaim:'2024-08-01', incidentFlags:['No police report filed','Medical treatment began 10 days post-incident','Low impact speed inconsistent with reported injuries'] },
  CLM002: { id:'CLM002', type:'Homeowners Water Damage', amount:22000, policyId:'POL002', claimDate:'2025-10-03', description:'Burst pipe in kitchen. Flooding to ground floor — damage to flooring, cabinets, appliances.', priorClaims:0, lastClaim:null, incidentFlags:[] },
  CLM003: { id:'CLM003', type:'Total Loss Vehicle', amount:67000, policyId:'POL003', claimDate:'2025-12-01', description:'Vehicle totalled in multi-car pileup on highway. Third-party at fault. Claimant seeking full market value.', priorClaims:1, lastClaim:'2022-03-10', incidentFlags:['Claim amount may exceed policy ACV limit'] },
  CLM004: { id:'CLM004', type:'Dental Accident', amount:4200, policyId:'POL004', claimDate:'2025-11-28', description:'Chipped tooth during sports activity. Claimant requesting full cosmetic restoration.', priorClaims:0, lastClaim:null, incidentFlags:['Cosmetic procedures excluded under this policy tier'] },
}

const POLICIES = {
  POL001: { type:'Auto', collisionLimit:50000, personalInjuryLimit:25000, deductible:1000, exclusions:['Pre-existing damage','Racing','Commercial use'], status:'Active', premium:1200 },
  POL002: { type:'Homeowners', dwellingLimit:400000, personalPropertyLimit:100000, deductible:2500, exclusions:['Flood from external source','Earthquake','Mold pre-existing at purchase'], status:'Active', premium:2800 },
  POL003: { type:'Auto', collisionLimit:55000, personalInjuryLimit:25000, deductible:1500, exclusions:['Pre-existing damage'], status:'Active', premium:1450 },
  POL004: { type:'Dental (Basic)', accidentalDamageLimit:2000, exclusions:['Cosmetic procedures','Orthodontics','Implants'], status:'Active', premium:360 },
}

const FRAUD_SCORES = {
  CLM001: { score:0.72, riskLevel:'HIGH',   flags:['3 prior claims in 4 years','Delayed medical treatment','No police report','Low-impact velocity inconsistent with injury severity'] },
  CLM002: { score:0.04, riskLevel:'LOW',    flags:[] },
  CLM003: { score:0.18, riskLevel:'LOW',    flags:['Amount near policy limit'] },
  CLM004: { score:0.09, riskLevel:'LOW',    flags:['Cosmetic item requested'] },
}

// ── Tool functions ──────────────────────────────────────────────

export function getClaimDetails(claimId) {
  const claim = CLAIMS[claimId]
  if (!claim) return { error: `Claim ${claimId} not found.` }
  return { ...claim }
}

export function checkPolicyCoverage(policyId) {
  const policy = POLICIES[policyId]
  if (!policy) return { error: `Policy ${policyId} not found.` }
  return { policyId, ...policy }
}

export function assessFraudRisk(claimId) {
  const fraud = FRAUD_SCORES[claimId]
  if (!fraud) return { error: `No fraud data for claim ${claimId}.` }
  return { claimId, ...fraud }
}

// ── Guardrails ─────────────────────────────────────────────────

function validateToolOutput(name, result) {
  if (name === 'assessFraudRisk') {
    if (result.score >= 0.7) {
      const msg = `HIGH FRAUD RISK (score ${result.score}): ${result.flags.join('; ')}. Refer to Special Investigation Unit before any settlement.`
      tracer.publish('guardrail:high', msg)
      return { safe: false, severity:'HIGH', warning: msg, forceRevision: true }
    }
    if (result.score >= 0.4) {
      const msg = `MODERATE FRAUD RISK (score ${result.score}): ${result.flags.join('; ')}. Request additional documentation.`
      tracer.publish('guardrail:moderate', msg)
      return { safe: true, severity:'MODERATE', warning: msg, forceRevision: false }
    }
  }
  if (name === 'checkPolicyCoverage' && result.exclusions?.length > 0) {
    const msg = `POLICY EXCLUSIONS ACTIVE: ${result.exclusions.join(', ')}. Verify claimed items are not excluded.`
    tracer.publish('guardrail:moderate', msg)
    return { safe: true, severity:'INFO', warning: msg, forceRevision: false }
  }
  if (name === 'getClaimDetails') {
    const claim = result
    const policy = POLICIES[claim.policyId]
    if (policy) {
      const maxLimit = Math.max(...Object.values(policy).filter(v => typeof v === 'number' && v > 1000))
      if (claim.amount > maxLimit) {
        const msg = `COVERAGE LIMIT EXCEEDED: Claim amount $${claim.amount.toLocaleString()} exceeds policy maximum $${maxLimit.toLocaleString()}.`
        tracer.publish('guardrail:high', msg)
        return { safe: false, severity:'HIGH', warning: msg, forceRevision: true }
      }
    }
  }
  return { safe: true }
}

function validateFinalPlan(plan, toolResults) {
  const errors = []
  const fraudResult = toolResults.find(r => r.name === 'assessFraudRisk')
  if (fraudResult?.result?.score >= 0.7) {
    const hasSIU = (plan.recommendations || []).some(r => r.item?.toLowerCase().includes('investigation') || r.item?.toLowerCase().includes('siu'))
    if (!hasSIU) errors.push('HIGH fraud risk detected — SIU referral must be included in recommendations')
  }
  return { valid: errors.length === 0, errors }
}

// ── Mock simulation ─────────────────────────────────────────────

async function mockSimulate(scenario) {
  const toolResults = []
  const guardrailWarnings = []

  await sleep(300)
  tracer.publish('layer:info', `Mock mode: Loading claim details for ${scenario.claimId}...`)
  await sleep(400)
  const claim = getClaimDetails(scenario.claimId)
  toolResults.push({ name:'getClaimDetails', args:{ claimId:scenario.claimId }, result:claim })
  tracer.publish('layer:execution', `Claim: ${claim.type} — $${claim.amount?.toLocaleString()} — ${claim.incidentFlags?.length || 0} flag(s)`)

  await sleep(300)
  tracer.publish('layer:execution', `Checking policy coverage for ${claim.policyId}...`)
  await sleep(350)
  const policy = checkPolicyCoverage(claim.policyId)
  const policyGuard = validateToolOutput('checkPolicyCoverage', policy)
  if (policyGuard.warning) guardrailWarnings.push(policyGuard.warning)
  toolResults.push({ name:'checkPolicyCoverage', args:{ policyId:claim.policyId }, result:policy })

  const claimGuard = validateToolOutput('getClaimDetails', claim)
  if (claimGuard.warning) guardrailWarnings.push(claimGuard.warning)

  await sleep(300)
  tracer.publish('layer:execution', `Running fraud risk assessment for ${scenario.claimId}...`)
  await sleep(450)
  const fraud = assessFraudRisk(scenario.claimId)
  const fraudGuard = validateToolOutput('assessFraudRisk', fraud)
  if (fraudGuard.warning) guardrailWarnings.push(fraudGuard.warning)
  toolResults.push({ name:'assessFraudRisk', args:{ claimId:scenario.claimId }, result:fraud })

  await sleep(400)
  tracer.publish('layer:execution', 'Synthesising claim recommendation...')

  const warnings = []
  const recommendations = []

  if (fraud.score >= 0.7) {
    warnings.push(`HIGH FRAUD RISK (${fraud.score}): ${fraud.flags.join('; ')}`)
    recommendations.push({ item:'Refer to Special Investigation Unit (SIU)', detail:'Fraud score exceeds 0.70 threshold — mandatory SIU review before any payout', priority:'high' })
    recommendations.push({ item:'Request full documentation package', detail:'Police report, original medical records from day of incident, repair shop independent estimate', priority:'high' })
    recommendations.push({ item:'Place settlement on hold', detail:'Do not issue any payment until SIU investigation complete (estimated 10–15 business days)', priority:'high' })
  } else if (fraud.score >= 0.4) {
    warnings.push(`MODERATE FRAUD RISK (${fraud.score}): ${fraud.flags.join('; ')}`)
    recommendations.push({ item:'Request additional documentation', detail:'Independent medical assessment and second repair estimate recommended', priority:'medium' })
  }

  const maxLimit = Math.max(...Object.values(policy).filter(v => typeof v === 'number' && v > 1000))
  if (claim.amount > maxLimit) {
    warnings.push(`COVERAGE LIMIT: Claim $${claim.amount.toLocaleString()} exceeds policy max $${maxLimit.toLocaleString()}. Claimant responsible for difference.`)
    recommendations.push({ item:`Approve partial settlement up to policy limit: $${maxLimit.toLocaleString()}`, detail:`Remainder $${(claim.amount - maxLimit).toLocaleString()} is claimant's responsibility`, priority:'medium' })
  }

  const excludedItems = (policy.exclusions || []).filter(ex => claim.description?.toLowerCase().includes(ex.toLowerCase().split(' ')[0]))
  if (excludedItems.length > 0) {
    warnings.push(`POLICY EXCLUSION: ${excludedItems.join(', ')} may apply — review claim items against policy exclusions`)
    recommendations.push({ item:'Conduct line-item exclusion review', detail:`Exclude any items matching: ${excludedItems.join(', ')}`, priority:'medium' })
  }

  if (fraud.score < 0.4 && claim.amount <= maxLimit && excludedItems.length === 0) {
    const settlement = Math.max(0, claim.amount - (policy.deductible || 0))
    recommendations.push({ item:`Approve settlement: $${settlement.toLocaleString()}`, detail:`Full claim $${claim.amount.toLocaleString()} minus $${policy.deductible?.toLocaleString() || 0} deductible`, priority:'high' })
    recommendations.push({ item:'Issue payment within 5 business days', detail:'Standard processing — no investigation required', priority:'medium' })
  }

  const plan = {
    summary: `Claim ${scenario.claimId} — ${claim.type} — Amount: $${claim.amount?.toLocaleString()} — Policy: ${claim.policyId} (${policy.type})`,
    assessment: `Fraud risk: ${fraud.riskLevel} (${fraud.score}). ${claim.incidentFlags?.length || 0} incident flag(s). ${guardrailWarnings.length} guardrail(s) triggered.`,
    recommendations,
    warnings,
    non_action_items: ['Document all adjuster communications', 'Update claims management system with decision and rationale'],
    reasoning: `[MOCK] Insurance claim analysed via fraud scoring (${fraud.score}), policy coverage verification, and incident flag review. ${recommendations.length} action(s) recommended.`,
    requires_human_review: true,
    follow_up: fraud.score >= 0.7 ? 'SIU report required before any settlement. Estimated 10–15 business days.' : 'Standard claim resolution. Follow up with claimant within 5 business days.',
  }

  return { plan, toolResults, guardrailWarnings, verification: verifyOutput(plan) }
}

// ── Tool schemas ────────────────────────────────────────────────

const TOOL_SCHEMAS_OPENAI = [
  { type:'function', function:{ name:'getClaimDetails', description:'Retrieve full details of an insurance claim including type, amount, incident flags, and claimant history.', parameters:{ type:'object', properties:{ claimId:{ type:'string', description:'Claim ID (e.g. CLM001)' } }, required:['claimId'] } } },
  { type:'function', function:{ name:'checkPolicyCoverage', description:'Look up policy terms, coverage limits, deductibles, and exclusions for a given policy ID.', parameters:{ type:'object', properties:{ policyId:{ type:'string', description:'Policy ID (e.g. POL001)' } }, required:['policyId'] } } },
  { type:'function', function:{ name:'assessFraudRisk', description:'Run fraud risk scoring on a claim. Returns a 0–1 risk score and specific red flags. Score ≥ 0.7 triggers mandatory SIU referral.', parameters:{ type:'object', properties:{ claimId:{ type:'string', description:'Claim ID to assess' } }, required:['claimId'] } } },
]

const TOOL_SCHEMAS_ANTHROPIC = [
  { name:'getClaimDetails', description:'Retrieve full details of an insurance claim.', input_schema:{ type:'object', properties:{ claimId:{ type:'string' } }, required:['claimId'] } },
  { name:'checkPolicyCoverage', description:'Look up policy terms, limits, and exclusions.', input_schema:{ type:'object', properties:{ policyId:{ type:'string' } }, required:['policyId'] } },
  { name:'assessFraudRisk', description:'Run fraud risk scoring (0–1) on a claim.', input_schema:{ type:'object', properties:{ claimId:{ type:'string' } }, required:['claimId'] } },
]

export default {
  id: 'insurance',
  name: 'Insurance',
  icon: '🛡️',
  color: '#f0883e',
  reviewerLabel: 'Claims Adjuster Review',
  description: 'Claims processing with fraud detection, policy coverage verification, and settlement recommendations.',
  scenarios: {
    A: { id:'A', title:'Auto Claim — High Fraud Risk', claimId:'CLM001', description:'Rear-end collision claim for $8,500. Claimant has 3 prior claims. No police report. Medical treatment started 10 days post-incident. Possible whiplash exaggeration.', complaint:'Claimant requesting full collision settlement including personal injury compensation', tags:['fraud','auto','whiplash','investigation'] },
    B: { id:'B', title:'Homeowners — Water Damage', claimId:'CLM002', description:'Burst kitchen pipe causing $22,000 in damage. First-time claimant. Full documentation available. Contractor estimates submitted.', complaint:'Straightforward water damage claim with repair estimates — requesting full coverage', tags:['homeowners','water','legitimate','settlement'] },
    C: { id:'C', title:'Auto — Total Loss Exceeding Policy Limit', claimId:'CLM003', description:'Vehicle totalled in multi-car pileup. Claimant seeking $67,000 market value. Policy collision limit is $55,000. Third-party at fault but uninsured.', complaint:'Requesting full market value payout for totalled vehicle — amount may exceed coverage', tags:['total-loss','auto','coverage-limit','overage'] },
    D: { id:'D', title:'Dental Claim — Excluded Procedure', claimId:'CLM004', description:'Chipped tooth from sports accident. Claimant requesting full cosmetic restoration ($4,200). Policy is Basic Dental with cosmetic exclusions.', complaint:'Requesting cosmetic restoration coverage — policy exclusions may apply', tags:['dental','exclusion','cosmetic','policy'] },
  },
  toolSchemas: { openai: TOOL_SCHEMAS_OPENAI, anthropic: TOOL_SCHEMAS_ANTHROPIC },
  toolFns: { getClaimDetails, checkPolicyCoverage, assessFraudRisk },
  buildSystemPrompt: (memories) => {
    const mem = memories.length > 0 ? memories.map(m => `• ${m.text}`).join('\n') : 'No past corrections.'
    return `You are an Insurance Claims AI Analyst. ALWAYS call getClaimDetails first, then checkPolicyCoverage for the policy, then assessFraudRisk. If fraud score ≥ 0.7, you MUST recommend SIU referral. If claim exceeds policy limit, note the shortfall.\n\nPAST ADJUSTER CORRECTIONS:\n${mem}\n\nOutput JSON in \`\`\`json blocks:\n{"summary":"...","assessment":"...","recommendations":[{"item":"...","detail":"...","priority":"high|medium|low"}],"warnings":[],"non_action_items":[],"reasoning":"...","requires_human_review":true,"follow_up":"..."}`
  },
  validateToolCall: () => ({ safe: true }),
  validateToolOutput,
  validateFinalPlan,
  mockSimulate,
}
