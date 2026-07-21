import crypto from 'node:crypto'
import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_JOB_TTL_MS = 60 * 60 * 1000
const DEFAULT_UPSTREAM_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_MAX_REQUEST_BYTES = 80 * 1024 * 1024
const DEFAULT_MAX_RESULT_BYTES = 200 * 1024 * 1024
const DEFAULT_MAX_CACHED_RESULT_BYTES = 512 * 1024 * 1024

const REQUEST_HEADERS_TO_SKIP = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'cookie',
  'host',
  'origin',
  'referer',
  'transfer-encoding',
])

const RESPONSE_HEADERS_TO_SKIP = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'set-cookie',
  'transfer-encoding',
])

function positiveNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function createRequestFingerprint(contentType, requestBody) {
  if (/^multipart\/form-data\b/i.test(contentType)) return null
  return crypto.createHash('sha256')
    .update(contentType.split(';', 1)[0].trim().toLowerCase())
    .update('\0')
    .update(requestBody)
    .digest('hex')
}

const REQUEST_SUMMARY_FIELDS = [
  'model',
  'size',
  'quality',
  'output_format',
  'moderation',
  'n',
  'response_format',
  'stream',
  'partial_images',
]

function compactScalar(value, maxLength = 120) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined
  const normalized = String(value)
  return normalized ? normalized.slice(0, maxLength) : undefined
}

async function createRequestSummary(apiPath, contentType, requestBody) {
  const summary = {
    apiPath,
    requestBytes: requestBody.byteLength,
    contentType: contentType.split(';', 1)[0].trim().toLowerCase() || 'unknown',
  }

  try {
    if (/^multipart\/form-data\b/i.test(contentType)) {
      const request = new Request('http://durable-proxy.local/request', {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: requestBody,
      })
      const formData = await request.formData()
      const fields = {}
      for (const name of REQUEST_SUMMARY_FIELDS) {
        fields[name] = compactScalar(formData.get(name))
      }
      const prompt = formData.get('prompt')
      const files = []
      for (const [field, value] of formData.entries()) {
        if (typeof value === 'string') continue
        files.push({
          field: field.slice(0, 40),
          type: compactScalar(value.type, 80) || 'application/octet-stream',
          bytes: value.size,
        })
      }
      return {
        ...summary,
        fields,
        promptChars: typeof prompt === 'string' ? prompt.length : 0,
        promptUtf8Bytes: typeof prompt === 'string' ? Buffer.byteLength(prompt, 'utf8') : 0,
        imageCount: files.filter((file) => file.field === 'image' || file.field.startsWith('image[')).length,
        maskCount: files.filter((file) => file.field === 'mask').length,
        files,
      }
    }

    if (/^application\/json\b/i.test(contentType)) {
      const payload = JSON.parse(requestBody.toString('utf8'))
      const fields = {}
      for (const name of REQUEST_SUMMARY_FIELDS) fields[name] = compactScalar(payload?.[name])
      return {
        ...summary,
        fields,
        promptChars: typeof payload?.prompt === 'string' ? payload.prompt.length : 0,
        promptUtf8Bytes: typeof payload?.prompt === 'string' ? Buffer.byteLength(payload.prompt, 'utf8') : 0,
        imageCount: 0,
        maskCount: 0,
        files: [],
      }
    }
  } catch (error) {
    return {
      ...summary,
      parseError: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    }
  }

  return summary
}

function buildUpstreamUrl(apiProxyUrl, apiPath, originalUrl) {
  const baseUrl = new URL(apiProxyUrl.endsWith('/') ? apiProxyUrl : `${apiProxyUrl}/`)
  const target = new URL(apiPath.replace(/^\/+/, ''), baseUrl)
  const requestUrl = new URL(originalUrl, 'http://durable-proxy.local')
  target.search = requestUrl.search
  return target
}

function copyRequestHeaders(headers) {
  const forwarded = new Headers()
  for (const [name, rawValue] of Object.entries(headers)) {
    const lowerName = name.toLowerCase()
    if (REQUEST_HEADERS_TO_SKIP.has(lowerName) || lowerName.startsWith('sec-') || lowerName.startsWith('x-forwarded-')) continue
    if (rawValue == null) continue
    forwarded.set(name, Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue))
  }
  return forwarded
}

