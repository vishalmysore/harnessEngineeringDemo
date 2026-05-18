import { verifyOutput } from '../feedback/verification.js'
import tracer from '../feedback/tracer.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Mock data ──────────────────────────────────────────────────

const APPLICANTS = {
  AP001: { id:'AP001', name:'Jordan Kim', age:34, currentRole:'Senior Software Engineer', yearsExp:10, skills:['Java','Python','REST APIs','SQL','Agile','Spring Boot'], education:'BS Computer Science', interests:['Machine Learning','AI','Data Science'], currentSalary:110000, location:'Austin, TX', goalRole:'ml-engineer' },
  AP002: { id:'AP002', name:'Sofia Martinez', age:23, currentRole:'Junior Marketing Coordinator', yearsExp:1, skills:['Social Media Marketing','Content Creation','Google Analytics','Canva','Excel'], education:'BS Marketing', interests:['UX Design','Product Management','User Research'], currentSalary:38000, location:'Chicago, IL', goalRole:'ux-designer' },
  AP003: { id:'AP003', name:'David Osei', age:48, currentRole:'High School Biology Teacher', yearsExp:22, skills:['Curriculum Development','Public Speaking','Team Leadership','Student Assessment','Learning Management Systems'], education:'MS Education, BS Biology', interests:['Corporate Training','L&D','Instructional Design'], currentSalary:62000, location:'Atlanta, GA', goalRole:'instructional-designer' },
  AP004: { id:'AP004', name:'Maria Chen', age:41, currentRole:'Assembly Line Technician (Laid Off)', yearsExp:18, skills:['Precision Assembly','Quality Control','Machine Operation','Safety Compliance','Blueprint Reading'], education:'High School Diploma + Trade Cert', interests:['CNC Operation','Robotics Technician','Industrial Automation'], currentSalary:0, location:'Detroit, MI', goalRole:'cnc-technician' },
}

const JOB_MARKET = {
  'ml-engineer':          { avgSalary:155000, demand:9.2, growth:'22% YoY', topSkills:['Python','PyTorch','TensorFlow','MLOps','Statistics','Cloud (AWS/GCP)'], timeToHire:'3–6 months', entryBarrier:'HIGH — portfolio + credentials typically required' },
  'ux-designer':          { avgSalary:92000,  demand:7.8, growth:'13% YoY', topSkills:['Figma','User Research','Prototyping','Usability Testing','HTML/CSS basics'], timeToHire:'2–4 months', entryBarrier:'MEDIUM — portfolio-driven, bootcamps accepted' },
  'instructional-designer':{ avgSalary:78000, demand:8.1, growth:'11% YoY', topSkills:['Articulate 360','Instructional Design Models','LMS (Canvas/Moodle)','Video Production','Needs Analysis'], timeToHire:'1–3 months', entryBarrier:'LOW-MEDIUM — teaching background highly valued' },
  'cnc-technician':       { avgSalary:58000,  demand:8.5, growth:'6% YoY',  topSkills:['CNC Programming (G-code)','CAD/CAM','Blueprint Reading','Haas/Mazak Operation','Quality Measurement'], timeToHire:'1–2 months', entryBarrier:'LOW — prior manufacturing experience counts heavily' },
}

const SKILL_GAPS = {
  AP001: { targetRole:'ml-engineer',          gaps:['PyTorch/TensorFlow','Statistical modelling','MLOps (MLflow/Kubeflow)','Feature engineering'], transferable:['Python','SQL','System design','Agile'], estimatedMonths:6, certifications:['Google ML Certificate','AWS ML Specialty','Fast.ai course'] },
  AP002: { targetRole:'ux-designer',           gaps:['Figma (advanced)','Usability testing','UX research methods','Interaction design principles'], transferable:['Analytics mindset','Content strategy','Consumer psychology'], estimatedMonths:4, certifications:['Google UX Design Certificate','Nielsen Norman UX Cert','CareerFoundry UX bootcamp'] },
  AP003: { targetRole:'instructional-designer',gaps:['Articulate Storyline 360','ADDIE/SAM models','Corporate LMS admin','Needs analysis for business'], transferable:['Curriculum design','Public speaking','Facilitation','Assessment design'], estimatedMonths:3, certifications:['ATD Instructional Design Certificate','Articulate 360 certification','LinkedIn Learning I-D path'] },
  AP004: { targetRole:'cnc-technician',        gaps:['CNC G-code programming','CAD/CAM software (Mastercam)','Haas machine operation'], transferable:['Blueprint reading','Quality control','Precision work','Safety protocols'], estimatedMonths:4, certifications:['NIMS CNC Turning Certification','Mastercam Associate','Community college CNC program (16 weeks)'] },
}

