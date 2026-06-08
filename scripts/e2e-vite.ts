import { createServer } from 'vite'

process.env.MEBOX_API_URL ??= 'http://127.0.0.1:3101'

const server = await createServer({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
})

await server.listen()
server.printUrls()
