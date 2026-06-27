import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import pool from '../config/database.js'
import { getJwtExpiresIn, getJwtSecret } from '../config/auth.js'

const TABLES = new Set(['users', 'tokens'])
const tableColumnsCache = new Map()

function isEnabled(value) {
  return String(value ?? '').toLowerCase() === 'true'
}

function normalizeIdentifier(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function quoteColumn(column) {
  return `\`${column.replace(/`/g, '``')}\``
}

async function getTableColumns(table) {
  if (!TABLES.has(table)) throw new Error(`Unsupported table: ${table}`)
  if (tableColumnsCache.has(table)) return tableColumnsCache.get(table)

  const [rows] = await pool.query(`SHOW COLUMNS FROM \`${table}\``)
  const columns = new Set(rows.map((row) => row.Field))
  tableColumnsCache.set(table, columns)
  return columns
}

function selectExistingColumns(columns, wanted) {
  const selected = wanted.filter((column) => columns.has(column))
  if (!selected.includes('id') && columns.has('id')) selected.unshift('id')
  return selected.map(quoteColumn).join(', ')
}

function createJwt(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      email: user.email || '',
      displayName: user.display_name || user.username,
      role: user.role ?? 1,
    },
    getJwtSecret(),
    { expiresIn: getJwtExpiresIn() },
  )
}

function publicUser(user) {
  return {
    id: String(user.id),
    username: user.username,
    email: user.email || '',
    displayName: user.display_name || user.username,
    role: user.role ?? 1,
  }
}

async function findActiveUserByIdentifier(identifier) {
  const columns = await getTableColumns('users')
  const where = []
  const params = []
  const lookup = []

  if (columns.has('username')) {
    lookup.push('`username` = ?')
    params.push(identifier)
  }
  if (columns.has('email')) {
    lookup.push('`email` = ?')
    params.push(identifier)
  }

  if (lookup.length === 0) {
    throw new Error('users table must contain username or email column')
  }

  where.push(`(${lookup.join(' OR ')})`)
  if (columns.has('status')) where.push('`status` = 1')
  if (columns.has('deleted_at')) where.push('`deleted_at` IS NULL')

  const select = selectExistingColumns(columns, ['id', 'username', 'password', 'display_name', 'email', 'role', 'status'])
  const [users] = await pool.query(
    `SELECT ${select} FROM \`users\` WHERE ${where.join(' AND ')} LIMIT 1`,
    params,
  )
  return users[0] || null
}

async function findActiveUserById(id) {
  const columns = await getTableColumns('users')
  const where = ['`id` = ?']
  if (columns.has('status')) where.push('`status` = 1')
  if (columns.has('deleted_at')) where.push('`deleted_at` IS NULL')

  const select = selectExistingColumns(columns, ['id', 'username', 'display_name', 'email', 'role', 'status'])
  const [users] = await pool.query(
    `SELECT ${select} FROM \`users\` WHERE ${where.join(' AND ')} LIMIT 1`,
    [id],
  )
  return users[0] || null
}

function createNewApiKey(rawKey) {
  const key = typeof rawKey === 'string' ? rawKey.trim() : ''
  if (!key) return ''

  const prefix = process.env.NEW_API_KEY_PREFIX ?? 'sk-'
  if (!prefix) return key
  return key.startsWith(prefix) ? key : `${prefix}${key}`
}

function createAffCode() {
  return Math.random().toString(36).slice(2, 6)
}