// ── Tool functions ──────────────────────────────────────────────

export function getApplicantProfile(applicantId) {
  const ap = APPLICANTS[applicantId]
  if (!ap) return { error: `Applicant ${applicantId} not found.` }
  return { ...ap }
}

export function fetchJobMarketInsights(targetRole) {
  const market = JOB_MARKET[targetRole]
  if (!market) return { error: `No market data for role: ${targetRole}`, availableRoles: Object.keys(JOB_MARKET) }
  return { targetRole, ...market }
}

export function analyseSkillGap(applicantId) {
  const gap = SKILL_GAPS[applicantId]
  if (!gap) return { error: `No skill gap analysis for applicant ${applicantId}.` }
  return { applicantId, ...gap }
}

// ── Guardrails ─────────────────────────────────────────────────

function validateToolOutput(name, result) {
  if (name === 'analyseSkillGap') {
    if (result.estimatedMonths > 18) {
      const msg = `TRANSITION TIMELINE WARNING: Estimated ${result.estimatedMonths} months is a long transition. Ensure applicant has financial runway and realistic expectations.`
      tracer.publish('guardrail:moderate', msg)
      return { safe: true, severity:'MODERATE', warning: msg, forceRevision: false }
    }
  }
  if (name === 'fetchJobMarketInsights') {
    if (result.demand < 5.0) {
      const msg = `LOW MARKET DEMAND WARNING: "${result.targetRole}" demand score ${result.demand}/10 — limited job openings. Consider adjacent roles with higher demand.`
      tracer.publish('guardrail:moderate', msg)
      return { safe: true, severity:'MODERATE', warning: msg, forceRevision: false }
    }
  }
  if (name === 'getApplicantProfile') {
    if (result.age > 50) {
      const msg = `AGE SENSITIVITY NOTE: Applicant is 50+. Ensure recommendations are age-neutral and skills-focused. Avoid assumptions about adaptability or learning speed.`
      tracer.publish('guardrail:moderate', msg)
      return { safe: true, severity:'INFO', warning: msg, forceRevision: false }
    }
  }
  return { safe: true }
}

function validateFinalPlan(plan) {
  const errors = []
  const hasSalaryPromise = JSON.stringify(plan.recommendations || []).toLowerCase().includes('guaranteed')
  if (hasSalaryPromise) errors.push('Recommendations must not include salary guarantees — use market averages only')
  return { valid: errors.length === 0, errors }
}

// ── Mock simulation ─────────────────────────────────────────────

