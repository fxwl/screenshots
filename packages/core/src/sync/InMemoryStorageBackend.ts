import type { StorageBackend } from '../types';

function deepClone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export class InMemoryStorageBackend implements StorageBackend {
  private readonly namespaces = new Map<string, Map<string, unknown>>();

  private getNs(namespace: string): Map<string, unknown> {
    let map = this.namespaces.get(namespace);
    if (!map) {
      map = new Map<string, unknown>();
      this.namespaces.set(namespace, map);
    }
    return map;
  }

  async get<T>(namespace: string, key: string): Promise<T | undefined> {
    const map = this.namespaces.get(namespace);
    if (!map || !map.has(key)) return undefined;
    return deepClone(map.get(key) as T);
  }

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    this.getNs(namespace).set(key, deepClone(value));
  }

  async delete(namespace: string, key: string): Promise<void> {
    this.namespaces.get(namespace)?.delete(key);
  }

  async getAll<T>(namespace: string, prefix?: string): Promise<Record<string, T>> {
    const map = this.namespaces.get(namespace);
    const out: Record<string, T> = {};
    if (!map) return out;
    for (const [k, v] of map.entries()) {
      if (!prefix || k.startsWith(prefix)) {
        out[k] = deepClone(v as T);
      }
    }
    return out;
  }

  async clearNamespace(namespace: string): Promise<void> {
    this.namespaces.delete(namespace);
  }

  /**
   * Creates an independent deep copy of the entire storage state (useful for testing/cloning).
   */
  clone(): InMemoryStorageBackend {
    const copy = new InMemoryStorageBackend();
    for (const [ns, map] of this.namespaces.entries()) {
      const target = copy.getNs(ns);
      for (const [k, v] of map.entries()) {
        target.set(k, deepClone(v));
      }
    }
    return copy;
  }
}
