import { describe, expect, it } from 'vitest'
import {
  getConstrainedReferenceImageSize,
  getReferenceRequestTimeoutSeconds,
  MAX_REFERENCE_IMAGES,
  MIN_REFERENCE_REQUEST_TIMEOUT_SECONDS,
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
})
