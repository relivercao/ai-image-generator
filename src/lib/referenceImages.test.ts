import { describe, expect, it } from 'vitest'
import {
  getConstrainedReferenceImageSize,
  getReferenceRequestTimeoutSeconds,
  getReferenceSheetLayout,
  MACODE_REFERENCE_SHEET_PROMPT,
  MAX_REFERENCE_IMAGES,
  MIN_REFERENCE_REQUEST_TIMEOUT_SECONDS,
  shouldComposeMacodeReferenceImages,
} from './referenceImages'

describe('reference images', () => {
  it('limits uploads to three images', () => {
    expect(MAX_REFERENCE_IMAGES).toBe(3)
  })

  it('keeps reference image requests alive for at least ten minutes', () => {
    expect(getReferenceRequestTimeoutSeconds(180, true)).toBe(MIN_REFERENCE_REQUEST_TIMEOUT_SECONDS)
    expect(getReferenceRequestTimeoutSeconds(900, true)).toBe(900)
    expect(getReferenceRequestTimeoutSeconds(180, false)).toBe(180)
  })

  it('constrains large images without changing their aspect ratio', () => {
    expect(getConstrainedReferenceImageSize(4032, 3024)).toEqual({ width: 2048, height: 1536 })
    expect(getConstrainedReferenceImageSize(800, 600)).toEqual({ width: 800, height: 600 })
  })

  it('creates stable two and three image sheet layouts', () => {
    const two = getReferenceSheetLayout(2)
    const three = getReferenceSheetLayout(3)

    expect(two).toMatchObject({ width: 2048, height: 1024 })
    expect(two.cells).toHaveLength(2)
    expect(three).toMatchObject({ width: 2048, height: 2048 })
    expect(three.cells).toHaveLength(3)
    expect(three.cells[2].x).toBeGreaterThan(three.cells[0].x)
  })

  it('composes only Macode gpt-image-2 Images API requests', () => {
    const profile = {
      provider: 'openai' as const,
      apiMode: 'images' as const,
      baseUrl: 'https://www.macode.cloud/v1',
      model: 'gpt-image-2',
    }

    expect(shouldComposeMacodeReferenceImages(profile, 2)).toBe(true)
    expect(shouldComposeMacodeReferenceImages(profile, 3)).toBe(true)
    expect(shouldComposeMacodeReferenceImages(profile, 1)).toBe(false)
    expect(shouldComposeMacodeReferenceImages({ ...profile, baseUrl: 'https://api.openai.com/v1' }, 2)).toBe(false)
    expect(shouldComposeMacodeReferenceImages({ ...profile, apiMode: 'responses' }, 2)).toBe(false)
    expect(MACODE_REFERENCE_SHEET_PROMPT).toContain('独立参考图')
  })
})
