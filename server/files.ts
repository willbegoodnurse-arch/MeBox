import type Database from 'better-sqlite3'
import { createReadStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

export const allowedMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/markdown',
])

const mimeExtensions: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
}

const dangerousExtensions = new Set([
  '.exe',
  '.dll',
  '.bat',
  '.cmd',
  '.ps1',
  '.sh',
  '.js',
  '.mjs',
  '.cjs',
  '.html',
  '.htm',
  '.svg',
  '.php',
  '.jar',
])

type FileRow = {
  item_id: number
  original_name: string
  stored_name: string
  mime_type: string
  size_bytes: number
}

export class UploadValidationError extends Error {
  statusCode: number

  constructor(message: string, statusCode = 400) {
    super(message)
    this.name = 'UploadValidationError'
    this.statusCode = statusCode
  }
}

function cleanMimeType(value: string | undefined) {
  return value?.split(';')[0]?.trim().toLowerCase() ?? ''
}

export function sanitizeOriginalFilename(value: string | undefined) {
  if (value?.includes('/') || value?.includes('\\')) {
    throw new UploadValidationError('Invalid filename')
  }

  const name = basename(value ?? '').trim()
  if (!name || name === '.' || name === '..') {
    throw new UploadValidationError('Invalid filename')
  }

  return [...name]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127 ? '_' : character
    })
    .join('')
    .slice(0, 240)
}

export function validateUploadInput(input: {
  originalName: string | undefined
  mimeType: string | undefined
  sizeBytes: number
}) {
  if (input.sizeBytes <= 0) {
    throw new UploadValidationError('Invalid file')
  }

  if (input.sizeBytes > MAX_UPLOAD_BYTES) {
    throw new UploadValidationError('File is too large', 413)
  }

  const originalName = sanitizeOriginalFilename(input.originalName)
  const extension = extname(originalName).toLowerCase()

  if (dangerousExtensions.has(extension)) {
    throw new UploadValidationError('File type is not allowed')
  }

  const mimeType = cleanMimeType(input.mimeType)
  if (!allowedMimeTypes.has(mimeType)) {
    throw new UploadValidationError('File type is not allowed', 415)
  }

  return {
    originalName,
    mimeType,
    extension: mimeExtensions[mimeType],
  }
}

export function createStoredFilename(extension: string) {
  return `${randomBytes(16).toString('hex')}${extension}`
}

export function resolveStoredFilePath(uploadDir: string, storedName: string) {
  if (!/^[a-f0-9]{32}\.[a-z0-9]+$/.test(storedName)) {
    throw new UploadValidationError('File not found', 404)
  }

  const root = resolve(uploadDir)
  const filePath = resolve(root, storedName)
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`

  if (!filePath.startsWith(prefix)) {
    throw new UploadValidationError('File not found', 404)
  }

  return filePath
}

export function storeUpload(
  db: Database.Database,
  uploadDir: string,
  input: {
    originalName: string | undefined
    mimeType: string | undefined
    body: Buffer
  },
) {
  const validated = validateUploadInput({
    originalName: input.originalName,
    mimeType: input.mimeType,
    sizeBytes: input.body.length,
  })

  mkdirSync(uploadDir, { recursive: true })
  const storedName = createStoredFilename(validated.extension)
  const filePath = resolveStoredFilePath(uploadDir, storedName)

  const itemId = db.transaction(() => {
    const id = Number(
      db
        .prepare('INSERT INTO items (type, body) VALUES (?, ?)')
        .run('file', validated.originalName).lastInsertRowid,
    )
    db.prepare(
      `INSERT INTO files
        (item_id, original_name, stored_name, mime_type, size_bytes)
        VALUES (?, ?, ?, ?, ?)`,
    ).run(
      id,
      validated.originalName,
      storedName,
      validated.mimeType,
      input.body.length,
    )

    writeFileSync(filePath, input.body, { flag: 'wx' })
    return id
  })()

  return itemId
}

export function getFileRow(db: Database.Database, itemId: number) {
  return db
    .prepare(
      `SELECT item_id, original_name, stored_name, mime_type, size_bytes
       FROM files
       WHERE item_id = ?`,
    )
    .get(itemId) as FileRow | undefined
}

export function listFileRows(db: Database.Database) {
  return db
    .prepare(
      `SELECT item_id, original_name, stored_name, mime_type, size_bytes
       FROM files
       ORDER BY item_id DESC`,
    )
    .all() as FileRow[]
}

export function deleteStoredFile(db: Database.Database, uploadDir: string, itemId: number) {
  const row = db
    .prepare('SELECT stored_name FROM files WHERE item_id = ?')
    .get(itemId) as { stored_name: string } | undefined
  if (!row) return
  try {
    const filePath = resolveStoredFilePath(uploadDir, row.stored_name)
    rmSync(filePath, { force: true })
  } catch {
    // ignore – file may already be missing
  }
}

export function openStoredFile(
  db: Database.Database,
  uploadDir: string,
  itemId: number,
) {
  const row = getFileRow(db, itemId)
  if (!row) {
    throw new UploadValidationError('File not found', 404)
  }

  const filePath = resolveStoredFilePath(uploadDir, row.stored_name)
  if (!existsSync(filePath)) {
    throw new UploadValidationError('File not found', 404)
  }

  return {
    row,
    stream: createReadStream(filePath),
  }
}
