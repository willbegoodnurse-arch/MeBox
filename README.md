# MeBox

Signal-like personal inbox app for self-hosted private notes, links, tasks, lists, files, announcements, and recurring expense reminders.

## MVP Foundation

- React + Vite + TypeScript mobile-first frontend
- Fastify local backend under `server/`
- SQLite database via `better-sqlite3`
- Zod request validation
- Single-user local deployment assumption
- Local file uploads stored under `uploads/` with random stored filenames
- Single local login with HttpOnly cookie sessions

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

## First-Run Login Setup

MeBox has one local user and no registration flow. On first run, open the app and complete the setup screen. The frontend calls:

```bash
POST /api/auth/setup
```

with a local username and password. The backend refuses setup after the first user exists.

After setup, use the login screen. Sessions are stored in an HttpOnly `SameSite=Lax` cookie, expire automatically, and are invalidated server-side on logout.

There is no password reset, email flow, OAuth, external identity provider, or public account system. This login layer is not a replacement for Tailscale-only access; keep the app private to your Tailnet.

Password changes require the current password. After a password change, the current session stays valid and other sessions are revoked.

## Settings And Data

The Settings tab provides:

- Account username display
- Password change
- Plain JSON export
- AES-256-GCM encrypted JSON export using a password-derived scrypt key
- Plain/encrypted JSON import using append/merge behavior
- Default reminder advance setting
- App version display
- Logout
- Guarded local account deletion requiring `DELETE`

Exports exclude `users.password_hash` and `sessions`. Uploaded file metadata is included, but uploaded file binaries are not included in export/import yet.

The default reminder advance is stored in SQLite. Reminder creation does not yet consume the setting automatically; wire that into new reminder creation in a follow-up.

## Upload Limits

Uploaded files are private local inbox items. There is no public sharing route.

- Maximum file size: 5 MB
- Stored path: `uploads/`
- Stored filename: random ID plus server-selected extension
- Original filename: SQLite metadata only
- Allowed MIME types:
  - `image/jpeg`
  - `image/png`
  - `image/webp`
  - `application/pdf`
  - `text/plain`
  - `text/markdown`
- Dangerous executable/web extensions are rejected, including `.exe`, `.dll`, `.bat`, `.cmd`, `.ps1`, `.sh`, `.js`, `.mjs`, `.cjs`, `.html`, `.htm`, `.svg`, `.php`, and `.jar`.

## Validation

```bash
npm run typecheck
npm test
npm run build
npm run lint
git diff --check
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
