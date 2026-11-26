/**
 * GitHub Private Gist RemoteStorageAdapter.
 * Enforces Secret/Private Gist privacy (forbids public Gists with HTTP 403 GIST_PUBLIC_FORBIDDEN),
 * uses lossless flat filename escaping, ETag 304 caching, and truncated raw_url fetching.
 */
import type { CapabilityReport, GitHubGistStorageConfig, RemoteObjectStat, RemoteStorageAdapter } from '../types';
import { base64ToBytes, bytesToBase64, bytesToHex } from '../crypto/encoding';
import { generateRandomBytes, sha256Hex } from '../crypto/smes';
import { createHttpStatusError, WebDAVHttpError } from '../webdav/errors';
import { normalizeEtag } from '../webdav/xml';
import {
  buildCapabilityReport,
  createCapabilityChecksTemplate,
  describeAdapterError,
  performTimedFetch,
  splitCleanStorageSegments,
  validateHttpsEndpoint,
  type StorageAdapterOptions,
} from './types';

interface GistFileEntry {
  filename?: string;
  content?: string;
  truncated?: boolean;
  raw_url?: string;
  size?: number;
}

interface GistApiResponse {
  id: string;
  public: boolean;
  updated_at?: string;
  html_url?: string;
  files?: Record<string, GistFileEntry | null>;
}

const DEFAULT_GITHUB_API = 'https://api.github.com';
const GIST_README_NAME = '_sessionmesh_readme.md';
const GIST_README_CONTENT =
  '# SessionMesh Encrypted Sync Vault\n\nThis Secret GitHub Gist stores end-to-end encrypted SessionMesh sync objects. Do NOT make this Gist public.\n';

function encodeGistSegment(seg: string): string {
  return seg.replace(/_/g, '__').replace(/-/g, '-_');
}

