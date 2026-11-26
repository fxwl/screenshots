import { normalizeDomain } from '../psl';

function normalizeOrigin(origin: string): string {
  const trimmed = origin.trim();
  if (!trimmed) return '';
  if (trimmed.includes('://')) {
    try {
      return new URL(trimmed).origin;
    } catch {
      return trimmed.replace(/\/+$/, '').toLowerCase();
    }
  }
  return trimmed.replace(/\/+$/, '');
}

const DEFAULT_COOKIE_STORE_IDS = new Set(['', 'default', '0', 'firefox-default']);

/**
 * Normalizes browser-specific default cookie jar identifiers ("0" in Chromium/Edge,
 * "firefox-default" in Firefox, "" / undefined / "default") into canonical "default",
 * while keeping isolated stores (incognito "1", container stores) distinct.
 */
export function normalizeCookieStoreScope(storeId?: string | null): string {
  const clean = (storeId ?? '').trim();
  if (!clean || DEFAULT_COOKIE_STORE_IDS.has(clean)) {
    return 'default';
  }
  return clean;
}

/**
 * Constructs the canonical globally unique logical identifier for a Cookie record.
 * Isolates by trackId, storeScope, CHIPS partitionKey, hostOnly vs domain, domain, path, and name.
 */
export function buildCookieLogicalId(params: {
  trackId: string;
  storeScope?: string;
  partitionKey?: { topLevelSite: string } | null;
  hostOnly: boolean;
  domain: string;
  path: string;
  name: string;
}): string {
  const storeScope = normalizeCookieStoreScope(params.storeScope);
  const partition = params.partitionKey?.topLevelSite || 'none';
  const domainPrefix = params.hostOnly ? 'h:' : 'd:';
  const normalizedDomain = normalizeDomain(params.domain);
  const path = params.path || '/';
  return `cookie::${params.trackId}::${storeScope}::${partition}::${domainPrefix}${normalizedDomain}::${path}::${params.name}`;
}

/**
 * Constructs the canonical globally unique logical identifier for a LocalStorage record.
 * Strictly isolates by trackId, origin (scheme + host + port), and key.
 */
export function buildLocalStorageLogicalId(trackId: string, origin: string, key: string): string {
  return `ls::${trackId}::${normalizeOrigin(origin)}::${key}`;
}

/**
 * Constructs the canonical globally unique logical identifier for a SessionStorage record.
 * Strictly isolates by trackId, origin (scheme + host + port), and key.
 */
export function buildSessionStorageLogicalId(trackId: string, origin: string, key: string): string {
  return `ss::${trackId}::${normalizeOrigin(origin)}::${key}`;
}

/**
 * Constructs the canonical globally unique logical identifier for an IndexedDB record.
 * Strictly isolates by trackId, origin, dbName, storeName, and canonical encodedKey.
 */
export function buildIndexedDbLogicalId(params: {
  trackId: string;
  origin: string;
  dbName: string;
  storeName: string;
  encodedKey: string;
}): string {
  return `idb::${params.trackId}::${normalizeOrigin(params.origin)}::${encodeURIComponent(params.dbName)}::${encodeURIComponent(params.storeName)}::${params.encodedKey}`;
}
