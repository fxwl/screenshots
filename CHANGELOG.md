# Changelog

All notable changes to **SessionMesh** will be documented in this file.

## [1.1.0] - 2026-11-26

### Added

- **Multi-Account Management & Deterministic Rotation**:
  - New **Accounts Manager** view integrated into both the Options Control Center and Side Panel, alongside quick account creation and one-click rotation in the Toolbar Popup and Context Menu.
  - Supports **Clean New Account** (`clean_new`, automatically archiving the existing session without invalidating server cookies—including pure-`localStorage` SPAs) and **Save Current Session** (`save_current`, decoupled Cookie + `localStorage` snapshots).
  - Deterministic forward/backward account rotation, custom account ordering, editable labels & account notes, safe deletion with peer sync, atomic SSO domain-group rotation, and inactive-track Cookie/`localStorage` editing & export without disturbing the active browser session.
- **Dev & Prod Environment Cookie & `localStorage` Sync (`EnvCookieMapper`)**:
  - Mirror production/staging Cookies and `localStorage` to `localhost`, `127.0.0.1`, IPv6/custom ports, or HTTPS dev domains on demand or via live auto-cascade rules.
  - Automatically rewrites `Domain`, adapts `Secure`/`SameSite`/`__Host-`/`__Secure-` flags for HTTP local debugging, clears CHIPS `partitionKey` across HTTPS targets, supports pinned background account tracks, deferred target-tab `localStorage` hydration, and safe reverse Dev → Prod write-back.
- **Immediate E2E Password Verification**:
  - Verifies the Master Encryption Password directly during onboarding/space join without mutating remote WebDAV state.

### Changed

- **Unified Control Center & UI Refactor**:
  - Consolidated Options Control Center sections (`Sites`, `Accounts`, `Rules & Env Sync`, `Devices & Spaces`, `History & Conflicts`, `Storage & Settings`) and refreshed Popup & Side Panel workflows.

### Fixed & Hardened

- **Sync Engine & Edge-Case Hardening**:
  - Improved multi-tab `localStorage` echo suppression, deferred offline-origin `localStorage` cleanup and undo restoration, multi-tab `on_page_leave` flush handling, localhost/IP `hostOnly` cookie normalization, cloud backup track resurrection, strict session-lock mutation guards, and global pause zero-network isolation.
- **Expanded Automated Test Coverage**:
  - Grew the Vitest acceptance suite from 132 to **175 passing tests** across 9 test files, adding 24 multi-account & environment-sync tests and 16 chaos/fault-injection/real-HTTP WebDAV E2E tests.

## [1.0.1] - 2026-11-24

### Changed

- **Visual Refresh (Microsoft Fluent 3D Cookie Icon)**:
  - Replaced the previous purple icon across all extension sizes (`16×16`, `32×32`, `48×48`, `128×128`), in-app UI logos (`256×256` PNG and `logo.svg`), and Microsoft Edge Add-ons store icon (`300×300`) with a new sky-blue/aqua Fluent 3D chocolate-chip cookie sync icon.
  - Redesigned store promotional tiles (`440×280` small tile and `1400×560` marquee banner) in a matching ocean-blue, aqua-mint, and warm amber palette (24-bit RGB PNG).

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
