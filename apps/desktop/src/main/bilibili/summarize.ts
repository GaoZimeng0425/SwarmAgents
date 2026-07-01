// Turns a transcript into a structured "experience note" summary by calling the
// user's configured provider through an OpenAI/Anthropic-style chat request.
// URL composition mirrors providers/test-connection.ts so runtime and health
// check go through the same URL composition.
import { createLogger } from '@shared/logger'
import type { BiliSummary, ProviderInjection } from '@swarm/protocol'

const log = createLogger({ process: 'main' }).child({ component: 'bilibili-summarize' })

// Default base URLs mirror providers/test-connection.ts DEFAULT_BASE_URL exactly.
const DEFAULT_BASE_URL = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
} as const

// Endpoint paths mirror providers/test-connection.ts PATH_BY_STYLE exactly.
const PATH_BY_STYLE = {
  anthropic: '/v1/messages',
  openai: '/chat/completions',
} as const

export function buildPrompt(input: { title: string; author: string; text: string }): string {
  return [
    `视频标题：${input.title}`,
    `UP主：${input.author}`,
    '以下是该视频的字幕全文。请基于字幕，输出一篇"经验型"知识卡片。',
    '只返回 JSON，字段：gist(一句话主旨,string)、points(核心要点,string[])、',
    'experience(可复用经验/方法论,string[])、pitfalls(踩坑/注意,string[])、steps(可执行步骤,string[])。',
    '不要输出 JSON 以外的任何文字。',
    '---字幕开始---',
    input.text,
    '---字幕结束---',
  ].join('\n')
}

export function parseSummary(raw: string): BiliSummary {
  // Strip optional ```json ... ``` fences before parsing.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = (fenced ? fenced[1] : raw).trim()
  const obj = JSON.parse(body) as Partial<BiliSummary>
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])
  return {
    gist: typeof obj.gist === 'string' ? obj.gist : '',
    points: arr(obj.points),
    experience: arr(obj.experience),
    pitfalls: arr(obj.pitfalls),
    steps: arr(obj.steps),
  }
}

// Compose the chat URL mirroring providers/test-connection.ts joinUrl logic.
// `registry` takes precedence over `apiStyle` (same pattern as test-connection.ts line 79).
function chatUrl(inj: ProviderInjection): { url: string; style: 'anthropic' | 'openai' } {
  const style = (inj.registry ?? inj.apiStyle) as 'anthropic' | 'openai'
  const base = inj.baseUrl ?? DEFAULT_BASE_URL[style]
  const url = `${base.replace(/\/+$/, '')}${PATH_BY_STYLE[style]}`
  return { url, style }
}

export async function summarize(
  inj: ProviderInjection,
  input: { bvid: string; title: string; author: string; text: string }
): Promise<BiliSummary> {
  // NOTE: ProviderInjection uses `model` (single string), not `models[]`.
  const model = inj.model
  const { url, style } = chatUrl(inj)
  const prompt = buildPrompt(input)
  log.info({ msg: 'summarize request', bvid: input.bvid, model, chars: input.text.length })

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  let body: string
  if (style === 'anthropic') {
    headers['x-api-key'] = inj.apiKey
    headers['anthropic-version'] = '2023-06-01'
    // biome-ignore lint/style/useNamingConvention: HTTP wire format (Anthropic Messages API)
    body = JSON.stringify({ model, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] })
  } else {
    headers.Authorization = `Bearer ${inj.apiKey}`
    body = JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] })
  }

  const res = await fetch(url, { method: 'POST', headers, body })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    log.error({ msg: 'summarize http error', status: res.status, body: text.slice(0, 200) })
    throw new Error(`llm http ${res.status}`)
  }

  const json = (await res.json()) as Record<string, unknown>
  // Anthropic: { content: [{ text }] }   OpenAI: { choices: [{ message: { content } }] }
  const content =
    style === 'anthropic'
      ? ((json.content as { text?: string }[] | undefined)?.[0]?.text ?? '')
      : ((json.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message?.content ?? '')
  return parseSummary(content)
}
