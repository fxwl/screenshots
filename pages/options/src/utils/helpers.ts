import type {
  CapabilityReport,
  ConsistencyLevel,
  DeviceStatus,
  SyncTimingMode,
  WebDAVAuthType,
} from '@sessionmesh/core';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

export interface WebDAVProviderPreset {
  id: string;
  label: string;
  exampleUrl: string;
  defaultAuthType: WebDAVAuthType;
  defaultRootPath: string;
  tip: string;
  recommendLowFreq?: boolean;
}

export const WEBDAV_PRESETS: WebDAVProviderPreset[] = [
  {
    id: 'nutstore',
    label: '坚果云 (Nutstore)',
    exampleUrl: 'https://dav.jianguoyun.com/dav/我的坚果云/',
    defaultAuthType: 'app_password',
    defaultRootPath: '/SessionMesh',
    tip: '坚果云禁止在 /dav/ 根下直接新建一级目录，请包含已有同步文件夹（如 /dav/我的坚果云/）并使用应用专用密码。',
    recommendLowFreq: true,
  },
  {
    id: 'nextcloud',
    label: 'Nextcloud',
    exampleUrl: 'https://cloud.example.com/remote.php/dav/files/username/',
    defaultAuthType: 'app_password',
    defaultRootPath: '/SessionMesh',
    tip: '在 Nextcloud 个人设置 -> 安全 中创建应用密码；支持完整 ETag / 条件写入强一致模式。',
  },
  {
    id: 'synology',
    label: '群晖 NAS (Synology)',
    exampleUrl: 'https://nas.example.com:5006/',
    defaultAuthType: 'basic',
    defaultRootPath: '/SessionMesh',
    tip: '请在群晖 WebDAV Server 启用 HTTPS (默认 5006 端口) 并授予目标共享文件夹读写权限。',
  },
  {
    id: 'alist',
    label: 'Alist / OpenList',
    exampleUrl: 'https://alist.example.com/dav/',
    defaultAuthType: 'basic',
    defaultRootPath: '/SessionMesh',
    tip: '确保 Alist 账号拥有 WebDAV 读取与管理权限；部分网盘后端将自动降级为单写者追加兼容模式。',
  },
];

export type PresetBlacklistCategory = 'webdav_self' | 'banking' | 'password_manager' | 'localhost';

export interface PresetBlacklistOption {
  category: PresetBlacklistCategory;
  title: string;
  description: string;
  examples: string;
  defaultChecked: boolean;
}

export const PRESET_BLACKLIST_OPTIONS: PresetBlacklistOption[] = [
  {
    category: 'webdav_self',
    title: '当前 WebDAV 服务器域名（防同步回环）',
    description: '自动排除你刚刚填写的 WebDAV 域名，避免云盘管理后台会话与同步引擎互相干扰。',
    examples: '自动从 Step 1 URL 提取域名',
    defaultChecked: true,
  },
  {
    category: 'banking',
    title: '网银、支付与金融类敏感站点',
    description: '保护高敏感金融凭据仅停留在当前浏览器本地，不上传至任何云端空间。',
    examples: 'alipay.com, paypal.com, icbc.com.cn, cmbchina.com 等',
    defaultChecked: true,
  },
  {
    category: 'password_manager',
    title: '在线密码管理器与密钥库',
    description: '避免密码库登录态在多设备间自动复制，降低主凭据暴露风险。',
    examples: 'bitwarden.com, 1password.com, lastpass.com, dashlane.com 等',
    defaultChecked: true,
  },
  {
    category: 'localhost',
    title: '本地开发调试地址',
    description: '排除本机调试服务，防止不同电脑上的本地项目会话互相覆盖。',
    examples: 'localhost, 127.0.0.1, [::1]',
    defaultChecked: false,
  },
];

export interface UiNonSensitiveMeta {
  webdavUrl?: string;
  authType?: WebDAVAuthType;
  rootPath?: string;
  username?: string;
  lastCapabilityReport?: CapabilityReport;
}

const UI_META_KEY = 'sessionmesh_ui_non_sensitive_meta_v1';