function copyResponseHeaders(headers) {
  const copied = []
  headers.forEach((value, name) => {
    if (!RESPONSE_HEADERS_TO_SKIP.has(name.toLowerCase())) copied.push([name, value])
  })
  return copied
}

async function readResponseBody(response, maxBytes) {
  const declaredSize = Number(response.headers.get('content-length') || 0)
  if (declaredSize > maxBytes) throw new Error('Upstream image response exceeds the durable proxy size limit')
  if (!response.body) return Buffer.alloc(0)

  const chunks = []
  let byteLength = 0
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > maxBytes) {
        await reader.cancel()
        throw new Error('Upstream image response exceeds the durable proxy size limit')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, byteLength)
}

function publicJob(job) {
  return {
    jobId: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.status === 'completed' ? { upstreamStatus: job.upstreamStatus } : {}),
    ...(job.status === 'failed' ? { error: job.error } : {}),
  }
}

function hasValidPollToken(req, job) {
  const token = req.get('x-generation-poll-token') || ''
  if (!token || token.length !== job.pollToken.length) return false
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(job.pollToken))
}

export function createDurableImageProxyRouter(options = {}) {
  const apiProxyUrl = options.apiProxyUrl || process.env.API_PROXY_URL || 'https://www.macode.cloud/v1'
  const upstreamTimeoutMs = positiveNumber(
    options.upstreamTimeoutMs ?? process.env.DURABLE_PROXY_UPSTREAM_TIMEOUT_MS,
    DEFAULT_UPSTREAM_TIMEOUT_MS,
  )
  const jobTtlMs = positiveNumber(options.jobTtlMs ?? process.env.DURABLE_PROXY_JOB_TTL_MS, DEFAULT_JOB_TTL_MS)
  const maxRequestBytes = positiveNumber(
    options.maxRequestBytes ?? process.env.DURABLE_PROXY_MAX_REQUEST_BYTES,
    DEFAULT_MAX_REQUEST_BYTES,
  )
  const maxResultBytes = positiveNumber(
    options.maxResultBytes ?? process.env.DURABLE_PROXY_MAX_RESULT_BYTES,
    DEFAULT_MAX_RESULT_BYTES,
  )
  const maxCachedResultBytes = Math.max(maxResultBytes, positiveNumber(
    options.maxCachedResultBytes ?? process.env.DURABLE_PROXY_MAX_CACHED_RESULT_BYTES,
    DEFAULT_MAX_CACHED_RESULT_BYTES,
  ))
  const fetchImpl = options.fetchImpl || fetch
  const storageDir = options.storageDir === false
    ? null
    : path.resolve(options.storageDir || process.env.DURABLE_PROXY_STORAGE_DIR || path.join(process.cwd(), 'data', 'durable-image-proxy'))
  const jobs = new Map()
  const dedupeJobs = new Map()
  let cachedResultBytes = 0

  const metadataPath = (jobId) => storageDir ? path.join(storageDir, `${jobId}.json`) : null
  const bodyPath = (jobId) => storageDir ? path.join(storageDir, `${jobId}.body`) : null

  const persistJob = async (job, writeBody = false) => {
    if (!storageDir) return
    await fs.mkdir(storageDir, { recursive: true, mode: 0o700 })
    if (writeBody && job.body) await fs.writeFile(bodyPath(job.id), job.body, { mode: 0o600 })
    await fs.writeFile(metadataPath(job.id), JSON.stringify({
      id: job.id,
      pollToken: job.pollToken,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      dedupeKey: job.dedupeKey,
      requestFingerprint: job.requestFingerprint,
      requestSummary: job.requestSummary,
      upstreamStatus: job.upstreamStatus,
      responseHeaders: job.responseHeaders,
      error: job.error,
      hasBody: Boolean(job.body),
    }), { mode: 0o600 })
  }

  const removePersistedJob = (jobId) => {
    if (!storageDir) return
    void Promise.all([
      fs.rm(metadataPath(jobId), { force: true }),
      fs.rm(bodyPath(jobId), { force: true }),
    ]).catch((error) => console.error(`Failed to remove durable image job ${jobId}:`, error))
  }

  const removeJob = (job) => {
    if (!jobs.delete(job.id)) return
    if (job.dedupeKey && dedupeJobs.get(job.dedupeKey) === job.id) dedupeJobs.delete(job.dedupeKey)
    cachedResultBytes = Math.max(0, cachedResultBytes - (job.body?.byteLength || 0))
    removePersistedJob(job.id)
  }

  const cleanupJobs = () => {
    const now = Date.now()
    for (const job of jobs.values()) {
      if (job.status !== 'processing' && now - job.updatedAt >= jobTtlMs) removeJob(job)
    }

    if (cachedResultBytes <= maxCachedResultBytes) return
    const completed = [...jobs.values()]
      .filter((job) => job.status === 'completed')
      .sort((left, right) => left.updatedAt - right.updatedAt)
    for (const job of completed) {
      if (cachedResultBytes <= maxCachedResultBytes) break
      removeJob(job)
    }
  }

  const cleanupTimer = setInterval(cleanupJobs, Math.min(jobTtlMs, 60_000))
  cleanupTimer.unref?.()

  const loadPersistedJobs = async () => {
    if (!storageDir) return
    await fs.mkdir(storageDir, { recursive: true, mode: 0o700 })
    const entries = await fs.readdir(storageDir, { withFileTypes: true })
    const now = Date.now()
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const filePath = path.join(storageDir, entry.name)
      try {
        const stored = JSON.parse(await fs.readFile(filePath, 'utf8'))
        if (!stored.id || !stored.pollToken || !stored.status || !stored.createdAt || !stored.updatedAt) throw new Error('invalid metadata')
        if (now - Number(stored.updatedAt) >= jobTtlMs) {
          removePersistedJob(stored.id)
          continue
        }

        const job = {
          id: String(stored.id),
          pollToken: String(stored.pollToken),
          status: stored.status === 'processing' ? 'failed' : stored.status,
          createdAt: Number(stored.createdAt),
          updatedAt: Number(stored.updatedAt),
          dedupeKey: stored.dedupeKey || null,
          requestFingerprint: stored.requestFingerprint || null,
          requestSummary: stored.requestSummary || null,
          requestHeaders: null,
          requestBody: null,
          upstreamUrl: null,
          upstreamStatus: stored.upstreamStatus == null ? null : Number(stored.upstreamStatus),
          responseHeaders: Array.isArray(stored.responseHeaders) ? stored.responseHeaders : [],
          body: null,
          error: stored.status === 'processing'
            ? '服务端在上游请求完成前发生重启；为避免重复计费，本次任务不会自动重新提交'
            : stored.error || null,
        }
        if (job.status === 'completed' && stored.hasBody) job.body = await fs.readFile(bodyPath(job.id))
        if (job.status === 'completed' && !job.body) throw new Error('completed result body is missing')

        jobs.set(job.id, job)
        if (job.dedupeKey) dedupeJobs.set(job.dedupeKey, job.id)
        cachedResultBytes += job.body?.byteLength || 0
        if (stored.status === 'processing') await persistJob(job)
      } catch (error) {
        console.error(`Ignoring invalid durable image job metadata ${entry.name}:`, error)
        const jobId = entry.name.slice(0, -'.json'.length)
        removePersistedJob(jobId)
      }
    }
    cleanupJobs()
  }

  const ready = loadPersistedJobs().catch((error) => {
    console.error('Failed to load durable image jobs; continuing with memory-only storage:', error)
  })

  const runUpstreamRequest = async (job) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('Upstream image request timed out')), upstreamTimeoutMs)
    timeout.unref?.()
    try {
      const response = await fetchImpl(job.upstreamUrl, {
        method: 'POST',
        headers: job.requestHeaders,
        body: job.requestBody,
        redirect: 'manual',
        signal: controller.signal,
      })
      const body = await readResponseBody(response, maxResultBytes)
      job.upstreamStatus = response.status
      job.responseHeaders = copyResponseHeaders(response.headers)
      job.body = body
      job.updatedAt = Date.now()
      cachedResultBytes += body.byteLength
      await persistJob({ ...job, status: 'completed' }, true)
        .catch((error) => console.error(`Failed to persist durable image job ${job.id}:`, error))
      job.status = 'completed'
      cleanupJobs()
    } catch (error) {
      job.status = 'failed'
      job.error = error instanceof Error ? error.message : String(error)
      job.updatedAt = Date.now()
      await persistJob(job).catch((persistError) => console.error(`Failed to persist durable image job ${job.id}:`, persistError))
    } finally {
      clearTimeout(timeout)
      job.requestBody = null
      job.requestHeaders = null
    }
  }

  const router = express.Router()
  const rawBody = express.raw({ type: () => true, limit: maxRequestBytes })

  for (const apiPath of ['images/edits', 'images/generations']) {
    router.post(`/${apiPath}`, rawBody, async (req, res) => {
      await ready
      cleanupJobs()
      const requestBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '')
      const idempotencyKey = String(req.get('idempotency-key') || '').trim()
      const authorizationHash = sha256(String(req.get('authorization') || ''))
      const dedupeKey = idempotencyKey ? sha256(`${authorizationHash}\0${apiPath}\0${idempotencyKey}`) : null
      const requestFingerprint = createRequestFingerprint(req.get('content-type') || '', requestBody)
      const requestSummary = await createRequestSummary(apiPath, req.get('content-type') || '', requestBody)

      if (dedupeKey) {
        const existingJob = jobs.get(dedupeJobs.get(dedupeKey))
        if (existingJob) {
          if (existingJob.requestFingerprint && requestFingerprint && existingJob.requestFingerprint !== requestFingerprint) {
            res.status(409).json({ error: 'Idempotency key was reused with a different image request' })
            return
          }
          res.status(existingJob.status === 'completed' ? 200 : 202).json({
            ...publicJob(existingJob),
            pollToken: existingJob.pollToken,
          })
          return
        }
      }

      const now = Date.now()
      const job = {
        id: crypto.randomUUID(),
        pollToken: crypto.randomBytes(24).toString('base64url'),
        status: 'processing',
        createdAt: now,
        updatedAt: now,
        dedupeKey,
        requestFingerprint,
        requestSummary,
        requestHeaders: copyRequestHeaders(req.headers),
        requestBody: Buffer.from(requestBody),
        upstreamUrl: buildUpstreamUrl(apiProxyUrl, apiPath, req.originalUrl),
        upstreamStatus: null,
        responseHeaders: [],
        body: null,
        error: null,
      }
      jobs.set(job.id, job)
      if (dedupeKey) dedupeJobs.set(dedupeKey, job.id)

      await persistJob(job).catch((error) => console.error(`Failed to persist durable image job ${job.id}:`, error))
      void runUpstreamRequest(job)
      res.status(202).json({ ...publicJob(job), pollToken: job.pollToken })
    })
  }

  router.get('/jobs/:jobId', async (req, res) => {
    await ready
    cleanupJobs()
    const job = jobs.get(req.params.jobId)
    if (!job) {
      res.status(404).json({ error: 'Image generation job was not found or has expired' })
      return
    }
    if (!hasValidPollToken(req, job)) {
      res.status(403).json({ error: 'Invalid image generation poll token' })
      return
    }
    res.setHeader('Cache-Control', 'no-store')
    res.json(publicJob(job))
  })

  router.get('/jobs/:jobId/result', async (req, res) => {
    await ready
    cleanupJobs()
    const job = jobs.get(req.params.jobId)
    if (!job) {
      res.status(404).json({ error: 'Image generation job was not found or has expired' })
      return
    }
    if (!hasValidPollToken(req, job)) {
      res.status(403).json({ error: 'Invalid image generation poll token' })
      return
    }
    if (job.status === 'failed') {
      res.status(502).json({ error: job.error || 'Upstream image request failed' })
      return
    }
    if (job.status !== 'completed') {
      res.status(409).json({ error: 'Image generation job is still processing' })
      return
    }

    for (const [name, value] of job.responseHeaders) res.setHeader(name, value)
    res.setHeader('Cache-Control', 'no-store')
    res.status(job.upstreamStatus).send(job.body)
  })

  return {
    router,
    close() {
      clearInterval(cleanupTimer)
      jobs.clear()
      dedupeJobs.clear()
      cachedResultBytes = 0
    },
  }
}
