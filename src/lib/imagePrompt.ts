export const MAX_IMAGE_PROMPT_CHARACTERS = 8000

const TRUNCATION_MARKER = '\n\n[中间内容因图像接口长度限制已省略]\n\n'

export interface ConstrainedImagePrompt {
  prompt: string
  truncated: boolean
  originalCharacters: number
  finalCharacters: number
}

export function constrainImagePrompt(
  prompt: string,
  maxCharacters = MAX_IMAGE_PROMPT_CHARACTERS,
): ConstrainedImagePrompt {
  const characters = Array.from(prompt)
  if (characters.length <= maxCharacters) {
    return {
      prompt,
      truncated: false,
      originalCharacters: characters.length,
      finalCharacters: characters.length,
    }
  }

  const marker = Array.from(TRUNCATION_MARKER)
  const contentBudget = Math.max(0, maxCharacters - marker.length)
  const headCount = Math.ceil(contentBudget * 0.72)
  const tailCount = contentBudget - headCount
  const constrained = [
    ...characters.slice(0, headCount),
    ...marker,
    ...(tailCount > 0 ? characters.slice(-tailCount) : []),
  ].join('')

  return {
    prompt: constrained,
    truncated: true,
    originalCharacters: characters.length,
    finalCharacters: Array.from(constrained).length,
  }
}
