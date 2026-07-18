import { describe, expect, it, vi } from 'vitest'
import { buildDurableImageProxyUrl, fetchThroughDurableImageProxy } from './durableImageProxy'

describe('durable image proxy client', () => {
  it('maps a scoped API proxy URL to the durable endpoint', () => {
    expect(buildDurableImageProxyUrl('/image-playground/api-proxy/images/edits'))
      .toBe('/image-playground/generation-proxy/images/edits')
    expect(buildDurableImageProxyUrl('https://api.example.com/v1/images/edits')).toBeNull()
  })

  it('submits, polls, and returns the original upstream response', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jobId: 'job-1',
        pollToken: 'poll-secret',
        status: 'processing',
      }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: 'job-1', status: 'processing' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: 'job-1', status: 'completed' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('{"data":[{"url":"https://image.example/result.png"}]}', {
        status: 201,
        headers: { 'Content-Type': 'application/json', 'X-Upstream-Request-Id': 'upstream-1' },
      }))

    const response = await fetchThroughDurableImageProxy('/image-playground/api-proxy/images/edits', {
      method: 'POST',
      headers: { Authorization: 'Bearer test' },
      body: new FormData(),
    }, { fetchImpl: fetchMock, pollIntervalMs: 0, transientRetryDelayMs: 0 })

    expect(response.status).toBe(201)
    expect(response.headers.get('X-Upstream-Request-Id')).toBe('upstream-1')
    expect(await response.json()).toEqual({ data: [{ url: 'https://image.example/result.png' }] })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(String(fetchMock.mock.calls[0][0])).toBe('/image-playground/generation-proxy/images/edits')
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has('Idempotency-Key')).toBe(true)
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('X-Generation-Poll-Token')).toBe('poll-secret')
  })

  it('recovers from a transient polling network failure without resubmitting', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jobId: 'job-2',
        pollToken: 'poll-secret',
        status: 'processing',
      }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: 'job-2', status: 'completed' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('{"data":[]}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    await expect(fetchThroughDurableImageProxy('/api-proxy/images/generations', {
      method: 'POST',
      body: '{}',
    }, {
      fetchImpl: fetchMock,
      pollIntervalMs: 0,
      transientRetryDelayMs: 0,
    })).resolves.toBeInstanceOf(Response)

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === '/generation-proxy/images/generations')).toHaveLength(1)
  })

  it('surfaces a background upstream failure', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jobId: 'job-3',
        pollToken: 'poll-secret',
        status: 'processing',
      }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jobId: 'job-3',
        status: 'failed',
        error: 'Upstream image request timed out',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(fetchThroughDurableImageProxy('/api-proxy/images/edits', {
      method: 'POST',
      body: new FormData(),
    }, {
      fetchImpl: fetchMock,
      pollIntervalMs: 0,
      transientRetryDelayMs: 0,
    })).rejects.toThrow('Upstream image request timed out')
  })

  it('retries downloading a completed result when the response body is interrupted', async () => {
    const interruptedBody = new ReadableStream({
      start(controller) {
        controller.error(new TypeError('connection closed'))
      },
    })
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jobId: 'job-4',
        pollToken: 'poll-secret',
        status: 'completed',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(interruptedBody, { status: 200 }))
      .mockResolvedValueOnce(new Response('{"data":[{"b64_json":"aW1hZ2U="}]}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const response = await fetchThroughDurableImageProxy('/api-proxy/images/generations', {
      method: 'POST',
      body: '{}',
    }, {
      fetchImpl: fetchMock,
      pollIntervalMs: 0,
      transientRetryDelayMs: 0,
    })

    expect(await response.json()).toEqual({ data: [{ b64_json: 'aW1hZ2U=' }] })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
