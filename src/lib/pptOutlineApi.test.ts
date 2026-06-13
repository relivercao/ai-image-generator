import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS, normalizeSettings } from './apiProfiles'
import { buildPptOutlineLlmInput, callPptOutlineApi } from './pptOutlineApi'

describe('pptOutlineApi', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('builds an LLM input with topic, material, and slide count', () => {
    const input = buildPptOutlineLlmInput({
      topic: 'AI 未来趋势',
      content: '多模态、Agent、算力成本',
      audience: '管理层',
      language: '中文',
      slideCount: 5,
    })

    expect(input).toContain('主题：AI 未来趋势')
    expect(input).toContain('页数：5')
    expect(input).toContain('多模态、Agent、算力成本')
    expect(input).toContain('页面标题')
    expect(input).toContain('不要写“幻灯片 1”')
  })

  it('calls the Responses API and returns generated outline text', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: '幻灯片 1：AI 未来趋势\n目标：建立判断。',
        }],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
      model: 'gpt-5.5',
      timeout: 30,
    })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [profile],
      activeProfileId: profile.id,
    })

    const outline = await callPptOutlineApi({
      settings,
      profile,
      input: {
        topic: 'AI 未来趋势',
        content: '多模态与 Agent',
        audience: '管理层',
        language: '中文',
        slideCount: 5,
      },
    })

    expect(outline).toBe('AI 未来趋势\n建立判断。')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/responses',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
        }),
      }),
    )
    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.model).toBe('gpt-5.5')
    expect(body.input[0].content[0].text).toContain('主题：AI 未来趋势')
    expect(body.input[0].content[0].text).toContain('页数：5')
  })
})