async function mockSimulate(scenario) {
  const toolResults = []
  const guardrailWarnings = []

  await sleep(300)
  tracer.publish('layer:info', `Mock mode: Loading applicant profile for ${scenario.applicantId}...`)
  await sleep(400)
  const profile = getApplicantProfile(scenario.applicantId)
  const profileGuard = validateToolOutput('getApplicantProfile', profile)
  if (profileGuard.warning) guardrailWarnings.push(profileGuard.warning)
  toolResults.push({ name:'getApplicantProfile', args:{ applicantId:scenario.applicantId }, result:profile })
  tracer.publish('layer:execution', `Profile: ${profile.name}, ${profile.age}yo, ${profile.currentRole}. Goal: ${profile.goalRole}`)

  await sleep(350)
  tracer.publish('layer:execution', `Fetching job market data for "${profile.goalRole}"...`)
  await sleep(450)
  const market = fetchJobMarketInsights(profile.goalRole)
  const marketGuard = validateToolOutput('fetchJobMarketInsights', market)
  if (marketGuard.warning) guardrailWarnings.push(marketGuard.warning)
  toolResults.push({ name:'fetchJobMarketInsights', args:{ targetRole:profile.goalRole }, result:market })

  await sleep(300)
  tracer.publish('layer:execution', `Analysing skill gap for ${scenario.applicantId}...`)
  await sleep(400)
  const gap = analyseSkillGap(scenario.applicantId)
  const gapGuard = validateToolOutput('analyseSkillGap', gap)
  if (gapGuard.warning) guardrailWarnings.push(gapGuard.warning)
  toolResults.push({ name:'analyseSkillGap', args:{ applicantId:scenario.applicantId }, result:gap })

  await sleep(400)
  tracer.publish('layer:execution', 'Building personalised career development plan...')

  const salaryDelta = market.avgSalary - (profile.currentSalary || 0)
  const warnings = guardrailWarnings.slice()
  const recommendations = []

  // Priority certifications
  gap.certifications?.forEach((cert, i) => {
    recommendations.push({ item: cert, detail: i === 0 ? 'Start here — highest ROI for the target role' : 'After completing primary cert', priority: i === 0 ? 'high' : 'medium' })
  })

  // Skill bridge
  gap.gaps?.slice(0, 2).forEach(skill => {
    recommendations.push({ item: `Build: ${skill}`, detail: `${skill} is a top-3 required skill for ${profile.goalRole} — use online courses or side projects`, priority: 'high' })
  })

  recommendations.push({ item: 'Build a portfolio of 2–3 relevant projects', detail: `Showcase ${gap.targetRole} skills. ${gap.transferable?.[0] || 'Prior experience'} provides a strong starting foundation.`, priority: 'medium' })
  recommendations.push({ item: 'Join professional community', detail: `LinkedIn groups, meetups, or Discord communities focused on ${profile.goalRole} for networking and mentorship`, priority: 'low' })

  if (salaryDelta > 20000) warnings.push(`SALARY GAP: Target role avg $${market.avgSalary.toLocaleString()} vs current $${profile.currentSalary?.toLocaleString() || 0}. Gap of $${salaryDelta.toLocaleString()} requires demonstrated skill before negotiating top-band.`)

  const plan = {
    summary: `${profile.name}, ${profile.age}yo — transitioning from ${profile.currentRole} to ${profile.goalRole.replace(/-/g,' ')} in ${profile.location}.`,
    assessment: `Skill gap: ${gap.gaps?.length || 0} area(s) to bridge. ${gap.transferable?.length || 0} transferable skill(s). Estimated transition: ${gap.estimatedMonths} months. Market demand: ${market.demand}/10 (${market.growth} growth). Entry barrier: ${market.entryBarrier}.`,
    recommendations,
    warnings,
    non_action_items: ['Update LinkedIn profile to reflect target role', 'Set aside 8–10 hrs/week for learning', 'Explore employer tuition reimbursement programs'],
    reasoning: `[MOCK] Career plan built from profile analysis, job market data (demand score ${market.demand}), and a ${gap.estimatedMonths}-month skill gap roadmap. ${gap.transferable?.length || 0} transferable skills reduce ramp-up time.`,
    requires_human_review: true,
    follow_up: `Reassess progress in ${Math.ceil(gap.estimatedMonths / 2)} months. Target first application after completing primary certification.`,
  }

  return { plan, toolResults, guardrailWarnings, verification: verifyOutput(plan) }
}

// ── Tool schemas ────────────────────────────────────────────────

const TOOL_SCHEMAS_OPENAI = [
  { type:'function', function:{ name:'getApplicantProfile', description:'Retrieve applicant career profile including current role, skills, education, salary, and goal role.', parameters:{ type:'object', properties:{ applicantId:{ type:'string', description:'Applicant ID (AP001–AP004)' } }, required:['applicantId'] } } },
  { type:'function', function:{ name:'fetchJobMarketInsights', description:'Get job market data for a target role: avg salary, demand score (1–10), growth rate, required skills, time to hire.', parameters:{ type:'object', properties:{ targetRole:{ type:'string', description:'Role slug (e.g. ml-engineer, ux-designer, instructional-designer, cnc-technician)' } }, required:['targetRole'] } } },
  { type:'function', function:{ name:'analyseSkillGap', description:'Identify skill gaps between the applicant\'s current skills and the target role. Returns gaps, transferable skills, certifications, and estimated transition time in months.', parameters:{ type:'object', properties:{ applicantId:{ type:'string' } }, required:['applicantId'] } } },
]

