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

SQLite data is stored locally under `data/` by default. File metadata has a schema, but upload handling is intentionally left as a TODO until MIME allowlists, size limits, random stored filenames, and local disk paths are implemented together.
