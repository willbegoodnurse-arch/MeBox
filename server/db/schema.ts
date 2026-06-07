import type Database from 'better-sqlite3'

export function initializeSchema(db: Database.Database) {
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN (
        'note',
        'link',
        'todo',
        'list',
        'file',
        'announcement',
        'recurring_expense'
      )),
      body TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS links (
      item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      title TEXT,
      memo TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS todos (
      item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      due_at TEXT,
      reminder_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS lists (
      item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
      title TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS list_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_item_id INTEGER NOT NULL REFERENCES lists(item_id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      completed_at TEXT,
      position INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS announcements (
      item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
      title TEXT,
      body TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 1 CHECK (pinned IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS recurring_expenses (
      item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      amount REAL NOT NULL CHECK (amount >= 0),
      currency TEXT NOT NULL,
      billing_day INTEGER NOT NULL CHECK (billing_day BETWEEN 1 AND 31),
      reminder_days_before INTEGER NOT NULL DEFAULT 3 CHECK (reminder_days_before >= 0),
      last_paid_on TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_items_created_at ON items(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
    CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_todos_due_at ON todos(due_at);
    CREATE INDEX IF NOT EXISTS idx_expenses_billing_day ON recurring_expenses(billing_day);
  `)
}
