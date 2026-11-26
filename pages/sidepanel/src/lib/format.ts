import type {
  BrowserCookieInput,
  CookieRecord,
  CookieSyncStatus,
  DebugExportFormat,
  DeviceStatus,
  EventOperation,
  ExpiryHealthStatus,
  ObjectType,
  PerDeviceSyncPolicy,
  SameSiteValue,
  SiteBindingState,
  SpaceAuthorityMode,
  SyncDirection,
  SyncTimingMode,
} from '@sessionmesh/shared';

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export interface AccountColorPreset {
  value: string;
  label: string;
}

export const ACCOUNT_COLOR_PRESETS: ReadonlyArray<AccountColorPreset> = [
  { value: '#dc2626', label: '生产红' },
  { value: '#d97706', label: '测试橙' },
  { value: '#2563eb', label: '开发蓝' },
  { value: '#16a34a', label: '个人绿' },
  { value: '#7c3aed', label: '临时/只读紫' },
  { value: '#0891b2', label: '灰度青' },
  { value: '#475569', label: '默认灰' },
];

export const SENSITIVE_CLIPBOARD_WARNING = '已复制到剪贴板（含敏感登录态，切勿提交到代码仓库）';

export interface DebugExportOptionMeta {
  format: DebugExportFormat;
  label: string;
  shortLabel: string;
  hint: string;
}

export const DEBUG_EXPORT_FORMAT_OPTIONS: ReadonlyArray<DebugExportOptionMeta> = [
  { format: 'curl', label: 'curl 命令', shortLabel: 'curl (.sh)', hint: '命令行复现请求' },
  { format: 'fetch', label: 'fetch 请求片段', shortLabel: 'fetch (.js)', hint: 'Node.js / 服务端脚本' },
  { format: 'cookie_header', label: 'Cookie 请求头', shortLabel: 'Cookie Header (.txt)', hint: 'name=value; ...' },
  { format: 'headers_json', label: 'Headers JSON', shortLabel: 'Headers JSON', hint: '{ "Cookie": "..." }' },
  {
    format: 'playwright_storage_state',
    label: 'Playwright storageState.json',
    shortLabel: 'storageState.json',
    hint: '自动化测试复用登录态',
  },
  {
    format: 'postman_apifox',
    label: 'Postman / Apifox JSON',
    shortLabel: 'Postman / Apifox (.json)',
    hint: '接口调试导入',
  },
  {
    format: 'netscape_cookies_txt',
    label: 'Netscape cookies.txt',
    shortLabel: 'cookies.txt',
    hint: 'wget / yt-dlp / curl -b',
  },
];

