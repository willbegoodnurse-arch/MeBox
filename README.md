# MeBox

Signal-like personal inbox app for self-hosted private notes, links, tasks, lists, files, announcements, and recurring expense reminders.

## MVP Foundation

- React + Vite + TypeScript mobile-first frontend
- Fastify local backend under `server/`
- SQLite database via `better-sqlite3`
- Zod request validation
- Single-user local deployment assumption

## Setup

```bash
npm install
```

## Development

Run the backend:

```bash
npm run server:dev
```

In another terminal, run the frontend:

```bash
npm run dev
```

Vite proxies `/api` to `http://127.0.0.1:3001`. The default SQLite file is `data/mebox.sqlite`.

## Validation

```bash
npm run typecheck
npm test
npm run build
```

## Target

- Raspberry Pi 5
- Docker
- SQLite
- Tailscale-only access
- Single-user personal app

## Security Boundary

This is not a password manager, seed phrase vault, private key store, or crypto wallet.
Do not store Bitcoin seed phrases, private keys, xprv/zprv, exchange passwords, or 2FA recovery codes.

See [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) for the MVP boundary.

## Docker Status

Docker deployment is expected for the target device, but the first MVP keeps the runtime local and simple. Add production static serving and a Dockerfile after the backend/frontend boundary settles.
