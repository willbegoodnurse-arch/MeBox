import { resolve } from 'node:path'

process.env.HOST ??= '127.0.0.1'
process.env.PORT ??= '3101'
process.env.MEBOX_DB_PATH ??= resolve(process.cwd(), '.e2e', 'mebox-e2e.sqlite')
process.env.MEBOX_UPLOAD_DIR ??= resolve(process.cwd(), '.e2e', 'uploads')

await import('../server/index')
