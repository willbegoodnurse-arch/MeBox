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

function uploadRequest(input: {
  filename: string
  mimeType: string
  body?: Buffer
}) {
  return {
    method: 'POST' as const,
    url: '/api/items/files',
    headers: {
      'content-type': input.mimeType,
      'x-filename': input.filename,
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

  const createResponse = await app.inject({
    method: 'POST',
    url: '/api/items/notes',
    payload: { body: 'private note' },
  })

  assert.equal(createResponse.statusCode, 201)
  const listResponse = await app.inject('/api/items')
  const payload = listResponse.json()

  assert.equal(payload.items.length, 1)
  assert.equal(payload.items[0].type, 'note')
  assert.equal(payload.items[0].detail.text, 'private note')
  await closeTestApp(app, db)
})

test('searches notes and links without requiring external services', async () => {
  const db = testDb()
  const app = createApp({ db })

  await app.inject({
    method: 'POST',
    url: '/api/items/notes',
    payload: { body: 'receipt for laptop stand' },
  })
  await app.inject({
    method: 'POST',
    url: '/api/items/links',
    payload: { url: 'https://example.test/read', title: 'Reading list' },
  })

  const response = await app.inject('/api/search?q=read')
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

  const response = await app.inject(
    uploadRequest({
      filename: 'photo.png',
      mimeType: 'image/png',
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
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

  const response = await app.inject(
    uploadRequest({
      filename: 'archive.zip',
      mimeType: 'application/zip',
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

  const response = await app.inject(
    uploadRequest({
      filename: 'script.js',
      mimeType: 'text/plain',
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

  const response = await app.inject(
    uploadRequest({
      filename: 'large.txt',
      mimeType: 'text/plain',
      body: Buffer.alloc(MAX_UPLOAD_BYTES + 1, 'a'),
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

  const response = await app.inject(
    uploadRequest({
      filename: '../safe.txt',
      mimeType: 'text/plain',
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

  const response = await app.inject(`/api/files/${itemId}`)

  assert.equal(response.statusCode, 404)
  assert.deepEqual(response.json(), { error: 'File not found' })

  await closeTestApp(app, db)
  rmSync(uploadDir, { recursive: true, force: true })
})

test('missing file id returns safe 404', async () => {
  const db = testDb()
  const uploadDir = testUploadDir()
  const app = createApp({ db, uploadDir })

  const response = await app.inject('/api/files/9999')

  assert.equal(response.statusCode, 404)
  assert.deepEqual(response.json(), { error: 'File not found' })

  await closeTestApp(app, db)
  rmSync(uploadDir, { recursive: true, force: true })
})
