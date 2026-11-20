/**
 * catalog.js — the 12 agent architecture patterns, each wired to a real use-case
 * from the harness domains (Healthcare, Insurance, Career, Drug Discovery).
 *
 * Each pattern = { id, group, name, control, bestUse, tradeoff, usecase, explain,
 *                  graph:{nodes,edges,rankDir}, run(ctx, input) → outcome string }
 *
 * run() only uses ctx.llm (real WebLLM generation), ctx.tool (real domain tool
 * functions), ctx.gate (programmatic checks) and ctx.decide (a real human click).
 */
import DOMAINS from '../domains/index.js'
import { runAgent } from '../execution/orchestrator.js'
import tracer from '../feedback/tracer.js'
import { retrieveRelevantMemories, saveCorrection } from '../information/memoryManager.js'
import { compact, firstJSON, pickLabel, short, esc } from './runtime.js'

const H = DOMAINS.healthcare, I = DOMAINS.insurance, C = DOMAINS.career, D = DOMAINS.drugDiscovery
const n = (id, label, kind) => ({ id, label, kind })
const p = (t) => `<p>${esc(t).replace(/\n/g, '<br>')}</p>`
const ul = (items) => `<ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>`
const kv = (k, v) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`
const money = (x) => `$${Number(x).toLocaleString('en-US')}`
const has = (text, ...needles) => needles.every(nd => (nd instanceof RegExp ? nd : new RegExp(nd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).test(text))
const amountIn = (text, x) => text.replace(/[,\s$]/g, '').includes(String(x))

export const GROUPS = [
  { id: 'single', name: '1 · Foundational single-agent' },
  { id: 'workflow', name: '2 · Deterministic workflows' },
  { id: 'multi', name: '3 · Multi-agent collaboration' },
  { id: 'gov', name: '4 · Governance & control' },
]

export const PATTERNS = [
  // ─────────────────────────────────────────────────────────── 1 · single agent
  {
    id: 'augmented', group: 'single', name: 'Augmented LLM',
    control: 'Single call', bestUse: 'Grounded Q&A over records', tradeoff: 'Only as good as what you retrieve',
    usecase: `${I.icon} Insurance · ${I.scenarios.B.title}`,
    explain: 'The building block: <b>one</b> model call whose context is augmented with retrieval (claim + policy records), tool data and long-term memory (past adjuster corrections). A grounding check then verifies the number the model quoted against the records.',
    graph: {
      nodes: [n('in', 'Request\nclaim CLM002', 'input'), n('mem', 'Memory\npast corrections', 'tool'), n('rag', 'Retrieve\nclaim + policy', 'tool'),
        n('llm', 'Augmented LLM\n(1 call)', 'llm'), n('chk', 'Grounding\ncheck', 'gate'), n('out', 'Answer', 'output')],
      edges: [['in', 'mem'], ['in', 'rag'], ['mem', 'llm', 'memory'], ['rag', 'llm', 'context'], ['llm', 'chk'], ['chk', 'out']],
    },
    async run(ctx) {
      const sc = I.scenarios.B
      ctx.node('in', 'done')
      const mem = retrieveRelevantMemories(`${sc.description} ${sc.complaint}`, 'insurance')
      ctx.node('mem', 'done', `${mem.length} found`); ctx.take('in', 'mem')
      ctx.log('note', `Memory retrieval: ${mem.length} relevant correction(s) for this claim type.`)
      const claim = ctx.tool('rag', I, 'getClaimDetails', sc.claimId)
      const policy = ctx.tool('rag', I, 'checkPolicyCoverage', claim.policyId)
      ctx.take('in', 'rag'); ctx.take('rag', 'llm'); ctx.take('mem', 'llm')
      const expected = claim.amount - policy.deductible
      const text = await ctx.llm({
        node: 'llm', label: 'Augmented LLM', maxTokens: 160,
        system: 'You are an insurance claims analyst. Use ONLY the facts provided. Be concise.',
        user: `Request: ${sc.complaint}\n\nRETRIEVED CLAIM RECORD:\n${compact(claim)}\n\nRETRIEVED POLICY:\n${compact(policy)}\n\nMEMORY (past adjuster corrections):\n${mem.map(m => '- ' + m.text).join('\n') || 'none'}\n\nAnswer in 3 short lines:\n1) Decision: approve, partial or deny\n2) Settlement amount = claim amount minus deductible\n3) One-line reason`,
      })
      ctx.take('llm', 'chk')
      const ok = ctx.gate('chk', amountIn(text, expected), `Settlement in answer must equal claim ${money(claim.amount)} − deductible ${money(policy.deductible)} = ${money(expected)} (from the records)`)
      ctx.take('chk', 'out', !ok); ctx.node('out', 'done')
      ctx.result('Augmented LLM answer', p(text) + kv('Grounding check', ok ? `PASS — quotes ${money(expected)}` : `FAIL — expected ${money(expected)}`), ok ? 'ok' : 'warn')
      return ok ? `Grounded (${money(expected)})` : 'Ungrounded amount'
    },
  },
  {
    id: 'react', group: 'single', name: 'ReAct loop',
    control: 'Dynamic · single agent', bestUse: 'Open-ended tool use', tradeoff: 'Can loop — needs step/token caps',
    usecase: `${H.icon} Healthcare · ${H.scenarios.A.title}`,
    explain: 'Thought → Action → Observation, repeated until the model stops asking for tools. This is the <b>real harness orchestrator</b> (<code>runAgent()</code>) — the model chooses its own tool calls, guardrails fire inside the loop, and <code>MAX_ITERATIONS</code> caps runaways.',
    graph: {
      nodes: [n('in', 'Patient case\nP001', 'input'), n('think', 'Thought\n(model)', 'llm'), n('act', 'Action\ntool call', 'tool'), n('obs', 'Observation\ntool result', 'tool'),
        n('guard', 'Guardrails', 'gate'), n('out', 'Final answer\n(no tool call)', 'output')],
      edges: [['in', 'think'], ['think', 'act', 'call tool'], ['act', 'obs'], ['obs', 'guard'], ['guard', 'think', 'observe', 'loop'], ['think', 'out', 'done']],
    },
    async run(ctx) {
      const sc = H.scenarios.A
      ctx.node('in', 'done'); ctx.take('in', 'think')
      let iter = 0, tools = 0, guards = 0
      const unsub = tracer.subscribe('*', (event, data) => {
        const msg = typeof data === 'string' ? data : ''
        let m
        if ((m = /^Iteration (\d+)/.exec(msg))) { iter = +m[1]; ctx.node('think', 'running', `iteration ${iter}`); ctx.log('note', msg) }
        else if ((m = /^Invoking (\w+)\((.*)\)/.exec(msg))) { tools++; ctx.node('think', 'done'); ctx.take('think', 'act'); ctx.node('act', 'running', m[1]); ctx.log('route', `Action: ${m[1]}(${short(m[2], 80)})`) }
        else if (/^Tool \w+ returned/.test(msg)) { ctx.node('act', 'done'); ctx.take('act', 'obs'); ctx.node('obs', 'done', msg.includes('error') ? 'error' : 'ok'); ctx.take('obs', 'guard'); ctx.node('guard', 'pass'); ctx.take('guard', 'think'); ctx.log('note', msg) }
        else if (event.startsWith('guardrail:')) { guards++; ctx.node('guard', 'fail', `${guards} fired`); ctx.log('warn', `Guardrail: ${short(msg || compact(data), 200)}`) }
        else if (event === 'agent:complete') { ctx.take('think', 'out'); ctx.node('out', 'done') }
        else if (event === 'agent:error') ctx.log('warn', short(msg || compact(data), 200))
        else if (msg) ctx.log('note', short(msg, 200))
      })
      try {
        const res = await runAgent(sc, H)
        const plan = res.plan || {}
        ctx.result(`ReAct finished in ${iter} iteration(s) · ${tools} tool call(s) · ${guards} guardrail(s)`,
          p(plan.summary || '') + ul((plan.recommendations || []).map(r => `<b>${esc(r.item || r.medication || r.name || '')}</b> ${esc(r.detail || r.reason || '')}`)) +
          ((plan.warnings || []).length ? kv('Warnings', plan.warnings.join(' · ')) : '') + kv('Schema verification', res.verification?.valid ? 'PASS' : 'FAIL'),
          res.verification?.valid ? 'ok' : 'warn')
        return `${iter} iters · ${tools} tools · ${res.verification?.valid ? 'valid' : 'invalid'}`
      } finally { unsub() }
    },
  },
  {
    id: 'evalopt', group: 'single', name: 'Evaluator-Optimizer',
    control: 'Iterative loop', bestUse: 'Generation with clear criteria', tradeoff: 'Latency & tokens × iterations',
    usecase: `${C.icon} Career · ${C.scenarios.B.title}`,
    explain: 'A generator drafts a learning plan; a <b>deterministic validator</b> (schema + facts from the tools) and an <b>LLM judge</b> critique it. Any failure becomes feedback for the next draft — up to 3 rounds.',
    graph: {
      nodes: [n('in', 'Applicant\nAP002', 'input'), n('data', 'Profile · skill gap\n· market', 'tool'), n('gen', 'Generator', 'llm'),
        n('val', 'Validator\n(rules)', 'gate'), n('judge', 'LLM judge', 'llm'), n('out', 'Accepted plan', 'output')],
      edges: [['in', 'data'], ['data', 'gen'], ['gen', 'val'], ['val', 'judge', 'valid'], ['val', 'gen', 'fix', 'loop'], ['judge', 'gen', 'FAIL', 'loop'], ['judge', 'out', 'PASS']],
    },
    async run(ctx) {
      ctx.node('in', 'done'); ctx.take('in', 'data')
      const prof = ctx.tool('data', C, 'getApplicantProfile', 'AP002')
      const gap = ctx.tool('data', C, 'analyseSkillGap', 'AP002')
      const mkt = ctx.tool('data', C, 'fetchJobMarketInsights', gap.targetRole)
      ctx.node('data', 'done'); ctx.take('data', 'gen')
      const facts = `APPLICANT: ${prof.name}, ${prof.currentRole}. Skills: ${prof.skills.join(', ')}.\nTARGET ROLE: UX designer. Gaps: ${gap.gaps.join(', ')}.\nCertifications available: ${gap.certifications.join('; ')}.\nEstimated months: ${gap.estimatedMonths}.\nMarket: entry barrier ${mkt.entryBarrier}; top skills ${mkt.topSkills.join(', ')}.`
      let critique = '', draft = null, raw = '', verdict = 'FAIL', round = 0
      for (round = 1; round <= 3; round++) {
        ctx.log('step', `Round ${round}: generate${critique ? ' with feedback' : ''}`)
        raw = await ctx.llm({
          node: 'gen', label: `Generator r${round}`, maxTokens: 220, temperature: 0.3,
          system: 'You are a career coach. Output ONLY a JSON object, no other text.',
          user: `${facts}\n\nWrite a learning plan for ${prof.name} as JSON exactly like:\n{"steps":["step 1","step 2","step 3"],"certification":"one certification from the list","months":4}\nUse 3 to 5 concrete steps. One step must be about building a portfolio.${critique ? `\n\nA reviewer rejected your last draft. Fix these problems:\n${critique}` : ''}`,
        })
        ctx.node('gen', 'done', `draft ${round}`); ctx.take('gen', 'val')
        draft = firstJSON(raw, 'object')
        const errs = []
        if (!draft) errs.push('Output was not a JSON object.')
        else {
          if (!Array.isArray(draft.steps) || draft.steps.length < 3) errs.push('"steps" must be an array of at least 3 steps.')
          if (!gap.certifications.some(c => String(draft.certification || '').toLowerCase().includes(c.toLowerCase().split(' ').slice(0, 2).join(' ')))) errs.push(`"certification" must be one of: ${gap.certifications.join('; ')}.`)
          const mo = Number(draft.months)
          if (!(mo >= 1 && mo <= gap.estimatedMonths + 2)) errs.push(`"months" must be a number between 1 and ${gap.estimatedMonths + 2} (skill-gap estimate is ${gap.estimatedMonths}).`)
          if (!/portfolio/i.test(JSON.stringify(draft.steps || ''))) errs.push('One step must mention building a portfolio (the market is portfolio-driven).')
        }
        if (!ctx.gate('val', !errs.length, errs.length ? `Validator: ${errs.join(' ')}` : 'Validator: schema + facts OK')) {
          ctx.take('val', 'gen', true); critique = errs.map(e => '- ' + e).join('\n'); continue
        }
        ctx.take('val', 'judge')
        const j = await ctx.llm({
          node: 'judge', label: `Judge r${round}`, maxTokens: 80, temperature: 0,
          system: 'You are a strict reviewer of career plans.',
          user: `${facts}\n\nPLAN:\n${JSON.stringify(draft)}\n\nIs this plan realistic and specific for this person? Reply with PASS or FAIL on the first line, then one sentence explaining why.`,
        })
        verdict = pickLabel(j, ['PASS', 'FAIL']) || 'FAIL'
        ctx.node('judge', verdict === 'PASS' ? 'pass' : 'fail', verdict)
        if (verdict === 'PASS') { ctx.take('judge', 'out'); break }
        ctx.take('judge', 'gen', true)
        critique = '- ' + short(j.replace(/^\s*FAIL\W*/i, ''), 240)
      }
      const accepted = verdict === 'PASS'
      ctx.node('out', accepted ? 'done' : 'fail')
      const body = draft ? ul((draft.steps || []).map(s => esc(typeof s === 'string' ? s : JSON.stringify(s)))) + kv('Certification', draft.certification || '—') + kv('Months', draft.months ?? '—') : p(raw)
      ctx.result(accepted ? `Accepted on round ${Math.min(round, 3)}` : 'Not accepted after 3 rounds — best draft shown', body, accepted ? 'ok' : 'warn')
      return accepted ? `PASS in ${Math.min(round, 3)} round(s)` : 'No pass in 3 rounds'
    },
  },

  // ─────────────────────────────────────────────────────────── 2 · workflows
  {
    id: 'chain', group: 'workflow', name: 'Prompt chaining',
    control: 'Fixed / predefined', bestUse: 'Document processing', tradeoff: 'Inflexible on edge cases',
    usecase: `${D.icon} Drug discovery · ${D.scenarios.C.title}`,
    explain: 'A fixed 3-step pipeline — extract signals → classify risk → write memo. Each step sees <b>only the previous step\'s output</b>, and a programmatic gate checks it before the next step runs (one retry per step).',
    graph: {
      nodes: [n('in', 'Compound\nQT-9901', 'input'), n('data', 'Profile + tox\nrecords', 'tool'), n('s1', '1 · Extract\nsafety signals', 'llm'), n('g1', 'Gate 1', 'gate'),
        n('s2', '2 · Classify\nrisk', 'llm'), n('g2', 'Gate 2', 'gate'), n('s3', '3 · Go/no-go\nmemo', 'llm'), n('g3', 'Gate 3', 'gate'), n('out', 'Memo', 'output')],
      edges: [['in', 'data'], ['data', 's1'], ['s1', 'g1'], ['g1', 's1', 'retry', 'loop'], ['g1', 's2'], ['s2', 'g2'], ['g2', 's2', 'retry', 'loop'], ['g2', 's3'], ['s3', 'g3'], ['g3', 's3', 'retry', 'loop'], ['g3', 'out']],
    },
    async run(ctx) {
      ctx.node('in', 'done'); ctx.take('in', 'data')
      const prof = ctx.tool('data', D, 'getCompoundProfile', 'COMP003')
      const tox = ctx.tool('data', D, 'assessToxicologyProfile', 'COMP003')
      ctx.node('data', 'done'); ctx.take('data', 's1')
      async function step(node, gate, label, build, check, why) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          const out = await ctx.llm({ node, label: `${label}${attempt > 1 ? ' (retry)' : ''}`, ...build(attempt) })
          ctx.take(node, gate)
          if (ctx.gate(gate, check(out), `${label}: ${why}`)) return out
          if (attempt === 1) ctx.take(gate, node, true)
        }
        throw new Error(`${label} failed its gate twice — chain stopped`)
      }
      const signals = await step('s1', 'g1', 'Step 1', (a) => ({
        maxTokens: 160, system: 'You extract facts. Never invent data.',
        user: `COMPOUND: ${compact(prof)}\nTOXICOLOGY: ${compact(tox)}\n\nList the safety signals of concern as short bullet lines (one per line). Include the hepatotoxicity score and the hERG value.${a > 1 ? ' You MUST mention hepatotoxicity and hERG explicitly.' : ''}`,
      }), o => has(o, /hepat/i, /herg/i), 'must mention hepatotoxicity AND hERG')
      ctx.take('g1', 's2')
      let label = null
      await step('s2', 'g2', 'Step 2', (a) => ({
        maxTokens: 12, temperature: 0,
        system: 'You classify risk. Reply with one word.',
        user: `SAFETY SIGNALS:\n${signals}\n\nClassify the overall safety risk. Reply with exactly one word: HIGH, MEDIUM or LOW.`,
      }), o => !!(label = pickLabel(o, ['HIGH', 'MEDIUM', 'LOW'])), 'reply must be exactly HIGH, MEDIUM or LOW')
      ctx.node('s2', 'done', label); ctx.take('g2', 's3')
      const memo = await step('s3', 'g3', 'Step 3', (a) => ({
        maxTokens: 170, system: 'You write brief memos for a drug project team.',
        user: `Compound: QT-9901\nRisk level: ${label}\nSafety signals:\n${signals}\n\nWrite a 3-sentence go/no-go memo for QT-9901. Start with "Decision:".${a > 1 ? ' You MUST name QT-9901 and start with "Decision:".' : ''}`,
      }), o => has(o, 'QT-9901', /decision/i), 'memo must name QT-9901 and state a Decision')
      ctx.take('g3', 'out'); ctx.node('out', 'done')
      ctx.result(`Chain complete · risk ${label}`, `<div class="chain-steps">${kv('1 · Signals', '')}${p(signals)}${kv('2 · Risk', label)}${kv('3 · Memo', '')}${p(memo)}</div>`)
      return `3/3 gates · risk ${label}`
    },
  },
  {
    id: 'routing', group: 'workflow', name: 'Routing',
    control: 'Conditional / triage', bestUse: 'Multi-domain assistants', tradeoff: 'A misroute ruins everything after it',
    usecase: '🔀 Your request → one of 4 specialists',
    input: {
      label: 'Request to route', samples: [
        'Patient P004 is on warfarin and wants something for a tension headache — what is safe?',
        'Claim CLM004: chipped tooth, the claimant wants cosmetic restoration covered. Will the policy pay?',
        'Applicant AP003 is a biology teacher moving into corporate training. What should they learn first?',
        'Is compound COMP004 ready for an IND filing, given its hERG result?',
      ],
    },
    explain: 'A triage call classifies the request; code then routes it to <b>one</b> specialist prompt that only gets its own domain\'s tools. Type your own request — the route is the model\'s real decision. A consistency check flags a misroute when the request names an ID from another domain.',
    graph: {
      nodes: [n('in', 'Request', 'input'), n('router', 'Triage router', 'llm'), n('healthcare', '🏥 Clinical\nspecialist', 'agent'), n('insurance', '🛡️ Claims\nspecialist', 'agent'),
        n('career', '🎓 Career\nspecialist', 'agent'), n('drugDiscovery', '🧪 Drug R&D\nspecialist', 'agent'), n('human', 'Unclassified\n→ human queue', 'human'), n('out', 'Answer', 'output')],
      edges: [['in', 'router'], ['router', 'healthcare', 'HEALTHCARE'], ['router', 'insurance', 'INSURANCE'], ['router', 'career', 'CAREER'], ['router', 'drugDiscovery', 'DRUG'], ['router', 'human', '?'],
        ['healthcare', 'out'], ['insurance', 'out'], ['career', 'out'], ['drugDiscovery', 'out']],
    },
    async run(ctx, input) {
      const req = (input || this.input.samples[0]).trim()
      ctx.node('in', 'done', short(req, 40)); ctx.take('in', 'router')
      ctx.log('note', `Request: ${req}`)
      const raw = await ctx.llm({
        node: 'router', label: 'Router', maxTokens: 8, temperature: 0,
        system: 'You are a triage router. Reply with one category name only.',
        user: `Categories:\nHEALTHCARE = patients, medicines, symptoms\nINSURANCE = insurance claims, policies, coverage\nCAREER = jobs, skills, career changes, training\nDRUG = drug compounds, toxicology, IND filings\n\nRequest: "${req}"\n\nCategory:`,
      })
      const map = { HEALTHCARE: 'healthcare', INSURANCE: 'insurance', CAREER: 'career', DRUG: 'drugDiscovery' }
      const lab = pickLabel(raw.replace(/DRUG[_ ]DISCOVERY/i, 'DRUG'), Object.keys(map))
      if (!lab) {
        ctx.node('router', 'fail', 'unparseable'); ctx.take('router', 'human', true); ctx.node('human', 'waiting')
        ctx.result('Sent to the human queue', p(`The router replied "${short(raw, 60)}", which is not a known category — routing it anywhere would be a guess.`), 'warn')
        return 'Unclassified → human'
      }
      const dom = map[lab], domain = DOMAINS[dom]
      ctx.node('router', 'done', lab); ctx.take('router', dom); ctx.log('route', `Router chose ${lab} → ${domain.name} specialist`)
      // which domain the IDs in the request belong to — a cheap misroute detector
      const idDomain = /\bP00\d\b/.test(req) ? 'healthcare' : /\bCLM00\d\b/.test(req) ? 'insurance' : /\bAP00\d\b/.test(req) ? 'career' : /\bCOMP00\d\b/.test(req) ? 'drugDiscovery' : null
      if (idDomain && idDomain !== dom) ctx.log('warn', `Consistency check: request names a ${DOMAINS[idDomain].name} record but was routed to ${domain.name} — likely misroute.`)
      // specialist: its own domain's lookup only
      let data = {}
      const id = (req.match(/\b(P00\d|CLM00\d|AP00\d|COMP00\d)\b/) || [])[1]
      if (id) {
        if (dom === 'healthcare' && id.startsWith('P')) data.patient = ctx.tool(dom, H, 'fetchPatientVitals', id)
        if (dom === 'insurance' && id.startsWith('CLM')) { data.claim = ctx.tool(dom, I, 'getClaimDetails', id); if (!data.claim.error) data.policy = ctx.tool(dom, I, 'checkPolicyCoverage', data.claim.policyId) }
        if (dom === 'career' && id.startsWith('AP')) { data.profile = ctx.tool(dom, C, 'getApplicantProfile', id); data.gap = ctx.tool(dom, C, 'analyseSkillGap', id) }
        if (dom === 'drugDiscovery' && id.startsWith('COMP')) { data.compound = ctx.tool(dom, D, 'getCompoundProfile', id); data.tox = ctx.tool(dom, D, 'assessToxicologyProfile', id) }
      }
      const answer = await ctx.llm({
        node: dom, label: `${domain.name} specialist`, maxTokens: 170,
        system: `You are a ${domain.name} specialist. Answer only from the data given; if data is missing, say what you would need.`,
        user: `Request: ${req}\n\nDATA:\n${Object.keys(data).length ? compact(data) : 'none found for this request'}\n\nAnswer in 3 short bullet points.`,
      })
      ctx.take(dom, 'out'); ctx.node('out', 'done')
      ctx.result(`Routed to ${domain.icon} ${domain.name}`, p(answer) + kv('Router output', short(raw, 40)) + (idDomain && idDomain !== dom ? kv('Misroute', `request names a ${DOMAINS[idDomain].name} record`) : ''), idDomain && idDomain !== dom ? 'warn' : 'ok')
      return `→ ${domain.name}${idDomain && idDomain !== dom ? ' (misroute)' : ''}`
    },
  },
  {
    id: 'sectioning', group: 'workflow', name: 'Parallel · sectioning',
    control: 'Fan-out / fan-in', bestUse: 'Independent sub-analyses', tradeoff: 'Aggregator must reconcile',
    usecase: `${I.icon} Insurance · ${I.scenarios.C.title}`,
    explain: 'The claim is split into three <b>independent</b> sections — coverage, fraud, valuation. Each worker sees only its slice and they are dispatched at once; an aggregator merges the findings. A final check confirms the payout is capped at the policy limit.',
    graph: {
      nodes: [n('in', 'Claim CLM003', 'input'), n('split', 'Split into\nsections', 'tool'), n('w1', 'Coverage\nanalyst', 'llm'), n('w2', 'Fraud\nanalyst', 'llm'), n('w3', 'Valuation\nanalyst', 'llm'),
        n('agg', 'Aggregator', 'llm'), n('chk', 'Limit check', 'gate'), n('out', 'Decision', 'output')],
      edges: [['in', 'split'], ['split', 'w1'], ['split', 'w2'], ['split', 'w3'], ['w1', 'agg'], ['w2', 'agg'], ['w3', 'agg'], ['agg', 'chk'], ['chk', 'out']],
    },
    async run(ctx) {
      ctx.node('in', 'done'); ctx.take('in', 'split')
      const claim = ctx.tool('split', I, 'getClaimDetails', 'CLM003')
      const policy = ctx.tool('split', I, 'checkPolicyCoverage', claim.policyId)
      const fraud = ctx.tool('split', I, 'assessFraudRisk', 'CLM003')
      ctx.node('split', 'done', '3 sections')
      const sys = 'You are one analyst on a claims team. Look only at your section. Two sentences max.'
      ctx.log('step', 'Fan-out: dispatching 3 workers concurrently (one WebGPU engine → queued)')
      ;['w1', 'w2', 'w3'].forEach(w => ctx.take('split', w))
      const [cov, fr, val] = await Promise.all([
        ctx.llm({ node: 'w1', label: 'Coverage analyst', maxTokens: 90, system: sys, user: `SECTION: coverage.\nPolicy: ${compact(policy)}\nClaim type: ${claim.type}. Is this loss covered, and what are the limit and deductible?` }),
        ctx.llm({ node: 'w2', label: 'Fraud analyst', maxTokens: 90, system: sys, user: `SECTION: fraud.\nFraud assessment: ${compact(fraud)}\nIncident flags: ${claim.incidentFlags.join('; ')}\nIs there a fraud concern that should block payment?` }),
        ctx.llm({ node: 'w3', label: 'Valuation analyst', maxTokens: 90, system: sys, user: `SECTION: valuation.\nClaimed amount: ${money(claim.amount)}. Collision limit: ${money(policy.collisionLimit)}. Deductible: ${money(policy.deductible)}.\nWhat is the maximum payable amount and the shortfall the claimant covers?` }),
      ])
      ;['w1', 'w2', 'w3'].forEach(w => ctx.take(w, 'agg'))
      const agg = await ctx.llm({
        node: 'agg', label: 'Aggregator', maxTokens: 150,
        system: 'You merge analyst findings into one claim decision.',
        user: `COVERAGE: ${cov}\nFRAUD: ${fr}\nVALUATION: ${val}\n\nWrite the final decision in 3 lines: decision, payable amount, what the claimant is told.`,
      })
      ctx.take('agg', 'chk')
      const capped = amountIn(agg, policy.collisionLimit) || amountIn(agg, policy.collisionLimit - policy.deductible)
      const ok = ctx.gate('chk', capped, `Payout must be capped at the ${money(policy.collisionLimit)} limit (claim is ${money(claim.amount)})`)
      ctx.take('chk', 'out', !ok); ctx.node('out', 'done')
      ctx.result('Aggregated decision', p(agg) + `<details><summary>Section findings</summary>${kv('Coverage', '')}${p(cov)}${kv('Fraud', '')}${p(fr)}${kv('Valuation', '')}${p(val)}</details>`, ok ? 'ok' : 'warn')
      return ok ? 'Capped at limit ✓' : 'Limit not applied'
    },
  },
  {
    id: 'voting', group: 'workflow', name: 'Parallel · voting',
    control: 'Fan-out / consensus', bestUse: 'Safety-critical yes/no calls', tradeoff: 'N× the cost of one answer',
    usecase: `${H.icon} Healthcare · ${H.scenarios.D.title}`,
    explain: 'The same question is asked <b>5 times at different temperatures</b>. The votes are tallied, and the consensus is then checked against the drug-interaction database — so you can see whether voting caught the error a single sample might make.',
    graph: {
      nodes: [n('in', 'Patient P004\naspirin?', 'input'), n('rec', 'Patient record', 'tool'), n('v1', 'Voter\nT=0.2', 'llm'), n('v2', 'Voter\nT=0.6', 'llm'), n('v3', 'Voter\nT=0.9', 'llm'), n('v4', 'Voter\nT=1.1', 'llm'), n('v5', 'Voter\nT=1.3', 'llm'),
        n('tally', 'Majority\nvote', 'rule'), n('db', 'Interaction DB\nground truth', 'tool'), n('out', 'Consensus', 'output')],
      edges: [['in', 'rec'], ['rec', 'v1'], ['rec', 'v2'], ['rec', 'v3'], ['rec', 'v4'], ['rec', 'v5'], ['v1', 'tally'], ['v2', 'tally'], ['v3', 'tally'], ['v4', 'tally'], ['v5', 'tally'], ['tally', 'db'], ['db', 'out']],
    },
    async run(ctx) {
      ctx.node('in', 'done'); ctx.take('in', 'rec')
      const pt = ctx.tool('rec', H, 'fetchPatientVitals', 'P004')
      const temps = [0.2, 0.6, 0.9, 1.1, 1.3]
      const q = `Patient: ${pt.name}, ${pt.age}y. Conditions: ${pt.conditions.join(', ')}. Current medications: ${pt.currentMedications.join(', ')}. Notes: ${pt.notes}\nRequest: aspirin for a tension headache.\n\nIs giving aspirin to this patient SAFE or UNSAFE? Reply with the single word SAFE or UNSAFE, then one short reason.`
      ctx.log('step', 'Fan-out: 5 identical prompts at 5 temperatures')
      temps.forEach((_, i) => ctx.take('rec', `v${i + 1}`))
      const replies = await Promise.all(temps.map((t, i) => ctx.llm({ node: `v${i + 1}`, label: `Voter ${i + 1} (T=${t})`, maxTokens: 40, temperature: t, system: 'You are a careful clinical pharmacist.', user: q })))
      const votes = replies.map((r, i) => {
        const v = pickLabel(r, ['UNSAFE', 'SAFE']) || 'ABSTAIN'
        ctx.node(`v${i + 1}`, v === 'UNSAFE' ? 'pass' : v === 'SAFE' ? 'fail' : 'done', v); ctx.take(`v${i + 1}`, 'tally')
        return v
      })
      const tally = votes.reduce((a, v) => (a[v] = (a[v] || 0) + 1, a), {})
      const consensus = (tally.UNSAFE || 0) > (tally.SAFE || 0) ? 'UNSAFE' : (tally.SAFE || 0) > (tally.UNSAFE || 0) ? 'SAFE' : 'TIE'
      const agree = Math.max(tally.UNSAFE || 0, tally.SAFE || 0) / votes.length
      ctx.node('tally', 'done', `${consensus} ${Math.round(agree * 100)}%`); ctx.log('rule', `Tally: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' · ')} → ${consensus}`)
      ctx.take('tally', 'db')
      const ix = ctx.tool('db', H, 'checkDrugInteraction', 'Warfarin', 'Aspirin')
      const truth = ix.severity === 'HIGH' || ix.severity === 'CRITICAL' ? 'UNSAFE' : 'SAFE'
      const right = consensus === truth
      ctx.gate('db', right, `Interaction DB says ${ix.severity}: ${ix.risk} → ground truth ${truth}; consensus ${right ? 'matches' : 'does NOT match'}`)
      const singleWrong = votes.filter(v => v !== truth).length
      ctx.take('db', 'out', !right); ctx.node('out', 'done')
      ctx.result(`Consensus ${consensus} · ${Math.round(agree * 100)}% agreement`,
        ul(replies.map((r, i) => `<b>T=${temps[i]} · ${votes[i]}</b> — ${esc(short(r, 140))}`)) + kv('Ground truth', `${truth} (${ix.severity})`) + kv('Individual voters wrong', `${singleWrong} of 5`), right ? 'ok' : 'warn')
      return { text: `${consensus} (${Math.round(agree * 100)}%) · ${singleWrong}/5 voters wrong`, ok: right }
    },
  },

  // ─────────────────────────────────────────────────────────── 3 · multi-agent
  {
    id: 'orchestrator', group: 'multi', name: 'Orchestrator-Workers',
    control: 'Dynamic / centralized', bestUse: 'Open-ended research', tradeoff: 'Orchestration overhead',
    usecase: `${D.icon} Drug discovery · IND brief for DM-3350`,
    explain: 'The orchestrator <b>plans at runtime</b>: it picks which specialist workers to use and what to ask each. Worker nodes appear in the graph only after the model has decided on them. A synthesizer merges their findings into a brief.',
    graph: {
      nodes: [n('in', 'Prepare IND brief\nDM-3350', 'input'), n('orch', 'Orchestrator\n(plans)', 'llm'), n('synth', 'Synthesizer', 'llm'), n('out', 'IND brief', 'output')],
      edges: [['in', 'orch'], ['synth', 'out']],
    },
    async run(ctx) {
      const WORKERS = {
        chemist: { label: '🧪 Chemist', desc: 'reviews potency, selectivity and solubility', run: () => ({ compound: ctx.tool('w_chemist', D, 'getCompoundProfile', 'COMP004') }) },
        toxicologist: { label: '☠️ Toxicologist', desc: 'reviews toxicology and cardiac safety', run: () => ({ tox: ctx.tool('w_toxicologist', D, 'assessToxicologyProfile', 'COMP004') }) },
        regulatory: { label: '📜 Regulatory', desc: 'reviews the regulatory pathway and timeline', run: () => ({ pathway: ctx.tool('w_regulatory', D, 'checkRegulatoryPathway', 'Fragile X') }) },
        clinical: { label: '🩺 Clinical', desc: 'drafts first-in-human study considerations', run: () => ({ compound: D.toolFns.getCompoundProfile('COMP004') }) },
      }
      ctx.node('in', 'done'); ctx.take('in', 'orch')
      const ask = 'Prepare an IND-readiness brief for DM-3350, a first-in-class mGluR5 NAM for Fragile X syndrome.'
      let plan = null, raw = ''
      for (let a = 1; a <= 2 && !plan?.length; a++) {
        raw = await ctx.llm({
          node: 'orch', label: `Orchestrator plan${a > 1 ? ' (retry)' : ''}`, maxTokens: 200, temperature: 0.2,
          system: 'You are a project lead who delegates work. Output ONLY JSON.',
          user: `Task: ${ask}\n\nAvailable workers:\n${Object.entries(WORKERS).map(([k, w]) => `- ${k}: ${w.desc}`).join('\n')}\n\nChoose 2 to 4 workers and give each one a specific subtask. Output ONLY a JSON array like:\n[{"worker":"toxicologist","task":"..."}]`,
        })
        const arr = firstJSON(raw, 'array')
        plan = (Array.isArray(arr) ? arr : []).filter(s => s && WORKERS[String(s.worker || '').toLowerCase().trim()])
          .map(s => ({ worker: String(s.worker).toLowerCase().trim(), task: String(s.task || WORKERS[String(s.worker).toLowerCase().trim()].desc) }))
          .filter((s, i, all) => all.findIndex(x => x.worker === s.worker) === i).slice(0, 4)
        if (!plan.length) ctx.log('warn', 'Orchestrator output had no valid worker assignments.')
      }
      if (!plan.length) {
        ctx.node('orch', 'fail', 'no plan')
        ctx.result('Orchestrator could not produce a plan', p(raw), 'bad')
        return 'No valid plan'
      }
      ctx.node('orch', 'done', `${plan.length} workers`)
      ctx.log('step', `Runtime plan: ${plan.map(s => s.worker).join(', ')}`)
      ctx.addNodes(plan.map(s => n(`w_${s.worker}`, `${WORKERS[s.worker].label}\n${short(s.task, 34)}`, 'agent')),
        plan.flatMap(s => [['orch', `w_${s.worker}`, 'delegate'], [`w_${s.worker}`, 'synth']]))
      plan.forEach(s => ctx.take('orch', `w_${s.worker}`))
      const findings = await Promise.all(plan.map(async s => {
        const data = WORKERS[s.worker].run()
        const out = await ctx.llm({
          node: `w_${s.worker}`, label: WORKERS[s.worker].label, maxTokens: 110,
          system: `You are the ${s.worker} on a drug development team. Use only the data given. Two or three sentences.`,
          user: `Subtask: ${s.task}\nDATA: ${compact(data)}`,
        })
        ctx.take(`w_${s.worker}`, 'synth')
        return { worker: s.worker, task: s.task, out }
      }))
      const brief = await ctx.llm({
        node: 'synth', label: 'Synthesizer', maxTokens: 200,
        system: 'You synthesize specialist findings into a short brief.',
        user: `Task: ${ask}\n\n${findings.map(f => `${f.worker.toUpperCase()}: ${f.out}`).join('\n\n')}\n\nWrite a 4-sentence IND-readiness brief. End with "Recommendation: GO", "Recommendation: CONDITIONAL" or "Recommendation: NO-GO".`,
      })
      const rec = pickLabel(brief, ['NO-GO', 'CONDITIONAL', 'GO']) || '—'
      ctx.node('synth', 'done', rec); ctx.node('out', 'done')
      ctx.result(`IND brief · ${rec}`, p(brief) + `<details><summary>Plan the orchestrator chose at runtime (${plan.length} workers)</summary>${ul(findings.map(f => `<b>${esc(f.worker)}</b> — <i>${esc(f.task)}</i><br>${esc(f.out)}`))}</details>`)
      return `${plan.length} workers · ${rec}`
    },
  },
  {
    id: 'hierarchical', group: 'multi', name: 'Hierarchical decomposition',
    control: 'Dynamic / layered', bestUse: 'Large multi-part goals', tradeoff: 'Deep chains add latency',
    usecase: `${I.icon} Insurance · triage today's claims queue`,
    explain: 'Three layers: an <b>executive</b> sets goals for two <b>managers</b>, each manager decomposes its goal into per-claim tasks for <b>executors</b> (which call real tools), and the executive makes the final call from the executors\' findings.',
    graph: {
      rankDir: 'TB',
      nodes: [n('in', 'Claims queue\nCLM001 · CLM003', 'input'), n('exec', 'Executive\n(goals)', 'llm'), n('mRisk', 'Risk manager', 'llm'), n('mCov', 'Coverage manager', 'llm'),
        n('final', 'Executive\n(decision)', 'llm'), n('out', 'Queue decisions', 'output')],
      edges: [['in', 'exec'], ['exec', 'mRisk', 'goal'], ['exec', 'mCov', 'goal'], ['final', 'out']],
    },
    async run(ctx) {
      const CLAIMS = ['CLM001', 'CLM003']
      ctx.node('in', 'done'); ctx.take('in', 'exec')
      const g = await ctx.llm({
        node: 'exec', label: 'Executive', maxTokens: 120,
        system: 'You head a claims desk. Output ONLY JSON.',
        user: `Today's queue: CLM001 (auto collision, $8,500) and CLM003 (vehicle total loss, $67,000).\nWrite one goal for your Risk manager and one for your Coverage manager as JSON: {"risk":"...","coverage":"..."}`,
      })
      const goals = firstJSON(g, 'object') || {}
      const goalRisk = String(goals.risk || 'Find fraud risk on each claim'), goalCov = String(goals.coverage || 'Check limits and exclusions on each claim')
      if (!goals.risk || !goals.coverage) ctx.log('warn', 'Executive did not return both goals as JSON — using its text as the goal where possible.')
      ctx.take('exec', 'mRisk'); ctx.take('exec', 'mCov')
      async function manager(id, role, goal) {
        const raw = await ctx.llm({
          node: id, label: `${role} manager`, maxTokens: 140,
          system: `You are the ${role} manager. Break your goal into one task per claim. Output ONLY a JSON array.`,
          user: `Goal: ${goal}\nClaims: ${CLAIMS.join(', ')}\nOutput: [{"claim":"CLM001","task":"..."},{"claim":"CLM003","task":"..."}]`,
        })
        let tasks = (firstJSON(raw, 'array') || []).filter(t => CLAIMS.includes(String(t?.claim || '').toUpperCase().trim()))
        if (!tasks.length) { ctx.log('warn', `${role} manager returned no valid tasks — assigning one review per claim.`); tasks = CLAIMS.map(c => ({ claim: c, task: goal })) }
        tasks = tasks.map(t => ({ claim: String(t.claim).toUpperCase().trim(), task: String(t.task || goal) })).filter((t, i, a) => a.findIndex(x => x.claim === t.claim) === i)
        ctx.node(id, 'done', `${tasks.length} tasks`)
        return tasks
      }
      const [riskTasks, covTasks] = await Promise.all([manager('mRisk', 'Risk', goalRisk), manager('mCov', 'Coverage', goalCov)])
      const exNodes = [...riskTasks.map(t => ({ ...t, id: `xR_${t.claim}`, mgr: 'mRisk', kind: 'risk' })), ...covTasks.map(t => ({ ...t, id: `xC_${t.claim}`, mgr: 'mCov', kind: 'coverage' }))]
      ctx.addNodes(exNodes.map(x => n(x.id, `${x.kind === 'risk' ? '🔎' : '📄'} Executor\n${x.claim}`, 'tool')), exNodes.flatMap(x => [[x.mgr, x.id], [x.id, 'final']]))
      exNodes.forEach(x => ctx.take(x.mgr, x.id))
      const results = await Promise.all(exNodes.map(async x => {
        const data = x.kind === 'risk' ? { fraud: ctx.tool(x.id, I, 'assessFraudRisk', x.claim) }
          : (() => { const c = ctx.tool(x.id, I, 'getClaimDetails', x.claim); return { claim: c, policy: ctx.tool(x.id, I, 'checkPolicyCoverage', c.policyId) } })()
        const out = await ctx.llm({ node: x.id, label: `Executor ${x.kind} ${x.claim}`, maxTokens: 70, system: 'You are an executor. One sentence finding from the data only.', user: `Task: ${x.task}\nDATA: ${compact(data)}` })
        ctx.take(x.id, 'final')
        return { ...x, out }
      }))
      const dec = await ctx.llm({
        node: 'final', label: 'Executive decision', maxTokens: 160,
        system: 'You head a claims desk and make the final call.',
        user: `Findings from your teams:\n${results.map(r => `${r.claim} [${r.kind}]: ${r.out}`).join('\n')}\n\nFor each claim write one line: "<claim>: <PAY | PARTIAL PAY | REFER TO SIU> — reason".`,
      })
      ctx.take('final', 'out'); ctx.node('out', 'done')
      const siu = /CLM001[^\n]*SIU/i.test(dec)
      ctx.log(siu ? 'ok' : 'warn', siu ? 'CLM001 (fraud score 0.72) referred to SIU' : 'CLM001 has fraud score 0.72 but was not referred to SIU')
      ctx.result('Executive decisions', p(dec) + `<details><summary>${results.length} executor findings</summary>${ul(results.map(r => `<b>${r.claim} · ${r.kind}</b> — ${esc(r.out)}`))}</details>`, siu ? 'ok' : 'warn')
      return `${results.length} executors · ${siu ? 'SIU ✓' : 'SIU missed'}`
    },
  },
  {
    id: 'swarm', group: 'multi', name: 'Swarm / handoff',
    control: 'Dynamic / decentralized', bestUse: 'Conversations across departments', tradeoff: 'Hard to trace global state',
    usecase: '🔁 One customer message spanning claims + clinical',
    explain: 'No supervisor. Each agent answers what it owns, then <b>decides itself</b> who to hand off to, passing a validated state object (what is answered, what is still open). The run stops when an agent hands off to <code>none</code> or after 5 hops.',
    graph: {
      nodes: [n('in', 'Customer\nmessage', 'input'), n('triage', 'Triage\nagent', 'agent'), n('claims', 'Claims\nagent', 'agent'), n('clinical', 'Clinical\nagent', 'agent'), n('career', 'Career\nagent', 'agent'), n('out', 'Reply to\ncustomer', 'output')],
      edges: [['in', 'triage'], ['triage', 'claims', 'handoff'], ['triage', 'clinical', 'handoff'], ['triage', 'career', 'handoff'], ['claims', 'clinical', 'handoff'], ['clinical', 'claims', 'handoff'],
        ['claims', 'career', 'handoff'], ['clinical', 'career', 'handoff'], ['career', 'claims', 'handoff'], ['career', 'clinical', 'handoff'],
        ['claims', 'out', 'none'], ['clinical', 'out', 'none'], ['career', 'out', 'none']],
    },
    async run(ctx) {
      const msg = "Hi, I'm patient P002 and I filed claim CLM004 after chipping my tooth playing hockey. Will my policy cover the cosmetic fix? And which painkiller is safe for me?"
      ctx.node('in', 'done'); ctx.take('in', 'triage'); ctx.log('note', `Customer: ${msg}`)
      const AGENTS = {
        triage: { owns: 'nothing — only decides who should speak first', data: () => ({}) },
        claims: { owns: 'insurance claims and policy coverage', data: () => { const c = ctx.tool('claims', I, 'getClaimDetails', 'CLM004'); return { claim: c, policy: ctx.tool('claims', I, 'checkPolicyCoverage', c.policyId) } } },
        clinical: { owns: 'medicines and patient safety', data: () => ({ patient: ctx.tool('clinical', H, 'fetchPatientVitals', 'P002'), ibuprofen: ctx.tool('clinical', H, 'calculateDosage', 'ibuprofen', 82), acetaminophen: ctx.tool('clinical', H, 'calculateDosage', 'acetaminophen', 82), alcohol: ctx.tool('clinical', H, 'checkDrugInteraction', 'Metformin', 'Alcohol') }) },
        career: { owns: 'jobs and career changes', data: () => ({}) },
      }
      const state = { open: ['coverage question', 'painkiller question'], answered: [], replies: [] }
      let cur = 'triage', prev = 'in'
      for (let hop = 1; hop <= 5; hop++) {
        const a = AGENTS[cur]
        ctx.node(cur, 'running', `hop ${hop}`)
        const data = a.data()
        const peers = Object.keys(AGENTS).filter(k => k !== cur && k !== 'triage')
        const raw = await ctx.llm({
          node: cur, label: `${cur} agent (hop ${hop})`, maxTokens: 150,
          system: `You are the ${cur} agent. You own: ${a.owns}. Only answer questions you own, using only your data.`,
          user: `Customer message: "${msg}"\nShared state: ${JSON.stringify({ open: state.open, answered: state.answered })}\nYour data: ${Object.keys(data).length ? compact(data) : 'none'}\n\nReply in exactly this format:\nREPLY: <your answer to the part you own, or "-" if none>\nANSWERED: <which open question you answered, or "-">\nHANDOFF: <one of ${peers.join(', ')}, none>`,
        })
        const reply = (raw.match(/REPLY:\s*([\s\S]*?)(?:\n\s*ANSWERED:|\n\s*HANDOFF:|$)/i) || [])[1]?.trim() || ''
        const answered = (raw.match(/ANSWERED:\s*(.*)/i) || [])[1] || ''
        let next = pickLabel((raw.match(/HANDOFF:\s*(.*)/i) || [])[1] || '', [...peers, 'none']) || 'none'
        // validate the state transfer: only mark a question answered if this agent actually replied
        if (cur !== 'triage' && reply && reply !== '-') {
          const q = state.open.find(o => answered.toLowerCase().includes(o.split(' ')[0])) || (cur === 'claims' ? 'coverage question' : cur === 'clinical' ? 'painkiller question' : null)
          if (q && state.open.includes(q)) { state.open = state.open.filter(o => o !== q); state.answered.push(q) }
          state.replies.push({ agent: cur, reply })
        }
        if (cur === 'triage' && next === 'none') { ctx.log('warn', 'Triage handed off to nobody — defaulting to the claims agent.'); next = 'claims' }
        if (state.open.length === 0 && next !== 'none') { ctx.log('note', `State says every question is answered — ending instead of handing off to ${next}.`); next = 'none' }
        ctx.node(cur, 'done', next === 'none' ? 'done' : `→ ${next}`)
        ctx.log('handoff', `${cur} → ${next} · state: answered [${state.answered.join(', ')}] open [${state.open.join(', ')}]`)
        if (next === 'none' && state.open.length && cur !== 'triage') {
          const owner = state.open[0].startsWith('coverage') ? 'claims' : 'clinical'
          if (owner !== cur) { ctx.log('warn', `State check: "${state.open[0]}" still open — handoff overridden to ${owner}.`); next = owner }
        }
        if (next === 'none') { ctx.take(cur, 'out'); break }
        ctx.take(cur, next); prev = cur; cur = next
      }
      ctx.node('out', 'done')
      const solved = state.open.length === 0
      ctx.result(solved ? 'Both questions answered via handoffs' : `Open: ${state.open.join(', ')}`,
        ul(state.replies.map(r => `<b>${esc(r.agent)}</b> — ${esc(r.reply)}`)) + kv('Handoff path', [...new Set(state.replies.map(r => r.agent))].join(' → ') || '—'), solved ? 'ok' : 'warn')
      return solved ? `Solved · ${state.replies.length} agents` : `${state.open.length} open`
    },
  },

  // ─────────────────────────────────────────────────────────── 4 · governance
  {
    id: 'hitl', group: 'gov', name: 'Human-in-the-loop',
    control: 'Pause on high-stakes action', bestUse: 'External or irreversible actions', tradeoff: 'Human latency',
    usecase: `${I.icon} Insurance · ${I.scenarios.A.title}`,
    explain: 'The agent works autonomously until a <b>high-stakes action</b> — sending a letter to the claimant. There it stops and waits for you. Reject it with feedback and the feedback is saved to memory and drives a redraft; approve it and it goes to the outbox.',
    graph: {
      nodes: [n('in', 'Claim CLM001', 'input'), n('data', 'Claim + fraud\ntools', 'tool'), n('draft', 'Draft letter', 'llm'), n('policy', 'Policy pre-check', 'gate'), n('human', 'Human approval', 'human'),
        n('mem', 'Save feedback\nto memory', 'tool'), n('send', 'Outbox\n(sent)', 'output')],
      edges: [['in', 'data'], ['data', 'draft'], ['draft', 'policy'], ['policy', 'human'], ['human', 'send', 'approve'], ['human', 'mem', 'reject'], ['mem', 'draft', 'redraft', 'loop']],
    },
    async run(ctx) {
      ctx.node('in', 'done'); ctx.take('in', 'data')
      const claim = ctx.tool('data', I, 'getClaimDetails', 'CLM001')
      const fraud = ctx.tool('data', I, 'assessFraudRisk', 'CLM001')
      ctx.node('data', 'done'); ctx.take('data', 'draft')
      let feedback = retrieveRelevantMemories('claimant letter fraud investigation status', 'insurance').map(m => m.text)
      if (feedback.length) ctx.log('note', `Memory: ${feedback.length} past correction(s) loaded into the prompt`)
      for (let round = 1; round <= 3; round++) {
        const letter = await ctx.llm({
          node: 'draft', label: `Draft letter r${round}`, maxTokens: 190, temperature: 0.3,
          system: 'You write short, polite emails to insurance claimants.',
          user: `Claim: ${compact({ id: claim.id, type: claim.type, amount: claim.amount, flags: claim.incidentFlags })}\nInternal fraud review: score ${fraud.score} (${fraud.riskLevel}).\n\nWrite a 4-sentence email to the claimant about the status of claim ${claim.id}. Do not promise payment and do not accuse them of fraud. Ask for the police report and medical records.${feedback.length ? `\n\nReviewer feedback you must follow:\n${feedback.map(f => '- ' + f).join('\n')}` : ''}`,
        })
        ctx.take('draft', 'policy')
        const issues = []
        if (/\b(will be paid|approved|we will pay|payment (will|has))/i.test(letter)) issues.push('promises payment')
        if (/\bfraud/i.test(letter)) issues.push('mentions fraud to the claimant')
        ctx.gate('policy', !issues.length, issues.length ? `Pre-check flags: ${issues.join(', ')} — the human should look closely` : 'Pre-check: no payment promise, no fraud accusation')
        ctx.take('policy', 'human'); ctx.node('human', 'waiting', 'waiting for you')
        ctx.result(`Draft ${round} — waiting for your approval`, `<div class="letter">${p(letter)}</div>`, 'pending')
        ctx.log('human', 'Paused before the external action. Approve, or reject with feedback.')
        const d = await ctx.decide('Send this email to the claimant?', [
          { label: '✓ Approve & send', value: 'approve', cls: 'btn-approve' },
          { label: '✗ Reject with feedback', value: 'reject', cls: 'btn-reject' },
        ], { withText: true, placeholder: 'Feedback for the agent if you reject (saved to memory)…' })
        if (d.value === 'approve') {
          ctx.node('human', 'pass', 'approved'); ctx.take('human', 'send'); ctx.node('send', 'done')
          ctx.log('ok', `Approved by human on round ${round}. Email placed in the outbox (this demo never sends real email).`)
          ctx.result(`Approved & sent on round ${round}`, `<div class="letter">${p(letter)}</div>`)
          return `Approved r${round}`
        }
        const text = d.text || 'Be clearer about which documents are needed and by when.'
        ctx.node('human', 'fail', 'rejected'); ctx.take('human', 'mem', true)
        saveCorrection({ text: `Claimant letter: ${text}`, tags: ['claimant', 'letter', 'fraud', 'investigation', 'status'], scenario: 'patterns-hitl', domain: 'insurance' })
        ctx.node('mem', 'done', 'saved'); ctx.log('human', `Rejected: "${text}" → saved to memory`)
        ctx.take('mem', 'draft'); feedback = [...feedback, text]
      }
      ctx.result('Stopped after 3 rejected drafts', p('Nothing was sent.'), 'warn')
      return 'Rejected ×3'
    },
  },
  {
    id: 'detcontrol', group: 'gov', name: 'Deterministic control + agentic reasoning',
    control: 'Rules decide · agent investigates', bestUse: 'Strict compliance gates', tradeoff: 'Agent cannot fix a bad rule',
    usecase: `${D.icon} Drug discovery · ${D.scenarios.C.title}`,
    explain: 'Hard-coded rules make the pass/fail decision. The agent only <b>investigates</b>: it explains why each rule failed and recommends next experiments. It may give an opinion, but it has <b>no authority</b> — any attempt to override is logged and ignored.',
    graph: {
      nodes: [n('in', 'Compound\nQT-9901', 'input'), n('data', 'Tox + profile', 'tool'), n('rules', 'Rules engine\n(final authority)', 'rule'), n('agent', 'Investigator\nagent', 'llm'), n('ovr', 'Override\nattempt?', 'gate'), n('out', 'Decision\n+ diagnosis', 'output')],
      edges: [['in', 'data'], ['data', 'rules'], ['rules', 'agent', 'failed rules'], ['agent', 'ovr'], ['ovr', 'out'], ['rules', 'out', 'decision']],
    },
    async run(ctx) {
      ctx.node('in', 'done'); ctx.take('in', 'data')
      const prof = ctx.tool('data', D, 'getCompoundProfile', 'COMP003')
      const tox = ctx.tool('data', D, 'assessToxicologyProfile', 'COMP003')
      ctx.take('data', 'rules')
      const herg = parseFloat(tox.hERG_IC50)
      const RULES = [
        { id: 'R1', text: 'Hepatotoxicity score must be < 0.50', pass: tox.hepatotoxicityScore < 0.5, value: tox.hepatotoxicityScore },
        { id: 'R2', text: 'hERG IC50 must be ≥ 10 µM', pass: !(herg < 10), value: tox.hERG_IC50 },
        { id: 'R3', text: 'No reproductive toxicity signal', pass: !/embryotox|teratogen/i.test(tox.reproTox), value: tox.reproTox },
        { id: 'R4', text: 'Ames test must be negative', pass: /negative/i.test(tox.amesTest), value: tox.amesTest },
      ]
      RULES.forEach(r => ctx.log('rule', `${r.id} ${r.pass ? 'PASS' : 'FAIL'} — ${r.text} (value: ${r.value})`))
      const failed = RULES.filter(r => !r.pass)
      const decision = failed.length ? 'NO-GO' : 'GO'
      ctx.node('rules', failed.length ? 'fail' : 'pass', `${decision} · ${failed.length} failed`)
      ctx.take('rules', 'agent')
      const raw = await ctx.llm({
        node: 'agent', label: 'Investigator', maxTokens: 220,
        system: 'You are a toxicology investigator. You diagnose and recommend; you do not make the final decision.',
        user: `Compound: ${compact(prof)}\nToxicology: ${compact(tox)}\nFailed rules:\n${failed.map(r => `- ${r.id}: ${r.text} (value ${r.value})`).join('\n') || 'none'}\n\n1) For each failed rule, explain in one sentence why it likely failed.\n2) Recommend 2 next experiments.\n3) Last line: "MY VIEW: GO" or "MY VIEW: NO-GO".`,
      })
      ctx.take('agent', 'ovr')
      const view = pickLabel((raw.match(/MY VIEW:\s*(.*)/i) || [])[1] || '', ['NO-GO', 'GO'])
      const overrode = view && view !== decision
      if (overrode) ctx.log('warn', `Agent's view is ${view}, rules say ${decision} → agent has no authority; ignored and logged.`)
      ctx.gate('ovr', !overrode, overrode ? `Override attempt (${view}) blocked — decision stays ${decision}` : `Agent agrees with the rules (${view || 'no view given'})`)
      ctx.take('ovr', 'out'); ctx.take('rules', 'out'); ctx.node('out', 'done', decision)
      ctx.result(`Rules decision: ${decision}`, `<div class="rules">${RULES.map(r => `<div class="rule ${r.pass ? 'r-pass' : 'r-fail'}">${r.pass ? '✓' : '✗'} ${esc(r.id)} ${esc(r.text)} <span>${esc(r.value)}</span></div>`).join('')}</div>${kv('Agent diagnosis (advisory only)', '')}${p(raw)}${overrode ? kv('Override attempt', `agent said ${view} — ignored`) : ''}`, decision === 'GO' ? 'ok' : 'bad')
      return `${decision} · agent ${overrode ? 'overruled' : 'agreed'}`
    },
  },
]
