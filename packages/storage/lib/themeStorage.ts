import { createStorage, StorageType, type BaseStorage } from './base';

export type Theme = 'light' | 'dark' | 'system';

export type ThemeStorage = BaseStorage<Theme> & {
  toggle: () => Promise<void>;
};

const THEME_STORAGE_KEY = 'sessionmesh-theme-storage';

const storage = createStorage<Theme>(THEME_STORAGE_KEY, 'system', {
  storageType: StorageType.Local,
  liveUpdate: true,
});

export const themeStorage: ThemeStorage = {
  ...storage,
  toggle: async () => {
    await storage.set((currentTheme: Theme) => {
      return currentTheme === 'dark' ? 'light' : 'dark';
    });
  },
};
