import type { StorageBackend } from '@sessionmesh/core';

interface KvRecord {
  namespace: string;
  key: string;
  value: unknown;
}

const DEFAULT_DB_NAME = 'sessionmesh_db';
const DB_VERSION = 1;
const STORE_NAME = 'kv';
const NAMESPACE_INDEX = 'by_namespace';

function safeClone<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') {
    return value;
  }
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // fallback below
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * IndexedDBStorageBackend implements @sessionmesh/core's StorageBackend with
 * strict namespace isolation (suitable for multi-space persistence & large MV3 queues)
 * and automatic in-memory fallback when IndexedDB is unavailable (e.g. Node unit tests).
 */
export class IndexedDBStorageBackend implements StorageBackend {
  private readonly dbName: string;
  private dbPromise: Promise<IDBDatabase> | null = null;
  private useMemoryFallback: boolean;
  private readonly memory = new Map<string, Map<string, unknown>>();

  constructor(dbName = DEFAULT_DB_NAME) {
    this.dbName = dbName;
    this.useMemoryFallback = typeof indexedDB === 'undefined';
  }

  private async openDb(): Promise<IDBDatabase | null> {
    if (this.useMemoryFallback || typeof indexedDB === 'undefined') {
      this.useMemoryFallback = true;
      return null;
    }

    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        try {
          const req = indexedDB.open(this.dbName, DB_VERSION);
          req.onupgradeneeded = () => {
            const db = req.result;
            let store: IDBObjectStore;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
              store = db.createObjectStore(STORE_NAME, { keyPath: ['namespace', 'key'] });
            } else {
              store = req.transaction!.objectStore(STORE_NAME);
            }
            if (!store.indexNames.contains(NAMESPACE_INDEX)) {
              store.createIndex(NAMESPACE_INDEX, 'namespace', { unique: false });
            }
          };
          req.onsuccess = () => {
            const db = req.result;
            db.onversionchange = () => {
              db.close();
              this.dbPromise = null;
            };
            db.onclose = () => {
              this.dbPromise = null;
            };
            resolve(db);
          };
          req.onerror = () => {
            this.dbPromise = null;
            reject(req.error ?? new Error(`Failed to open IndexedDB "${this.dbName}"`));
          };
          req.onblocked = () => {
            console.warn(`SessionMesh IndexedDB "${this.dbName}" open blocked by another connection`);
          };
        } catch (err) {
          this.dbPromise = null;
          reject(err);
        }
      });
    }

    try {
      return await this.dbPromise;
    } catch (err) {
      console.warn('IndexedDB unavailable, falling back to in-memory storage:', err);
      this.dbPromise = null;
      this.useMemoryFallback = true;
      return null;
    }
  }

  async get<T>(namespace: string, key: string): Promise<T | undefined> {
    const db = await this.openDb();
    if (!db) {
      const val = this.memory.get(namespace)?.get(key);
      return val === undefined ? undefined : safeClone(val as T);
    }

    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const rec = await requestToPromise<KvRecord | undefined>(store.get([namespace, key]));
    return rec ? (rec.value as T) : undefined;
  }

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    const db = await this.openDb();
    if (!db) {
      let nsMap = this.memory.get(namespace);
      if (!nsMap) {
        nsMap = new Map<string, unknown>();
        this.memory.set(namespace, nsMap);
      }
      nsMap.set(key, safeClone(value));
      return;
    }

    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const record: KvRecord = { namespace, key, value };
    store.put(record);
    await transactionDone(tx);
  }

  async delete(namespace: string, key: string): Promise<void> {
    const db = await this.openDb();
    if (!db) {
      this.memory.get(namespace)?.delete(key);
      return;
    }

    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete([namespace, key]);
    await transactionDone(tx);
  }

  async getAll<T>(namespace: string, prefix?: string): Promise<Record<string, T>> {
    const db = await this.openDb();
    if (!db) {
      const result: Record<string, T> = {};
      const nsMap = this.memory.get(namespace);
      if (!nsMap) return result;
      for (const [k, v] of nsMap.entries()) {
        if (!prefix || k.startsWith(prefix)) {
          result[k] = safeClone(v as T);
        }
      }
      return result;
    }

    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index(NAMESPACE_INDEX);
    const records = await requestToPromise<KvRecord[]>(index.getAll(IDBKeyRange.only(namespace)));

    const result: Record<string, T> = {};
    for (const rec of records) {
      if (!prefix || rec.key.startsWith(prefix)) {
        result[rec.key] = rec.value as T;
      }
    }
    return result;
  }

  async clearNamespace(namespace: string): Promise<void> {
    const db = await this.openDb();
    if (!db) {
      this.memory.delete(namespace);
      return;
    }

    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index(NAMESPACE_INDEX);

    await new Promise<void>((resolve, reject) => {
      const cursorReq = index.openKeyCursor(IDBKeyRange.only(namespace));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        } else {
          resolve();
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error ?? new Error('Failed to clear namespace'));
    });

    await transactionDone(tx);
  }

  async close(): Promise<void> {
    if (this.dbPromise) {
      try {
        const db = await this.dbPromise;
        db.close();
      } catch {
        // ignore close errors
      }
      this.dbPromise = null;
    }
  }
}
