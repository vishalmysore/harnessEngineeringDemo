import tracer from '../feedback/tracer.js'

const HIGH_RISK_SEVERITIES = new Set(['HIGH', 'CRITICAL'])

export function validateToolCall(toolName, args) {
  if (toolName === 'calculateDosage') {
    if (args.weightKg <= 0 || args.weightKg > 300) {
      return { safe: false, reason: `Invalid weight: ${args.weightKg}kg is outside safe range.` }
    }
  }
  return { safe: true }
}

export function validateToolOutput(toolName, result) {
  if (toolName === 'checkDrugInteraction') {
    if (result.severity === 'CRITICAL') {
      const msg = `CRITICAL INTERACTION DETECTED: ${result.med1} + ${result.med2} — ${result.risk} | ${result.recommendation}`
      tracer.publish('guardrail:critical', msg)
      return { safe: false, severity: 'CRITICAL', warning: msg, forceRevision: true }
    }
    if (HIGH_RISK_SEVERITIES.has(result.severity)) {
      const msg = `HIGH-RISK INTERACTION: ${result.med1} + ${result.med2} — ${result.risk} | ${result.recommendation}`
      tracer.publish('guardrail:high', msg)
      return { safe: false, severity: 'HIGH', warning: msg, forceRevision: true }
    }
    if (result.severity === 'MODERATE') {
      const msg = `MODERATE INTERACTION WARNING: ${result.med1} + ${result.med2} — ${result.recommendation}`
      tracer.publish('guardrail:moderate', msg)
      return { safe: true, severity: 'MODERATE', warning: msg, forceRevision: false }
    }
  }

  if (toolName === 'calculateDosage') {
    if (result.cappedAtMaximum) {
      const msg = `DOSAGE CAP APPLIED: Weight-based calc (${result.calculatedByWeight}mg) exceeds absolute max (${result.maxAbsoluteMg}mg). Capped at ${result.recommendedDose}mg.`
      tracer.publish('guardrail:dosage', msg)
      return { safe: true, severity: 'INFO', warning: msg, forceRevision: false }
    }
  }

  if (toolName === 'fetchPatientVitals' && result.allergies?.length > 0) {
    const msg = `ALLERGY ALERT: Patient has documented allergies: ${result.allergies.join(', ')}. Cross-check all prescriptions.`
    tracer.publish('guardrail:allergy', msg)
    return { safe: true, severity: 'ALLERGY', warning: msg, forceRevision: false }
  }

  return { safe: true }
}

export function validateFinalPlan(plan, toolResults) {
  const errors = []

  const vitalsResult = toolResults.find(r => r.name === 'fetchPatientVitals' && !r.result.error)
  if (vitalsResult) {
    const allergies = vitalsResult.result.allergies || []
    for (const med of (plan.medications || [])) {
      for (const allergy of allergies) {
        const medLow = med.name?.toLowerCase() || ''
        const allergyLow = allergy.toLowerCase()
        if (medLow.includes(allergyLow) || allergyLow.includes(medLow) ||
            (allergyLow === 'penicillin' && medLow.includes('amoxicillin'))) {
          errors.push(`ALLERGY VIOLATION: ${med.name} is contraindicated — patient is allergic to ${allergy}`)
        }
      }
    }
  }

  const interactionResults = toolResults.filter(r => r.name === 'checkDrugInteraction' && HIGH_RISK_SEVERITIES.has(r.result.severity))
  for (const ir of interactionResults) {
    const blockedMed = ir.result.med2.toLowerCase()
    const prescribed = (plan.medications || []).find(m => m.name?.toLowerCase().includes(blockedMed))
    if (prescribed) {
      errors.push(`INTERACTION VIOLATION: ${prescribed.name} has a ${ir.result.severity} interaction risk — ${ir.result.recommendation}`)
    }
  }

  return { valid: errors.length === 0, errors }
}
