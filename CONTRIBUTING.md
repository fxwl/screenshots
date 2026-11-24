# Contributing to SessionMesh / 参与贡献

Thank you for your interest in contributing to **SessionMesh**! / 感谢你关注并参与 **SessionMesh** 开源共建！

## Development Setup / 本地开发环境

- **Node.js**: `>= 20.12.0`
- **pnpm**: `9.x` (managed via `packageManager` field)
- **Browser**: Chrome or Microsoft Edge (Manifest V3)

```bash
# Install dependencies / 安装依赖
pnpm install

# Build all packages and extension -> dist/ / 全量构建
pnpm build

# Watch mode for active development / 开发热重载模式
pnpm dev
```

To test WebDAV sync locally without an external server, run the built-in mock server:

```bash
node scripts/start-local-webdav.mjs
```

Then enable **"Allow local loopback HTTP testing"** in Onboarding Step 1 and connect to `http://127.0.0.1:8765`.

## Verification Before Submitting a PR / 提交 PR 前的检查清单

Please run all quality gates before opening a Pull Request:

```bash
pnpm lint          # ESLint + Prettier check (0 errors)
pnpm type-check    # TypeScript check across all workspace packages
pnpm test          # Vitest unit & acceptance test suite
pnpm zip           # Production build + release archive verification
```

## Guidelines / 提交规范

- Keep Pull Requests focused and scoped to a single feature or fix.
- Add or update Vitest acceptance tests in `packages/core/tests/` for any sync, crypto, WebDAV, or refresh-guard behavior change.
- Never commit real credentials, personal WebDAV URLs, cookies, or `dist/` / `dist-zip/` build artifacts.
- Prefer clear commit prefixes such as `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, or `chore:`.
