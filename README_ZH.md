<div align="center">
  <img src="chrome-extension/public/icon-128.png" width="96" height="96" alt="SessionMesh Logo" />
  <h1>SessionMesh</h1>
  <p>基于自建 WebDAV 与客户端端到端加密的多设备浏览器登录态自动同步扩展。</p>

  <p>
    <a href="https://github.com/fxwl/screenshots/actions/workflows/build-zip.yml">
      <img src="https://github.com/fxwl/screenshots/actions/workflows/build-zip.yml/badge.svg" alt="自动编译状态" />
    </a>
    <img src="https://img.shields.io/badge/Manifest-V3-4285F4?style=flat-square" alt="Manifest V3" />
    <img src="https://img.shields.io/badge/TypeScript-5.2-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React" />
    <img src="https://img.shields.io/badge/Vite-5-646CFF?style=flat-square&logo=vite&logoColor=white" alt="Vite" />
    <img src="https://img.shields.io/badge/License-MIT-22C55E?style=flat-square" alt="MIT License" />
  </p>

  <p><a href="./README.md">English</a> | <strong>简体中文</strong></p>
</div>

---

**SessionMesh** 是一款面向 **Microsoft Edge**（同时兼容各类 Chromium 内核浏览器）的开源扩展，通过**你自己的 WebDAV 服务器**在多台设备间自动同步网站登录状态（**Cookie** 与同源 **`localStorage`**）。所有数据在离开浏览器前均在本地完成端到端加密，无开发者后端、无统计追踪。

## 核心特性

- **零知识端到端加密（SMES v2）**：全部数据在本地通过 Web Crypto API 加密（`AES-256-GCM` 认证加密 + 文件头/路径 AAD 绑定、`PBKDF2-SHA256` 200,000 次迭代派生主密钥、单文件 `HKDF-SHA256` 独立密钥）。
- **本地密钥安全封装**：主加密密码永不以明文落盘；空间密钥通过不可导出（`extractable: false`）的本地 `AES-256-GCM` 密钥封装存储，支持开启**会话锁定（Session Lock）**模式，关闭浏览器自动清空密钥。
- **自选 WebDAV 存储与 19 项能力探测**：兼容坚果云、Nextcloud、群晖 NAS、Alist、Caddy、Nginx 等任意标准 WebDAV 服务（支持 Basic 账号密码、应用专用密码与 Bearer Token），内置 **19 项能力与强一致 CAS 并发探测**以及 HTTP `507` 空间满自动熔断保护。
- **按需纳管、主基准设备与双层黑名单**：默认仅同步你主动纳入管理的网站（`managed_only`），支持空间统一基准策略（`ask` / `primary_device` / `latest_wins`）与单设备独立策略（只读跟随、仅上传、独立轨道、设备专属排除），并配备空间级 + 本机级双层黑名单与 SSO 关联域名分组。
- **智能同步时机与高可靠同步内核**：默认支持**离开页面时上传（`on_page_leave`）**（页面打开期间静默合并变更，离开时自动批量落盘）与实时/定时同步；内置同名/同路径碰撞 Cookie 精确消歧、强制浏览器回读验证、异常退出启动补齐与 `>256KB` 超大 SPA `localStorage` 跳过保护。
- **多账号轨道与 10 秒跨设备配对**：同一网站支持多账号轨道切换与独立维护，支持工作/个人多空间隔离，并可通过加密配对码（`smesh://pair/...`）10 秒接入新设备。
- **安全自动刷新守卫与防死循环护盾**：准备刷新标签页前自动检测未保存表单、活跃输入、富文本编辑或待上传文件，并屏蔽仅 `localStorage` 变更或后台轮询导致的刷新死循环。
- **侧边栏与完整控制台**：支持逐条查看/编辑/导入导出 Cookie（含回读验证状态）与 `localStorage`、冲突处理、历史回滚、WebDAV AEAD 完整性校验、备份恢复与安全垃圾回收（GC）。

## 安装方式

### 商店安装与自动编译发布包（推荐）

