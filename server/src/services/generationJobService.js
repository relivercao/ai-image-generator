import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import pool from '../config/generationDatabase.js'

const MAX_IMAGE_BYTES = Number(process.env.GENERATED_IMAGE_MAX_BYTES || 30 * 1024 * 1024)
const DOWNLOAD_TIMEOUT_MS = Number(process.env.GENERATED_IMAGE_DOWNLOAD_TIMEOUT_MS || 120_000)
const MAX_REDIRECTS = 4
const assetRoot = path.resolve(process.env.GENERATED_ASSET_DIR || path.join(process.cwd(), 'data', 'generated-images'))

const JOB_COLUMNS = new Set([
  'status',
  'provider',
  'provider_task_id',
  'requested_count',
  'received_count',
  'result_json',
  'error_message',
  'updated_at',
  'finished_at',
])

export async function ensureGenerationJobSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS image_generation_jobs (
    id VARCHAR(96) PRIMARY KEY,
    user_id BIGINT NOT NULL,
    status VARCHAR(32) NOT NULL,
    provider VARCHAR(64),
    provider_task_id VARCHAR(255),
    requested_count INTEGER NOT NULL DEFAULT 1,
    received_count INTEGER NOT NULL DEFAULT 0,
    result_json TEXT,
    error_message TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    finished_at BIGINT
  )`)
  await pool.query(`CREATE TABLE IF NOT EXISTS image_generation_assets (
    id VARCHAR(96) PRIMARY KEY,
    job_id VARCHAR(96) NOT NULL,
    user_id BIGINT NOT NULL,
    source_url TEXT,
    file_path TEXT NOT NULL,
    mime_type VARCHAR(128) NOT NULL,
    byte_size BIGINT NOT NULL,
    created_at BIGINT NOT NULL
  )`)
  await fs.mkdir(assetRoot, { recursive: true })
}

export async function createGenerationJob(userId, input) {
  const now = Date.now()
  const id = String(input.id || crypto.randomUUID()).slice(0, 96)
  const requestedCount = Math.max(1, Math.min(20, Number(input.requestedCount) || 1))
  const existing = await getGenerationJob(userId, id)
  if (existing) return existing

  await pool.query(
    `INSERT INTO image_generation_jobs
      (id, user_id, status, provider, requested_count, received_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    [id, userId, 'submitted', String(input.provider || '').slice(0, 64), requestedCount, now, now],
  )
  return getGenerationJob(userId, id)
}

