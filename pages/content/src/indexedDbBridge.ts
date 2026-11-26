import { decodeIdbKey, decodeTypedValue, encodeIdbKey, encodeTypedValue } from '@sessionmesh/core';
import type {
  IndexedDbMutation,
  IndexedDbRecord,
  IndexedDbTargetRule,
  InspectedIndexedDbDatabase,
  InspectedIndexedDbStore,
  SessionMeshCommand,
} from '@sessionmesh/shared';
import { isExtensionContextAlive, isSupportedHttpOrigin } from './localStorageMonitor';

export type IndexedDbCapturedRecord = Omit<
  IndexedDbRecord,
  | 'logicalId'
  | 'siteKey'
  | 'trackId'
  | 'version'
  | 'sourceDevice'
  | 'sourceDeviceName'
  | 'deleted'
  | 'updatedAt'
  | 'syncStatus'
>;

export interface IndexedDbBridgeConfig {
  enabled: boolean;
  targets?: IndexedDbTargetRule[];
  maxTotalBytes?: number;
}

const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024;
const OPEN_TIMEOUT_MS = 3_000;
const INSPECT_SAMPLE_LIMIT = 20;
const ACTIVITY_POLL_INTERVAL_MS = 8_000;
const ECHO_SUPPRESSION_TTL_MS = 2_500;

const utf8Encoder = new TextEncoder();

function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).byteLength;
}

function keyMatchesPrefixes(key: IDBValidKey, encodedKey: string, prefixes?: string[]): boolean {
  if (!prefixes || prefixes.length === 0) return true;
  for (const raw of prefixes) {
    const prefix = raw.trim();
    if (!prefix) continue;
    if (typeof key === 'string' && key.startsWith(prefix)) return true;
    if (Array.isArray(key) && key.length > 0 && typeof key[0] === 'string' && key[0].startsWith(prefix)) return true;
    if (encodedKey.startsWith(prefix)) return true;
  }
  return false;
}

function closeDbSafe(db: IDBDatabase | null | undefined): void {
  if (!db) return;
  try {
    db.close();
  } catch {
    // ignore close errors
  }
}

async function listExistingDatabaseNames(): Promise<Map<string, number> | null> {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
    return null;
  }
  try {
    const list = await indexedDB.databases();
    const map = new Map<string, number>();
    for (const info of list) {
      if (info.name) {
        map.set(info.name, typeof info.version === 'number' ? info.version : 1);
      }
    }
    return map;
  } catch {
    return null;
  }
}

function openExistingDbReadOnly(dbName: string): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    let settled = false;
    let abortedPhantomCreate = false;
    const finish = (db: IDBDatabase | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(db);
    };

    const timer = setTimeout(() => finish(null), OPEN_TIMEOUT_MS);

    try {
      const req = indexedDB.open(dbName);
      req.onupgradeneeded = event => {
        // Guard against creating an empty phantom v1 DB if the database didn't actually exist
        if (event.oldVersion === 0) {
          abortedPhantomCreate = true;
          try {
            req.transaction?.abort();
          } catch {
            // ignore abort error
          }
        }
      };
      req.onblocked = () => {
        finish(null);
      };
      req.onerror = () => {
        finish(null);
      };
      req.onsuccess = () => {
        const db = req.result;
        if (abortedPhantomCreate) {
          closeDbSafe(db);
          finish(null);
          return;
        }
        db.onversionchange = () => {
          closeDbSafe(db);
        };
        if (settled) {
          closeDbSafe(db);
          return;
        }
        finish(db);
      };
    } catch {
      finish(null);
    }
  });
}

interface StoreCreateSpec {
  storeName: string;
  keyPath?: string | string[] | null;
  autoIncrement?: boolean;
}

function openDbForWrite(
  dbName: string,
  version: number | undefined,
  storesToCreate: StoreCreateSpec[],
): Promise<{ db: IDBDatabase | null; error?: string }> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: { db: IDBDatabase | null; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => finish({ db: null, error: `indexedDB_open_timeout:${dbName}` }), OPEN_TIMEOUT_MS);

    try {
      const req = version !== undefined ? indexedDB.open(dbName, version) : indexedDB.open(dbName);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const spec of storesToCreate) {
          if (db.objectStoreNames.contains(spec.storeName)) continue;
          const opts: IDBObjectStoreParameters = {};
          if (spec.keyPath !== undefined && spec.keyPath !== null) {
            opts.keyPath = spec.keyPath;
          }
          if (spec.autoIncrement !== undefined) {
            opts.autoIncrement = Boolean(spec.autoIncrement);
          }
          db.createObjectStore(spec.storeName, opts);
        }
      };
      req.onblocked = () => {
        finish({ db: null, error: `indexedDB_open_blocked:${dbName}` });
      };
      req.onerror = () => {
        finish({ db: null, error: req.error?.message || `indexedDB_open_failed:${dbName}` });
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          closeDbSafe(db);
        };
        if (settled) {
          closeDbSafe(db);
          return;
        }
        finish({ db });
      };
    } catch (err) {
      finish({ db: null, error: err instanceof Error ? err.message : `indexedDB_open_exception:${dbName}` });
    }
  });
}

