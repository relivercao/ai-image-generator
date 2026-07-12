import fs from 'node:fs'
import {
  archiveGenerationImages,
  createGenerationJob,
  getGenerationAsset,
  getGenerationJob,
  listRecoverableGenerationJobs,
  updateGenerationJob,
} from '../services/generationJobService.js'

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export async function createJob(req, res) {
  try {
    const job = await createGenerationJob(req.user.id, req.body || {})
    return res.status(201).json({ job })
  } catch (error) {
    console.error('Create generation job error:', error)
    return res.status(500).json({ error: 'Failed to create generation job', message: errorMessage(error) })
  }
}

export async function updateJob(req, res) {
  try {
    const job = await updateGenerationJob(req.user.id, req.params.id, req.body || {})
    if (!job) return res.status(404).json({ error: 'Generation job not found' })
    return res.json({ job })
  } catch (error) {
    console.error('Update generation job error:', error)
    return res.status(500).json({ error: 'Failed to update generation job', message: errorMessage(error) })
  }
}

export async function getJob(req, res) {
  try {
    const job = await getGenerationJob(req.user.id, req.params.id)
    if (!job) return res.status(404).json({ error: 'Generation job not found' })
    return res.json({
      job: {
        ...job,
        assets: (job.assets || []).map((asset) => ({
          ...asset,
          assetUrl: `/${encodeURIComponent(req.params.id)}/assets/${encodeURIComponent(asset.id)}`,
        })),
      },
    })
  } catch (error) {
    return res.status(500).json({ error: 'Failed to read generation job', message: errorMessage(error) })
  }
}

export async function listRecoverableJobs(req, res) {
  try {
    return res.json({ jobs: await listRecoverableGenerationJobs(req.user.id) })
  } catch (error) {
    return res.status(500).json({ error: 'Failed to list generation jobs', message: errorMessage(error) })
  }
}

export async function archiveJobImages(req, res) {
  try {
    const sourceUrls = Array.isArray(req.body?.sourceUrls) ? req.body.sourceUrls : []
    const result = await archiveGenerationImages(req.user.id, req.params.id, sourceUrls)
    return res.json({
      images: result.images.map((image) => ({
        ...image,
        assetUrl: `/${encodeURIComponent(req.params.id)}/assets/${encodeURIComponent(image.id)}`,
      })),
      errors: result.errors,
    })
  } catch (error) {
    console.error('Archive generated images error:', error)
    return res.status(502).json({ error: 'Failed to archive generated images', message: errorMessage(error) })
  }
}

export async function downloadAsset(req, res) {
  try {
    const asset = await getGenerationAsset(req.user.id, req.params.assetId)
    if (!asset || !fs.existsSync(asset.file_path)) return res.status(404).json({ error: 'Generated image not found' })
    res.type(asset.mime_type)
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    return res.sendFile(asset.file_path)
  } catch (error) {
    return res.status(500).json({ error: 'Failed to read generated image', message: errorMessage(error) })
  }
}
