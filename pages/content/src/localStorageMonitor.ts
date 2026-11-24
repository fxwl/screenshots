import type { SessionMeshCommand } from '@sessionmesh/shared';

export interface LocalStorageMutation {
  key: string;
  value?: string;
  deleted?: boolean;
}

interface EchoSuppressionEntry {
  value?: string;
  deleted: boolean;
  expiresAt: number;
}

const POLL_INTERVAL_MS = 15_000;
const ECHO_SUPPRESSION_TTL_MS = 2_500;
const MAX_SYNCABLE_LS_VALUE_LENGTH = 256 * 1024;

export function isSupportedHttpOrigin(): boolean {
  if (typeof window === 'undefined' || !window.location) return false;
  const proto = window.location.protocol;
  if (proto !== 'http:' && proto !== 'https:') return false;
  return Boolean(window.location.origin && window.location.origin !== 'null');
}

export function isExtensionContextAlive(): boolean {
  try {
    return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

export function readLocalStorageSafe(): { available: boolean; items: Record<string, string>; reason?: string } {
  try {
    const storage = window.localStorage;
    const items: Record<string, string> = Object.create(null);
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key === null) continue;
      const val = storage.getItem(key);
      if (val !== null && val.length <= MAX_SYNCABLE_LS_VALUE_LENGTH) {
        Object.defineProperty(items, key, {
          value: val,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    return { available: true, items };
  } catch (err) {
    return {
      available: false,
      items: Object.create(null),
      reason: err instanceof Error ? err.message : 'localStorage_unavailable',
    };
  }
}

/**
 * Monitors window.localStorage for strict window.location.origin changes (CREATE, UPDATE, DELETE)
 * using storage events + lightweight visible-tab 3s diff + pagehide flush, while suppressing
 * echoes from CS_APPLY_LOCAL_STORAGE mutations.
 */
export class LocalStorageMonitor {
  private readonly baseline = new Map<string, string>();
  private readonly suppressedEchoes = new Map<string, EchoSuppressionEntry>();
  private isApplyingRemote = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  get origin(): string {
    return window.location.origin;
  }

  init(): void {
    if (this.initialized || !isSupportedHttpOrigin()) return;
    this.initialized = true;

    // Initial baseline capture and mount report
    this.scanAndNotifyMounted();

    // Re-capture on DOMContentLoaded in case early scripts initialized auth tokens
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', this.handleDomReady, { once: true });
    }

    window.addEventListener('storage', this.handleStorageEvent);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    window.addEventListener('pagehide', this.handlePageHide);

    this.syncPollingTimer();
  }

  dispose(): void {
    if (!this.initialized) return;
    this.initialized = false;
    this.stopPollingTimer();
    document.removeEventListener('DOMContentLoaded', this.handleDomReady);
    window.removeEventListener('storage', this.handleStorageEvent);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    window.removeEventListener('pagehide', this.handlePageHide);
    this.baseline.clear();
    this.suppressedEchoes.clear();
  }

  /**
   * Handle CS_GET_LOCAL_STORAGE strictly checking window.location.origin.
   */
  handleGetLocalStorage(requestedOrigin: string): {
    available: boolean;
    items: Record<string, string>;
    reason?: string;
  } {
    if (requestedOrigin !== this.origin) {
      return { available: false, items: {}, reason: 'origin_mismatch' };
    }
    const snap = readLocalStorageSafe();
    if (snap.available) {
      this.replaceBaseline(snap.items);
    }
    return snap;
  }

  /**
   * Handle CS_APPLY_LOCAL_STORAGE strictly checking window.location.origin,
   * updating baseline and echo suppression so applied remote values never loop back.
   */
  handleApplyLocalStorage(
    requestedOrigin: string,
    mutations: LocalStorageMutation[],
  ): { applied: boolean; reason?: string } {
    if (requestedOrigin !== this.origin) {
      return { applied: false, reason: 'origin_mismatch' };
    }

    this.isApplyingRemote = true;
    try {
      const storage = window.localStorage;
      const expiresAt = Date.now() + ECHO_SUPPRESSION_TTL_MS;

      for (const mutation of mutations) {
        if (mutation.deleted) {
          this.suppressedEchoes.set(mutation.key, {
            deleted: true,
            expiresAt,
          });
          storage.removeItem(mutation.key);
          this.baseline.delete(mutation.key);
        } else {
          const nextValue = mutation.value ?? '';
          this.suppressedEchoes.set(mutation.key, {
            value: nextValue,
            deleted: false,
            expiresAt,
          });
          storage.setItem(mutation.key, nextValue);
          this.baseline.set(mutation.key, nextValue);
        }
      }

      return { applied: true };
    } catch (err) {
      return {
        applied: false,
        reason: err instanceof Error ? err.message : 'localStorage_apply_failed',
      };
    } finally {
      this.isApplyingRemote = false;
    }
  }

  private replaceBaseline(items: Record<string, string>): void {
    this.baseline.clear();
    for (const [k, v] of Object.entries(items)) {
      this.baseline.set(k, v);
    }
  }

  private pruneExpiredSuppressedEchoes(now: number): void {
    for (const [key, entry] of this.suppressedEchoes.entries()) {
      if (entry.expiresAt <= now) {
        this.suppressedEchoes.delete(key);
      }
    }
  }

  private isSuppressedEcho(change: LocalStorageMutation, now: number): boolean {
    const entry = this.suppressedEchoes.get(change.key);
    if (!entry) return false;
    if (entry.expiresAt <= now) {
      this.suppressedEchoes.delete(change.key);
      return false;
    }
    const matches = Boolean(change.deleted) === entry.deleted && (entry.deleted || change.value === entry.value);
    if (matches) {
      this.suppressedEchoes.delete(change.key);
      return true;
    }
    return false;
  }

  private sendToBackground(cmd: SessionMeshCommand): void {
    if (!isExtensionContextAlive()) {
      this.dispose();
      return;
    }
    try {
      chrome.runtime.sendMessage(cmd, () => {
        // Consume chrome.runtime.lastError silently if background is not listening
        void chrome.runtime.lastError;
      });
    } catch {
      this.dispose();
    }
  }

  private scanAndNotifyMounted(): void {
    const snap = readLocalStorageSafe();
    if (!snap.available) return;
    this.replaceBaseline(snap.items);
    this.sendToBackground({
      type: 'CONTENT_PAGE_MOUNTED',
      origin: this.origin,
      items: snap.items,
    });
  }

  private collectLocalDiff(): LocalStorageMutation[] {
    if (this.isApplyingRemote) return [];
    if (!isExtensionContextAlive()) {
      this.dispose();
      return [];
    }

    const snap = readLocalStorageSafe();
    if (!snap.available) return [];

    const now = Date.now();
    this.pruneExpiredSuppressedEchoes(now);

    const changes: LocalStorageMutation[] = [];

    // Detect CREATE & UPDATE
    for (const [key, val] of Object.entries(snap.items)) {
      const prev = this.baseline.get(key);
      if (prev === undefined || prev !== val) {
        const change: LocalStorageMutation = { key, value: val };
        if (!this.isSuppressedEcho(change, now)) {
          changes.push(change);
        }
      }
    }

    // Detect DELETE
    for (const key of this.baseline.keys()) {
      if (!Object.prototype.hasOwnProperty.call(snap.items, key)) {
        const change: LocalStorageMutation = { key, deleted: true };
        if (!this.isSuppressedEcho(change, now)) {
          changes.push(change);
        }
      }
    }

    this.replaceBaseline(snap.items);
    return changes;
  }

  private diffAndReport(): void {
    const changes = this.collectLocalDiff();
    if (changes.length > 0) {
      this.sendToBackground({
        type: 'CONTENT_LOCAL_STORAGE_CHANGED',
        origin: this.origin,
        changes,
      });
    }
  }

  private readonly handleDomReady = (): void => {
    this.diffAndReport();
  };

  private readonly handleStorageEvent = (event: StorageEvent): void => {
    if (this.isApplyingRemote) return;
    if (event.storageArea !== window.localStorage) return;

    // For clear() (event.key === null) or any key event, diff against baseline accurately
    this.diffAndReport();
  };

  private readonly handleVisibilityChange = (): void => {
    this.syncPollingTimer();
    if (document.visibilityState === 'visible') {
      // Only report incremental diffs when switching back; avoid resending full snapshot on every tab switch
      this.diffAndReport();
    } else {
      // Flush local diff right before tab becomes hidden
      this.diffAndReport();
    }
  };

  private readonly handlePageHide = (): void => {
    const changes = this.collectLocalDiff();
    this.sendToBackground({
      type: 'CONTENT_PAGE_LEAVING',
      origin: this.origin,
      changes,
    });
    this.stopPollingTimer();
  };

  private syncPollingTimer(): void {
    if (document.visibilityState === 'visible') {
      if (this.pollTimer === null) {
        this.pollTimer = setInterval(() => {
          if (document.visibilityState === 'visible') {
            this.diffAndReport();
          }
        }, POLL_INTERVAL_MS);
      }
    } else {
      this.stopPollingTimer();
    }
  }

  private stopPollingTimer(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
