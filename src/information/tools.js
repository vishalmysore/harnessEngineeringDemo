const DRUG_INTERACTIONS = {
  'warfarin+aspirin':           { severity: 'HIGH',     risk: 'Severe bleeding risk. Aspirin inhibits platelet aggregation, compounding Warfarin anticoagulation.',    recommendation: 'CONTRAINDICATED — use Acetaminophen instead' },
  'aspirin+warfarin':           { severity: 'HIGH',     risk: 'Severe bleeding risk.',                                                                                   recommendation: 'CONTRAINDICATED — use Acetaminophen instead' },
  'warfarin+ibuprofen':         { severity: 'HIGH',     risk: 'NSAIDs increase anticoagulant effect and cause GI bleeding.',                                             recommendation: 'CONTRAINDICATED — avoid all NSAIDs with anticoagulants' },
  'ibuprofen+warfarin':         { severity: 'HIGH',     risk: 'NSAIDs increase bleeding risk.',                                                                           recommendation: 'CONTRAINDICATED' },
  'metformin+alcohol':          { severity: 'HIGH',     risk: 'Lactic acidosis risk. Alcohol impairs hepatic lactate clearance.',                                         recommendation: 'Avoid alcohol entirely. If heavy drinker, reassess Metformin therapy.' },
  'alcohol+metformin':          { severity: 'HIGH',     risk: 'Lactic acidosis risk.',                                                                                    recommendation: 'Avoid alcohol' },
  'lisinopril+ibuprofen':       { severity: 'MODERATE', risk: 'NSAIDs reduce ACE inhibitor effectiveness and may worsen renal function.',                                 recommendation: 'Avoid NSAIDs. Use Acetaminophen for pain.' },
  'ibuprofen+lisinopril':       { severity: 'MODERATE', risk: 'NSAIDs reduce ACE inhibitor effectiveness.',                                                               recommendation: 'Avoid combination' },
  'lisinopril+pseudoephedrine': { severity: 'MODERATE', risk: 'Decongestants raise blood pressure, counteracting antihypertensive therapy.',                              recommendation: 'Use non-decongestant cold remedies' },
  'pseudoephedrine+lisinopril': { severity: 'MODERATE', risk: 'Blood pressure elevation risk.',                                                                           recommendation: 'Avoid decongestants in hypertension patients' },
  'ssri+maoi':                  { severity: 'CRITICAL', risk: 'Serotonin syndrome — potentially fatal.',                                                                  recommendation: 'ABSOLUTELY CONTRAINDICATED' },
  'maoi+ssri':                  { severity: 'CRITICAL', risk: 'Serotonin syndrome — potentially fatal.',                                                                  recommendation: 'ABSOLUTELY CONTRAINDICATED' },
  'penicillin+tetracycline':    { severity: 'MODERATE', risk: 'Tetracycline (bacteriostatic) may reduce bactericidal effect of penicillin.',                              recommendation: 'Use alternative antibiotics' },
  'tetracycline+penicillin':    { severity: 'MODERATE', risk: 'Reduced antibiotic effectiveness.',                                                                        recommendation: 'Use alternative' },
  'benzodiazepine+alcohol':     { severity: 'HIGH',     risk: 'CNS depression — respiratory failure risk.',                                                               recommendation: 'CONTRAINDICATED. Avoid alcohol during benzodiazepine therapy.' },
  'alcohol+benzodiazepine':     { severity: 'HIGH',     risk: 'CNS depression.',                                                                                          recommendation: 'CONTRAINDICATED' },
  'amoxicillin+penicillin':     { severity: 'HIGH',     risk: 'Cross-allergy: amoxicillin is a penicillin-class antibiotic. Anaphylaxis risk in penicillin-allergic patients.', recommendation: 'CONTRAINDICATED — use macrolide (e.g., Azithromycin) instead' },
  'penicillin+amoxicillin':     { severity: 'HIGH',     risk: 'Cross-allergy risk.',                                                                                      recommendation: 'CONTRAINDICATED — use Azithromycin instead' },
}

const PATIENTS = {
  P001: {
    name: 'Martha Johnson', age: 75, weightKg: 68,
    conditions: ['Hypertension', 'Osteoarthritis'],
    currentMedications: ['Lisinopril 10mg daily', 'Calcium Supplement 500mg daily'],
    allergies: ['Sulfa drugs'],
    lastVitals: { bp: '148/92', hr: 78, temp: 37.2, spo2: 97 },
    notes: 'Elderly patient. Mild CKD (eGFR 58). Fall risk. Monitor renal function.'
  },
  P002: {
    name: 'Raj Patel', age: 55, weightKg: 82,
    conditions: ['Type 2 Diabetes', 'Obesity'],
    currentMedications: ['Metformin 1000mg twice daily'],
    allergies: [],
    lastVitals: { bp: '132/84', hr: 82, temp: 36.8, spo2: 98 },
    notes: 'HbA1c 7.8%. History of heavy alcohol use (reported >14 drinks/week).'
  },
  P003: {
    name: 'Tommy Garcia', age: 8, weightKg: 25,
    conditions: ['Strep Throat (confirmed by rapid antigen test)'],
    currentMedications: [],
    allergies: ['Penicillin'],
    lastVitals: { bp: '100/60', hr: 95, temp: 38.5, spo2: 99 },
    notes: 'PENICILLIN ALLERGY — confirmed anaphylaxis history. Pediatric dosing required.'
  },
  P004: {
    name: 'Wei Chen', age: 62, weightKg: 75,
    conditions: ['Atrial Fibrillation', 'Hypertension'],
    currentMedications: ['Warfarin 5mg daily', 'Metoprolol 25mg twice daily'],
    allergies: [],
    lastVitals: { bp: '138/88', hr: 72, temp: 36.9, spo2: 97 },
    notes: 'INR target 2.0–3.0. Last INR 2.4 (therapeutic). HIGH BLEEDING RISK.'
  }
}

