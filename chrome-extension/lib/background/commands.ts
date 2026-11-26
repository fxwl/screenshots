import type { AccountSwitchToastPayload } from '@sessionmesh/shared';

export const COMMAND_IDS = {
  ROTATE_NEXT: 'rotate-account-next',
  ROTATE_PREV: 'rotate-account-prev',
  SYNC_SITE: 'sync-current-site',
  COPY_CURL: 'copy-current-curl',
} as const;

export const PENDING_TOAST_SESSION_KEY = 'sessionmesh_pending_account_toasts_v1';

interface StoredPendingToast {
  payload: AccountSwitchToastPayload;
  expiresAt: number;
}

type PendingToastMap = Record<string, StoredPendingToast>;

export interface CommandShortcutsHandlers {
  onRotateAccount: (direction: 'next' | 'prev', tab?: chrome.tabs.Tab) => Promise<void>;
  onSyncCurrentSite: (tab?: chrome.tabs.Tab) => Promise<void>;
  onCopyCurrentCurl: (tab?: chrome.tabs.Tab) => Promise<void>;
}

const memoryFallbackToasts = new Map<string, StoredPendingToast>();
let toastStorageQueue: Promise<void> = Promise.resolve();
let listenerRegistered = false;

function runToastStorageSerialized<T>(task: () => Promise<T>): Promise<T> {
  const next = toastStorageQueue.then(task, task);
  toastStorageQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function readPendingToastMap(): Promise<PendingToastMap> {
  if (typeof chrome !== 'undefined' && chrome.storage?.session?.get) {
    try {
      const res = await chrome.storage.session.get(PENDING_TOAST_SESSION_KEY);
      const raw = res?.[PENDING_TOAST_SESSION_KEY];
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return { ...(raw as PendingToastMap) };
      }
      return {};
    } catch {
      // fall through to memory fallback
    }
  }

  const out: PendingToastMap = {};
  for (const [key, entry] of memoryFallbackToasts.entries()) {
    out[key] = entry;
  }
  return out;
}

async function writePendingToastMap(map: PendingToastMap): Promise<void> {
  memoryFallbackToasts.clear();
  for (const [key, entry] of Object.entries(map)) {
    memoryFallbackToasts.set(key, entry);
  }

  if (typeof chrome !== 'undefined' && chrome.storage?.session?.set) {
    try {
      await chrome.storage.session.set({ [PENDING_TOAST_SESSION_KEY]: map });
    } catch {
      // ignore session storage errors
    }
  }
}

function pruneExpiredToasts(map: PendingToastMap, now: number): { pruned: PendingToastMap; changed: boolean } {
  const pruned: PendingToastMap = {};
  let changed = false;
  for (const [key, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== 'object' || typeof entry.expiresAt !== 'number' || entry.expiresAt <= now) {
      changed = true;
      continue;
    }
    pruned[key] = entry;
  }
  return { pruned, changed };
}

/**
 * Persists a short-lived post-reload account switch toast payload for `tabId`
 * in `chrome.storage.session` so it survives MV3 Service Worker suspension.
 */
export async function savePendingTabAccountToast(
  tabId: number,
  payload: AccountSwitchToastPayload,
  ttlMs = 10_000,
): Promise<void> {
  if (!Number.isFinite(tabId) || tabId < 0) return;
  const effectiveTtl = Math.max(500, ttlMs);

  await runToastStorageSerialized(async () => {
    const now = Date.now();
    const raw = await readPendingToastMap();
    const { pruned } = pruneExpiredToasts(raw, now);
    pruned[String(tabId)] = {
      payload,
      expiresAt: now + effectiveTtl,
    };

    // Keep map bounded if many tabs switch quickly
    const entries = Object.entries(pruned);
    if (entries.length > 50) {
      entries.sort((a, b) => b[1].expiresAt - a[1].expiresAt);
      const bounded: PendingToastMap = {};
      for (const [k, v] of entries.slice(0, 50)) {
        bounded[k] = v;
      }
      await writePendingToastMap(bounded);
      return;
    }

    await writePendingToastMap(pruned);
  });
}

/**
 * Consumes and removes any non-expired pending account switch toast for `tabId`
 * (optionally verifying `siteKey` matches when provided).
 */
export async function consumePendingTabAccountToast(
  tabId: number,
  siteKey?: string,
): Promise<AccountSwitchToastPayload | null> {
  if (!Number.isFinite(tabId) || tabId < 0) return null;

  return runToastStorageSerialized(async () => {
    const now = Date.now();
    const raw = await readPendingToastMap();
    const { pruned, changed: prunedChanged } = pruneExpiredToasts(raw, now);
    const key = String(tabId);
    const entry = pruned[key];

    if (!entry) {
      if (prunedChanged) {
        await writePendingToastMap(pruned);
      }
      return null;
    }

    if (siteKey && entry.payload.siteKey && entry.payload.siteKey !== siteKey) {
      if (prunedChanged) {
        await writePendingToastMap(pruned);
      }
      return null;
    }

    delete pruned[key];
    await writePendingToastMap(pruned);
    return entry.payload;
  });
}

async function resolveActiveTabForCommand(tab?: chrome.tabs.Tab): Promise<chrome.tabs.Tab | undefined> {
  if (tab?.url) {
    return tab;
  }
  if (typeof chrome === 'undefined' || !chrome.tabs?.query) {
    return tab;
  }

  return new Promise<chrome.tabs.Tab | undefined>(resolve => {
    try {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
        if (chrome.runtime.lastError || !Array.isArray(tabs) || tabs.length === 0) {
          resolve(tab);
          return;
        }
        resolve(tabs[0] ?? tab);
      });
    } catch {
      resolve(tab);
    }
  });
}

/**
 * Registers the top-level chrome.commands.onCommand listener synchronously
 * so keyboard shortcuts wake the MV3 Service Worker reliably.
 */
export function registerCommandShortcutsListener(handlers: CommandShortcutsHandlers): void {
  if (listenerRegistered || typeof chrome === 'undefined' || !chrome.commands?.onCommand) return;
  listenerRegistered = true;

  chrome.commands.onCommand.addListener((command, tab) => {
    void (async () => {
      const activeTab = await resolveActiveTabForCommand(tab);
      switch (command) {
        case COMMAND_IDS.ROTATE_NEXT:
          await handlers.onRotateAccount('next', activeTab);
          break;
        case COMMAND_IDS.ROTATE_PREV:
          await handlers.onRotateAccount('prev', activeTab);
          break;
        case COMMAND_IDS.SYNC_SITE:
          await handlers.onSyncCurrentSite(activeTab);
          break;
        case COMMAND_IDS.COPY_CURL:
          await handlers.onCopyCurrentCurl(activeTab);
          break;
        default:
          break;
      }
    })().catch(err => {
      console.warn(`SessionMesh command "${command}" handler failed:`, err);
    });
  });
}
