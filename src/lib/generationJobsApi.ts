import { GENERATION_JOBS_API_BASE_URL, getStoredAuthToken } from './authApi'

export interface ServerGenerationJob {
  id: string
  status: string
  provider?: string
  provider_task_id?: string
  requested_count: number
  received_count: number
  result_json?: string | null
  error_message?: string | null
  updated_at: number
  finished_at?: number | null
  assets?: Array<{ id: string; assetUrl: string; mime_type?: string; byte_size?: number }>
}

export interface ArchivedServerImage {
  sourceUrl: string
  dataUrl: string
}

export interface ArchivedServerResult {
  images: ArchivedServerImage[]
  warnings: string[]
}

async function requestJson(path: string, init: RequestInit = {}) {
  const token = getStoredAuthToken()
  if (!token) return null
  const response = await fetch(`${GENERATION_JOBS_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  })
  const data = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    const error = new Error(typeof data.message === 'string' ? data.message : `Generation job request failed: HTTP ${response.status}`)
    ;(error as Error & { status?: number }).status = response.status
    throw error
  }
  return data
}

export async function createServerGenerationJob(input: {
  id: string
  requestedCount: number
  provider?: string
}): Promise<ServerGenerationJob | null> {
  const data = await requestJson('/', { method: 'POST', body: JSON.stringify(input) })
  return (data?.job as ServerGenerationJob | undefined) ?? null
}

export async function updateServerGenerationJob(id: string, patch: Record<string, unknown>): Promise<ServerGenerationJob | null> {
  const data = await requestJson(`/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })
  return (data?.job as ServerGenerationJob | undefined) ?? null
}

export async function getServerGenerationJob(id: string): Promise<ServerGenerationJob | null> {
  const data = await requestJson(`/${encodeURIComponent(id)}`)
  return (data?.job as ServerGenerationJob | undefined) ?? null
}

export async function listRecoverableServerGenerationJobs(): Promise<ServerGenerationJob[]> {
  const data = await requestJson('/recoverable')
  return Array.isArray(data?.jobs) ? data.jobs as ServerGenerationJob[] : []
}

export async function archiveServerGenerationImages(id: string, sourceUrls: string[]): Promise<ArchivedServerResult> {
  const data = await requestJson(`/${encodeURIComponent(id)}/archive`, {
    method: 'POST',
    body: JSON.stringify({ sourceUrls }),
  })
  if (!data) return { images: [], warnings: ['请先登录 Macode 账号以启用服务器图片归档'] }
  const images = Array.isArray(data.images) ? data.images : []
  const errors = Array.isArray(data.errors) ? data.errors : []
  const archivedImages = await downloadArchivedAssets(images)
  return {
    images: archivedImages,
    warnings: errors.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const message = (item as { error?: unknown }).error
      return typeof message === 'string' && message.trim() ? [message] : []
    }),
  }
}

async function downloadArchivedAssets(images: unknown[]): Promise<ArchivedServerImage[]> {
  const token = getStoredAuthToken()
  const results = await Promise.all(images.map(async (item) => {
    if (!item || typeof item !== 'object') return null
    const assetUrl = (item as { assetUrl?: unknown }).assetUrl
    const sourceUrl = (item as { sourceUrl?: unknown }).sourceUrl
    if (typeof assetUrl !== 'string') return null
    const response = await fetch(`${GENERATION_JOBS_API_BASE_URL}${assetUrl}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) throw new Error(`Archived image download failed: HTTP ${response.status}`)
    const blob = await response.blob()
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(reader.error || new Error('Failed to read archived image'))
      reader.readAsDataURL(blob)
    })
    return { sourceUrl: typeof sourceUrl === 'string' ? sourceUrl : '', dataUrl }
  }))
  return results.filter((value): value is ArchivedServerImage => Boolean(value?.dataUrl.startsWith('data:image/')))
}

export async function downloadServerGenerationJobImages(job: ServerGenerationJob): Promise<string[]> {
  return (await downloadArchivedAssets(Array.isArray(job.assets) ? job.assets : [])).map((image) => image.dataUrl)
}
