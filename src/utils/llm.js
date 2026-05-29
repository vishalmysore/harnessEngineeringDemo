/**
 * llm.js — WebLLM wrapper with prompt-based tool calling.
 * Runs entirely in the browser via WebGPU — no API keys required.
 */

export const WEBLLM_MODELS = [
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',  name: 'Llama 3.2 3B (~2.0 GB) — Recommended' },
  { id: 'Phi-3.5-mini-instruct-q4f16_1-MLC',   name: 'Phi-3.5 Mini (~2.2 GB)' },
  { id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC',     name: 'Qwen 2.5 3B (~2.0 GB)' },
  { id: 'gemma-2-2b-it-q4f16_1-MLC',           name: 'Gemma 2 2B (~1.5 GB)' },
  { id: 'Llama-3.2-1B-Instruct-q4f32_1-MLC',   name: 'Llama 3.2 1B (~0.9 GB) — Fast' },
]

let _worker      = null
let _status      = 'idle' // 'idle' | 'loading' | 'ready' | 'error'
let _modelId     = null
let _genCounter  = 0
let _onProgress  = null
let _pendingLoad = null
let _pendingGen  = null

function _ensureWorker() {
  if (_worker) return
  _worker = new Worker(new URL('../worker.js', import.meta.url), { type: 'module' })
  _worker.onmessage = _handleMessage
}

function _handleMessage(e) {
  const msg = e.data
  switch (msg.status) {
    case 'ready':
      _status  = 'ready'
      _modelId = msg.modelId
      _onProgress?.({ type: 'ready', modelId: msg.modelId })
      _pendingLoad?.resolve()
      _pendingLoad = null
      break
    case 'error': {
      _status = 'error'
      const err = new Error(msg.error)
      _pendingLoad?.reject(err)
      _pendingGen?.reject(err)
      _pendingLoad = null
      _pendingGen  = null
      break
    }
    case 'downloading':
      _onProgress?.({ type: 'downloading', progress: msg.progress, file: msg.file })
      break
    case 'phase':
      _onProgress?.({ type: 'phase', phase: msg.phase, note: msg.note })
      break
    case 'device_detected':
      _onProgress?.({ type: 'device' })
      break
    case 'success':
      _pendingGen?.resolve({ text: msg.generatedText, latencyMs: msg.elapsedMs, tokensPerSec: msg.tokensPerSec })
      _pendingGen = null
      break
    case 'cancelled':
    case 'disposed':
      _pendingLoad?.reject(new Error('Cancelled'))
      _pendingLoad = null
      break
  }
}

export function getModelStatus()    { return _status }
export function getLoadedModelId()  { return _modelId }

export function loadModel(modelId, onProgress) {
  _ensureWorker()
  _status     = 'loading'
  _modelId    = null
  _onProgress = onProgress
  _genCounter++

  return new Promise((resolve, reject) => {
    _pendingLoad = { resolve, reject }
    _worker.postMessage({ action: 'load', modelId, gen: _genCounter })
  })
}

export function cancelModel() {
  if (_worker) _worker.postMessage({ action: 'cancel' })
  _status      = 'idle'
  _pendingLoad = null
  _pendingGen  = null
}

// ── Mock mode support ──────────────────────────────────────────

let _mockMode = false
export function setMockMode(v) { _mockMode = v }
export function isMockMode()   { return _mockMode }

// ── Prompt-based tool calling ──────────────────────────────────

function _buildToolPromptSuffix(toolSchemas) {
  if (!toolSchemas?.length) return ''
  const defs = toolSchemas.map(t => ({
    name:        t.function.name,
    description: t.function.description,
    parameters:  t.function.parameters,
  }))
  return `

## Tool Use Instructions
To call a tool, output ONLY a JSON block wrapped in <tool_call> tags — nothing else on that turn:
<tool_call>
{"tool_calls": [{"id": "c1", "name": "TOOL_NAME", "args": {}}]}
</tool_call>

You may batch multiple calls in one array. After receiving results, continue reasoning.
When finished, output your final answer as plain JSON (no tool_call tags).

Available tools:
${JSON.stringify(defs, null, 2)}`
}

function _parseToolCalls(text) {
  const match = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[1].trim())
    if (Array.isArray(parsed.tool_calls)) {
      return parsed.tool_calls.map((tc, i) => ({
        id:   tc.id   || `call_${i}`,
        name: tc.name,
        args: tc.args || {},
      }))
    }
  } catch (_) { /* malformed JSON — treat as no tool calls */ }
  return null
}

// ── Public API (mirrors old cloud llm.js surface) ──────────────

export async function callLLMWithTools(messages, systemPrompt, toolSchemasOpenAI /*, _anthropic unused */) {
  if (_status !== 'ready') throw new Error('No model loaded. Use the model loader to load a model first.')

  const fullSystemPrompt = systemPrompt + _buildToolPromptSuffix(toolSchemasOpenAI)
  _genCounter++
  const gen = _genCounter

  return new Promise((resolve, reject) => {
    _pendingGen = {
      resolve: ({ text, latencyMs, tokensPerSec }) =>
        resolve({ _webllm: true, text, latencyMs, tokensPerSec }),
      reject,
    }
    _worker.postMessage({ action: 'generate', messages, systemPrompt: fullSystemPrompt, gen })
  })
}

export function extractToolCalls(response) {
  if (!response?._webllm) return null
  return _parseToolCalls(response.text)
}

export function extractText(response) {
  if (!response?._webllm) return ''
  return response.text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim()
}

export function getRawMessage(response) {
  return { role: 'assistant', content: response.text }
}

export function formatToolResult(toolCallId, toolName, result) {
  return {
    role: 'user',
    content: `<tool_result id="${toolCallId}" name="${toolName}">\n${JSON.stringify(result, null, 2)}\n</tool_result>`,
  }
}

export function appendToolResults(messages, rawAssistantMessage, toolResults) {
  messages.push(rawAssistantMessage)
  const combined = toolResults.map(tr =>
    `<tool_result id="${tr.id}" name="${tr.name}">\n${JSON.stringify(tr.result, null, 2)}\n</tool_result>`
  ).join('\n')
  messages.push({ role: 'user', content: combined })
}

export function appendCorrectionMessage(messages, rawAssistantMessage, correctionText) {
  messages.push(rawAssistantMessage)
  messages.push({ role: 'user', content: correctionText })
}
