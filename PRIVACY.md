# Privacy Policy — SessionMesh

**Last Updated:** 2026-11-24

[English](#english) | [中文](#中文)

---

<a id="english"></a>

## English

### 1. Overview

**SessionMesh** is a browser extension designed to synchronize browser login states (cookies and origin-scoped `localStorage`) across your own devices via a **user-configured WebDAV server** with **client-side end-to-end encryption (E2EE)**.

We respect your privacy:
- SessionMesh **does not operate any developer-hosted backend servers**.
- SessionMesh **does not collect, store, or receive any personal information** on any developer server.
- SessionMesh **does not embed any analytics, telemetry, advertising, or third-party tracking SDKs**.
- SessionMesh **does not load or execute any remote code**.

### 2. Data Accessed and Processed

To perform its single user-requested purpose (multi-device login state synchronization), SessionMesh accesses and processes the following data locally in your browser:

1. **Browser Cookies & `localStorage` Data**
   - Reads and writes cookies (via the browser `cookies` API) and `window.localStorage` items (via the content script) for websites you explicitly include in your managed sync list (sites matching your blacklist or excluded rules are ignored).
2. **Tab & Navigation Information**
   - Inspects the URL/origin of open tabs and navigation events solely to identify the current site domain, detect session updates, show sync status in the popup/side panel, and verify whether a tab is safe to reload (avoiding data loss while typing in forms).
   - Browsing history is **never** collected or transmitted to any third party.
3. **Sync & WebDAV Configuration**
   - Stores your WebDAV endpoint URL, WebDAV authentication credentials (username/password or bearer token), sync rules, device labels, and local sync metadata inside your browser's local extension storage (`chrome.storage` and `IndexedDB`).

### 3. End-to-End Encryption & Security Architecture

- **Client-Side Encryption (SMES v2):** Before any cookie, `localStorage`, or sync metadata leaves your browser, it is encrypted locally using the standard Web Crypto API (**AES-256-GCM** authenticated encryption with header/path AAD binding, **PBKDF2-SHA256** with 200,000 iterations for master password derivation, and **HKDF-SHA256** per-file key derivation).
- **Local Key Protection:** Your master encryption password is never written to disk in plaintext. Space data encryption keys (DEKs) are wrapped locally with a non-extractable `AES-256-GCM` CryptoKey (`extractable: false`) in IndexedDB. When **Session Lock** mode is enabled, wrapped keys are kept strictly in `chrome.storage.session` and cleared automatically when the browser closes.
- **Direct User-Controlled Transfer:** Encrypted payloads are sent **exclusively** between your browser and the WebDAV server URL that **you** configure (such as a self-hosted WebDAV server, Nextcloud, or personal cloud drive supporting WebDAV). SessionMesh makes no network requests to any other external hosts.

### 4. Data Sharing and Limited Use Disclosure

- We **never** sell, rent, trade, or transfer your data to third parties.
- We **never** use your data for advertising, profiling, creditworthiness, or lending purposes.
- SessionMesh's use and transfer of information received from browser APIs strictly adheres to the **Chrome Web Store User Data Policy**, including the **Limited Use** requirements, as well as the **Microsoft Edge Add-ons** developer policies.

### 5. Permissions Explanation

| Permission | Purpose |
| --- | --- |
| `cookies` | Read and restore cookies for user-managed domains during synchronization. |
| `tabs` | Identify active tab domains for quick actions and coordinate safe page refreshes after restoring login state. |
| `webNavigation` | Detect navigation events on managed sites to trigger timely session sync checks. |
| `storage` & `unlimitedStorage` | Store local sync settings, rules, cache, and encrypted metadata in browser storage without hitting small default quotas. |
| `alarms` | Run periodic background sync polling and deferred write flushes reliably under Manifest V3. |
| `contextMenus` | Provide right-click menu shortcuts to manage/sync the current website or open the side panel. |
| `sidePanel` | Display the SessionMesh management panel alongside web pages. |
| `<all_urls>` (Host Permissions) | Allow synchronizing cookies/`localStorage` for any website domain chosen by the user and communicating with the user's custom WebDAV server URL. |

### 6. Data Retention and Your Control

You retain full control over all data at all times:
- You may pause synchronization, exclude or blacklist specific domains, or delete synced cookies/`localStorage` items directly within the extension.
- You may lock your session, clear local keys, or delete local and remote sync spaces from the Options page.
- Uninstalling SessionMesh immediately stops all extension activity and removes all locally stored extension data from your browser. Remote encrypted files remain under your sole control on your WebDAV server and can be deleted there at any time.

### 7. Changes to This Policy & Contact

If this Privacy Policy is updated in future versions of SessionMesh, the updated version and date will be published in this document. If you have any questions or privacy concerns, please contact the developer via the support contact listed on the Chrome Web Store / Microsoft Edge Add-ons listing page.

---

<a id="中文"></a>

## 中文

### 1. 概述

**SessionMesh** 是一款浏览器扩展程序，旨在通过**用户自行配置的 WebDAV 服务器**与**客户端端到端加密（E2EE）**，在你的多台设备之间安全同步浏览器登录状态（Cookie 与同源 `localStorage`）。

我们严格保护你的隐私：
- SessionMesh **不运营任何开发者自建后端服务器**。
- SessionMesh **不会向开发者或任何第三方收集、上传或存储个人数据**。
- SessionMesh **不内嵌任何统计分析（Analytics）、遥测（Telemetry）、广告或第三方追踪代码**。
- SessionMesh **不加载也不执行任何远程代码**。

### 2. 访问与处理的数据范围

为了实现核心单一功能（多设备浏览器登录态同步），SessionMesh 仅在本地浏览器中访问并处理以下数据：

1. **浏览器 Cookie 与 `localStorage` 数据**
   - 仅针对你明确纳入同步管理名单的网站，读写对应的浏览器 Cookie（通过 `cookies` API）及网页同源 `window.localStorage`（通过内容脚本）；处于黑名单或排除规则中的网站不会被同步。
2. **标签页与导航状态**
   - 仅用于识别当前访问网站的域名、触发受管站点的同步检查、在弹窗/侧边栏展示同步状态，以及在自动刷新前检查页面表单是否正在输入，避免丢失未保存内容。
   - 不会收集或向任何第三方发送你的浏览历史。
3. **同步与 WebDAV 配置**
   - 将你填写的 WebDAV 地址、认证凭据（账号密码或 Bearer Token）、同步规则、设备名称及本地同步索引保存在浏览器扩展本地存储（`chrome.storage` 与 `IndexedDB`）中。

### 3. 端到端加密与本地安全机制

- **客户端端到端加密（SMES v2）**：所有 Cookie、`localStorage` 及同步数据在离开浏览器前，均通过浏览器标准 Web Crypto API 完成本地加密（采用 **AES-256-GCM** 认证加密并绑定文件头/路径 AAD，主密码派生采用 **PBKDF2-SHA256 200,000 次迭代**，单文件密钥通过 **HKDF-SHA256** 派生）。
- **本地密钥保护**：你的主加密密码不会以明文形式写入磁盘。空间数据加密密钥（DEK）在本地通过不可导出（`extractable: false`）的 `AES-256-GCM` 密钥封装后存储于 IndexedDB；开启**会话锁定（Session Lock）**模式后，封装密钥仅驻留于 `chrome.storage.session`，关闭浏览器后自动清除。
- **仅直连用户自选 WebDAV**：加密后的密文仅在你的浏览器与**你主动配置的 WebDAV 服务器**（如自建 WebDAV、Nextcloud、坚果云等）之间传输，扩展不会向任何其他外部主机发起网络请求。

### 4. 数据共享与合规声明

- 我们**绝不**出售、出租、交易或向第三方转让你的任何数据。
- 我们**绝不**将数据用于广告投放、用户画像、信用评估或借贷等与核心功能无关的用途。
- SessionMesh 对浏览器 API 获取数据的使用严格遵守 **Chrome Web Store 用户数据政策（含“有限使用 / Limited Use”条款）** 以及 **Microsoft Edge 加载项商店** 的隐私与安全政策。

### 5. 权限用途说明

| 权限 | 用途说明 |
| --- | --- |
| `cookies` | 读取与写入受管网站的 Cookie，实现多设备登录态同步。 |
| `tabs` | 获取当前标签页域名以执行快捷同步，并在恢复登录态后安全刷新对应页面。 |
| `webNavigation` | 监听受管网站的页面导航事件，及时触发登录态同步检查。 |
| `storage` 与 `unlimitedStorage` | 在本地保存同步设置、规则、加密缓存与元数据，避免超出默认容量上限。 |
| `alarms` | 在 Manifest V3 生命周期下可靠调度后台定时轮询与防抖写入任务。 |
| `contextMenus` | 提供右键快捷菜单，用于快速打开侧边栏、纳入或同步当前站点。 |
| `sidePanel` | 在浏览器侧边栏展示 SessionMesh 站点与登录态管理面板。 |
| `<all_urls>`（主机权限） | 支持用户自由选择任意网站进行登录态同步，并连接用户自定义的 WebDAV 服务器地址。 |

### 6. 数据留存与用户控制权

你对所有数据拥有完全控制权：
- 可随时在扩展内暂停同步、将任意域名加入黑名单，或删除单条 Cookie / `localStorage` 记录。
- 可随时锁定会话、清除本地密钥，或在设置页删除本地及远端同步空间。
- 卸载 SessionMesh 后，扩展将立即停止运行，浏览器会自动清除本地存储的数据；远端 WebDAV 服务器上的密文文件完全归你所有，可随时自行删除。

### 7. 政策更新与联系方式

如后续版本更新本隐私政策，更新后的内容及日期将同步发布于本页面。如有任何隐私相关疑问，请通过 Chrome 应用商店或 Microsoft Edge 加载项商店页面中公布的开发者联系方式与我们联系。
