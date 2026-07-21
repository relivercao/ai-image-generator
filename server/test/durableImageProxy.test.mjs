import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'
import { createDurableImageProxyRouter } from '../durable-image-proxy.mjs'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function waitForCompleted(url, token) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(url, { headers: { 'X-Generation-Poll-Token': token } })
    const job = await response.json()
    if (job.status === 'completed' || job.status === 'failed') return job
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Durable proxy test job did not complete')
}

test('keeps the upstream image request alive and deduplicates browser submissions', async (t) => {
  let upstreamCalls = 0
  let releaseUpstream
  const upstreamGate = new Promise((resolve) => { releaseUpstream = resolve })
  const upstreamServer = http.createServer(async (req, res) => {
    upstreamCalls += 1
    assert.equal(req.url, '/v1/images/edits')
    assert.equal(req.headers.authorization, 'Bearer test-key')
    for await (const _chunk of req) {
      // Drain the uploaded request before simulating slow generation.
    }
    await upstreamGate
    res.statusCode = 201
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('X-Upstream-Request-Id', 'upstream-request-1')
    res.end('{"data":[{"b64_json":"aW1hZ2U="}]}')
  })
  const upstreamUrl = await listen(upstreamServer)

  const app = express()
  const durableProxy = createDurableImageProxyRouter({ apiProxyUrl: `${upstreamUrl}/v1`, jobTtlMs: 60_000, storageDir: false })
  app.use('/generation-proxy', durableProxy.router)
  const appServer = http.createServer(app)
  const appUrl = await listen(appServer)

  t.after(async () => {
    durableProxy.close()
    await close(appServer)
    await close(upstreamServer)
  })

  const requestInit = {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'task-1:0',
    },
    body: '{"model":"gpt-image-2","prompt":"test"}',
  }
  const firstResponse = await fetch(`${appUrl}/generation-proxy/images/edits`, requestInit)
  assert.equal(firstResponse.status, 202)
  const firstJob = await firstResponse.json()
  assert.equal(firstJob.status, 'processing')

  const duplicateResponse = await fetch(`${appUrl}/generation-proxy/images/edits`, requestInit)
  const duplicateJob = await duplicateResponse.json()
  assert.equal(duplicateJob.jobId, firstJob.jobId)
  assert.equal(upstreamCalls, 1)

  const deniedResponse = await fetch(`${appUrl}/generation-proxy/jobs/${firstJob.jobId}`, {
    headers: { 'X-Generation-Poll-Token': 'wrong-token' },
  })
  assert.equal(deniedResponse.status, 403)

  const changedRequest = await fetch(`${appUrl}/generation-proxy/images/edits`, {
    ...requestInit,
    body: '{"model":"gpt-image-2","prompt":"different"}',
  })
  assert.equal(changedRequest.status, 409)

  releaseUpstream()
  const completed = await waitForCompleted(
    `${appUrl}/generation-proxy/jobs/${firstJob.jobId}`,
    firstJob.pollToken,
  )
  assert.equal(completed.status, 'completed')
  assert.equal(completed.upstreamStatus, 201)

  const resultResponse = await fetch(`${appUrl}/generation-proxy/jobs/${firstJob.jobId}/result`, {
    headers: { 'X-Generation-Poll-Token': firstJob.pollToken },
  })
  assert.equal(resultResponse.status, 201)
  assert.equal(resultResponse.headers.get('x-upstream-request-id'), 'upstream-request-1')
  assert.deepEqual(await resultResponse.json(), { data: [{ b64_json: 'aW1hZ2U=' }] })
})

