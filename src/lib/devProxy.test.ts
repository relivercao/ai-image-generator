import { describe, expect, it } from 'vitest'
import { buildApiUrl, isApiProxyLocked, normalizeDevProxyConfig, resolveDefaultProxyPrefix, shouldUseApiProxy } from './devProxy'

describe('buildApiUrl', () => {
  it('keeps the proxy under a relative production base path', () => {
    expect(resolveDefaultProxyPrefix('./')).toBe('./api-proxy')
    expect(resolveDefaultProxyPrefix('/image-playground/')).toBe('/image-playground/api-proxy')
    expect(resolveDefaultProxyPrefix('/')).toBe('/api-proxy')
  })

  it('uses the same-origin proxy prefix when API proxy is enabled', () => {
    expect(buildApiUrl('http://api.example.com/v1', 'images/edits', null, true)).toBe(
      '/api-proxy/images/edits',
    )
  })

  it('leaves API versioning to the proxy target when proxying', () => {
    expect(buildApiUrl('http://api.example.com', 'images/generations', null, true)).toBe(
      '/api-proxy/images/generations',
    )
  })

  it('uses a configured proxy prefix when one is available', () => {
    expect(
      buildApiUrl(
        'http://api.example.com/v1',
        'responses',
        {
          enabled: true,
          locked: false,
          prefix: '/openai-proxy',
          target: 'http://api.example.com/v1',
          changeOrigin: true,
          secure: false,
        },
        true,
      ),
    ).toBe('/openai-proxy/responses')
  })

  it('normalizes locked proxy config and forces proxy use', () => {
    const proxyConfig = normalizeDevProxyConfig({
      enabled: true,
      locked: true,
      prefix: 'openai-proxy/',
      target: 'https://api.openai.com/v1',
      secure: true,
    })

    expect(proxyConfig).toMatchObject({
      enabled: true,
      locked: true,
      prefix: '/openai-proxy',
      target: 'https://api.openai.com/v1',
      changeOrigin: true,
      secure: true,
    })
    expect(isApiProxyLocked(proxyConfig)).toBe(true)
    expect(shouldUseApiProxy(false, proxyConfig)).toBe(true)
  })

  it('uses the configured API URL directly when API proxy is disabled', () => {
    expect(buildApiUrl('http://api.example.com/v1', 'responses', null, false)).toBe(
      'http://api.example.com/v1/responses',
    )
  })
})
