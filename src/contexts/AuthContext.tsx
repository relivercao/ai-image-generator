import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  AUTH_ENDPOINTS,
  AUTH_TOKEN_STORAGE_KEY,
  AUTH_USER_STORAGE_KEY,
  AUTO_API_KEY_STORAGE_KEY,
  USER_API_KEY_STORAGE_KEY,
  USER_API_KEY_UPDATED_EVENT,
} from '../lib/authApi'

export interface AuthUser {
  id: string
  username: string
  email?: string
  displayName?: string
  role?: number
}

interface AuthContextValue {
  user: AuthUser | null
  isLoading: boolean
  login: (identifier: string, password: string) => Promise<void>
  register: (username: string, password: string, email?: string) => Promise<void>
  refreshApiKey: () => Promise<string>
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)
const AUTH_REQUEST_TIMEOUT_MS = 15_000

function readStoredUser(): AuthUser | null {
  const raw = localStorage.getItem(AUTH_USER_STORAGE_KEY)
  if (!raw) return null

  try {
    return JSON.parse(raw) as AuthUser
  } catch {
    localStorage.removeItem(AUTH_USER_STORAGE_KEY)
    return null
  }
}

async function readJsonResponse(response: Response) {
  const text = await response.text()
  if (!text) return {}

  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return { message: text }
  }
}

async function fetchAuthJson(url: string, init?: RequestInit) {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      signal: init?.signal ?? controller.signal,
    })
  } catch (error) {
    console.warn('Macode auth request failed:', error)
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('登录服务响应超时，请稍后重试。')
    }
    throw new Error('登录服务暂时不可达，请稍后重试。')
  } finally {
    window.clearTimeout(timeout)
  }

  const data = await readJsonResponse(response)

  if (!response.ok) {
    const message = typeof data.message === 'string'
      ? data.message
      : typeof data.error === 'string'
      ? data.error
      : '请求失败'
    const error = new Error(message)
    ;(error as Error & { status?: number }).status = response.status
    throw error
  }

  return data
}

function saveSession(token: string, user: AuthUser) {
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token)
  localStorage.setItem(AUTH_USER_STORAGE_KEY, JSON.stringify(user))
}

function clearSyncedApiKey() {
  const syncedKey = localStorage.getItem(AUTO_API_KEY_STORAGE_KEY)
  const currentKey = localStorage.getItem(USER_API_KEY_STORAGE_KEY)

  if (syncedKey && currentKey === syncedKey) {
    localStorage.removeItem(USER_API_KEY_STORAGE_KEY)
    window.dispatchEvent(new CustomEvent(USER_API_KEY_UPDATED_EVENT))
  }

  localStorage.removeItem(AUTO_API_KEY_STORAGE_KEY)
}

function clearSession() {
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY)
  localStorage.removeItem(AUTH_USER_STORAGE_KEY)
  clearSyncedApiKey()
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => readStoredUser())
  const [isLoading, setIsLoading] = useState(true)

  const refreshApiKey = useCallback(async () => {
    const token = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)
    if (!token) return ''

    const data = await fetchAuthJson(AUTH_ENDPOINTS.apiKey, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    const apiKey = typeof data.apiKey === 'string' ? data.apiKey : ''
    if (apiKey) {
      localStorage.setItem(USER_API_KEY_STORAGE_KEY, apiKey)
      localStorage.setItem(AUTO_API_KEY_STORAGE_KEY, apiKey)
      window.dispatchEvent(new CustomEvent(USER_API_KEY_UPDATED_EVENT))
    } else {
      clearSyncedApiKey()
    }

    return apiKey
  }, [])

  const logout = useCallback(() => {
    clearSession()
    setUser(null)
  }, [])

  useEffect(() => {
    let cancelled = false

    async function verifyStoredSession() {
      const token = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)
      if (!token) {
        if (!cancelled) setIsLoading(false)
        return
      }

      try {
        const data = await fetchAuthJson(AUTH_ENDPOINTS.verify, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        })
        const verifiedUser = data.user as AuthUser
        if (!verifiedUser?.id) throw new Error('Invalid user session')
        saveSession(token, verifiedUser)
        if (!cancelled) setUser(verifiedUser)
        await refreshApiKey()
      } catch (error) {
        console.warn('Failed to verify macode session:', error)
        const status = error && typeof error === 'object' && 'status' in error
          ? Number((error as { status?: unknown }).status)
          : 0
        if (status === 401 || status === 403) {
          clearSession()
          if (!cancelled) setUser(null)
        } else if (!cancelled) {
          setUser(readStoredUser())
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void verifyStoredSession()
    return () => {
      cancelled = true
    }
  }, [refreshApiKey])

  const login = useCallback(async (identifier: string, password: string) => {
    const data = await fetchAuthJson(AUTH_ENDPOINTS.login, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, username: identifier, password }),
    })

    const token = typeof data.token === 'string' ? data.token : ''
    const nextUser = data.user as AuthUser
    if (!token || !nextUser?.id) throw new Error('登录响应无效')

    saveSession(token, nextUser)
    setUser(nextUser)
    await refreshApiKey()
  }, [refreshApiKey])

  const register = useCallback(async (username: string, password: string, email = '') => {
    const data = await fetchAuthJson(AUTH_ENDPOINTS.register, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, email }),
    })

    const token = typeof data.token === 'string' ? data.token : ''
    const nextUser = data.user as AuthUser
    if (!token || !nextUser?.id) throw new Error('注册响应无效')

    saveSession(token, nextUser)
    setUser(nextUser)
    await refreshApiKey()
  }, [refreshApiKey])

  const value = useMemo<AuthContextValue>(() => ({
    user,
    isLoading,
    login,
    register,
    refreshApiKey,
    logout,
  }), [isLoading, login, logout, refreshApiKey, register, user])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider')
  return context
}
