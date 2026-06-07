import assert from 'node:assert/strict'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { createApp } from './app'
import { initializeSchema } from './db/schema'
import { listAlerts, nextBillingDate } from './alerts'

function testDb() {
  const db = new Database(':memory:')
  initializeSchema(db)
  return db
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
  await app.close()
  db.close()
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
  await app.close()
  db.close()
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
