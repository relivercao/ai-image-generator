import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'macode-generation-jobs-'))
process.env.DB_DRIVER = 'sqlite'
process.env.SQLITE_PATH = path.join(testRoot, 'auth.sqlite')
process.env.GENERATION_DB_DRIVER = 'sqlite'
process.env.GENERATION_SQLITE_PATH = path.join(testRoot, 'jobs.sqlite')
process.env.GENERATED_ASSET_DIR = path.join(testRoot, 'assets')

const service = await import('../src/services/generationJobService.js')
const { default: pool } = await import('../src/config/database.js')
const { default: generationPool } = await import('../src/config/generationDatabase.js')

test('creates, updates, and lists generation jobs', async () => {
  await service.ensureGenerationJobSchema()
  const created = await service.createGenerationJob(7, {
    id: 'task-test-1',
    requestedCount: 5,
    provider: 'openai',
  })
  assert.equal(created.id, 'task-test-1')
  assert.equal(created.requested_count, 5)

  const updated = await service.updateGenerationJob(7, created.id, {
    status: 'processing',
    providerTaskId: 'remote-task-1',
  })
  assert.equal(updated.status, 'processing')
  assert.equal(updated.provider_task_id, 'remote-task-1')

  const jobs = await service.listRecoverableGenerationJobs(7)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].id, created.id)
})

test.after(async () => {
  await generationPool.end()
  await pool.end()
  await fs.rm(testRoot, { recursive: true, force: true })
})
