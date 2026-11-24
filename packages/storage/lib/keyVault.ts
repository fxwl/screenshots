/**
 * NonExtractableKeyVault
 *
 * Protects each SyncSpace's DEK (Data Encryption Key) at rest WITHOUT storing
 * the user's plaintext encryption password on disk:
 * - Generates a local AES-256-GCM CryptoKey with `extractable: false` and persists
 *   the opaque key handle in IndexedDB via structured clone.
 * - Wraps each space's `dekBase64` with AES-256-GCM + AAD bound to `spaceId`, allowing
 *   MV3 Service Workers to seamlessly unwrap the DEK after 30s idle restarts.
 * - When `sessionLockEnabled` is true, wrapped DEKs are stored EXCLUSIVELY in
 *   `chrome.storage.session` (wiped automatically on browser close) and never persisted
 *   in IndexedDB's `wrapped_deks` store, requiring master password re-entry on next launch.
 */

const VAULT_DB_NAME = 'sessionmesh_vault';
const VAULT_DB_VERSION = 1;
const WRAPPING_KEYS_STORE = 'wrapping_keys';
const WRAPPED_DEKS_STORE = 'wrapped_deks';
const LOCAL_KEK_ID = 'local_kek';

const SESSION_DEKS_STORAGE_KEY = 'sessionmesh_vault_session_deks';
const SESSION_LOCK_CONFIG_KEY = 'sessionmesh_vault_session_lock_enabled';

interface WrappedDekRecord {
  spaceId: string;
  iv: number[];
  ciphertext: number[];
  updatedAt: number;
}

export interface KeyVaultOptions {
  dbName?: string;
  initialSessionLockEnabled?: boolean;
}

function reqPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Vault IndexedDB request failed'));
  });
}

function txPromise(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Vault IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('Vault IndexedDB transaction aborted'));
  });
}

function hasChromeSessionStorage(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.storage !== 'undefined' && chrome.storage.session !== undefined;
}

function hasChromeLocalStorage(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.storage !== 'undefined' && chrome.storage.local !== undefined;
}

export class NonExtractableKeyVault {
  private readonly dbName: string;
  private dbPromise: Promise<IDBDatabase> | null = null;
  private useMemoryFallback: boolean;
  private cachedKek: CryptoKey | null = null;
  private kekInitPromise: Promise<CryptoKey> | null = null;
  private sessionLockOverride: boolean | undefined;

  // Fallbacks for Node / environments lacking IndexedDB or chrome.storage.session
  private readonly memoryWrappedDeks = new Map<string, WrappedDekRecord>();
  private readonly memorySessionDeks = new Map<string, WrappedDekRecord>();
  private memorySessionLockFlag = false;

  constructor(options?: KeyVaultOptions) {
    this.dbName = options?.dbName ?? VAULT_DB_NAME;
    this.useMemoryFallback = typeof indexedDB === 'undefined';
    if (options?.initialSessionLockEnabled !== undefined) {
      this.sessionLockOverride = options.initialSessionLockEnabled;
      this.memorySessionLockFlag = options.initialSessionLockEnabled;
    }
  }

  private async openDb(): Promise<IDBDatabase | null> {
    if (this.useMemoryFallback || typeof indexedDB === 'undefined') {
      this.useMemoryFallback = true;
      return null;
    }

    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        try {
          const req = indexedDB.open(this.dbName, VAULT_DB_VERSION);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(WRAPPING_KEYS_STORE)) {
              db.createObjectStore(WRAPPING_KEYS_STORE);
            }
            if (!db.objectStoreNames.contains(WRAPPED_DEKS_STORE)) {
              db.createObjectStore(WRAPPED_DEKS_STORE, { keyPath: 'spaceId' });
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
            reject(req.error ?? new Error(`Failed to open vault IndexedDB "${this.dbName}"`));
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

  private async getOrCreateLocalKek(): Promise<CryptoKey> {
    if (this.cachedKek) return this.cachedKek;
    if (this.kekInitPromise) return this.kekInitPromise;

    this.kekInitPromise = (async () => {
      const db = await this.openDb();
      if (db) {
        const readTx = db.transaction(WRAPPING_KEYS_STORE, 'readonly');
        const existing = await reqPromise<CryptoKey | undefined>(
          readTx.objectStore(WRAPPING_KEYS_STORE).get(LOCAL_KEK_ID),
        );
        if (existing) {
          this.cachedKek = existing;
          return existing;
        }
      }

      // Generate a non-extractable AES-256-GCM key (extractable: false!)
      const generated = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]);

      if (db) {
        const writeTx = db.transaction(WRAPPING_KEYS_STORE, 'readwrite');
        writeTx.objectStore(WRAPPING_KEYS_STORE).put(generated, LOCAL_KEK_ID);
        await txPromise(writeTx);
      }

      this.cachedKek = generated;
      return generated;
    })();

    try {
      return await this.kekInitPromise;
    } finally {
      this.kekInitPromise = null;
    }
  }