export async function updateGenerationJob(userId, id, patch) {
  const entries = Object.entries(patch)
    .map(([key, value]) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), value])
    .filter(([key]) => JOB_COLUMNS.has(key))
  if (!entries.length) return getGenerationJob(userId, id)

  const now = Date.now()
  if (!entries.some(([key]) => key === 'updated_at')) entries.push(['updated_at', now])
  const params = entries.map(([, value]) => {
    if (value === undefined) return null
    if (typeof value === 'object' && value !== null) return JSON.stringify(value)
    return value
  })
  params.push(id, userId)
  await pool.query(
    `UPDATE image_generation_jobs SET ${entries.map(([key]) => `\`${key}\` = ?`).join(', ')} WHERE id = ? AND user_id = ?`,
    params,
  )
  return getGenerationJob(userId, id)
}

export async function getGenerationJob(userId, id) {
  const [rows] = await pool.query(
    'SELECT * FROM image_generation_jobs WHERE id = ? AND user_id = ? LIMIT 1',
    [id, userId],
  )
  const job = rows[0] || null
  if (!job) return null
  const [assets] = await pool.query(
    'SELECT id, job_id, mime_type, byte_size, created_at FROM image_generation_assets WHERE job_id = ? AND user_id = ? ORDER BY created_at ASC',
    [id, userId],
  )
  return { ...job, assets }
}

export async function listRecoverableGenerationJobs(userId) {
  const [rows] = await pool.query(
    `SELECT * FROM image_generation_jobs
     WHERE user_id = ? AND status IN ('submitted', 'processing', 'archiving', 'archive_error')
     ORDER BY updated_at DESC LIMIT 100`,
    [userId],
  )
  return rows
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number)
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168)
  }
  const normalized = address.toLowerCase()
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
    normalized.startsWith('fd') || normalized.startsWith('fe80:') || normalized.startsWith('::ffff:127.')
}

async function assertPublicImageUrl(rawUrl) {
  const url = new URL(rawUrl)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) image URLs are supported')
  if (url.username || url.password) throw new Error('Image URL credentials are not allowed')
  const addresses = await dns.lookup(url.hostname, { all: true })
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Private network image URLs are not allowed')
  }
  return url
}

async function fetchImage(rawUrl) {
  let currentUrl = rawUrl
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await assertPublicImageUrl(currentUrl)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
    let response
    try {
      response = await fetch(currentUrl, { redirect: 'manual', signal: controller.signal })
    } finally {
      clearTimeout(timeout)
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error(`Image redirect ${response.status} did not include a location`)
      currentUrl = new URL(location, currentUrl).toString()
      continue
    }
    if (!response.ok) throw new Error(`Image download failed with HTTP ${response.status}`)
    const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (!mimeType.startsWith('image/')) throw new Error(`Remote result is not an image (${mimeType || 'unknown type'})`)
    const declaredSize = Number(response.headers.get('content-length') || 0)
    if (declaredSize > MAX_IMAGE_BYTES) throw new Error('Generated image exceeds archive size limit')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Generated image is empty or exceeds archive size limit')
    return { bytes, mimeType, finalUrl: currentUrl }
  }
  throw new Error('Generated image URL redirected too many times')
}

function extensionForMime(mimeType) {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  if (mimeType === 'image/gif') return 'gif'
  return 'png'
}

export async function archiveGenerationImages(userId, jobId, sourceUrls) {
  const job = await getGenerationJob(userId, jobId)
  if (!job) throw new Error('Generation job not found')
  const urls = Array.from(new Set(sourceUrls.filter((value) => typeof value === 'string' && value.trim()))).slice(0, 20)
  if (!urls.length) return { images: [], errors: [] }

  await updateGenerationJob(userId, jobId, { status: 'archiving' })
  const results = []
  const errors = []
  for (const sourceUrl of urls) {
    let filePath = ''
    try {
      const [existingRows] = await pool.query(
        'SELECT * FROM image_generation_assets WHERE job_id = ? AND user_id = ? AND source_url = ? LIMIT 1',
        [jobId, userId, sourceUrl],
      )
      const existing = existingRows[0]
      if (existing) {
        try {
          await fs.access(existing.file_path)
          results.push({
            id: existing.id,
            sourceUrl,
            mimeType: existing.mime_type,
            byteSize: Number(existing.byte_size),
          })
          continue
        } catch {
          // Missing archived files are downloaded again below.
        }
      }

      const image = await fetchImage(sourceUrl)
      const assetId = crypto.randomUUID()
      const userDir = path.join(assetRoot, String(userId))
      await fs.mkdir(userDir, { recursive: true })
      filePath = path.join(userDir, `${assetId}.${extensionForMime(image.mimeType)}`)
      await fs.writeFile(filePath, image.bytes, { flag: 'wx' })
      await pool.query(
        `INSERT INTO image_generation_assets
          (id, job_id, user_id, source_url, file_path, mime_type, byte_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [assetId, jobId, userId, image.finalUrl, filePath, image.mimeType, image.bytes.length, Date.now()],
      )
      results.push({
        id: assetId,
        sourceUrl,
        mimeType: image.mimeType,
        byteSize: image.bytes.length,
      })
    } catch (error) {
      if (filePath) await fs.rm(filePath, { force: true }).catch(() => undefined)
      errors.push({ sourceUrl, error: error instanceof Error ? error.message : String(error) })
    }
  }
  await updateGenerationJob(userId, jobId, {
    status: errors.length ? 'archive_error' : 'completed',
    receivedCount: results.length,
    resultJson: { images: results, errors },
    errorMessage: errors.map((item) => item.error).join('\n') || null,
    finishedAt: errors.length ? null : Date.now(),
  })
  return { images: results, errors }
}

export async function getGenerationAsset(userId, assetId) {
  const [rows] = await pool.query(
    'SELECT * FROM image_generation_assets WHERE id = ? AND user_id = ? LIMIT 1',
    [assetId, userId],
  )
  return rows[0] || null
}
