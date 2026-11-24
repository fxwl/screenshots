import type { BaseStorage } from '@sessionmesh/storage';
import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Non-suspending reactive hook for any BaseStorage<Data>.
 * Immediately reads cached snapshots and updates on cross-context liveUpdate changes.
 */
export function useStorage<
  Storage extends BaseStorage<Data>,
  Data = Storage extends BaseStorage<infer D> ? D : unknown,
>(storage: Storage): Data | null {
  const snapshot = useSyncExternalStore<Data | null>(storage.subscribe, storage.getSnapshot, storage.getSnapshot);
  const [asyncValue, setAsyncValue] = useState<Data | null>(snapshot);

  useEffect(() => {
    let mounted = true;
    if (snapshot === null) {
      storage
        .get()
        .then(val => {
          if (mounted) {
            setAsyncValue(val);
          }
        })
        .catch(() => undefined);
    } else {
      setAsyncValue(snapshot);
    }
    return () => {
      mounted = false;
    };
  }, [storage, snapshot]);

  return snapshot ?? asyncValue;
}
