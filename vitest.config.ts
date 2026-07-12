import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'server/**'],
  },
  define: {
    __APP_VERSION__: JSON.stringify('0.6.10'),
    __DEV_PROXY_CONFIG__: JSON.stringify(null),
  },
})
