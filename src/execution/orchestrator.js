import { retrieveRelevantMemories } from '../information/memoryManager.js'
import { verifyOutput, extractOutput } from '../feedback/verification.js'
import tracer from '../feedback/tracer.js'
import {
  callLLMWithTools, extractToolCalls, extractText, getRawMessage,
  formatToolResult, appendToolResults, appendCorrectionMessage, isMockMode,
} from '../utils/llm.js'

const MAX_ITERATIONS = 10

// Small models sometimes repeat a tool call with empty args — catch it before the tool runs
function missingRequiredArgs(domain, name, args) {
  const schema = domain.toolSchemas.openai.find(t => t.function.name === name)
  const required = schema?.function.parameters?.required || []
  return required.filter(p => args?.[p] === undefined || args[p] === '')
}

// Same tool + same args (key order ignored) = same call
function callKey(name, args) {
  const sorted = Object.keys(args || {}).sort().map(k => [k, args[k]])
  return `${name}:${JSON.stringify(sorted)}`
}

// After two turns of nothing but repeats, stop instead of filling the context window
const MAX_REPEAT_TURNS = 2

const FINALIZE_MSG = 'You already have the results for every tool call you just requested — they are in the tool results above. ' +
  'Do NOT call any more tools. Write your final recommendation now: output ONLY the JSON object in the required format, with no <tool_call> tags.'

// A parsed reply needs at least one of these to count as an answer
const ANSWER_FIELDS = ['summary', 'assessment', 'recommendations', 'reasoning']

const MAX_GUARDRAIL_REVISIONS = 2

const JSON_RETRY_MSG = 'Your last reply was not the final answer: it was not a JSON object (do not repeat tool calls or tool results). ' +
  'Using the tool results you already have, output ONLY the JSON object in the required format now.'

// Corrections keep only the start of a bad reply, so a long echo can't fill the context window
function shortened(rawMessage, max = 300) {
  const c = rawMessage.content || ''
  return c.length > max ? { ...rawMessage, content: c.slice(0, max) + ' …[truncated]' } : rawMessage
}

function executeTool(domain, name, args) {
  const fn = domain.toolFns[name]
  if (!fn) throw new Error(`Unknown tool: ${name}`)
  return fn(...Object.values(args))
}

