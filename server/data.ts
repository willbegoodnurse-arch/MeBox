import type Database from 'better-sqlite3'
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto'
import { z } from 'zod'

const exportTables = [
  'items',
  'links',
  'todos',
  'lists',
  'list_items',
  'files',
  'announcements',
  'recurring_expenses',
  'app_settings',
] as const

const kdfOptions = {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
}

const recordSchema = z.record(z.string(), z.unknown())
const importDataSchema = z.object({
  version: z.number().int().min(1),
  exportedAt: z.string(),
  tables: z.object({
    items: z.array(recordSchema).default([]),
    links: z.array(recordSchema).default([]),
    todos: z.array(recordSchema).default([]),
    lists: z.array(recordSchema).default([]),
    list_items: z.array(recordSchema).default([]),
    files: z.array(recordSchema).default([]),
    announcements: z.array(recordSchema).default([]),
    recurring_expenses: z.array(recordSchema).default([]),
    app_settings: z.array(recordSchema).default([]),
  }),
})

export type ExportPayload = z.infer<typeof importDataSchema>

export class DataError extends Error {
  statusCode: number

  constructor(message: string, statusCode = 400) {
    super(message)
    this.name = 'DataError'
    this.statusCode = statusCode
  }
}

function tableRows(db: Database.Database, table: string) {
  return db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]
}

export function exportAppData(db: Database.Database): ExportPayload {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    tables: {
      items: tableRows(db, 'items'),
      links: tableRows(db, 'links'),
      todos: tableRows(db, 'todos'),
      lists: tableRows(db, 'lists'),
      list_items: tableRows(db, 'list_items'),
      files: tableRows(db, 'files'),
      announcements: tableRows(db, 'announcements'),
      recurring_expenses: tableRows(db, 'recurring_expenses'),
      app_settings: tableRows(db, 'app_settings'),
    },
  }
}