  private async wrapDek(spaceId: string, dekBase64: string): Promise<WrappedDekRecord> {
    const kek = await this.getOrCreateLocalKek();
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(dekBase64);
    const aad = new TextEncoder().encode(`sessionmesh-vault|${spaceId}`);

    const encrypted = await globalThis.crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: aad,
      },
      kek,
      plaintext,
    );

    return {
      spaceId,
      iv: Array.from(iv),
      ciphertext: Array.from(new Uint8Array(encrypted)),
      updatedAt: Date.now(),
    };
  }

  private async unwrapDek(spaceId: string, record: WrappedDekRecord): Promise<string | null> {
    try {
      const kek = await this.getOrCreateLocalKek();
      const iv = new Uint8Array(record.iv);
      const ciphertext = new Uint8Array(record.ciphertext);
      const aad = new TextEncoder().encode(`sessionmesh-vault|${spaceId}`);

      const decrypted = await globalThis.crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData: aad,
        },
        kek,
        ciphertext,
      );
      return new TextDecoder().decode(decrypted);
    } catch {
      return null;
    }
  }

  private async readSessionMap(): Promise<Record<string, WrappedDekRecord>> {
    if (hasChromeSessionStorage()) {
      const res = await chrome.storage.session.get([SESSION_DEKS_STORAGE_KEY]);
      const map = res[SESSION_DEKS_STORAGE_KEY];
      if (map && typeof map === 'object') {
        return { ...(map as Record<string, WrappedDekRecord>) };
      }
      return {};
    }
    const out: Record<string, WrappedDekRecord> = {};
    for (const [k, v] of this.memorySessionDeks.entries()) {
      out[k] = v;
    }
    return out;
  }

  private async writeSessionMap(map: Record<string, WrappedDekRecord>): Promise<void> {
    if (hasChromeSessionStorage()) {
      await chrome.storage.session.set({ [SESSION_DEKS_STORAGE_KEY]: map });
      return;
    }
    this.memorySessionDeks.clear();
    for (const [k, v] of Object.entries(map)) {
      this.memorySessionDeks.set(k, v);
    }
  }

  private async readPersistentDek(spaceId: string): Promise<WrappedDekRecord | undefined> {
    const db = await this.openDb();
    if (!db) {
      return this.memoryWrappedDeks.get(spaceId);
    }
    const tx = db.transaction(WRAPPED_DEKS_STORE, 'readonly');
    return reqPromise<WrappedDekRecord | undefined>(tx.objectStore(WRAPPED_DEKS_STORE).get(spaceId));
  }

  private async readAllPersistentDeks(): Promise<WrappedDekRecord[]> {
    const db = await this.openDb();
    if (!db) {
      return Array.from(this.memoryWrappedDeks.values());
    }
    const tx = db.transaction(WRAPPED_DEKS_STORE, 'readonly');
    return reqPromise<WrappedDekRecord[]>(tx.objectStore(WRAPPED_DEKS_STORE).getAll());
  }

  private async writePersistentDek(record: WrappedDekRecord): Promise<void> {
    const db = await this.openDb();
    if (!db) {
      this.memoryWrappedDeks.set(record.spaceId, record);
      return;
    }
    const tx = db.transaction(WRAPPED_DEKS_STORE, 'readwrite');
    tx.objectStore(WRAPPED_DEKS_STORE).put(record);
    await txPromise(tx);
  }

  private async deletePersistentDek(spaceId: string): Promise<void> {
    const db = await this.openDb();
    if (!db) {
      this.memoryWrappedDeks.delete(spaceId);
      return;
    }
    const tx = db.transaction(WRAPPED_DEKS_STORE, 'readwrite');
    tx.objectStore(WRAPPED_DEKS_STORE).delete(spaceId);
    await txPromise(tx);
  }

  private async clearAllPersistentDeks(): Promise<void> {
    const db = await this.openDb();
    if (!db) {
      this.memoryWrappedDeks.clear();
      return;
    }
    const tx = db.transaction(WRAPPED_DEKS_STORE, 'readwrite');
    tx.objectStore(WRAPPED_DEKS_STORE).clear();
    await txPromise(tx);
  }

  async isSessionLockEnabled(): Promise<boolean> {
    if (this.sessionLockOverride !== undefined) {
      return this.sessionLockOverride;
    }
    if (hasChromeLocalStorage()) {
      const res = await chrome.storage.local.get([SESSION_LOCK_CONFIG_KEY]);
      return Boolean(res[SESSION_LOCK_CONFIG_KEY]);
    }
    return this.memorySessionLockFlag;
  }

  /**
   * Toggle session-only lock mode:
   * - When enabled (`true`), clears persistent wrapped DEKs from IndexedDB (keeping
   *   active DEKs in `chrome.storage.session` until browser closes).
   * - When disabled (`false`), persists any active session DEKs back to IndexedDB.
   */
  async setSessionLockEnabled(enabled: boolean): Promise<void> {
    this.sessionLockOverride = enabled;
    this.memorySessionLockFlag = enabled;
    if (hasChromeLocalStorage()) {
      await chrome.storage.local.set({ [SESSION_LOCK_CONFIG_KEY]: enabled });
    }

    if (enabled) {
      // Preserve active DEKs in chrome.storage.session for the rest of this browser session,
      // then wipe IndexedDB persistent wrapped_deks so next browser launch requires password.
      const persistent = await this.readAllPersistentDeks();
      if (persistent.length > 0) {
        const sessionMap = await this.readSessionMap();
        for (const rec of persistent) {
          if (!sessionMap[rec.spaceId]) {
            sessionMap[rec.spaceId] = rec;
          }
        }
        await this.writeSessionMap(sessionMap);
      }
      await this.clearAllPersistentDeks();
    } else {
      // Persist any currently cached session DEKs into IndexedDB
      const sessionMap = await this.readSessionMap();
      for (const rec of Object.values(sessionMap)) {
        await this.writePersistentDek(rec);
      }
    }
  }

  async saveDek(spaceId: string, dekBase64: string): Promise<void> {
    const wrapped = await this.wrapDek(spaceId, dekBase64);
    const sessionLock = await this.isSessionLockEnabled();

    // Always update session cache so MV3 SW restarts within same browser session are instant
    const sessionMap = await this.readSessionMap();
    sessionMap[spaceId] = wrapped;
    await this.writeSessionMap(sessionMap);

    if (sessionLock) {
      // Strictly avoid persisting to disk when sessionLockEnabled is true
      await this.deletePersistentDek(spaceId);
    } else {
      await this.writePersistentDek(wrapped);
    }
  }

  async loadDek(spaceId: string): Promise<string | null> {
    const sessionLock = await this.isSessionLockEnabled();

    // 1. Check chrome.storage.session first
    const sessionMap = await this.readSessionMap();
    const sessionRec = sessionMap[spaceId];
    if (sessionRec) {
      const dek = await this.unwrapDek(spaceId, sessionRec);
      if (dek) return dek;
    }

    // 2. When sessionLockEnabled is true, NEVER read from persistent IndexedDB!
    if (sessionLock) {
      return null;
    }

    // 3. Fall back to persistent IndexedDB wrapped_deks (auto-unwrap across browser restarts)
    const persistentRec = await this.readPersistentDek(spaceId);
    if (!persistentRec) {
      return null;
    }
    const dek = await this.unwrapDek(spaceId, persistentRec);
    if (dek) {
      // Warm session cache
      sessionMap[spaceId] = persistentRec;
      await this.writeSessionMap(sessionMap).catch(() => undefined);
    }
    return dek;
  }

  async clearDek(spaceId: string): Promise<void> {
    const sessionMap = await this.readSessionMap();
    if (spaceId in sessionMap) {
      delete sessionMap[spaceId];
      await this.writeSessionMap(sessionMap);
    }
    await this.deletePersistentDek(spaceId);
  }

  async clearAllDeks(): Promise<void> {
    await this.writeSessionMap({});
    await this.clearAllPersistentDeks();
  }
}
