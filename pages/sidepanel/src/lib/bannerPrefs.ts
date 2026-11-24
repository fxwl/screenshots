import { useCallback, useEffect, useRef, useState } from 'react';

export const UI_BANNER_PREFS_STORAGE_KEY = 'sessionmesh_ui_banner_prefs_v1';
const BANNER_PREFS_EVENT = 'sessionmesh:banner-prefs-updated';

export type BannerCategory = 'security' | 'degraded' | 'general';

export interface UiBannerPrefs {
  showSecurityWarnings: boolean;
  showDegradedWarnings: boolean;
  dismissedBannerIds: Record<string, boolean>;
}

export const DEFAULT_UI_BANNER_PREFS: UiBannerPrefs = {
  showSecurityWarnings: true,
  showDegradedWarnings: true,
  dismissedBannerIds: {},
};

export function normalizeBannerPrefs(raw: unknown): UiBannerPrefs {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_UI_BANNER_PREFS, dismissedBannerIds: {} };
  }
  const obj = raw as Record<string, unknown>;
  const rawDismissed =
    obj.dismissedBannerIds && typeof obj.dismissedBannerIds === 'object'
      ? (obj.dismissedBannerIds as Record<string, unknown>)
      : {};
  const dismissedBannerIds: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(rawDismissed)) {
    if (v === true) {
      dismissedBannerIds[k] = true;
    }
  }
  return {
    showSecurityWarnings: typeof obj.showSecurityWarnings === 'boolean' ? obj.showSecurityWarnings : true,
    showDegradedWarnings: typeof obj.showDegradedWarnings === 'boolean' ? obj.showDegradedWarnings : true,
    dismissedBannerIds,
  };
}

function readLocalFallback(): UiBannerPrefs {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const text = window.localStorage.getItem(UI_BANNER_PREFS_STORAGE_KEY);
      if (text) {
        return normalizeBannerPrefs(JSON.parse(text));
      }
    }
  } catch {
    // ignore storage errors
  }
  return { ...DEFAULT_UI_BANNER_PREFS, dismissedBannerIds: {} };
}

function writeLocalFallback(prefs: UiBannerPrefs): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(UI_BANNER_PREFS_STORAGE_KEY, JSON.stringify(prefs));
    }
  } catch {
    // ignore storage errors
  }
}

export async function loadBannerPrefs(): Promise<UiBannerPrefs> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
    try {
      const data = await new Promise<Record<string, unknown>>(resolve => {
        chrome.storage.local.get(UI_BANNER_PREFS_STORAGE_KEY, items => {
          if (chrome.runtime?.lastError) {
            resolve({});
            return;
          }
          resolve((items as Record<string, unknown>) || {});
        });
      });
      if (data && UI_BANNER_PREFS_STORAGE_KEY in data) {
        const parsed = normalizeBannerPrefs(data[UI_BANNER_PREFS_STORAGE_KEY]);
        writeLocalFallback(parsed);
        return parsed;
      }
    } catch {
      // fall through to localStorage
    }
  }
  return readLocalFallback();
}

export async function saveBannerPrefs(next: UiBannerPrefs): Promise<void> {
  const normalized = normalizeBannerPrefs(next);
  writeLocalFallback(normalized);
  if (typeof chrome !== 'undefined' && chrome.storage?.local?.set) {
    try {
      await new Promise<void>(resolve => {
        chrome.storage.local.set({ [UI_BANNER_PREFS_STORAGE_KEY]: normalized }, () => {
          void chrome.runtime?.lastError;
          resolve();
        });
      });
    } catch {
      // ignore chrome storage errors
    }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<UiBannerPrefs>(BANNER_PREFS_EVENT, { detail: normalized }));
  }
}

export interface UseBannerPrefsResult {
  prefs: UiBannerPrefs;
  loaded: boolean;
  dismissedCount: number;
  hasSuppressedHints: boolean;
  isBannerVisible: (bannerId: string, category?: BannerCategory) => boolean;
  dismissBanner: (bannerId: string) => Promise<void>;
  setShowSecurityWarnings: (show: boolean) => Promise<void>;
  setShowDegradedWarnings: (show: boolean) => Promise<void>;
  restoreAllBanners: () => Promise<void>;
}