- **Microsoft Edge Add-ons**：*审核上架中*
- **GitHub Releases（每次推送自动编译）**：[前往 Releases 下载最新 `.zip`](https://github.com/fxwl/screenshots/releases) → 解压后在 `edge://extensions` 加载即可（其他 Chromium 内核浏览器亦可手动加载解压目录使用）。

### 从源码构建

环境要求：**Node.js >= 20.12**、**pnpm 9+**。

```bash
# 1. 安装依赖
pnpm install

# 2. 构建扩展产物（输出到 dist/）
pnpm build

# 3. （可选）打包商店上传用 ZIP（输出到 dist-zip/）
pnpm zip
```

在 Microsoft Edge（或其他 Chromium 内核浏览器）中加载本地扩展：

1. 打开 `edge://extensions`。
2. 开启**开发人员模式**。
3. 点击**加载解压缩的扩展**，选择项目根目录下的 `dist/` 文件夹。

## 快速上手

### 第 1 步：连接你的 WebDAV 服务器

首次安装会自动打开配置向导。填写你的 HTTPS WebDAV 地址（内置坚果云、Nextcloud、群晖 NAS、Alist 快捷模板）和认证信息，点击**测试连接（19 项能力检测）**确认服务连通性与一致性模式。

<p align="center">
  <img src="./docs/screenshots/01-onboarding-webdav.png" width="820" alt="首次向导第 1 步：连接 WebDAV" />
</p>

### 第 2 步：创建或加入加密同步空间

首台设备创建新同步空间（设备 B / C 可自动探测并加入已有空间），填写本机名称并设置强**端到端加密主密码**（独立于 WebDAV 密码，永不发送到服务器）。

<p align="center">
  <img src="./docs/screenshots/02-onboarding-space.png" width="820" alt="首次向导第 2 步：同步空间与主密码" />
</p>

### 第 3 步：通过 Popup 或侧边栏管理与同步站点

在向导、工具栏 **Popup**、**侧边栏**或网页**右键菜单**中将需要同步的网站纳入管理。随时点击扩展图标即可查看当前站点的 Cookie / `localStorage` 数量，执行单站上传/拉取、轨道拆分或一键全量同步。

<p align="center">
  <img src="./docs/screenshots/03-popup-overview.png" width="820" alt="工具栏 Popup 快捷面板" />
</p>

### 第 4 步：10 秒跨设备配对

打开 **控制中心 → 同步空间与跨设备配对**，输入一次性口令生成加密配对码（`smesh://pair/...`），在另一台设备的引导向导第 1 步粘贴即可自动填入 WebDAV 与空间配置。

<p align="center">
  <img src="./docs/screenshots/06-options-spaces-pairing.png" width="820" alt="跨设备加密配对码" />
</p>

## 界面总览

### 侧边栏管理台 — Cookie 回读验证与 `localStorage` 明细

实时查看每条 Cookie 的 `HttpOnly` / `Secure` / `SameSite` 属性与**回读已验证**状态，支持多账号轨道切换、JSON 导入导出，以及按 Origin 隔离管理 `localStorage` 键值。

<p align="center">
  <img src="./docs/screenshots/04-sidepanel-manager.png" width="820" alt="侧边栏 Cookie 与 LocalStorage 管理台" />
</p>

### 控制中心 — WebDAV 状态诊断、快照与安全垃圾回收

直观查看连接状态、并发一致性模式（`强一致 CAS` / `仅追加降级`）、响应延迟，支持一键执行 AEAD 数据完整性校验、加密快照与历史垃圾回收（GC）。

<p align="center">
  <img src="./docs/screenshots/05-options-webdav.png" width="820" alt="WebDAV 存储与维护" />
</p>

### 控制中心 — 同步规则与双层黑名单

支持配置空间级（全设备同步）与本机级双层黑名单（优先级高于任何同步规则），内置网银、支付、密码管理器等敏感站点预设过滤，以及规则 JSON 导入导出。

<p align="center">
  <img src="./docs/screenshots/07-options-rules-blacklist.png" width="820" alt="同步规则与双层黑名单" />
</p>

### 控制中心 — 主基准设备与单设备独立策略

自由切换「仅同步已纳管网站 / 全站自动纳管」，指定空间统一基准设备（`手动确认` / `以主设备为准` / `最新更新为准`），并为每台设备单独配置同步方向与专属排除站点。

<p align="center">
  <img src="./docs/screenshots/08-options-policy-advanced.png" width="820" alt="主基准设备与单设备独立策略" />
</p>

## 常见问题与测试排错

以下整理了实际联调与多 WebDAV / Chromium MV3 测试中常见的问题与内置保护机制：

- **提示「禁止不安全的 `http://` 地址，必须使用 HTTPS」**
  - 线上 WebDAV 服务出于安全要求强制使用 `https://`。
  - 如使用内置本地测试服务 `node scripts/start-local-webdav.mjs`（`http://127.0.0.1:8765`），需在向导第 1 步输入 `127.0.0.1` / `localhost` 后，开启下方出现的**「允许本机回环 HTTP 调试」**开关。
- **坚果云（Nutstore）或 Nextcloud 连接报 `401 Unauthorized`**
  - 请勿直接填写网页登录密码。坚果云与开启两步验证的 Nextcloud 必须在后台安全设置中生成**应用专用密码（App Password）**，并在认证方式中选择对应模式。
- **测试连接时 `OPTIONS` 请求返回 `403` / `405` / `501`**
  - Cloudflare WAF、IIS、群晖反向代理或坚果云等环境常禁用 `OPTIONS` 探测，但 `PROPFIND` / `PUT` / `GET` 实际正常。SessionMesh 的 19 项探测会自动降级改用 `PROPFIND` 验证连通性，可在 **WebDAV 存储与维护** 中展开 19 项报告查看详情。
- **检测到「仅追加降级模式」而非「强一致 CAS」**
  - 部分轻量 WebDAV 服务端会忽略 `If-Match` / `ETag` 条件更新头。SessionMesh 会在探测阶段主动识别并自动切换为安全的仅追加模式，避免静默覆盖冲突；可定期在维护页执行「生成加密快照」与「安全清理历史（GC）」。
- **WebDAV 返回 `507 Insufficient Storage`（远端空间已满）**
  - 扩展会自动触发 `storageFullHalted` 熔断停止后台无效重试。释放网盘空间或执行历史 GC 后，在面板点击一次**立即同步**即可自动解除熔断并恢复同步。
- **`localStorage` 显示「已缓存（待网页上下文打开）」或跳过超大键值**
  - 受浏览器安全模型限制，扩展只能在对应网站标签页打开时读写其同源 `window.localStorage`；远端拉取的键值会先缓存在本地，下次打开该网站时自动注入生效。单条超过 `256KB` 的大型 SPA 缓存会被自动跳过，同时安全处理 `__proto__` / `constructor` 等保留键名。
- **特殊前缀与同名碰撞 Cookie（`__Host-` / `__Secure-` / `SameSite=None` / `hostOnly` 与 `.domain`）**
  - Chromium 对前缀 Cookie 校验极严，且同一名称下可能同时存在 `hostOnly`、泛域名 `.domain` 或不同路径（`/admin` 与 `/`）的碰撞 Cookie。SessionMesh 已统一归一化默认存储区（`"0"` / `"firefox-default"` → `"default"`），在回读和删除时精确消歧避免误删兄弟 Cookie，并在旧浏览器不支持 `partitionKey`（CHIPS）时自动回退；若单条仍写入失败，可在侧边栏筛选「写入失败」查看原因并一键重试。
- **网页仍打开时修改了登录态但尚未立即上传**
  - 默认采用**离开页面时上传（`on_page_leave`）**模式：标签页打开期间会在本地静默合并频繁变更，切换或关闭页面时自动批量加密上传，也可随时点击**立即同步**。如需即时上传，可在 **控制中心 → 同步策略与高级设置** 中切换为实时模式。
- **拉取登录态后页面没有自动刷新**
  - 多层**安全刷新守卫**与防死循环护盾会在检测到表单未保存输入、15 秒内活跃打字、`contenteditable` 富文本修改或 `<input type="file">` 待上传文件时主动延后刷新，且不会对仅 `localStorage` 变更触发死循环刷新；编辑完成后手动刷新即可。
- **重启浏览器后提示锁定 / 忘记端到端主密码**
  - 开启**会话锁定（Session Lock）**后，本地封装密钥仅存于 `chrome.storage.session`，关闭浏览器自动清除，重新输入主密码即可解锁恢复。由于采用零知识加密，遗忘主密码无法找回，需在已解锁设备上轮换密码或重建新空间。

## 开发指南

```bash
pnpm dev            # 启动开发监听模式
pnpm lint           # 全工作区 ESLint + Prettier 检查
pnpm type-check     # 全工作区 TypeScript 类型检查
pnpm test           # 运行全部 132 项 Vitest 单元测试与验收测试
pnpm clean          # 安全清理 dist/ 与 .turbo 缓存
pnpm build          # 生产构建 -> dist/
pnpm zip            # 生产构建并打包商店上传包 -> dist-zip/
```

如需在不依赖外部服务器的情况下本地联调 WebDAV，可直接启动内置测试服务：

```bash
node scripts/start-local-webdav.mjs
```

贡献流程请查看 [CONTRIBUTING.md](./CONTRIBUTING.md)，版本变更记录请查看 [CHANGELOG.md](./CHANGELOG.md)。

## 项目结构

```text
.
├── chrome-extension/     # MV3 清单、后台 Service Worker、多语言包与图标
├── pages/
│   ├── popup/            # 工具栏弹窗（状态总览与当前站点快捷操作）
│   ├── sidepanel/        # 侧边栏管理台（站点轨道、Cookie 与 localStorage 管理）
│   ├── options/          # 完整控制中心（WebDAV、空间、规则、策略与备份）
│   └── content/          # 内容脚本（localStorage 监听与安全刷新守卫）
├── packages/
│   ├── core/             # 核心同步引擎、SMES v2 加密、WebDAV 客户端、因果版本与规则
│   ├── storage/          # IndexedDB 持久化、不可导出密钥库与 chrome.storage 封装
│   ├── shared/           # 跨进程 IPC 协议、React Hooks 与通用工具
│   ├── ui/               # 公共 Tailwind / Radix UI 组件库
│   ├── webdav-mock/      # 用于自动化与本地测试的内存 WebDAV 服务
│   ├── zipper/           # 发布包打包工具（dist/ -> dist-zip/）
│   └── ...               # 构建与开发工具（hmr、dev-utils、tsconfig、tailwind-config）
├── docs/screenshots/     # 项目与商店实机截图（1280×800 24 位 PNG）
└── scripts/              # 本地开发辅助脚本
```

## 隐私与安全

SessionMesh 仅在你的浏览器与你自行配置的 WebDAV 服务器之间直连通信，不收集任何个人数据，不含统计/遥测代码，不执行远程代码。

- 隐私政策与权限用途说明：[PRIVACY.md](./PRIVACY.md)
- 安全架构与漏洞反馈指南：[SECURITY.md](./SECURITY.md)

## 开源协议

本项目基于 [MIT](./LICENSE) 协议开源。
