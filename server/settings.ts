import type Database from 'better-sqlite3'

export const reminderAdvanceOptions = new Set([0, 5, 15, 30, 60, 120, 1440])
export const defaultReminderAdvanceMinutes = 15

type SettingRow = {
  value: string
}

export function getDefaultReminderAdvance(db: Database.Database) {
  const row = db
    .prepare("SELECT value FROM app_settings WHERE key = 'default_reminder_advance_minutes'")
    .get() as SettingRow | undefined
  const value = row ? Number(row.value) : defaultReminderAdvanceMinutes

  return reminderAdvanceOptions.has(value) ? value : defaultReminderAdvanceMinutes
}

export function setDefaultReminderAdvance(db: Database.Database, value: number) {
  if (!reminderAdvanceOptions.has(value)) {
    throw new Error('Invalid reminder advance')
  }

  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ('default_reminder_advance_minutes', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(String(value))

  return getDefaultReminderAdvance(db)
}
