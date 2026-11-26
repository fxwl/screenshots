/**
 * IndexedDB store for Chromium FileSystemDirectoryHandle objects (with in-memory fallback for tests).
 */

export type DirectoryPermissionMode = 'read' | 'readwrite';
export type DirectoryPermissionState = 'granted' | 'denied' | 'prompt';

export interface StoredDirectoryHandle {
  queryPermission?(descriptor?: { mode?: DirectoryPermissionMode }): Promise<DirectoryPermissionState>;
  requestPermission?(descriptor?: { mode?: DirectoryPermissionMode }): Promise<DirectoryPermissionState>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<StoredDirectoryHandle>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<{
    getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; size: number; lastModified: number }>;
    createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }>;
  }>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterableIterator<[string, { kind: 'file' | 'directory'; name?: string }]>;
}

const DEFAULT_DIR_HANDLES_DB = 'sessionmesh_dir_handles';
const DB_VERSION = 1;
const HANDLES_STORE = 'handles';

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('DirHandleStore IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('DirHandleStore IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('DirHandleStore IndexedDB transaction aborted'));
  });
}

export class DirHandleStore {
  private readonly dbName: string;
  private dbPromise: Promise<IDBDatabase> | null = null;
  private useMemoryFallback: boolean;
  private readonly memoryHandles = new Map<string, StoredDirectoryHandle>();

  constructor(dbName = DEFAULT_DIR_HANDLES_DB) {
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
            if (!db.objectStoreNames.contains(HANDLES_STORE)) {
              db.createObjectStore(HANDLES_STORE);
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
            reject(req.error ?? new Error(`Failed to open DirHandleStore IndexedDB "${this.dbName}"`));
          };
        } catch (err) {
          this.dbPromise = null;
          reject(err);
        }
      });
    }

    try {
      return await this.dbPromise;
    } catch {
      this.dbPromise = null;
      this.useMemoryFallback = true;
      return null;
    }
  }

  async saveDirectoryHandle(handleKey: string, handle: StoredDirectoryHandle): Promise<void> {
    if (!handleKey) {
      throw new Error('handleKey must not be empty');
    }
    const db = await this.openDb();
    if (!db) {
      this.memoryHandles.set(handleKey, handle);
      return;
    }
    const tx = db.transaction(HANDLES_STORE, 'readwrite');
    tx.objectStore(HANDLES_STORE).put(handle, handleKey);
    await transactionDone(tx);
  }

  async getDirectoryHandle(handleKey: string): Promise<StoredDirectoryHandle | null> {
    if (!handleKey) return null;
    const db = await this.openDb();
    if (!db) {
      return this.memoryHandles.get(handleKey) ?? null;
    }
    const tx = db.transaction(HANDLES_STORE, 'readonly');
    const result = await requestToPromise<StoredDirectoryHandle | undefined>(
      tx.objectStore(HANDLES_STORE).get(handleKey),
    );
    return result ?? null;
  }

  async deleteDirectoryHandle(handleKey: string): Promise<void> {
    if (!handleKey) return;
    const db = await this.openDb();
    if (!db) {
      this.memoryHandles.delete(handleKey);
      return;
    }
    const tx = db.transaction(HANDLES_STORE, 'readwrite');
    tx.objectStore(HANDLES_STORE).delete(handleKey);
    await transactionDone(tx);
  }

  async listHandleKeys(): Promise<string[]> {
    const db = await this.openDb();
    if (!db) {
      return Array.from(this.memoryHandles.keys());
    }
    const tx = db.transaction(HANDLES_STORE, 'readonly');
    const keys = await requestToPromise<IDBValidKey[]>(tx.objectStore(HANDLES_STORE).getAllKeys());
    return keys.map(k => String(k));
  }

  async checkDirectoryPermission(
    handleKey: string,
    mode: DirectoryPermissionMode = 'readwrite',
  ): Promise<DirectoryPermissionState | 'missing'> {
    const handle = await this.getDirectoryHandle(handleKey);
    if (!handle) return 'missing';
    if (typeof handle.queryPermission === 'function') {
      return handle.queryPermission({ mode });
    }
    return 'granted';
  }

  async requestDirectoryPermission(
    handleKey: string,
    mode: DirectoryPermissionMode = 'readwrite',
  ): Promise<DirectoryPermissionState | 'missing'> {
    const handle = await this.getDirectoryHandle(handleKey);
    if (!handle) return 'missing';
    if (typeof handle.queryPermission === 'function') {
      const current = await handle.queryPermission({ mode });
      if (current === 'granted') return 'granted';
    }
    if (typeof handle.requestPermission === 'function') {
      return handle.requestPermission({ mode });
    }
    if (typeof handle.queryPermission === 'function') {
      return handle.queryPermission({ mode });
    }
    return 'granted';
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

export const defaultDirHandleStore = new DirHandleStore();

export function saveDirectoryHandle(handleKey: string, handle: StoredDirectoryHandle): Promise<void> {
  return defaultDirHandleStore.saveDirectoryHandle(handleKey, handle);
}

export function getDirectoryHandle(handleKey: string): Promise<StoredDirectoryHandle | null> {
  return defaultDirHandleStore.getDirectoryHandle(handleKey);
}

export function deleteDirectoryHandle(handleKey: string): Promise<void> {
  return defaultDirHandleStore.deleteDirectoryHandle(handleKey);
}

export function checkDirectoryPermission(
  handleKey: string,
  mode: DirectoryPermissionMode = 'readwrite',
): Promise<DirectoryPermissionState | 'missing'> {
  return defaultDirHandleStore.checkDirectoryPermission(handleKey, mode);
}

export function requestDirectoryPermission(
  handleKey: string,
  mode: DirectoryPermissionMode = 'readwrite',
): Promise<DirectoryPermissionState | 'missing'> {
  return defaultDirHandleStore.requestDirectoryPermission(handleKey, mode);
}
