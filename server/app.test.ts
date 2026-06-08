import assert from 'node:assert/strict'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

function appSource() {
  return readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8')
}

function sourceBetween(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex)
  assert.notEqual(startIndex, -1)
  assert.notEqual(endIndex, -1)
  return source.slice(startIndex, endIndex)
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

test('lists inbox items oldest to newest', async () => {
  const db = testDb()
  const app = createApp({ db })
  const cookie = await authCookie(app)

  await app.inject({
    method: 'POST',
    url: '/api/items/notes',
    headers: { cookie },
    payload: { body: 'oldest note' },
  })
  await app.inject({
    method: 'POST',
    url: '/api/items/notes',
    headers: { cookie },
    payload: { body: 'newest note' },
  })
  const response = await app.inject({
    url: '/api/items',
    headers: { cookie },
  })
  const payload = response.json()

  assert.deepEqual(
    payload.items.map((item: { detail: { text: string } }) => item.detail.text),
    ['oldest note', 'newest note'],
  )

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

test('username can be updated and is reflected in the active session', async () => {
  const db = testDb()
  const app = createApp({ db })
  const cookie = await authCookie(app)

  const response = await app.inject({
    method: 'PATCH',
    url: '/api/auth/username',
    headers: { cookie },
    payload: { username: '  renamed local  ' },
  })
  const meResponse = await app.inject({
    url: '/api/auth/me',
    headers: { cookie },
  })
  const settingsResponse = await app.inject({
    url: '/api/settings',
    headers: { cookie },
  })

  assert.equal(response.statusCode, 200)
  assert.equal(response.json().user.username, 'renamed local')
  assert.equal(response.payload.includes('password_hash'), false)
  assert.equal(response.payload.includes('token'), false)
  assert.equal(meResponse.json().user.username, 'renamed local')
  assert.equal(settingsResponse.json().user.username, 'renamed local')

  await closeTestApp(app, db)
})

test('username update rejects empty names', async () => {
  const db = testDb()
  const app = createApp({ db })
  const cookie = await authCookie(app)

  const response = await app.inject({
    method: 'PATCH',
    url: '/api/auth/username',
    headers: { cookie },
    payload: { username: '   ' },
  })

  assert.equal(response.statusCode, 400)
  assert.equal(
    (db.prepare('SELECT username FROM users WHERE id = 1').get() as { username: string })
      .username,
    'local',
  )

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

test('plain import restores exported supported data without auth material', async () => {
  const sourceDb = testDb()
  const sourceApp = createApp({ db: sourceDb })
  const sourceCookie = await authCookie(sourceApp)

  await sourceApp.inject({
    method: 'POST',
    url: '/api/items/notes',
    headers: { cookie: sourceCookie },
    payload: { body: 'round trip note' },
  })
  await sourceApp.inject({
    method: 'POST',
    url: '/api/items/links',
    headers: { cookie: sourceCookie },
    payload: { url: 'https://example.test/restore', title: 'restore link' },
  })
  await sourceApp.inject(
    uploadRequest({
      filename: 'restore.txt',
      mimeType: 'text/plain',
      body: Buffer.from('not exported'),
      cookie: sourceCookie,
    }),
  )
  await sourceApp.inject({
    method: 'PATCH',
    url: '/api/settings',
    headers: { cookie: sourceCookie },
    payload: { defaultReminderAdvanceMinutes: 60 },
  })
  const exportResponse = await sourceApp.inject({
    method: 'POST',
    url: '/api/data/export',
    headers: { cookie: sourceCookie },
    payload: { format: 'plain' },
  })
  const exported = exportResponse.json()

  const targetDb = testDb()
  const targetApp = createApp({ db: targetDb })
  const targetCookie = await authCookie(targetApp)
  const importResponse = await targetApp.inject({
    method: 'POST',
    url: '/api/data/import',
    headers: { cookie: targetCookie },
    payload: { format: 'plain', payload: exported },
  })
  const itemsResponse = await targetApp.inject({
    url: '/api/items',
    headers: { cookie: targetCookie },
  })
  const filesResponse = await targetApp.inject({
    url: '/api/files',
    headers: { cookie: targetCookie },
  })
  const settingsResponse = await targetApp.inject({
    url: '/api/settings',
    headers: { cookie: targetCookie },
  })

  assert.equal(importResponse.statusCode, 200)
  assert.equal(importResponse.json().importedItems, 3)
  assert.equal(itemsResponse.json().items.length, 3)
  assert.equal(
    itemsResponse
      .json()
      .items.some((item: { detail: { text?: string } | null }) => item.detail?.text === 'round trip note'),
    true,
  )
  assert.equal(filesResponse.json().files.length, 1)
  assert.equal(filesResponse.json().files[0].originalName, 'restore.txt')
  assert.equal(settingsResponse.json().defaultReminderAdvanceMinutes, 60)
  assert.equal(tableCount(targetDb, 'users'), 1)
  assert.equal(tableCount(targetDb, 'sessions'), 1)

  await closeTestApp(sourceApp, sourceDb)
  await closeTestApp(targetApp, targetDb)
})

test('plain import accepts the actual exported JSON file content and returns imported items from inbox', async () => {
  const sourceDb = testDb()
  const sourceApp = createApp({ db: sourceDb })
  const sourceCookie = await authCookie(sourceApp)

  await sourceApp.inject({
    method: 'POST',
    url: '/api/items/notes',
    headers: { cookie: sourceCookie },
    payload: { body: 'plain file note' },
  })
  await sourceApp.inject({
    method: 'POST',
    url: '/api/items/todos',
    headers: { cookie: sourceCookie },
    payload: { title: 'plain file todo' },
  })
  const exportResponse = await sourceApp.inject({
    method: 'POST',
    url: '/api/data/export',
    headers: { cookie: sourceCookie },
    payload: { format: 'plain' },
  })

  const targetDb = testDb()
  const targetApp = createApp({ db: targetDb })
  const targetCookie = await authCookie(targetApp)
  const importResponse = await targetApp.inject({
    method: 'POST',
    url: '/api/data/import',
    headers: { cookie: targetCookie },
    payload: { format: 'plain', payload: exportResponse.payload },
  })
  const itemsResponse = await targetApp.inject({
    url: '/api/items',
    headers: { cookie: targetCookie },
  })
  const items = itemsResponse.json().items as Array<{
    type: string
    detail: Record<string, unknown> | null
  }>

  assert.equal(importResponse.statusCode, 200)
  assert.equal(importResponse.json().importedItems, 2)
  assert.equal(itemsResponse.statusCode, 200)
  assert.equal(items.length, 2)
  assert.equal(items.some((item) => item.detail?.text === 'plain file note'), true)
  assert.equal(items.some((item) => item.detail?.title === 'plain file todo'), true)

  await closeTestApp(sourceApp, sourceDb)
  await closeTestApp(targetApp, targetDb)
})

test('encrypted export can be imported with the correct password', async () => {
  const sourceDb = testDb()
  const sourceApp = createApp({ db: sourceDb })
  const sourceCookie = await authCookie(sourceApp)
  const password = 'export password'

  await sourceApp.inject({
    method: 'POST',
    url: '/api/items/notes',
    headers: { cookie: sourceCookie },
    payload: { body: 'encrypted round trip note' },
  })
  const exportResponse = await sourceApp.inject({
    method: 'POST',
    url: '/api/data/export',
    headers: { cookie: sourceCookie },
    payload: { format: 'encrypted', password },
  })

  const targetDb = testDb()
  const targetApp = createApp({ db: targetDb })
  const targetCookie = await authCookie(targetApp)
  const importResponse = await targetApp.inject({
    method: 'POST',
    url: '/api/data/import',
    headers: { cookie: targetCookie },
    payload: { format: 'encrypted', password, payload: exportResponse.json() },
  })
  const itemsResponse = await targetApp.inject({
    url: '/api/items',
    headers: { cookie: targetCookie },
  })

  assert.equal(importResponse.statusCode, 200)
  assert.equal(itemsResponse.json().items[0].detail.text, 'encrypted round trip note')

  await closeTestApp(sourceApp, sourceDb)
  await closeTestApp(targetApp, targetDb)
})

test('encrypted import accepts the actual exported JSON file content and rejects wrong or corrupted payloads safely', async () => {
  const sourceDb = testDb()
  const sourceApp = createApp({ db: sourceDb })
  const sourceCookie = await authCookie(sourceApp)
  const password = 'export password'

  await sourceApp.inject({
    method: 'POST',
    url: '/api/items/notes',
    headers: { cookie: sourceCookie },
    payload: { body: 'encrypted file note' },
  })
  await sourceApp.inject({
    method: 'POST',
    url: '/api/items/lists',
    headers: { cookie: sourceCookie },
    payload: { title: 'encrypted file list', items: [{ text: 'first' }, { text: 'second' }] },
  })
  const exportResponse = await sourceApp.inject({
    method: 'POST',
    url: '/api/data/export',
    headers: { cookie: sourceCookie },
    payload: { format: 'encrypted', password },
  })

  const targetDb = testDb()
  const targetApp = createApp({ db: targetDb })
  const targetCookie = await authCookie(targetApp)
  const importResponse = await targetApp.inject({
    method: 'POST',
    url: '/api/data/import',
    headers: { cookie: targetCookie },
    payload: { format: 'encrypted', password, payload: exportResponse.payload },
  })
  const wrongPasswordResponse = await targetApp.inject({
    method: 'POST',
    url: '/api/data/import',
    headers: { cookie: targetCookie },
    payload: {
      format: 'encrypted',
      password: 'wrong password',
      payload: exportResponse.payload,
    },
  })
  const encryptedFile = JSON.parse(exportResponse.payload) as { ciphertext: string }
  const corruptedFile = JSON.stringify({
    ...encryptedFile,
    ciphertext: `${encryptedFile.ciphertext.slice(0, -4)}AAAA`,
  })
  const corruptedResponse = await targetApp.inject({
    method: 'POST',
    url: '/api/data/import',
    headers: { cookie: targetCookie },
    payload: { format: 'encrypted', password, payload: corruptedFile },
  })
  const itemsResponse = await targetApp.inject({
    url: '/api/items',
    headers: { cookie: targetCookie },
  })
  const items = itemsResponse.json().items as Array<{
    type: string
    detail: Record<string, unknown> | null
  }>

  assert.equal(importResponse.statusCode, 200)
  assert.equal(importResponse.json().importedItems, 2)
  assert.equal(items.some((item) => item.detail?.text === 'encrypted file note'), true)
  assert.equal(items.some((item) => item.detail?.title === 'encrypted file list'), true)
  assert.equal(wrongPasswordResponse.statusCode, 400)
  assert.deepEqual(wrongPasswordResponse.json(), { error: 'Invalid import file' })
  assert.equal(corruptedResponse.statusCode, 400)
  assert.deepEqual(corruptedResponse.json(), { error: 'Invalid import file' })

  await closeTestApp(sourceApp, sourceDb)
  await closeTestApp(targetApp, targetDb)
})

test('encrypted import fails safely with the wrong password', async () => {
  const db = testDb()
  const app = createApp({ db })
  const cookie = await authCookie(app)

  await app.inject({
    method: 'POST',
    url: '/api/items/notes',
    headers: { cookie },
    payload: { body: 'encrypted source' },
  })
  const exportResponse = await app.inject({
    method: 'POST',
    url: '/api/data/export',
    headers: { cookie },
    payload: { format: 'encrypted', password: 'correct password' },
  })
  const importResponse = await app.inject({
    method: 'POST',
    url: '/api/data/import',
    headers: { cookie },
    payload: {
      format: 'encrypted',
      password: 'wrong password',
      payload: exportResponse.json(),
    },
  })

  assert.equal(importResponse.statusCode, 400)
  assert.deepEqual(importResponse.json(), { error: 'Invalid import file' })

  await closeTestApp(app, db)
})

test('plain import rejects auth tables in the payload', async () => {
  const db = testDb()
  const app = createApp({ db })
  const cookie = await authCookie(app)

  const response = await app.inject({
    method: 'POST',
    url: '/api/data/import',
    headers: { cookie },
    payload: {
      format: 'plain',
      payload: {
        version: 1,
        exportedAt: new Date().toISOString(),
        users: [{ id: 1, username: 'imported', password_hash: 'hash' }],
        sessions: [{ token_hash: 'hash' }],
        tables: {
          items: [],
          links: [],
          todos: [],
          lists: [],
          list_items: [],
          files: [],
          announcements: [],
          recurring_expenses: [],
          app_settings: [],
        },
      },
    },
  })

  assert.equal(response.statusCode, 400)
  assert.deepEqual(response.json(), { error: 'Invalid import file' })
  assert.equal(tableCount(db, 'users'), 1)
  assert.equal(tableCount(db, 'sessions'), 1)

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

test('import rejects corrupted encrypted payload', async () => {
  const db = testDb()
  const app = createApp({ db })
  const cookie = await authCookie(app)

  const exportResponse = await app.inject({
    method: 'POST',
    url: '/api/data/export',
    headers: { cookie },
    payload: { format: 'encrypted', password: 'correct password' },
  })
  const corrupted = {
    ...exportResponse.json(),
    ciphertext: 'AAAA' + exportResponse.json().ciphertext,
  }
  const response = await app.inject({
    method: 'POST',
    url: '/api/data/import',
    headers: { cookie },
    payload: {
      format: 'encrypted',
      password: 'correct password',
      payload: corrupted,
    },
  })

  assert.equal(response.statusCode, 400)
  assert.deepEqual(response.json(), { error: 'Invalid import file' })

  await closeTestApp(app, db)
})

test('frontend import flow refetches the same inbox endpoint after successful import', () => {
  const source = appSource()
  const importScreen = sourceBetween(
    source,
    'function ImportDataScreen',
    'function ReminderScreen',
  )

  assert.match(importScreen, /\/api\/data\/import/)
  assert.match(importScreen, /onImported/)

  const appComponent = sourceBetween(source, 'function App()', 'export default App')
  assert.match(appComponent, /\/api\/items/)
  assert.match(appComponent, /onImported/)
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

test('delete account invalidates old session, blocks old login, and reopens setup', async () => {
  const db = testDb()
  const app = createApp({ db })
  const password = 'correct horse battery staple'

  const setupResponse = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'deleted-user', password },
  })
  const cookie = cookieFromResponse(setupResponse)
  const loginBeforeDelete = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password },
  })
  const deleteResponse = await app.inject({
    method: 'POST',
    url: '/api/auth/delete-account',
    headers: { cookie },
    payload: { confirmation: 'DELETE' },
  })
  const oldSessionResponse = await app.inject({
    url: '/api/items',
    headers: { cookie },
  })
  const oldLoginResponse = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password },
  })
  const meResponse = await app.inject({
    url: '/api/auth/me',
    headers: { cookie },
  })
  const setupAgainResponse = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'deleted-user', password },
  })

  assert.equal(loginBeforeDelete.statusCode, 200)
  assert.equal(deleteResponse.statusCode, 200)
  assert.match(String(deleteResponse.headers['set-cookie']), /Max-Age=0/)
  assert.equal(oldSessionResponse.statusCode, 401)
  assert.equal(oldLoginResponse.statusCode, 401)
  assert.deepEqual(meResponse.json(), {
    authenticated: false,
    setupRequired: true,
    user: null,
  })
  assert.equal(setupAgainResponse.statusCode, 201)

  await closeTestApp(app, db)
})

test('frontend delete-account flow asks auth/me which screen is required after deletion', () => {
  const source = appSource()
  const deleteScreen = sourceBetween(
    source,
    'function DeleteAccountScreen',
    'function SettingsScreen',
  )
  const appComponent = sourceBetween(source, 'function App()', 'export default App')

  assert.match(deleteScreen, /\/api\/auth\/delete-account/)
  assert.match(deleteScreen, /await onDeleted\(\)/)
  assert.match(appComponent, /async function handleDeleted/)
  assert.match(appComponent, /\/api\/auth\/me/)
})
