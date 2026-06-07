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
