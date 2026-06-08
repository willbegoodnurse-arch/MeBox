import { createApp } from './app'
import { openDatabase } from './db/database'

const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? '127.0.0.1'
const db = openDatabase()
const app = createApp({ db, uploadDir: process.env.MEBOX_UPLOAD_DIR })

try {
  await app.listen({ port, host })
  console.log(`MeBox server listening on http://${host}:${port}`)
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
