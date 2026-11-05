// gesture-bridge.example.js
//
// Adapter shell for provider-agnostic gesture recognition.
// This file contains NO key and makes NO live call. It shows where one plugs in.
//
// Contract: ai/README.md
// Providers: ai/providers.md

const PROVIDERS = {
  meta: ({ key, model }) => ({
    url: 'https://api.meta.ai/v1/messages',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: { model, max_tokens: 128, messages: [{ role: 'user', content: buildPrompt() }] },
  }),
  messages: ({ baseUrl, key, model }) => ({
    url: baseUrl + '/v1/messages',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: { model, max_tokens: 128, messages: [{ role: 'user', content: buildPrompt() }] },
  }),
  chat: ({ baseUrl, key, model }) => ({
    url: baseUrl + '/chat/completions',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: { model, messages: buildMessages() },
  }),
}

const SCHEMA_HINT = `Reply with JSON only:
{"gesture":"<name>","action":{"keys":["ctrl","i"]},"confidence":0.0}
Allowed action keys: keys | text | click | scroll | launch.`

function buildPrompt(stroke) {
  const s = stroke || { points: [], fingers: 1, durationMs: 0, canvas: {} }
  return [
    'You classify a touch gesture drawn on a trackpad.',
    'The stroke is a list of [x, y, tMs] points, x and y normalised 0-1 to the canvas, t in milliseconds.',
    'Return the gesture name and the action it should fire.',
    'Known actions in this build: circle -> Ctrl+I, vee -> Ctrl+Alt+S, notepad -> launch notepad.',
    SCHEMA_HINT,
    'Stroke: ' + JSON.stringify(s),
  ].join('\n')
}

function buildMessages() {
  return [
    { role: 'system', content: 'You return only JSON. Never explain.' },
    { role: 'user', content: buildPrompt() },
  ]
}

/**
 * Recognise a stroke through the configured provider.
 *
 * @param {object} stroke  the contract input
 * @param {object} cfg     { provider, baseUrl, model, key }
 * @returns {Promise<object|null>} contract output, or null on any failure
 */
export async function recognise(stroke, cfg) {
  const make = PROVIDERS[cfg.provider]
  if (!make) throw new Error('unknown provider: ' + cfg.provider)

  const req = make(cfg)

  // The prompt needs the specific stroke, so rebuild the body per call.
  if (cfg.provider === 'chat') req.body.messages = buildMessages()
  else req.body.messages = [{ role: 'user', content: buildPrompt(stroke) }]

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 4000)

  try {
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: ctrl.signal,
    })
    if (!res.ok) return null            // 401, 402, 429, 5xx -> fall back
    const data = await res.json()
    const text = extractText(data)
    return parseDecision(text)
  } catch {
    return null                          // network, timeout, bad JSON -> fall back
  } finally {
    clearTimeout(timer)
  }
}

function extractText(data) {
  if (!data) return ''
  if (Array.isArray(data.content)) return data.content.map(c => c.text || '').join('')
  if (data.choices && data.choices[0]) return data.choices[0].message?.content || ''
  return ''
}

function parseDecision(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try {
    const out = JSON.parse(text.slice(start, end + 1))
    if (!out.gesture || !out.action) return null
    if (typeof out.confidence !== 'number') out.confidence = 0
    return out
  } catch {
    return null
  }
}

// The rule that keeps the product honest: the model is optional.
export async function decide(stroke, cfg, rulesFallback) {
  const result = await recognise(stroke, cfg)
  if (result && result.confidence >= (cfg.minConfidence ?? 0.6)) return result
  return rulesFallback(stroke)
}
