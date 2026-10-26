# LAN Server

Optional, **off by default**. Shares the same Rust media/thumbnail/
transcode pipeline as the desktop app — the LAN client is served the same
gallery, not a separate implementation.

## Enabling

Settings > LAN. Choosing "Enable LAN Viewing" starts an Axum server bound
to the user-selected network interface (never `0.0.0.0` silently — the UI
lists actual local interfaces and their IPs, per spec's "bind LAN only
when explicitly enabled"). Shows the LAN URL (`http://<lan-ip>:<port>`) and
a generated QR code pointing at it. **One-click Stop LAN Server** tears the
listener down immediately.

## Authentication

- A random access token (or user-set password, hashed with Argon2) is
  required; generated fresh per enable unless the user pins one in
  Settings. The token is embedded in the QR-coded URL as a query param on
  first connect, then exchanged for a short-lived session cookie.
- Sessions expire after a configurable idle timeout.
- Optional IP allowlist, checked before auth.
- Permission levels: **View only** (default), **Download**, **Edit** — the
  Edit level is intentionally never the default and must be explicitly
  granted; Edit over LAN is scoped to the same non-destructive operations
  as desktop editing (§14) and still cannot touch files outside root.

## Sandbox parity

Every route resolves requested paths through the exact same
`fs_sandbox::ensure_within_root` guard used by desktop commands (see
`ARCHITECTURE.md`). There is no separate/duplicated path-safety logic for
LAN — this is the one property that must never regress.

## Routes (sketch)

```
GET  /                         gallery web UI (static bundle, same look/feel as desktop app or a lightweight responsive variant)
GET  /api/media?...            filtered/sorted/paginated media list (mirrors desktop query API)
GET  /api/media/:id            single item metadata
GET  /api/media/:id/thumb      thumbnail (cached)
GET  /api/media/:id/stream     video byte stream, HTTP Range supported (native or remux/transcode fallback, same logic as VIDEO_PLAYBACK.md)
GET  /api/media/:id/download   present only when permission >= Download
POST /api/media/:id/edit/*     present only when permission == Edit
GET  /api/clients              connected client list (desktop-only admin view)
```

## Range streaming

Reuses the loopback streaming server's Range implementation
(`VIDEO_PLAYBACK.md`) — the LAN server mounts the same handler rather than
reimplementing byte-range logic, so seeking behaves identically on LAN and
desktop.

## Connected clients

The desktop app's LAN settings panel lists active sessions (IP, connect
time, permission level, last activity) sourced from the session store, with
a per-session revoke action in addition to the global Stop button.

## Threat model notes

- LAN mode assumes a trusted local network; it is not designed to be
  exposed through port-forwarding/NAT — the app does not attempt UPnP or
  any WAN exposure, by design (spec: "never expose outside LAN
  intentionally").
- Token/password is never logged (see spec §32 on logging discipline).
