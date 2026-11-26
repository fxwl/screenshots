import { afterEach, describe, expect, it } from 'vitest';
import { MockWebDAVServer } from '@sessionmesh/webdav-mock';
import { DirHandleStore } from '../../storage/lib/dirHandleStore';
import { decodeSessionShare, encodeSessionShare } from '../src/crypto/sessionShare';
import { encodeIdbKey, encodeTypedValue, sha256Hex } from '../src/crypto';
import { SimulatedBrowserDevice } from '../src/sim';
import type { VirtualDirectoryHandle } from '../src/storage-providers';
import { InMemoryStorageBackend, SyncEngine } from '../src/sync';
import type {
  IndexedDbMutation,
  IndexedDbRecord,
  IndexedDbTargetRule,
  InspectedIndexedDbDatabase,
  S3StorageConfig,
  StorageProviderConfig,
  WebDAVConfig,
} from '../src/types';

const ENC_PASS = 'v13-MasterPassphrase!2026';

// ============================================================================
// Simulated Browser with Extended Storage (sessionStorage + IndexedDB + Quota)
// ============================================================================

interface SimIdbRecord {
  encodedKey: string;
  encodedValue: string;
  byteLength: number;
}

interface SimIdbStore {
  dbVersion: number;
  keyPath?: string | string[] | null;
  autoIncrement?: boolean;
  records: Map<string, SimIdbRecord>;
}

class SimulatedV13BrowserDevice extends SimulatedBrowserDevice {
  private readonly sessionStorageByOrigin = new Map<string, Map<string, string>>();
  private readonly idbByOrigin = new Map<string, Map<string, SimIdbStore>>();

  private async hasOpenContext(origin: string): Promise<boolean> {
    const lsCheck = await this.getLocalStorage(origin);
    return lsCheck.available;
  }

  async getSessionStorage(origin: string): Promise<{ available: boolean; items: Record<string, string> }> {
    let norm: string;
    try {
      norm = new URL(origin).origin;
    } catch {
      return { available: false, items: {} };
    }
    if (!(await this.hasOpenContext(norm))) {
      return { available: false, items: {} };
    }
    const store = this.sessionStorageByOrigin.get(norm);
    const items: Record<string, string> = {};
    if (store) {
      for (const [k, v] of store.entries()) items[k] = v;
    }
    return { available: true, items };
  }

  async applySessionStorage(
    origin: string,
    mutations: Array<{ key: string; value?: string; deleted?: boolean }>,
  ): Promise<{ applied: boolean; reason?: string }> {
    let norm: string;
    try {
      norm = new URL(origin).origin;
    } catch {
      return { applied: false, reason: 'Invalid origin' };
    }
    if (!(await this.hasOpenContext(norm))) {
      return { applied: false, reason: 'No open tab/context for origin' };
    }
    let store = this.sessionStorageByOrigin.get(norm);
    if (!store) {
      store = new Map<string, string>();
      this.sessionStorageByOrigin.set(norm, store);
    }
    for (const m of mutations) {
      if (m.deleted) store.delete(m.key);
      else store.set(m.key, m.value ?? '');
    }
    return { applied: true };
  }

  seedSessionStorage(origin: string, items: Record<string, string>): void {
    const norm = new URL(origin).origin;
    let store = this.sessionStorageByOrigin.get(norm);
    if (!store) {
      store = new Map<string, string>();
      this.sessionStorageByOrigin.set(norm, store);
    }
    for (const [k, v] of Object.entries(items)) store.set(k, v);
  }

  seedIndexedDbRecord(
    origin: string,
    entry: {
      dbName: string;
      dbVersion?: number;
      storeName: string;
      keyPath?: string | string[] | null;
      autoIncrement?: boolean;
      encodedKey: string;
      encodedValue: string;
      byteLength?: number;
    },
  ): void {
    const norm = new URL(origin).origin;
    let originMap = this.idbByOrigin.get(norm);
    if (!originMap) {
      originMap = new Map();
      this.idbByOrigin.set(norm, originMap);
    }
    const storeKey = `${entry.dbName}::${entry.storeName}`;
    let store = originMap.get(storeKey);
    if (!store) {
      store = {
        dbVersion: entry.dbVersion ?? 1,
        keyPath: entry.keyPath ?? null,
        autoIncrement: entry.autoIncrement ?? false,
        records: new Map(),
      };
      originMap.set(storeKey, store);
    }
    store.records.set(entry.encodedKey, {
      encodedKey: entry.encodedKey,
      encodedValue: entry.encodedValue,
      byteLength: entry.byteLength ?? entry.encodedKey.length + entry.encodedValue.length,
    });
  }

  getRawIndexedDbRecords(origin: string, dbName: string, storeName: string): SimIdbRecord[] {
    const norm = new URL(origin).origin;
    const store = this.idbByOrigin.get(norm)?.get(`${dbName}::${storeName}`);
    return store ? Array.from(store.records.values()) : [];
  }

  async inspectIndexedDb(
    origin: string,
  ): Promise<{ available: boolean; databases: InspectedIndexedDbDatabase[]; reason?: string }> {
    let norm: string;
    try {
      norm = new URL(origin).origin;
    } catch {
      return { available: false, databases: [], reason: 'Invalid origin' };
    }
    if (!(await this.hasOpenContext(norm))) {
      return { available: false, databases: [], reason: 'No open context' };
    }
    const originMap = this.idbByOrigin.get(norm);
    if (!originMap) return { available: true, databases: [] };
    const dbMap = new Map<string, InspectedIndexedDbDatabase>();
    for (const [key, store] of originMap.entries()) {
      const [dbName, storeName] = key.split('::');
      let db = dbMap.get(dbName);
      if (!db) {
        db = { dbName, version: store.dbVersion, stores: [], totalEstimatedBytes: 0 };
        dbMap.set(dbName, db);
      }
      let storeBytes = 0;
      for (const rec of store.records.values()) storeBytes += rec.byteLength;
      db.stores.push({
        name: storeName,
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        recordCount: store.records.size,
        estimatedBytes: storeBytes,
      });
      db.totalEstimatedBytes += storeBytes;
    }
    return { available: true, databases: Array.from(dbMap.values()) };
  }

  async getIndexedDbRecords(
    origin: string,
    targets: IndexedDbTargetRule[],
    maxTotalBytes = 1_048_576,
  ): Promise<{
    available: boolean;
    quotaExceeded?: boolean;
    totalBytes: number;
    records: Array<
      Omit<
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
      >
    >;
    reason?: string;
  }> {
    let norm: string;
    try {
      norm = new URL(origin).origin;
    } catch {
      return { available: false, totalBytes: 0, records: [], reason: 'Invalid origin' };
    }
    if (!(await this.hasOpenContext(norm))) {
      return { available: false, totalBytes: 0, records: [], reason: 'No open context' };
    }
    const originMap = this.idbByOrigin.get(norm);
    if (!originMap) return { available: true, totalBytes: 0, records: [] };

    const out: Array<
      Omit<
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
      >
    > = [];
    let totalBytes = 0;

    for (const [pairKey, store] of originMap.entries()) {
      const [dbName, storeName] = pairKey.split('::');
      const rule = targets.find((t) => t.dbName === dbName);
      if (!rule) continue;
      if (rule.objectStores && rule.objectStores.length > 0 && !rule.objectStores.includes(storeName)) {
        continue;
      }
      for (const rec of store.records.values()) {
        if (
          rule.keyPrefixes &&
          rule.keyPrefixes.length > 0 &&
          !rule.keyPrefixes.some((p) => rec.encodedKey.includes(p))
        ) {
          continue;
        }
        totalBytes += rec.byteLength;
        out.push({
          origin: norm,
          dbName,
          dbVersion: store.dbVersion,
          storeName,
          keyPath: store.keyPath,
          autoIncrement: store.autoIncrement,
          encodedKey: rec.encodedKey,
          encodedValue: rec.encodedValue,
          byteLength: rec.byteLength,
        });
      }
    }

    if (totalBytes > maxTotalBytes) {
      return { available: true, quotaExceeded: true, totalBytes, records: [] };
    }
    return { available: true, totalBytes, records: out };
  }

