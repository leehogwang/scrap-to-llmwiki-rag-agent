import { getCodexAuth } from '@/lib/server/codex-auth'
import { getOptionalEnv } from '@/lib/server/env'

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
const defaultModel = getOptionalEnv('CODEX_AUTH_MODEL', 'gpt-5.4-mini')

type CodexInputItem =
  | string
  | {
    role: 'user' | 'assistant' | 'system'
    content: string
  }

function buildHeaders() {
  const auth = getCodexAuth()
  if (!auth) {
    throw new Error('Codex auth not found in ~/.codex/auth.json')
  }
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'ChatGPT-Account-Id': auth.accountId
  }
}

function normalizeInput(input: CodexInputItem | CodexInputItem[]) {
  const list = Array.isArray(input) ? input : [input]
  return list.map((item) => {
    if (typeof item === 'string') {
      return { role: 'user', content: item }
    }
    return item
  })
}

function extractItemText(item: unknown): string {
  if (!item || typeof item !== 'object') return ''
  const record = item as Record<string, unknown>
  if (typeof record.text === 'string' && record.text.trim()) {
    return record.text
  }
  if (!Array.isArray(record.content)) return ''
  const fragments = record.content.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const contentRecord = entry as Record<string, unknown>
    if (typeof contentRecord.text === 'string' && contentRecord.text.trim()) {
      return [contentRecord.text]
    }
    if (contentRecord.type === 'output_text' && typeof contentRecord.value === 'string' && contentRecord.value.trim()) {
      return [contentRecord.value]
    }
    return []
  })
  return fragments.join('\n').trim()
}

function extractText(events: Array<Record<string, unknown>>) {
  const deltas: string[] = []
  const completed: string[] = []

  for (const event of events) {
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      deltas.push(event.delta)
      continue
    }
    if (event.type === 'item.completed') {
      const text = extractItemText(event.item)
      if (text) completed.push(text)
    }
  }

  const deltaText = deltas.join('').trim()
  if (deltaText) return deltaText
  return completed.join('\n\n').trim()
}

function stripCodeFences(text: string) {
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced) return fenced[1].trim()
  return text.trim()
}

export async function runCodexText(params: {
  instructions: string
  input: CodexInputItem | CodexInputItem[]
  model?: string
  timeoutMs?: number
}) {
  const response = await fetch(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify({
      model: params.model ?? defaultModel,
      instructions: params.instructions,
      input: normalizeInput(params.input),
      store: false,
      stream: true
    }),
    signal: AbortSignal.timeout(params.timeoutMs ?? 300000)
  })

  if (!response.ok) {
    const raw = await response.text()
    const detail = raw.trim()
    throw new Error(detail ? `${response.status} ${response.statusText}: ${detail}` : `${response.status} ${response.statusText}`)
  }

  const events: Array<Record<string, unknown>> = []
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('Codex returned an empty response stream')
  }
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      newlineIndex = buffer.indexOf('\n')

      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6).trim()
      if (!payload || payload === '[DONE]') {
        await reader.cancel()
        break
      }
      try {
        const event = JSON.parse(payload) as Record<string, unknown>
        events.push(event)
        if (event.type === 'response.completed') {
          await reader.cancel()
          break
        }
      } catch {
        // Ignore malformed chunks and continue collecting usable events.
      }
    }
  }

  const text = extractText(events)
  if (!text) {
    throw new Error('Codex returned no text output')
  }
  return text
}

export async function runCodexJson<T>(params: {
  instructions: string
  input: CodexInputItem | CodexInputItem[]
  model?: string
  timeoutMs?: number
}) {
  const text = await runCodexText(params)
  const normalized = stripCodeFences(text)
  return JSON.parse(normalized) as T
}
