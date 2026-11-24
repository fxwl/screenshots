/**
 * Storage area type for persisting and exchanging data.
 * @see https://developer.chrome.com/docs/extensions/reference/storage/#overview
 */
export enum StorageType {
  /**
   * Persist data locally against browser restarts. Will be deleted by uninstalling the extension.
   * @default
   */
  Local = 'local',
  /**
   * Uploads data to the users account in the cloud and syncs to the users browsers on other devices. Limits apply.
   * CRITICAL (Prohibition #17): NEVER store deviceId or device identity in StorageType.Sync!
   */
  Sync = 'sync',
  /**
   * Requires an enterprise policy with a json schema for company wide config.
   */
  Managed = 'managed',
  /**
   * Only persist data until the browser is closed. Recommended for service workers which can shutdown anytime and
   * therefore need to restore their state.
   */
  Session = 'session',
}

/**
 * Global access level requirement for the {@link StorageType.Session} Storage Area.
 */
export enum SessionAccessLevel {
  ExtensionPagesOnly = 'TRUSTED_CONTEXTS',
  ExtensionPagesAndContentScripts = 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
}

type ValueOrUpdate<D> = D | ((prev: D) => Promise<D> | D);

export type BaseStorage<D> = {
  get: () => Promise<D>;
  set: (value: ValueOrUpdate<D>) => Promise<void>;
  getSnapshot: () => D | null;
  subscribe: (listener: () => void) => () => void;
};

export type StorageConfig<D = string> = {
  /**
   * Assign the {@link StorageType} to use.
   * @default StorageType.Local
   */
  storageType?: StorageType;
  /**
   * Only for {@link StorageType.Session}: Grant Content scripts access to storage area?
   * @default false
   */
  sessionAccessForContentScripts?: boolean;
  /**
   * Keeps state live in sync between all instances of the extension (popup, options, side panel, background).
   * @default false
   */
  liveUpdate?: boolean;
  /**
   * Optional serialization helpers for non-native values.
   */
  serialization?: {
    serialize: (value: D) => string;
    deserialize: (text: string) => D;
  };
};

// In-memory fallback map when running outside an extension environment (e.g. Vitest / Node)
const memoryFallbackStore = new Map<string, Map<string, unknown>>();

function getMemoryArea(storageType: StorageType): Map<string, unknown> {
  let area = memoryFallbackStore.get(storageType);
  if (!area) {
    area = new Map<string, unknown>();
    memoryFallbackStore.set(storageType, area);
  }
  return area;
}

function hasChromeStorage(storageType: StorageType): boolean {
  return (
    typeof chrome !== 'undefined' && typeof chrome.storage !== 'undefined' && chrome.storage[storageType] !== undefined
  );
}

async function updateCache<D>(valueOrUpdate: ValueOrUpdate<D>, cache: D | null): Promise<D> {
  if (typeof valueOrUpdate === 'function') {
    return await (valueOrUpdate as (prev: D) => Promise<D> | D)(cache as D);
  }
  return valueOrUpdate;
}

let globalSessionAccessLevelFlag = false;

/**
 * Creates a reactive storage area for persisting and exchanging data.
 * Automatically falls back to in-memory storage in non-extension Node/test contexts.
 */
export function createStorage<D = string>(key: string, fallback: D, config?: StorageConfig<D>): BaseStorage<D> {
  const storageType = config?.storageType ?? StorageType.Local;

  // Enforce Prohibition #17: never allow deviceId keys in chrome.storage.sync
  if (storageType === StorageType.Sync && /device[_-]?id/i.test(key)) {
    throw new Error(`Prohibition #17 violation: key "${key}" must never be stored in chrome.storage.sync`);
  }

  let cache: D | null = null;
  let initedCache = false;
  let listeners: Array<() => void> = [];
  const liveUpdate = config?.liveUpdate ?? false;
  const serialize = config?.serialization?.serialize ?? ((v: D) => v as unknown);
  const deserialize = config?.serialization?.deserialize ?? ((v: unknown) => v as D);

  if (
    globalSessionAccessLevelFlag === false &&
    storageType === StorageType.Session &&
    config?.sessionAccessForContentScripts === true &&
    hasChromeStorage(storageType)
  ) {
    chrome.storage.session
      ?.setAccessLevel?.({
        accessLevel: SessionAccessLevel.ExtensionPagesAndContentScripts,
      })
      .catch(error => {
        console.warn('SessionMesh storage setAccessLevel warning:', error);
      });
    globalSessionAccessLevelFlag = true;
  }

  const _getDataFromStorage = async (): Promise<D> => {
    if (!hasChromeStorage(storageType)) {
      const memArea = getMemoryArea(storageType);
      if (!memArea.has(key)) return fallback;
      const raw = memArea.get(key);
      return raw === undefined ? fallback : deserialize(raw as never);
    }

    const value = await chrome.storage[storageType].get([key]);
    if (value[key] === undefined) {
      return fallback;
    }
    const deserialized = deserialize(value[key] as never);
    return deserialized === undefined ? fallback : deserialized;
  };

  const _emitChange = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        console.error('Storage listener error:', err);
      }
    }
  };

  let writeChain: Promise<void> = Promise.resolve();

  const set = async (valueOrUpdate: ValueOrUpdate<D>): Promise<void> => {
    const run = async () => {
      if (!initedCache) {
        cache = await _getDataFromStorage();
        initedCache = true;
      }
      cache = await updateCache(valueOrUpdate, cache);
      _emitChange();

      const serialized = serialize(cache);
      if (!hasChromeStorage(storageType)) {
        getMemoryArea(storageType).set(key, serialized);
        return;
      }
      await chrome.storage[storageType].set({ [key]: serialized });
    };

    const next = writeChain.then(run, run);
    writeChain = next.catch(() => undefined);
    await next;
  };

  const subscribe = (listener: () => void) => {
    listeners = [...listeners, listener];
    return () => {
      listeners = listeners.filter(l => l !== listener);
    };
  };

  const getSnapshot = () => cache;

  // Prime cache asynchronously without throwing unhandled rejections
  _getDataFromStorage()
    .then(data => {
      if (!initedCache) {
        cache = data;
        initedCache = true;
        _emitChange();
      }
    })
    .catch(() => {
      if (!initedCache) {
        cache = fallback;
        initedCache = true;
        _emitChange();
      }
    });

  if (liveUpdate && hasChromeStorage(storageType) && chrome.storage[storageType]?.onChanged) {
    chrome.storage[storageType].onChanged.addListener((changes: { [k: string]: chrome.storage.StorageChange }) => {
      if (changes[key] === undefined) return;
      const rawNew = changes[key].newValue;
      const nextVal = rawNew === undefined ? fallback : deserialize(rawNew as never);
      if (Object.is(cache, nextVal)) return;
      cache = nextVal;
      initedCache = true;
      _emitChange();
    });
  }

  return {
    get: _getDataFromStorage,
    set,
    getSnapshot,
    subscribe,
  };
}
