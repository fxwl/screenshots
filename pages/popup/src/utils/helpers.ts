import type { DeviceStatus, ExpiryHealthStatus, SiteBindingState, SyncTimingMode } from '@sessionmesh/core';
import { useCallback, useEffect, useState } from 'react';

export const SENSITIVE_CLIPBOARD_WARNING = '已复制到剪贴板（含敏感登录态，切勿提交到代码仓库）';

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

export function getExpiryBadgeMeta(status: ExpiryHealthStatus): {
  label: string;
  variant: 'success' | 'warning' | 'destructive' | 'info' | 'secondary';
} {
  switch (status) {
    case 'healthy':
      return { label: '状态健康', variant: 'success' };
    case 'expiring_soon':
      return { label: '即将过期', variant: 'warning' };
    case 'critical':
      return { label: '即将失效', variant: 'destructive' };
    case 'expired':
      return { label: '已过期', variant: 'destructive' };
    default:
      return { label: '正常', variant: 'secondary' };
  }
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
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
      return { label: '同步中', variant: 'success' };
    case 'USER_BOUND':
      return { label: '跟随同步', variant: 'info' };
    case 'INDEPENDENT':
      return { label: '仅本机独立', variant: 'outline' };
    case 'PENDING_CHOICE':
      return { label: '待确认', variant: 'warning' };
    case 'BLACKLISTED':
      return { label: '已排除', variant: 'destructive' };
    case 'UNMANAGED':
      return { label: '未开启同步', variant: 'secondary' };
    default:
      return { label: '未开启同步', variant: 'secondary' };
  }
}

export interface PopupUxPrefs {
  checklistDismissed: boolean;
  checklistCollapsed: boolean;
  popupTourDone: boolean;
  popupDeveloperMode: boolean;
  onboardingExpertMode: boolean;
  completedGuideTasks: Record<string, boolean>;
}

export const UX_ONBOARDING_PREFS_KEY = 'sessionmesh_ux_onboarding_prefs_v1';
const UX_ONBOARDING_PREFS_EVENT = 'sessionmesh:ux-onboarding-prefs-updated';

const DEFAULT_POPUP_UX_PREFS: PopupUxPrefs = {
  checklistDismissed: false,
  checklistCollapsed: false,
  popupTourDone: false,
  popupDeveloperMode: false,
  onboardingExpertMode: false,
  completedGuideTasks: {},
};

function normalizePopupUxPrefs(raw: unknown): PopupUxPrefs {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_POPUP_UX_PREFS, completedGuideTasks: {} };
  }
  const obj = raw as Partial<PopupUxPrefs>;
  const tasks: Record<string, boolean> = {};
  if (obj.completedGuideTasks && typeof obj.completedGuideTasks === 'object') {
    for (const [k, v] of Object.entries(obj.completedGuideTasks)) {
      if (v) tasks[k] = true;
    }
  }
  return {
    checklistDismissed: Boolean(obj.checklistDismissed),
    checklistCollapsed: Boolean(obj.checklistCollapsed),
    popupTourDone: Boolean(obj.popupTourDone),
    popupDeveloperMode: Boolean(obj.popupDeveloperMode),
    onboardingExpertMode: Boolean(obj.onboardingExpertMode),
    completedGuideTasks: tasks,
  };
}

export async function loadPopupUxPrefs(): Promise<PopupUxPrefs> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const res = await chrome.storage.local.get(UX_ONBOARDING_PREFS_KEY);
      if (res && res[UX_ONBOARDING_PREFS_KEY] !== undefined) {
        return normalizePopupUxPrefs(res[UX_ONBOARDING_PREFS_KEY]);
      }
    }
    if (typeof window !== 'undefined' && window.localStorage) {
      const raw = window.localStorage.getItem(UX_ONBOARDING_PREFS_KEY);
      if (raw) return normalizePopupUxPrefs(JSON.parse(raw));
    }
  } catch {
    // fallback
  }
  return { ...DEFAULT_POPUP_UX_PREFS, completedGuideTasks: {} };
}

export async function patchPopupUxPrefs(patch: Partial<PopupUxPrefs>): Promise<PopupUxPrefs> {
  const prev = await loadPopupUxPrefs();
  const next = normalizePopupUxPrefs({
    ...prev,
    ...patch,
    completedGuideTasks: patch.completedGuideTasks
      ? { ...prev.completedGuideTasks, ...patch.completedGuideTasks }
      : prev.completedGuideTasks,
  });
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [UX_ONBOARDING_PREFS_KEY]: next });
    }
  } catch {
    // ignore
  }
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(UX_ONBOARDING_PREFS_KEY, JSON.stringify(next));
    }
  } catch {
    // ignore
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<PopupUxPrefs>(UX_ONBOARDING_PREFS_EVENT, { detail: next }));
  }
  return next;
}

export function usePopupUxPrefs() {
  const [prefs, setPrefs] = useState<PopupUxPrefs>(() => ({
    ...DEFAULT_POPUP_UX_PREFS,
    completedGuideTasks: {},
  }));
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    void loadPopupUxPrefs().then(loaded => {
      if (active) {
        setPrefs(loaded);
        setReady(true);
      }
    });

    const handleCustom = (event: Event) => {
      const detail = (event as CustomEvent<PopupUxPrefs>).detail;
      if (detail) setPrefs(normalizePopupUxPrefs(detail));
    };
    const handleStorage = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName === 'local' && changes[UX_ONBOARDING_PREFS_KEY]) {
        setPrefs(normalizePopupUxPrefs(changes[UX_ONBOARDING_PREFS_KEY].newValue));
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener(UX_ONBOARDING_PREFS_EVENT, handleCustom);
    }
    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener(handleStorage);
    }
    return () => {
      active = false;
      if (typeof window !== 'undefined') {
        window.removeEventListener(UX_ONBOARDING_PREFS_EVENT, handleCustom);
      }
      if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
        chrome.storage.onChanged.removeListener(handleStorage);
      }
    };
  }, []);

  const updatePopupUxPrefs = useCallback(async (patch: Partial<PopupUxPrefs>) => {
    const next = await patchPopupUxPrefs(patch);
    setPrefs(next);
    return next;
  }, []);

  return {
    prefs,
    ready,
    updatePopupUxPrefs,
  };
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