  async applyIndexedDbMutations(
    origin: string,
    mutations: IndexedDbMutation[],
    clearStores?: Array<{ dbName: string; storeName: string }>,
  ): Promise<{ applied: boolean; reason?: string }> {
    let norm: string;
    try {
      norm = new URL(origin).origin;
    } catch {
      return { applied: false, reason: 'Invalid origin' };
    }
    if (!(await this.hasOpenContext(norm))) {
      return { applied: false, reason: 'No open context' };
    }
    let originMap = this.idbByOrigin.get(norm);
    if (!originMap) {
      originMap = new Map();
      this.idbByOrigin.set(norm, originMap);
    }
    for (const cs of clearStores ?? []) {
      const st = originMap.get(`${cs.dbName}::${cs.storeName}`);
      if (st) st.records.clear();
    }
    for (const m of mutations) {
      const key = `${m.dbName}::${m.storeName}`;
      let st = originMap.get(key);
      if (!st) {
        st = {
          dbVersion: m.dbVersion ?? 1,
          keyPath: m.keyPath ?? null,
          autoIncrement: m.autoIncrement ?? false,
          records: new Map(),
        };
        originMap.set(key, st);
      }
      if (m.deleted) {
        st.records.delete(m.encodedKey);
      } else {
        const val = m.encodedValue ?? '';
        st.records.set(m.encodedKey, {
          encodedKey: m.encodedKey,
          encodedValue: val,
          byteLength: m.encodedKey.length + val.length,
        });
      }
    }
    return { applied: true };
  }
}

// ============================================================================
// Mock S3, Mock GitHub Gist & Shared Memory Virtual Directory
// ============================================================================

function createMockS3Server() {
  const objects = new Map<string, { bytes: Uint8Array; etag: string; lastModified: string }>();
  const requests: Array<{ method: string; url: string }> = [];
  let seq = 0;

  const extractKey = (urlStr: string): string => {
    const url = new URL(urlStr);
    const segs = url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    return segs.slice(1).join('/');
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    requests.push({ method, url: urlStr });
    const url = new URL(urlStr);
    const key = extractKey(urlStr);

    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const delimiter = url.searchParams.get('delimiter') ?? '';
      const sortedKeys = Array.from(objects.keys())
        .filter((k) => k.startsWith(prefix))
        .sort();
      const contents: string[] = [];
      const seenPrefixes = new Set<string>();
      for (const k of sortedKeys) {
        const rest = k.slice(prefix.length);
        if (delimiter) {
          const idx = rest.indexOf(delimiter);
          if (idx >= 0) {
            seenPrefixes.add(`${prefix}${rest.slice(0, idx + 1)}`);
            continue;
          }
        }
        const obj = objects.get(k)!;
        contents.push(
          `<Contents><Key>${k}</Key><LastModified>${obj.lastModified}</LastModified><ETag>"${obj.etag}"</ETag><Size>${obj.bytes.byteLength}</Size></Contents>`,
        );
      }
      const prefixes = Array.from(seenPrefixes)
        .map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`)
        .join('');
      const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Prefix>${prefix}</Prefix><IsTruncated>false</IsTruncated>${contents.join('')}${prefixes}</ListBucketResult>`;
      return new Response(xml, { status: 200, headers: { 'Content-Type': 'application/xml' } });
    }

    if (method === 'HEAD') {
      if (!key) return new Response(null, { status: 200 });
      const obj = objects.get(key);
      if (!obj) return new Response(null, { status: 404 });
      return new Response(null, {
        status: 200,
        headers: { ETag: `"${obj.etag}"`, 'Content-Length': String(obj.bytes.byteLength), 'Last-Modified': obj.lastModified },
      });
    }

    if (method === 'GET') {
      const obj = objects.get(key);
      if (!obj) return new Response('', { status: 404 });
      const inm = headers['if-none-match']?.replace(/"/g, '');
      if (inm && inm === obj.etag) return new Response(null, { status: 304, headers: { ETag: `"${obj.etag}"` } });
      return new Response(new Uint8Array(obj.bytes), {
        status: 200,
        headers: { ETag: `"${obj.etag}"`, 'Content-Length': String(obj.bytes.byteLength), 'Last-Modified': obj.lastModified },
      });
    }

    if (method === 'PUT') {
      const existing = objects.get(key);
      if (headers['if-none-match'] === '*' && existing) return new Response('', { status: 412 });
      if (headers['if-match']) {
        const expected = headers['if-match'].replace(/"/g, '');
        if (!existing || (expected !== '*' && expected !== existing.etag)) return new Response('', { status: 412 });
      }
      const raw = init?.body instanceof Uint8Array ? init.body : new Uint8Array(0);
      const copy = new Uint8Array(raw.byteLength);
      copy.set(raw);
      seq += 1;
      const etag = `${await sha256Hex(copy)}-${seq}`;
      const lm = new Date(1_730_000_000_000 + seq * 1000).toUTCString();
      objects.set(key, { bytes: copy, etag, lastModified: lm });
      return new Response(null, { status: existing ? 200 : 201, headers: { ETag: `"${etag}"` } });
    }

    if (method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response('Method Not Allowed', { status: 405 });
  };

  return { fetchImpl, objects, requests };
}

function createMockGistServer() {
  const gists = new Map<
    string,
    { id: string; public: boolean; updated_at: string; etagCounter: number; files: Record<string, { content: string }> }
  >();
  let nextId = 1;

  const formatGist = (g: NonNullable<ReturnType<typeof gists.get>>) => ({
    id: g.id,
    public: g.public,
    updated_at: g.updated_at,
    files: Object.fromEntries(
      Object.entries(g.files).map(([name, f]) => [
        name,
        { filename: name, content: f.content, truncated: false, size: f.content.length },
      ]),
    ),
  });

  const fetchImpl: typeof fetch = async (input, init) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlStr);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }

    if (method === 'POST' && url.pathname === '/gists') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { public?: boolean; files?: Record<string, { content: string }> };
      const id = `gist_${nextId++}`;
      const files: Record<string, { content: string }> = {};
      for (const [k, v] of Object.entries(body.files ?? {})) files[k] = { content: v.content };
      const created = { id, public: Boolean(body.public), updated_at: '2026-11-26T00:00:00Z', etagCounter: 1, files };
      gists.set(id, created);
      return new Response(JSON.stringify(formatGist(created)), {
        status: 201,
        headers: { 'Content-Type': 'application/json', ETag: `"gist-etag-${created.etagCounter}"` },
      });
    }

    const match = /^\/gists\/([^/]+)$/.exec(url.pathname);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const g = gists.get(id);
      if (!g) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });

      if (method === 'GET') {
        const etag = `"gist-etag-${g.etagCounter}"`;
        if (headers['if-none-match'] === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
        return new Response(JSON.stringify(formatGist(g)), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ETag: etag },
        });
      }

      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { files?: Record<string, { content: string } | null> };
        for (const [fname, patch] of Object.entries(body.files ?? {})) {
          if (patch === null) delete g.files[fname];
          else g.files[fname] = { content: patch.content };
        }
        g.etagCounter += 1;
        return new Response(JSON.stringify(formatGist(g)), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ETag: `"gist-etag-${g.etagCounter}"` },
        });
      }
    }

    return new Response('Not Found', { status: 404 });
  };

  return { fetchImpl, gists };
}