export async function loadUiNonSensitiveMeta(): Promise<UiNonSensitiveMeta> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const res = await chrome.storage.local.get(UI_META_KEY);
      return (res?.[UI_META_KEY] as UiNonSensitiveMeta) ?? {};
    }
    const raw = window.localStorage.getItem(UI_META_KEY);
    return raw ? (JSON.parse(raw) as UiNonSensitiveMeta) : {};
  } catch {
    return {};
  }
}

export async function saveUiNonSensitiveMeta(patch: Partial<UiNonSensitiveMeta>): Promise<void> {
  try {
    const prev = await loadUiNonSensitiveMeta();
    // Never persist secrets (password / bearerToken / encryptionPassword)
    const next: UiNonSensitiveMeta = {
      webdavUrl: patch.webdavUrl ?? prev.webdavUrl,
      authType: patch.authType ?? prev.authType,
      rootPath: patch.rootPath ?? prev.rootPath,
      username: patch.username ?? prev.username,
      lastCapabilityReport: patch.lastCapabilityReport ?? prev.lastCapabilityReport,
    };
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [UI_META_KEY]: next });
    } else {
      window.localStorage.setItem(UI_META_KEY, JSON.stringify(next));
    }
  } catch {
    // Non-fatal UI cache failure
  }
}

export interface UiBannerPrefs {
  showSecurityWarnings: boolean;
  showDegradedWarnings: boolean;
  dismissedBannerIds: Record<string, boolean>;
}

export type BannerCategory = 'security' | 'degraded' | 'general';

export const UI_BANNER_PREFS_KEY = 'sessionmesh_ui_banner_prefs_v1';
const UI_BANNER_PREFS_EVENT = 'sessionmesh:banner-prefs-updated';

export const DEFAULT_UI_BANNER_PREFS: UiBannerPrefs = {
  showSecurityWarnings: true,
  showDegradedWarnings: true,
  dismissedBannerIds: {},
};

function normalizeUiBannerPrefs(raw: unknown): UiBannerPrefs {
  if (!raw || typeof raw !== 'object') {
    return {
      ...DEFAULT_UI_BANNER_PREFS,
      dismissedBannerIds: {},
    };
  }
  const obj = raw as Partial<UiBannerPrefs>;
  const rawDismissed = obj.dismissedBannerIds;
  const dismissedBannerIds: Record<string, boolean> = {};
  if (rawDismissed && typeof rawDismissed === 'object') {
    for (const [k, v] of Object.entries(rawDismissed)) {
      if (v) dismissedBannerIds[k] = true;
    }
  }
  return {
    showSecurityWarnings: obj.showSecurityWarnings !== false,
    showDegradedWarnings: obj.showDegradedWarnings !== false,
    dismissedBannerIds,
  };
}

export async function loadUiBannerPrefs(): Promise<UiBannerPrefs> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const res = await chrome.storage.local.get(UI_BANNER_PREFS_KEY);
      if (res && res[UI_BANNER_PREFS_KEY] !== undefined) {
        return normalizeUiBannerPrefs(res[UI_BANNER_PREFS_KEY]);
      }
    }
    if (typeof window !== 'undefined' && window.localStorage) {
      const raw = window.localStorage.getItem(UI_BANNER_PREFS_KEY);
      if (raw) {
        return normalizeUiBannerPrefs(JSON.parse(raw));
      }
    }
  } catch {
    // fallback to default
  }
  return {
    ...DEFAULT_UI_BANNER_PREFS,
    dismissedBannerIds: {},
  };
}

export async function saveUiBannerPrefs(nextRaw: UiBannerPrefs): Promise<UiBannerPrefs> {
  const next = normalizeUiBannerPrefs(nextRaw);
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [UI_BANNER_PREFS_KEY]: next });
    }
  } catch {
    // fallback to localStorage
  }
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(UI_BANNER_PREFS_KEY, JSON.stringify(next));
    }
  } catch {
    // ignore storage errors
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<UiBannerPrefs>(UI_BANNER_PREFS_EVENT, { detail: next }));
  }
  return next;
}

