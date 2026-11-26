/**
 * Browser-safe IndexedDB helper matching `@sessionmesh/storage` `DirHandleStore`
 * DB name (`sessionmesh_dir_handles`), version (1), and object store (`handles`).
 */

export type DirectoryPermissionMode = 'read' | 'readwrite';
export type DirectoryPermissionState = 'granted' | 'denied' | 'prompt';

export interface FileSystemDirectoryHandleWithPermission {
  readonly kind?: 'directory';
  readonly name: string;
  queryPermission?(descriptor?: { mode?: DirectoryPermissionMode }): Promise<DirectoryPermissionState>;
  requestPermission?(descriptor?: { mode?: DirectoryPermissionMode }): Promise<DirectoryPermissionState>;
}

const DIR_HANDLES_DB = 'sessionmesh_dir_handles';
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

async function openDirHandlesDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('当前环境不支持 IndexedDB，无法持久化本地目录句柄');
  }
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DIR_HANDLES_DB, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HANDLES_STORE)) {
        db.createObjectStore(HANDLES_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error(`无法打开 IndexedDB "${DIR_HANDLES_DB}"`));
  });
}

export function isDirectoryPickerSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
  );
}

export async function saveLocalDirectoryHandle(
  handleKey: string,
  handle: FileSystemDirectoryHandleWithPermission,
): Promise<void> {
  if (!handleKey) {
    throw new Error('handleKey 不能为空');
  }
  const db = await openDirHandlesDb();
  try {
    const tx = db.transaction(HANDLES_STORE, 'readwrite');
    tx.objectStore(HANDLES_STORE).put(handle, handleKey);
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

export async function getLocalDirectoryHandle(
  handleKey: string,
): Promise<FileSystemDirectoryHandleWithPermission | null> {
  if (!handleKey) return null;
  const db = await openDirHandlesDb();
  try {
    const tx = db.transaction(HANDLES_STORE, 'readonly');
    const result = await requestToPromise<FileSystemDirectoryHandleWithPermission | undefined>(
      tx.objectStore(HANDLES_STORE).get(handleKey),
    );
    return result ?? null;
  } finally {
    db.close();
  }
}

export async function queryLocalDirectoryPermission(
  handleKey: string,
  mode: DirectoryPermissionMode = 'readwrite',
): Promise<DirectoryPermissionState | 'missing'> {
  try {
    const handle = await getLocalDirectoryHandle(handleKey);
    if (!handle) return 'missing';
    if (typeof handle.queryPermission === 'function') {
      return await handle.queryPermission({ mode });
    }
    return 'granted';
  } catch {
    return 'missing';
  }
}

export async function requestLocalDirectoryPermission(
  handleKey: string,
  mode: DirectoryPermissionMode = 'readwrite',
): Promise<DirectoryPermissionState | 'missing'> {
  const handle = await getLocalDirectoryHandle(handleKey);
  if (!handle) return 'missing';
  if (typeof handle.queryPermission === 'function') {
    const current = await handle.queryPermission({ mode });
    if (current === 'granted') return 'granted';
  }
  if (typeof handle.requestPermission === 'function') {
    return await handle.requestPermission({ mode });
  }
  if (typeof handle.queryPermission === 'function') {
    return await handle.queryPermission({ mode });
  }
  return 'granted';
}

export function generateLocalDirectoryHandleKey(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `smesh-dir-${crypto.randomUUID().slice(0, 12)}`;
    }
  } catch {
    // fallback below
  }
  return `smesh-dir-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function pickAndStoreLocalDirectory(existingHandleKey?: string): Promise<{
  handleKey: string;
  directoryLabel: string;
  permissionState: DirectoryPermissionState;
}> {
  if (!isDirectoryPickerSupported()) {
    throw new Error('当前浏览器不支持 File System Access API (showDirectoryPicker)');
  }
  const picker = (
    window as unknown as {
      showDirectoryPicker: (options?: {
        mode?: DirectoryPermissionMode;
      }) => Promise<FileSystemDirectoryHandleWithPermission>;
    }
  ).showDirectoryPicker;

  const handle = await picker({ mode: 'readwrite' });
  const handleKey = existingHandleKey?.trim() || generateLocalDirectoryHandleKey();
  await saveLocalDirectoryHandle(handleKey, handle);

  let permissionState: DirectoryPermissionState = 'granted';
  if (typeof handle.queryPermission === 'function') {
    permissionState = await handle.queryPermission({ mode: 'readwrite' });
  }
  if (permissionState !== 'granted' && typeof handle.requestPermission === 'function') {
    permissionState = await handle.requestPermission({ mode: 'readwrite' });
  }

  return {
    handleKey,
    directoryLabel: handle.name || '已选同步文件夹',
    permissionState,
  };
}
