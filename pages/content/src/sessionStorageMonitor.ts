import type { SessionMeshCommand } from '@sessionmesh/shared';
import { isExtensionContextAlive, isSupportedHttpOrigin } from './localStorageMonitor';

export interface SessionStorageMutation {
  key: string;
  value?: string;
  deleted?: boolean;
}

export interface SessionStorageMonitorConfig {
  enabled: boolean;
  keyAllowlist?: string[];
}

interface EchoSuppressionEntry {
  value?: string;
  deleted: boolean;
  expiresAt: number;
}

const POLL_INTERVAL_MS = 2_500;
const ECHO_SUPPRESSION_TTL_MS = 2_500;
const MAX_SYNCABLE_SS_VALUE_LENGTH = 256 * 1024;

function matchesAllowlist(key: string, allowlist?: string[]): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  for (const rawRule of allowlist) {
    const rule = rawRule.trim();
    if (!rule) continue;
    if (rule.endsWith('*')) {
      const prefix = rule.slice(0, -1);
      if (key.startsWith(prefix)) return true;
    } else if (key === rule || key.startsWith(rule)) {
      return true;
    }
  }
  return false;
}

export function readSessionStorageSafe(keyAllowlist?: string[]): {
  available: boolean;
  items: Record<string, string>;
  reason?: string;
} {
  try {
    const storage = window.sessionStorage;
    const items: Record<string, string> = Object.create(null);
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key === null) continue;
      if (!matchesAllowlist(key, keyAllowlist)) continue;
      const val = storage.getItem(key);
      if (val !== null && val.length <= MAX_SYNCABLE_SS_VALUE_LENGTH) {
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
      reason: err instanceof Error ? err.message : 'sessionStorage_unavailable',
    };
  }
}

/**
 * Opt-in monitor for window.sessionStorage on strict window.location.origin.
 * Disabled by default (`enabled = false`, zero timers) until configured by background.
 * `handleGetSessionStorage` and `handleApplySessionStorage` remain available on demand.
 */
export class SessionStorageMonitor {
  private readonly baseline = new Map<string, string>();
  private readonly suppressedEchoes = new Map<string, EchoSuppressionEntry>();
  private enabled = false;
  private keyAllowlist: string[] | undefined;
  private isApplyingRemote = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private listenersAttached = false;
  private initialized = false;

