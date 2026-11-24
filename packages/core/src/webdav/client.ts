/**
 * RFC 4918 WebDAV Client — MV3 Service Worker & Node compatible.
 * Enforces HTTPS by default, handles Basic/App-Password/Bearer auth without leaking secrets,
 * supports conditional writes (If-Match, If-None-Match: *), ETag caching (304),
 * idempotent recursive ensureDir, and strict 404 vs error differentiation.
 */
import type { WebDAVConfig, WebDAVResourceStat } from '../types';
import { base64ToBytes, bytesToBase64, bytesToUtf8, utf8ToBytes } from '../crypto/encoding';
import { createHttpStatusError, WebDAVHttpError } from './errors';
import { normalizeEtag, parseWebDAVMultistatusXml } from './xml';

export interface WebDAVClientOptions {
  fetchImpl?: typeof fetch;
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:resourcetype/>
    <D:getetag/>
    <D:getcontentlength/>
    <D:getlastmodified/>
    <D:quota-used-bytes/>
    <D:quota-available-bytes/>
  </D:prop>
</D:propfind>`;

function isLocalhostHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'localhost' || lower === '127.0.0.1' || lower === '[::1]' || lower === '::1';
}

function splitCleanSegments(pathStr: string): string[] {
  const raw = (pathStr || '').split('/');
  const out: string[] = [];
  for (const seg of raw) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      throw new WebDAVHttpError({
        status: 400,
        code: 'WEBDAV_INVALID_PATH',
        phase: 'validate_path',
        message: `Path traversal ("..") is not permitted in WebDAV path: ${pathStr}`,
        retryable: false,
        suggestion: 'Use a valid relative path without ".." segments.',
      });
    }
    out.push(seg);
  }
  return out;
}

function formatHeaderEtag(etag: string): string {
  const trimmed = etag.trim();
  if (trimmed === '*') return '*';
  const normalized = normalizeEtag(trimmed) ?? trimmed;
  return `"${normalized}"`;
}

export class WebDAVClient {
  readonly config: WebDAVConfig;
  private readonly customFetch?: typeof fetch;

  constructor(config: WebDAVConfig, options?: WebDAVClientOptions) {
    this.config = { ...config };
    this.customFetch = options?.fetchImpl;
  }

  setStorageFormat(format: 'binary_enc' | 'base64_txt'): void {
    this.config.storageFormat = format;
  }

  private isBase64TxtMode(): boolean {
    return this.config.storageFormat === 'base64_txt';
  }

  private toWireSubPath(subPath: string): string {
    if (this.isBase64TxtMode() && subPath.endsWith('.enc')) {
      return `${subPath.slice(0, -4)}.txt`;
    }
    return subPath;
  }

  private fromWireStat(stat: WebDAVResourceStat): WebDAVResourceStat {
    if (this.isBase64TxtMode() && !stat.isCollection && stat.path.endsWith('.txt')) {
      return {
        ...stat,
        path: `${stat.path.slice(0, -4)}.enc`,
        name: stat.name.endsWith('.txt') ? `${stat.name.slice(0, -4)}.enc` : stat.name,
      };
    }
    return stat;
  }

  validateUrl(): void {
    let parsed: URL;
    try {
      parsed = new URL(this.config.url);
    } catch {
      throw new WebDAVHttpError({
        status: 0,
        code: 'WEBDAV_INVALID_URL',
        phase: 'validate_url',
        message: `Invalid WebDAV URL: "${this.config.url}"`,
        retryable: false,
        suggestion: 'Enter a valid full HTTPS WebDAV URL, e.g. https://dav.example.com/dav/',
      });
    }

    if (parsed.protocol === 'https:') {
      return;
    }

    if (
      parsed.protocol === 'http:' &&
      this.config.allowInsecureLocalhostForTesting === true &&
      isLocalhostHostname(parsed.hostname)
    ) {
      return;
    }

    if (parsed.protocol === 'http:') {
      throw new WebDAVHttpError({
        status: 0,
        code: 'WEBDAV_INSECURE_HTTP',
        phase: 'validate_url',
        message: 'Insecure http:// WebDAV URLs are forbidden; HTTPS is required.',
        retryable: false,
        suggestion: 'Update the WebDAV server URL to use https://.',
      });
    }

    throw new WebDAVHttpError({
      status: 0,
      code: 'WEBDAV_INVALID_PROTOCOL',
      phase: 'validate_url',
      message: `Unsupported WebDAV URL protocol: "${parsed.protocol}"`,
      retryable: false,
      suggestion: 'Use an https:// WebDAV URL.',
    });
  }

  private getParsedBase(): {
    origin: string;
    mountSegments: string[];
    rootSegments: string[];
    basePath: string;
  } {
    this.validateUrl();
    const parsed = new URL(this.config.url);
    const mountSegments = splitCleanSegments(
      parsed.pathname
        .split('/')
        .map((s) => {
          try {
            return decodeURIComponent(s);
          } catch {
            return s;
          }
        })
        .join('/'),
    );
    const rootSegments = splitCleanSegments(this.config.rootPath || '');
    const allBase = [...mountSegments, ...rootSegments];
    const basePath = allBase.length > 0 ? `/${allBase.join('/')}` : '/';
    return {
      origin: parsed.origin,
      mountSegments,
      rootSegments,
      basePath,
    };
  }

  private buildUrlFromSegments(origin: string, segments: string[], trailingSlash = false): string {
    const encodedPath = segments.length > 0 ? `/${segments.map((s) => encodeURIComponent(s)).join('/')}` : '/';
    if (trailingSlash && !encodedPath.endsWith('/')) {
      return `${origin}${encodedPath}/`;
    }
    return `${origin}${encodedPath}`;
  }

  private resolveTarget(subPath = '', trailingSlash = false): { url: string; displayPath: string; basePath: string } {
    const { origin, mountSegments, rootSegments, basePath } = this.getParsedBase();
    const wireSubPath = this.toWireSubPath(subPath);
    const subSegments = splitCleanSegments(wireSubPath);
    const url = this.buildUrlFromSegments(origin, [...mountSegments, ...rootSegments, ...subSegments], trailingSlash);
    const displayPath = subSegments.length > 0 ? `/${subSegments.join('/')}` : '/';
    return { url, displayPath, basePath };
  }

  private buildAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.config.authType === 'bearer') {
      if (this.config.bearerToken) {
        headers['Authorization'] = `Bearer ${this.config.bearerToken}`;
      }
    } else {
      // 'basic' or 'app_password' both use HTTP Basic Auth
      if (this.config.username !== undefined || this.config.password !== undefined) {
        const rawCreds = `${this.config.username ?? ''}:${this.config.password ?? ''}`;
        headers['Authorization'] = `Basic ${bytesToBase64(utf8ToBytes(rawCreds))}`;
      }
    }
    return headers;
  }

  private async performFetch(
    method: string,
    url: string,
    phase: string,
    displayPath: string,
    extraHeaders?: Record<string, string>,
    body?: BodyInit | Uint8Array,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      ...this.buildAuthHeaders(),
      ...(extraHeaders ?? {}),
    };

    const timeoutMs = this.config.requestTimeoutMs ?? 30_000;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (typeof AbortController !== 'undefined' && timeoutMs > 0) {
      controller = new AbortController();
      timer = setTimeout(() => controller?.abort(), timeoutMs);
    }

    const fetchFn = this.customFetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

    let bodyToSend: BodyInit | undefined;
    if (body instanceof Uint8Array) {
      // Create an ArrayBuffer-backed copy/view so Node & Browser fetch always send exact byteLength
      const copy = new Uint8Array(body.byteLength);
      copy.set(body);
      bodyToSend = copy;
    } else {
      bodyToSend = body;
    }

    try {
      const response = await fetchFn(url, {
        method,
        headers,
        body: bodyToSend,
        signal: controller?.signal,
      });
      return response;
    } catch (err: unknown) {
      const isAbort =
        err instanceof Error && (err.name === 'AbortError' || err.message.toLowerCase().includes('aborted'));
      if (isAbort) {
        throw new WebDAVHttpError({
          status: 0,
          code: 'WEBDAV_TIMEOUT',
          phase,
          message: `WebDAV ${phase} timed out after ${timeoutMs}ms (${displayPath})`,
          retryable: true,
          suggestion: 'Check network latency or increase the WebDAV request timeout.',
        });
      }
      const errMsg = err instanceof Error ? err.message : 'Network error';
      throw new WebDAVHttpError({
        status: 0,
        code: 'WEBDAV_NETWORK_ERROR',
        phase,
        message: `WebDAV ${phase} network error (${displayPath}): ${errMsg}`,
        retryable: true,
        suggestion: 'Check your internet connection, DNS, TLS certificate, and WebDAV server availability.',
      });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  async options(subPath = ''): Promise<{ allow: string[]; dav: string[]; status: number }> {
    const { url, displayPath } = this.resolveTarget(subPath);
    const res = await this.performFetch('OPTIONS', url, 'options', displayPath);
    if (res.status < 200 || res.status >= 300) {
      throw createHttpStatusError(res.status, 'options', displayPath, res.headers.get('retry-after'));
    }
    const allowHeader = res.headers.get('allow') ?? '';
    const davHeader = res.headers.get('dav') ?? '';
    const allow = allowHeader
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const dav = davHeader
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return { allow, dav, status: res.status };
  }

  async propfind(subPath: string, depth: 0 | 1 = 1): Promise<WebDAVResourceStat[]> {
    // Collections (depth=1 or root '') prefer trailing slash to avoid Nginx/Apache 301 -> GET downgrade
    const preferSlash = depth === 1 || !subPath || subPath === '/';
    const primary = this.resolveTarget(subPath, preferSlash);
    let res = await this.performFetch(
      'PROPFIND',
      primary.url,
      'propfind',
      primary.displayPath,
      {
        Depth: String(depth),
        'Content-Type': 'application/xml; charset=utf-8',
      },
      PROPFIND_BODY,
    );

    // Fallback with opposite trailing-slash convention if a strict gateway returns 400/404/405
    if (res.status === 400 || res.status === 404 || res.status === 405) {
      const alt = this.resolveTarget(subPath, !preferSlash);
      if (alt.url !== primary.url) {
        const altRes = await this.performFetch(
          'PROPFIND',
          alt.url,
          'propfind',
          alt.displayPath,
          {
            Depth: String(depth),
            'Content-Type': 'application/xml; charset=utf-8',
          },
          PROPFIND_BODY,
        );
        if (altRes.status === 207 || (altRes.status >= 200 && altRes.status < 300)) {
          res = altRes;
        }
      }
    }

    if (res.status !== 207 && (res.status < 200 || res.status >= 300)) {
      throw createHttpStatusError(res.status, 'propfind', primary.displayPath, res.headers.get('retry-after'));
    }

    const expectedSubSegments = splitCleanSegments(this.toWireSubPath(subPath));
    const effectiveBase =
      expectedSubSegments.length > 0
        ? `${primary.basePath === '/' ? '' : primary.basePath}/${expectedSubSegments.join('/')}`
        : primary.basePath;

    const xmlText = await res.text();
    const parsed = parseWebDAVMultistatusXml(xmlText, primary.basePath);
    // Normalize self entry if effectiveBase is a subdirectory
    void effectiveBase;
    return this.isBase64TxtMode() ? parsed.map((s) => this.fromWireStat(s)) : parsed;
  }

  async stat(subPath: string): Promise<WebDAVResourceStat | null> {
    try {
      const items = await this.propfind(subPath, 0);
      if (items.length === 0) return null;
      const first = items[0];
      if (first.status === 404) return null;
      return first;
    } catch (err) {
      // ONLY return null on a genuine 404; rethrow 401/403/5xx/offline/etc.
      if (err instanceof WebDAVHttpError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  async mkcol(subPath: string): Promise<void> {
    const { url, displayPath } = this.resolveTarget(subPath, true);
    let res = await this.performFetch('MKCOL', url, 'mkcol', displayPath);
    if (res.status === 400 || res.status === 404 || res.status === 405) {
      const noSlash = this.resolveTarget(subPath, false);
      if (noSlash.url !== url) {
        const retryRes = await this.performFetch('MKCOL', noSlash.url, 'mkcol', displayPath);
        if (retryRes.status === 200 || retryRes.status === 201 || retryRes.status === 202 || retryRes.status === 204) {
          return;
        }
        if (res.status !== 405) {
          res = retryRes;
        }
      }
    }
    if (res.status === 200 || res.status === 201 || res.status === 202 || res.status === 204) {
      return;
    }
    throw createHttpStatusError(res.status, 'mkcol', displayPath, res.headers.get('retry-after'));
  }

  async ensureDir(subPath: string): Promise<void> {
    const { origin, mountSegments, rootSegments } = this.getParsedBase();
    const subSegments = splitCleanSegments(subPath);

    // Fast path: check if target directory already exists
    const existing = await this.stat(subPath);
    if (existing) {
      if (!existing.isCollection) {
        throw new WebDAVHttpError({
          status: 409,
          code: 'WEBDAV_CONFLICT',
          phase: 'ensureDir',
          message: `Cannot ensure directory "${subPath}": a non-collection resource already exists at this path`,
          retryable: false,
          suggestion: 'Choose a different path or remove the conflicting file.',
        });
      }
      return;
    }

    const tryMkcol = async (segments: string[], displayPath: string): Promise<number> => {
      const url = this.buildUrlFromSegments(origin, segments, true);
      const res = await this.performFetch('MKCOL', url, 'ensureDir', displayPath);
      if (
        res.status === 200 ||
        res.status === 201 ||
        res.status === 204 ||
        res.status === 405 ||
        res.status === 301 ||
        res.status === 302
      ) {
        return res.status;
      }
      if (res.status === 409) {
        return 409;
      }
      throw createHttpStatusError(res.status, 'ensureDir', displayPath, res.headers.get('retry-after'));
    };

    const ensureMountSegments = async (): Promise<void> => {
      const cur: string[] = [];
      for (const seg of mountSegments) {
        cur.push(seg);
        const st = await tryMkcol(cur, `/${cur.join('/')}`);
        if (st === 409) {
          throw createHttpStatusError(409, 'ensureDir', `/${cur.join('/')}`);
        }
      }
    };

    const relativeToMount = [...rootSegments, ...subSegments];
    if (relativeToMount.length === 0) {
      if (mountSegments.length > 0) {
        await ensureMountSegments();
      }
      return;
    }

    // Create missing segments progressively starting from rootPath segments down to subPath segments.
    // Only create mountSegments on demand if the server returns 409 for missing parent mount path.
    const current: string[] = [...mountSegments];
    let ensuredMount = false;

    for (const seg of relativeToMount) {
      current.push(seg);
      const displayPath = `/${current.slice(mountSegments.length).join('/')}`;
      const status = await tryMkcol(current, displayPath);
      if (status === 409) {
        if (!ensuredMount && mountSegments.length > 0) {
          ensuredMount = true;
          await ensureMountSegments();
          const retryStatus = await tryMkcol(current, displayPath);
          if (retryStatus !== 409) {
            continue;
          }
        }
        throw createHttpStatusError(409, 'ensureDir', displayPath);
      }
    }
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
    const { url, displayPath } = this.resolveTarget(subPath);
    const headers: Record<string, string> = {};
    if (options?.ifNoneMatch) {
      headers['If-None-Match'] = formatHeaderEtag(options.ifNoneMatch);
    }

    let res = await this.performFetch('GET', url, 'getBytes', displayPath, headers);
    // Some cloud WebDAV gateways (S3/Alist/IIS) reject If-None-Match with 400/501; retry plain GET
    if (options?.ifNoneMatch && (res.status === 400 || res.status === 501)) {
      res = await this.performFetch('GET', url, 'getBytes', displayPath, {});
    }
    const etag = normalizeEtag(res.headers.get('etag') ?? res.headers.get('oc-etag'));

    if (res.status === 304) {
      return {
        notModified: true,
        bytes: new Uint8Array(0),
        etag: etag ?? normalizeEtag(options?.ifNoneMatch),
        status: 304,
      };
    }

    if (res.status < 200 || res.status >= 300) {
      throw createHttpStatusError(res.status, 'getBytes', displayPath, res.headers.get('retry-after'));
    }

    const buf = await res.arrayBuffer();
    const rawBytes = new Uint8Array(buf);
    if (this.isBase64TxtMode()) {
      const text = bytesToUtf8(rawBytes).trim();
      const decoded = base64ToBytes(text);
      return {
        notModified: false,
        bytes: decoded,
        etag,
        status: res.status,
      };
    }
    return {
      notModified: false,
      bytes: rawBytes,
      etag,
      status: res.status,
    };
  }

  async putBytes(
    subPath: string,
    bytes: Uint8Array,
    options?: { ifMatch?: string; ifNoneMatchStar?: boolean; contentType?: string },
  ): Promise<{ etag?: string; status: number }> {
    const { url, displayPath } = this.resolveTarget(subPath);
    const useTxt = this.isBase64TxtMode();
    const wireBytes = useTxt ? utf8ToBytes(bytesToBase64(bytes)) : bytes;
    const effectiveContentType = useTxt
      ? 'text/plain; charset=utf-8'
      : options?.contentType ?? 'application/octet-stream';
    const headers: Record<string, string> = {
      'Content-Type': effectiveContentType,
    };
    const hasConditional = Boolean(options?.ifMatch || options?.ifNoneMatchStar);
    if (options?.ifMatch) {
      headers['If-Match'] = formatHeaderEtag(options.ifMatch);
    }
    if (options?.ifNoneMatchStar) {
      headers['If-None-Match'] = '*';
    }

    let res = await this.performFetch('PUT', url, 'putBytes', displayPath, headers, wireBytes);
    // Universal fallback: if a non-CAS WebDAV gateway (Alist cloud driver, pCloud, IIS, Box) rejects
    // If-Match / If-None-Match headers with HTTP 400 or 501 (NOT 412!), retry plain PUT.
    if (hasConditional && (res.status === 400 || res.status === 501)) {
      res = await this.performFetch(
        'PUT',
        url,
        'putBytes',
        displayPath,
        { 'Content-Type': effectiveContentType },
        wireBytes,
      );
    }
    if (res.status !== 200 && res.status !== 201 && res.status !== 202 && res.status !== 204) {
      throw createHttpStatusError(res.status, 'putBytes', displayPath, res.headers.get('retry-after'));
    }

    return {
      etag: normalizeEtag(res.headers.get('etag') ?? res.headers.get('oc-etag')),
      status: res.status,
    };
  }

  async delete(subPath: string, options?: { ifMatch?: string; isCollection?: boolean }): Promise<void> {
    const preferSlash = Boolean(options?.isCollection);
    const { url, displayPath } = this.resolveTarget(subPath, preferSlash);
    const headers: Record<string, string> = {};
    if (options?.ifMatch) {
      headers['If-Match'] = formatHeaderEtag(options.ifMatch);
    }

    let res = await this.performFetch('DELETE', url, 'delete', displayPath, headers);
    if (preferSlash && (res.status === 400 || res.status === 404 || res.status === 405)) {
      const noSlash = this.resolveTarget(subPath, false);
      if (noSlash.url !== url) {
        const retryRes = await this.performFetch('DELETE', noSlash.url, 'delete', displayPath, headers);
        if (retryRes.status === 200 || retryRes.status === 202 || retryRes.status === 204) {
          return;
        }
      }
    }
    if (res.status === 200 || res.status === 202 || res.status === 204) {
      return;
    }
    throw createHttpStatusError(res.status, 'delete', displayPath, res.headers.get('retry-after'));
  }

  async move(fromSubPath: string, toSubPath: string, overwrite = true): Promise<void> {
    const from = this.resolveTarget(fromSubPath);
    const to = this.resolveTarget(toSubPath);
    const res = await this.performFetch('MOVE', from.url, 'move', from.displayPath, {
      Destination: to.url,
      Overwrite: overwrite ? 'T' : 'F',
    });
    if (res.status === 200 || res.status === 201 || res.status === 204) {
      return;
    }
    throw createHttpStatusError(res.status, 'move', from.displayPath, res.headers.get('retry-after'));
  }
}
