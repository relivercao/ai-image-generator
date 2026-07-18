import fs from 'node:fs'
import path from 'node:path'
import authPool, { createSqlitePool } from './database.js'

const generationDriver = String(process.env.GENERATION_DB_DRIVER || '').trim().toLowerCase()
const generationSqlitePath = String(process.env.GENERATION_SQLITE_PATH || '').trim()

if (generationDriver && generationDriver !== 'sqlite') {
  throw new Error(`Unsupported GENERATION_DB_DRIVER: ${generationDriver}`)
}

let generationPool = authPool
if (generationDriver === 'sqlite' || generationSqlitePath) {
  const filename = path.resolve(generationSqlitePath || './data/generation-jobs.sqlite')
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  generationPool = createSqlitePool(filename)
}

export default generationPool