class MemoryVirtualDirectoryHandle implements VirtualDirectoryHandle {
  readonly kind = 'directory' as const;
  private readonly dirs = new Map<string, MemoryVirtualDirectoryHandle>();
  private readonly files = new Map<string, { data: Uint8Array; lastModified: number }>();
  permissionState: 'granted' | 'denied' | 'prompt' = 'granted';
  private clock = 1_730_000_000_000;

  constructor(
    readonly name = 'SessionMeshSync',
    private readonly rootRef?: MemoryVirtualDirectoryHandle,
  ) {}

  private effectivePerm(): 'granted' | 'denied' | 'prompt' {
    return this.rootRef ? this.rootRef.effectivePerm() : this.permissionState;
  }

  async queryPermission(): Promise<'granted' | 'denied' | 'prompt'> {
    return this.effectivePerm();
  }

  async requestPermission(): Promise<'granted' | 'denied' | 'prompt'> {
    return this.effectivePerm();
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<VirtualDirectoryHandle> {
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!options?.create) {
        const err = new Error(`NotFound: ${name}`);
        err.name = 'NotFoundError';
        throw err;
      }
      dir = new MemoryVirtualDirectoryHandle(name, this.rootRef ?? this);
      this.dirs.set(name, dir);
    }
    return dir;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    let entry = this.files.get(name);
    if (!entry) {
      if (!options?.create) {
        const err = new Error(`NotFound: ${name}`);
        err.name = 'NotFoundError';
        throw err;
      }
      entry = { data: new Uint8Array(0), lastModified: ++this.clock };
      this.files.set(name, entry);
    }
    const getEntry = () => this.files.get(name)!;
    const setEntry = (d: Uint8Array) => {
      const copy = new Uint8Array(d.byteLength);
      copy.set(d);
      this.files.set(name, { data: copy, lastModified: ++this.clock });
    };
    return {
      async getFile() {
        const cur = getEntry();
        const ab = new ArrayBuffer(cur.data.byteLength);
        new Uint8Array(ab).set(cur.data);
        return {
          size: cur.data.byteLength,
          lastModified: cur.lastModified,
          async arrayBuffer() {
            return ab;
          },
        };
      },
      async createWritable() {
        let pending = new Uint8Array(0);
        return {
          async write(data: Uint8Array) {
            pending = new Uint8Array(data);
          },
          async close() {
            setEntry(pending);
          },
        };
      },
    };
  }

  async removeEntry(name: string, _options?: { recursive?: boolean }): Promise<void> {
    if (this.files.delete(name)) return;
    if (this.dirs.delete(name)) return;
    const err = new Error(`NotFound: ${name}`);
    err.name = 'NotFoundError';
    throw err;
  }

  async *entries(): AsyncIterableIterator<[string, { kind: 'file' | 'directory'; name?: string }]> {
    for (const [k, d] of this.dirs.entries()) yield [k, { kind: 'directory', name: d.name }];
    for (const k of this.files.keys()) yield [k, { kind: 'file', name: k }];
  }
}

// ============================================================================
// Harness Builder
// ============================================================================

interface DeviceContext {
  name: string;
  browser: SimulatedV13BrowserDevice;
  storage: InMemoryStorageBackend;
  engine: SyncEngine;
}

class V13TestHarness {
  private readonly devices: DeviceContext[] = [];

  async createDevice(
    name: string,
    opts?: {
      fetchImpl?: typeof fetch;
      resolveDirectoryHandle?: (key: string) => Promise<VirtualDirectoryHandle | null>;
      fixedNowMs?: number;
      storageBackend?: InMemoryStorageBackend;
    },
  ): Promise<DeviceContext> {
    const browser = new SimulatedV13BrowserDevice({
      deviceName: name,
      fixedNowMs: opts?.fixedNowMs ?? 1_750_000_000_000,
    });
    const storage = opts?.storageBackend ?? new InMemoryStorageBackend();
    const engine = new SyncEngine({
      storage,
      browser,
      storageAdapterOptions: {
        fetchImpl: opts?.fetchImpl,
        resolveDirectoryHandle: opts?.resolveDirectoryHandle,
      },
      debounceMs: 0,
      refreshCoalesceMs: 0,
      pbkdf2Iterations: 1000,
    });
    await engine.init();
    const ctx = { name, browser, storage, engine };
    this.devices.push(ctx);
    return ctx;
  }

  async disposeAll(): Promise<void> {
    for (const d of this.devices) {
      d.engine.dispose();
    }
    this.devices.length = 0;
  }
}

function makeWebdavConfig(): WebDAVConfig {
  return {
    url: 'https://dav.v13.test/dav',
    authType: 'basic',
    username: 'alice',
    password: 'v13-secret-password',
    rootPath: '/SessionMesh',
    requestTimeoutMs: 5000,
  };
}

// ============================================================================
// v1.3.0 E2E Acceptance Suites (9 Real Scenarios)
// ============================================================================

