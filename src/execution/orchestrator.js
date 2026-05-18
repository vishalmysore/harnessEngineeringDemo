import { retrieveRelevantMemories } from '../information/memoryManager.js'
import { verifyOutput, extractOutput } from '../feedback/verification.js'
import tracer from '../feedback/tracer.js'
import {
  callLLMWithTools, extractToolCalls, extractText, getRawMessage,
  formatToolResult, appendToolResults, appendCorrectionMessage, isMockMode,
} from '../utils/llm.js'

const MAX_ITERATIONS = 10

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
  const memories  = retrieveRelevantMemories(queryText)
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
      tracer.publish('layer:execution', 'Agent completed reasoning. No further tool calls requested.')
      tracer.publish('layer:feedback', 'Running schema verification...')

      const plan = extractOutput(rawText)

      const finalGuardrail = domain.validateFinalPlan(plan, toolResults)
      if (!finalGuardrail.valid) {
        tracer.publish('layer:feedback', `GUARDRAIL FINAL CHECK FAILED: ${finalGuardrail.errors.join(' | ')}`)
        const correctionMsg = `GUARDRAIL OVERRIDE (Iteration ${iteration}):\n${finalGuardrail.errors.map(e => `- ${e}`).join('\n')}\n\nRevise and re-output corrected JSON.`
        appendCorrectionMessage(messages, getRawMessage(response), correctionMsg)
        continue
      }

      const verification = verifyOutput(plan)
      tracer.publish('layer:feedback',
        verification.valid ? 'Schema verification PASSED. Audit complete.' : `Schema issues: ${verification.errors.join('; ')}`)

      tracer.publish('agent:complete', plan)
      return { plan, toolResults, guardrailWarnings, verification, rawText }
    }

    const processedResults = []

    for (const tc of toolCalls) {
      const { id, name, args } = tc
      tracer.publish('layer:execution', `Invoking ${name}(${JSON.stringify(args)})...`)

      const guardCall = domain.validateToolCall(name, args)
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
      } else {
        tracer.publish('layer:execution', `Tool ${name} returned OK.`)
      }

      toolResults.push({ name, args, result })
      processedResults.push({ id, name, result, formatted: formatToolResult(id, name, result) })
    }

    appendToolResults(messages, getRawMessage(response), processedResults)
  }

  throw new Error(`Agent did not complete after ${MAX_ITERATIONS} iterations.`)
}
