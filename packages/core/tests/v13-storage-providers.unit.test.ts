import { describe, expect, it } from 'vitest';
import { MockWebDAVServer } from '@sessionmesh/webdav-mock';
import { DirHandleStore } from '../../storage/lib/dirHandleStore';
import { base64ToBytes, bytesToBase64 } from '../src/crypto/encoding';
import { encryptWithPassword, generateRandomBytes, sha256Hex } from '../src/crypto/smes';
import { toStructuredError } from '../src/diagnostics';
import {
  ARCHIVE_BACKUP_AAD,
  createRemoteStorageAdapter,
  decodeArchiveBackup,
  decodeGistFilename,
  encodeArchiveBackup,
  encodeGistFilename,
  GitHubGistStorageAdapter,
  hmacSha256Bytes,
  LocalDirectoryStorageAdapter,
  normalizeStorageProviderConfig,
  S3_VENDOR_PRESETS,
  S3StorageAdapter,
  sanitizeStorageProviderConfig,
  signS3Request,
  WebDAVStorageAdapter,
  type VirtualDirectoryHandle,
} from '../src/storage-providers';
import type { ArchiveBackupPayload, SnapshotPayload, WebDAVConfig } from '../src/types';
import { WebDAVHttpError } from '../src/webdav';

function makeWebdavConfig(overrides: Partial<WebDAVConfig> = {}): WebDAVConfig {
  return {
    url: 'https://dav.sessionmesh.test/dav',
    authType: 'basic',
    username: 'alice',
    password: 'super-secret-password',
    rootPath: '/SessionMesh',
    requestTimeoutMs: 5000,
    ...overrides,
  };
}

/**
 * Pure in-memory VirtualDirectoryHandle for testing LocalDirectoryStorageAdapter in Node.
 */
class MemoryVirtualDirectoryHandle implements VirtualDirectoryHandle {
  readonly kind = 'directory' as const;
  private readonly dirs = new Map<string, MemoryVirtualDirectoryHandle>();
  private readonly files = new Map<string, { data: Uint8Array; lastModified: number }>();
  permissionState: 'granted' | 'denied' | 'prompt';
  throwDomErrorOnWrite?: string;
  private readonly parentRoot?: MemoryVirtualDirectoryHandle;
  private clock = 1_730_000_000_000;

  constructor(
    readonly name = 'root',
    permissionState: 'granted' | 'denied' | 'prompt' = 'granted',
    parentRoot?: MemoryVirtualDirectoryHandle,
  ) {
    this.permissionState = permissionState;
    this.parentRoot = parentRoot;
  }

  private getEffectiveWriteError(): string | undefined {
    return this.throwDomErrorOnWrite ?? this.parentRoot?.getEffectiveWriteError();
  }

  async queryPermission(): Promise<'granted' | 'denied' | 'prompt'> {
    return this.permissionState;
  }

  async requestPermission(): Promise<'granted' | 'denied' | 'prompt'> {
    return this.permissionState;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<VirtualDirectoryHandle> {
    if (this.files.has(name)) {
      const err = new Error(`TypeMismatch: ${name} is a file`);
      err.name = 'TypeMismatchError';
      throw err;
    }
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!options?.create) {
        const err = new Error(`NotFound: directory ${name}`);
        err.name = 'NotFoundError';
        throw err;
      }
      dir = new MemoryVirtualDirectoryHandle(name, this.permissionState, this.parentRoot ?? this);
      this.dirs.set(name, dir);
    }
    return dir;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (this.dirs.has(name)) {
      const err = new Error(`TypeMismatch: ${name} is a directory`);
      err.name = 'TypeMismatchError';
      throw err;
    }
    const writeErr = this.getEffectiveWriteError();
    let entry = this.files.get(name);
    if (!entry) {
      if (!options?.create) {
        const err = new Error(`NotFound: file ${name}`);
        err.name = 'NotFoundError';
        throw err;
      }
      if (writeErr) {
        const err = new Error(`Simulated DOM error: ${writeErr}`);
        err.name = writeErr;
        throw err;
      }
      entry = { data: new Uint8Array(0), lastModified: ++this.clock };
      this.files.set(name, entry);
    }

    const getEntry = () => this.files.get(name)!;
    const setEntry = (nextData: Uint8Array) => {
      const activeWriteErr = this.getEffectiveWriteError();
      if (activeWriteErr) {
        const err = new Error(`Simulated DOM error: ${activeWriteErr}`);
        err.name = activeWriteErr;
        throw err;
      }
      const copy = new Uint8Array(nextData.byteLength);
      copy.set(nextData);
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

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    if (this.files.has(name)) {
      this.files.delete(name);
      return;
    }
    const sub = this.dirs.get(name);
    if (sub) {
      if (!options?.recursive && (sub.dirs.size > 0 || sub.files.size > 0)) {
        const err = new Error(`InvalidModificationError: directory ${name} not empty`);
        err.name = 'InvalidModificationError';
        throw err;
      }
      this.dirs.delete(name);
      return;
    }
    const err = new Error(`NotFound: ${name}`);
    err.name = 'NotFoundError';
    throw err;
  }

