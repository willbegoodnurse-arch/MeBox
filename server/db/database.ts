import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { initializeSchema } from './schema'

const defaultDbPath = resolve(process.cwd(), 'data', 'mebox.sqlite')

export function openDatabase(dbPath = process.env.MEBOX_DB_PATH ?? defaultDbPath) {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true })
  }

  const db = new Database(dbPath)
  initializeSchema(db)
  return db
}