const TOOL_SCHEMAS_ANTHROPIC = [
  { name:'getApplicantProfile', description:'Retrieve applicant career profile.', input_schema:{ type:'object', properties:{ applicantId:{ type:'string' } }, required:['applicantId'] } },
  { name:'fetchJobMarketInsights', description:'Get job market data for a target role.', input_schema:{ type:'object', properties:{ targetRole:{ type:'string' } }, required:['targetRole'] } },
  { name:'analyseSkillGap', description:'Identify skill gaps and suggest certifications.', input_schema:{ type:'object', properties:{ applicantId:{ type:'string' } }, required:['applicantId'] } },
]

export default {
  id: 'career',
  name: 'Career Counselling',
  icon: '🎓',
  color: '#bc8cff',
  reviewerLabel: 'Counsellor Review',
  description: 'Career transition planning with job market analysis, skill gap identification, and personalised learning paths.',
  scenarios: {
    A: { id:'A', title:'Software Engineer → ML Engineer', applicantId:'AP001', description:'Jordan Kim, 34yo Senior SWE with 10yr Java/Python experience. Wants to pivot to machine learning engineering. Strong programming base, needs ML-specific skills.', complaint:'Career pivot to ML/AI — needs structured learning path and realistic timeline', tags:['tech','ml','career-change','upskill'] },
    B: { id:'B', title:'Marketing Grad → UX Designer', applicantId:'AP002', description:'Sofia Martinez, 23yo junior marketing coordinator. Wants to move into UX design. Analytics and consumer insight skills transfer well.', complaint:'Early career pivot to UX — limited design portfolio, seeking certification roadmap', tags:['ux','design','bootcamp','early-career'] },
    C: { id:'C', title:'Teacher → Instructional Designer', applicantId:'AP003', description:'David Osei, 48yo high school biology teacher with 22yr experience. Seeking corporate L&D transition. Rich pedagogical background is a strong asset.', complaint:'Mid-career pivot to corporate instructional design — needs corporate tool certifications', tags:['teaching','ld','corporate','mid-career'] },
    D: { id:'D', title:'Laid-Off Technician → CNC Operator', applicantId:'AP004', description:'Maria Chen, 41yo assembly line technician laid off from automotive plant. 18yr precision manufacturing background. Seeking retraining in CNC/automation.', complaint:'Workforce retraining after layoff — identify fastest path to CNC certification and employment', tags:['manufacturing','retraining','cnc','layoff'] },
  },
  toolSchemas: { openai: TOOL_SCHEMAS_OPENAI, anthropic: TOOL_SCHEMAS_ANTHROPIC },
  toolFns: { getApplicantProfile, fetchJobMarketInsights, analyseSkillGap },
  buildSystemPrompt: (memories) => {
    const mem = memories.length > 0 ? memories.map(m => `• ${m.text}`).join('\n') : 'No past corrections.'
    return `You are a Career Counselling AI. ALWAYS call getApplicantProfile first, then fetchJobMarketInsights for the goal role, then analyseSkillGap. Recommendations must be skills-focused and age-neutral. Never guarantee specific salaries — use market averages.\n\nPAST COUNSELLOR CORRECTIONS:\n${mem}\n\nOutput JSON in \`\`\`json blocks:\n{"summary":"...","assessment":"...","recommendations":[{"item":"...","detail":"...","priority":"high|medium|low"}],"warnings":[],"non_action_items":[],"reasoning":"...","requires_human_review":true,"follow_up":"..."}`
  },
  validateToolCall: () => ({ safe: true }),
  validateToolOutput,
  validateFinalPlan,
  mockSimulate,
}
