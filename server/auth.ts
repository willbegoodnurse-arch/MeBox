import type Database from 'better-sqlite3'
import { randomBytes, createHash } from 'node:crypto'
import argon2 from 'argon2'

export const SESSION_COOKIE_NAME = 'mebox_session'
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14

type UserRow = {
  id: number
  username: string
  password_hash: string
}

type SessionRow = {
  id: number
  user_id: number
  expires_at: string
  revoked_at: string | null
  username: string
}

export class AuthError extends Error {
  statusCode: number

  constructor(message: string, statusCode = 400) {
    super(message)
    this.name = 'AuthError'
    this.statusCode = statusCode
  }
}

function nowIso(now = new Date()) {
  return now.toISOString()
}

function expiresAt(now = new Date()) {
  return new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString()
}

export function hashSessionToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function sessionToken() {
  return randomBytes(32).toString('base64url')
}

export function hasUser(db: Database.Database) {
  const row = db.prepare('SELECT id FROM users WHERE id = 1').get()
  return row !== undefined
}

export async function createFirstUser(
  db: Database.Database,
  input: { username?: string; password: string },
) {
  if (hasUser(db)) {
    throw new AuthError('Setup is already complete', 409)
  }

  const passwordHash = await argon2.hash(input.password, {
    type: argon2.argon2id,
  })
  const username = input.username?.trim() || 'local'

  db.prepare(
    'INSERT INTO users (id, username, password_hash) VALUES (1, ?, ?)',
  ).run(username, passwordHash)

  return { id: 1, username }
}

export async function verifyLogin(
  db: Database.Database,
  input: { password: string },
) {
  const user = db
    .prepare('SELECT id, username, password_hash FROM users WHERE id = 1')
    .get() as UserRow | undefined

  if (!user) {
    throw new AuthError('Invalid password', 401)
  }

  const ok = await argon2.verify(user.password_hash, input.password)
  if (!ok) {
    throw new AuthError('Invalid password', 401)
  }

  return { id: user.id, username: user.username }
}

export async function changePassword(
  db: Database.Database,
  input: { currentPassword: string; newPassword: string; currentToken?: string },
) {
  const user = db
    .prepare('SELECT id, username, password_hash FROM users WHERE id = 1')
    .get() as UserRow | undefined

  if (!user) {
    throw new AuthError('Invalid password', 401)
  }

  const ok = await argon2.verify(user.password_hash, input.currentPassword)
  if (!ok) {
    throw new AuthError('Invalid password', 401)
  }

  const passwordHash = await argon2.hash(input.newPassword, {
    type: argon2.argon2id,
  })
  db.prepare(
    "UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = 1",
  ).run(passwordHash)

  revokeOtherSessions(db, input.currentToken)
  return { id: user.id, username: user.username }
}

export function createSession(db: Database.Database, userId: number, now = new Date()) {
  cleanupExpiredSessions(db, now)

  const token = sessionToken()
  const tokenHash = hashSessionToken(token)
  const expiry = expiresAt(now)

  db.prepare(
    'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
  ).run(userId, tokenHash, expiry)

  return {
    token,
    expiresAt: expiry,
  }
}

export function validateSession(
  db: Database.Database,
  token: string | undefined,
  now = new Date(),
) {
  if (!token) {
    return null
  }

  const row = db
    .prepare(
      `SELECT sessions.id, sessions.user_id, sessions.expires_at, sessions.revoked_at, users.username
       FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ?`,
    )
    .get(hashSessionToken(token)) as SessionRow | undefined

  if (!row || row.revoked_at || new Date(row.expires_at) <= now) {
    return null
  }

  return {
    sessionId: row.id,
    user: {
      id: row.user_id,
      username: row.username,
    },
    expiresAt: row.expires_at,
  }
}

export function revokeSession(db: Database.Database, token: string | undefined) {
  if (!token) {
    return
  }

  db.prepare(
    `UPDATE sessions
     SET revoked_at = ?
     WHERE token_hash = ? AND revoked_at IS NULL`,
  ).run(nowIso(), hashSessionToken(token))
}

export function revokeOtherSessions(db: Database.Database, token: string | undefined) {
  if (!token) {
    db.prepare("UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL").run(
      nowIso(),
    )
    return
  }

  db.prepare(
    `UPDATE sessions
     SET revoked_at = ?
     WHERE token_hash != ? AND revoked_at IS NULL`,
  ).run(nowIso(), hashSessionToken(token))
}

export function cleanupExpiredSessions(db: Database.Database, now = new Date()) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL').run(
    nowIso(now),
  )
}

export function parseCookie(header: string | undefined, name: string) {
  if (!header) {
    return undefined
  }

  for (const part of header.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=')
    if (rawKey === name) {
      return decodeURIComponent(rawValue.join('='))
    }
  }

  return undefined
}

export function makeSessionCookie(input: {
  token: string
  maxAgeSeconds: number
  secure: boolean
}) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(input.token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${input.maxAgeSeconds}`,
  ]

  if (input.secure) {
    parts.push('Secure')
  }

  return parts.join('; ')
}

export function makeLogoutCookie(secure: boolean) {
  return makeSessionCookie({ token: '', maxAgeSeconds: 0, secure })
}
