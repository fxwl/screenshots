# Changelog

All notable changes to **SessionMesh** will be documented in this file.

## [1.3.0] - 2026-11-26

### Added

- **Multi-Provider Storage Backends & Local Encrypted Archive Backup**:
  - **S3-Compatible Object Storage (`S3StorageAdapter`)**: Zero-dependency Web Crypto AWS SigV4 and Aliyun `oss_v4` (`OSS4-HMAC-SHA256`) signing with built-in vendor presets for **Cloudflare R2**, **Aliyun OSS** (Virtual-Hosted-Style), **AWS S3**, **MinIO**, **Tencent COS**, **Backblaze B2**, and custom S3 endpoints.
  - **GitHub Private Gist Storage (`GitHubGistStorageAdapter`)**: Zero-cost private synchronization using Secret GitHub Gists with lossless flat filename escaping, `ETag` `304` caching, and strict `public === false` privacy enforcement (`GIST_PUBLIC_FORBIDDEN` guard).
  - **Local Sync Directory Storage (`LocalDirectoryStorageAdapter`)**: Direct read/write sync to **OneDrive / iCloud / Dropbox / local folders** via Chromium File System Access API and `DirHandleStore` IndexedDB persistence, complete with a 1-click permission recovery banner (`local_dir_permission_needed`).
  - **Universal `.smesh-backup` Single-File Encrypted Archive**: Cross-browser (`Chrome`, `Edge`, `Firefox`) password-encrypted archive export/import (`encodeArchiveBackup` / `decodeArchiveBackup`) supporting both **Causal Smart Merge** (`merge`) and **Full Replace Restore** (`replace`).
  - **Cross-Device Pairing Code v2**: Upgraded `smesh://pair/...` pairing codes to SMES v2 payloads packaging WebDAV, S3/R2/OSS, and GitHub Private Gist configurations.
- **Extended Storage Sync (`sessionStorage` & Opt-In `IndexedDB`)**:
  - Origin-scoped `sessionStorage` sync with a global default setting and per-site rule overrides / key allowlists.
  - Opt-in per-site `IndexedDB` snapshot sync via `typedCloneCodec` with target database/objectStore/key-prefix rules and configurable byte-budget quota protection.
- **Developer Debug Export**:
  - Export effective site/track credentials as `cURL`, Node.js `fetch`, raw `Cookie` header, `headers.json`, Playwright `storageState.json`, Postman/Apifox JSON, or Netscape `cookies.txt` with RFC 6265 scheme/domain/path filtering and analytics noise suppression.
- **Team Temporary Encrypted Session Share (`smesh://share/v1.`)**:
  - Time-limited encrypted session sharing with high-entropy passphrases, pre-import preview, cookie expiry clamping, `HttpOnly`/cookie-name filters, and three import modes (`ephemeral_track`, `env_target`, `override_active`).
- **Global Shortcuts, Account Color Badges & Cookie Expiry Warnings**:
  - Manifest V3 `chrome.commands` global shortcuts (`rotate-account-next`, `rotate-account-prev`, `sync-current-site`, `copy-current-curl`) with post-switch in-page toast notifications and quick browser shortcut settings access.
  - Per-account custom color palette, `<=4` character toolbar badge labels with automatic WCAG text contrast, and configurable toolbar badge display modes (`multi_or_tagged`, `always`, `status_only`).
  - Cookie expiry health monitor (`expiryMonitor`: `healthy`, `expiring_soon`, `critical`, `expired`) with watched auth cookie pinning, configurable warning/critical lead hours, and inactive track monitoring.
- **Full Bilingual UI (`简体中文` / `English` / `Follow Browser`)**:
  - 1-click live language switching (`LanguageDropdown`) across the Onboarding Wizard, Toolbar Popup, Side Panel, Options Control Center, right-click Context Menus, toolbar badge tooltips, and in-page switch toasts—backed by an AST-verified 2,460+ entry translation dictionary with zero page reload required.
- **Firefox Manifest V3 Support & Automated Multi-Browser Releases**:
  - Native Firefox MV3 manifest & runtime support (`sidebar_action`, `browser_specific_settings.gecko`, `options_ui.open_in_tab`, synchronous `browser.sidebarAction.open()` fallback), `pnpm zip:firefox` packaging, and automated `.xpi` + AMO source archive publishing in GitHub Actions.
- **Refreshed Store & Documentation Screenshots**:
  - Re-captured all `1280×800` 24-bit RGB product and store screenshots showcasing the Fluent 3D cookie icon, 4-provider storage selector, multi-account color badges, environment sync, debug export, and bilingual UI controls.

### Changed

- **Options Control Center & Onboarding Upgrades**:
  - Unified Onboarding Wizard Step 1 and the Control Center **Storage & Backup** tab around a reusable 4-provider selector (`WebDAV`, `S3 / R2 / OSS`, `GitHub Private Gist`, `Local Directory`) alongside the embedded `.smesh-backup` card and updated **Sync Policy** controls.

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
