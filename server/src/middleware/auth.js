import jwt from 'jsonwebtoken'
import { getJwtSecret } from '../config/auth.js'

export function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization || ''
  const [scheme, token] = authHeader.split(' ')

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return res.status(401).json({ error: 'Access token required', message: '请先登录' })
  }

  jwt.verify(token, getJwtSecret(), (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token', message: '登录已过期，请重新登录' })
    }

    req.user = user
    next()
  })
}
