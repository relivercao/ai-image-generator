import { describe, expect, it } from 'vitest'
import { createDefaultFalProfile, createDefaultOpenAIProfile, DEFAULT_RESPONSES_MODEL, normalizeSettings } from './apiProfiles'
import { buildPptGenerationApiSettings, PPT_RECOMMENDED_TIMEOUT_SECONDS } from './pptApiSettings'

describe('pptApiSettings', () => {
  it('uses Responses image generation with gpt-5.5 for OpenAI profiles by default', () => {
    const baseProfile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      model: 'gpt-image-2',
      apiMode: 'images',
      streamImages: false,
      timeout: 60,
    })
    const settings = normalizeSettings({
      profiles: [baseProfile],
      activeProfileId: baseProfile.id,
    })

    const result = buildPptGenerationApiSettings(settings, 'gpt55')

    expect(result.usingRecommendedModel).toBe(true)
    expect(result.profile.provider).toBe('openai')
    expect(result.profile.apiMode).toBe('responses')
    expect(result.profile.model).toBe(DEFAULT_RESPONSES_MODEL)
    expect(result.profile.timeout).toBe(PPT_RECOMMENDED_TIMEOUT_SECONDS)
    expect(result.profile.streamImages).toBe(true)
    expect(result.profile.streamPartialImages).toBe(2)
  })

  it('preserves a longer user timeout for the recommended channel', () => {
    const baseProfile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      timeout: 900,
    })
    const settings = normalizeSettings({
      profiles: [baseProfile],
      activeProfileId: baseProfile.id,
    })

    const result = buildPptGenerationApiSettings(settings, 'gpt55')

    expect(result.profile.timeout).toBe(900)
  })

  it('keeps the current OpenAI profile when requested', () => {
    const baseProfile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      model: 'gpt-image-2',
      apiMode: 'images',
    })
    const settings = normalizeSettings({
      profiles: [baseProfile],
      activeProfileId: baseProfile.id,
    })

    const result = buildPptGenerationApiSettings(settings, 'current')

    expect(result.usingRecommendedModel).toBe(false)
    expect(result.profile.apiMode).toBe('images')
    expect(result.profile.model).toBe('gpt-image-2')
  })

  it('does not force non-OpenAI providers onto Responses mode', () => {
    const falProfile = createDefaultFalProfile({ apiKey: 'fal-key' })
    const settings = normalizeSettings({
      profiles: [falProfile],
      activeProfileId: falProfile.id,
    })

    const result = buildPptGenerationApiSettings(settings, 'gpt55')

    expect(result.usingRecommendedModel).toBe(false)
    expect(result.profile.provider).toBe('fal')
    expect(result.profile.apiMode).toBe('images')
    expect(result.profile.model).toBe(falProfile.model)
  })
})