  async *entries(): AsyncIterableIterator<[string, { kind: 'file' | 'directory'; name?: string }]> {
    for (const [k, d] of this.dirs.entries()) {
      yield [k, { kind: 'directory', name: d.name }];
    }
    for (const k of this.files.keys()) {
      yield [k, { kind: 'file', name: k }];
    }
  }
}

/**
 * In-memory S3 mock implementing ListObjectsV2 pagination, HEAD, GET (If-None-Match),
 * PUT (If-Match / If-None-Match: *), DELETE, virtual-hosted & path style, and degraded mode.
 */
function createMockS3Fetch(options?: {
  expectedHostPrefix?: string;
  maxKeysPerPage?: number;
  degradedIgnoreConditional?: boolean;
  rejectConditionalWith501?: boolean;
  failStatus?: number;
}) {
  const objects = new Map<string, { bytes: Uint8Array; etag: string; lastModified: string }>();
  const requests: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  let seq = 0;

  const extractBucketAndKey = (urlStr: string): { bucket: string; key: string; url: URL } => {
    const url = new URL(urlStr);
    const segs = url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    if (options?.expectedHostPrefix && url.host.startsWith(`${options.expectedHostPrefix}.`)) {
      return {
        bucket: options.expectedHostPrefix,
        key: segs.join('/'),
        url,
      };
    }
    return {
      bucket: segs[0] ?? '',
      key: segs.slice(1).join('/'),
      url,
    };
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
    requests.push({ method, url: urlStr, headers });

    if (options?.failStatus) {
      return new Response('', { status: options.failStatus });
    }

    const { key, url } = extractBucketAndKey(urlStr);

    // ListObjectsV2
    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const delimiter = url.searchParams.get('delimiter') ?? '';
      const token = url.searchParams.get('continuation-token');
      const offset = token ? Number.parseInt(token, 10) : 0;
      const pageSize = options?.maxKeysPerPage ?? 1000;

      const sortedKeys = Array.from(objects.keys())
        .filter((k) => k.startsWith(prefix))
        .sort();

      // Build unified entries (files + common prefixes) before paginating
      const pageEntries: Array<{ type: 'content'; key: string } | { type: 'prefix'; prefix: string }> = [];
      const seenPrefixes = new Set<string>();

      for (const k of sortedKeys) {
        const rest = k.slice(prefix.length);
        if (delimiter) {
          const idx = rest.indexOf(delimiter);
          if (idx >= 0) {
            const cp = `${prefix}${rest.slice(0, idx + 1)}`;
            if (!seenPrefixes.has(cp)) {
              seenPrefixes.add(cp);
              pageEntries.push({ type: 'prefix', prefix: cp });
            }
            continue;
          }
        }
        pageEntries.push({ type: 'content', key: k });
      }

      const slice = pageEntries.slice(offset, offset + pageSize);
      const isTruncated = offset + pageSize < pageEntries.length;
      const nextToken = isTruncated ? String(offset + pageSize) : '';

      const contentsXml = slice
        .filter((e): e is { type: 'content'; key: string } => e.type === 'content')
        .map((e) => {
          const obj = objects.get(e.key)!;
          return `<Contents><Key>${e.key}</Key><LastModified>${obj.lastModified}</LastModified><ETag>"${obj.etag}"</ETag><Size>${obj.bytes.byteLength}</Size></Contents>`;
        })
        .join('');
      const prefixesXml = slice
        .filter((e): e is { type: 'prefix'; prefix: string } => e.type === 'prefix')
        .map((e) => `<CommonPrefixes><Prefix>${e.prefix}</Prefix></CommonPrefixes>`)
        .join('');

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Prefix>${prefix}</Prefix>
  <IsTruncated>${isTruncated ? 'true' : 'false'}</IsTruncated>
  ${nextToken ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : ''}
  ${contentsXml}
  ${prefixesXml}
</ListBucketResult>`;
      return new Response(xml, { status: 200, headers: { 'Content-Type': 'application/xml' } });
    }

    if (method === 'HEAD') {
      if (!key) {
        return new Response(null, { status: 200 });
      }
      const obj = objects.get(key);
      if (!obj) return new Response(null, { status: 404 });
      return new Response(null, {
        status: 200,
        headers: {
          ETag: `"${obj.etag}"`,
          'Content-Length': String(obj.bytes.byteLength),
          'Last-Modified': obj.lastModified,
        },
      });
    }

    if (method === 'GET') {
      const obj = objects.get(key);
      if (!obj) return new Response('', { status: 404 });
      const inm = headers['if-none-match']?.replace(/"/g, '');
      if (inm && inm === obj.etag) {
        return new Response(null, { status: 304, headers: { ETag: `"${obj.etag}"` } });
      }
      const copy = new Uint8Array(obj.bytes.byteLength);
      copy.set(obj.bytes);
      return new Response(copy, {
        status: 200,
        headers: {
          ETag: `"${obj.etag}"`,
          'Content-Length': String(obj.bytes.byteLength),
          'Last-Modified': obj.lastModified,
        },
      });
    }

    if (method === 'PUT') {
      const hasCond = Boolean(headers['if-match'] || headers['if-none-match']);
      if (hasCond && options?.rejectConditionalWith501) {
        return new Response('Not Implemented', { status: 501 });
      }
      const existing = objects.get(key);
      if (hasCond && !options?.degradedIgnoreConditional) {
        if (headers['if-none-match'] === '*' && existing) {
          return new Response('', { status: 412 });
        }
        if (headers['if-match']) {
          const expected = headers['if-match'].replace(/"/g, '');
          if (!existing || (expected !== '*' && expected !== existing.etag)) {
            return new Response('', { status: 412 });
          }
        }
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
      const existing = objects.get(key);
      if (headers['if-match'] && !options?.degradedIgnoreConditional) {
        const expected = headers['if-match'].replace(/"/g, '');
        if (!existing || (expected !== '*' && expected !== existing.etag)) {
          return new Response('', { status: 412 });
        }
      }
      objects.delete(key);
      return new Response(null, { status: 204 });
    }

    return new Response('Method Not Allowed', { status: 405 });
  };

  return { fetchImpl, objects, requests };
}

/**
 * In-memory GitHub Gist REST API mock supporting private/public flag, ETag 304, truncated raw_url, PATCH create/update/delete.
 */
function createMockGistFetch(opts?: {
  initialGists?: Record<
    string,
    {
      id: string;
      public: boolean;
      files: Record<string, { content: string; truncated?: boolean; raw_url?: string }>;
    }
  >;
  expectedToken?: string;
}) {
  const gists = new Map<
    string,
    {
      id: string;
      public: boolean;
      updated_at: string;
      etagCounter: number;
      files: Record<string, { content: string; truncated?: boolean; raw_url?: string }>;
    }
  >();

  if (opts?.initialGists) {
    for (const [id, g] of Object.entries(opts.initialGists)) {
      gists.set(id, {
        ...g,
        updated_at: '2026-11-26T00:00:00Z',
        etagCounter: 1,
        files: { ...g.files },
      });
    }
  }

  let nextId = 1;
  let networkCalls = 0;

  const formatGistPayload = (g: NonNullable<ReturnType<typeof gists.get>>) => {
    const filesOut: Record<string, unknown> = {};
    for (const [name, f] of Object.entries(g.files)) {
      filesOut[name] = {
        filename: name,
        content: f.content,
        truncated: Boolean(f.truncated),
        raw_url: f.raw_url,
        size: f.content.length,
      };
    }
    return {
      id: g.id,
      public: g.public,
      updated_at: g.updated_at,
      files: filesOut,
    };
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    networkCalls += 1;
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlStr);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }

    // Raw URL endpoint for truncated file test
    if (url.hostname === 'gist.githubusercontent.com' || url.pathname.startsWith('/raw/')) {
      const key = decodeURIComponent(url.pathname.split('/').pop() ?? '');
      for (const g of gists.values()) {
        for (const [fname, f] of Object.entries(g.files)) {
          if (f.raw_url === urlStr || fname === key) {
            return new Response(f.content, { status: 200, headers: { 'Content-Type': 'text/plain' } });
          }
        }
      }
      return new Response('Not Found', { status: 404 });
    }

    if (opts?.expectedToken && headers['authorization'] !== `Bearer ${opts.expectedToken}`) {
      return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
    }

    if (method === 'POST' && url.pathname === '/gists') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        public?: boolean;
        files?: Record<string, { content: string }>;
      };
      const id = `gist_${nextId++}`;
      const files: Record<string, { content: string }> = {};
      for (const [k, v] of Object.entries(body.files ?? {})) {
        files[k] = { content: v.content };
      }
      const created = {
        id,
        public: Boolean(body.public),
        updated_at: '2026-11-26T01:00:00Z',
        etagCounter: 1,
        files,
      };
      gists.set(id, created);
      return new Response(JSON.stringify(formatGistPayload(created)), {
        status: 201,
        headers: {
          'Content-Type': 'application/json',
          ETag: `"gist-etag-${created.etagCounter}"`,
        },
      });
    }

    const match = /^\/gists\/([^/]+)$/.exec(url.pathname);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const g = gists.get(id);
      if (!g) {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      }

      if (method === 'GET') {
        const currentEtag = `"gist-etag-${g.etagCounter}"`;
        if (headers['if-none-match'] && headers['if-none-match'] === currentEtag) {
          return new Response(null, { status: 304, headers: { ETag: currentEtag } });
        }
        // Simulate truncated preview when entry.truncated === true
        const payload = formatGistPayload(g);
        for (const [fname, f] of Object.entries(g.files)) {
          if (f.truncated) {
            (payload.files[fname] as { content: string }).content = f.content.slice(0, 8);
          }
        }
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ETag: currentEtag,
          },
        });
      }

      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          files?: Record<string, { content: string } | null>;
        };
        for (const [fname, patch] of Object.entries(body.files ?? {})) {
          if (patch === null) {
            delete g.files[fname];
          } else {
            g.files[fname] = { content: patch.content };
          }
        }
        g.etagCounter += 1;
        g.updated_at = '2026-11-26T02:00:00Z';
        return new Response(JSON.stringify(formatGistPayload(g)), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ETag: `"gist-etag-${g.etagCounter}"`,
          },
        });
      }
    }

    return new Response('Not Found', { status: 404 });
  };

  return { fetchImpl, gists, getNetworkCalls: () => networkCalls };
}

describe('SessionMesh v1.3.0 Multi-Provider Storage Backends', () => {
  it('WebDAVStorageAdapter: wraps WebDAVClient, excludes self-collection in list(), preserves identically-named child dirs, supports CAS & capability check', async () => {
    const server = new MockWebDAVServer();
    const adapter = new WebDAVStorageAdapter(makeWebdavConfig(), { fetchImpl: server.fetchImpl });

    expect(adapter.provider).toBe('webdav');
    expect(adapter.displayEndpoint).toBe('https://dav.sessionmesh.test/dav');
    adapter.validateConfig();

    await adapter.ensureDir('SessionMesh/v1/spaces/sp_alpha/devices/devices');
    const payload = new TextEncoder().encode('hello-webdav-adapter');
    const put1 = await adapter.putBytes('SessionMesh/v1/spaces/sp_alpha/devices/dev_1.enc', payload, {
      ifNoneMatchStar: true,
    });
    expect(put1.status).toBe(201);
    expect(put1.etag).toBeTruthy();

    await expect(
      adapter.putBytes('SessionMesh/v1/spaces/sp_alpha/devices/dev_1.enc', payload, { ifNoneMatchStar: true }),
    ).rejects.toMatchObject({ status: 412 });

    const children = await adapter.list('SessionMesh/v1/spaces/sp_alpha/devices', 1);
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.name).sort()).toEqual(['dev_1.enc', 'devices']);
    expect(children.find((c) => c.name === 'dev_1.enc')?.isCollection).toBe(false);
    expect(children.find((c) => c.name === 'devices')?.isCollection).toBe(true);

    const depth0 = await adapter.list('SessionMesh/v1/spaces/sp_alpha/devices', 0);
    expect(depth0).toHaveLength(1);
    expect(depth0[0].isCollection).toBe(true);

    const notMod = await adapter.getBytes('SessionMesh/v1/spaces/sp_alpha/devices/dev_1.enc', {
      ifNoneMatch: put1.etag,
    });
    expect(notMod.notModified).toBe(true);
    expect(notMod.status).toBe(304);

    const got = await adapter.getBytes('SessionMesh/v1/spaces/sp_alpha/devices/dev_1.enc');
    expect(got.notModified).toBe(false);
    expect(got.bytes).toEqual(payload);

    expect(await adapter.stat('SessionMesh/v1/spaces/sp_alpha/devices/missing.enc')).toBeNull();
    await adapter.delete('SessionMesh/v1/spaces/sp_alpha/devices/dev_1.enc', { ifMatch: put1.etag });
    expect(await adapter.stat('SessionMesh/v1/spaces/sp_alpha/devices/dev_1.enc')).toBeNull();

    const cap = await adapter.checkCapabilities();
    expect(cap.overallOk).toBe(true);
    expect(cap.consistencyLevel).toBe('strong_cas');
  });

  it('s3SigV4: generates valid AWS4-HMAC-SHA256 & OSS4-HMAC-SHA256 signatures with RFC3986 path/query encoding', async () => {
    const body = new TextEncoder().encode('hello s3 payload');
    const fixedDate = new Date('2026-11-26T03:47:52.000Z');
    const signedAws = await signS3Request({
      method: 'PUT',
      url: 'https://s3.us-east-1.amazonaws.com/my-bucket/path%20with/special!%27()*.enc?z=1&a=hello%20world',
      region: 'us-east-1',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      sessionToken: 'sts-token-123',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
      date: fixedDate,
    });

    const expectedBodyHash = await sha256Hex(body);
    expect(signedAws.payloadHash).toBe(expectedBodyHash);
    expect(signedAws.headers['x-amz-content-sha256']).toBe(expectedBodyHash);
    expect(signedAws.headers['x-amz-date']).toBe('20261126T034752Z');
    expect(signedAws.headers['x-amz-security-token']).toBe('sts-token-123');
    expect(signedAws.canonicalRequest).toContain('/my-bucket/path%20with/special%21%27%28%29%2A.enc');
    expect(signedAws.canonicalRequest).toContain('\na=hello%20world&z=1\n');
    expect(signedAws.headers['Authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20261126\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[a-f0-9]{64}$/,
    );

    // Independently verify AWS SigV4 HMAC chain
    const kDate = await hmacSha256Bytes('AWS4wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20261126');
    const kRegion = await hmacSha256Bytes(kDate, 'us-east-1');
    const kService = await hmacSha256Bytes(kRegion, 's3');
    const kSigning = await hmacSha256Bytes(kService, 'aws4_request');
    const expectedSigBytes = await hmacSha256Bytes(kSigning, signedAws.stringToSign);
    const expectedSigHex = Array.from(expectedSigBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(signedAws.signature).toBe(expectedSigHex);

    // Aliyun OSS V4 virtual-hosted canonical URI includes /bucket/ prefix
    const signedOss = await signS3Request({
      method: 'GET',
      url: 'https://vault.oss-cn-hangzhou.aliyuncs.com/?list-type=2&prefix=SessionMesh%2F',
      region: 'cn-hangzhou',
      accessKeyId: 'LTAI_KEY',
      secretAccessKey: 'oss_secret',
      signatureMode: 'oss_v4',
      bucket: 'vault',
      addressingStyle: 'virtual_hosted',
      date: fixedDate,
    });
    expect(signedOss.headers['x-oss-date']).toBe('20261126T034752Z');
    expect(signedOss.headers['x-oss-content-sha256']).toBe('UNSIGNED-PAYLOAD');
    expect(signedOss.canonicalRequest.startsWith('GET\n/vault/\nlist-type=2&prefix=SessionMesh%2F\n')).toBe(true);
    expect(signedOss.headers['Authorization']).toContain(
      'OSS4-HMAC-SHA256 Credential=LTAI_KEY/20261126/cn-hangzhou/oss/aliyun_v4_request,AdditionalHeaders=host,Signature=',
    );
  });

  it('S3StorageAdapter: supports path & virtual-hosted addressing, ListObjectsV2 pagination, CAS fallback, and capability detection', async () => {
    // 1. HTTPS enforcement & localhost testing override
    const insecureS3 = new S3StorageAdapter({
      provider: 's3',
      endpoint: 'http://s3.example.com',
      region: 'us-east-1',
      bucket: 'b',
      accessKeyId: 'k',
      secretAccessKey: 's',
      rootPrefix: '/SessionMesh',
    });
    expect(() => insecureS3.validateConfig()).toThrowError(/HTTPS is required/);

    const localS3Mock = createMockS3Fetch();
    const localS3 = new S3StorageAdapter(
      {
        provider: 's3',
        vendorPreset: 'minio',
        endpoint: 'http://127.0.0.1:9000',
        region: 'us-east-1',
        bucket: 'sm-bucket',
        accessKeyId: 'minioadmin',
        secretAccessKey: 'minioadmin',
        rootPrefix: '/SessionMesh',
        allowInsecureLocalhostForTesting: true,
      },
      { fetchImpl: localS3Mock.fetchImpl },
    );
    localS3.validateConfig();
    expect(localS3.displayEndpoint).toBe('http://127.0.0.1:9000/sm-bucket/SessionMesh');

    // 2. Paginated ListObjectsV2 across multiple pages + CommonPrefixes
    const paginatedMock = createMockS3Fetch({ maxKeysPerPage: 2 });
    const r2Adapter = new S3StorageAdapter(
      {
        provider: 's3',
        vendorPreset: 'r2',
        endpoint: 'https://acc.r2.cloudflarestorage.com',
        region: 'auto',
        bucket: 'mesh-vault',
        accessKeyId: 'r2key',
        secretAccessKey: 'r2secret',
        rootPrefix: '/SessionMesh',
      },
      { fetchImpl: paginatedMock.fetchImpl },
    );
    expect(r2Adapter.displayEndpoint).toBe('https://acc.r2.cloudflarestorage.com/mesh-vault/SessionMesh');

    for (let i = 1; i <= 4; i += 1) {
      await r2Adapter.putBytes(`v1/spaces/sp_1/events/dev_a/000${i}_b${i}.enc`, new Uint8Array([i, i + 1]));
    }
    await r2Adapter.putBytes('v1/spaces/sp_1/events/dev_b/0001_b1.enc', new Uint8Array([9]));

    const eventDirs = await r2Adapter.list('v1/spaces/sp_1/events', 1);
    expect(eventDirs).toHaveLength(2);
    expect(eventDirs.every((d) => d.isCollection)).toBe(true);
    expect(eventDirs.map((d) => d.name).sort()).toEqual(['dev_a', 'dev_b']);

    const devAFiles = await r2Adapter.list('v1/spaces/sp_1/events/dev_a', 1);
    expect(devAFiles).toHaveLength(4);
    expect(devAFiles.every((f) => !f.isCollection && f.path.startsWith('/v1/spaces/sp_1/events/dev_a/'))).toBe(true);

    // stat() returns null on 404, throws WebDAVHttpError on 403/5xx
    expect(await r2Adapter.stat('v1/spaces/sp_1/events/dev_a/missing.enc')).toBeNull();
    const err403Mock = createMockS3Fetch({ failStatus: 403 });
    const forbiddenAdapter = new S3StorageAdapter(
      {
        provider: 's3',
        endpoint: 'https://s3.example.com',
        region: 'us-east-1',
        bucket: 'b',
        accessKeyId: 'k',
        secretAccessKey: 's',
        rootPrefix: '',
      },
      { fetchImpl: err403Mock.fetchImpl },
    );
    await expect(forbiddenAdapter.stat('foo.enc')).rejects.toBeInstanceOf(WebDAVHttpError);
    try {
      await forbiddenAdapter.stat('foo.enc');
    } catch (err) {
      expect(toStructuredError(err, 'stat').code).toBe('WEBDAV_FORBIDDEN');
    }

    // 3. Collection delete across pages + strong CAS checkCapabilities
    await r2Adapter.delete('v1/spaces/sp_1/events/dev_a', { isCollection: true });
    expect(await r2Adapter.list('v1/spaces/sp_1/events/dev_a', 1)).toHaveLength(0);
    expect(await r2Adapter.list('v1/spaces/sp_1/events/dev_b', 1)).toHaveLength(1);

    const capStrong = await r2Adapter.checkCapabilities();
    expect(capStrong.overallOk).toBe(true);
    expect(capStrong.consistencyLevel).toBe('strong_cas');

    // 4. Aliyun OSS virtual-hosted mode + 501 fallback -> append_only_degraded
    const ossMock = createMockS3Fetch({ expectedHostPrefix: 'my-oss-bucket', rejectConditionalWith501: true });
    const ossAdapter = new S3StorageAdapter(
      {
        provider: 's3',
        vendorPreset: 'aliyun_oss',
        endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
        region: 'cn-hangzhou',
        bucket: 'my-oss-bucket',
        accessKeyId: 'ak',
        secretAccessKey: 'sk',
        rootPrefix: '/SessionMesh',
      },
      { fetchImpl: ossMock.fetchImpl },
    );
    expect(ossAdapter.displayEndpoint).toBe('https://my-oss-bucket.oss-cn-hangzhou.aliyuncs.com/SessionMesh');

    // putBytes with ifNoneMatchStar falls back on 501 without failing
    const ossPut = await ossAdapter.putBytes('metadata/space.enc', new Uint8Array([7, 8, 9]), {
      ifNoneMatchStar: true,
    });
    expect(ossPut.status).toBe(201);
    expect(ossMock.requests.some((r) => r.url.startsWith('https://my-oss-bucket.oss-cn-hangzhou.aliyuncs.com/'))).toBe(
      true,
    );

    const capDegraded = await ossAdapter.checkCapabilities();
    expect(capDegraded.overallOk).toBe(true);
    expect(capDegraded.consistencyLevel).toBe('append_only_degraded');
  });

  it('GitHubGistStorageAdapter: enforces private-only privacy guard, lossless flat paths, 304 cache, truncated raw_url, and batch delete', async () => {
    // 1. Lossless flat filename encoding / decoding
    const paths = [
      'SessionMesh/v1/spaces/sp_abc/metadata/space.enc',
      'a/b-c_d--e_-f/00001_dev-1_batch--x.enc',
      'single.enc',
    ];
    for (const p of paths) {
      const flat = encodeGistFilename(p);
      expect(flat).not.toContain('/');
      expect(flat.endsWith('.b64')).toBe(true);
      expect(decodeGistFilename(flat)).toBe(p);
    }
    expect(decodeGistFilename('_sessionmesh_readme.md')).toBeNull();
    expect(decodeGistFilename('bad--escape-.b64')).toBeNull();

    // 2. CRITICAL PRIVACY RULE: public Gist is strictly rejected with 403 GIST_PUBLIC_FORBIDDEN
    const publicMock = createMockGistFetch({
      initialGists: {
        pub_gist_1: {
          id: 'pub_gist_1',
          public: true,
          files: {
            [encodeGistFilename('SessionMesh/space.enc')]: { content: bytesToBase64(new Uint8Array([1, 2, 3])) },
          },
        },
      },
    });
    const publicAdapter = new GitHubGistStorageAdapter(
      {
        provider: 'github_gist',
        personalAccessToken: 'ghp_test_token',
        gistId: 'pub_gist_1',
        rootPrefix: 'SessionMesh',
      },
      { fetchImpl: publicMock.fetchImpl },
    );

    await expect(publicAdapter.getBytes('space.enc')).rejects.toMatchObject({
      status: 403,
      code: 'GIST_PUBLIC_FORBIDDEN',
      retryable: false,
    });
    const publicCap = await publicAdapter.checkCapabilities();
    expect(publicCap.overallOk).toBe(false);
    expect(publicCap.consistencyLevel).toBe('incompatible');

    // 3. Auto-create Private Gist when gistId is empty, ETag 304 cache, list, and batch collection delete
    const mock = createMockGistFetch({ expectedToken: 'ghp_secret_123' });
    const gistAdapter = new GitHubGistStorageAdapter(
      {
        provider: 'github_gist',
        personalAccessToken: 'ghp_secret_123',
        rootPrefix: 'SessionMesh',
      },
      { fetchImpl: mock.fetchImpl },
    );
    expect(gistAdapter.getGistId()).toBeUndefined();

    const bin1 = generateRandomBytes(128);
    const putRes = await gistAdapter.putBytes('v1/spaces/sp_1/metadata/space.enc', bin1);
    const createdId = gistAdapter.getGistId();
    expect(createdId).toBeTruthy();
    expect(mock.gists.get(createdId!)?.public).toBe(false);
    expect(putRes.etag).toBe(await sha256Hex(bin1));

    await gistAdapter.putBytes('v1/spaces/sp_1/devices/dev_a.enc', new Uint8Array([10, 20]));
    await gistAdapter.putBytes('v1/spaces/sp_1/devices/dev_b.enc', new Uint8Array([30, 40]));

    // List virtual directory children + files
    const spaceDirs = await gistAdapter.list('v1/spaces/sp_1', 1);
    expect(spaceDirs.map((s) => s.name).sort()).toEqual(['devices', 'metadata']);
    expect(spaceDirs.every((s) => s.isCollection)).toBe(true);

    const devFiles = await gistAdapter.list('v1/spaces/sp_1/devices', 1);
    expect(devFiles.map((s) => s.name).sort()).toEqual(['dev_a.enc', 'dev_b.enc']);

    // getBytes uses cache / 304 and supports ifNoneMatch
    const got1 = await gistAdapter.getBytes('v1/spaces/sp_1/metadata/space.enc');
    expect(got1.bytes).toEqual(bin1);
    const got304 = await gistAdapter.getBytes('v1/spaces/sp_1/metadata/space.enc', { ifNoneMatch: putRes.etag });
    expect(got304.notModified).toBe(true);
    expect(got304.status).toBe(304);

    // 4. Truncated file fallback via raw_url
    const largePayload = generateRandomBytes(1024);
    const largeB64 = bytesToBase64(largePayload);
    const truncFlat = encodeGistFilename('SessionMesh/v1/spaces/sp_1/snapshots/snap_1.enc');
    mock.gists.get(createdId!)!.files[truncFlat] = {
      content: largeB64,
      truncated: true,
      raw_url: `https://gist.githubusercontent.com/alice/${createdId}/raw/abc/${truncFlat}`,
    };
    mock.gists.get(createdId!)!.etagCounter += 1;

    const gotTrunc = await gistAdapter.getBytes('v1/spaces/sp_1/snapshots/snap_1.enc');
    expect(await sha256Hex(gotTrunc.bytes)).toBe(await sha256Hex(largePayload));

    // 5. Collection delete removes all matching prefix files in single PATCH
    const callsBeforeDel = mock.getNetworkCalls();
    await gistAdapter.delete('v1/spaces/sp_1/devices', { isCollection: true });
    // 1 GET(forceRefresh) + 1 PATCH = 2 calls for deleting multiple files
    expect(mock.getNetworkCalls() - callsBeforeDel).toBe(2);
    expect(await gistAdapter.list('v1/spaces/sp_1/devices', 1)).toHaveLength(0);

    // 6. checkCapabilities returns append_only_degraded + overallOk: true
    const cap = await gistAdapter.checkCapabilities();
    expect(cap.overallOk).toBe(true);
    expect(cap.consistencyLevel).toBe('append_only_degraded');
  });

  it('LocalDirectoryStorageAdapter & DirHandleStore: supports virtual FS CRUD, CAS, permission-needed errors, and strong_cas capabilities', async () => {
    const store = new DirHandleStore('test_dir_handles_unit');
    const rootHandle = new MemoryVirtualDirectoryHandle('SessionMeshSync', 'granted');
    await store.saveDirectoryHandle('hk_main', rootHandle);

    expect(await store.listHandleKeys()).toEqual(['hk_main']);
    expect(await store.checkDirectoryPermission('hk_main', 'readwrite')).toBe('granted');
    expect(await store.checkDirectoryPermission('missing_key', 'readwrite')).toBe('missing');

    const adapter = new LocalDirectoryStorageAdapter(
      {
        provider: 'local_directory',
        directoryLabel: 'SessionMeshSync',
        handleKey: 'hk_main',
        rootPrefix: 'SessionMesh',
      },
      { resolveDirectoryHandle: (k) => store.getDirectoryHandle(k) as Promise<VirtualDirectoryHandle | null> },
    );

    const dataV1 = new TextEncoder().encode('local-v1');
    const put1 = await adapter.putBytes('v1/spaces/sp_1/metadata/space.enc', dataV1, { ifNoneMatchStar: true });
    expect(put1.status).toBe(201);
    expect(put1.etag).toBeTruthy();

    await expect(
      adapter.putBytes('v1/spaces/sp_1/metadata/space.enc', dataV1, { ifNoneMatchStar: true }),
    ).rejects.toMatchObject({ status: 412 });

    const dataV2 = new TextEncoder().encode('local-v2-updated');
    const put2 = await adapter.putBytes('v1/spaces/sp_1/metadata/space.enc', dataV2, { ifMatch: put1.etag });
    expect(put2.status).toBe(200);
    expect(put2.etag).not.toBe(put1.etag);

    await expect(
      adapter.putBytes('v1/spaces/sp_1/metadata/space.enc', dataV1, { ifMatch: put1.etag }),
    ).rejects.toMatchObject({ status: 412 });

    const got = await adapter.getBytes('v1/spaces/sp_1/metadata/space.enc');
    expect(got.bytes).toEqual(dataV2);
    const got304 = await adapter.getBytes('v1/spaces/sp_1/metadata/space.enc', { ifNoneMatch: put2.etag });
    expect(got304.notModified).toBe(true);
    expect(got304.status).toBe(304);

    const listed = await adapter.list('v1/spaces/sp_1', 1);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: 'metadata', isCollection: true, path: '/v1/spaces/sp_1/metadata' });

    const cap = await adapter.checkCapabilities();
    expect(cap.overallOk).toBe(true);
    expect(cap.consistencyLevel).toBe('strong_cas');

    // Permission prompt / denied check
    rootHandle.permissionState = 'prompt';
    await expect(adapter.list('', 1)).rejects.toMatchObject({
      status: 403,
      code: 'ERR_LOCAL_DIR_PERMISSION',
      message: '本地同步文件夹需要重新授予读写权限',
    });

    // NotAllowedError during FS operation
    rootHandle.permissionState = 'granted';
    rootHandle.throwDomErrorOnWrite = 'NotAllowedError';
    await expect(adapter.putBytes('v1/spaces/sp_1/metadata/new.enc', new Uint8Array([1]))).rejects.toMatchObject({
      status: 403,
      code: 'ERR_LOCAL_DIR_PERMISSION',
    });
    rootHandle.throwDomErrorOnWrite = undefined;

    // Missing handle check
    await store.deleteDirectoryHandle('hk_main');
    await expect(adapter.stat('v1/spaces/sp_1/metadata/space.enc')).rejects.toMatchObject({
      code: 'ERR_LOCAL_DIR_MISSING',
    });
  });

  it('archiveBackup: encrypts and decrypts .smesh-backup archives and rejects wrong passphrase or AAD mismatch', async () => {
    const snapshot: SnapshotPayload = {
      snapshotId: 'snap_001',
      spaceId: 'sp_demo',
      createdAt: 1_730_000_000_000,
      createdByDevice: 'dev_1',
      coveredVectorClock: { dev_1: 5 },
      cookies: {},
      localStorage: {},
      tombstones: {},
      tracks: {},
      rules: {
        spaceBlacklist: [],
        siteOverrides: {},
        ssoGroups: [],
        updatedAt: 1_730_000_000_000,
      },
    };
    const payload: ArchiveBackupPayload = {
      format: 'sessionmesh_archive',
      version: 1,
      exportedAt: 1_730_000_123_000,
      spaceName: 'Work Vault',
      snapshot,
    };

    const bytes = await encodeArchiveBackup(payload, 'ArchivePass!2026', { iterations: 1000 });
    const decoded = await decodeArchiveBackup(bytes, 'ArchivePass!2026');
    expect(decoded).toEqual(payload);

    await expect(decodeArchiveBackup(bytes, 'WrongPass!')).rejects.toMatchObject({ code: 'DECRYPT_ERROR' });

    // Reject SMES payload with wrong AAD
    const wrongAad = await encryptWithPassword(payload, 'ArchivePass!2026', 'wrong:aad', { iterations: 1000 });
    await expect(decodeArchiveBackup(wrongAad, 'ArchivePass!2026')).rejects.toMatchObject({
      code: 'DECRYPT_AAD_MISMATCH',
    });
    expect(ARCHIVE_BACKUP_AAD).toBe('sessionmesh:archive:v1');
  });

  it('factory: normalizes configs, sanitizes all secrets, exposes S3 vendor presets, and instantiates all 4 adapters', () => {
    expect(Object.keys(S3_VENDOR_PRESETS).sort()).toEqual([
      'aliyun_oss',
      'aws_s3',
      'b2',
      'cos',
      'custom',
      'minio',
      'r2',
    ]);
    expect(S3_VENDOR_PRESETS.aliyun_oss.defaultAddressingStyle).toBe('virtual_hosted');
    expect(S3_VENDOR_PRESETS.r2.defaultAddressingStyle).toBe('path');

    const legacyNormalized = normalizeStorageProviderConfig(null, makeWebdavConfig());
    expect(legacyNormalized?.provider).toBe('webdav');

    const sanitizedWebdav = sanitizeStorageProviderConfig(legacyNormalized);
    expect(sanitizedWebdav).toBeTruthy();
    expect('password' in sanitizedWebdav!).toBe(false);
    expect('bearerToken' in sanitizedWebdav!).toBe(false);

    const s3Cfg = normalizeStorageProviderConfig({
      provider: 's3',
      vendorPreset: 'aliyun_oss',
      endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
      region: '',
      bucket: 'my-bucket',
      accessKeyId: 'ak_123',
      secretAccessKey: 'sk_secret',
      sessionToken: 'sts_secret',
      rootPrefix: '/SessionMesh',
    });
    expect(s3Cfg?.provider).toBe('s3');
    if (s3Cfg?.provider === 's3') {
      expect(s3Cfg.region).toBe('cn-hangzhou');
      expect(s3Cfg.addressingStyle).toBe('virtual_hosted');
      expect(s3Cfg.signatureMode).toBe('oss_v4');
    }
    const sanitizedS3 = sanitizeStorageProviderConfig(s3Cfg);
    expect('secretAccessKey' in sanitizedS3!).toBe(false);
    expect('sessionToken' in sanitizedS3!).toBe(false);

    const gistCfg = normalizeStorageProviderConfig({
      provider: 'github_gist',
      personalAccessToken: 'ghp_secret',
    });
    const sanitizedGist = sanitizeStorageProviderConfig(gistCfg);
    expect('personalAccessToken' in sanitizedGist!).toBe(false);

    const localCfg = normalizeStorageProviderConfig({
      provider: 'local_directory',
      directoryLabel: 'VaultDir',
      handleKey: 'hk_1',
    });

    expect(createRemoteStorageAdapter(legacyNormalized!).provider).toBe('webdav');
    expect(createRemoteStorageAdapter(s3Cfg!).provider).toBe('s3');
    expect(createRemoteStorageAdapter(gistCfg!).provider).toBe('github_gist');
    expect(createRemoteStorageAdapter(localCfg!).provider).toBe('local_directory');
  });
});