test('reports background transport failures through the polling endpoint', async (t) => {
  const app = express()
  const durableProxy = createDurableImageProxyRouter({
    apiProxyUrl: 'http://127.0.0.1:1/v1',
    fetchImpl: async () => { throw new Error('upstream unavailable') },
    storageDir: false,
  })
  app.use('/generation-proxy', durableProxy.router)
  const appServer = http.createServer(app)
  const appUrl = await listen(appServer)

  t.after(async () => {
    durableProxy.close()
    await close(appServer)
  })

  const response = await fetch(`${appUrl}/generation-proxy/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'failed-task' },
    body: '{}',
  })
  const submission = await response.json()
  const failed = await waitForCompleted(
    `${appUrl}/generation-proxy/jobs/${submission.jobId}`,
    submission.pollToken,
  )
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /upstream unavailable/)
})

test('persists a redacted multipart request summary', async (t) => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'macode-durable-summary-'))
  const storageDir = path.join(testRoot, 'jobs')
  const app = express()
  const durableProxy = createDurableImageProxyRouter({
    apiProxyUrl: 'https://upstream.example/v1',
    storageDir,
    fetchImpl: async () => new Response('{"error":{"message":"invalid","type":"service_error","code":"400"}}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  })
  app.use('/generation-proxy', durableProxy.router)
  const appServer = http.createServer(app)
  const appUrl = await listen(appServer)

  t.after(async () => {
    durableProxy.close()
    await close(appServer)
    await fs.rm(testRoot, { recursive: true, force: true })
  })

  const formData = new FormData()
  formData.append('model', 'gpt-image-2')
  formData.append('prompt', 'private prompt text')
  formData.append('size', '1440x2560')
  formData.append('quality', 'standard')
  formData.append('image[]', new Blob(['first-image'], { type: 'image/jpeg' }), 'private-first.jpg')
  formData.append('image[]', new Blob(['second-image'], { type: 'image/png' }), 'private-second.png')

  const submissionResponse = await fetch(`${appUrl}/generation-proxy/images/edits`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'summary-task' },
    body: formData,
  })
  const submission = await submissionResponse.json()
  await waitForCompleted(`${appUrl}/generation-proxy/jobs/${submission.jobId}`, submission.pollToken)

  const metadataText = await fs.readFile(path.join(storageDir, `${submission.jobId}.json`), 'utf8')
  const metadata = JSON.parse(metadataText)
  assert.deepEqual(metadata.requestSummary.fields, {
    model: 'gpt-image-2',
    size: '1440x2560',
    quality: 'standard',
  })
  assert.equal(metadata.requestSummary.promptChars, 'private prompt text'.length)
  assert.equal(metadata.requestSummary.promptUtf8Bytes, Buffer.byteLength('private prompt text', 'utf8'))
  assert.equal(metadata.requestSummary.imageCount, 2)
  assert.equal(metadata.requestSummary.files[0].type, 'image/jpeg')
  assert.equal(metadata.requestSummary.files[1].type, 'image/png')
  assert.doesNotMatch(metadataText, /private prompt text|private-first|private-second/)
})

test('restores completed jobs after a runtime restart without calling upstream again', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'macode-durable-proxy-'))
  const storageDir = path.join(testRoot, 'jobs')
  let upstreamCalls = 0
  const upstreamServer = http.createServer(async (req, res) => {
    upstreamCalls += 1
    for await (const _chunk of req) {
      // Drain request body.
    }
    res.setHeader('Content-Type', 'application/json')
    res.end('{"data":[{"b64_json":"cGVyc2lzdGVk"}]}')
  })
  const upstreamUrl = await listen(upstreamServer)

  const startProxy = async () => {
    const app = express()
    const proxy = createDurableImageProxyRouter({
      apiProxyUrl: `${upstreamUrl}/v1`,
      storageDir,
      jobTtlMs: 60_000,
    })
    app.use('/generation-proxy', proxy.router)
    const server = http.createServer(app)
    const url = await listen(server)
    return { proxy, server, url }
  }

  const requestInit = {
    method: 'POST',
    headers: {
      Authorization: 'Bearer persisted-user',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'persisted-task-1',
    },
    body: '{"model":"gpt-image-2","prompt":"persist me"}',
  }

  let firstRuntime
  let secondRuntime
  try {
    firstRuntime = await startProxy()
    const firstSubmission = await (await fetch(`${firstRuntime.url}/generation-proxy/images/generations`, requestInit)).json()
    const completed = await waitForCompleted(
      `${firstRuntime.url}/generation-proxy/jobs/${firstSubmission.jobId}`,
      firstSubmission.pollToken,
    )
    assert.equal(completed.status, 'completed')
    await close(firstRuntime.server)
    firstRuntime.proxy.close()
    firstRuntime = null

    secondRuntime = await startProxy()
    const restoredResponse = await fetch(`${secondRuntime.url}/generation-proxy/images/generations`, requestInit)
    const restoredSubmission = await restoredResponse.json()
    assert.equal(restoredResponse.status, 200)
    assert.equal(restoredSubmission.jobId, firstSubmission.jobId)
    assert.equal(restoredSubmission.status, 'completed')
    assert.equal(upstreamCalls, 1)

    const resultResponse = await fetch(
      `${secondRuntime.url}/generation-proxy/jobs/${restoredSubmission.jobId}/result`,
      { headers: { 'X-Generation-Poll-Token': restoredSubmission.pollToken } },
    )
    assert.deepEqual(await resultResponse.json(), { data: [{ b64_json: 'cGVyc2lzdGVk' }] })
  } finally {
    if (firstRuntime) {
      await close(firstRuntime.server)
      firstRuntime.proxy.close()
    }
    if (secondRuntime) {
      await close(secondRuntime.server)
      secondRuntime.proxy.close()
    }
    await close(upstreamServer)
    await fs.rm(testRoot, { recursive: true, force: true })
  }
})

test('does not resubmit an interrupted in-flight job after restart', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'macode-durable-interrupted-'))
  const storageDir = path.join(testRoot, 'jobs')
  let upstreamCalls = 0

  const startProxy = async (fetchImpl) => {
    const app = express()
    const proxy = createDurableImageProxyRouter({
      apiProxyUrl: 'https://upstream.example/v1',
      fetchImpl,
      storageDir,
      jobTtlMs: 60_000,
    })
    app.use('/generation-proxy', proxy.router)
    const server = http.createServer(app)
    const url = await listen(server)
    return { proxy, server, url }
  }

  const requestInit = {
    method: 'POST',
    headers: {
      Authorization: 'Bearer interrupted-user',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'interrupted-task-1',
    },
    body: '{"model":"gpt-image-2","prompt":"do not bill twice"}',
  }

  let firstRuntime
  let secondRuntime
  try {
    firstRuntime = await startProxy(async () => {
      upstreamCalls += 1
      return new Promise(() => {})
    })
    const firstSubmission = await (await fetch(`${firstRuntime.url}/generation-proxy/images/generations`, requestInit)).json()
    assert.equal(firstSubmission.status, 'processing')
    await close(firstRuntime.server)
    firstRuntime.proxy.close()
    firstRuntime = null

    secondRuntime = await startProxy(async () => {
      upstreamCalls += 1
      throw new Error('interrupted job must not be submitted again')
    })
    const restoredSubmission = await (await fetch(
      `${secondRuntime.url}/generation-proxy/images/generations`,
      requestInit,
    )).json()
    assert.equal(restoredSubmission.jobId, firstSubmission.jobId)
    assert.equal(restoredSubmission.status, 'failed')
    assert.match(restoredSubmission.error, /不会自动重新提交/)
    assert.equal(upstreamCalls, 1)
  } finally {
    if (firstRuntime) {
      await close(firstRuntime.server)
      firstRuntime.proxy.close()
    }
    if (secondRuntime) {
      await close(secondRuntime.server)
      secondRuntime.proxy.close()
    }
    await fs.rm(testRoot, { recursive: true, force: true })
  }
})
