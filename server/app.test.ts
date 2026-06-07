import assert from 'node:assert/strict'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createApp } from './app'
import { initializeSchema } from './db/schema'
import { listAlerts, nextBillingDate } from './alerts'
import { MAX_UPLOAD_BYTES } from './files'
import { createFirstUser, createSession } from './auth'
import { decryptExport } from './data'

function testDb() {
  const db = new Database(':memory:')
  initializeSchema(db)
  return db
}

function testUploadDir() {
  return mkdtempSync(join(tmpdir(), 'mebox-upload-'))
}

async function closeTestApp(app: ReturnType<typeof createApp>, db: Database.Database) {
  await app.close()
  db.close()
}

function cookieFromResponse(response: Awaited<ReturnType<ReturnType<typeof createApp>['inject']>>) {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  assert.equal(typeof header, 'string')
  if (!header) {
    throw new Error('Missing session cookie')
  }

  return header.split(';')[0]
}

async function authCookie(app: ReturnType<typeof createApp>) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { password: 'correct horse battery staple' },
  })

  assert.equal(response.statusCode, 201)
  return cookieFromResponse(response)
}

function uploadRequest(input: {
  filename: string
  mimeType: string
  body?: Buffer
  cookie?: string
}) {
  return {
    method: 'POST' as const,
    url: '/api/items/files',
    headers: {
      'content-type': input.mimeType,
      'x-filename': input.filename,
      ...(input.cookie ? { cookie: input.cookie } : {}),
    },
    payload: input.body ?? Buffer.from('hello'),
  }
}

function tableCount(db: Database.Database, tableName: string) {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as {
      count: number
    }
  ).count
}

test('creates and lists note items', async () => {
  const db = testDb()
  const app = createApp({ db })
  const cookie = await authCookie(app)

  const createResponse = await app.inject({
    method: 'POST',
    url: '/api/items/notes',
    headers: { cookie },
    payload: { body: 'private note' },
  })

  assert.equal(createResponse.statusCode, 201)
  const listResponse = await app.inject({
    url: '/api/items',
    headers: { cookie },
  })
  const payload = listResponse.json()

  assert.equal(payload.items.length, 1)
  assert.equal(payload.items[0].type, 'note')
  assert.equal(payload.items[0].detail.text, 'private note')
  await closeTestApp(app, db)
})

test('searches notes and links without requiring external services', async () => {
  const db = testDb()
  const app = createApp({ db })
  const cookie = await authCookie(app)

  await app.inject({
    method: 'POST',
    url: '/api/items/notes',
    headers: { cookie },
    payload: { body: 'receipt for laptop stand' },
  })
  await app.inject({
    method: 'POST',
    url: '/api/items/links',
    headers: { cookie },
    payload: { url: 'https://example.test/read', title: 'Reading list' },
  })

  const response = await app.inject({
    url: '/api/search?q=read',
    headers: { cookie },
  })
  const payload = response.json()

  assert.equal(response.statusCode, 200)
  assert.equal(payload.items.length, 1)
  assert.equal(payload.items[0].type, 'link')
  await closeTestApp(app, db)
})