export function formatRemainingDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '已过期';
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return '剩余 <1m';
  if (mins < 60) return `剩余 ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `剩余 ${hours}h`;
  const days = Math.floor(hours / 24);
  return `剩余 ${days}d`;
}

export function getExpiryBadgeMeta(status: ExpiryHealthStatus): { label: string; tone: BadgeTone } {
  switch (status) {
    case 'healthy':
      return { label: '状态健康', tone: 'success' };
    case 'expiring_soon':
      return { label: '即将过期', tone: 'warning' };
    case 'critical':
      return { label: '即将失效', tone: 'danger' };
    case 'expired':
      return { label: '已过期', tone: 'danger' };
    default:
      return { label: '正常', tone: 'neutral' };
  }
}

export function formatByteSize(bytes?: number): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes >= 10 * 1024 ? 1 : 2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function getObjectTypeLabel(objectType: ObjectType): string {
  switch (objectType) {
    case 'cookie':
      return 'Cookie';
    case 'localStorage':
      return 'LS';
    case 'sessionStorage':
      return 'SS';
    case 'indexedDb':
      return 'IDB';
    default:
      return String(objectType);
  }
}

export function generateRandomSharePassphrase(length = 16): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const maxUnbiased = 256 - (256 % alphabet.length);
  let out = '';
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    while (out.length < length) {
      const buf = new Uint8Array(Math.max(length * 2, 16));
      crypto.getRandomValues(buf);
      for (let i = 0; i < buf.length && out.length < length; i += 1) {
        const b = buf[i];
        if (b < maxUnbiased) {
          out += alphabet[b % alphabet.length];
        }
      }
    }
    return out;
  }
  while (out.length < length) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

const TYPED_TAG_KEY = '$sm_t';

function decodePreviewNode(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(decodePreviewNode);

  const rec = node as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(rec, TYPED_TAG_KEY)) {
    const tag = rec[TYPED_TAG_KEY];
    switch (tag) {
      case 'undef':
        return '[undefined]';
      case 'num':
        return String(rec.v ?? 'NaN');
      case 'bigint':
        return `${String(rec.v ?? '0')}n`;
      case 'date':
        return `Date(${String(rec.v ?? '')})`;
      case 'regexp':
        return `/${String(rec.s ?? '')}/${String(rec.f ?? '')}`;
      case 'u8':
        return `[Uint8Array base64(${String(rec.b64 ?? '').length} chars)]`;
      case 'ab':
        return `[ArrayBuffer base64(${String(rec.b64 ?? '').length} chars)]`;
      case 'view':
        return `[${String(rec.kind ?? 'TypedArray')} base64(${String(rec.b64 ?? '').length} chars)]`;
      case 'map': {
        const entries = Array.isArray(rec.e) ? rec.e : [];
        return {
          __type: 'Map',
          entries: entries.map(pair =>
            Array.isArray(pair) && pair.length >= 2 ? [decodePreviewNode(pair[0]), decodePreviewNode(pair[1])] : pair,
          ),
        };
      }
      case 'set': {
        const values = Array.isArray(rec.v) ? rec.v : [];
        return {
          __type: 'Set',
          values: values.map(decodePreviewNode),
        };
      }
      case 'raw_obj': {
        const inner = (rec.v ?? {}) as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(inner)) {
          out[k] = decodePreviewNode(inner[k]);
        }
        return out;
      }
      default:
        return rec;
    }
  }

  const out: Record<string, unknown> = {};
  for (const k of Object.keys(rec)) {
    out[k] = decodePreviewNode(rec[k]);
  }
  return out;
}

export function decodeTypedClonePreview(encoded: string): string {
  if (!encoded) return '';
  try {
    const parsed = JSON.parse(encoded) as unknown;
    const decoded = decodePreviewNode(parsed);
    if (typeof decoded === 'string') return decoded;
    if (typeof decoded === 'number' || typeof decoded === 'boolean' || decoded === null) {
      return String(decoded);
    }
    return JSON.stringify(decoded, null, 2);
  } catch {
    return encoded;
  }
}

function decodeIdbKeyNodePreview(node: unknown): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node) && node.length === 2) {
    const [kind, payload] = node;
    if (kind === 'n') return String(payload);
    if (kind === 'd' && typeof payload === 'number') {
      return new Date(payload).toISOString();
    }
    if (kind === 'b') return `[BinaryKey ${String(payload).slice(0, 12)}...]`;
    if (kind === 'a' && Array.isArray(payload)) {
      return `[${payload.map(decodeIdbKeyNodePreview).join(', ')}]`;
    }
  }
  return JSON.stringify(node);
}

export function decodeIdbKeyPreview(encodedKey: string): string {
  if (!encodedKey) return '';
  try {
    const parsed = JSON.parse(encodedKey) as unknown;
    return decodeIdbKeyNodePreview(parsed);
  } catch {
    return encodedKey;
  }
}

export function formatRelativeTime(ts?: number): string {
  if (!ts) return '从未';
  const diff = Date.now() - ts;
  if (diff < 0) return '刚刚';
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return '刚刚';
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return formatDateTime(ts);
}

export function formatDateTime(ts?: number): string {
  if (!ts) return '-';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '-';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatCookieExpiry(expirationDate?: number, session?: boolean): string {
  if (session || expirationDate === undefined || expirationDate === null) {
    return '会话期 (Session)';
  }
  const ms = expirationDate > 1e12 ? expirationDate : expirationDate * 1000;
  const expired = ms < Date.now();
  return `${formatDateTime(ms)}${expired ? ' (已过期)' : ''}`;
}

export function shortId(id?: string, maxLen = 14): string {
  if (!id) return '-';
  if (id.length <= maxLen) return id;
  return `${id.slice(0, maxLen - 3)}...`;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export function downloadTextFile(filename: string, content: string, mimeType = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadJsonFile(filename: string, data: unknown): void {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  downloadTextFile(filename, text, 'application/json;charset=utf-8');
}

export function buildCookieHeader(cookies: Array<Pick<BrowserCookieInput, 'name' | 'value'>>): string {
  return cookies
    .filter(c => c.name)
    .map(c => `${c.name}=${c.value ?? ''}`)
    .join('; ');
}

export function toBrowserCookieInput(record: CookieRecord): BrowserCookieInput {
  return {
    domain: record.domain,
    name: record.name,
    value: record.value,
    path: record.path,
    secure: record.secure,
    httpOnly: record.httpOnly,
    sameSite: record.sameSite,
    session: record.session,
    expirationDate: record.expirationDate,
    hostOnly: record.hostOnly,
    storeId: record.storeScope && record.storeScope !== 'default' ? record.storeScope : undefined,
    partitionKey: record.partitionKey ?? null,
  };
}

export function getBindingMeta(state: SiteBindingState): { label: string; tone: BadgeTone } {
  switch (state) {
    case 'AUTO_BOUND':
      return { label: '同步中', tone: 'success' };
    case 'USER_BOUND':
      return { label: '跟随同步', tone: 'primary' };
    case 'INDEPENDENT':
      return { label: '仅本机独立', tone: 'info' };
    case 'PENDING_CHOICE':
      return { label: '待确认', tone: 'warning' };
    case 'BLACKLISTED':
      return { label: '已排除', tone: 'neutral' };
    case 'UNMANAGED':
      return { label: '未开启同步', tone: 'neutral' };
    default:
      return { label: state, tone: 'neutral' };
  }
}

export function getAuthorityModeLabel(mode?: SpaceAuthorityMode): string {
  switch (mode) {
    case 'primary_device':
      return '统一指定主基准设备';
    case 'latest_wins':
      return '以最新更新为准';
    case 'ask':
    default:
      return '手动询问确认';
  }
}

export function getDevicePolicyModeLabel(mode: PerDeviceSyncPolicy['mode']): string {
  switch (mode) {
    case 'independent_tracks':
      return '独立轨道模式';
    case 'follow_device':
      return '指定跟随设备';
    case 'inherit':
    default:
      return '跟随空间默认';
  }
}

/**
 * Normalize manual domain / URL inputs like "https://sub.example.com/login", "*.example.com", "Example.COM"
 * into a clean lowercase domain/siteKey string. Returns empty string if invalid.
 */
export function normalizeManualSiteKey(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return '';
  let candidate = trimmed;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(candidate)) {
    try {
      candidate = new URL(candidate).hostname.toLowerCase();
    } catch {
      return '';
    }
  } else {
    candidate = candidate.replace(/^\*\./, '').replace(/^\.+/, '');
    candidate = candidate.split('/')[0] || '';
    candidate = candidate.split('?')[0] || '';
    candidate = candidate.split('#')[0] || '';
    candidate = candidate.split(':')[0] || '';
  }
  candidate = candidate.replace(/\.+$/, '');
  if (!candidate || /\s/.test(candidate)) return '';
  if (!/^[a-z0-9.-]+$/.test(candidate)) return '';
  if (candidate !== 'localhost' && !candidate.includes('.')) return '';
  return candidate;
}

export function parseManualSiteKeysInput(raw: string): string[] {
  const tokens = raw
    .split(/[,，;\n\s]+/)
    .map(normalizeManualSiteKey)
    .filter(Boolean);
  return Array.from(new Set(tokens));
}

export function getDeviceStatusMeta(
  status?: DeviceStatus,
  syncTimingMode?: SyncTimingMode,
): { label: string; tone: BadgeTone; dotClass: string } {
  switch (status) {
    case 'SYNCED':
      return { label: '已同步', tone: 'success', dotClass: 'bg-emerald-500' };
    case 'SYNCING':
    case 'INITIALIZING':
    case 'JOINING':
      return { label: '同步中', tone: 'primary', dotClass: 'bg-primary animate-pulse' };
    case 'PENDING':
      return {
        label: syncTimingMode === 'on_page_leave' ? '关页后上传' : '自动上传中',
        tone: 'info',
        dotClass: 'bg-sky-500',
      };
    case 'PARTIAL':
      return { label: '部分完成', tone: 'warning', dotClass: 'bg-amber-500' };
    case 'CONFLICT':
      return { label: '存在冲突', tone: 'warning', dotClass: 'bg-amber-500' };
    case 'OFFLINE':
      return { label: '离线', tone: 'neutral', dotClass: 'bg-slate-400' };
    case 'PAUSED':
      return { label: '已暂停', tone: 'neutral', dotClass: 'bg-slate-400' };
    case 'LOCKED':
      return { label: '已锁定', tone: 'warning', dotClass: 'bg-amber-500' };
    case 'AUTH_ERROR':
      return { label: '认证失败', tone: 'danger', dotClass: 'bg-rose-500' };
    case 'DECRYPT_ERROR':
      return { label: '解密错误', tone: 'danger', dotClass: 'bg-rose-500' };
    case 'UNCONFIGURED':
    default:
      return { label: '未配置', tone: 'neutral', dotClass: 'bg-slate-400' };
  }
}

export function getCookieSyncStatusMeta(status?: CookieSyncStatus): { label: string; tone: BadgeTone } {
  switch (status) {
    case 'IN_SYNC':
      return { label: '已同步', tone: 'success' };
    case 'LOCAL_ONLY':
      return { label: '仅本机', tone: 'info' };
    case 'REMOTE_ONLY':
      return { label: '仅云端', tone: 'primary' };
    case 'LOCAL_NEWER':
      return { label: '本机较新', tone: 'info' };
    case 'REMOTE_NEWER':
      return { label: '云端较新', tone: 'primary' };
    case 'CONCURRENT':
      return { label: '并发冲突', tone: 'warning' };
    case 'DELETED':
      return { label: '已删除', tone: 'neutral' };
    case 'EXPIRED':
      return { label: '已过期', tone: 'neutral' };
    case 'APPLY_FAILED':
      return { label: '写入失败', tone: 'danger' };
    case 'EXCLUDED':
      return { label: '已排除', tone: 'neutral' };
    case 'PENDING_CHOICE':
      return { label: '待确认', tone: 'warning' };
    default:
      return { label: '正常', tone: 'neutral' };
  }
}

export function getOperationMeta(op: EventOperation): { label: string; tone: BadgeTone } {
  switch (op) {
    case 'CREATE':
      return { label: '新建', tone: 'success' };
    case 'UPDATE':
      return { label: '更新', tone: 'info' };
    case 'DELETE':
      return { label: '删除', tone: 'danger' };
    case 'RESTORE':
      return { label: '恢复', tone: 'primary' };
    case 'SNAPSHOT':
      return { label: '快照', tone: 'neutral' };
    case 'CHECKPOINT':
      return { label: '检查点', tone: 'neutral' };
    default:
      return { label: op, tone: 'neutral' };
  }
}

export function getDirectionLabel(dir: SyncDirection): string {
  switch (dir) {
    case 'bidirectional':
      return '双向同步';
    case 'push_only':
      return '仅上传 (Push)';
    case 'pull_only':
      return '仅下载 (Pull)';
    case 'disabled':
      return '禁用同步';
    case 'inherit':
      return '继承空间默认';
    default:
      return dir;
  }
}

export function getSameSiteLabel(val: SameSiteValue): string {
  switch (val) {
    case 'no_restriction':
      return 'None';
    case 'lax':
      return 'Lax';
    case 'strict':
      return 'Strict';
    case 'unspecified':
    default:
      return 'Unspecified';
  }
}

export function getMatchTypeLabel(matchType: 'exact_domain' | 'subdomain' | 'wildcard' | 'origin'): string {
  switch (matchType) {
    case 'exact_domain':
      return '精确域名';
    case 'subdomain':
      return '含子域名';
    case 'wildcard':
      return '通配符';
    case 'origin':
      return '精确 Origin';
    default:
      return matchType;
  }
}

export function getDeviceStateMeta(state: 'active' | 'paused' | 'removed' | 'revoked'): {
  label: string;
  tone: BadgeTone;
} {
  switch (state) {
    case 'active':
      return { label: '活跃同步', tone: 'success' };
    case 'paused':
      return { label: '已暂停', tone: 'warning' };
    case 'removed':
      return { label: '已逻辑移除', tone: 'neutral' };
    case 'revoked':
      return { label: '已吊销', tone: 'danger' };
    default:
      return { label: state, tone: 'neutral' };
  }
}

/**
 * Parse and validate an imported Cookie JSON payload (top-level array or `{ cookies: [...] }`).
 */
export function parseImportedCookiesJson(parsed: unknown, fallbackDomain: string): BrowserCookieInput[] {
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { cookies?: unknown }).cookies)
      ? (parsed as { cookies: unknown[] }).cookies
      : null;
  if (!arr || arr.length === 0) {
    throw new Error('JSON 必须是包含 Cookie 对象的非空数组');
  }
  return arr.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`第 ${index + 1} 项不是有效的 Cookie 对象`);
    }
    const item = raw as Record<string, unknown>;
    const name = String(item.name ?? '').trim();
    if (!name) {
      throw new Error(`第 ${index + 1} 条 Cookie 缺少有效的 name 字段`);
    }
    return {
      name,
      value: String(item.value ?? ''),
      domain: String(item.domain ?? fallbackDomain),
      path: String(item.path ?? '/'),
      secure: Boolean(item.secure ?? true),
      httpOnly: Boolean(item.httpOnly ?? false),
      sameSite: (item.sameSite as BrowserCookieInput['sameSite']) || 'unspecified',
      session: Boolean(item.session ?? !item.expirationDate),
      expirationDate: typeof item.expirationDate === 'number' ? item.expirationDate : undefined,
      hostOnly: Boolean(item.hostOnly ?? false),
      storeId: typeof item.storeId === 'string' && item.storeId !== 'default' ? item.storeId : undefined,
      partitionKey: (item.partitionKey as BrowserCookieInput['partitionKey']) ?? null,
    };
  });
}
