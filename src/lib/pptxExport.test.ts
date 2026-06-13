import { describe, expect, it } from 'vitest'
import {
  createEditableSlidesPptx,
  ensurePptxExtension,
  getTaskOutputImageSlideIds,
  sanitizePptxFileName,
  toEditableSlidesFromPlans,
  toPptxImageData,
} from './pptxExport'

describe('pptxExport', () => {
  it('sanitizes pptx file names', () => {
    expect(sanitizePptxFileName(' A/B:C* deck... ')).toBe('A-B-C- deck')
    expect(ensurePptxExtension('deck')).toBe('deck.pptx')
    expect(ensurePptxExtension('deck.PPTX')).toBe('deck.PPTX')
  })

  it('collects task output images newest first', () => {
    expect(getTaskOutputImageSlideIds([
      { id: 'old', createdAt: 1, outputImages: ['a', 'b'] },
      { id: 'new', createdAt: 3, outputImages: ['c'] },
      { id: 'empty', createdAt: 2, outputImages: [] },
    ])).toEqual(['c', 'a', 'b'])
  })

  it('normalizes data urls for pptxgenjs', () => {
    expect(toPptxImageData('data:image/png;base64,abc')).toBe('image/png;base64,abc')
    expect(toPptxImageData('image/png;base64,abc')).toBe('image/png;base64,abc')
  })

  it('creates editable slide specs from prompt plans', () => {
    const slides = toEditableSlidesFromPlans([
      { index: 1, title: '总览', content: '总览\n- 第一条\n- 第二条' },
      { index: 2, title: '行动', content: '行动\n- 下一步' },
    ])

    expect(slides).toEqual([
      { index: 1, title: '总览', content: '总览\n- 第一条\n- 第二条', notes: '总览\n- 第一条\n- 第二条' },
      { index: 2, title: '行动', content: '行动\n- 下一步', notes: '行动\n- 下一步' },
    ])
    expect(() => createEditableSlidesPptx(slides, '测试')).not.toThrow()
  })
})
