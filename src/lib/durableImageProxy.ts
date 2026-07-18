interface DurableJobSubmission {
  jobId: string
  pollToken: string
  status: 'processing' | 'completed' | 'failed'
  error?: string
}

interface DurableJobStatus {
  jobId: string
  status: 'processing' | 'completed' | 'failed'
  error?: string
}

interface DurableImageFetchOptions {
  pollIntervalMs?: number
  transientRetryDelayMs?: number
  maxTransientRetries?: number
  fetchImpl?: typeof fetch
}

const TRANSIENT_HTTP_STATUSES = new Set([502, 503, 504])

export function isDurableImageProxyEnabled(): boolean {
  return import.meta.env.VITE_DURABLE_IMAGE_PROXY === 'true'
}

export function buildDurableImageProxyUrl(url: string): string | null {
  if (!/(^|\/)api-proxy(?=\/|$)/.test(url)) return null
  return url.replace(/(^|\/)api-proxy(?=\/|$)/, '$1generation-proxy')
}

function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `image-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  if (!text) return `HTTP ${response.status}`
  try {
    const payload = JSON.parse(text) as { error?: string | { message?: string }; message?: string }
    if (typeof payload.error === 'string') return payload.error
    if (payload.error && typeof payload.error.message === 'string') return payload.error.message
    if (typeof payload.message === 'string') return payload.message
  } catch {
    // Plain-text proxy errors are returned as-is.
  }
  return text
}

async function fetchWithTransientRetries(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  options: Required<Pick<DurableImageFetchOptions, 'maxTransientRetries' | 'transientRetryDelayMs'>>,
  retryHttpStatuses: boolean,
): Promise<Response> {
  let failure: unknown
  for (let attempt = 0; attempt <= options.maxTransientRetries; attempt += 1) {
    try {
      const response = await fetchImpl(input, init)
      if (!retryHttpStatuses || !TRANSIENT_HTTP_STATUSES.has(response.status) || attempt === options.maxTransientRetries) {
        return response
      }
      failure = new Error(`HTTP ${response.status}`)
    } catch (error) {
      failure = error
      if (init.signal?.aborted || attempt === options.maxTransientRetries) throw error
    }
    await delay(options.transientRetryDelayMs * (attempt + 1), init.signal ?? undefined)
  }
  throw failure
}

async function fetchBufferedResultWithRetries(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  options: Required<Pick<DurableImageFetchOptions, 'maxTransientRetries' | 'transientRetryDelayMs'>>,
): Promise<Response> {
  for (let attempt = 0; attempt <= options.maxTransientRetries; attempt += 1) {
    try {
      const response = await fetchImpl(input, init)
      const body = await response.arrayBuffer()
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } catch (error) {
      if (init.signal?.aborted || attempt === options.maxTransientRetries) throw error
      await delay(options.transientRetryDelayMs * (attempt + 1), init.signal ?? undefined)
    }
  }
  throw new Error('无法读取服务端已完成的生图结果')
}

export async function fetchThroughDurableImageProxy(
  url: string,
  init: RequestInit,
  options: DurableImageFetchOptions = {},
): Promise<Response> {
  const durableUrl = buildDurableImageProxyUrl(url)
  if (!durableUrl) return (options.fetchImpl ?? fetch)(url, init)

  const fetchImpl = options.fetchImpl ?? fetch
  const pollIntervalMs = options.pollIntervalMs ?? 2_000
  const retryOptions = {
    maxTransientRetries: options.maxTransientRetries ?? 3,
    transientRetryDelayMs: options.transientRetryDelayMs ?? 750,
  }
  const headers = new Headers(init.headers)
  if (!headers.has('Idempotency-Key')) headers.set('Idempotency-Key', createIdempotencyKey())

  const submissionResponse = await fetchWithTransientRetries(fetchImpl, durableUrl, {
    ...init,
    headers,
    cache: 'no-store',
  }, retryOptions, true)
  if (!submissionResponse.ok) {
    throw new Error(await readErrorMessage(submissionResponse))
  }

  const submission = await submissionResponse.json() as DurableJobSubmission
  if (!submission.jobId || !submission.pollToken) throw new Error('持久生图代理返回了无效的任务信息')
  if (submission.status === 'failed') throw new Error(submission.error || '服务端生图任务失败')

  const jobBaseUrl = `${durableUrl.replace(/\/images\/(?:edits|generations)(?:\?.*)?$/, '')}/jobs/${encodeURIComponent(submission.jobId)}`
  const pollHeaders = {
    'X-Generation-Poll-Token': submission.pollToken,
    Accept: 'application/json',
  }

  let status = submission.status
  while (status !== 'completed') {
    await delay(pollIntervalMs, init.signal ?? undefined)
    const pollResponse = await fetchWithTransientRetries(fetchImpl, jobBaseUrl, {
      method: 'GET',
      headers: pollHeaders,
      cache: 'no-store',
      signal: init.signal,
    }, retryOptions, true)
    if (!pollResponse.ok) throw new Error(await readErrorMessage(pollResponse))

    const job = await pollResponse.json() as DurableJobStatus
    if (job.status === 'failed') throw new Error(job.error || '服务端生图任务失败')
    status = job.status
  }

  return fetchBufferedResultWithRetries(fetchImpl, `${jobBaseUrl}/result`, {
    method: 'GET',
    headers: { 'X-Generation-Poll-Token': submission.pollToken },
    cache: 'no-store',
    signal: init.signal,
  }, retryOptions)
}