export async function register(req, res) {
  if (!isEnabled(process.env.ALLOW_PASSWORD_REGISTER)) {
    return res.status(403).json({
      error: 'Registration disabled',
      message: '当前站点使用 macode / New API 账号登录，请先在主站创建账号',
    })
  }

  try {
    const username = normalizeIdentifier(req.body.username)
    const email = normalizeIdentifier(req.body.email)
    const password = normalizeIdentifier(req.body.password)

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required', message: '请输入用户名和密码' })
    }

    const columns = await getTableColumns('users')
    const lookup = ['`username` = ?']
    const params = [username]
    if (email && columns.has('email')) {
      lookup.push('`email` = ?')
      params.push(email)
    }

    const [existingUsers] = await pool.query(
      `SELECT \`id\` FROM \`users\` WHERE ${lookup.join(' OR ')} LIMIT 1`,
      params,
    )

    if (existingUsers.length > 0) {
      return res.status(409).json({ error: 'Username already exists', message: '用户名或邮箱已存在' })
    }

    const hashedPassword = await bcrypt.hash(password, 10)
    const insertValues = {
      username,
      password: hashedPassword,
    }

    if (columns.has('display_name')) insertValues.display_name = username
    if (columns.has('email')) insertValues.email = email
    if (columns.has('role')) insertValues.role = 1
    if (columns.has('status')) insertValues.status = 1
    if (columns.has('quota')) insertValues.quota = 0
    if (columns.has('group')) insertValues.group = 'default'
    if (columns.has('aff_code')) insertValues.aff_code = createAffCode()
    if (columns.has('created_at')) insertValues.created_at = Math.floor(Date.now() / 1000)

    const insertColumns = Object.keys(insertValues)
    const placeholders = insertColumns.map(() => '?').join(', ')
    const [result] = await pool.query(
      `INSERT INTO \`users\` (${insertColumns.map(quoteColumn).join(', ')}) VALUES (${placeholders})`,
      insertColumns.map((column) => insertValues[column]),
    )

    const user = await findActiveUserById(result.insertId)
    const token = createJwt(user)

    return res.status(201).json({
      message: '注册成功',
      token,
      user: publicUser(user),
    })
  } catch (error) {
    console.error('Registration error:', error)
    return res.status(500).json({ error: 'Internal server error', message: '注册失败，请稍后重试' })
  }
}

export async function login(req, res) {
  try {
    const identifier = normalizeIdentifier(req.body.identifier || req.body.username || req.body.email)
    const password = normalizeIdentifier(req.body.password)

    if (!identifier || !password) {
      return res.status(400).json({ error: 'Identifier and password are required', message: '请输入账号和密码' })
    }

    const user = await findActiveUserByIdentifier(identifier)
    if (!user?.password) {
      return res.status(401).json({ error: 'Invalid credentials', message: '账号或密码错误' })
    }

    const isPasswordValid = await bcrypt.compare(password, user.password)
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid credentials', message: '账号或密码错误' })
    }

    const token = createJwt(user)

    return res.json({
      message: '登录成功',
      token,
      user: publicUser(user),
    })
  } catch (error) {
    console.error('Login error:', error)
    return res.status(500).json({ error: 'Internal server error', message: '登录失败，请稍后重试' })
  }
}

export async function verifyToken(req, res) {
  try {
    const user = await findActiveUserById(req.user.id)
    if (!user) {
      return res.status(403).json({ error: 'User disabled', message: '账号不可用，请重新登录' })
    }

    return res.json({
      message: 'Token is valid',
      user: publicUser(user),
    })
  } catch (error) {
    console.error('Verify token error:', error)
    return res.status(500).json({ error: 'Internal server error', message: '登录校验失败' })
  }
}

export async function getUserApiKey(req, res) {
  try {
    const user = await findActiveUserById(req.user.id)
    if (!user) {
      return res.status(403).json({ error: 'User disabled', message: '账号不可用，请重新登录' })
    }

    const columns = await getTableColumns('tokens')
    if (!columns.has('key') || !columns.has('user_id')) {
      throw new Error('tokens table must contain user_id and key columns')
    }

    const where = ['`user_id` = ?']
    const params = [req.user.id]
    if (columns.has('status')) where.push('`status` = 1')
    if (columns.has('deleted_at')) where.push('`deleted_at` IS NULL')
    if (columns.has('expired_time')) where.push('(`expired_time` = -1 OR `expired_time` > ?)')
    if (columns.has('expired_time')) params.push(Math.floor(Date.now() / 1000))
    if (columns.has('remain_quota') && columns.has('unlimited_quota')) {
      where.push('(`unlimited_quota` = 1 OR `remain_quota` > 0)')
    } else if (columns.has('remain_quota')) {
      where.push('`remain_quota` > 0')
    }

    const select = selectExistingColumns(columns, ['id', 'key', 'name', 'status', 'created_time', 'expired_time', 'remain_quota', 'unlimited_quota'])
    const orderColumn = columns.has('created_time') ? 'created_time' : 'id'
    const [tokens] = await pool.query(
      `SELECT ${select} FROM \`tokens\` WHERE ${where.join(' AND ')} ORDER BY ${quoteColumn(orderColumn)} DESC LIMIT 1`,
      params,
    )

    if (tokens.length === 0) {
      return res.json({
        apiKey: '',
        message: '当前账号没有可用 API Key，请先在 macode 创建令牌',
      })
    }

    return res.json({
      apiKey: createNewApiKey(tokens[0].key),
      name: tokens[0].name || '',
    })
  } catch (error) {
    console.error('Get API key error:', error)
    return res.status(500).json({ error: 'Internal server error', message: '获取 API Key 失败' })
  }
}