export async function updateUiBannerPrefs(patch: Partial<UiBannerPrefs>): Promise<UiBannerPrefs> {
  const prev = await loadUiBannerPrefs();
  return saveUiBannerPrefs({
    showSecurityWarnings: patch.showSecurityWarnings ?? prev.showSecurityWarnings,
    showDegradedWarnings: patch.showDegradedWarnings ?? prev.showDegradedWarnings,
    dismissedBannerIds: patch.dismissedBannerIds ?? prev.dismissedBannerIds,
  });
}

export async function dismissUiBanner(bannerId: string): Promise<UiBannerPrefs> {
  const prev = await loadUiBannerPrefs();
  return saveUiBannerPrefs({
    ...prev,
    dismissedBannerIds: {
      ...prev.dismissedBannerIds,
      [bannerId]: true,
    },
  });
}

export async function resetDismissedUiBanners(): Promise<UiBannerPrefs> {
  const prev = await loadUiBannerPrefs();
  return saveUiBannerPrefs({
    ...prev,
    showSecurityWarnings: true,
    showDegradedWarnings: true,
    dismissedBannerIds: {},
  });
}

export function useUiBannerPrefs() {
  const [prefs, setPrefs] = useState<UiBannerPrefs>(() => ({
    ...DEFAULT_UI_BANNER_PREFS,
    dismissedBannerIds: {},
  }));

  useEffect(() => {
    let active = true;
    void loadUiBannerPrefs().then(loaded => {
      if (active) setPrefs(loaded);
    });

    const handleCustomEvent = (event: Event) => {
      const detail = (event as CustomEvent<UiBannerPrefs>).detail;
      if (detail) {
        setPrefs(normalizeUiBannerPrefs(detail));
      } else {
        void loadUiBannerPrefs().then(loaded => {
          if (active) setPrefs(loaded);
        });
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener(UI_BANNER_PREFS_EVENT, handleCustomEvent);
    }

    const handleStorageChange = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName === 'local' && changes[UI_BANNER_PREFS_KEY]) {
        setPrefs(normalizeUiBannerPrefs(changes[UI_BANNER_PREFS_KEY].newValue));
      }
    };

    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener(handleStorageChange);
    }

    return () => {
      active = false;
      if (typeof window !== 'undefined') {
        window.removeEventListener(UI_BANNER_PREFS_EVENT, handleCustomEvent);
      }
      if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
        chrome.storage.onChanged.removeListener(handleStorageChange);
      }
    };
  }, []);

  const isBannerVisible = useCallback(
    (bannerId: string, category: BannerCategory = 'general'): boolean => {
      if (prefs.dismissedBannerIds[bannerId]) return false;
      if (category === 'security' && !prefs.showSecurityWarnings) return false;
      if (category === 'degraded' && !prefs.showDegradedWarnings) return false;
      return true;
    },
    [prefs],
  );

  const dismissBanner = useCallback(async (bannerId: string) => {
    const next = await dismissUiBanner(bannerId);
    setPrefs(next);
  }, []);

  const setShowSecurityWarnings = useCallback(async (show: boolean) => {
    const next = await updateUiBannerPrefs({ showSecurityWarnings: show });
    setPrefs(next);
  }, []);

  const setShowDegradedWarnings = useCallback(async (show: boolean) => {
    const next = await updateUiBannerPrefs({ showDegradedWarnings: show });
    setPrefs(next);
  }, []);

  const restoreAllBanners = useCallback(async () => {
    const next = await resetDismissedUiBanners();
    setPrefs(next);
  }, []);

  const dismissedCount = Object.values(prefs.dismissedBannerIds).filter(Boolean).length;

  return {
    prefs,
    isBannerVisible,
    dismissBanner,
    setShowSecurityWarnings,
    setShowDegradedWarnings,
    restoreAllBanners,
    dismissedCount,
  };
}

export function detectDefaultDeviceName(): string {
  try {
    const ua = navigator.userAgent || '';
    const os = ua.includes('Windows')
      ? 'Windows'
      : ua.includes('Mac OS X')
        ? 'macOS'
        : ua.includes('Linux')
          ? 'Linux'
          : 'Desktop';
    const browser = ua.includes('Edg/')
      ? 'Edge'
      : ua.includes('Chrome/')
        ? 'Chrome'
        : ua.includes('Firefox/')
          ? 'Firefox'
          : 'Edge';
    return `${os} ${browser}`;
  } catch {
    return 'Windows Edge';
  }
}

