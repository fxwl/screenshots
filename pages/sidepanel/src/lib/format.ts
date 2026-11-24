import type {
  BrowserCookieInput,
  CookieRecord,
  CookieSyncStatus,
  DeviceStatus,
  EventOperation,
  PerDeviceSyncPolicy,
  SameSiteValue,
  SiteBindingState,
  SpaceAuthorityMode,
  SyncDirection,
  SyncTimingMode,
} from '@sessionmesh/shared';

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

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

export function downloadJsonFile(filename: string, data: unknown): void {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      return { label: '自动绑定', tone: 'success' };
    case 'USER_BOUND':
      return { label: '手动跟随', tone: 'primary' };
    case 'INDEPENDENT':
      return { label: '独立轨道', tone: 'info' };
    case 'PENDING_CHOICE':
      return { label: '待确认', tone: 'warning' };
    case 'BLACKLISTED':
      return { label: '黑名单', tone: 'neutral' };
    case 'UNMANAGED':
      return { label: '未纳管', tone: 'neutral' };
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