export function encryptExport(payload: ExportPayload, password: string) {
  if (!password) {
    throw new DataError('Export password is required')
  }

  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(password, salt, 32, kdfOptions)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  return {
    format: 'mebox-encrypted-json',
    version: 1,
    cipher: 'aes-256-gcm',
    kdf: {
      name: 'scrypt',
      N: kdfOptions.N,
      r: kdfOptions.r,
      p: kdfOptions.p,
      keyLength: 32,
    },
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

export function decryptExport(payload: unknown, password: string) {
  if (!password) {
    throw new DataError('Import password is required')
  }

  const encrypted = z
    .object({
      format: z.literal('mebox-encrypted-json'),
      version: z.number().int(),
      cipher: z.literal('aes-256-gcm'),
      kdf: z.object({
        name: z.literal('scrypt'),
        N: z.number().int(),
        r: z.number().int(),
        p: z.number().int(),
        keyLength: z.literal(32),
      }),
      salt: z.string(),
      iv: z.string(),
      tag: z.string(),
      ciphertext: z.string(),
    })
    .parse(payload)

  try {
    const salt = Buffer.from(encrypted.salt, 'base64')
    const iv = Buffer.from(encrypted.iv, 'base64')
    const tag = Buffer.from(encrypted.tag, 'base64')
    const ciphertext = Buffer.from(encrypted.ciphertext, 'base64')
    const key = scryptSync(password, salt, 32, {
      N: encrypted.kdf.N,
      r: encrypted.kdf.r,
      p: encrypted.kdf.p,
      maxmem: kdfOptions.maxmem,
    })
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8')

    return parseImportPayload(JSON.parse(plaintext))
  } catch {
    throw new DataError('Invalid import file')
  }
}

export function parseImportPayload(payload: unknown) {
  try {
    return importDataSchema.parse(payload)
  } catch {
    throw new DataError('Invalid import file')
  }
}

function insertItemFromRow(db: Database.Database, row: Record<string, unknown>) {
  const result = db
    .prepare('INSERT INTO items (type, body, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(
      row.type,
      row.body ?? null,
      row.created_at ?? new Date().toISOString(),
      row.updated_at ?? new Date().toISOString(),
    )
  return Number(result.lastInsertRowid)
}

function byItemId(rows: Record<string, unknown>[]) {
  const map = new Map<number, Record<string, unknown>>()
  for (const row of rows) {
    if (typeof row.item_id === 'number') {
      map.set(row.item_id, row)
    }
  }
  return map
}

export function importAppData(db: Database.Database, payload: ExportPayload) {
  const imported = parseImportPayload(payload)
  const oldToNewItemId = new Map<number, number>()
  const links = byItemId(imported.tables.links)
  const todos = byItemId(imported.tables.todos)
  const lists = byItemId(imported.tables.lists)
  const announcements = byItemId(imported.tables.announcements)
  const expenses = byItemId(imported.tables.recurring_expenses)

  return db.transaction(() => {
    for (const item of imported.tables.items) {
      if (
        typeof item.id !== 'number' ||
        typeof item.type !== 'string' ||
        !exportTables.includes('items')
      ) {
        continue
      }

      const newItemId = insertItemFromRow(db, item)
      oldToNewItemId.set(item.id, newItemId)
      const oldItemId = item.id

      if (item.type === 'link') {
        const row = links.get(oldItemId)
        if (row) {
          db.prepare(
            'INSERT INTO links (item_id, url, title, memo, tags_json) VALUES (?, ?, ?, ?, ?)',
          ).run(
            newItemId,
            row.url,
            row.title ?? null,
            row.memo ?? null,
            row.tags_json ?? '[]',
          )
        }
      }

      if (item.type === 'todo') {
        const row = todos.get(oldItemId)
        if (row) {
          db.prepare(
            'INSERT INTO todos (item_id, title, due_at, reminder_at, completed_at) VALUES (?, ?, ?, ?, ?)',
          ).run(
            newItemId,
            row.title,
            row.due_at ?? null,
            row.reminder_at ?? null,
            row.completed_at ?? null,
          )
        }
      }

      if (item.type === 'list') {
        const row = lists.get(oldItemId)
        if (row) {
          db.prepare('INSERT INTO lists (item_id, title) VALUES (?, ?)').run(
            newItemId,
            row.title,
          )
        }
      }

      if (item.type === 'announcement') {
        const row = announcements.get(oldItemId)
        if (row) {
          db.prepare(
            'INSERT INTO announcements (item_id, title, body, pinned) VALUES (?, ?, ?, ?)',
          ).run(newItemId, row.title ?? null, row.body, row.pinned ?? 1)
        }
      }

      if (item.type === 'recurring_expense') {
        const row = expenses.get(oldItemId)
        if (row) {
          db.prepare(
            `INSERT INTO recurring_expenses
              (item_id, name, amount, currency, billing_day, reminder_days_before, last_paid_on)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            newItemId,
            row.name,
            row.amount,
            row.currency,
            row.billing_day,
            row.reminder_days_before ?? 3,
            row.last_paid_on ?? null,
          )
        }
      }
    }

    const insertListItem = db.prepare(
      'INSERT INTO list_items (list_item_id, text, completed_at, position) VALUES (?, ?, ?, ?)',
    )
    for (const row of imported.tables.list_items) {
      if (typeof row.list_item_id !== 'number') {
        continue
      }

      const newListId = oldToNewItemId.get(row.list_item_id)
      if (newListId) {
        insertListItem.run(
          newListId,
          row.text,
          row.completed_at ?? null,
          row.position ?? 0,
        )
      }
    }

    for (const row of imported.tables.app_settings) {
      if (typeof row.key === 'string' && typeof row.value === 'string') {
        db.prepare(
          `INSERT INTO app_settings (key, value, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
        ).run(row.key, row.value)
      }
    }

    return { importedItems: oldToNewItemId.size }
  })()
}