const DOSAGE_LIMITS = {
  amoxicillin:    { maxMgPerKg: 45, maxAbsoluteMg: 3000, unit: 'mg', frequency: 'twice daily',       notes: 'Standard pediatric/adult dose for strep throat. 10-day course.' },
  ibuprofen:      { maxMgPerKg: 10, maxAbsoluteMg: 800,  unit: 'mg', frequency: 'every 6–8 hours',   notes: 'Max 3200mg/day adults. Avoid in renal impairment, elderly, anticoagulants.' },
  acetaminophen:  { maxMgPerKg: 15, maxAbsoluteMg: 1000, unit: 'mg', frequency: 'every 6 hours',     notes: 'Max 4000mg/day healthy adults; 2000mg/day with liver risk.' },
  aspirin:        { maxMgPerKg: 15, maxAbsoluteMg: 1000, unit: 'mg', frequency: 'every 4–6 hours',   notes: 'NOT for children under 16 (Reye syndrome). Avoid with anticoagulants.' },
  azithromycin:   { maxMgPerKg: 10, maxAbsoluteMg: 500,  unit: 'mg', frequency: 'once daily',        notes: '5-day Z-pack for strep. Use when penicillin-allergic.' },
  pseudoephedrine:{ maxMgPerKg: 1,  maxAbsoluteMg: 60,   unit: 'mg', frequency: 'every 4–6 hours',   notes: 'Avoid in hypertension, cardiac disease, hyperthyroidism.' },
}

export function checkDrugInteraction(med1, med2) {
  const key = `${med1.toLowerCase()}+${med2.toLowerCase()}`
  const interaction = DRUG_INTERACTIONS[key]
  if (!interaction) {
    return { med1, med2, severity: 'NONE', risk: 'No known interaction found in database.', recommendation: 'No specific precautions required based on available data.' }
  }
  return { med1, med2, ...interaction }
}

export function fetchPatientVitals(patientId) {
  const patient = PATIENTS[patientId]
  if (!patient) {
    return { error: `Patient ${patientId} not found in records.` }
  }
  return { patientId, ...patient }
}

export function calculateDosage(medication, weightKg) {
  const drug = DOSAGE_LIMITS[medication.toLowerCase()]
  if (!drug) {
    return { error: `Dosage data not available for ${medication}. Consult pharmacist.` }
  }
  const rawDose = Math.round(drug.maxMgPerKg * weightKg)
  const recommendedDose = Math.min(rawDose, drug.maxAbsoluteMg)
  return {
    medication, weightKg,
    calculatedByWeight: rawDose,
    recommendedDose,
    maxAbsoluteDose: drug.maxAbsoluteMg,
    cappedAtMaximum: rawDose > drug.maxAbsoluteMg,
    unit: drug.unit,
    frequency: drug.frequency,
    notes: drug.notes
  }
}

export const TOOL_SCHEMAS_OPENAI = [
  {
    type: 'function',
    function: {
      name: 'checkDrugInteraction',
      description: 'Check for known drug-drug interactions between two medications. Returns severity (NONE/MODERATE/HIGH/CRITICAL) and clinical recommendations.',
      parameters: {
        type: 'object',
        properties: {
          med1: { type: 'string', description: 'First medication name (lowercase)' },
          med2: { type: 'string', description: 'Second medication name (lowercase)' }
        },
        required: ['med1', 'med2']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetchPatientVitals',
      description: 'Retrieve patient medical history including current medications, allergies, conditions, and recent vital signs.',
      parameters: {
        type: 'object',
        properties: {
          patientId: { type: 'string', description: 'Patient ID (P001, P002, P003, P004)' }
        },
        required: ['patientId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'calculateDosage',
      description: 'Calculate the safe dosage for a medication based on patient weight. Returns recommended dose and maximum thresholds.',
      parameters: {
        type: 'object',
        properties: {
          medication: { type: 'string', description: 'Medication name (lowercase, e.g. amoxicillin, ibuprofen)' },
          weightKg:   { type: 'number', description: 'Patient weight in kilograms' }
        },
        required: ['medication', 'weightKg']
      }
    }
  }
]

export const TOOL_SCHEMAS_ANTHROPIC = [
  {
    name: 'checkDrugInteraction',
    description: 'Check for known drug-drug interactions between two medications. Returns severity (NONE/MODERATE/HIGH/CRITICAL) and clinical recommendations.',
    input_schema: {
      type: 'object',
      properties: {
        med1: { type: 'string', description: 'First medication name (lowercase)' },
        med2: { type: 'string', description: 'Second medication name (lowercase)' }
      },
      required: ['med1', 'med2']
    }
  },
  {
    name: 'fetchPatientVitals',
    description: 'Retrieve patient medical history including current medications, allergies, conditions, and recent vital signs.',
    input_schema: {
      type: 'object',
      properties: {
        patientId: { type: 'string', description: 'Patient ID (P001, P002, P003, P004)' }
      },
      required: ['patientId']
    }
  },
  {
    name: 'calculateDosage',
    description: 'Calculate the safe dosage for a medication based on patient weight. Returns recommended dose and maximum thresholds.',
    input_schema: {
      type: 'object',
      properties: {
        medication: { type: 'string', description: 'Medication name (lowercase)' },
        weightKg:   { type: 'number', description: 'Patient weight in kilograms' }
      },
      required: ['medication', 'weightKg']
    }
  }
]

export const TOOL_FNS = { checkDrugInteraction, fetchPatientVitals, calculateDosage }
