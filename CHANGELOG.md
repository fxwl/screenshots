# Changelog

All notable changes to **SessionMesh** will be documented in this file.

## [1.0.0] - 2026-11-24

Initial open-source release of **SessionMesh** for Chrome and Microsoft Edge (Manifest V3).

### Highlights

- **Zero-Knowledge E2E Encryption (SMES v2)**:
  - Client-side `AES-256-GCM` authenticated encryption with header & remote path AAD binding, `PBKDF2-SHA256` (200,000 iterations), and per-file `HKDF-SHA256` keys.
  - Local `NonExtractableKeyVault` (`extractable: false` AES-256-GCM wrapping key in IndexedDB) plus optional **Session Lock** mode (`chrome.storage.session` only).
  - Encrypted 10-second cross-device pairing codes (`smesh://pair/...`).
- **Universal WebDAV Storage & Diagnostics**:
  - Built-in **19-step WebDAV capability & consistency detector** distinguishing `Strong CAS` vs `Append-Only Degraded` vs `Incompatible`, with automatic `OPTIONS` → `PROPFIND` fallback for WAF/reverse-proxy environments.
  - Support for Basic Auth, App Passwords, and Bearer Tokens; binary `.enc` and `base64_txt` compatibility modes; encrypted snapshots, AEAD integrity checks, backups, and safe garbage collection (GC).
  - `HTTP 507 Insufficient Storage` circuit breaker to halt background retries until space is freed.
- **High-Reliability Sync Engine**:
  - Opt-in **Managed Sites** mode with automatic remote space probing, **Authority Modes** (`ask`, `primary_device`, `latest_wins`), per-device sync policies, and multi-account **Site Tracks**.
  - Flexible sync timing modes including **`on_page_leave`** (quietly compacts changes while a tab is open and flushes on navigation/leave), outbound queue compaction & byte-budgeted batch chunking, and startup reconciliation after abrupt browser exits.
  - Exact cookie identity disambiguation (`CookieApplyHelper`) for colliding `hostOnly` vs wildcard-domain / sibling-path cookies, `__Host-` / `__Secure-` / `SameSite=None` normalization, CHIPS `partitionKey` graceful fallback, and mandatory browser readback verification.
  - Origin-scoped `localStorage` synchronization with `Object.prototype` reserved-key hardening, oversized (`>256KB`) SPA blob protection, and echo suppression.
  - Multi-layer **Safe Auto-Refresh Guard** & anti-reload-loop shields protecting unsaved form inputs, active typing, `contenteditable` edits, and pending file uploads.
- **Full Extension UI**:
  - 4-step Onboarding Wizard, Toolbar Popup, Side Panel (Sites & Cookies, LocalStorage, Rules, Devices, History & Undo, Conflicts), Options Control Center, and right-click Context Menu.
  - Minimal Manifest V3 permissions with English and Simplified Chinese (`en` / `zh_CN`) locales.
- **Quality & Testing**:
  - 131 automated Vitest unit & acceptance tests across crypto, WebDAV, versioning/rules, tracks, refresh guards, and managed-authority scenarios.
