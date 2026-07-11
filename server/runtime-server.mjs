import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..', 'dist')
const app = express()
const host = process.env.HOST || '127.0.0.1'
const port = Number(process.env.PORT || 8080)
const apiProxyUrl = process.env.API_PROXY_URL || 'https://macode.cloud/v1'
const authApiUrl = process.env.AUTH_API_URL || 'http://127.0.0.1:3004'

app.disable('x-powered-by')

app.use(
  '/api-proxy',
  createProxyMiddleware({
    target: apiProxyUrl,
    changeOrigin: true,
    secure: true,
    pathRewrite: { '^/api-proxy': '' },
    proxyTimeout: 600000,
    timeout: 600000,
    ws: false,
  }),
)

app.use(
  '/api',
  createProxyMiddleware({
    target: `${authApiUrl}/api`,
    changeOrigin: true,
    proxyTimeout: 60000,
    timeout: 60000,
  }),
)

app.use(express.static(root, { maxAge: '1y', immutable: true, index: false }))
app.get('*', (_req, res) => res.sendFile(path.join(root, 'index.html')))

app.listen(port, host, () => {
  console.log(`image playground serving ${root} on ${host}:${port}`)
})
