import { describe, expect, it } from 'vitest'
import {
  createEditableSlidesPptx,
  createGordenSkillEditablePptx,
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
  it('creates a Gorden Super PPT layered editable deck', () => {
    const onePixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l8UQ8QAAAABJRU5ErkJggg=='

    expect(() => createGordenSkillEditablePptx([{
      index: 1,
      title: 'Layered slide',
      sourceImage: onePixelPng,
      backgroundImage: onePixelPng,
      frameImage: onePixelPng,
      iconsImage: onePixelPng,
      icons: [{ dataUrl: onePixelPng, x: 0.2, y: 0.2, w: 0.08, h: 0.08, role: 'icon' }],
      texts: [{
        text: 'Editable text',
        x: 0.1,
        y: 0.1,
        w: 0.4,
        h: 0.12,
        sizeRatio: 0.04,
        color: '#111111',
        bold: true,
      }],
    }], 'Gorden')).not.toThrow()
  })
})