export function formatRelativeTime(ts?: number): string {
  if (!ts) return '尚未同步';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 10) return '刚刚';
  if (diffSec < 60) return `${diffSec} 秒前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${diffDay} 天前`;
  return formatDateTime(ts);
}

export function formatDateTime(ts?: number): string {
  if (!ts) return '-';
  try {
    return new Date(ts).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return String(ts);
  }
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function getDeviceStatusMeta(
  status?: DeviceStatus,
  syncTimingMode?: SyncTimingMode,
): {
  label: string;
  variant: 'success' | 'info' | 'warning' | 'destructive' | 'secondary';
} {
  switch (status) {
    case 'SYNCED':
      return { label: '已同步', variant: 'success' };
    case 'SYNCING':
    case 'INITIALIZING':
    case 'JOINING':
      return { label: '同步中', variant: 'info' };
    case 'PENDING':
      return {
        label: syncTimingMode === 'on_page_leave' ? '关页后上传' : '自动上传中',
        variant: 'info',
      };
    case 'PARTIAL':
      return { label: '部分完成', variant: 'warning' };
    case 'CONFLICT':
      return { label: '有冲突', variant: 'warning' };
    case 'OFFLINE':
      return { label: '离线', variant: 'secondary' };
    case 'AUTH_ERROR':
      return { label: '认证失败', variant: 'destructive' };
    case 'DECRYPT_ERROR':
      return { label: '密码错误', variant: 'destructive' };
    case 'LOCKED':
      return { label: '已锁定', variant: 'warning' };
    case 'PAUSED':
      return { label: '已暂停', variant: 'secondary' };
    case 'UNCONFIGURED':
    default:
      return { label: '未配置', variant: 'secondary' };
  }
}

export function getConsistencyMeta(level?: ConsistencyLevel): {
  label: string;
  shortLabel: string;
  variant: 'success' | 'warning' | 'destructive' | 'secondary';
  description: string;
} {
  switch (level) {
    case 'strong_cas':
      return {
        label: '强一致 CAS（支持 ETag + 条件写入）',
        shortLabel: '强一致 CAS',
        variant: 'success',
        description: '服务器完整支持 If-Match 与 If-None-Match: *，多设备并发元数据更新具备严格防覆盖保护。',
      };
    case 'append_only_degraded':
      return {
        label: '单写者追加兼容模式（降级）',
        shortLabel: '单写者追加兼容模式',
        variant: 'warning',
        description:
          '服务器未完整支持强条件写入（If-Match/If-None-Match）。日常事件按设备独立目录追加无覆盖，但空间元数据更新不具备强 CAS 锁。',
      };
    case 'incompatible':
      return {
        label: '不兼容',
        shortLabel: '不兼容',
        variant: 'destructive',
        description: '服务器未通过基础 WebDAV 读写检测，无法用于 SessionMesh 同步。',
      };
    default:
      return {
        label: '尚未检测',
        shortLabel: '未检测',
        variant: 'secondary',
        description: '请点击「测试连接（19 项能力检测）」验证服务器兼容性与并发保护等级。',
      };
  }
}

export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (
    err &&
    typeof err === 'object' &&
    'message' in err &&
    typeof (err as { message?: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message;
  }
  return '操作失败，请检查网络连接或重试';
}

export async function copyToClipboard(text: string, label = '已复制到剪贴板'): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(label);
    return true;
  } catch {
    toast.error('复制失败，请手动选中复制');
    return false;
  }
}

export function downloadJsonFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export function openSidePanelFromWindow(): void {
  try {
    if (typeof chrome !== 'undefined' && chrome.windows && chrome.sidePanel) {
      chrome.windows.getCurrent(currentWindow => {
        if (currentWindow?.id !== undefined) {
          chrome.sidePanel.open({ windowId: currentWindow.id }).catch(err => {
            toast.error(`无法打开侧边栏：${extractErrorMessage(err)}`);
          });
        }
      });
    } else {
      toast.info('请在浏览器扩展工具栏点击侧边栏图标打开管理台');
    }
  } catch (err) {
    toast.error(`打开侧边栏失败：${extractErrorMessage(err)}`);
  }
}
