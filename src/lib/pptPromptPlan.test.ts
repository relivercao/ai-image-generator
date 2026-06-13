import { describe, expect, it } from 'vitest'
import { buildPptOutlineDraft, buildPptPromptPlan, clampSlideCount, splitContentBlocks } from './pptPromptPlan'

describe('pptPromptPlan', () => {
  it('clamps slide count to a safe range', () => {
    expect(clampSlideCount(0)).toBe(1)
    expect(clampSlideCount(6.4)).toBe(6)
    expect(clampSlideCount(99)).toBe(20)
    expect(clampSlideCount(Number.NaN)).toBe(6)
  })

  it('splits outline-style content into slide blocks', () => {
    expect(splitContentBlocks('1. 背景\n2. 方案\n3. 总结')).toEqual(['背景', '方案', '总结'])
    expect(splitContentBlocks('背景\n\n方案')).toEqual(['背景', '方案'])
    expect(splitContentBlocks('幻灯片 1：背景\n\n第 2 页：方案')).toEqual(['背景', '方案'])
  })

  it('builds self-contained image prompts for every slide', () => {
    const plan = buildPptPromptPlan({
      topic: '智能制造',
      content: '背景\n\n路径',
      audience: '高管',
      style: '咨询风',
      language: '中文',
      slideCount: 3,
    })

    expect(plan).toHaveLength(3)
    expect(plan[0].title).toBe('智能制造')
    expect(plan[0].prompt).toContain('完整的 16:9 PPT 幻灯片图片')
    expect(plan[0].prompt).toContain('页面文字')
    expect(plan[1].prompt).toContain('至少 4 个模块')
    expect(plan[1].prompt).toContain('硬约束')
    expect(plan.some((slide) => slide.prompt.includes('路径'))).toBe(true)
    expect(plan[2].title).toBe('总结与下一步')
  })

  it('generates an editable outline draft from title and content', () => {
    const outline = buildPptOutlineDraft({
      topic: 'AI 未来趋势',
      content: '多模态模型成为基础入口。\n\n企业 Agent 从试点走向规模化落地。',
      audience: '管理层',
      language: '中文',
      slideCount: 5,
    })

    expect(outline).toContain('AI 未来趋势')
    expect(outline).not.toContain('1. AI 未来趋势')
    expect(outline).not.toContain('核心信息')
    expect(outline).not.toContain('视觉建议')
    expect(splitContentBlocks(outline)).toHaveLength(5)
  })

  it('uses outline headings as content slide titles', () => {
    const plan = buildPptPromptPlan({
      topic: 'AI 未来趋势',
      content: '1. 多模态入口\n- 模型理解文本、图像和视频\n\n2. 企业 Agent\n- 从试点走向规模化',
      audience: '管理层',
      style: '咨询风',
      language: '中文',
      slideCount: 4,
    })

    expect(plan[1].title).toBe('多模态入口')
    expect(plan[2].title).toBe('企业 Agent')
  })

  it('uses one content block per slide when a complete outline is provided', () => {
    const plan = buildPptPromptPlan({
      topic: 'AI 未来趋势',
      content: [
        '总览\n- 第一页内容',
        '多模态入口\n- 第二页内容',
        '企业 Agent\n- 第三页内容',
      ].join('\n\n'),
      audience: '管理层',
      style: '咨询风',
      language: '中文',
      slideCount: 3,
    })

    expect(plan[0].content).toContain('第一页内容')
    expect(plan[0].content).not.toContain('第二页内容')
    expect(plan[2].content).toContain('第三页内容')
    expect(plan[2].content).not.toContain('第一页内容')
  })
})
