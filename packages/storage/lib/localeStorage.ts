import { createStorage, StorageType, type BaseStorage } from './base';

export type LocalePreference = 'system' | 'zh-CN' | 'en';
export type ResolvedLocale = 'zh-CN' | 'en';

export type LocaleStorage = BaseStorage<LocalePreference> & {
  resolve: () => ResolvedLocale;
};

export const LOCALE_STORAGE_KEY = 'sessionmesh-locale-storage';

export function detectBrowserLocale(): ResolvedLocale {
  try {
    if (typeof chrome !== 'undefined' && typeof chrome.i18n?.getUILanguage === 'function') {
      const uiLang = chrome.i18n.getUILanguage();
      if (uiLang && /^zh\b/i.test(uiLang)) {
        return 'zh-CN';
      }
      if (uiLang) {
        return 'en';
      }
    }
  } catch {
    // ignore chrome.i18n errors
  }

  try {
    if (typeof navigator !== 'undefined' && navigator.language) {
      return /^zh\b/i.test(navigator.language) ? 'zh-CN' : 'en';
    }
  } catch {
    // ignore navigator errors
  }

  return 'zh-CN';
}

export function resolveLocalePreference(pref?: LocalePreference | null): ResolvedLocale {
  if (pref === 'en') return 'en';
  if (pref === 'zh-CN') return 'zh-CN';
  return detectBrowserLocale();
}

const storage = createStorage<LocalePreference>(LOCALE_STORAGE_KEY, 'system', {
  storageType: StorageType.Local,
  liveUpdate: true,
});

export const localeStorage: LocaleStorage = {
  ...storage,
  resolve: () => resolveLocalePreference(storage.getSnapshot()),
};
