import type Database from 'better-sqlite3'
import type { InboxItem, ItemType } from './model'

export type ItemRow = {
  id: number
  type: ItemType
  body: string | null
  created_at: string
  updated_at: string
}

function parseTags(value: string | null) {
  if (!value) {
    return []
  }

  try {
    const tags = JSON.parse(value)
    return Array.isArray(tags) ? tags : []
  } catch {
    return []
  }
}

function detailForItem(db: Database.Database, row: ItemRow) {
  switch (row.type) {
    case 'note':
      return { text: row.body ?? '' }
    case 'link': {
      const link = db
        .prepare('SELECT url, title, memo, tags_json FROM links WHERE item_id = ?')
        .get(row.id) as
        | { url: string; title: string | null; memo: string | null; tags_json: string }
        | undefined
      return link
        ? {
            url: link.url,
            title: link.title,
            memo: link.memo,
            tags: parseTags(link.tags_json),
          }
        : null
    }
    case 'todo':
      return (
        db
          .prepare(
            'SELECT title, due_at AS dueAt, reminder_at AS reminderAt, completed_at AS completedAt FROM todos WHERE item_id = ?',
          )
          .get(row.id) ?? null
      )
    case 'list': {
      const list = db
        .prepare('SELECT title FROM lists WHERE item_id = ?')
        .get(row.id) as { title: string } | undefined
      const items = db
        .prepare(
          'SELECT id, text, completed_at AS completedAt, position FROM list_items WHERE list_item_id = ? ORDER BY position ASC, id ASC',
        )
        .all(row.id)
      return list ? { title: list.title, items } : null
    }
    case 'file':
      return (
        db
          .prepare(
            'SELECT original_name AS originalName, stored_name AS storedName, mime_type AS mimeType, size_bytes AS sizeBytes FROM files WHERE item_id = ?',
          )
          .get(row.id) ?? null
      )
    case 'announcement':
      return (
        db
          .prepare(
            'SELECT title, body, pinned FROM announcements WHERE item_id = ?',
          )
          .get(row.id) ?? null
      )
    case 'recurring_expense':
      return (
        db
          .prepare(
            'SELECT name, amount, currency, billing_day AS billingDay, reminder_days_before AS reminderDaysBefore, last_paid_on AS lastPaidOn FROM recurring_expenses WHERE item_id = ?',
          )
          .get(row.id) ?? null
      )
  }
}

export function serializeItem(db: Database.Database, row: ItemRow): InboxItem {
  return {
    id: row.id,
    type: row.type,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    detail: detailForItem(db, row) as Record<string, unknown> | null,
  }
}

export function getItem(db: Database.Database, id: number) {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id) as
    | ItemRow
    | undefined
  return row ? serializeItem(db, row) : null
}

export function listInboxItems(db: Database.Database, limit: number, offset: number) {
  const rows = db
    .prepare(
      'SELECT * FROM items ORDER BY datetime(created_at) ASC, id ASC LIMIT ? OFFSET ?',
    )
    .all(limit, offset) as ItemRow[]

  return rows.map((row) => serializeItem(db, row))
}
