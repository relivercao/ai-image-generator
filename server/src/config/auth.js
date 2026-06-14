export function getJwtSecret() {
  return process.env.JWT_SECRET || 'macode-image-playground-dev-secret'
}

export function getJwtExpiresIn() {
  return process.env.JWT_EXPIRES_IN || '30d'
}
