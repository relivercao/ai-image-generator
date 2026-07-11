export const AUTH_TOKEN_STORAGE_KEY = 'macodeAuthToken'
export const AUTH_USER_STORAGE_KEY = 'macodeAuthUser'
export const USER_API_KEY_STORAGE_KEY = 'userApiKey'
export const AUTO_API_KEY_STORAGE_KEY = 'macodeAutoApiKey'
export const MACODE_AUTH_REQUIRED_EVENT = 'macodeAuthRequired'
export const USER_API_KEY_UPDATED_EVENT = 'userApiKeyUpdated'

function normalizeAuthBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '')
  return trimmed || '/api'
}

function getDefaultAuthBaseUrl() {
  const baseUrl = typeof import.meta.env.BASE_URL === 'string' ? import.meta.env.BASE_URL : '/'
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  return normalizedBaseUrl ? `${normalizedBaseUrl}/api` : '/api'
}

export const AUTH_API_BASE_URL = normalizeAuthBaseUrl(
  import.meta.env.VITE_AUTH_API_BASE_URL || import.meta.env.VITE_API_BASE_URL || getDefaultAuthBaseUrl(),
)

export const AUTH_ENDPOINTS = {
  login: `${AUTH_API_BASE_URL}/auth/login`,
  register: `${AUTH_API_BASE_URL}/auth/register`,
  verify: `${AUTH_API_BASE_URL}/auth/verify`,
  apiKey: `${AUTH_API_BASE_URL}/auth/api-key`,
}

export function requestMacodeAuth() {
  window.dispatchEvent(new CustomEvent(MACODE_AUTH_REQUIRED_EVENT))
}
