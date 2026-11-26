import type { BrowserCookieChangeEvent, PartitionKeyInfo } from '../types';
import { normalizeCookieStoreScope } from '../version';

interface SuppressionEntry {
  op: 'set' | 'remove';
  contentHash: string;
  expiresAt: number;
  remainingHits: number;
  /** Number of preceding explicit removeCookie() IPCs still in flight for the same key */
  pendingExplicitRemoves?: number;
}

export function buildEchoCookieKey(cookie: {
  domain: string;
  path: string;
  name: string;
  hostOnly?: boolean;
  partitionKey?: PartitionKeyInfo | null;
  storeId?: string;
  storeScope?: string;
}): string {
  const normDomain = cookie.domain.toLowerCase().replace(/^\./, '');
  const pk = cookie.partitionKey?.topLevelSite ?? '';
  const path = cookie.path || '/';
  const store = normalizeCookieStoreScope(cookie.storeId ?? cookie.storeScope);
  return `c::${store}::${pk}::${normDomain}::${path}::${cookie.name}`;
}

export function buildEchoLsKey(origin: string, key: string): string {
  return `ls::${origin.toLowerCase()}::${key}`;
}

export class EchoSuppressor {
  private readonly entries = new Map<string, SuppressionEntry>();
  private readonly defaultTtlMs: number;

  constructor(defaultTtlMs = 15_000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  registerCookieMutation(
    cookie: {
      domain: string;
      path: string;
      name: string;
      hostOnly?: boolean;
      partitionKey?: PartitionKeyInfo | null;
      storeId?: string;
      storeScope?: string;
    },
    op: 'set' | 'remove',
    contentHash: string,
    nowMs: number,
    ttlMs = this.defaultTtlMs,
  ): void {
    const key = buildEchoCookieKey(cookie);
    const prev = this.entries.get(key);
    let pendingExplicitRemoves = 0;
    if (prev && prev.expiresAt >= nowMs) {
      pendingExplicitRemoves = prev.pendingExplicitRemoves ?? 0;
      if (op === 'set' && prev.op === 'remove') {
        pendingExplicitRemoves += prev.remainingHits;
      }
    }
    this.entries.set(key, {
      op,
      contentHash,
      expiresAt: nowMs + ttlMs,
      remainingHits: op === 'set' ? 2 : 1,
      pendingExplicitRemoves: pendingExplicitRemoves > 0 ? pendingExplicitRemoves : undefined,
    });
  }

  shouldSuppressCookieEvent(
    event: BrowserCookieChangeEvent,
    contentHash: string,
    nowMs: number,
  ): boolean {
    this.prune(nowMs);
    const key = buildEchoCookieKey(event.cookie);
    const entry = this.entries.get(key);
    if (!entry) return false;

    if (entry.expiresAt < nowMs) {
      this.entries.delete(key);
      return false;
    }

    // Chromium emits removed:true, cause:'overwrite' immediately before removed:false when setting an existing cookie
    if (event.removed && event.cause === 'overwrite' && entry.op === 'set') {
      entry.remainingHits = Math.max(1, entry.remainingHits - 1);
      return true;
    }

    // Suppress in-flight removed:true, cause:'explicit' from a removeCookie() that immediately preceded setCookie()
    if (event.removed && entry.op === 'set' && (entry.pendingExplicitRemoves ?? 0) > 0) {
      entry.pendingExplicitRemoves = (entry.pendingExplicitRemoves ?? 1) - 1;
      return true;
    }

    if (event.removed && entry.op === 'remove') {
      entry.remainingHits -= 1;
      if (entry.remainingHits <= 0) {
        this.entries.delete(key);
      }
      return true;
    }

    if (!event.removed && entry.op === 'set' && entry.contentHash === contentHash) {
      if ((entry.pendingExplicitRemoves ?? 0) <= 0) {
        this.entries.delete(key);
      } else {
        entry.remainingHits = 0;
      }
      return true;
    }

    return false;
  }

  registerLocalStorageMutation(
    origin: string,
    key: string,
    op: 'set' | 'remove',
    valueHash: string,
    nowMs: number,
    ttlMs = 4_000,
  ): void {
    this.entries.set(buildEchoLsKey(origin, key), {
      op,
      contentHash: valueHash,
      expiresAt: nowMs + ttlMs,
      // Multiple open tabs on the same origin can each fire a native `storage` event for one write.
      // Keep matching `(op, valueHash)` echoes suppressed for the short TTL window; any differing
      // user mutation (different value or opposite op) clears the entry and passes through immediately.
      remainingHits: Number.MAX_SAFE_INTEGER,
    });
  }

  shouldSuppressLocalStorageEvent(
    origin: string,
    key: string,
    op: 'set' | 'remove',
    valueHash: string,
    nowMs: number,
  ): boolean {
    this.prune(nowMs);
    const mapKey = buildEchoLsKey(origin, key);
    const entry = this.entries.get(mapKey);
    if (!entry) return false;
    if (entry.expiresAt < nowMs) {
      this.entries.delete(mapKey);
      return false;
    }
    if (entry.op === op && (op === 'remove' || entry.contentHash === valueHash)) {
      return true;
    }
    // Divergent real user mutation arrived -> clear old suppression immediately
    this.entries.delete(mapKey);
    return false;
  }

  prune(nowMs: number): void {
    for (const [k, v] of Array.from(this.entries.entries())) {
      if (v.expiresAt < nowMs) {
        this.entries.delete(k);
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