export function useBannerPrefs(): UseBannerPrefsResult {
  const [prefs, setPrefs] = useState<UiBannerPrefs>(() => readLocalFallback());
  const prefsRef = useRef<UiBannerPrefs>(prefs);
  const [loaded, setLoaded] = useState(false);

  const commitLocalState = useCallback((next: UiBannerPrefs) => {
    const normalized = normalizeBannerPrefs(next);
    prefsRef.current = normalized;
    setPrefs(normalized);
  }, []);

  useEffect(() => {
    let active = true;
    void loadBannerPrefs().then(initial => {
      if (!active) return;
      commitLocalState(initial);
      setLoaded(true);
    });

    const onWindowSync = (e: Event) => {
      const custom = e as CustomEvent<UiBannerPrefs>;
      if (custom.detail) {
        commitLocalState(custom.detail);
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener(BANNER_PREFS_EVENT, onWindowSync);
    }

    const onChromeStorageChanged = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName !== 'local') return;
      const change = changes[UI_BANNER_PREFS_STORAGE_KEY];
      if (!change) return;
      const next = normalizeBannerPrefs(change.newValue);
      writeLocalFallback(next);
      commitLocalState(next);
    };

    const hasChromeListener = typeof chrome !== 'undefined' && Boolean(chrome.storage?.onChanged?.addListener);
    if (hasChromeListener) {
      chrome.storage.onChanged.addListener(onChromeStorageChanged);
    }

    return () => {
      active = false;
      if (typeof window !== 'undefined') {
        window.removeEventListener(BANNER_PREFS_EVENT, onWindowSync);
      }
      if (hasChromeListener) {
        chrome.storage.onChanged.removeListener(onChromeStorageChanged);
      }
    };
  }, [commitLocalState]);

  const updatePrefs = useCallback(
    async (updater: (prev: UiBannerPrefs) => UiBannerPrefs) => {
      const nextValue = normalizeBannerPrefs(updater(prefsRef.current));
      commitLocalState(nextValue);
      await saveBannerPrefs(nextValue);
    },
    [commitLocalState],
  );

  const dismissBanner = useCallback(
    async (bannerId: string) => {
      await updatePrefs(prev => ({
        ...prev,
        dismissedBannerIds: {
          ...prev.dismissedBannerIds,
          [bannerId]: true,
        },
      }));
    },
    [updatePrefs],
  );

  const setShowSecurityWarnings = useCallback(
    async (show: boolean) => {
      await updatePrefs(prev => ({
        ...prev,
        showSecurityWarnings: show,
      }));
    },
    [updatePrefs],
  );

  const setShowDegradedWarnings = useCallback(
    async (show: boolean) => {
      await updatePrefs(prev => ({
        ...prev,
        showDegradedWarnings: show,
      }));
    },
    [updatePrefs],
  );

  const restoreAllBanners = useCallback(async () => {
    await updatePrefs(() => ({
      showSecurityWarnings: true,
      showDegradedWarnings: true,
      dismissedBannerIds: {},
    }));
  }, [updatePrefs]);

  const isBannerVisible = useCallback(
    (bannerId: string, category: BannerCategory = 'general'): boolean => {
      if (prefs.dismissedBannerIds[bannerId]) return false;
      if (category === 'security' && !prefs.showSecurityWarnings) return false;
      if (category === 'degraded' && !prefs.showDegradedWarnings) return false;
      return true;
    },
    [prefs],
  );

  const dismissedCount = Object.values(prefs.dismissedBannerIds).filter(Boolean).length;
  const hasSuppressedHints = !prefs.showSecurityWarnings || !prefs.showDegradedWarnings || dismissedCount > 0;

  return {
    prefs,
    loaded,
    dismissedCount,
    hasSuppressedHints,
    isBannerVisible,
    dismissBanner,
    setShowSecurityWarnings,
    setShowDegradedWarnings,
    restoreAllBanners,
  };
}
