import assert from 'node:assert/strict'
import http from 'node:http'
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
  const durableProxy = createDurableImageProxyRouter({ apiProxyUrl: `${upstreamUrl}/v1`, jobTtlMs: 60_000 })
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
