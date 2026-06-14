import { useCallback, useEffect } from 'react'
import { useStore } from '../store'
import { createDefaultOpenAIProfile, DEFAULT_OPENAI_PROFILE_ID, getActiveApiProfile, normalizeSettings } from '../lib/apiProfiles'
import {
  AUTO_API_KEY_STORAGE_KEY,
  USER_API_KEY_STORAGE_KEY,
  USER_API_KEY_UPDATED_EVENT,
} from '../lib/authApi'

const MACODE_OPENAI_BASE_URL = 'https://macode.cloud/v1'

export function useAutoConfigureApiKey() {
  const settings = useStore((state) => state.settings)
  const setSettings = useStore((state) => state.setSettings)

  const autoConfigureSettings = useCallback(() => {
    const userApiKey = localStorage.getItem(USER_API_KEY_STORAGE_KEY)
    const syncedKey = localStorage.getItem(AUTO_API_KEY_STORAGE_KEY)
    const normalized = normalizeSettings(settings)

    if (!userApiKey) {
      if (!syncedKey) return

      const nextProfiles = normalized.profiles.map((profile) =>
        profile.apiKey === syncedKey && profile.baseUrl.replace(/\/+$/, '') === MACODE_OPENAI_BASE_URL
          ? { ...profile, apiKey: '' }
          : profile,
      )

      if (nextProfiles.some((profile, index) => profile.apiKey !== normalized.profiles[index].apiKey)) {
        setSettings({ ...normalized, profiles: nextProfiles })
      }
      return
    }

    const activeProfile = getActiveApiProfile(normalized)
    const targetProfileId = activeProfile.provider === 'openai'
      ? activeProfile.id
      : normalized.profiles.some((profile) => profile.id === DEFAULT_OPENAI_PROFILE_ID)
      ? DEFAULT_OPENAI_PROFILE_ID
      : activeProfile.id

    let foundTarget = false
    const nextProfiles = normalized.profiles.map((profile) => {
      if (profile.id !== targetProfileId) return profile
      foundTarget = true
      return {
        ...profile,
        provider: 'openai',
        baseUrl: MACODE_OPENAI_BASE_URL,
        apiKey: userApiKey,
        apiProxy: false,
      }
    })

    if (!foundTarget) {
      nextProfiles.push(createDefaultOpenAIProfile({
        id: DEFAULT_OPENAI_PROFILE_ID,
        name: 'macode',
        baseUrl: MACODE_OPENAI_BASE_URL,
        apiKey: userApiKey,
        apiProxy: false,
      }))
    }

    const nextSettings = normalizeSettings({
      ...normalized,
      profiles: nextProfiles,
      activeProfileId: targetProfileId,
      baseUrl: MACODE_OPENAI_BASE_URL,
      apiKey: userApiKey,
      apiProxy: false,
    })

    const currentTarget = normalized.profiles.find((profile) => profile.id === targetProfileId)
    const needsUpdate =
      normalized.activeProfileId !== targetProfileId ||
      currentTarget?.apiKey !== userApiKey ||
      currentTarget?.baseUrl.replace(/\/+$/, '') !== MACODE_OPENAI_BASE_URL ||
      currentTarget?.provider !== 'openai' ||
      currentTarget?.apiProxy !== false

    if (needsUpdate) {
      setSettings(nextSettings)
    }
  }, [settings, setSettings])

  useEffect(() => {
    autoConfigureSettings()
  }, [autoConfigureSettings])

  useEffect(() => {
    const handleApiKeyUpdate = () => {
      window.setTimeout(autoConfigureSettings, 50)
    }

    window.addEventListener(USER_API_KEY_UPDATED_EVENT, handleApiKeyUpdate)
    window.addEventListener('storage', handleApiKeyUpdate)
    return () => {
      window.removeEventListener(USER_API_KEY_UPDATED_EVENT, handleApiKeyUpdate)
      window.removeEventListener('storage', handleApiKeyUpdate)
    }
  }, [autoConfigureSettings])
}
