import { themeStorage, type Theme } from '@sessionmesh/storage';
import { createContext, useEffect, useMemo } from 'react';
import { useStorage } from '../hooks/useStorage';

type ThemeProviderProps = {
  children: React.ReactNode;
};

export type ThemeProviderState = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

const initialState: ThemeProviderState = {
  theme: 'system',
  setTheme: () => null,
};

export const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

function applyThemeClass(theme: Theme) {
  if (typeof window === 'undefined' || !window.document?.documentElement) return;
  const root = window.document.documentElement;
  root.classList.remove('light', 'dark');

  if (theme === 'system') {
    const prefersDark =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.classList.add(prefersDark ? 'dark' : 'light');
    return;
  }

  root.classList.add(theme);
}

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  const storedTheme = useStorage(themeStorage);
  const theme: Theme = storedTheme ?? 'system';

  useEffect(() => {
    applyThemeClass(theme);

    if (theme !== 'system' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyThemeClass('system');
    mediaQuery.addEventListener('change', onChange);
    return () => {
      mediaQuery.removeEventListener('change', onChange);
    };
  }, [theme]);

  const value = useMemo<ThemeProviderState>(
    () => ({
      theme,
      setTheme: (nextTheme: Theme) => {
        void themeStorage.set(nextTheme);
      },
    }),
    [theme],
  );

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}