  get origin(): string {
    return window.location.origin;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  init(): void {
    if (this.initialized || !isSupportedHttpOrigin()) return;
    this.initialized = true;
    // Remains idle with zero timers until configure({ enabled: true }) is called.
  }

  configure(config: SessionStorageMonitorConfig): void {
    if (!isSupportedHttpOrigin()) return;
    if (!this.initialized) {
      this.init();
    }

    const normalizedAllowlist =
      config.keyAllowlist && config.keyAllowlist.length > 0
        ? config.keyAllowlist.map(k => k.trim()).filter(Boolean)
        : undefined;
    const nextAllowlist = normalizedAllowlist && normalizedAllowlist.length > 0 ? normalizedAllowlist : undefined;

    if (!config.enabled) {
      this.enabled = false;
      this.keyAllowlist = undefined;
      this.stopPollingTimer();
      this.detachListeners();
      this.baseline.clear();
      this.suppressedEchoes.clear();
      return;
    }

    const wasEnabled = this.enabled;
    this.enabled = true;
    this.keyAllowlist = nextAllowlist;

    if (wasEnabled && nextAllowlist) {
      for (const key of Array.from(this.baseline.keys())) {
        if (!matchesAllowlist(key, nextAllowlist)) {
          this.baseline.delete(key);
        }
      }
    }

    this.attachListeners();
    this.syncPollingTimer();
    this.diffAndReport();
  }

  dispose(): void {
    this.enabled = false;
    this.keyAllowlist = undefined;
    this.initialized = false;
    this.stopPollingTimer();
    this.detachListeners();
    this.baseline.clear();
    this.suppressedEchoes.clear();
  }

  /**
   * Handle CS_GET_SESSION_STORAGE strictly checking window.location.origin.
   * Always works on demand even when continuous monitoring is disabled.
   */
  handleGetSessionStorage(requestedOrigin: string): {
    available: boolean;
    items: Record<string, string>;
    reason?: string;
  } {
    if (requestedOrigin !== this.origin) {
      return { available: false, items: {}, reason: 'origin_mismatch' };
    }
    const snap = readSessionStorageSafe();
    if (snap.available && this.enabled) {
      const filtered: Record<string, string> = Object.create(null);
      for (const [k, v] of Object.entries(snap.items)) {
        if (matchesAllowlist(k, this.keyAllowlist)) {
          Object.defineProperty(filtered, k, {
            value: v,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      }
      this.replaceBaseline(filtered);
    }
    return snap;
  }

  /**
   * Handle CS_APPLY_SESSION_STORAGE strictly checking window.location.origin,
   * updating baseline and echo suppression so applied remote values never loop back.
   */
  handleApplySessionStorage(
    requestedOrigin: string,
    mutations: SessionStorageMutation[],
  ): { applied: boolean; reason?: string } {
    if (requestedOrigin !== this.origin) {
      return { applied: false, reason: 'origin_mismatch' };
    }

    this.isApplyingRemote = true;
    try {
      const storage = window.sessionStorage;
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
          if (this.enabled && matchesAllowlist(mutation.key, this.keyAllowlist)) {
            this.baseline.set(mutation.key, nextValue);
          }
        }
      }

      return { applied: true };
    } catch (err) {
      return {
        applied: false,
        reason: err instanceof Error ? err.message : 'sessionStorage_apply_failed',
      };
    } finally {
      this.isApplyingRemote = false;
    }
  }

  readFilteredSnapshot(): Record<string, string> {
    if (!this.enabled) return {};
    const snap = readSessionStorageSafe(this.keyAllowlist);
    return snap.available ? snap.items : {};
  }

  collectLeavingChanges(): SessionStorageMutation[] {
    if (!this.enabled) return [];
    return this.collectLocalDiff();
  }

  private attachListeners(): void {
    if (this.listenersAttached) return;
    this.listenersAttached = true;
    window.addEventListener('storage', this.handleStorageEvent);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    window.addEventListener('pagehide', this.handlePageHide);
  }

  private detachListeners(): void {
    if (!this.listenersAttached) return;
    this.listenersAttached = false;
    window.removeEventListener('storage', this.handleStorageEvent);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    window.removeEventListener('pagehide', this.handlePageHide);
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

  private isSuppressedEcho(change: SessionStorageMutation, now: number): boolean {
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
        void chrome.runtime.lastError;
      });
    } catch {
      this.dispose();
    }
  }

  private collectLocalDiff(): SessionStorageMutation[] {
    if (!this.enabled || this.isApplyingRemote) return [];
    if (!isExtensionContextAlive()) {
      this.dispose();
      return [];
    }

    const snap = readSessionStorageSafe(this.keyAllowlist);
    if (!snap.available) return [];

    const now = Date.now();
    this.pruneExpiredSuppressedEchoes(now);

    const changes: SessionStorageMutation[] = [];

    for (const [key, val] of Object.entries(snap.items)) {
      const prev = this.baseline.get(key);
      if (prev === undefined || prev !== val) {
        const change: SessionStorageMutation = { key, value: val };
        if (!this.isSuppressedEcho(change, now)) {
          changes.push(change);
        }
      }
    }

    for (const key of this.baseline.keys()) {
      if (!Object.prototype.hasOwnProperty.call(snap.items, key)) {
        const change: SessionStorageMutation = { key, deleted: true };
        if (!this.isSuppressedEcho(change, now)) {
          changes.push(change);
        }
      }
    }

    this.replaceBaseline(snap.items);
    return changes;
  }

  private diffAndReport(): void {
    if (!this.enabled) return;
    const changes = this.collectLocalDiff();
    if (changes.length > 0) {
      this.sendToBackground({
        type: 'CONTENT_SESSION_STORAGE_CHANGED',
        origin: this.origin,
        changes,
      });
    }
  }

  private readonly handleStorageEvent = (event: StorageEvent): void => {
    if (!this.enabled || this.isApplyingRemote) return;
    if (event.storageArea !== window.sessionStorage) return;
    this.diffAndReport();
  };

  private readonly handleVisibilityChange = (): void => {
    if (!this.enabled) return;
    this.syncPollingTimer();
    this.diffAndReport();
  };

  private readonly handlePageHide = (): void => {
    if (!this.enabled) return;
    this.diffAndReport();
    this.stopPollingTimer();
  };

  private syncPollingTimer(): void {
    if (this.enabled && document.visibilityState === 'visible') {
      if (this.pollTimer === null) {
        this.pollTimer = setInterval(() => {
          if (this.enabled && document.visibilityState === 'visible') {
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
