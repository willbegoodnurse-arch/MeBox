import type Database from 'better-sqlite3'
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { resolveStoredFilePath } from './files'

function deleteUploadedFiles(uploadDir: string, storedNames: string[]) {
  if (!existsSync(uploadDir)) {
    return
  }

  const existing = new Set(readdirSync(uploadDir))
  for (const storedName of storedNames) {
    if (!existing.has(storedName)) {
      continue
    }

    const filePath = resolveStoredFilePath(uploadDir, storedName)
    unlinkSync(filePath)
  }
}

export function deleteLocalAccountData(db: Database.Database, uploadDir: string) {
  const storedNames = db
    .prepare('SELECT stored_name FROM files')
    .all()
    .map((row) => (row as { stored_name: string }).stored_name)

  deleteUploadedFiles(uploadDir, storedNames)

  db.transaction(() => {
    db.prepare('DELETE FROM sessions').run()
    db.prepare('DELETE FROM users').run()
    db.prepare('DELETE FROM items').run()
    db.prepare('DELETE FROM app_settings').run()
  })()
}
