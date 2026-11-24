# Security Policy / 安全策略

[English](#english) | [中文](#中文)

---

<a id="english"></a>

## English

### Supported Versions

| Version | Supported |
| --- | --- |
| `1.0.x` | Yes |

### Cryptographic & Isolation Guarantees

SessionMesh handles highly sensitive browser authentication artifacts (cookies and `localStorage`). Its security model enforces:

- **Client-Side End-to-End Encryption (SMES v2)**: Every payload uploaded to WebDAV is authenticated-encrypted locally using Web Crypto API (`AES-256-GCM`, header & remote path bound as AAD, `PBKDF2-SHA256` with 200,000 iterations for master password derivation, `HKDF-SHA256` per-file keys).
- **Opaque Remote Metadata**: Remote WebDAV directory and file names use deterministic hashes / opaque IDs rather than plaintext site domains or cookie names.
- **Non-Extractable Local Key Vault**: Master passwords are never written to disk in plaintext. Space data encryption keys (DEKs) are wrapped locally using an `extractable: false` AES-256-GCM `CryptoKey` in IndexedDB, and can be confined strictly to `chrome.storage.session` via **Session Lock**.
- **HTTPS-Only WebDAV**: Non-HTTPS WebDAV endpoints are blocked by default (explicit loopback override allowed only for `127.0.0.1` / `localhost` development).
- **Dual-Layer Blacklist**: Space-wide and device-only blacklists (including built-in presets for banking, payment, password managers, and self-WebDAV endpoints) take strict precedence over all sync rules.
- **Zero Remote Code & Zero Telemetry**: All code is bundled locally in the extension package; network traffic goes exclusively to your configured WebDAV endpoint.

### Reporting a Vulnerability

Please **do not** report security vulnerabilities in public GitHub issues.

1. Use GitHub's **Security → Report a vulnerability** (Private Vulnerability Reporting) on this repository if enabled, or contact the maintainer privately via the email listed on the browser store page.
2. Include the affected SessionMesh version, browser version, reproduction steps, and impact assessment.
3. Never include real cookies, auth tokens, WebDAV credentials, or master passwords in any report or log.

We aim to acknowledge reports within 72 hours and coordinate a fix before public disclosure.

### User Security Best Practices

- Use a **dedicated App Password** for WebDAV (never reuse your primary cloud account password).
- Keep your **Master Encryption Password** completely separate from your WebDAV password.
- Keep the default sensitive-site blacklists (banking, payment, password managers) enabled.
- If a synced device is lost or compromised, immediately revoke it, rotate your **Space Master Password**, and revoke/rotate the WebDAV App Password.

---

<a id="中文"></a>

## 中文

### 支持版本

| 版本 | 是否提供安全维护 |
| --- | --- |
| `1.0.x` | 支持 |

### 核心安全边界

SessionMesh 处理浏览器登录态等高敏数据，在架构层面强制遵循以下安全保障：

- **客户端端到端加密（SMES v2）**：所有上传至 WebDAV 的文件均在浏览器本地完成认证加密（`AES-256-GCM` 并将文件头与远端路径绑定为 AAD，`PBKDF2-SHA256` 200,000 次迭代派生主密钥，单文件 `HKDF-SHA256` 独立密钥）。
- **远端路径不透明化**：WebDAV 上的目录与文件名采用哈希 / 不透明标识，绝不暴露网站域名或 Cookie 名称。
- **本地不可导出密钥库**：主加密密码永不以明文落盘；空间 DEK 由 `extractable: false` 的本地 AES-256-GCM 密钥封装，并可开启**会话锁定（Session Lock）**仅驻留于 `chrome.storage.session`。
- **强制 HTTPS WebDAV**：默认拒绝明文 `http://` 地址（仅本机回环调试允许手动放行）。
- **双层黑名单高优先级隔离**：空间级与本机级黑名单（含网银、支付、密码管理器与 WebDAV 自身后台预设）优先级高于一切同步规则。
- **零远程代码与零遥测**：全部代码随扩展本地打包，网络请求仅直连用户自配 WebDAV。

### 漏洞反馈方式

请**勿**在公开 Issue 中披露未修复的安全漏洞：

1. 请优先通过本仓库的 **Security → Report a vulnerability（私密漏洞报告）** 提交，或通过扩展商店页面公布的开发者邮箱私下联系。
2. 请提供 SessionMesh 版本、浏览器版本、复现步骤与潜在影响说明。
3. 切勿在日志或报告中附带真实 Cookie、Token、WebDAV 凭据或加密主密码。

### 用户安全建议

- 为 WebDAV 单独生成**应用专用密码**，切勿复用网盘主密码；
- **端到端加密主密码**应与 WebDAV 密码完全区分；
- 保持网银、支付与密码管理器等高敏预设黑名单处于开启状态；
- 若某台设备遗失或不再信任，请立即撤销设备、轮换**空间主密码**并吊销对应 WebDAV 应用密码。
