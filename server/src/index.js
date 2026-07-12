import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import authRoutes from './routes/auth.js'
import generationJobRoutes from './routes/generationJobs.js'
import { ensureGenerationJobSchema } from './services/generationJobService.js'

dotenv.config()

const app = express()
const PORT = Number(process.env.PORT || 3004)

app.use(cors())
app.use(express.json({ limit: '2mb' }))

app.use('/api/auth', authRoutes)
app.use('/api/generation-jobs', generationJobRoutes)

const healthHandler = (_req, res) => {
  res.json({
    status: 'ok',
    generationArchive: app.locals.generationArchiveReady ? 'ok' : 'degraded',
  })
}

app.get('/health', healthHandler)
app.get('/api/health', healthHandler)

try {
  await ensureGenerationJobSchema()
  app.locals.generationArchiveReady = true
} catch (error) {
  app.locals.generationArchiveReady = false
  console.error('Generation archive initialization failed; authentication will remain available:', error)
}

app.listen(PORT, '0.0.0.0', () => {
  if (!process.env.JWT_SECRET) {
    console.warn('JWT_SECRET is not set; using development fallback secret.')
  }
  console.log(`Macode auth bridge running on 0.0.0.0:${PORT}`)
})