test('returns overdue todo and recurring expense alerts', () => {
  const db = testDb()
  const itemId = Number(
    db.prepare('INSERT INTO items (type, body) VALUES (?, ?)').run('todo', 'tax').lastInsertRowid,
  )
  db.prepare('INSERT INTO todos (item_id, title, due_at) VALUES (?, ?, ?)').run(
    itemId,
    'tax',
    '2026-06-07T00:00:00.000Z',
  )
  const expenseId = Number(
    db
      .prepare('INSERT INTO items (type, body) VALUES (?, ?)')
      .run('recurring_expense', 'hosting').lastInsertRowid,
  )
  db.prepare(
    `INSERT INTO recurring_expenses
      (item_id, name, amount, currency, billing_day, reminder_days_before)
      VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(expenseId, 'hosting', 12, 'USD', 10, 3)

  const alerts = listAlerts(db, new Date('2026-06-08T00:00:00.000Z'))

  assert.equal(alerts.length, 2)
  assert.equal(alerts[0].type, 'todo')
  assert.equal(alerts[1].type, 'recurring_expense')
  db.close()
})

test('clamps billing dates to the end of shorter months', () => {
  const dueDate = nextBillingDate(new Date('2026-02-01T00:00:00.000Z'), 31)
  assert.equal(dueDate.toISOString(), '2026-02-28T00:00:00.000Z')
})

test('accepts allowed file MIME type and persists metadata', async () => {
  const db = testDb()
  const uploadDir = testUploadDir()
  const app = createApp({ db, uploadDir })
  const cookie = await authCookie(app)

  const response = await app.inject(
    uploadRequest({
      filename: 'photo.png',
      mimeType: 'image/png',
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      cookie,
    }),
  )
  const payload = response.json()
  const row = db
    .prepare('SELECT original_name, stored_name, mime_type, size_bytes FROM files')
    .get() as {
    original_name: string
    stored_name: string
    mime_type: string
    size_bytes: number
  }

  assert.equal(response.statusCode, 201)
  assert.equal(payload.item.type, 'file')
  assert.equal(row.original_name, 'photo.png')
  assert.equal(row.mime_type, 'image/png')
  assert.equal(row.size_bytes, 4)
  assert.notEqual(row.stored_name, 'photo.png')
  assert.match(row.stored_name, /^[a-f0-9]{32}\.png$/)
  assert.equal(existsSync(join(uploadDir, row.stored_name)), true)
  assert.equal(existsSync(join(uploadDir, row.original_name)), false)

  await closeTestApp(app, db)
  rmSync(uploadDir, { recursive: true, force: true })
})

test('rejects blocked file MIME type', async () => {
  const db = testDb()
  const uploadDir = testUploadDir()
  const app = createApp({ db, uploadDir })
  const cookie = await authCookie(app)

  const response = await app.inject(
    uploadRequest({
      filename: 'archive.zip',
      mimeType: 'application/zip',
      cookie,
    }),
  )

  assert.equal(response.statusCode, 415)
  assert.deepEqual(response.json(), { error: 'File type is not allowed' })
  assert.equal(tableCount(db, 'files'), 0)

  await closeTestApp(app, db)
  rmSync(uploadDir, { recursive: true, force: true })
})

test('rejects dangerous file extension even with allowed MIME type', async () => {
  const db = testDb()
  const uploadDir = testUploadDir()
  const app = createApp({ db, uploadDir })
  const cookie = await authCookie(app)

  const response = await app.inject(
    uploadRequest({
      filename: 'script.js',
      mimeType: 'text/plain',
      cookie,
    }),
  )

  assert.equal(response.statusCode, 400)
  assert.deepEqual(response.json(), { error: 'File type is not allowed' })
  assert.equal(tableCount(db, 'files'), 0)

  await closeTestApp(app, db)
  rmSync(uploadDir, { recursive: true, force: true })
})

test('rejects uploads over the size limit', async () => {
  const db = testDb()
  const uploadDir = testUploadDir()
  const app = createApp({ db, uploadDir })
  const cookie = await authCookie(app)

  const response = await app.inject(
    uploadRequest({
      filename: 'large.txt',
      mimeType: 'text/plain',
      body: Buffer.alloc(MAX_UPLOAD_BYTES + 1, 'a'),
      cookie,
    }),
  )

  assert.equal(response.statusCode, 413)
  assert.deepEqual(response.json(), { error: 'File is too large' })
  assert.equal(tableCount(db, 'files'), 0)

  await closeTestApp(app, db)
  rmSync(uploadDir, { recursive: true, force: true })
})

test('rejects upload filename path traversal', async () => {
  const db = testDb()
  const uploadDir = testUploadDir()
  const app = createApp({ db, uploadDir })
  const cookie = await authCookie(app)

  const response = await app.inject(
    uploadRequest({
      filename: '../safe.txt',
      mimeType: 'text/plain',
      cookie,
    }),
  )

  assert.equal(response.statusCode, 400)
  assert.deepEqual(response.json(), { error: 'Invalid filename' })
  assert.equal(tableCount(db, 'files'), 0)

  await closeTestApp(app, db)
  rmSync(uploadDir, { recursive: true, force: true })
})

test('download route rejects stored filename path traversal', async () => {
  const db = testDb()
  const uploadDir = testUploadDir()
  const app = createApp({ db, uploadDir })
  await createFirstUser(db, { password: 'correct horse battery staple' })
  const session = createSession(db, 1)
  const cookie = `mebox_session=${session.token}`
  const itemId = Number(
    db
      .prepare('INSERT INTO items (type, body) VALUES (?, ?)')
      .run('file', 'safe.txt').lastInsertRowid,
  )
  db.prepare(
    `INSERT INTO files
      (item_id, original_name, stored_name, mime_type, size_bytes)
      VALUES (?, ?, ?, ?, ?)`,
  ).run(itemId, 'safe.txt', '../safe.txt', 'text/plain', 4)

  const response = await app.inject({
    url: `/api/files/${itemId}`,
    headers: { cookie },
  })

  assert.equal(response.statusCode, 404)
  assert.deepEqual(response.json(), { error: 'File not found' })

  await closeTestApp(app, db)
  rmSync(uploadDir, { recursive: true, force: true })
})

test('missing file id returns safe 404', async () => {
  const db = testDb()
  const uploadDir = testUploadDir()
  const app = createApp({ db, uploadDir })
  const cookie = await authCookie(app)

  const response = await app.inject({
    url: '/api/files/9999',
    headers: { cookie },
  })

  assert.equal(response.statusCode, 404)
  assert.deepEqual(response.json(), { error: 'File not found' })

  await closeTestApp(app, db)
  rmSync(uploadDir, { recursive: true, force: true })
})

test('setup creates first user with argon2id hash and safe response', async () => {
  const db = testDb()
  const app = createApp({ db })
  const password = 'correct horse battery staple'

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'me', password },
  })
  const payloadText = response.payload
  const user = db
    .prepare('SELECT username, password_hash FROM users WHERE id = 1')
    .get() as { username: string; password_hash: string }

  assert.equal(response.statusCode, 201)
  assert.equal(response.json().authenticated, true)
  assert.equal(user.username, 'me')
  assert.match(user.password_hash, /^\$argon2id\$/)
  assert.notEqual(user.password_hash, password)
  assert.equal(payloadText.includes(password), false)
  assert.equal(payloadText.includes(user.password_hash), false)
  assert.equal(payloadText.includes('token'), false)

  await closeTestApp(app, db)
})

test('setup refuses second user', async () => {
  const db = testDb()
  const app = createApp({ db })

  await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { password: 'correct horse battery staple' },
  })
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { password: 'another correct battery staple' },
  })

  assert.equal(response.statusCode, 409)
  assert.deepEqual(response.json(), { error: 'Setup is already complete' })
  assert.equal(tableCount(db, 'users'), 1)

  await closeTestApp(app, db)
})

test('login succeeds with correct password and returns HttpOnly cookie', async () => {
  const db = testDb()
  const app = createApp({ db })

  await createFirstUser(db, { password: 'correct horse battery staple' })
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: 'correct horse battery staple' },
  })
  const cookie = response.headers['set-cookie']

  assert.equal(response.statusCode, 200)
  assert.equal(response.json().authenticated, true)
  assert.equal(JSON.stringify(response.json()).includes('token'), false)
  assert.equal(typeof cookie, 'string')
  assert.match(String(cookie), /HttpOnly/)
  assert.match(String(cookie), /SameSite=Lax/)

  await closeTestApp(app, db)
})

test('login fails with wrong password using generic response', async () => {
  const db = testDb()
  const app = createApp({ db })

  await createFirstUser(db, { password: 'correct horse battery staple' })
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: 'wrong password' },
  })

  assert.equal(response.statusCode, 401)
  assert.deepEqual(response.json(), { error: 'Invalid password' })
  assert.equal(response.headers['set-cookie'], undefined)

  await closeTestApp(app, db)
})

test('protected routes reject unauthenticated requests', async () => {
  const db = testDb()
  const app = createApp({ db })

  await createFirstUser(db, { password: 'correct horse battery staple' })
  const response = await app.inject('/api/items')

  assert.equal(response.statusCode, 401)
  assert.deepEqual(response.json(), { error: 'Authentication required' })

  await closeTestApp(app, db)
})

test('protected routes accept authenticated session cookie', async () => {
  const db = testDb()
  const app = createApp({ db })
  const cookie = await authCookie(app)

  const response = await app.inject({
    url: '/api/items',
    headers: { cookie },
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { items: [] })

  await closeTestApp(app, db)
})

test('logout invalidates session server-side', async () => {
  const db = testDb()
  const app = createApp({ db })
  const cookie = await authCookie(app)

  const logoutResponse = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: { cookie },
  })
  const protectedResponse = await app.inject({
    url: '/api/items',
    headers: { cookie },
  })

  assert.equal(logoutResponse.statusCode, 200)
  assert.match(String(logoutResponse.headers['set-cookie']), /Max-Age=0/)
  assert.equal(protectedResponse.statusCode, 401)

  await closeTestApp(app, db)
})

test('expired session is rejected', async () => {
  const db = testDb()
  const app = createApp({ db })

  await createFirstUser(db, { password: 'correct horse battery staple' })
  const session = createSession(db, 1, new Date('2020-01-01T00:00:00.000Z'))
  const response = await app.inject({
    url: '/api/items',
    headers: { cookie: `mebox_session=${session.token}` },
  })

  assert.equal(response.statusCode, 401)

  await closeTestApp(app, db)
})

test('change password succeeds with current password', async () => {
  const db = testDb()
  const app = createApp({ db })
  const cookie = await authCookie(app)

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: { cookie },
    payload: {
      currentPassword: 'correct horse battery staple',
      newPassword: 'new correct horse battery staple',
    },
  })

  assert.equal(response.statusCode, 200)
  assert.equal(response.json().ok, true)
  assert.equal(JSON.stringify(response.json()).includes('password'), false)

  await closeTestApp(app, db)
})

test('change password fails with wrong current password', async () => {
  const db = testDb()
  const app = createApp({ db })
  const cookie = await authCookie(app)

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: { cookie },
    payload: {
      currentPassword: 'wrong password',
      newPassword: 'new correct horse battery staple',
    },
  })

  assert.equal(response.statusCode, 401)
  assert.deepEqual(response.json(), { error: 'Invalid password' })

  await closeTestApp(app, db)
})

test('old password no longer works and new password works after change', async () => {
  const db = testDb()
  const app = createApp({ db })
  const cookie = await authCookie(app)

  await app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: { cookie },
    payload: {
      currentPassword: 'correct horse battery staple',
      newPassword: 'new correct horse battery staple',
    },
  })
  const oldLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: 'correct horse battery staple' },
  })
  const newLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: 'new correct horse battery staple' },
  })

  assert.equal(oldLogin.statusCode, 401)
  assert.equal(newLogin.statusCode, 200)

  await closeTestApp(app, db)
})

test('plain export excludes password hashes and sessions', async () => {
  const db = testDb()
  const app = createApp({ db })
  const cookie = await authCookie(app)

  await app.inject({
    method: 'POST',
    url: '/api/items/notes',
    headers: { cookie },
    payload: { body: 'exported note' },
  })
  const response = await app.inject({
    method: 'POST',
    url: '/api/data/export',
    headers: { cookie },
    payload: { format: 'plain' },
  })

  assert.equal(response.statusCode, 200)
  assert.equal(response.payload.includes('exported note'), true)
  assert.equal(response.payload.includes('password_hash'), false)
  assert.equal(response.payload.includes('sessions'), false)

  await closeTestApp(app, db)
})

test('encrypted export does not contain plaintext JSON and can be decrypted', async () => {
  const db = testDb()
  const app = createApp({ db })
  const cookie = await authCookie(app)
  const password = 'export password'

  await app.inject({
    method: 'POST',
    url: '/api/items/notes',
    headers: { cookie },
    payload: { body: 'private exported note' },
  })
  const response = await app.inject({
    method: 'POST',
    url: '/api/data/export',
    headers: { cookie },
    payload: { format: 'encrypted', password },
  })
  const encrypted = response.json()
  const decrypted = decryptExport(encrypted, password)

  assert.equal(response.statusCode, 200)
  assert.equal(response.payload.includes('private exported note'), false)
  assert.equal(response.payload.includes('"items"'), false)
  assert.equal(decrypted.tables.items.length, 1)
  assert.equal(decrypted.tables.items[0].body, 'private exported note')

  await closeTestApp(app, db)
})

test('import rejects invalid JSON payload', async () => {
  const db = testDb()
  const app = createApp({ db })
  const cookie = await authCookie(app)

  const response = await app.inject({
    method: 'POST',
    url: '/api/data/import',
    headers: { cookie },
    payload: { format: 'plain', payload: 'not json' },
  })

  assert.equal(response.statusCode, 400)
  assert.deepEqual(response.json(), { error: 'Invalid import file' })

  await closeTestApp(app, db)
})

test('import rejects malformed encrypted payload', async () => {
  const db = testDb()
  const app = createApp({ db })
  const cookie = await authCookie(app)

  const response = await app.inject({
    method: 'POST',
    url: '/api/data/import',
    headers: { cookie },
    payload: {
      format: 'encrypted',
      password: 'import password',
      payload: { format: 'mebox-encrypted-json' },
    },
  })

  assert.equal(response.statusCode, 400)
  assert.equal(response.json().error.length > 0, true)

  await closeTestApp(app, db)
})

test('settings default reminder advance can be read and updated', async () => {
  const db = testDb()
  const app = createApp({ db })
  const cookie = await authCookie(app)

  const readResponse = await app.inject({
    url: '/api/settings',
    headers: { cookie },
  })
  const updateResponse = await app.inject({
    method: 'PATCH',
    url: '/api/settings',
    headers: { cookie },
    payload: { defaultReminderAdvanceMinutes: 60 },
  })
  const rereadResponse = await app.inject({
    url: '/api/settings',
    headers: { cookie },
  })

  assert.equal(readResponse.statusCode, 200)
  assert.equal(readResponse.json().defaultReminderAdvanceMinutes, 15)
  assert.equal(updateResponse.statusCode, 200)
  assert.equal(updateResponse.json().defaultReminderAdvanceMinutes, 60)
  assert.equal(rereadResponse.json().defaultReminderAdvanceMinutes, 60)

  await closeTestApp(app, db)
})

test('delete account requires DELETE confirmation', async () => {
  const db = testDb()
  const app = createApp({ db })
  const cookie = await authCookie(app)

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/delete-account',
    headers: { cookie },
    payload: { confirmation: 'delete' },
  })

  assert.equal(response.statusCode, 400)
  assert.equal(tableCount(db, 'users'), 1)

  await closeTestApp(app, db)
})

test('delete account clears sessions, users, and app data within app scope', async () => {
  const db = testDb()
  const uploadDir = testUploadDir()
  const app = createApp({ db, uploadDir })
  const cookie = await authCookie(app)

  await app.inject({
    method: 'POST',
    url: '/api/items/notes',
    headers: { cookie },
    payload: { body: 'delete me' },
  })
  await app.inject({
    method: 'PATCH',
    url: '/api/settings',
    headers: { cookie },
    payload: { defaultReminderAdvanceMinutes: 30 },
  })
  const upload = await app.inject(
    uploadRequest({
      filename: 'delete.txt',
      mimeType: 'text/plain',
      body: Buffer.from('delete file'),
      cookie,
    }),
  )
  const storedName = (
    db.prepare('SELECT stored_name FROM files').get() as { stored_name: string }
  ).stored_name
  assert.equal(upload.statusCode, 201)
  assert.equal(existsSync(join(uploadDir, storedName)), true)

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/delete-account',
    headers: { cookie },
    payload: { confirmation: 'DELETE' },
  })

  assert.equal(response.statusCode, 200)
  assert.equal(tableCount(db, 'users'), 0)
  assert.equal(tableCount(db, 'sessions'), 0)
  assert.equal(tableCount(db, 'items'), 0)
  assert.equal(tableCount(db, 'app_settings'), 0)
  assert.equal(existsSync(join(uploadDir, storedName)), false)

  await closeTestApp(app, db)
  rmSync(uploadDir, { recursive: true, force: true })
})