describe('SessionMesh v1.3.0 SyncEngine E2E Acceptance Suite', () => {
  let harness: V13TestHarness | null = null;

  afterEach(async () => {
    if (harness) {
      await harness.disposeAll();
      harness = null;
    }
  });

  it('1. S3 / R2 2-device E2E sync, pairing v2 roundtrip, sanitized config, and updateSpaceStorageConfig', async () => {
    const s3Server = createMockS3Server();
    const h = new V13TestHarness();
    harness = h;

    const devA = await h.createDevice('Workstation-A', { fetchImpl: s3Server.fetchImpl });
    const devB = await h.createDevice('Laptop-B', { fetchImpl: s3Server.fetchImpl });

    const s3Config: S3StorageConfig = {
      provider: 's3',
      vendorPreset: 'r2',
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: 'sessionmesh-vault',
      accessKeyId: 'AKIA_V13',
      secretAccessKey: 'SECRET_V13',
      sessionToken: 'STS_V13',
      rootPrefix: '/SessionMesh',
    };

    const cap = await devA.engine.testStorageConnection(s3Config);
    expect(cap.overallOk).toBe(true);
    expect(cap.consistencyLevel).toBe('strong_cas');

    devA.browser.seedCookie({
      domain: '.acme-s3.com',
      name: 's3_sess',
      value: 'r2_tok_1',
      secure: true,
      httpOnly: true,
    });
    devA.browser.openTab('https://app.acme-s3.com/');
    await devA.browser.applyLocalStorage('https://app.acme-s3.com', [
      { key: 'jwt', value: 'ls_r2_jwt' },
    ]);

    await devA.engine.saveAndJoinSpace({
      storage: s3Config,
      spaceId: 'sp_r2_team',
      spaceName: 'R2 Production',
      encryptionPassword: ENC_PASS,
      deviceName: 'Workstation-A',
    });

    const summaryA = await devA.engine.getStatusSummary();
    expect(summaryA.storageProvider).toBe('s3');
    expect(summaryA.webdavUrl).toContain('sessionmesh-vault');

    const sanitized = await devA.engine.getSanitizedStorageConfig();
    expect(sanitized?.provider).toBe('s3');
    expect('secretAccessKey' in sanitized!).toBe(false);
    expect('sessionToken' in sanitized!).toBe(false);

    // Pairing v2 does not fabricate webdav config (outer envelope prefix stays smesh://pair/v1.)
    const pairCode = await devA.engine.generatePairingCode('pair-r2-99');
    expect(pairCode.startsWith('smesh://pair/v1.')).toBe(true);
    const decoded = await devB.engine.decodePairingCode(pairCode, 'pair-r2-99');
    expect(decoded.version).toBe(2);
    expect(decoded.storage?.provider).toBe('s3');
    expect(decoded.webdav).toBeUndefined();

    // Probe & verify password on Device B
    const probed = await devB.engine.probeStorageSpaces(decoded.storage!);
    expect(probed.some((p) => p.spaceId === 'sp_r2_team')).toBe(true);
    const verifyRes = await devB.engine.verifyStorageSpacePassword({
      storage: decoded.storage!,
      spaceId: 'sp_r2_team',
      encryptionPassword: ENC_PASS,
    });
    expect(verifyRes.verified).toBe(true);

    await devB.engine.saveAndJoinSpace({
      storage: decoded.storage!,
      spaceId: decoded.spaceId,
      spaceName: decoded.spaceName,
      encryptionPassword: ENC_PASS,
      deviceName: 'Laptop-B',
    });
    devB.browser.openTab('https://app.acme-s3.com/');
    await devB.engine.ingestLocalStorageSnapshot('https://app.acme-s3.com', {});
    await devB.engine.syncNow({ triggerRefresh: false });

    expect(devB.browser.findJarCookie('s3_sess', 'acme-s3.com')?.value).toBe('r2_tok_1');
    expect((await devB.browser.getLocalStorage('https://app.acme-s3.com')).items.jwt).toBe('ls_r2_jwt');

    // Update storage credentials dynamically
    const updatedS3: S3StorageConfig = {
      ...s3Config,
      accessKeyId: 'AKIA_V13_ROTATED',
      secretAccessKey: 'SECRET_V13_ROTATED',
    };
    await devA.engine.updateSpaceStorageConfig(updatedS3);
    const cfgAfter = await devA.engine.getStorageConfig();
    expect(cfgAfter?.provider === 's3' && cfgAfter.accessKeyId).toBe('AKIA_V13_ROTATED');
  });

  it('2. GitHub Private Gist 2-device sync auto-creates private Gist and persists gistId across restart', async () => {
    const gistServer = createMockGistServer();
    const h = new V13TestHarness();
    harness = h;

    const persistentStorageA = new InMemoryStorageBackend();
    const devA = await h.createDevice('Gist-Dev-A', {
      fetchImpl: gistServer.fetchImpl,
      storageBackend: persistentStorageA,
    });

    devA.browser.seedCookie({
      domain: '.gist-app.io',
      name: 'gh_sess',
      value: 'private_gist_cookie_1',
      secure: true,
      httpOnly: true,
    });

    const initialGistCfg: StorageProviderConfig = {
      provider: 'github_gist',
      personalAccessToken: 'ghp_test_token_A',
      gistId: '',
      rootPrefix: 'SessionMesh',
    };

    await devA.engine.saveAndJoinSpace({
      storage: initialGistCfg,
      spaceId: 'sp_gist_auto',
      spaceName: 'Gist Vault',
      encryptionPassword: ENC_PASS,
      deviceName: 'Gist-Dev-A',
    });

    // Private Gist MUST be auto-created as non-public and persisted back into storage config
    expect(gistServer.gists.size).toBe(1);
    const createdGist = Array.from(gistServer.gists.values())[0];
    expect(createdGist.public).toBe(false);

    const cfgAfterCreate = await devA.engine.getStorageConfig();
    expect(cfgAfterCreate?.provider).toBe('github_gist');
    const resolvedGistId = cfgAfterCreate?.provider === 'github_gist' ? cfgAfterCreate.gistId : '';
    expect(resolvedGistId).toBe(createdGist.id);

    // Pairing v2 includes the resolved gistId so Device B joins the exact private Gist
    const pairCode = await devA.engine.generatePairingCode('pair-gist-1');
    const devB = await h.createDevice('Gist-Dev-B', { fetchImpl: gistServer.fetchImpl });
    const decoded = await devB.engine.decodePairingCode(pairCode, 'pair-gist-1');
    expect(decoded.version).toBe(2);
    expect(decoded.storage?.provider === 'github_gist' && decoded.storage.gistId).toBe(resolvedGistId);

    await devB.engine.saveAndJoinSpace({
      storage: decoded.storage!,
      spaceId: decoded.spaceId,
      spaceName: decoded.spaceName,
      encryptionPassword: ENC_PASS,
      deviceName: 'Gist-Dev-B',
    });
    expect(devB.browser.findJarCookie('gh_sess', 'gist-app.io')?.value).toBe('private_gist_cookie_1');

    // Restart Device A using same IndexedDB/InMemoryStorageBackend -> reuses same gistId (no duplicate POST /gists)
    const devARestarted = await h.createDevice('Gist-Dev-A-Restarted', {
      fetchImpl: gistServer.fetchImpl,
      storageBackend: persistentStorageA,
    });
    const restartedCfg = await devARestarted.engine.getStorageConfig();
    expect(restartedCfg?.provider === 'github_gist' && restartedCfg.gistId).toBe(resolvedGistId);
    await devB.browser.simulateUserCookieSet({
      domain: '.gist-app.io',
      name: 'gh_sess',
      value: 'private_gist_cookie_2',
      secure: true,
      httpOnly: true,
    });
    await devB.engine.syncNow({ triggerRefresh: false });
    await devARestarted.engine.syncNow({ triggerRefresh: false });
    expect(devARestarted.browser.findJarCookie('gh_sess', 'gist-app.io')?.value).toBe('private_gist_cookie_2');
    expect(gistServer.gists.size).toBe(1);
  });

  it('3. Local Directory 2-device sync + ERR_LOCAL_DIR_PERMISSION emits actionable warning (not AUTH_ERROR) & recovers cleanly', async () => {
    const dirStore = new DirHandleStore('v13_e2e_local_dir_store');
    const sharedDir = new MemoryVirtualDirectoryHandle('SessionMeshCloudFolder');
    await dirStore.saveDirectoryHandle('hk_cloud', sharedDir);

    const h = new V13TestHarness();
    harness = h;
    const resolver = (k: string) => dirStore.getDirectoryHandle(k) as Promise<VirtualDirectoryHandle | null>;

    const devA = await h.createDevice('Local-PC-A', { resolveDirectoryHandle: resolver });
    const devB = await h.createDevice('Local-PC-B', { resolveDirectoryHandle: resolver });

    const localCfg: StorageProviderConfig = {
      provider: 'local_directory',
      directoryLabel: 'SessionMeshCloudFolder',
      handleKey: 'hk_cloud',
      rootPrefix: 'SessionMesh',
    };

    devA.browser.seedCookie({
      domain: '.localfs.io',
      name: 'fs_tok',
      value: 'folder_sync_1',
      secure: true,
      httpOnly: true,
    });
    await devA.engine.saveAndJoinSpace({
      storage: localCfg,
      spaceId: 'sp_local_dir',
      spaceName: 'OneDrive Sync',
      encryptionPassword: ENC_PASS,
      deviceName: 'Local-PC-A',
    });

    await devB.engine.saveAndJoinSpace({
      storage: localCfg,
      spaceId: 'sp_local_dir',
      spaceName: 'OneDrive Sync',
      encryptionPassword: ENC_PASS,
      deviceName: 'Local-PC-B',
    });
    expect(devB.browser.findJarCookie('fs_tok', 'localfs.io')?.value).toBe('folder_sync_1');

    // Revoke folder permission -> Device A emits local_dir_permission_needed + PARTIAL (never AUTH_ERROR)
    sharedDir.permissionState = 'prompt';
    await devA.engine.syncNow().catch(() => undefined);

    const revokedSummary = await devA.engine.getStatusSummary();
    expect(revokedSummary.status).toBe('PARTIAL');
    expect(revokedSummary.status).not.toBe('AUTH_ERROR');
    expect(revokedSummary.attentionItems.some((a) => a.kind === 'local_dir_permission_needed' && a.handleKey === 'hk_cloud')).toBe(true);

    // Grant permission & notify engine -> attention clears & sync resumes cleanly
    sharedDir.permissionState = 'granted';
    await devA.engine.clearLocalDirPermissionError('hk_cloud');
    await devA.engine.syncNow();
    const recoveredSummary = await devA.engine.getStatusSummary();
    expect(recoveredSummary.status).toBe('SYNCED');
    expect(recoveredSummary.attentionItems.some((a) => a.kind === 'local_dir_permission_needed')).toBe(false);
  });

  it('4. Encrypted .smesh-backup export + causal merge mode & replace mode', async () => {
    const dav = new MockWebDAVServer();
    const webdav = makeWebdavConfig();
    const h = new V13TestHarness();
    harness = h;

    const devA = await h.createDevice('Backup-A', { fetchImpl: dav.fetchImpl });
    const devB = await h.createDevice('Backup-B', { fetchImpl: dav.fetchImpl });

    devA.browser.seedCookie({ domain: '.alpha.io', name: 'k_stable', value: 'v1', secure: true });
    devA.browser.seedCookie({ domain: '.alpha.io', name: 'k_overwrite_me', value: 'old_v1', secure: true });
    devA.browser.seedCookie({ domain: '.alpha.io', name: 'k_deleted_later', value: 'gone_soon', secure: true });

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: 'sp_archive',
      spaceName: 'ArchiveVault',
      encryptionPassword: ENC_PASS,
      deviceName: 'Backup-A',
    });

    // Also ensure a local-only ephemeral track is NEVER leaked into exported archives
    const shareCode = await encodeSessionShare(
      {
        version: 1,
        shareId: 'shr_secret_local',
        siteKey: 'ephemeral-only.io',
        createdAt: 1_750_000_000_000,
        expiresAt: 1_750_000_000_000 + 3600_000,
        clampCookieExpiry: true,
        cookies: [{ domain: '.ephemeral-only.io', name: 'temp', value: 'never_backup', path: '/', secure: true, httpOnly: true, sameSite: 'lax', session: false, hostOnly: false }],
      },
      'temp-share-pw',
      { iterations: 1000 },
    );
    await devA.engine.importSessionShare({ code: shareCode, passphrase: 'temp-share-pw', mode: 'ephemeral_track' });

    // Export .smesh-backup while k_deleted_later still exists
    const exported = await devA.engine.exportArchiveBackup('ArchiveCustom!123');
    expect(exported.suggestedFilename.endsWith('.smesh-backup')).toBe(true);
    expect(exported.byteLength).toBeGreaterThan(0);

    // Advance Device B with newer edits + tombstone + extra cookie before merge import
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: 'sp_archive',
      spaceName: 'ArchiveVault',
      encryptionPassword: ENC_PASS,
      deviceName: 'Backup-B',
    });
    await devB.browser.simulateUserCookieSet({ domain: '.alpha.io', name: 'k_overwrite_me', value: 'newer_on_B', secure: true });
    const cookiesB = await devB.engine.getSiteCookies('alpha.io');
    const delRec = cookiesB.find((c) => c.name === 'k_deleted_later')!;
    await devB.engine.deleteCookies([delRec.logicalId], 'all_devices');
    await devB.browser.simulateUserCookieSet({ domain: '.beta.io', name: 'beta_only_B', value: 'keep_b', secure: true });

    // Wrong passphrase rejects cleanly
    await expect(
      devB.engine.importArchiveBackup({ base64: exported.base64, passphrase: 'wrong', mode: 'merge' }),
    ).rejects.toMatchObject({ code: 'DECRYPT_ERROR' });

    // Causal MERGE preserves newer local 'newer_on_B' and tombstone for k_deleted_later + keeps beta_only_B
    await devB.engine.importArchiveBackup({
      base64: exported.base64,
      passphrase: 'ArchiveCustom!123',
      mode: 'merge',
    });
    expect(devB.browser.findJarCookie('k_overwrite_me', 'alpha.io')?.value).toBe('newer_on_B');
    expect(devB.browser.findJarCookie('k_deleted_later', 'alpha.io')).toBeUndefined();
    expect(devB.browser.findJarCookie('beta_only_B', 'beta.io')?.value).toBe('keep_b');
    expect(devB.browser.findJarCookie('temp', 'ephemeral-only.io')).toBeUndefined();

    // REPLACE restores archive state cleanly (brings back k_deleted_later & old_v1, removes post-backup beta_only_B)
    const replaceRes = await devB.engine.importArchiveBackup({
      bytes: exported.bytes,
      passphrase: 'ArchiveCustom!123',
      mode: 'replace',
    });
    expect(replaceRes.mode).toBe('replace');
    expect(devB.browser.findJarCookie('k_overwrite_me', 'alpha.io')?.value).toBe('old_v1');
    expect(devB.browser.findJarCookie('k_deleted_later', 'alpha.io')?.value).toBe('gone_soon');
    expect(devB.browser.findJarCookie('beta_only_B', 'beta.io')).toBeUndefined();
    expect((await devB.engine.getUndoPoints()).length).toBeGreaterThan(0);
  });

  it('5. SessionStorage (allowlist) + Typed IndexedDB cross-device sync, Clean Track Switch, 1MB Quota Circuit Breaker & Env SessionStorage sync', async () => {
    const dav = new MockWebDAVServer();
    const webdav = makeWebdavConfig();
    const h = new V13TestHarness();
    harness = h;

    const devA = await h.createDevice('Ext-A', { fetchImpl: dav.fetchImpl });
    const devB = await h.createDevice('Ext-B', { fetchImpl: dav.fetchImpl });

    devA.browser.openTab('https://app.extsync.io/');
    devA.browser.seedCookie({ domain: '.extsync.io', name: 'main_sid', value: 'acct1_sid', secure: true });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: 'sp_ext',
      spaceName: 'ExtStorage',
      encryptionPassword: ENC_PASS,
      deviceName: 'Ext-A',
    });

    await devA.engine.upsertSiteRule({
      siteKey: 'extsync.io',
      pattern: 'extsync.io',
      direction: 'bidirectional',
      syncCookies: true,
      syncLocalStorage: true,
      syncSessionStorage: true,
      sessionStorageKeyAllowlist: ['auth_*', 'tab_token'],
      syncIndexedDb: true,
      indexedDbTargets: [{ dbName: 'AppVaultDb', objectStores: ['authStore'] }],
      indexedDbMaxTotalBytes: 64 * 1024,
      autoRefresh: false,
      updatedAt: devA.browser.now(),
    });

    const mountA = await devA.engine.getPageMountConfig('https://app.extsync.io');
    expect(mountA.syncSessionStorage).toBe(true);
    expect(mountA.syncIndexedDb).toBe(true);

    // Seed allowed + disallowed sessionStorage & complex typed IndexedDB record (Date + Uint8Array + Infinity)
    devA.browser.seedSessionStorage('https://app.extsync.io', {
      auth_jwt: 'ss_jwt_1',
      tab_token: 'ss_tab_1',
      ui_draft: 'excluded_by_allowlist',
    });
    const encodedKey = encodeIdbKey(['user', 1]);
    const encodedVal = encodeTypedValue({
      issuedAt: new Date(1_750_000_000_000),
      keyBytes: new Uint8Array([10, 20, 30]),
      count: Number.POSITIVE_INFINITY,
    });
    if (!encodedKey.ok || !encodedVal.ok) {
      throw new Error('Expected test IndexedDB key & value encoding to succeed');
    }
    devA.browser.seedIndexedDbRecord('https://app.extsync.io', {
      dbName: 'AppVaultDb',
      dbVersion: 3,
      storeName: 'authStore',
      keyPath: 'id',
      encodedKey: encodedKey.encodedKey,
      encodedValue: encodedVal.encoded,
    });

    await devA.engine.reconcileOriginExtendedStorage('https://app.extsync.io');
    await devA.engine.syncNow({ triggerRefresh: false });

    // Device B joins & opens tab -> receives allowlisted sessionStorage + IndexedDB record
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: 'sp_ext',
      spaceName: 'ExtStorage',
      encryptionPassword: ENC_PASS,
      deviceName: 'Ext-B',
    });
    devB.browser.openTab('https://app.extsync.io/');
    await devB.engine.reconcileOriginExtendedStorage('https://app.extsync.io');

    const ssB = await devB.browser.getSessionStorage('https://app.extsync.io');
    expect(ssB.items.auth_jwt).toBe('ss_jwt_1');
    expect(ssB.items.tab_token).toBe('ss_tab_1');
    expect(ssB.items.ui_draft).toBeUndefined();

    const idbB = devB.browser.getRawIndexedDbRecords('https://app.extsync.io', 'AppVaultDb', 'authStore');
    expect(idbB).toHaveLength(1);
    expect(idbB[0].encodedKey).toBe(encodedKey.encodedKey);
    expect(idbB[0].encodedValue).toBe(encodedVal.encoded);

    // Clean Track Switch isolates SessionStorage & IndexedDB between accounts
    const acct1TrackId = (await devA.engine.getSitesOverview()).find((s) => s.siteKey === 'extsync.io')!.activeTrack!.trackId;
    await devA.engine.createSiteAccountTrack('extsync.io', { mode: 'clean_new', label: 'Account-2' });
    const ssAAfterClean = await devA.browser.getSessionStorage('https://app.extsync.io');
    expect(ssAAfterClean.items.auth_jwt).toBeUndefined();
    expect(devA.browser.getRawIndexedDbRecords('https://app.extsync.io', 'AppVaultDb', 'authStore')).toHaveLength(0);

    // Switching back restores Account 1's SS + IDB
    await devA.engine.switchSiteTrack('extsync.io', acct1TrackId);
    expect((await devA.browser.getSessionStorage('https://app.extsync.io')).items.auth_jwt).toBe('ss_jwt_1');
    expect(devA.browser.getRawIndexedDbRecords('https://app.extsync.io', 'AppVaultDb', 'authStore')).toHaveLength(1);

    // EnvCookieSync also injects SessionStorage to localhost target
    devA.browser.openTab('http://localhost:4173/');
    await devA.engine.upsertEnvSyncRule({
      scope: 'device',
      enabled: true,
      sourceSiteKey: 'extsync.io',
      targetUrl: 'http://localhost:4173',
      syncCookies: true,
      syncLocalStorage: true,
      syncSessionStorage: true,
      adaptForHttp: true,
      cleanTargetBeforeSync: false,
      autoSync: false,
      autoReloadTarget: false,
    });
    const envRes = await devA.engine.executeEnvCookieSync({
      adHoc: {
        sourceSiteKey: 'extsync.io',
        targetUrl: 'http://localhost:4173',
        syncCookies: true,
        syncLocalStorage: false,
        syncSessionStorage: true,
      },
    });
    expect(envRes.appliedSessionStorage).toBeGreaterThanOrEqual(2);
    expect((await devA.browser.getSessionStorage('http://localhost:4173')).items.auth_jwt).toBe('ss_jwt_1');

    // Quota circuit breaker: exceeding 64KB cap triggers indexeddb_quota_exceeded without throwing
    const hugeKey = encodeIdbKey('huge_blob');
    const hugeVal = encodeTypedValue('X'.repeat(70 * 1024));
    if (!hugeKey.ok || !hugeVal.ok) {
      throw new Error('Expected test huge IndexedDB key & value encoding to succeed');
    }
    devA.browser.seedIndexedDbRecord('https://app.extsync.io', {
      dbName: 'AppVaultDb',
      dbVersion: 3,
      storeName: 'authStore',
      encodedKey: hugeKey.encodedKey,
      encodedValue: hugeVal.encoded,
    });
    await devA.engine.captureOriginIndexedDb('https://app.extsync.io');
    const quotaSummary = await devA.engine.getStatusSummary();
    const quotaAlert = quotaSummary.attentionItems.find((a) => a.kind === 'indexeddb_quota_exceeded');
    expect(quotaAlert).toBeTruthy();
    await devA.engine.dismissAttentionItem(quotaAlert!.id);
    expect((await devA.engine.getStatusSummary()).attentionItems.some((a) => a.kind === 'indexeddb_quota_exceeded')).toBe(false);
  });

  it('6. Temporary Encrypted Session Share: localOnly zero-cloud isolation, TTL auto-cleanup, env_target & override_active', async () => {
    const dav = new MockWebDAVServer();
    const reqLog: Array<{ method: string; url: string }> = [];
    const trackedFetch: typeof fetch = (input, init) => {
      reqLog.push({ method: (init?.method ?? 'GET').toUpperCase(), url: String(input) });
      return dav.fetchImpl(input, init);
    };
    const webdav = makeWebdavConfig();
    const h = new V13TestHarness();
    harness = h;

    const devA = await h.createDevice('Sharer-A', { fetchImpl: dav.fetchImpl });
    const devB = await h.createDevice('Guest-B', { fetchImpl: trackedFetch });

    const baseExpSec = Math.floor(devA.browser.now() / 1000) + 86_400 * 30;
    devA.browser.openTab('https://teamapp.io/');
    devA.browser.seedCookie({
      domain: '.teamapp.io',
      name: 'auth_tok',
      value: 'team_secret_1',
      secure: true,
      httpOnly: true,
      expirationDate: baseExpSec,
    });
    devA.browser.seedCookie({ domain: '.teamapp.io', name: '_ga', value: 'noise_ga', secure: false });
    await devA.browser.applyLocalStorage('https://teamapp.io', [{ key: 'org', value: 'acme' }]);
    devA.browser.seedSessionStorage('https://teamapp.io', { tab_state: 'open' });

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: 'sp_share',
      spaceName: 'TeamShare',
      encryptionPassword: ENC_PASS,
      deviceName: 'Sharer-A',
    });

    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: 'sp_share',
      spaceName: 'TeamShare',
      encryptionPassword: ENC_PASS,
      deviceName: 'Guest-B',
    });
    // Seed regular account on Guest-B first
    await devB.browser.simulateUserCookieSet({
      domain: '.teamapp.io',
      name: 'auth_tok',
      value: 'b_regular_acct',
      secure: true,
      httpOnly: true,
    });
    await devB.engine.syncNow({ triggerRefresh: false });

    const shareRes = await devA.engine.createSessionShare({
      siteKey: 'teamapp.io',
      passphrase: 'OneTimeShare!88',
      ttlMs: 30_000,
      accountLabel: 'QA Debug',
      note: 'Troubleshoot #42',
      clampCookieExpiry: true,
      filterNoise: true,
    });
    expect(shareRes.code.startsWith('smesh://share/v1.')).toBe(true);
    expect(shareRes.cookieCount).toBe(1);
    expect(shareRes.localStorageCount).toBe(1);
    expect(shareRes.sessionStorageCount).toBe(1);

    // Clamped cookie expiry does not exceed expiresAt
    const rawDecoded = await decodeSessionShare(shareRes.code, 'OneTimeShare!88', {
      nowMs: devA.browser.now(),
    });
    expect(rawDecoded.cookies[0].expirationDate).toBeLessThanOrEqual(Math.floor(shareRes.expiresAt / 1000));

    // Wrong passphrase rejected on preview
    await expect(devB.engine.previewSessionShare(shareRes.code, 'bad-pass')).rejects.toMatchObject({
      code: 'DECRYPT_ERROR',
    });
    const preview = await devB.engine.previewSessionShare(shareRes.code, 'OneTimeShare!88');
    expect(preview.accountLabel).toBe('QA Debug');
    expect(preview.note).toBe('Troubleshoot #42');

    // Record WebDAV request baseline before importing ephemeral_track on Device B
    const davReqBefore = reqLog.length;
    devB.browser.openTab('https://teamapp.io/');
    const importEphemeral = await devB.engine.importSessionShare({
      code: shareRes.code,
      passphrase: 'OneTimeShare!88',
      mode: 'ephemeral_track',
    });
    expect(importEphemeral.track?.ephemeral?.localOnly).toBe(true);
    expect(importEphemeral.appliedCookies).toBe(1);
    expect(devB.browser.findJarCookie('auth_tok', 'teamapp.io')?.value).toBe('team_secret_1');

    // Mutate ephemeral track locally and sync -> ZERO write requests (PUT/PATCH/MKCOL/DELETE/MOVE) to cloud & Sharer-A never sees it!
    await devB.browser.simulateUserCookieSet({
      domain: '.teamapp.io',
      name: 'ephemeral_extra',
      value: 'must_stay_local',
      secure: true,
    });
    await devB.engine.syncNow({ triggerRefresh: false });
    const newWriteReqs = reqLog
      .slice(davReqBefore)
      .filter((r) => ['PUT', 'MKCOL', 'DELETE', 'PATCH', 'MOVE'].includes(r.method));
    expect(newWriteReqs).toEqual([]);

    await devA.engine.syncNow({ triggerRefresh: false });
    const aTracks = (await devA.engine.getSitesOverview()).find((s) => s.siteKey === 'teamapp.io')?.allTracks ?? [];
    expect(aTracks.some((t) => t.ephemeral?.localOnly || t.label === 'QA Debug')).toBe(false);

    // env_target injection into localhost works cleanly without creating tracks
    const envInject = await devB.engine.importSessionShare({
      code: shareRes.code,
      passphrase: 'OneTimeShare!88',
      mode: 'env_target',
      targetUrl: 'http://localhost:3000',
      adaptForHttp: true,
    });
    expect(envInject.appliedCookies).toBe(1);
    expect(devB.browser.findJarCookie('auth_tok', 'localhost')?.value).toBe('team_secret_1');

    // Advance time past TTL -> preview rejects SHARE_EXPIRED; cleanupExpiredEphemeralTracks reverts B cleanly to regular track & emits notice
    devB.browser.advanceTime(35_000);
    await expect(devB.engine.previewSessionShare(shareRes.code, 'OneTimeShare!88')).rejects.toMatchObject({
      code: 'SHARE_EXPIRED',
    });
    const cleanedCount = await devB.engine.cleanupExpiredEphemeralTracks();
    expect(cleanedCount).toBe(1);
    expect(devB.browser.findJarCookie('ephemeral_extra', 'teamapp.io')).toBeUndefined();
    const bAfterCleanupSummary = await devB.engine.getStatusSummary();
    expect(bAfterCleanupSummary.attentionItems.some((a) => a.kind === 'ephemeral_track_expired')).toBe(true);

    // override_active updates active regular track and syncs cleanly to peer
    await devA.browser.simulateUserCookieSet({
      domain: '.teamapp.io',
      name: 'auth_tok',
      value: 'team_secret_override',
      secure: true,
      httpOnly: true,
      expirationDate: Math.floor(devB.browser.now() / 1000) + 86_400,
    });
    const overrideShare = await devA.engine.createSessionShare({
      siteKey: 'teamapp.io',
      passphrase: 'OverridePass!77',
      ttlMs: 3600_000,
      clampCookieExpiry: true,
    });
    const overrideRes = await devB.engine.importSessionShare({
      code: overrideShare.code,
      passphrase: 'OverridePass!77',
      mode: 'override_active',
    });
    expect(overrideRes.mode).toBe('override_active');
    expect(overrideRes.track?.ephemeral).toBeUndefined();
    expect(devB.browser.findJarCookie('auth_tok', 'teamapp.io')?.value).toBe('team_secret_override');
  });

  it('7. exportDebugState: inactive track isolation, active live HttpOnly overlay, Playwright/Netscape/cURL, and unmanaged/locked live fallback', async () => {
    const dav = new MockWebDAVServer();
    const webdav = makeWebdavConfig();
    const h = new V13TestHarness();
    harness = h;

    const devA = await h.createDevice('Debug-A', { fetchImpl: dav.fetchImpl });

    devA.browser.openTab('https://api.dbg.io/');
    devA.browser.seedCookie({
      domain: '.dbg.io',
      name: 'sid_acct1',
      value: 'v_acct1',
      secure: true,
      httpOnly: true,
    });
    await devA.browser.applyLocalStorage('https://api.dbg.io', [{ key: 'token', value: 'ls_acct1' }]);
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: 'sp_dbg',
      spaceName: 'DebugSpace',
      encryptionPassword: ENC_PASS,
      deviceName: 'Debug-A',
    });

    const tracksBefore = (await devA.engine.getSitesOverview()).find((s) => s.siteKey === 'dbg.io')!.allTracks;
    const acct1Id = tracksBefore[0].trackId;

    await devA.engine.createSiteAccountTrack('dbg.io', { mode: 'clean_new', label: 'Acct-2' });
    await devA.browser.simulateUserCookieSet({
      domain: '.dbg.io',
      name: 'sid_acct2_http',
      value: 'v_acct2_live',
      secure: true,
      httpOnly: true,
    });

    // Exporting inactive Acct-1 returns Acct-1 cookies (NOT active Acct-2 live jar)
    const expInactive = await devA.engine.exportDebugState({
      siteKey: 'dbg.io',
      trackId: acct1Id,
      targetUrl: 'https://api.dbg.io/v1/me',
      format: 'curl',
    });
    expect(expInactive.liveFallback).toBe(false);
    expect(expInactive.trackId).toBe(acct1Id);
    expect(expInactive.content).toContain('sid_acct1=v_acct1');
    expect(expInactive.content).not.toContain('sid_acct2_http');

    // Exporting active track overlays live HttpOnly jar + exports Netscape & Playwright storageState.json
    const expActiveNetscape = await devA.engine.exportDebugState({
      siteKey: 'dbg.io',
      format: 'netscape_cookies_txt',
    });
    expect(expActiveNetscape.liveFallback).toBe(false);
    expect(expActiveNetscape.content).toContain('#HttpOnly_.dbg.io');
    expect(expActiveNetscape.content).toContain('sid_acct2_http');

    const expPlaywright = await devA.engine.exportDebugState({
      siteKey: 'dbg.io',
      trackId: acct1Id,
      format: 'playwright_storage_state',
    });
    expect(expPlaywright.originCount).toBe(1);
    expect(JSON.parse(expPlaywright.content).origins[0].origin).toBe('https://api.dbg.io');

    // Unmanaged site live fallback
    devA.browser.seedCookie({
      domain: '.unmanaged.example',
      name: 'raw_tok',
      value: 'live_fallback_val',
      secure: true,
      httpOnly: true,
    });
    const expUnmanaged = await devA.engine.exportDebugState({
      targetUrl: 'https://app.unmanaged.example/dashboard',
      format: 'fetch',
    });
    expect(expUnmanaged.liveFallback).toBe(true);
    expect(expUnmanaged.content).toContain('raw_tok=live_fallback_val');

    // Locked session live fallback still works
    await devA.engine.lockSession();
    const expLocked = await devA.engine.exportDebugState({
      targetUrl: 'https://app.unmanaged.example/dashboard',
      format: 'cookie_header',
    });
    expect(expLocked.liveFallback).toBe(true);
    expect(expLocked.content).toContain('raw_tok=live_fallback_val');
  });

  it('8. Smart Cookie Expiry Warning: toggleWatchedCookie, grading transitions, dismissal & re-escalation', async () => {
    const dav = new MockWebDAVServer();
    const webdav = makeWebdavConfig();
    const h = new V13TestHarness();
    harness = h;

    const devA = await h.createDevice('Expiry-A', { fetchImpl: dav.fetchImpl, fixedNowMs: 1_750_000_000_000 });
    const nowSec = Math.floor(devA.browser.now() / 1000);

    // Pair long auth cookie (30d) + opaque short cookie (3h)
    devA.browser.seedCookie({
      domain: '.portal-exp.io',
      name: 'main_session',
      value: 'long_valid',
      secure: true,
      httpOnly: true,
      expirationDate: nowSec + 86_400 * 30,
    });
    devA.browser.seedCookie({
      domain: '.portal-exp.io',
      name: 'x_custom_badge_tok',
      value: 'short_3h',
      secure: true,
      httpOnly: false,
      expirationDate: nowSec + 3600 * 3,
    });

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: 'sp_exp',
      spaceName: 'ExpiryWatch',
      encryptionPassword: ENC_PASS,
      deviceName: 'Expiry-A',
    });

    // Healthy initially (L2 main_session is 30d, opaque non-auth cookie ignored unless watched)
    let summary = await devA.engine.getStatusSummary();
    expect(summary.expiringSitesCount).toBe(0);
    expect(summary.attentionItems.some((a) => a.kind === 'cookie_expiring')).toBe(false);

    // Watching x_custom_badge_tok immediately flags expiring_soon (3h < 24h)
    const watched = await devA.engine.toggleWatchedCookie('portal-exp.io', 'x_custom_badge_tok', true);
    expect(watched).toEqual(['x_custom_badge_tok']);

    const siteOverview = (await devA.engine.getSitesOverview()).find((s) => s.siteKey === 'portal-exp.io');
    expect(siteOverview?.expiryHealth?.status).toBe('expiring_soon');

    summary = await devA.engine.getStatusSummary();
    expect(summary.expiringSitesCount).toBe(1);
    const alertSoon = summary.attentionItems.find((a) => a.kind === 'cookie_expiring');
    expect(alertSoon?.severity).toBe('info');

    // Dismissing hides 'expiring_soon' alert
    await devA.engine.dismissAttentionItem(alertSoon!.id);
    expect((await devA.engine.getStatusSummary()).attentionItems.some((a) => a.kind === 'cookie_expiring')).toBe(false);

    // Advance 2h -> 1h left (< 2h criticalLeadHours) -> escalates to 'critical' and re-surfaces!
    devA.browser.advanceTime(2 * 3600_000);
    const summaryCrit = await devA.engine.getStatusSummary();
    const alertCrit = summaryCrit.attentionItems.find((a) => a.kind === 'cookie_expiring');
    expect(alertCrit?.severity).toBe('warning');

    // Advance 2h more -> -1h left -> escalates to 'expired'!
    devA.browser.advanceTime(2 * 3600_000);
    const summaryExp = await devA.engine.getStatusSummary();
    const alertExp = summaryExp.attentionItems.find((a) => a.kind === 'cookie_expiring');
    expect(alertExp?.title).toContain('已过期');
  });

  it('9. SiteTrack color & badgeText validation, clearing, and cross-device synchronization', async () => {
    const dav = new MockWebDAVServer();
    const webdav = makeWebdavConfig();
    const h = new V13TestHarness();
    harness = h;

    const devA = await h.createDevice('Color-A', { fetchImpl: dav.fetchImpl });
    const devB = await h.createDevice('Color-B', { fetchImpl: dav.fetchImpl });

    devA.browser.seedCookie({ domain: '.acctbadge.io', name: 'uid', value: 'u1', secure: true });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: 'sp_color',
      spaceName: 'ColorTracks',
      encryptionPassword: ENC_PASS,
      deviceName: 'Color-A',
    });

    const created = await devA.engine.createSiteAccountTrack('acctbadge.io', {
      mode: 'clean_new',
      label: 'Production',
      color: '#3B82F6',
      badgeText: 'PROD',
    });
    expect(created.color).toBe('#3b82f6');
    expect(created.badgeText).toBe('PROD');

    // Invalid hex color throws clear error
    await expect(
      devA.engine.updateSiteTrack('acctbadge.io', created.trackId, { color: 'invalid-color' }),
    ).rejects.toThrow(/颜色/);

    await devA.engine.syncNow({ triggerRefresh: false });

    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: 'sp_color',
      spaceName: 'ColorTracks',
      encryptionPassword: ENC_PASS,
      deviceName: 'Color-B',
    });

    const tracksOnB = (await devB.engine.getSitesOverview()).find((s) => s.siteKey === 'acctbadge.io')?.allTracks ?? [];
    const syncedTrackB = tracksOnB.find((t) => t.trackId === created.trackId);
    expect(syncedTrackB?.color).toBe('#3b82f6');
    expect(syncedTrackB?.badgeText).toBe('PROD');

    // Clear color & badgeText with null and sync across devices
    const cleared = await devA.engine.updateSiteTrack('acctbadge.io', created.trackId, {
      color: null,
      badgeText: null,
    });
    expect(cleared.color).toBeUndefined();
    expect(cleared.badgeText).toBeUndefined();

    await devA.engine.syncNow({ triggerRefresh: false });
    await devB.engine.syncNow({ triggerRefresh: false });

    const tracksAfterClearB =
      (await devB.engine.getSitesOverview()).find((s) => s.siteKey === 'acctbadge.io')?.allTracks ?? [];
    const clearedTrackB = tracksAfterClearB.find((t) => t.trackId === created.trackId);
    expect(clearedTrackB?.color).toBeUndefined();
    expect(clearedTrackB?.badgeText).toBeUndefined();
  });
});
