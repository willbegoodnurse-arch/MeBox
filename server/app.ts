import Fastify from 'fastify'
import type Database from 'better-sqlite3'
import type { IncomingHttpHeaders } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deleteLocalAccountData } from './account'
import { listAlerts } from './alerts'
import {
  AuthError,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  changePassword,
  createFirstUser,
  createSession,
  hasUser,
  makeLogoutCookie,
  makeSessionCookie,
  parseCookie,
  revokeSession,
  updateUsername,
  validateSession,
  verifyLogin,
} from './auth'
import {
  DataError,
  decryptExport,
  encryptExport,
  exportAppData,
  importAppData,
  parseImportPayload,
} from './data'
import {
  MAX_UPLOAD_BYTES,
  UploadValidationError,
  allowedMimeTypes,
  deleteStoredFile,
  listFileRows,
  openStoredFile,
  storeUpload,
} from './files'
import { getItem, listInboxItems, type ItemRow } from './items'
import { getDefaultReminderAdvance, setDefaultReminderAdvance } from './settings'
import {
  announcementInputSchema,
  changePasswordInputSchema,
  deleteAccountInputSchema,
  exportInputSchema,
  importInputSchema,
  itemRenameSchema,
  loginInputSchema,
  linkInputSchema,
  listInputSchema,
  listItemAddSchema,
  noteInputSchema,
  paginationSchema,
  recurringExpenseInputSchema,
  searchQuerySchema,
  settingsPatchSchema,
  setupInputSchema,
  todoInputSchema,
  updateUsernameInputSchema,
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

function isPublicPath(path: string) {
  return (
    path === '/api/health' ||
    path === '/api/auth/setup' ||
    path === '/api/auth/login' ||
    path === '/api/auth/logout' ||
    path === '/api/auth/me'
  )
}

function shouldUseSecureCookie(headers: IncomingHttpHeaders) {
  const forwardedProto = headers['x-forwarded-proto']
  const isForwardedHttps = Array.isArray(forwardedProto)
    ? forwardedProto.includes('https')
    : forwardedProto === 'https'

  return (
    process.env.NODE_ENV === 'production' ||
    process.env.MEBOX_COOKIE_SECURE === 'true' ||
    isForwardedHttps
  )
}

function safeUser(user: { id: number; username: string }) {
  return {
    id: user.id,
    username: user.username,
  }
}

function appVersion() {
  try {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { version?: string }
    return packageJson.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function currentSession(db: Database.Database, cookieHeader: string | undefined) {
  const token = parseCookie(cookieHeader, SESSION_COOKIE_NAME)
  const session = validateSession(db, token)

  return { token, session }
}

function parseSubmittedImportPayload(payload: unknown) {
  if (typeof payload !== 'string') {
    return payload
  }

  try {
    return JSON.parse(payload) as unknown
  } catch {
    throw new DataError('Invalid import file')
  }
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

    if (error instanceof AuthError) {
      reply.code(error.statusCode).send({ error: error.message })
      return
    }

    if (error instanceof DataError) {
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

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/') || isPublicPath(request.url.split('?')[0])) {
      return
    }

    const token = parseCookie(request.headers.cookie, SESSION_COOKIE_NAME)
    const session = validateSession(db, token)
    if (!session) {
      return reply.code(401).send({ error: 'Authentication required' })
    }
  })

  app.get('/api/health', async () => ({
    ok: true,
    storage: 'sqlite',
  }))

  app.get('/api/auth/me', async (request) => {
    const token = parseCookie(request.headers.cookie, SESSION_COOKIE_NAME)
    const session = validateSession(db, token)

    return {
      authenticated: session !== null,
      setupRequired: !hasUser(db),
      user: session ? safeUser(session.user) : null,
    }
  })

  app.post('/api/auth/setup', async (request, reply) => {
    const input = parseBody(setupInputSchema, request.body)
    const user = await createFirstUser(db, input)
    const session = createSession(db, user.id)

    reply
      .code(201)
      .header(
        'set-cookie',
        makeSessionCookie({
          token: session.token,
          maxAgeSeconds: SESSION_TTL_SECONDS,
          secure: shouldUseSecureCookie(request.headers),
        }),
      )

    return {
      authenticated: true,
      setupRequired: false,
      user: safeUser(user),
    }
  })

  app.post('/api/auth/login', async (request, reply) => {
    const input = parseBody(loginInputSchema, request.body)
    const user = await verifyLogin(db, input)
    const session = createSession(db, user.id)

    reply.header(
      'set-cookie',
      makeSessionCookie({
        token: session.token,
        maxAgeSeconds: SESSION_TTL_SECONDS,
        secure: shouldUseSecureCookie(request.headers),
      }),
    )

    return {
      authenticated: true,
      setupRequired: false,
      user: safeUser(user),
    }
  })

  app.post('/api/auth/logout', async (request, reply) => {
    const token = parseCookie(request.headers.cookie, SESSION_COOKIE_NAME)
    revokeSession(db, token)
    reply.header(
      'set-cookie',
      makeLogoutCookie(shouldUseSecureCookie(request.headers)),
    )
    return { ok: true }
  })

  app.post('/api/auth/change-password', async (request) => {
    const input = parseBody(changePasswordInputSchema, request.body)
    const { token } = currentSession(db, request.headers.cookie)
    const user = await changePassword(db, {
      currentPassword: input.currentPassword,
      newPassword: input.newPassword,
      currentToken: token,
    })

    return {
      ok: true,
      user: safeUser(user),
      sessionPolicy: 'current_session_kept_other_sessions_revoked',
    }
  })

  app.patch('/api/auth/username', async (request) => {
    const input = parseBody(updateUsernameInputSchema, request.body)
    const user = updateUsername(db, input.username)

    return {
      ok: true,
      user: safeUser(user),
    }
  })

  app.post('/api/auth/delete-account', async (request, reply) => {
    parseBody(deleteAccountInputSchema, request.body)
    deleteLocalAccountData(db, uploadDir)
    reply.header(
      'set-cookie',
      makeLogoutCookie(shouldUseSecureCookie(request.headers)),
    )
    return { ok: true }
  })

  app.get('/api/settings', async (request) => {
    const { session } = currentSession(db, request.headers.cookie)

    return {
      user: session ? safeUser(session.user) : null,
      version: appVersion(),
      defaultReminderAdvanceMinutes: getDefaultReminderAdvance(db),
      reminderAdvanceOptions: [0, 5, 15, 30, 60, 120, 1440],
    }
  })

  app.patch('/api/settings', async (request) => {
    const input = parseBody(settingsPatchSchema, request.body)
    const value =
      input.defaultReminderAdvanceMinutes === undefined
        ? getDefaultReminderAdvance(db)
        : setDefaultReminderAdvance(db, input.defaultReminderAdvanceMinutes)

    return {
      defaultReminderAdvanceMinutes: value,
    }
  })

  app.post('/api/data/export', async (request, reply) => {
    const input = parseBody(exportInputSchema, request.body)
    const payload = exportAppData(db)
    const filename =
      input.format === 'encrypted' ? 'mebox-export.encrypted.json' : 'mebox-export.json'
    const body =
      input.format === 'encrypted'
        ? encryptExport(payload, input.password ?? '')
        : payload

    reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('cache-control', 'no-store')

    return body
  })

  app.post('/api/data/import', async (request) => {
    const input = parseBody(importInputSchema, request.body)
    const submittedPayload = parseSubmittedImportPayload(input.payload)
    const payload =
      input.format === 'encrypted'
        ? decryptExport(submittedPayload, input.password ?? '')
        : parseImportPayload(submittedPayload)
    const result = importAppData(db, payload)

    return {
      ok: true,
      importedItems: result.importedItems,
      filesRestored: false,
    }
  })

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

  app.patch('/api/items/todos/:id/complete', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(404)
      return { error: 'Todo not found' }
    }

    const existing = db
      .prepare('SELECT completed_at AS completedAt FROM todos WHERE item_id = ?')
      .get(id) as { completedAt: string | null } | undefined

    if (!existing) {
      reply.code(404)
      return { error: 'Todo not found' }
    }

    const completedAt = existing.completedAt ? null : new Date().toISOString()
    db.prepare('UPDATE todos SET completed_at = ? WHERE item_id = ?').run(completedAt, id)

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

  app.post('/api/items/lists/:id/items', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(404)
      return { error: 'List not found' }
    }

    const list = db
      .prepare('SELECT item_id FROM lists WHERE item_id = ?')
      .get(id) as { item_id: number } | undefined

    if (!list) {
      reply.code(404)
      return { error: 'List not found' }
    }

    const input = parseBody(listItemAddSchema, request.body)
    const maxPos = db
      .prepare('SELECT MAX(position) AS maxPos FROM list_items WHERE list_item_id = ?')
      .get(id) as { maxPos: number | null }
    const position = (maxPos.maxPos ?? -1) + 1

    db.prepare(
      'INSERT INTO list_items (list_item_id, text, completed_at, position) VALUES (?, ?, ?, ?)',
    ).run(id, input.text, null, position)

    reply.code(201)
    return { item: getItem(db, id) }
  })

  app.patch('/api/items/lists/:listId/items/:itemId/complete', async (request, reply) => {
    const listId = Number((request.params as { listId: string; itemId: string }).listId)
    const itemId = Number((request.params as { listId: string; itemId: string }).itemId)

    if (!Number.isInteger(listId) || listId <= 0 || !Number.isInteger(itemId) || itemId <= 0) {
      reply.code(404)
      return { error: 'List item not found' }
    }

    const existing = db
      .prepare('SELECT id, completed_at AS completedAt FROM list_items WHERE id = ? AND list_item_id = ?')
      .get(itemId, listId) as { id: number; completedAt: string | null } | undefined

    if (!existing) {
      reply.code(404)
      return { error: 'List item not found' }
    }

    const completedAt = existing.completedAt ? null : new Date().toISOString()
    db.prepare('UPDATE list_items SET completed_at = ? WHERE id = ?').run(completedAt, itemId)

    return { item: getItem(db, listId) }
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

  app.patch('/api/items/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(404)
      return { error: 'Item not found' }
    }

    const item = getItem(db, id)
    if (!item) {
      reply.code(404)
      return { error: 'Item not found' }
    }

    if (item.type === 'file') {
      reply.code(422)
      return { error: 'File rename not supported' }
    }

    const input = parseBody(itemRenameSchema, request.body)
    const now = new Date().toISOString()

    db.transaction(() => {
      switch (item.type) {
        case 'note':
          db.prepare('UPDATE items SET body = ?, updated_at = ? WHERE id = ?').run(input.name, now, id)
          break
        case 'link':
          db.prepare('UPDATE links SET title = ? WHERE item_id = ?').run(input.name, id)
          db.prepare('UPDATE items SET updated_at = ? WHERE id = ?').run(now, id)
          break
        case 'todo':
          db.prepare('UPDATE todos SET title = ? WHERE item_id = ?').run(input.name, id)
          db.prepare('UPDATE items SET body = ?, updated_at = ? WHERE id = ?').run(input.name, now, id)
          break
        case 'list':
          db.prepare('UPDATE lists SET title = ? WHERE item_id = ?').run(input.name, id)
          db.prepare('UPDATE items SET body = ?, updated_at = ? WHERE id = ?').run(input.name, now, id)
          break
        case 'announcement':
          db.prepare('UPDATE announcements SET title = ? WHERE item_id = ?').run(input.name, id)
          db.prepare('UPDATE items SET updated_at = ? WHERE id = ?').run(now, id)
          break
        case 'recurring_expense':
          db.prepare('UPDATE recurring_expenses SET name = ? WHERE item_id = ?').run(input.name, id)
          db.prepare('UPDATE items SET body = ?, updated_at = ? WHERE id = ?').run(input.name, now, id)
          break
      }
    })()

    return { item: getItem(db, id) }
  })

  app.delete('/api/items/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(404)
      return { error: 'Item not found' }
    }

    const row = db.prepare('SELECT type FROM items WHERE id = ?').get(id) as { type: string } | undefined
    if (!row) {
      reply.code(404)
      return { error: 'Item not found' }
    }

    if (row.type === 'file') {
      deleteStoredFile(db, uploadDir, id)
    }

    db.prepare('DELETE FROM items WHERE id = ?').run(id)
    return { ok: true }
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
