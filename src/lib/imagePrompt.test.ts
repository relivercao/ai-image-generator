import { describe, expect, it } from 'vitest'
import { constrainImagePrompt, MAX_IMAGE_PROMPT_CHARACTERS } from './imagePrompt'

describe('image prompt constraints', () => {
  it('keeps prompts within the image API limit unchanged', () => {
    expect(constrainImagePrompt('正常提示词')).toEqual({
      prompt: '正常提示词',
      truncated: false,
      originalCharacters: 5,
      finalCharacters: 5,
    })
  })

  it('preserves the beginning and ending constraints of an oversized prompt', () => {
    const original = `开头主题-${'中'.repeat(MAX_IMAGE_PROMPT_CHARACTERS + 1000)}-末尾硬约束-🎨`
    const result = constrainImagePrompt(original)

    expect(result.truncated).toBe(true)
    expect(result.originalCharacters).toBeGreaterThan(MAX_IMAGE_PROMPT_CHARACTERS)
    expect(result.finalCharacters).toBe(MAX_IMAGE_PROMPT_CHARACTERS)
    expect(result.prompt).toMatch(/^开头主题-/)
    expect(result.prompt).toContain('中间内容因图像接口长度限制已省略')
    expect(result.prompt).toMatch(/-末尾硬约束-🎨$/)
  })
})