function readStoreCountAndSampleBytes(db: IDBDatabase, storeName: string): Promise<InspectedIndexedDbStore> {
  return new Promise(resolve => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const keyPath = store.keyPath as string | string[] | null;
      const autoIncrement = Boolean(store.autoIncrement);

      let recordCount = 0;
      let sampledCount = 0;
      let sampledBytes = 0;

      const countReq = store.count();
      countReq.onsuccess = () => {
        recordCount = countReq.result;
      };

      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || sampledCount >= INSPECT_SAMPLE_LIMIT) {
          return;
        }
        sampledCount += 1;
        const keyRes = encodeIdbKey(cursor.key);
        const valRes = encodeTypedValue(cursor.value);
        if (keyRes.ok && valRes.ok) {
          sampledBytes += utf8ByteLength(keyRes.encodedKey) + valRes.byteLength;
        } else if (typeof Blob !== 'undefined' && cursor.value instanceof Blob) {
          sampledBytes += cursor.value.size;
        }
        if (sampledCount < INSPECT_SAMPLE_LIMIT) {
          cursor.continue();
        }
      };

      tx.oncomplete = () => {
        const estimatedBytes =
          recordCount === 0 || sampledCount === 0
            ? 0
            : sampledCount >= recordCount
              ? sampledBytes
              : Math.round((sampledBytes / sampledCount) * recordCount);
        resolve({
          name: storeName,
          keyPath,
          autoIncrement,
          recordCount,
          estimatedBytes,
        });
      };
      tx.onerror = () => {
        resolve({ name: storeName, keyPath, autoIncrement, recordCount, estimatedBytes: 0 });
      };
      tx.onabort = () => {
        resolve({ name: storeName, keyPath, autoIncrement, recordCount, estimatedBytes: 0 });
      };
    } catch {
      resolve({ name: storeName, recordCount: 0, estimatedBytes: 0 });
    }
  });
}

function readRecordsFromStore(params: {
  origin: string;
  db: IDBDatabase;
  storeName: string;
  keyPrefixes?: string[];
  remainingBytes: number;
}): Promise<{
  records: IndexedDbCapturedRecord[];
  bytesUsed: number;
  quotaExceeded: boolean;
}> {
  const { origin, db, storeName, keyPrefixes, remainingBytes } = params;
  return new Promise(resolve => {
    const records: IndexedDbCapturedRecord[] = [];
    let bytesUsed = 0;
    let quotaExceeded = false;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ records, bytesUsed, quotaExceeded });
    };

    try {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const keyPath = store.keyPath as string | string[] | null;
      const autoIncrement = Boolean(store.autoIncrement);

      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;

        const keyRes = encodeIdbKey(cursor.key);
        if (!keyRes.ok) {
          cursor.continue();
          return;
        }

        if (!keyMatchesPrefixes(cursor.key, keyRes.encodedKey, keyPrefixes)) {
          cursor.continue();
          return;
        }

        const valRes = encodeTypedValue(cursor.value);
        if (!valRes.ok) {
          // Skip non-serializable values (CryptoKey, Blob, circular structures, etc.)
          cursor.continue();
          return;
        }

        const byteLength = utf8ByteLength(keyRes.encodedKey) + valRes.byteLength;
        if (bytesUsed + byteLength > remainingBytes) {
          quotaExceeded = true;
          try {
            tx.abort();
          } catch {
            // ignore abort error
          }
          finish();
          return;
        }

        bytesUsed += byteLength;
        records.push({
          origin,
          dbName: db.name,
          dbVersion: db.version,
          storeName,
          keyPath,
          autoIncrement,
          encodedKey: keyRes.encodedKey,
          encodedValue: valRes.encoded,
          byteLength,
        });
        cursor.continue();
      };

      tx.oncomplete = finish;
      tx.onerror = finish;
      tx.onabort = finish;
    } catch {
      finish();
    }
  });
}

