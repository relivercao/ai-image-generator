import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
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
