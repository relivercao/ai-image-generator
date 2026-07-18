import crypto from 'node:crypto'
import express from 'express'

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
  const jobs = new Map()
  const dedupeJobs = new Map()
  let cachedResultBytes = 0

  const removeJob = (job) => {
    if (!jobs.delete(job.id)) return
    if (job.dedupeKey && dedupeJobs.get(job.dedupeKey) === job.id) dedupeJobs.delete(job.dedupeKey)
    cachedResultBytes = Math.max(0, cachedResultBytes - (job.body?.byteLength || 0))
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
      job.status = 'completed'
      job.updatedAt = Date.now()
      cachedResultBytes += body.byteLength
      cleanupJobs()
    } catch (error) {
      job.status = 'failed'
      job.error = error instanceof Error ? error.message : String(error)
      job.updatedAt = Date.now()
    } finally {
      clearTimeout(timeout)
      job.requestBody = null
      job.requestHeaders = null
    }
  }

  const router = express.Router()
  const rawBody = express.raw({ type: () => true, limit: maxRequestBytes })

  for (const apiPath of ['images/edits', 'images/generations']) {
    router.post(`/${apiPath}`, rawBody, (req, res) => {
      cleanupJobs()
      const requestBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '')
      const idempotencyKey = String(req.get('idempotency-key') || '').trim()
      const authorizationHash = sha256(String(req.get('authorization') || ''))
      const dedupeKey = idempotencyKey ? sha256(`${authorizationHash}\0${apiPath}\0${idempotencyKey}`) : null
      const requestFingerprint = createRequestFingerprint(req.get('content-type') || '', requestBody)

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

      void runUpstreamRequest(job)
      res.status(202).json({ ...publicJob(job), pollToken: job.pollToken })
    })
  }

  router.get('/jobs/:jobId', (req, res) => {
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

  router.get('/jobs/:jobId/result', (req, res) => {
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
      for (const job of jobs.values()) removeJob(job)
    },
  }
}