export async function runAgent(scenario, domain) {
  tracer.clearLogs()
  tracer.publish('agent:start', { scenario: scenario.title, domain: domain.name })
  tracer.publish('layer:info', `Domain: ${domain.name} | Scenario: ${scenario.title}`)

  const queryText = Object.values(scenario).filter(v => typeof v === 'string').join(' ')
  const memories  = retrieveRelevantMemories(queryText, domain.id)
  tracer.publish('layer:info',
    memories.length > 0
      ? `Searching past feedback logs... Found ${memories.length} relevant correction(s).`
      : 'Searching past feedback logs... No prior corrections for this case.'
  )
  tracer.publish('layer:info', 'System prompt assembled with memory context and output constraints.')

  // ── Mock mode — domain handles its own simulation ──────────
  if (isMockMode()) {
    tracer.publish('layer:execution', '[MOCK MODE] Simulating full agentic loop with real tools — no LLM required.')
    const result = await domain.mockSimulate(scenario)
    tracer.publish('layer:feedback', 'Running schema verification...')
    const v = result.verification || verifyOutput(result.plan)
    tracer.publish(v.valid ? 'layer:feedback' : 'agent:error',
      v.valid ? 'Schema verification PASSED. Audit complete.' : `Schema issues: ${v.errors.join('; ')}`)
    tracer.publish('agent:complete', result.plan)
    return { ...result, verification: v }
  }

  // ── Real LLM agentic loop ──────────────────────────────────
  const systemPrompt = domain.buildSystemPrompt(memories)
  const scenarioText = Object.entries(scenario)
    .filter(([k, v]) => typeof v === 'string' && k !== 'id')
    .map(([k, v]) => `${k}: ${v}`).join('\n')

  const messages = [{ role: 'user', content: `${scenarioText}\n\nAnalyse thoroughly using all available tools, then generate your structured recommendation.` }]
  const toolResults       = []
  const guardrailWarnings = []
  const completedCalls    = new Set()   // callKey of every call that ran cleanly
  const completedTools    = new Set()   // tool names that have run cleanly at least once
  let repeatTurns = 0
  let coverageChecked = false   // one reminder about tools the model never used
  let jsonRetried     = false   // one retry when the final answer isn't JSON
  let guardrailRevisions = 0
  let iteration = 0

  tracer.publish('layer:execution', 'Starting agentic loop (Plan → Tool Call → Parse → Retry/Complete)...')

  while (iteration < MAX_ITERATIONS) {
    iteration++
    tracer.publish('layer:execution', `Iteration ${iteration}: Querying model...`)

    let response
    try {
      response = await callLLMWithTools(messages, systemPrompt, domain.toolSchemas.openai, domain.toolSchemas.anthropic)
    } catch (err) {
      tracer.publish('agent:error', `LLM call failed: ${err.message}`)
      throw err
    }

    const toolCalls = extractToolCalls(response)

    if (!toolCalls || toolCalls.length === 0) {
      const rawText = extractText(response)

      const unusedTools = domain.toolSchemas.openai.map(t => t.function.name).filter(n => !completedTools.has(n))
      if (unusedTools.length && !coverageChecked) {
        coverageChecked = true
        tracer.publish('layer:execution', `Model tried to finish without using ${unusedTools.join(', ')}. Asking it to call any that matter before answering.`)
        appendCorrectionMessage(messages, shortened(getRawMessage(response)),
          `Before you answer: you have not used ${unusedTools.join(', ')}. If any of them is relevant to this case, call it now (with all its arguments). Otherwise output ONLY the final JSON object.`)
        continue
      }

      tracer.publish('layer:execution', 'Agent completed reasoning. No further tool calls requested.')
      tracer.publish('layer:feedback', 'Running schema verification...')

      let plan = extractOutput(rawText)

      // JSON that has none of the answer fields (e.g. an echoed tool result) is not an answer
      const looksLikeAnswer = ANSWER_FIELDS.some(f => plan[f] !== undefined)
      if (!plan._parse_error && !looksLikeAnswer) plan = extractOutput('')

      if (plan._parse_error && !jsonRetried) {
        jsonRetried = true
        tracer.publish('layer:feedback', 'Final answer was not valid JSON. Asking the model to re-output it once.')
        appendCorrectionMessage(messages, shortened(getRawMessage(response)), JSON_RETRY_MSG)
        continue
      }

      // The fallback plan is already headed for manual review; domain rules only apply to real answers
      const finalGuardrail = plan._parse_error ? { valid: true, errors: [] } : domain.validateFinalPlan(plan, toolResults)
      if (!finalGuardrail.valid) {
        tracer.publish('layer:feedback', `GUARDRAIL FINAL CHECK FAILED: ${finalGuardrail.errors.join(' | ')}`)
        if (guardrailRevisions < MAX_GUARDRAIL_REVISIONS) {
          guardrailRevisions++
          const correctionMsg = `GUARDRAIL OVERRIDE (Iteration ${iteration}):\n${finalGuardrail.errors.map(e => `- ${e}`).join('\n')}\n\nRevise and re-output corrected JSON.`
          appendCorrectionMessage(messages, shortened(getRawMessage(response), 1500), correctionMsg)
          continue
        }
        // Still failing: release for manual review with the violations in front of the reviewer
        tracer.publish('layer:feedback', `Still failing after ${MAX_GUARDRAIL_REVISIONS} revisions. Sending to manual review with the violations listed.`)
        const warnings = Array.isArray(plan.warnings) ? plan.warnings : plan.warnings ? [plan.warnings] : []
        plan = { ...plan, warnings: [...finalGuardrail.errors.map(e => `GUARDRAIL VIOLATION: ${e}`), ...warnings], requires_human_review: true, _guardrail_violation: true }
      }

      const verification = verifyOutput(plan)
      tracer.publish('layer:feedback',
        verification.valid ? 'Schema verification PASSED. Audit complete.' : `Schema issues: ${verification.errors.join('; ')}`)

      tracer.publish('agent:complete', plan)
      return { plan, toolResults, guardrailWarnings, verification, rawText }
    }

    // ── Repeat detection: calls already answered (or empty re-asks of a tool that already ran) ──
    const isRepeat = ({ name, args }) =>
      completedCalls.has(callKey(name, args)) ||
      (completedTools.has(name) && missingRequiredArgs(domain, name, args).length > 0)
    const repeats = toolCalls.filter(isRepeat)

    if (repeats.length === toolCalls.length) {
      repeatTurns++
      const names = [...new Set(repeats.map(tc => tc.name))].join(', ')

      if (repeatTurns >= MAX_REPEAT_TURNS) {
        tracer.publish('layer:feedback', `Model kept re-requesting tools it already has results for (${names}). Stopping the loop and sending the case for manual review.`)
        const plan = extractOutput(extractText(response))
        const verification = verifyOutput(plan)
        tracer.publish('layer:feedback', verification.valid ? 'Schema verification PASSED. Audit complete.' : `Schema issues: ${verification.errors.join('; ')}`)
        tracer.publish('agent:complete', plan)
        return { plan, toolResults, guardrailWarnings, verification, rawText: response.text }
      }

      tracer.publish('layer:execution', `Repeat tool calls skipped (${names}) — results already available. Asking the model for its final answer.`)
      appendCorrectionMessage(messages, getRawMessage(response), FINALIZE_MSG)
      continue
    }
    repeatTurns = 0

    const processedResults = []

    for (const tc of toolCalls) {
      const { id, name, args } = tc

      // Mixed turn: answer repeats with a pointer instead of running them again
      if (isRepeat(tc)) {
        tracer.publish('layer:execution', `Skipping repeat call ${name}(${JSON.stringify(args)}) — result already available.`)
        const note = { note: `${name} was already called; use the earlier result above.` }
        processedResults.push({ id, name, result: note, formatted: formatToolResult(id, name, note) })
        continue
      }

      tracer.publish('layer:execution', `Invoking ${name}(${JSON.stringify(args)})...`)

      const missing = missingRequiredArgs(domain, name, args)
      const guardCall = missing.length
        ? { safe: false, reason: `${name} needs ${missing.join(', ')} — call it again with those arguments filled in.` }
        : domain.validateToolCall(name, args)
      if (!guardCall.safe) {
        tracer.publish('layer:feedback', `GUARDRAIL BLOCKED tool call: ${guardCall.reason}`)
        const blockedResult = { error: `Guardrail blocked: ${guardCall.reason}` }
        toolResults.push({ name, args, result: blockedResult, blocked: true })
        processedResults.push({ id, name, result: blockedResult, formatted: formatToolResult(id, name, blockedResult) })
        continue
      }

      let result
      try {
        result = executeTool(domain, name, args)
      } catch (err) {
        result = { error: err.message }
      }

      const outputCheck = domain.validateToolOutput(name, result)
      if (outputCheck.warning) {
        guardrailWarnings.push(outputCheck.warning)
        result._guardrail = { severity: outputCheck.severity, warning: outputCheck.warning }
        if (outputCheck.forceRevision) result._guardrail.instruction = 'This result requires you to revise your recommendation.'
      } else if (result?.error) {
        tracer.publish('layer:execution', `Tool ${name} returned an error: ${result.error}`)
      } else {
        tracer.publish('layer:execution', `Tool ${name} returned OK.`)
      }

      if (!result?.error) {
        completedCalls.add(callKey(name, args))
        completedTools.add(name)
      }

      toolResults.push({ name, args, result })
      processedResults.push({ id, name, result, formatted: formatToolResult(id, name, result) })
    }

    appendToolResults(messages, getRawMessage(response), processedResults)
  }

  throw new Error(`Agent did not complete after ${MAX_ITERATIONS} iterations.`)
}
