import type { ApiProfile, AppSettings } from '../types'
import { DEFAULT_RESPONSES_MODEL, getActiveApiProfile, normalizeSettings } from './apiProfiles'

export type PptGenerationMode = 'gpt55' | 'current'
export const PPT_RECOMMENDED_RESPONSES_SIZE = '1536x1024'
export const PPT_RECOMMENDED_TIMEOUT_SECONDS = 600

export interface PptGenerationApiSettings {
  settings: AppSettings
  profile: ApiProfile
  usingRecommendedModel: boolean
}

export function buildPptGenerationApiSettings(
  settings: AppSettings,
  mode: PptGenerationMode,
): PptGenerationApiSettings {
  const normalized = normalizeSettings(settings)
  const activeProfile = getActiveApiProfile(normalized)

  if (mode !== 'gpt55' || activeProfile.provider !== 'openai') {
    return {
      settings: normalized,
      profile: activeProfile,
      usingRecommendedModel: false,
    }
  }

  const profiles = normalized.profiles.map((profile) =>
    profile.id === normalized.activeProfileId
      ? {
          ...profile,
          apiMode: 'responses' as const,
          model: DEFAULT_RESPONSES_MODEL,
          timeout: Math.max(profile.timeout, PPT_RECOMMENDED_TIMEOUT_SECONDS),
          streamImages: true,
          streamPartialImages: Math.max(profile.streamPartialImages ?? 2, 2),
        }
      : profile,
  )
  const nextSettings = normalizeSettings({
    ...normalized,
    apiMode: 'responses',
    model: DEFAULT_RESPONSES_MODEL,
    streamImages: true,
    profiles,
  })

  return {
    settings: nextSettings,
    profile: getActiveApiProfile(nextSettings),
    usingRecommendedModel: true,
  }
}
