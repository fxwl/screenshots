import {
  localeStorage,
  resolveLocalePreference,
  type LocalePreference,
  type ResolvedLocale,
} from '@sessionmesh/storage';
import type React from 'react';
import { createContext, useCallback, useContext, useLayoutEffect, useMemo } from 'react';
import { useStorage } from '../hooks/useStorage';
import { installDomLocaleObserver } from './domObserver';
import { t as translatePair, translateUiText } from './translator';

export interface LocaleContextState {
  localePreference: LocalePreference;
  locale: ResolvedLocale;
  isEn: boolean;
  setLocalePreference: (pref: LocalePreference) => void;
  t: (zh: string, en: string) => string;
  tr: (zhText: string) => string;
}

const defaultState: LocaleContextState = {
  localePreference: 'system',
  locale: 'zh-CN',
  isEn: false,
  setLocalePreference: () => undefined,
  t: zh => zh,
  tr: zh => zh,
};

export const LocaleProviderContext = createContext<LocaleContextState>(defaultState);

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const storedPref = useStorage(localeStorage);
  const localePreference: LocalePreference = storedPref ?? 'system';
  const locale: ResolvedLocale = resolveLocalePreference(localePreference);

  useLayoutEffect(() => {
    return installDomLocaleObserver(locale);
  }, [locale]);

  const setLocalePreference = useCallback((nextPref: LocalePreference) => {
    void localeStorage.set(nextPref);
  }, []);

  const value = useMemo<LocaleContextState>(
    () => ({
      localePreference,
      locale,
      isEn: locale === 'en',
      setLocalePreference,
      t: (zh: string, en: string) => translatePair(zh, en, locale),
      tr: (zhText: string) => translateUiText(zhText, locale),
    }),
    [localePreference, locale, setLocalePreference],
  );

  return <LocaleProviderContext.Provider value={value}>{children}</LocaleProviderContext.Provider>;
}

export function useLocale(): LocaleContextState {
  return useContext(LocaleProviderContext);
}
