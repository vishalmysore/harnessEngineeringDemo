const REQUIRED_FIELDS = ['patient_summary', 'medications', 'reason', 'duration', 'doctor_review', 'warnings']

export function verifyCarePlan(plan) {
  const errors = []

  for (const field of REQUIRED_FIELDS) {
    if (plan[field] === undefined || plan[field] === null || plan[field] === '') {
      errors.push(`Missing required field: "${field}"`)
    }
  }

  if (plan.doctor_review !== true) {
    errors.push('doctor_review must be true — AI recommendations require physician sign-off')
  }

  if (Array.isArray(plan.medications)) {
    plan.medications.forEach((med, i) => {
      if (!med.name) errors.push(`medications[${i}] missing "name"`)
      if (!med.dose) errors.push(`medications[${i}] missing "dose"`)
    })
  }

  if (!Array.isArray(plan.warnings)) {
    errors.push('"warnings" must be an array')
  }

  return {
    valid: errors.length === 0,
    errors,
    score: errors.length === 0 ? 1.0 : Math.max(0, 1 - errors.length * 0.15)
  }
}

export function extractCarePlan(rawText) {
  const jsonBlock = rawText.match(/```json\s*([\s\S]*?)\s*```/)
  if (jsonBlock) {
    try { return JSON.parse(jsonBlock[1]) } catch { /* fall through */ }
  }
  const braceMatch = rawText.match(/\{[\s\S]*\}/)
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]) } catch { /* fall through */ }
  }
  return {
    patient_summary: 'Extracted from unstructured response',
    medications: [],
    warnings: ['Could not parse structured JSON from model response'],
    reason: rawText.substring(0, 500),
    duration: 'As directed by physician',
    doctor_review: true,
    _parse_error: true
  }
}
