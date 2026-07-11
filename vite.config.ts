import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { lookup as dnsLookup, resolve4 } from 'dns'
import { readFileSync } from 'fs'
import { Agent as HttpsAgent } from 'https'
import { normalizeDevProxyConfig } from './src/lib/devProxy'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

function loadDevProxyConfig() {
  try {
    return normalizeDevProxyConfig(
      JSON.parse(readFileSync('./dev-proxy.config.json', 'utf-8')) as unknown,
    )
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return null
    throw error
  }
}

function createDevProxyAgent(target: string) {
  let targetUrl: URL
  try {
    targetUrl = new URL(target)
  } catch {
    return undefined
  }
  if (targetUrl.protocol !== 'https:') return undefined

  const targetHost = targetUrl.hostname
  let cachedAddress = process.env.VITE_DEV_PROXY_RESOLVED_IP || ''

  const lookup = (hostname: string, options: unknown, callback?: unknown) => {
    const cb = (typeof options === 'function' ? options : callback) as
      | ((err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void)
      | undefined
    const lookupOptions = (typeof options === 'function' ? {} : options) as { all?: boolean } | undefined
    if (!cb) return

    if (hostname !== targetHost) {
      dnsLookup(hostname, options as never, callback as never)
      return
    }

    const done = (address: string) => {
      cachedAddress = address
      if (lookupOptions?.all) cb(null, [{ address, family: 4 }])
      else cb(null, address, 4)
    }

    if (cachedAddress) {
      done(cachedAddress)
      return
    }

    dnsLookup(hostname, { family: 4 }, (lookupError, address) => {
      if (!lookupError && address) {
        done(address)
        return
      }

      resolve4(hostname, (resolveError, addresses) => {
        const resolvedAddress = addresses?.[0]
        if (resolvedAddress) {
          done(resolvedAddress)
          return
        }
        cb((lookupError || resolveError || new Error(`Unable to resolve ${hostname}`)) as NodeJS.ErrnoException, '')
      })
    })
  }

  return new HttpsAgent({
    keepAlive: true,
    lookup,
  })
}

export default defineConfig(({ command, mode }) => {
  const devProxyConfig = command === 'serve' && mode !== 'test' ? loadDevProxyConfig() : null
  const authProxyEnabled = command === 'serve' && mode !== 'test' && process.env.VITE_AUTH_DEV_PROXY !== 'false'
  const authProxyTarget = process.env.VITE_AUTH_DEV_PROXY_TARGET || 'http://127.0.0.1:3004'
  const serverProxy = {
    ...(devProxyConfig?.enabled
      ? {
          [devProxyConfig.prefix]: {
            target: devProxyConfig.target,
            changeOrigin: devProxyConfig.changeOrigin,
            secure: devProxyConfig.secure,
            agent: createDevProxyAgent(devProxyConfig.target),
            rewrite: (path: string) =>
              path.replace(
                new RegExp(`^${devProxyConfig.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
                '',
              ),
          },
        }
      : {}),
    ...(authProxyEnabled
      ? {
          '/api': {
            target: authProxyTarget,
            changeOrigin: true,
            secure: false,
          },
        }
      : {}),
  }

  return {
    plugins: [react()],
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __DEV_PROXY_CONFIG__: JSON.stringify(devProxyConfig),
    },
    server: {
      host: true,
      proxy: Object.keys(serverProxy).length ? serverProxy : undefined,
    },
    build: {
      rollupOptions: {
        input: {
          main: 'index.html',
          ppt: 'ppt.html',
        },
      },
    },
  }
})
