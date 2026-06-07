# MeBox Security Model

## MVP Access Boundary

MeBox is a single-user local app intended for Tailscale-only access.

- No router port forwarding.
- No Tailscale Funnel.
- No public domain for the MVP.
- No public sharing links.
- No multi-user accounts, teams, comments, or collaboration.
- No analytics, telemetry, tracking, external API calls, or cloud dependencies.

The app should bind to localhost during development. Any LAN or Tailscale exposure must be handled by the operator's private network policy.

The local login layer is required before reading inbox data or writing items, but it is not a replacement for Tailscale-only access. Keep the app off the public internet.

## Forbidden Data

MeBox must not be used to store:

- Password-manager records.
- Account passwords.
- Session tokens.
- Raw cookies.
- Seed phrases.
- Crypto private keys.
- Wallet backup material.
- Exchange credentials.
- 2FA recovery codes.

## Logging Rules

Do not log:

- Note bodies.
- Uploaded file contents.
- Passwords.
- Session tokens.
- Raw cookies.
- Private request payloads.

The MVP backend disables Fastify request logging by default.

## Auth And Session Threat Model

MeBox supports exactly one local user.

- No open registration.
- No second user creation after first-run setup.
- No password reset flow.
- No email flow.
- No OAuth.
- No external identity provider.

Passwords are hashed with argon2id before storage. Plaintext passwords are never stored. Password hashes are not returned by API responses.

Sessions use high-entropy random IDs. The raw session ID is sent only as an HttpOnly cookie named `mebox_session`; it is not returned in JSON and should not be readable by frontend JavaScript. The database stores a SHA-256 hash of the session ID, not the raw session ID.

Session cookies use:

- `HttpOnly`
- `SameSite=Lax`
- `Path=/`
- `Max-Age` matching the server session expiry
- `Secure` when production mode, `MEBOX_COOKIE_SECURE=true`, or HTTPS forwarding is detected

Sessions expire server-side. Logout revokes the matching session on the server and sends an expired cookie. Expired and revoked sessions are rejected by protected API routes.

Protected APIs include inbox reads, item creation, search, alerts, file metadata, upload, and download routes. `/api/health` remains public. Auth routes return sanitized errors and do not expose whether different accounts exist because there is only one local account.

## Storage

SQLite data is stored locally under `data/` by default. Uploaded files are stored locally under `uploads/`.

## File Upload Threat Model

Files are private inbox items for a single user on a Tailscale-only deployment. The MVP does not implement public file sharing, public file URLs, or multi-user permissions.

Threats handled by the MVP upload path:

- Executable uploads: dangerous extensions are rejected even when the MIME type is otherwise allowed.
- Unknown file types: uploads are accepted only for the explicit safe MIME allowlist.
- Oversized uploads: files larger than 5 MB are rejected.
- Path traversal: upload filenames containing path separators are rejected, stored filenames must match the random server-generated pattern, and downloads resolve paths under `uploads/` before opening a file.
- Filename abuse: raw user filenames are never used as stored filenames. The original filename is stored only as SQLite metadata.
- Content leakage through logs: Fastify request logging is disabled and upload payloads are not logged.

Allowed MVP MIME types:

- `image/jpeg`
- `image/png`
- `image/webp`
- `application/pdf`
- `text/plain`
- `text/markdown`

Rejected dangerous extensions:

- `.exe`
- `.dll`
- `.bat`
- `.cmd`
- `.ps1`
- `.sh`
- `.js`
- `.mjs`
- `.cjs`
- `.html`
- `.htm`
- `.svg`
- `.php`
- `.jar`

Download routes are local API routes by file item id. Missing files and unsafe stored paths return a generic `File not found` response.
