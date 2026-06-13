import type { ApiProfile, AppSettings, ResponsesApiResponse } from '../types'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import { createLinkedAbortController, getApiErrorMessage } from './imageApiShared'

export interface PptOutlineRequest {
  topic: string
  content: string
  audience: string
  language: string
  slideCount: number
}

const PPT_OUTLINE_INSTRUCTIONS = [
  'You are a senior presentation strategist and visual prompt writer.',
  'Generate a complete PPT outline/prompt in the user requested language.',
  'The output will be pasted directly into a PPT image-generation workspace.',
  'Do not include explanations, markdown code fences, or meta commentary.',
  'Every slide must have a clear title, business content, and concrete visual direction.',
  'Prefer concise, high-density report language. Avoid vague marketing slogans.',
].join('\n')

export function buildPptOutlineLlmInput(input: PptOutlineRequest): string {
  return [
    `主题：${input.topic.trim() || '未命名主题'}`,
    `受众：${input.audience.trim() || '通用受众'}`,
    `语言：${input.language.trim() || '中文'}`,
    `页数：${Math.max(1, Math.trunc(input.slideCount || 1))}`,
    '',
    '已有素材/要求：',
    input.content.trim() || '请根据主题自行补全合理的汇报结构。',
    '',
    '请重新生成一版完整 PPT 大纲提示词，严格按以下格式输出：',
    '',
    '页面标题',
    '- 这一页要传达的核心判断。',
    '- 支撑判断的业务要点或事实。',
    '- 可执行动作、指标或结论。',
    '',
    '要求：',
    '- 内容块数量必须与“页数”一致。',
    '- 不要写“幻灯片 1”“第 1 页”“Page 1”“Slide 1”等页码或页面标记。',
    '- 不要写“目标：”“要点：”“画面建议：”等字段标签。',
    '- 第 1 页适合作为封面/总览，最后 1 页必须有总结和下一步。',
    '- 每页标题要短，内容要能直接指导生成一张完整 16:9 PPT 页面。',
    '- 每个内容块之间用一个空行分隔。',
    '- 不要输出 JSON，不要输出代码块。',
  ].join('\n')
}

function createHeaders(profile: ApiProfile): Record<string, string> {
  return {
    Authorization: `Bearer ${profile.apiKey}`,
    'Content-Type': 'application/json',
  }
}

function getStringByPath(source: unknown, path: string[]): string {
  let current = source
  for (const key of path) {
    if (!current || typeof current !== 'object') return ''
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === 'string' ? current : ''
}

function extractResponsesText(payload: ResponsesApiResponse | Record<string, unknown>): string {
  const directText =
    getStringByPath(payload, ['output_text']) ||
    getStringByPath(payload, ['text']) ||
    getStringByPath(payload, ['message', 'content']) ||
    getStringByPath(payload, ['choices', '0', 'message', 'content'])
  if (directText.trim()) return directText.trim()

  const output = Array.isArray((payload as ResponsesApiResponse).output)
    ? (payload as ResponsesApiResponse).output ?? []
    : []
  const parts: string[] = []

  for (const item of output) {
    const record = item as Record<string, unknown>
    if (typeof record.text === 'string') parts.push(record.text)
    if (typeof record.output_text === 'string') parts.push(record.output_text)

    const content = record.content
    if (typeof content === 'string') {
      parts.push(content)
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === 'object') {
          const text = (part as Record<string, unknown>).text
          if (typeof text === 'string') parts.push(text)
        }
      }
    }
  }

  return parts.join('\n').trim()
}

function cleanLlmOutlineText(value: string): string {
  return value
    .trim()
    .replace(/^```(?:markdown|md|text)?\s*/i, '')
    .replace(/\s*```$/g, '')
    .split(/\r?\n/g)
    .map((line) => line
      .replace(/^\s*(?:幻灯片|slide|page|p)\s*\d+\s*[:：.、-]?\s*/i, '')
      .replace(/^\s*第\s*[一二三四五六七八九十\d]+\s*(?:页|张|章|节|部分)\s*[:：.、-]?\s*/, '')
      .replace(/^\s*(?:目标|要点|画面建议|核心信息|支撑要点|视觉建议)\s*[:：]\s*/g, '')
      .trimEnd(),
    )
    .filter((line) => !/^\s*(?:目标|要点|画面建议|核心信息|支撑要点|视觉建议)\s*[:：]?\s*$/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function callPptOutlineApi(opts: {
  settings: AppSettings
  profile: ApiProfile
  input: PptOutlineRequest
  signal?: AbortSignal
}): Promise<string> {
  const { settings, profile, input, signal } = opts
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const { controller, cleanup } = createLinkedAbortController(profile.timeout || settings.timeout || 600, signal)

  try {
    const response = await fetch(buildApiUrl(profile.baseUrl, 'responses', proxyConfig, useApiProxy), {
      method: 'POST',
      headers: createHeaders(profile),
      cache: 'no-store',
      body: JSON.stringify({
        model: profile.model || settings.model,
        instructions: PPT_OUTLINE_INSTRUCTIONS,
        input: [{
          role: 'user',
          content: [{
            type: 'input_text',
            text: buildPptOutlineLlmInput(input),
          }],
        }],
        max_output_tokens: 1800,
      }),
      signal: controller.signal,
    })

    if (!response.ok) throw new Error(await getApiErrorMessage(response))

    const payload = await response.json() as ResponsesApiResponse
    const text = cleanLlmOutlineText(extractResponsesText(payload))
    if (!text) {
      const err = new Error('LLM 没有返回可用的大纲提示词')
      ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
      throw err
    }
    return text
  } finally {
    cleanup()
  }
}