function fnv1aDigestUpdate(hash: number, str: string): number {
  let h = hash >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Content-script bridge for IndexedDB inspection, TypedClone extraction,
 * safe mutation application, and optional low-frequency change detection.
 */
export class IndexedDbBridge {
  private enabled = false;
  private targets: IndexedDbTargetRule[] = [];
  private maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES;
  private baselineDigest: string | null = null;
  private suppressUntil = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private checkInFlight = false;
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
  }

  configure(config: IndexedDbBridgeConfig): void {
    if (!isSupportedHttpOrigin()) return;
    if (!this.initialized) {
      this.init();
    }

    const validTargets = (config.targets ?? []).filter(t => t && typeof t.dbName === 'string' && t.dbName.trim());
    if (!config.enabled || validTargets.length === 0) {
      this.enabled = false;
      this.targets = [];
      this.baselineDigest = null;
      this.stopPollingTimer();
      this.detachListeners();
      return;
    }

    this.enabled = true;
    this.targets = validTargets;
    this.maxTotalBytes =
      typeof config.maxTotalBytes === 'number' && Number.isFinite(config.maxTotalBytes)
        ? Math.max(1024, Math.floor(config.maxTotalBytes))
        : DEFAULT_MAX_TOTAL_BYTES;

    this.attachListeners();
    this.syncPollingTimer();
    void this.refreshBaselineDigest();
  }

  dispose(): void {
    this.enabled = false;
    this.targets = [];
    this.baselineDigest = null;
    this.initialized = false;
    this.stopPollingTimer();
    this.detachListeners();
  }

  async handleInspectIndexedDb(
    requestedOrigin: string,
  ): Promise<{ available: boolean; databases: InspectedIndexedDbDatabase[]; reason?: string }> {
    if (requestedOrigin !== this.origin) {
      return { available: false, databases: [], reason: 'origin_mismatch' };
    }
    if (typeof indexedDB === 'undefined') {
      return { available: false, databases: [], reason: 'indexeddb_unavailable' };
    }

    const dbMap = await listExistingDatabaseNames();
    if (!dbMap) {
      return { available: false, databases: [], reason: 'indexeddb_databases_api_unsupported' };
    }

    const databases: InspectedIndexedDbDatabase[] = [];
    for (const dbName of dbMap.keys()) {
      const db = await openExistingDbReadOnly(dbName);
      if (!db) continue;
      try {
        const stores: InspectedIndexedDbStore[] = [];
        for (let i = 0; i < db.objectStoreNames.length; i++) {
          const storeName = db.objectStoreNames.item(i);
          if (!storeName) continue;
          stores.push(await readStoreCountAndSampleBytes(db, storeName));
        }
        const totalEstimatedBytes = stores.reduce((sum, s) => sum + s.estimatedBytes, 0);
        databases.push({
          dbName: db.name,
          version: db.version,
          stores,
          totalEstimatedBytes,
        });
      } finally {
        closeDbSafe(db);
      }
    }

    return { available: true, databases };
  }

  async handleGetIndexedDbRecords(
    requestedOrigin: string,
    targets: IndexedDbTargetRule[],
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  ): Promise<{
    available: boolean;
    quotaExceeded?: boolean;
    totalBytes: number;
    records: IndexedDbCapturedRecord[];
    reason?: string;
  }> {
    if (requestedOrigin !== this.origin) {
      return { available: false, totalBytes: 0, records: [], reason: 'origin_mismatch' };
    }
    if (typeof indexedDB === 'undefined') {
      return { available: false, totalBytes: 0, records: [], reason: 'indexeddb_unavailable' };
    }

    const limit =
      typeof maxTotalBytes === 'number' && Number.isFinite(maxTotalBytes)
        ? Math.max(1024, Math.floor(maxTotalBytes))
        : DEFAULT_MAX_TOTAL_BYTES;

    const existingDbs = await listExistingDatabaseNames();
    const records: IndexedDbCapturedRecord[] = [];
    let totalBytes = 0;
    let quotaExceeded = false;

    for (const target of targets) {
      const dbName = target.dbName?.trim();
      if (!dbName) continue;
      // Never create a phantom v1 database when reading targets
      if (existingDbs !== null && !existingDbs.has(dbName)) {
        continue;
      }

      const db = await openExistingDbReadOnly(dbName);
      if (!db) continue;

      try {
        const availableStores = new Set<string>();
        for (let i = 0; i < db.objectStoreNames.length; i++) {
          const s = db.objectStoreNames.item(i);
          if (s) availableStores.add(s);
        }

        const requestedStores =
          target.objectStores && target.objectStores.length > 0
            ? target.objectStores.filter(s => availableStores.has(s))
            : Array.from(availableStores);

        for (const storeName of requestedStores) {
          const remaining = limit - totalBytes;
          if (remaining <= 0) {
            quotaExceeded = true;
            break;
          }
          const storeRes = await readRecordsFromStore({
            origin: this.origin,
            db,
            storeName,
            keyPrefixes: target.keyPrefixes,
            remainingBytes: remaining,
          });
          records.push(...storeRes.records);
          totalBytes += storeRes.bytesUsed;
          if (storeRes.quotaExceeded) {
            quotaExceeded = true;
            break;
          }
        }
      } finally {
        closeDbSafe(db);
      }

      if (quotaExceeded) break;
    }

    return {
      available: true,
      quotaExceeded: quotaExceeded || undefined,
      totalBytes,
      records,
      reason: quotaExceeded ? 'max_total_bytes_exceeded' : undefined,
    };
  }

  async handleApplyIndexedDbMutations(
    requestedOrigin: string,
    mutations: IndexedDbMutation[],
    clearStores?: Array<{ dbName: string; storeName: string }>,
  ): Promise<{ applied: boolean; reason?: string }> {
    if (requestedOrigin !== this.origin) {
      return { applied: false, reason: 'origin_mismatch' };
    }
    if (typeof indexedDB === 'undefined') {
      return { applied: false, reason: 'indexeddb_unavailable' };
    }

    const clearByDb = new Map<string, Set<string>>();
    for (const item of clearStores ?? []) {
      if (!item.dbName || !item.storeName) continue;
      let set = clearByDb.get(item.dbName);
      if (!set) {
        set = new Set<string>();
        clearByDb.set(item.dbName, set);
      }
      set.add(item.storeName);
    }

    const mutsByDb = new Map<string, IndexedDbMutation[]>();
    for (const mut of mutations) {
      if (!mut.dbName || !mut.storeName) continue;
      let list = mutsByDb.get(mut.dbName);
      if (!list) {
        list = [];
        mutsByDb.set(mut.dbName, list);
      }
      list.push(mut);
    }

    const allDbNames = new Set<string>([...clearByDb.keys(), ...mutsByDb.keys()]);
    if (allDbNames.size === 0) {
      return { applied: true };
    }

    this.suppressUntil = Date.now() + ECHO_SUPPRESSION_TTL_MS;
    const existingDbs = await listExistingDatabaseNames();

    for (const dbName of allDbNames) {
      const dbClearStores = Array.from(clearByDb.get(dbName) ?? []);
      const dbMutations = mutsByDb.get(dbName) ?? [];

      const storeSpecMap = new Map<string, StoreCreateSpec>();
      let requestedVersion = 1;
      let hasNonDeleteMutations = false;

      for (const mut of dbMutations) {
        if (typeof mut.dbVersion === 'number' && Number.isFinite(mut.dbVersion) && mut.dbVersion > requestedVersion) {
          requestedVersion = Math.floor(mut.dbVersion);
        }
        if (!mut.deleted) {
          hasNonDeleteMutations = true;
          if (!storeSpecMap.has(mut.storeName)) {
            storeSpecMap.set(mut.storeName, {
              storeName: mut.storeName,
              keyPath: mut.keyPath,
              autoIncrement: mut.autoIncrement,
            });
          }
        }
      }

      const dbExistsKnown = existingDbs === null ? null : existingDbs.has(dbName);
      if (dbExistsKnown === false && !hasNonDeleteMutations) {
        continue;
      }

      let db: IDBDatabase | null = null;
      try {
        if (dbExistsKnown === false) {
          const opened = await openDbForWrite(dbName, requestedVersion, Array.from(storeSpecMap.values()));
          if (!opened.db) {
            return { applied: false, reason: opened.error ?? 'indexedDB_create_failed' };
          }
          db = opened.db;
        } else {
          // Open at existing version without forcing downgrade/upgrade first
          const opened = await openDbForWrite(dbName, undefined, Array.from(storeSpecMap.values()));
          if (!opened.db) {
            return { applied: false, reason: opened.error ?? 'indexedDB_open_failed' };
          }
          db = opened.db;

          const missingStores = Array.from(storeSpecMap.values()).filter(
            spec => !db!.objectStoreNames.contains(spec.storeName),
          );
          if (missingStores.length > 0) {
            const nextVersion = db.version + 1;
            closeDbSafe(db);
            db = null;
            const upgraded = await openDbForWrite(dbName, nextVersion, missingStores);
            if (!upgraded.db) {
              return { applied: false, reason: upgraded.error ?? 'indexedDB_upgrade_failed' };
            }
            db = upgraded.db;
          }
        }

        const txStores = Array.from(
          new Set(
            [...dbClearStores, ...dbMutations.map(m => m.storeName)].filter(s => db!.objectStoreNames.contains(s)),
          ),
        );
        if (txStores.length === 0) {
          continue;
        }

        await new Promise<void>((resolve, reject) => {
          const tx = db!.transaction(txStores, 'readwrite');
          for (const sName of dbClearStores) {
            if (db!.objectStoreNames.contains(sName)) {
              tx.objectStore(sName).clear();
            }
          }
          for (const mut of dbMutations) {
            if (!db!.objectStoreNames.contains(mut.storeName)) continue;
            const store = tx.objectStore(mut.storeName);
            const decodedKey = decodeIdbKey(mut.encodedKey) as IDBValidKey;
            if (mut.deleted) {
              store.delete(decodedKey);
            } else {
              const decodedValue = mut.encodedValue !== undefined ? decodeTypedValue(mut.encodedValue) : undefined;
              // IndexedDB forbids passing an explicit key argument when store uses in-line keyPath
              if (store.keyPath !== null) {
                store.put(decodedValue);
              } else {
                store.put(decodedValue, decodedKey);
              }
            }
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error('indexedDB_tx_error'));
          tx.onabort = () => reject(tx.error ?? new Error('indexedDB_tx_aborted'));
        });
      } catch (err) {
        return {
          applied: false,
          reason: err instanceof Error ? err.message : 'indexedDB_apply_failed',
        };
      } finally {
        closeDbSafe(db);
      }
    }

    this.suppressUntil = Date.now() + ECHO_SUPPRESSION_TTL_MS;
    if (this.enabled) {
      void this.refreshBaselineDigest();
    }
    return { applied: true };
  }

  async flushOnPageLeaving(): Promise<void> {
    if (!this.enabled) return;
    await this.checkForDigestChanges();
  }

  private async computeCurrentDigest(): Promise<string | null> {
    const snap = await this.handleGetIndexedDbRecords(this.origin, this.targets, this.maxTotalBytes);
    if (!snap.available) return null;

    const sorted = [...snap.records].sort((a, b) => {
      if (a.dbName !== b.dbName) return a.dbName.localeCompare(b.dbName);
      if (a.storeName !== b.storeName) return a.storeName.localeCompare(b.storeName);
      return a.encodedKey.localeCompare(b.encodedKey);
    });

    let hash = 0x811c9dc5;
    for (const rec of sorted) {
      hash = fnv1aDigestUpdate(hash, `${rec.dbName}::${rec.storeName}::${rec.encodedKey}::${rec.encodedValue};`);
    }
    return `${sorted.length}:${hash.toString(16)}`;
  }

  private async refreshBaselineDigest(): Promise<void> {
    if (!this.enabled || this.checkInFlight) return;
    this.checkInFlight = true;
    try {
      this.baselineDigest = await this.computeCurrentDigest();
    } finally {
      this.checkInFlight = false;
    }
  }

  private async checkForDigestChanges(): Promise<void> {
    if (!this.enabled || this.checkInFlight) return;
    if (Date.now() < this.suppressUntil) return;
    if (!isExtensionContextAlive()) {
      this.dispose();
      return;
    }

    this.checkInFlight = true;
    try {
      const nextDigest = await this.computeCurrentDigest();
      if (nextDigest === null) return;
      if (this.baselineDigest === null) {
        this.baselineDigest = nextDigest;
        return;
      }
      if (nextDigest !== this.baselineDigest) {
        this.baselineDigest = nextDigest;
        this.sendToBackground({
          type: 'CONTENT_INDEXED_DB_CHANGED',
          origin: this.origin,
        });
      }
    } finally {
      this.checkInFlight = false;
    }
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

  private attachListeners(): void {
    if (this.listenersAttached) return;
    this.listenersAttached = true;
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    window.addEventListener('pagehide', this.handlePageHide);
  }

  private detachListeners(): void {
    if (!this.listenersAttached) return;
    this.listenersAttached = false;
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    window.removeEventListener('pagehide', this.handlePageHide);
  }

  private readonly handleVisibilityChange = (): void => {
    if (!this.enabled) return;
    this.syncPollingTimer();
    void this.checkForDigestChanges();
  };

  private readonly handlePageHide = (): void => {
    if (!this.enabled) return;
    void this.checkForDigestChanges();
    this.stopPollingTimer();
  };

  private syncPollingTimer(): void {
    if (this.enabled && document.visibilityState === 'visible') {
      if (this.pollTimer === null) {
        this.pollTimer = setInterval(() => {
          if (this.enabled && document.visibilityState === 'visible') {
            void this.checkForDigestChanges();
          }
        }, ACTIVITY_POLL_INTERVAL_MS);
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
