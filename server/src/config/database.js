import mysql from 'mysql2/promise'
import dotenv from 'dotenv'

dotenv.config()

function parseSqlDsn(dsn) {
  const match = String(dsn || '').match(/^([^:]+):(.*)@tcp\(([^)]+)\)\/([^?]+)(?:\?.*)?$/)
  if (!match) return null

  const hostPort = match[3]
  const portSeparator = hostPort.lastIndexOf(':')
  const hasPort = portSeparator > 0 && /^\d+$/.test(hostPort.slice(portSeparator + 1))

  return {
    user: match[1],
    password: match[2],
    host: hasPort ? hostPort.slice(0, portSeparator) : hostPort,
    port: hasPort ? Number(hostPort.slice(portSeparator + 1)) : 3306,
    database: match[4],
  }
}

const dsnConfig = parseSqlDsn(process.env.SQL_DSN)

const pool = mysql.createPool({
  host: process.env.DB_HOST || dsnConfig?.host || '127.0.0.1',
  port: Number(process.env.DB_PORT || dsnConfig?.port || 3306),
  user: process.env.DB_USER || dsnConfig?.user,
  password: process.env.DB_PASSWORD || dsnConfig?.password,
  database: process.env.DB_NAME || dsnConfig?.database,
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  queueLimit: 0,
  enableKeepAlive: true,
})

export default pool
