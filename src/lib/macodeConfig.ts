import { readRuntimeEnv } from './runtimeEnv'

export const MACODE_DEFAULT_ORIGIN = 'https://www.macode.cloud'
export const MACODE_DEFAULT_API_BASE_URL = `${MACODE_DEFAULT_ORIGIN}/v1`

function normalizeHttpUrl(value: string | undefined, fallback: string): string {
  const trimmed = readRuntimeEnv(value).replace(/\/+$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : fallback
}

export const MACODE_API_BASE_URL = normalizeHttpUrl(
  import.meta.env.VITE_DEFAULT_API_URL,
  MACODE_DEFAULT_API_BASE_URL,
)

export const MACODE_QUEUE_BASE_URL = normalizeHttpUrl(
  import.meta.env.VITE_DEFAULT_QUEUE_URL,
  MACODE_DEFAULT_ORIGIN,
)
