/**
 * llm.js — LLM API wrapper with proxy routing and tool-call support.
 * All requests are routed through a CORS proxy via x-target-url header.
 * Supported providers: OpenAI, Anthropic, Google Gemini, NVIDIA NIM, Mock.
 */

const DEFAULT_PROXY = 'https://quantumstudio.visrow.workers.dev/'

export const PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI',
    icon: '🤖',
    keyPlaceholder: 'sk-…',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    models: [
      { id: 'gpt-4o',      name: 'GPT-4o (recommended)' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini (fast)' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
    ],
    format: 'openai',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    icon: '🧬',
    keyPlaceholder: 'sk-ant-…',
    endpoint: 'https://api.anthropic.com/v1/messages',
    models: [
      { id: 'claude-opus-4-7',              name: 'Claude Opus 4.7 (most capable)' },
      { id: 'claude-sonnet-4-6',            name: 'Claude Sonnet 4.6 (recommended)' },
      { id: 'claude-3-5-sonnet-20241022',   name: 'Claude 3.5 Sonnet' },
    ],
    format: 'anthropic',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    icon: '✨',
    keyPlaceholder: 'AIza…',
    endpoint: 'https://generativelanguage.googleapis.com',
    models: [
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash (recommended)' },
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
      { id: 'gemini-1.5-pro',   name: 'Gemini 1.5 Pro' },
    ],
    format: 'openai',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    icon: '🟢',
    keyPlaceholder: 'nvapi-…',
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    models: [
      { id: 'meta/llama-3.1-70b-instruct',            name: 'Llama 3.1 70B Instruct' },
      { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'Nemotron 70B' },
    ],
    format: 'openai',
  },
  {
    id: 'mock',
    name: 'Mock AI',
    icon: '🧪',
    keyPlaceholder: 'No key needed',
    endpoint: 'mock',
    models: [
      { id: 'mock-agent', name: 'Mock Agent v1 (no API key required)' },
    ],
    format: 'mock',
  },
]

let _config = {
  provider: 'openai',
  apiKey: '',
  model: 'gpt-4o',
  proxyUrl: _loadProxyUrl(),
}

function _loadProxyUrl() {
  try { return localStorage.getItem('hh_proxy_url') || DEFAULT_PROXY } catch { return DEFAULT_PROXY }
}

export function setLLMConfig(cfg) {
  _config = { ..._config, ...cfg }
  if (cfg.proxyUrl !== undefined) {
    try { localStorage.setItem('hh_proxy_url', cfg.proxyUrl || DEFAULT_PROXY) } catch { /* ignore */ }
  }
}

export function getLLMConfig() {
  return { ..._config, proxyUrl: _config.proxyUrl || DEFAULT_PROXY }
}

export function getDefaultProxy() { return DEFAULT_PROXY }

export function getProviderDef(providerId) {
  return PROVIDERS.find(p => p.id === (providerId || _config.provider))
}

/**
 * Call the LLM with tool definitions. Returns the raw provider response.
 * Handles OpenAI-format (tool_calls) and Anthropic-format (content blocks).
 * @param {{ role, content }[]} messages
 * @param {string} systemPrompt
 * @param {object[]} toolSchemasOpenAI
 * @param {object[]} toolSchemasAnthropic
 * @returns {Promise<object>} Raw provider response
 */
export async function callLLMWithTools(messages, systemPrompt, toolSchemasOpenAI, toolSchemasAnthropic) {
  const { provider, apiKey, model, proxyUrl } = getLLMConfig()
  const providerDef = getProviderDef(provider)
  if (!providerDef) throw new Error(`Unknown provider: ${provider}`)
  if (provider !== 'mock' && !apiKey) throw new Error('API key not configured. Open Settings to add one.')

  const proxy = proxyUrl || DEFAULT_PROXY

  if (providerDef.format === 'anthropic') {
    return _callAnthropic(messages, systemPrompt, model, apiKey, proxy, toolSchemasAnthropic)
  }
  return _callOpenAIFormat(messages, systemPrompt, model, apiKey, proxy, toolSchemasOpenAI, providerDef)
}

// ── Provider implementations ───────────────────────────────────