function decodeGistSegment(encoded: string): string | null {
  let out = '';
  for (let i = 0; i < encoded.length; i += 1) {
    const ch = encoded[i];
    if (ch === '-') {
      if (i + 1 >= encoded.length || encoded[i + 1] !== '_') {
        return null;
      }
      out += '-';
      i += 1;
    } else if (ch === '_') {
      if (i + 1 >= encoded.length || encoded[i + 1] !== '_') {
        return null;
      }
      out += '_';
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Losslessly encodes a logical hierarchical path into a flat Gist filename (without "/").
 */
export function encodeGistFilename(logicalPath: string): string {
  const segs = splitCleanStorageSegments(logicalPath, 'GitHub Gist');
  if (segs.length === 0) {
    throw new WebDAVHttpError({
      status: 400,
      code: 'STORAGE_INVALID_PATH',
      phase: 'encode_path',
      message: 'GitHub Gist logical file path must not be empty',
      retryable: false,
      suggestion: 'Provide a valid non-empty file path.',
    });
  }
  return `${segs.map(encodeGistSegment).join('--')}.b64`;
}

/**
 * Decodes a flat `.b64` Gist filename back into a logical "/" path, or null for unrelated files.
 */
export function decodeGistFilename(flatName: string): string | null {
  if (!flatName || !flatName.endsWith('.b64')) {
    return null;
  }
  const stem = flatName.slice(0, -4);
  if (!stem) return null;
  const rawParts = stem.split('--');
  const decodedParts: string[] = [];
  for (const part of rawParts) {
    if (!part) return null;
    const dec = decodeGistSegment(part);
    if (dec === null || dec.includes('/')) {
      return null;
    }
    decodedParts.push(dec);
  }
  return decodedParts.join('/');
}

const GIST_CAPABILITY_STEPS = [
  { step: 1, id: 'config_format', name: 'GitHub API URL & Token Validation' },
  { step: 2, id: 'gist_private_check', name: 'Private/Secret Gist Privacy Guard' },
  { step: 3, id: 'temp_put', name: 'Temporary Object PATCH Write' },
  { step: 4, id: 'temp_get', name: 'Temporary Object Read & Base64 Decode' },
  { step: 5, id: 'sha256_consistency', name: 'Binary Read/Write SHA-256 Consistency' },
  { step: 6, id: 'payload_size_64kb', name: '64KB Binary Payload Support' },
  { step: 7, id: 'probe_cleanup', name: 'Temporary Probe Cleanup' },
];

export class GitHubGistStorageAdapter implements RemoteStorageAdapter {
  readonly provider = 'github_gist' as const;

  private readonly config: GitHubGistStorageConfig;
  private readonly fetchImpl?: typeof fetch;
  private cachedGistEtag?: string;
  private cachedGistData?: GistApiResponse;

  constructor(config: GitHubGistStorageConfig, options?: StorageAdapterOptions) {
    this.config = {
      ...config,
      apiBaseUrl: (config.apiBaseUrl || DEFAULT_GITHUB_API).replace(/\/+$/, ''),
      gistId: config.gistId?.trim() || undefined,
    };
    this.fetchImpl = options?.fetchImpl;
  }

  get displayEndpoint(): string {
    const base = this.config.apiBaseUrl || DEFAULT_GITHUB_API;
    return this.config.gistId ? `${base}/gists/${this.config.gistId}` : `${base}/gists`;
  }

  getGistId(): string | undefined {
    return this.config.gistId;
  }

  validateConfig(): void {
    validateHttpsEndpoint(
      this.config.apiBaseUrl || DEFAULT_GITHUB_API,
      this.config.allowInsecureLocalhostForTesting,
      'GitHub Gist API',
      'GIST',
    );
    if (!this.config.personalAccessToken || !this.config.personalAccessToken.trim()) {
      throw new WebDAVHttpError({
        status: 401,
        code: 'GIST_MISSING_TOKEN',
        phase: 'validate_config',
        message: 'GitHub Personal Access Token (gist scope) is required',
        retryable: false,
        suggestion: 'Configure a GitHub Personal Access Token with the "gist" scope.',
      });
    }
    if (this.config.rootPrefix !== undefined) {
      splitCleanStorageSegments(this.config.rootPrefix, 'GitHub Gist');
    }
  }

  private getRootSegments(): string[] {
    if (this.config.rootPrefix === undefined) {
      return ['SessionMesh'];
    }
    return splitCleanStorageSegments(this.config.rootPrefix, 'GitHub Gist');
  }

  private toFullSegments(subPath: string): { rootSegments: string[]; subSegments: string[]; fullSegments: string[] } {
    const rootSegments = this.getRootSegments();
    const subSegments = splitCleanStorageSegments(subPath, 'GitHub Gist');
    return {
      rootSegments,
      subSegments,
      fullSegments: [...rootSegments, ...subSegments],
    };
  }

  private buildApiHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.personalAccessToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(extra ?? {}),
    };
  }

  private assertPrivateGist(gist: GistApiResponse): void {
    if (gist.public === true) {
      this.cachedGistData = undefined;
      this.cachedGistEtag = undefined;
      throw new WebDAVHttpError({
        status: 403,
        code: 'GIST_PUBLIC_FORBIDDEN',
        phase: 'privacy_check',
        message: '安全拦截：严禁使用公开 (Public) GitHub Gist 存储加密会话，请改用 Secret/Private Gist！',
        retryable: false,
        suggestion: '请新建 Secret (Private) Gist，或清空 Gist ID 由 SessionMesh 自动创建私有 Gist。',
      });
    }
  }

  private async apiRequest(params: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
    phase: string;
  }): Promise<Response> {
    this.validateConfig();
    const base = this.config.apiBaseUrl || DEFAULT_GITHUB_API;
    return performTimedFetch({
      fetchImpl: this.fetchImpl,
      url: `${base}${params.path}`,
      method: params.method,
      headers: this.buildApiHeaders(params.headers),
      body: params.body,
      timeoutMs: this.config.requestTimeoutMs ?? 30_000,
      phase: params.phase,
      displayPath: params.path,
      providerLabel: 'GitHub Gist',
      errorCodePrefix: 'GIST',
    });
  }

  async createPrivateGist(
    description = 'SessionMesh Encrypted Sync Vault (Do Not Make Public)',
  ): Promise<string> {
    const res = await this.apiRequest({
      method: 'POST',
      path: '/gists',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        description,
        public: false,
        files: {
          [GIST_README_NAME]: {
            content: GIST_README_CONTENT,
          },
        },
      }),
      phase: 'create_gist',
    });

    if (res.status < 200 || res.status >= 300) {
      throw createHttpStatusError(res.status, 'create_gist', '/gists', res.headers.get('retry-after'));
    }

    const created = (await res.json()) as GistApiResponse;
    this.assertPrivateGist(created);
    if (!created.id) {
      throw new WebDAVHttpError({
        status: 500,
        code: 'GIST_CREATE_INVALID_RESPONSE',
        phase: 'create_gist',
        message: 'GitHub Gist creation response missing id',
        retryable: false,
        suggestion: 'Verify GitHub API response and PAT permissions.',
      });
    }
    this.config.gistId = created.id;
    this.cachedGistData = created;
    this.cachedGistEtag = res.headers.get('etag') ?? undefined;
    return created.id;
  }

  async ensureGistReady(): Promise<string> {
    this.validateConfig();
    if (!this.config.gistId) {
      return this.createPrivateGist();
    }
    await this.fetchGist(false);
    return this.config.gistId;
  }

  private async fetchGist(forceRefresh = false): Promise<GistApiResponse> {
    this.validateConfig();
    const gistId = this.config.gistId;
    if (!gistId) {
      throw createHttpStatusError(404, 'get_gist', '/gists');
    }

    const headers: Record<string, string> = {};
    if (!forceRefresh && this.cachedGistEtag && this.cachedGistData) {
      headers['If-None-Match'] = this.cachedGistEtag;
    }

    const res = await this.apiRequest({
      method: 'GET',
      path: `/gists/${encodeURIComponent(gistId)}`,
      headers,
      phase: 'get_gist',
    });

    if (res.status === 304 && this.cachedGistData) {
      this.assertPrivateGist(this.cachedGistData);
      return this.cachedGistData;
    }

    if (res.status < 200 || res.status >= 300) {
      throw createHttpStatusError(res.status, 'get_gist', `/gists/${gistId}`, res.headers.get('retry-after'));
    }

    const data = (await res.json()) as GistApiResponse;
    this.assertPrivateGist(data);
    this.cachedGistData = data;
    this.cachedGistEtag = res.headers.get('etag') ?? this.cachedGistEtag;
    return data;
  }

  private async resolveFileContent(entry: GistFileEntry, displayPath: string): Promise<string> {
    if (entry.truncated === true && entry.raw_url) {
      const baseOrigin = new URL(this.config.apiBaseUrl || DEFAULT_GITHUB_API).origin;
      let rawHeaders: Record<string, string> = { Accept: 'text/plain' };
      try {
        if (new URL(entry.raw_url).origin === baseOrigin) {
          rawHeaders = this.buildApiHeaders({ Accept: 'text/plain' });
        }
      } catch {
        // use minimal header
      }

      const rawRes = await performTimedFetch({
        fetchImpl: this.fetchImpl,
        url: entry.raw_url,
        method: 'GET',
        headers: rawHeaders,
        timeoutMs: this.config.requestTimeoutMs ?? 30_000,
        phase: 'getBytes_raw',
        displayPath,
        providerLabel: 'GitHub Gist',
        errorCodePrefix: 'GIST',
      });
      if (rawRes.status < 200 || rawRes.status >= 300) {
        throw createHttpStatusError(rawRes.status, 'getBytes_raw', displayPath, rawRes.headers.get('retry-after'));
      }
      return rawRes.text();
    }
    return entry.content ?? '';
  }

  async ensureDir(subPath: string): Promise<void> {
    splitCleanStorageSegments(subPath, 'GitHub Gist');
    await this.ensureGistReady();
  }

  async list(subPath: string, depth: 0 | 1 = 1): Promise<RemoteObjectStat[]> {
    this.validateConfig();
    if (!this.config.gistId) {
      return [];
    }
    if (depth === 0) {
      const st = await this.stat(subPath);
      return st ? [st] : [];
    }

    const { rootSegments, subSegments, fullSegments } = this.toFullSegments(subPath);
    const gist = await this.fetchGist();
    const files = gist.files ?? {};
    const gistUpdatedMs = gist.updated_at ? Date.parse(gist.updated_at) : Number.NaN;
    const defaultLastModified = Number.isNaN(gistUpdatedMs) ? undefined : gistUpdatedMs;

    const results = new Map<string, RemoteObjectStat>();

    for (const [flatName, entry] of Object.entries(files)) {
      if (!entry) continue;
      const decoded = decodeGistFilename(flatName);
      if (!decoded) continue;
      const segs = decoded.split('/').filter(Boolean);
      if (segs.length <= fullSegments.length) continue;

      let matchesPrefix = true;
      for (let i = 0; i < fullSegments.length; i += 1) {
        if (segs[i] !== fullSegments[i]) {
          matchesPrefix = false;
          break;
        }
      }
      if (!matchesPrefix) continue;

      const relSegs = segs.slice(rootSegments.length);
      const childName = segs[fullSegments.length];

      if (segs.length === fullSegments.length + 1) {
        let size = entry.size ?? 0;
        let etag: string | undefined;
        if (!entry.truncated && typeof entry.content === 'string') {
          try {
            const decodedBytes = base64ToBytes(entry.content.trim());
            size = decodedBytes.byteLength;
            etag = await sha256Hex(decodedBytes);
          } catch {
            // fallback to reported size
          }
        }
        const relPath = `/${relSegs.join('/')}`;
        results.set(relPath, {
          path: relPath,
          name: childName,
          isCollection: false,
          etag,
          size,
          lastModified: defaultLastModified,
          status: 200,
        });
      } else {
        const dirRelSegs = relSegs.slice(0, subSegments.length + 1);
        const dirPath = `/${dirRelSegs.join('/')}`;
        if (!results.has(dirPath)) {
          results.set(dirPath, {
            path: dirPath,
            name: childName,
            isCollection: true,
            size: 0,
            lastModified: defaultLastModified,
            status: 200,
          });
        }
      }
    }

    return Array.from(results.values());
  }

  async stat(subPath: string): Promise<RemoteObjectStat | null> {
    this.validateConfig();
    if (!this.config.gistId) {
      return null;
    }

    const { subSegments, fullSegments } = this.toFullSegments(subPath);
    const gist = await this.fetchGist();
    const files = gist.files ?? {};
    const gistUpdatedMs = gist.updated_at ? Date.parse(gist.updated_at) : Number.NaN;
    const defaultLastModified = Number.isNaN(gistUpdatedMs) ? undefined : gistUpdatedMs;

    if (subSegments.length === 0 && fullSegments.length === 0) {
      return {
        path: '/',
        name: '',
        isCollection: true,
        size: 0,
        lastModified: defaultLastModified,
        status: 200,
      };
    }

    if (fullSegments.length > 0) {
      const flatName = encodeGistFilename(fullSegments.join('/'));
      const exact = files[flatName];
      if (exact) {
        let size = exact.size ?? 0;
        let etag: string | undefined;
        if (!exact.truncated && typeof exact.content === 'string') {
          try {
            const decodedBytes = base64ToBytes(exact.content.trim());
            size = decodedBytes.byteLength;
            etag = await sha256Hex(decodedBytes);
          } catch {
            // keep fallback size
          }
        }
        return {
          path: subSegments.length > 0 ? `/${subSegments.join('/')}` : '/',
          name: subSegments[subSegments.length - 1] ?? '',
          isCollection: false,
          etag,
          size,
          lastModified: defaultLastModified,
          status: 200,
        };
      }
    }

    // Check if subPath represents a virtual directory containing files
    const fullPrefix = fullSegments.join('/');
    for (const [flatName, entry] of Object.entries(files)) {
      if (!entry) continue;
      const decoded = decodeGistFilename(flatName);
      if (!decoded) continue;
      if (!fullPrefix || decoded.startsWith(`${fullPrefix}/`)) {
        return {
          path: subSegments.length > 0 ? `/${subSegments.join('/')}` : '/',
          name: subSegments[subSegments.length - 1] ?? '',
          isCollection: true,
          size: 0,
          lastModified: defaultLastModified,
          status: 200,
        };
      }
    }

    return subSegments.length === 0
      ? {
          path: '/',
          name: '',
          isCollection: true,
          size: 0,
          lastModified: defaultLastModified,
          status: 200,
        }
      : null;
  }

  async getBytes(
    subPath: string,
    options?: { ifNoneMatch?: string },
  ): Promise<{
    notModified: boolean;
    bytes: Uint8Array;
    etag?: string;
    status: number;
  }> {
    this.validateConfig();
    const { subSegments, fullSegments } = this.toFullSegments(subPath);
    const displayPath = `/${subSegments.join('/')}`;
    if (!this.config.gistId) {
      throw createHttpStatusError(404, 'getBytes', displayPath);
    }

    const flatName = encodeGistFilename(fullSegments.join('/'));
    const gist = await this.fetchGist();
    const entry = gist.files?.[flatName];
    if (!entry) {
      throw createHttpStatusError(404, 'getBytes', displayPath);
    }

    const contentText = await this.resolveFileContent(entry, displayPath);
    const bytes = base64ToBytes(contentText.trim());
    const etag = await sha256Hex(bytes);

    if (options?.ifNoneMatch && normalizeEtag(options.ifNoneMatch) === etag) {
      return {
        notModified: true,
        bytes: new Uint8Array(0),
        etag,
        status: 304,
      };
    }

    return {
      notModified: false,
      bytes,
      etag,
      status: 200,
    };
  }

  async putBytes(
    subPath: string,
    bytes: Uint8Array,
    _options?: { ifMatch?: string; ifNoneMatchStar?: boolean; contentType?: string },
  ): Promise<{ etag?: string; status: number }> {
    const gistId = await this.ensureGistReady();
    const { subSegments, fullSegments } = this.toFullSegments(subPath);
    const displayPath = `/${subSegments.join('/')}`;
    const flatName = encodeGistFilename(fullSegments.join('/'));
    const base64Content = bytesToBase64(bytes);

    const res = await this.apiRequest({
      method: 'PATCH',
      path: `/gists/${encodeURIComponent(gistId)}`,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        files: {
          [flatName]: {
            content: base64Content,
          },
        },
      }),
      phase: 'putBytes',
    });

    if (res.status < 200 || res.status >= 300) {
      throw createHttpStatusError(res.status, 'putBytes', displayPath, res.headers.get('retry-after'));
    }

    const updated = (await res.json()) as GistApiResponse;
    this.assertPrivateGist(updated);
    this.cachedGistData = updated;
    this.cachedGistEtag = res.headers.get('etag') ?? undefined;

    const etag = await sha256Hex(bytes);
    return {
      etag,
      status: res.status,
    };
  }

  async delete(subPath: string, options?: { ifMatch?: string; isCollection?: boolean }): Promise<void> {
    this.validateConfig();
    if (!this.config.gistId) {
      return;
    }

    const gistId = this.config.gistId;
    const { subSegments, fullSegments } = this.toFullSegments(subPath);
    const displayPath = subSegments.length > 0 ? `/${subSegments.join('/')}` : '/';

    if (options?.isCollection) {
      const gist = await this.fetchGist(true);
      const files = gist.files ?? {};
      const prefix = fullSegments.join('/');
      const patchFiles: Record<string, null> = {};

      for (const [flatName, entry] of Object.entries(files)) {
        if (!entry) continue;
        const decoded = decodeGistFilename(flatName);
        if (!decoded) continue;
        if (!prefix || decoded === prefix || decoded.startsWith(`${prefix}/`)) {
          patchFiles[flatName] = null;
        }
      }

      if (Object.keys(patchFiles).length === 0) {
        return;
      }

      const res = await this.apiRequest({
        method: 'PATCH',
        path: `/gists/${encodeURIComponent(gistId)}`,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ files: patchFiles }),
        phase: 'delete',
      });

      if (res.status < 200 || res.status >= 300) {
        throw createHttpStatusError(res.status, 'delete', displayPath, res.headers.get('retry-after'));
      }

      const updated = (await res.json()) as GistApiResponse;
      this.assertPrivateGist(updated);
      this.cachedGistData = updated;
      this.cachedGistEtag = res.headers.get('etag') ?? undefined;
      return;
    }

    const flatName = encodeGistFilename(fullSegments.join('/'));
    const res = await this.apiRequest({
      method: 'PATCH',
      path: `/gists/${encodeURIComponent(gistId)}`,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        files: {
          [flatName]: null,
        },
      }),
      phase: 'delete',
    });

    if (res.status === 404) {
      return;
    }
    if (res.status < 200 || res.status >= 300) {
      throw createHttpStatusError(res.status, 'delete', displayPath, res.headers.get('retry-after'));
    }

    const updated = (await res.json()) as GistApiResponse;
    this.assertPrivateGist(updated);
    this.cachedGistData = updated;
    this.cachedGistEtag = res.headers.get('etag') ?? undefined;
  }

  async checkCapabilities(): Promise<CapabilityReport> {
    const startedAt = Date.now();
    const checks = createCapabilityChecksTemplate(GIST_CAPABILITY_STEPS);
    const setCheck = (
      stepNum: number,
      state: CapabilityReport['checks'][number]['state'],
      detail?: string,
      latencyMs?: number,
    ) => {
      const item = checks[stepNum - 1];
      item.state = state;
      if (detail !== undefined) item.detail = detail;
      if (latencyMs !== undefined) item.latencyMs = latencyMs;
    };

    try {
      this.validateConfig();
      setCheck(1, 'supported', 'Valid GitHub API endpoint & Personal Access Token');
    } catch (err) {
      const msg = describeAdapterError(err);
      setCheck(1, 'unsupported', msg);
      return buildCapabilityReport({
        startedAt,
        url: this.displayEndpoint,
        consistencyLevel: 'incompatible',
        overallOk: false,
        checks,
        summaryMessage: `GitHub Gist config validation failed: ${msg}`,
      });
    }

    const tGist = Date.now();
    try {
      const gistId = await this.ensureGistReady();
      setCheck(2, 'supported', `Verified private Secret Gist (${gistId})`, Date.now() - tGist);
    } catch (err) {
      const msg = describeAdapterError(err);
      setCheck(2, 'unsupported', msg, Date.now() - tGist);
      return buildCapabilityReport({
        startedAt,
        url: this.displayEndpoint,
        consistencyLevel: 'incompatible',
        overallOk: false,
        checks,
        summaryMessage: msg,
      });
    }

    const probeToken = bytesToHex(generateRandomBytes(6));
    const probeDir = `sm_probe_${probeToken}`;
    const basicFile = `${probeDir}/basic.enc`;
    const shaFile = `${probeDir}/sha_check.enc`;
    const size64File = `${probeDir}/size_64k.enc`;

    let basicOk = true;
    let abortMsg: string | undefined;

    try {
      const probeBytes = new TextEncoder().encode(`sessionmesh-gist-probe:${probeToken}`);
      const tPut = Date.now();
      try {
        const putRes = await this.putBytes(basicFile, probeBytes);
        setCheck(3, 'supported', `HTTP ${putRes.status}`, Date.now() - tPut);
      } catch (err) {
        basicOk = false;
        abortMsg = `GitHub Gist probe write failed: ${describeAdapterError(err)}`;
        setCheck(3, 'unsupported', describeAdapterError(err), Date.now() - tPut);
      }

      if (basicOk) {
        const tGet = Date.now();
        try {
          const got = await this.getBytes(basicFile);
          if (got.bytes.byteLength === probeBytes.byteLength) {
            setCheck(4, 'supported', `Decoded ${got.bytes.byteLength} bytes`, Date.now() - tGet);
          } else {
            basicOk = false;
            abortMsg = 'GitHub Gist Base64 decode length mismatch';
            setCheck(4, 'unsupported', abortMsg, Date.now() - tGet);
          }
        } catch (err) {
          basicOk = false;
          abortMsg = `GitHub Gist probe read failed: ${describeAdapterError(err)}`;
          setCheck(4, 'unsupported', describeAdapterError(err), Date.now() - tGet);
        }
      }

      if (basicOk) {
        const tSha = Date.now();
        try {
          const sample = new Uint8Array(512);
          for (let i = 0; i < 256; i += 1) sample[i] = i;
          sample.set(generateRandomBytes(256), 256);
          const expectedHash = await sha256Hex(sample);
          await this.putBytes(shaFile, sample);
          const readBack = await this.getBytes(shaFile);
          const actualHash = await sha256Hex(readBack.bytes);
          if (actualHash === expectedHash) {
            setCheck(5, 'supported', `SHA-256 verified (${expectedHash.slice(0, 12)}...)`, Date.now() - tSha);
          } else {
            basicOk = false;
            setCheck(5, 'unsupported', 'Binary payload SHA-256 mismatch', Date.now() - tSha);
          }
        } catch (err) {
          basicOk = false;
          setCheck(5, 'unsupported', describeAdapterError(err), Date.now() - tSha);
        }

        const t64 = Date.now();
        try {
          const p64 = generateRandomBytes(64 * 1024);
          const h64 = await sha256Hex(p64);
          await this.putBytes(size64File, p64);
          const r64 = await this.getBytes(size64File);
          if (r64.bytes.byteLength === p64.byteLength && (await sha256Hex(r64.bytes)) === h64) {
            setCheck(6, 'supported', '64KB binary Base64 round-trip SHA-256 verified', Date.now() - t64);
          } else {
            basicOk = false;
            setCheck(6, 'unsupported', '64KB payload corruption detected', Date.now() - t64);
          }
        } catch (err) {
          basicOk = false;
          setCheck(6, 'unsupported', describeAdapterError(err), Date.now() - t64);
        }
      }
    } finally {
      const tClean = Date.now();
      try {
        await this.delete(probeDir, { isCollection: true });
        setCheck(7, 'supported', `Cleaned up probe files in ${probeDir}`, Date.now() - tClean);
      } catch (err) {
        setCheck(7, 'unsupported', describeAdapterError(err), Date.now() - tClean);
      }
    }

    if (!basicOk || abortMsg) {
      return buildCapabilityReport({
        startedAt,
        url: this.displayEndpoint,
        consistencyLevel: 'incompatible',
        overallOk: false,
        checks,
        summaryMessage: abortMsg ?? 'GitHub Gist failed core read/write checks.',
      });
    }

    return buildCapabilityReport({
      startedAt,
      url: this.displayEndpoint,
      consistencyLevel: 'append_only_degraded',
      overallOk: true,
      checks,
      resolvedGistId: this.config.gistId,
      summaryMessage:
        'Private GitHub Gist verified successfully. Operating in append-only degraded consistency mode (per-file CAS headers are unsupported by Gist API).',
    });
  }
}
