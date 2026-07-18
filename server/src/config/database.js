import dotenv from 'dotenv'
import mysql from 'mysql2/promise'
import sqlite3 from 'sqlite3'

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

export function createMysqlPool() {
  const dsnConfig = parseSqlDsn(process.env.SQL_DSN)
  return mysql.createPool({
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
}

function runSqlite(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) {
        reject(error)
        return
      }
      resolve({ insertId: this.lastID, affectedRows: this.changes })
    })
  })
}

function allSqlite(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error)
        return
      }
      resolve(rows)
    })
  })
}

export function createSqlitePool(filename) {
  const db = new sqlite3.Database(filename)

  return {
    async query(sql, params = []) {
      const trimmed = String(sql).trim()
      const showColumnsMatch = trimmed.match(/^SHOW\s+COLUMNS\s+FROM\s+`?([A-Za-z0-9_]+)`?/i)
      if (showColumnsMatch) {
        const rows = await allSqlite(db, `PRAGMA table_info(\`${showColumnsMatch[1]}\`)`)
        return [rows.map((row) => ({ Field: row.name }))]
      }

      if (/^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(trimmed)) {
        const result = await runSqlite(db, sql, params)
        return [result]
      }

      return [await allSqlite(db, sql, params)]
    },
    async end() {
      return new Promise((resolve, reject) => {
        db.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    },
  }
}

function shouldUseSqlite() {
  return process.env.DB_DRIVER === 'sqlite' || Boolean(process.env.SQLITE_PATH)
}

const pool = shouldUseSqlite()
  ? createSqlitePool(process.env.SQLITE_PATH || process.env.DB_NAME || './one-api.db')
  : createMysqlPool()

export default pool