async function _callOpenAIFormat(messages, systemPrompt, model, apiKey, proxy, tools, providerDef) {
  const targetUrl = providerDef.id === 'gemini'
    ? `${providerDef.endpoint}/v1beta/models/${model}:generateContent?key=${apiKey}`
    : providerDef.endpoint

  const headers = {
    'Content-Type': 'application/json',
    'x-target-url': targetUrl,
  }
  if (providerDef.id !== 'gemini') {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  const body = {
    model,
    temperature: 0.2,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    tools,
    tool_choice: 'auto',
  }

  const res = await fetch(proxy, { method: 'POST', headers, body: JSON.stringify(body) })
  const data = await res.json()
  if (!res.ok) throw new Error(data?.error?.message || `${providerDef.name} error ${res.status}`)
  return data
}

async function _callAnthropic(messages, systemPrompt, model, apiKey, proxy, tools) {
  const headers = {
    'Content-Type': 'application/json',
    'x-target-url': 'https://api.anthropic.com/v1/messages',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  }
  const body = { model, system: systemPrompt, messages, tools, max_tokens: 4096, temperature: 0.2 }

  const res = await fetch(proxy, { method: 'POST', headers, body: JSON.stringify(body) })
  const data = await res.json()
  if (!res.ok) throw new Error(data?.error?.message || `Anthropic error ${res.status}`)
  return data
}

// ── Response extraction helpers ────────────────────────────────

export function extractToolCalls(response) {
  const { provider } = getLLMConfig()
  if (provider === 'anthropic') {
    const blocks = response.content?.filter(b => b.type === 'tool_use') || []
    if (!blocks.length) return null
    return blocks.map(b => ({ id: b.id, name: b.name, args: b.input }))
  }
  // OpenAI format
  const toolCalls = response.choices?.[0]?.message?.tool_calls
  if (!toolCalls?.length) return null
  return toolCalls.map(tc => ({
    id: tc.id,
    name: tc.function.name,
    args: JSON.parse(tc.function.arguments),
  }))
}

export function extractText(response) {
  const { provider } = getLLMConfig()
  if (provider === 'anthropic') {
    return (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
  }
  return response.choices?.[0]?.message?.content || ''
}

export function getRawMessage(response) {
  const { provider } = getLLMConfig()
  if (provider === 'anthropic') return response.content
  return response.choices?.[0]?.message
}

export function formatToolResult(toolCallId, toolName, result) {
  const { provider } = getLLMConfig()
  if (provider === 'anthropic') {
    return { type: 'tool_result', tool_use_id: toolCallId, content: JSON.stringify(result) }
  }
  return { role: 'tool', tool_call_id: toolCallId, name: toolName, content: JSON.stringify(result) }
}

export function appendToolResults(messages, rawAssistantMessage, toolResults) {
  const { provider } = getLLMConfig()
  if (provider === 'anthropic') {
    messages.push({ role: 'assistant', content: rawAssistantMessage })
    messages.push({ role: 'user', content: toolResults.map(tr => tr.formatted) })
  } else {
    messages.push(rawAssistantMessage)
    toolResults.forEach(tr => messages.push(tr.formatted))
  }
}

export function appendCorrectionMessage(messages, rawAssistantMessage, correctionText) {
  const { provider } = getLLMConfig()
  if (provider === 'anthropic') {
    messages.push({ role: 'assistant', content: rawAssistantMessage })
    messages.push({ role: 'user', content: correctionText })
  } else {
    messages.push(rawAssistantMessage)
    messages.push({ role: 'user', content: correctionText })
  }
}

// ── Mock simulation ────────────────────────────────────────────
// Used by orchestrator.js when provider === 'mock'
// Returns a realistic tool-calling sequence without hitting any API.

export function isMockMode() {
  return getLLMConfig().provider === 'mock'
}

/**
 * testConnection — send a minimal "Say OK" prompt to verify the API key and proxy work.
 * @returns {Promise<{ text: string, latencyMs: number }>}
 */
export async function testConnection() {
  const { provider, apiKey, model, proxyUrl } = getLLMConfig()
  const providerDef = getProviderDef(provider)
  if (!providerDef) throw new Error(`Unknown provider: ${provider}`)

  if (provider === 'mock') {
    await new Promise(r => setTimeout(r, 600))
    return { text: 'OK (mock)', latencyMs: 600 }
  }

  if (!apiKey) throw new Error('No API key configured.')

  const proxy = proxyUrl || DEFAULT_PROXY
  const start = Date.now()

  if (providerDef.format === 'anthropic') {
    const res = await fetch(proxy, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-target-url': providerDef.endpoint,
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Say OK' }],
      }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data?.error?.message || `Anthropic error ${res.status}`)
    return { text: data.content?.[0]?.text || 'OK', latencyMs: Date.now() - start }
  }

  // OpenAI-compatible (OpenAI, NVIDIA NIM, Gemini)
  let targetUrl = providerDef.endpoint
  if (provider === 'nvidia' && !targetUrl.endsWith('/chat/completions')) {
    targetUrl += '/chat/completions'
  }
  if (provider === 'gemini') {
    targetUrl = `${providerDef.endpoint}/v1beta/models/${model}:generateContent?key=${apiKey}`
  }

  const headers = {
    'Content-Type': 'application/json',
    'x-target-url': targetUrl,
  }
  if (provider !== 'gemini') headers['Authorization'] = `Bearer ${apiKey}`

  let body
  if (provider === 'gemini') {
    body = { contents: [{ parts: [{ text: 'Say OK' }] }], generationConfig: { maxOutputTokens: 10 } }
  } else {
    body = { model, max_tokens: 10, messages: [{ role: 'user', content: 'Say OK' }] }
  }

  const res = await fetch(proxy, { method: 'POST', headers, body: JSON.stringify(body) })
  const data = await res.json()
  if (!res.ok) throw new Error(data?.error?.message || `${providerDef.name} error ${res.status}`)

  let text = ''
  if (provider === 'gemini') {
    text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'OK'
  } else {
    text = data.choices?.[0]?.message?.content || 'OK'
  }
  return { text: text.trim(), latencyMs: Date.now() - start }
}
