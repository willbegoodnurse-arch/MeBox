import Fastify from 'fastify'
import type Database from 'better-sqlite3'
import { listAlerts } from './alerts'
import {
  MAX_UPLOAD_BYTES,
  UploadValidationError,
  allowedMimeTypes,
  listFileRows,
  openStoredFile,
  storeUpload,
} from './files'
import { getItem, listInboxItems, type ItemRow } from './items'
import {
  announcementInputSchema,
  linkInputSchema,
  listInputSchema,
  noteInputSchema,
  paginationSchema,
  recurringExpenseInputSchema,
  searchQuerySchema,
  todoInputSchema,
} from './validation'

type AppOptions = {
  db: Database.Database
  uploadDir?: string
}

function parseBody<T>(schema: { parse: (value: unknown) => T }, body: unknown) {
  return schema.parse(body)
}

function insertItem(db: Database.Database, type: string, body: string | null) {
  const result = db
    .prepare('INSERT INTO items (type, body) VALUES (?, ?)')
    .run(type, body)
  return Number(result.lastInsertRowid)
}

function likeTerm(query: string) {
  const escaped = query.replace(/[\\%_]/g, (match) => `\\${match}`)
  return `%${escaped}%`
}

export function createApp({ db, uploadDir = 'uploads' }: AppOptions) {
  const app = Fastify({ logger: false, bodyLimit: MAX_UPLOAD_BYTES })

  app.addContentTypeParser(
    [...allowedMimeTypes],
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body)
    },
  )

  app.setErrorHandler((error, _request, reply) => {
    if (typeof error === 'object' && error !== null && 'issues' in error) {
      reply.code(400).send({ error: 'Invalid request body' })
      return
    }

    if (error instanceof UploadValidationError) {
      reply.code(error.statusCode).send({ error: error.message })
      return
    }

    const statusCode =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : undefined

    if (statusCode === 413) {
      reply.code(413).send({ error: 'File is too large' })
      return
    }

    if (statusCode === 415) {
      reply.code(415).send({ error: 'File type is not allowed' })
      return
    }

    reply.code(500).send({ error: 'Internal server error' })
  })

  app.get('/api/health', async () => ({
    ok: true,
    storage: 'sqlite',
  }))

  app.get('/api/items', async (request) => {
    const { limit, offset } = paginationSchema.parse(request.query)
    return { items: listInboxItems(db, limit, offset) }
  })

  app.post('/api/items/notes', async (request, reply) => {
    const input = parseBody(noteInputSchema, request.body)
    const id = db.transaction(() => insertItem(db, 'note', input.body))()
    reply.code(201)
    return { item: getItem(db, id) }
  })

  app.post('/api/items/links', async (request, reply) => {
    const input = parseBody(linkInputSchema, request.body)
    const id = db.transaction(() => {
      const itemId = insertItem(db, 'link', input.memo ?? input.title ?? input.url)
      db.prepare(
        'INSERT INTO links (item_id, url, title, memo, tags_json) VALUES (?, ?, ?, ?, ?)',
      ).run(
        itemId,
        input.url,
        input.title ?? null,
        input.memo ?? null,
        JSON.stringify(input.tags),
      )
      return itemId
    })()
    reply.code(201)
    return { item: getItem(db, id) }
  })

  app.post('/api/items/todos', async (request, reply) => {
    const input = parseBody(todoInputSchema, request.body)
    const id = db.transaction(() => {
      const itemId = insertItem(db, 'todo', input.title)
      db.prepare(
        'INSERT INTO todos (item_id, title, due_at, reminder_at) VALUES (?, ?, ?, ?)',
      ).run(itemId, input.title, input.dueAt ?? null, input.reminderAt ?? null)
      return itemId
    })()
    reply.code(201)
    return { item: getItem(db, id) }
  })

  app.post('/api/items/lists', async (request, reply) => {
    const input = parseBody(listInputSchema, request.body)
    const id = db.transaction(() => {
      const itemId = insertItem(db, 'list', input.title)
      db.prepare('INSERT INTO lists (item_id, title) VALUES (?, ?)').run(
        itemId,
        input.title,
      )

      const insertListItem = db.prepare(
        'INSERT INTO list_items (list_item_id, text, completed_at, position) VALUES (?, ?, ?, ?)',
      )
      input.items.forEach((listItem, index) => {
        insertListItem.run(
          itemId,
          listItem.text,
          listItem.completed ? new Date().toISOString() : null,
          index,
        )
      })
      return itemId
    })()
    reply.code(201)
    return { item: getItem(db, id) }
  })

  app.post('/api/items/announcements', async (request, reply) => {
    const input = parseBody(announcementInputSchema, request.body)
    const id = db.transaction(() => {
      const itemId = insertItem(db, 'announcement', input.body)
      db.prepare(
        'INSERT INTO announcements (item_id, title, body, pinned) VALUES (?, ?, ?, ?)',
      ).run(itemId, input.title ?? null, input.body, input.pinned ? 1 : 0)
      return itemId
    })()
    reply.code(201)
    return { item: getItem(db, id) }
  })

  app.post('/api/items/recurring-expenses', async (request, reply) => {
    const input = parseBody(recurringExpenseInputSchema, request.body)
    const id = db.transaction(() => {
      const itemId = insertItem(db, 'recurring_expense', input.name)
      db.prepare(
        `INSERT INTO recurring_expenses
          (item_id, name, amount, currency, billing_day, reminder_days_before)
          VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        itemId,
        input.name,
        input.amount,
        input.currency.toUpperCase(),
        input.billingDay,
        input.reminderDaysBefore,
      )
      return itemId
    })()
    reply.code(201)
    return { item: getItem(db, id) }
  })

  app.post('/api/items/files', async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) {
      reply.code(400)
      return { error: 'Invalid file' }
    }

    const id = storeUpload(db, uploadDir, {
      originalName: request.headers['x-filename']?.toString(),
      mimeType: request.headers['content-type'],
      body: request.body,
    })

    reply.code(201)
    return { item: getItem(db, id) }
  })

  app.get('/api/files', async () => ({
    files: listFileRows(db).map((file) => ({
      id: file.item_id,
      originalName: file.original_name,
      mimeType: file.mime_type,
      sizeBytes: file.size_bytes,
      downloadUrl: `/api/files/${file.item_id}`,
    })),
  }))

  app.get('/api/files/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(404)
      return { error: 'File not found' }
    }

    const { row, stream } = openStoredFile(db, uploadDir, id)
    reply.header('content-type', row.mime_type)
    reply.header('content-length', row.size_bytes)
    reply.header('x-content-type-options', 'nosniff')
    reply.header('cache-control', 'no-store')
    reply.header(
      'content-disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(row.original_name)}`,
    )
    return reply.send(stream)
  })

  app.get('/api/search', async (request) => {
    const { q, type } = searchQuerySchema.parse(request.query)
    const term = likeTerm(q)
    const types = type
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean)

    const rows = db
      .prepare(
        `
        SELECT DISTINCT items.*
        FROM items
        LEFT JOIN links ON links.item_id = items.id
        LEFT JOIN announcements ON announcements.item_id = items.id
        LEFT JOIN files ON files.item_id = items.id
        WHERE (
          (items.type = 'note' AND items.body LIKE ? ESCAPE '\\')
          OR (items.type = 'link' AND (
            links.url LIKE ? ESCAPE '\\'
            OR links.title LIKE ? ESCAPE '\\'
            OR links.memo LIKE ? ESCAPE '\\'
          ))
          OR (items.type = 'announcement' AND (
            announcements.title LIKE ? ESCAPE '\\'
            OR announcements.body LIKE ? ESCAPE '\\'
          ))
          OR (items.type = 'file' AND files.original_name LIKE ? ESCAPE '\\')
        )
        ORDER BY datetime(items.created_at) DESC, items.id DESC
        LIMIT 100
      `,
      )
      .all(term, term, term, term, term, term, term) as ItemRow[]

    const items = rows
      .filter((row) => !types?.length || types.includes(row.type))
      .map((row) => getItem(db, row.id))
      .filter((item) => item !== null)

    return { items }
  })

  app.get('/api/alerts', async () => ({ alerts: listAlerts(db) }))

  return app
}
