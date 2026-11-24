import type { DeviceStatus, SiteBindingState, SyncTimingMode } from '@sessionmesh/core';
import { useCallback, useEffect, useState } from 'react';

export function formatRelativeTime(ts?: number): string {
  if (!ts) return '尚未同步';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 10) return '刚刚';
  if (diffSec < 60) return `${diffSec}秒前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}天前`;
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
  return '操作失败，请重试';
}

export function getPopupStatusBadge(
  status: DeviceStatus,
  pendingDecisionsCount: number,
  attentionCount = 0,
  syncTimingMode?: SyncTimingMode,
): {
  label: string;
  variant: 'success' | 'info' | 'warning' | 'destructive' | 'secondary';
} {
  if (status === 'DECRYPT_ERROR') return { label: '密码错误', variant: 'destructive' };
  if (status === 'AUTH_ERROR') return { label: '认证失败', variant: 'destructive' };
  if (status === 'LOCKED') return { label: '已锁定', variant: 'warning' };
  if (status === 'OFFLINE') return { label: '离线', variant: 'warning' };
  if (status === 'PAUSED') return { label: '已暂停', variant: 'secondary' };
  if (status === 'SYNCING' || status === 'INITIALIZING' || status === 'JOINING') {
    return { label: '同步中', variant: 'info' };
  }
  if (pendingDecisionsCount > 0) {
    return { label: `待决策 (${pendingDecisionsCount})`, variant: 'warning' };
  }
  if (status === 'CONFLICT') return { label: '有冲突', variant: 'warning' };
  if (status === 'PARTIAL') {
    return attentionCount > 0
      ? { label: `待处理 (${attentionCount})`, variant: 'warning' }
      : { label: '已同步', variant: 'success' };
  }
  if (status === 'PENDING') {
    return {
      label: syncTimingMode === 'on_page_leave' ? '关页后上传' : '自动上传中',
      variant: 'info',
    };
  }
  if (attentionCount > 0) {
    return { label: `待处理 (${attentionCount})`, variant: 'warning' };
  }
  if (status === 'SYNCED') return { label: '已同步', variant: 'success' };
  return { label: '未配置', variant: 'secondary' };
}

export function getBindingBadge(state?: SiteBindingState): {
  label: string;
  variant: 'success' | 'info' | 'warning' | 'destructive' | 'secondary' | 'outline';
} {
  switch (state) {
    case 'AUTO_BOUND':
      return { label: '自动绑定', variant: 'success' };
    case 'USER_BOUND':
      return { label: '手动跟随', variant: 'info' };
    case 'INDEPENDENT':
      return { label: '独立轨道', variant: 'outline' };
    case 'PENDING_CHOICE':
      return { label: '待确认', variant: 'warning' };
    case 'BLACKLISTED':
      return { label: '黑名单', variant: 'destructive' };
    case 'UNMANAGED':
      return { label: '未纳管', variant: 'secondary' };
    default:
      return { label: '未纳管', variant: 'secondary' };
  }
}

export function extractFallbackHost(url?: string): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
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

const DEFAULT_UI_BANNER_PREFS: UiBannerPrefs = {
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
    // ignore chrome storage failure
  }
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(UI_BANNER_PREFS_KEY, JSON.stringify(next));
    }
  } catch {
    // ignore localStorage failure
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<UiBannerPrefs>(UI_BANNER_PREFS_EVENT, { detail: next }));
  }
  return next;
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

  return {
    prefs,
    isBannerVisible,
    dismissBanner,
  };
}
