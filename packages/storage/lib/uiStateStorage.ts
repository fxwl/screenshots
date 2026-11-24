import type { SyncStatusSummary } from '@sessionmesh/core';
import { createStorage, StorageType, type BaseStorage } from './base';

export interface UiStateSnapshot {
  revision: number;
  updatedAt: number;
  status: SyncStatusSummary;
}

export const DEFAULT_SYNC_STATUS_SUMMARY: SyncStatusSummary = {
  configured: false,
  locked: false,
  spaces: [],
  status: 'UNCONFIGURED',
  webdavConnected: false,
  pendingUploads: 0,
  pendingApplies: 0,
  pendingDecisionsCount: 0,
  unresolvedConflictsCount: 0,
  undoPointsCount: 0,
  latestError: null,
  attentionItems: [],
};

const DEFAULT_UI_STATE: UiStateSnapshot = {
  revision: 0,
  updatedAt: 0,
  status: DEFAULT_SYNC_STATUS_SUMMARY,
};

const UI_STATE_STORAGE_KEY = 'sessionmesh-ui-state';

const baseUiStorage = createStorage<UiStateSnapshot>(UI_STATE_STORAGE_KEY, DEFAULT_UI_STATE, {
  storageType: StorageType.Local,
  liveUpdate: true,
});

export type UiStateStorage = BaseStorage<UiStateSnapshot> & {
  publishStatus: (status: SyncStatusSummary) => Promise<void>;
  bumpRevision: () => Promise<void>;
};

/**
 * Reactive UI state bridge persisted in chrome.storage.local with liveUpdate: true.
 * Whenever Background mutates SyncEngine state, it publishes the latest SyncStatusSummary
 * and increments `revision`, waking Popup, Options, and SidePanel instantly.
 */
export const uiStateStorage: UiStateStorage = {
  ...baseUiStorage,
  publishStatus: async (status: SyncStatusSummary) => {
    await baseUiStorage.set(prev => ({
      revision: (prev?.revision ?? 0) + 1,
      updatedAt: Date.now(),
      status,
    }));
  },
  bumpRevision: async () => {
    await baseUiStorage.set(prev => ({
      revision: (prev?.revision ?? 0) + 1,
      updatedAt: Date.now(),
      status: prev?.status ?? DEFAULT_SYNC_STATUS_SUMMARY,
    }));
  },
};
