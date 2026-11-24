/**
 * Programmable RFC 4918 Mock WebDAV Server for SessionMesh acceptance & integration testing.
 * Supports both zero-network in-memory `fetchImpl` and real Node HTTP server (`startHttpServer`)
 * with full CORS headers, 4 XML namespace styles, conditional CAS headers, and fault injection quirks.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

export interface MockWebDAVQuirks {
  requireAuth?: {
    username: string;
    password?: string;
    bearerToken?: string;
    readOnlyUsers?: Record<string, string>;
  };
  ignoreConditionalHeaders?: boolean; // simulates W-012 weak server
  weakEtags?: boolean; // emits W/"..."
  xmlNamespaceStyle?: 'D_upper' | 'd_lower' | 'default_xmlns' | 'nextcloud';
  offline?: boolean; // simulates W-013/W-014
  storageQuotaBytes?: number; // simulates 507 Insufficient Storage (W-016)
  lockedPaths?: Set<string>; // simulates 423 Locked
  rateLimitRemaining?: number; // simulates 429 Too Many Requests
  corruptReadsForPaths?: Set<string>; // simulates W-015 bit-flip / corrupt ciphertext
  artificialLatencyMs?: number;
  forbidDotFiles?: boolean; // simulates Nginx `location ~ /\. { deny all; }` / Nextcloud hidden-file 403
  silentPutDropExtensions?: string[] | '*'; // simulates YetiShare / hubu.cloud returning fake 201 + ETag:1 without storing
}

interface CollectionNode {
  kind: 'collection';
  etag: string;
  lastModified: number;
}

interface FileNode {
  kind: 'file';
  data: Uint8Array;
  contentType: string;
  etag: string;
  lastModified: number;
}

type StoredNode = CollectionNode | FileNode;

interface InternalResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

const WRITE_METHODS = new Set(['MKCOL', 'PUT', 'DELETE', 'MOVE']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeStorePath(rawPath: string): string {
  let pathname = rawPath;
  if (/^https?:\/\//i.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname;
    } catch {
      // keep raw
    }
  }
  const qIdx = pathname.indexOf('?');
  if (qIdx !== -1) pathname = pathname.slice(0, qIdx);

  const decoded = pathname
    .split('/')
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/');

  const collapsed = decoded.replace(/\/{2,}/g, '/');
  if (!collapsed || collapsed === '/') return '/';
  const withLeading = collapsed.startsWith('/') ? collapsed : `/${collapsed}`;
  return withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading;
}

function encodeHrefPath(normPath: string, isCollection: boolean): string {
  if (normPath === '/') return '/';
  const encoded = `/${normPath
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/')}`;
  return isCollection ? `${encoded}/` : encoded;
}

function getParentPath(normPath: string): string {
  if (normPath === '/') return '/';
  const idx = normPath.lastIndexOf('/');
  if (idx <= 0) return '/';
  return normPath.slice(0, idx);
}

function normalizeEtagToken(etag: string): string {
  let s = etag.trim();
  if (s.startsWith('W/') || s.startsWith('w/')) {
    s = s.slice(2).trim();
  }
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function etagHeaderMatches(headerValue: string, currentEtag: string): boolean {
  const parts = headerValue
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  for (const part of parts) {
    if (part === '*') return true;
    if (normalizeEtagToken(part) === currentEtag) return true;
  }
  return false;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function pathMatchesSet(normPath: string, set?: Set<string>): boolean {
  if (!set || set.size === 0) return false;
  for (const entry of set) {
    const normEntry = normalizeStorePath(entry);
    if (normPath === normEntry || normPath.startsWith(`${normEntry}/`)) {
      return true;
    }
  }
  return false;
}

function buildCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'OPTIONS, PROPFIND, MKCOL, GET, HEAD, PUT, DELETE, MOVE',
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, Depth, Destination, Overwrite, If-Match, If-None-Match',
    'Access-Control-Expose-Headers': 'ETag, DAV, Allow, Retry-After',
  };
}

export class MockWebDAVServer {
  quirks: MockWebDAVQuirks;
  requestCount = 0;
  methodCounts: Record<string, number> = {};

  private readonly nodes = new Map<string, StoredNode>();
  private etagCounter = 1;

  readonly fetchImpl: typeof fetch;

  constructor(quirks: MockWebDAVQuirks = {}) {
    this.quirks = { ...quirks };
    this.nodes.set('/', {
      kind: 'collection',
      etag: this.nextEtag('root'),
      lastModified: Date.now(),
    });

    this.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const urlStr =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();

      const headersMap = new Map<string, string>();
      if (typeof input === 'object' && 'headers' in input && input.headers) {
        input.headers.forEach((v, k) => headersMap.set(k.toLowerCase(), v));
      }
      if (init?.headers) {
        new Headers(init.headers).forEach((v, k) => headersMap.set(k.toLowerCase(), v));
      }

      const bodyBytes = await this.extractBodyBytes(init?.body ?? (typeof input === 'object' && 'arrayBuffer' in input ? input : null));

      if (init?.signal?.aborted) {
        const abortErr = new Error('The operation was aborted.');
        abortErr.name = 'AbortError';
        throw abortErr;
      }

      const res = await this.handleRequest(method, urlStr, headersMap, bodyBytes, init?.signal ?? undefined);

      // Fetch Response forbids a non-null body on 204/304 status codes
      const isNullBodyStatus = res.status === 204 || res.status === 304;
      let responseBody: BodyInit | null = null;
      if (!isNullBodyStatus && res.body !== null) {
        const copy = new Uint8Array(res.body.byteLength);
        copy.set(res.body);
        responseBody = copy;
      }
      return new Response(responseBody, {
        status: res.status,
        headers: res.headers,
      });
    }) as typeof fetch;
  }

  private async extractBodyBytes(body: unknown): Promise<Uint8Array> {
    if (body === null || body === undefined) return new Uint8Array(0);
    if (body instanceof Uint8Array) {
      return new Uint8Array(body);
    }
    if (body instanceof ArrayBuffer) {
      return new Uint8Array(body.slice(0));
    }
    if (ArrayBuffer.isView(body)) {
      return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    }
    if (typeof body === 'string') {
      return new TextEncoder().encode(body);
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      return new Uint8Array(await body.arrayBuffer());
    }
    if (typeof body === 'object' && 'arrayBuffer' in body && typeof (body as Request).arrayBuffer === 'function') {
      try {
        const buf = await (body as Request).arrayBuffer();
        return new Uint8Array(buf);
      } catch {
        return new Uint8Array(0);
      }
    }
    return new Uint8Array(0);
  }

  private nextEtag(seed: string | Uint8Array): string {
    const seq = this.etagCounter++;
    const hash = crypto
      .createHash('sha256')
      .update(typeof seed === 'string' ? seed : Buffer.from(seed))
      .update(`:${seq}`)
      .digest('hex')
      .slice(0, 12);
    return `sm-${seq}-${hash}`;
  }

  private formatEtag(rawEtag: string): string {
    return this.quirks.weakEtags ? `W/"${rawEtag}"` : `"${rawEtag}"`;
  }

  private getUsedBytes(): number {
    let total = 0;
    for (const node of this.nodes.values()) {
      if (node.kind === 'file') {
        total += node.data.byteLength;
      }
    }
    return total;
  }

  resetStats(): void {
    this.requestCount = 0;
    this.methodCounts = {};
  }

  corruptFile(path: string): void {
    const normPath = normalizeStorePath(path);
    const node = this.nodes.get(normPath);
    if (!node || node.kind !== 'file') {
      throw new Error(`MockWebDAVServer.corruptFile: File not found at "${normPath}"`);
    }
    if (node.data.byteLength === 0) {
      node.data = new Uint8Array([0xff, 0x00, 0xfe]);
    } else {
      const corrupted = new Uint8Array(node.data);
      // Flip last byte (inside GCM authentication tag / ciphertext)
      corrupted[corrupted.byteLength - 1] ^= 0xff;
      node.data = corrupted;
    }
  }

  getStoredRawBytes(path: string): Uint8Array | undefined {
    const normPath = normalizeStorePath(path);
    const node = this.nodes.get(normPath);
    if (!node || node.kind !== 'file') return undefined;
    return new Uint8Array(node.data);
  }

  listAllStoredPaths(): string[] {
    return Array.from(this.nodes.keys())
      .filter((p) => p !== '/')
      .sort();
  }

  private authenticate(headers: Map<string, string>): { ok: boolean; readOnly: boolean } {
    const reqAuth = this.quirks.requireAuth;
    if (!reqAuth) return { ok: true, readOnly: false };

    const authHeader = headers.get('authorization');
    if (!authHeader) return { ok: false, readOnly: false };

    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (reqAuth.bearerToken && token === reqAuth.bearerToken) {
        return { ok: true, readOnly: false };
      }
      return { ok: false, readOnly: false };
    }

    if (authHeader.startsWith('Basic ')) {
      const b64 = authHeader.slice(6).trim();
      let decoded = '';
      try {
        decoded = Buffer.from(b64, 'base64').toString('utf8');
      } catch {
        return { ok: false, readOnly: false };
      }
      const colonIdx = decoded.indexOf(':');
      const user = colonIdx === -1 ? decoded : decoded.slice(0, colonIdx);
      const pass = colonIdx === -1 ? '' : decoded.slice(colonIdx + 1);

      if (user === reqAuth.username && pass === (reqAuth.password ?? '')) {
        return { ok: true, readOnly: false };
      }
      if (
        reqAuth.readOnlyUsers &&
        Object.prototype.hasOwnProperty.call(reqAuth.readOnlyUsers, user) &&
        reqAuth.readOnlyUsers[user] === pass
      ) {
        return { ok: true, readOnly: true };
      }
      return { ok: false, readOnly: false };
    }

    return { ok: false, readOnly: false };
  }

  private renderMultistatusXml(entries: Array<[string, StoredNode]>): string {
    const style = this.quirks.xmlNamespaceStyle ?? 'D_upper';
    const usedBytes = this.getUsedBytes();
    const availableBytes =
      typeof this.quirks.storageQuotaBytes === 'number'
        ? Math.max(0, this.quirks.storageQuotaBytes - usedBytes)
        : 10 * 1024 * 1024 * 1024; // 10 GiB default

    const pfx =
      style === 'D_upper'
        ? 'D:'
        : style === 'd_lower' || style === 'nextcloud'
          ? 'd:'
          : '';

    const rootAttrs =
      style === 'D_upper'
        ? 'xmlns:D="DAV:"'
        : style === 'd_lower'
          ? 'xmlns:d="DAV:"'
          : style === 'default_xmlns'
            ? 'xmlns="DAV:"'
            : 'xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"';

    const responseBlocks = entries.map(([path, node]) => {
      const isCol = node.kind === 'collection';
      const href = escapeXml(encodeHrefPath(path, isCol));
      const etagText = escapeXml(this.formatEtag(node.etag));
      const lastMod = escapeXml(new Date(node.lastModified).toUTCString());

      const props: string[] = [];
      if (isCol) {
        props.push(`<${pfx}resourcetype><${pfx}collection/></${pfx}resourcetype>`);
        props.push(`<${pfx}quota-used-bytes>${usedBytes}</${pfx}quota-used-bytes>`);
        props.push(`<${pfx}quota-available-bytes>${availableBytes}</${pfx}quota-available-bytes>`);
        if (style === 'nextcloud') {
          props.push(`<oc:size>${usedBytes}</oc:size>`);
          props.push(`<oc:permissions>RGDNVCK</oc:permissions>`);
        }
      } else {
        props.push(`<${pfx}resourcetype/>`);
        props.push(`<${pfx}getcontentlength>${node.data.byteLength}</${pfx}getcontentlength>`);
        if (style === 'nextcloud') {
          props.push(`<oc:size>${node.data.byteLength}</oc:size>`);
          props.push(`<nc:has-preview>false</nc:has-preview>`);
        }
      }
      props.push(`<${pfx}getetag>${etagText}</${pfx}getetag>`);
      props.push(`<${pfx}getlastmodified>${lastMod}</${pfx}getlastmodified>`);

      const extra404Propstat =
        style === 'nextcloud' && isCol
          ? `<${pfx}propstat><${pfx}prop><${pfx}getcontentlength/></${pfx}prop><${pfx}status>HTTP/1.1 404 Not Found</${pfx}status></${pfx}propstat>`
          : '';

      return `<${pfx}response><${pfx}href>${href}</${pfx}href><${pfx}propstat><${pfx}prop>${props.join('')}</${pfx}prop><${pfx}status>HTTP/1.1 200 OK</${pfx}status></${pfx}propstat>${extra404Propstat}</${pfx}response>`;
    });

    return `<?xml version="1.0" encoding="utf-8"?><${pfx}multistatus ${rootAttrs}>${responseBlocks.join('')}</${pfx}multistatus>`;
  }

  private async handleRequest(
    method: string,
    rawUrl: string,
    headers: Map<string, string>,
    body: Uint8Array,
    signal?: AbortSignal,
  ): Promise<InternalResponse> {
    this.requestCount += 1;
    this.methodCounts[method] = (this.methodCounts[method] ?? 0) + 1;

    if (this.quirks.artificialLatencyMs && this.quirks.artificialLatencyMs > 0) {
      await sleep(this.quirks.artificialLatencyMs);
      if (signal?.aborted) {
        const abortErr = new Error('The operation was aborted.');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
    }

    if (this.quirks.offline) {
      throw new TypeError('Failed to fetch: MockWebDAVServer is offline');
    }

    const cors = buildCorsHeaders();

    // Browser CORS preflight OPTIONS bypasses WebDAV auth
    if (method === 'OPTIONS' && headers.has('access-control-request-method')) {
      return { status: 204, headers: cors, body: null };
    }

    // Rate limit simulation (429)
    if (typeof this.quirks.rateLimitRemaining === 'number') {
      if (this.quirks.rateLimitRemaining <= 0) {
        return {
          status: 429,
          headers: { ...cors, 'Retry-After': '1' },
          body: new TextEncoder().encode('Too Many Requests'),
        };
      }
      this.quirks.rateLimitRemaining -= 1;
    }

    // Authentication & read-only enforcement
    const auth = this.authenticate(headers);
    if (!auth.ok) {
      return {
        status: 401,
        headers: { ...cors, 'WWW-Authenticate': 'Basic realm="SessionMesh Mock WebDAV"' },
        body: new TextEncoder().encode('Unauthorized'),
      };
    }
    if (auth.readOnly && WRITE_METHODS.has(method)) {
      return {
        status: 403,
        headers: cors,
        body: new TextEncoder().encode('Forbidden: read-only credentials'),
      };
    }

    const normPath = normalizeStorePath(rawUrl);

    // Nginx `location ~ /\. { deny all; }` / Nextcloud dotfile 403 simulation
    if (this.quirks.forbidDotFiles) {
      const hasDotSegment = normPath
        .split('/')
        .filter(Boolean)
        .some((seg) => seg.startsWith('.'));
      if (hasDotSegment) {
        return {
          status: 403,
          headers: cors,
          body: new TextEncoder().encode('403 Forbidden: hidden dotfile path blocked by server policy'),
        };
      }
    }

    // Locked path check (423)
    if (WRITE_METHODS.has(method) && pathMatchesSet(normPath, this.quirks.lockedPaths)) {
      return {
        status: 423,
        headers: { ...cors, 'Retry-After': '1' },
        body: new TextEncoder().encode('Locked'),
      };
    }

    switch (method) {
      case 'OPTIONS':
        return {
          status: 200,
          headers: {
            ...cors,
            DAV: '1, 2',
            Allow: 'OPTIONS, PROPFIND, MKCOL, GET, HEAD, PUT, DELETE, MOVE',
            'MS-Author-Via': 'DAV',
          },
          body: null,
        };

      case 'PROPFIND': {
        const target = this.nodes.get(normPath);
        if (!target) {
          return { status: 404, headers: cors, body: new TextEncoder().encode('Not Found') };
        }
        const depth = (headers.get('depth') ?? '1').trim();
        const entries: Array<[string, StoredNode]> = [[normPath, target]];
        if (depth !== '0' && target.kind === 'collection') {
          const children: Array<[string, StoredNode]> = [];
          for (const [p, n] of this.nodes.entries()) {
            if (p !== normPath && getParentPath(p) === normPath) {
              children.push([p, n]);
            }
          }
          children.sort((a, b) => a[0].localeCompare(b[0]));
          entries.push(...children);
        }
        const xml = this.renderMultistatusXml(entries);
        return {
          status: 207,
          headers: { ...cors, 'Content-Type': 'application/xml; charset=utf-8' },
          body: new TextEncoder().encode(xml),
        };
      }

      case 'MKCOL': {
        if (this.nodes.has(normPath)) {
          return { status: 405, headers: cors, body: new TextEncoder().encode('Method Not Allowed: already exists') };
        }
        const parentPath = getParentPath(normPath);
        const parent = this.nodes.get(parentPath);
        if (!parent || parent.kind !== 'collection') {
          return { status: 409, headers: cors, body: new TextEncoder().encode('Conflict: missing parent collection') };
        }
        const created: CollectionNode = {
          kind: 'collection',
          etag: this.nextEtag(normPath),
          lastModified: Date.now(),
        };
        this.nodes.set(normPath, created);
        return {
          status: 201,
          headers: { ...cors, ETag: this.formatEtag(created.etag) },
          body: null,
        };
      }

      case 'GET':
      case 'HEAD': {
        const node = this.nodes.get(normPath);
        if (!node) {
          return { status: 404, headers: cors, body: new TextEncoder().encode('Not Found') };
        }
        const etagHeader = this.formatEtag(node.etag);
        const ifNoneMatch = headers.get('if-none-match');
        if (!this.quirks.ignoreConditionalHeaders && ifNoneMatch && etagHeaderMatches(ifNoneMatch, node.etag)) {
          return {
            status: 304,
            headers: { ...cors, ETag: etagHeader },
            body: null,
          };
        }
        if (node.kind === 'collection') {
          return {
            status: 200,
            headers: {
              ...cors,
              ETag: etagHeader,
              'Last-Modified': new Date(node.lastModified).toUTCString(),
            },
            body: method === 'HEAD' ? null : new Uint8Array(0),
          };
        }
        let payload = new Uint8Array(node.data);
        if (pathMatchesSet(normPath, this.quirks.corruptReadsForPaths)) {
          if (payload.byteLength === 0) {
            payload = new Uint8Array([0xde, 0xad]);
          } else {
            payload[payload.byteLength - 1] ^= 0xff;
          }
        }
        return {
          status: 200,
          headers: {
            ...cors,
            ETag: etagHeader,
            'Content-Type': node.contentType,
            'Content-Length': String(payload.byteLength),
            'Last-Modified': new Date(node.lastModified).toUTCString(),
          },
          body: method === 'HEAD' ? null : payload,
        };
      }

      case 'PUT': {
        const parentPath = getParentPath(normPath);
        const parent = this.nodes.get(parentPath);
        if (!parent || parent.kind !== 'collection') {
          return { status: 409, headers: cors, body: new TextEncoder().encode('Conflict: missing parent collection') };
        }
        const existing = this.nodes.get(normPath);
        if (existing && existing.kind === 'collection') {
          return { status: 405, headers: cors, body: new TextEncoder().encode('Method Not Allowed: target is collection') };
        }

        if (this.quirks.silentPutDropExtensions) {
          const dropAll = this.quirks.silentPutDropExtensions === '*';
          const dropMatched =
            !dropAll &&
            Array.isArray(this.quirks.silentPutDropExtensions) &&
            this.quirks.silentPutDropExtensions.some((ext) => normPath.toLowerCase().endsWith(ext.toLowerCase()));
          if (dropAll || dropMatched) {
            return {
              status: 201,
              headers: { ...cors, ETag: '1' },
              body: new Uint8Array(0),
            };
          }
        }

        if (!this.quirks.ignoreConditionalHeaders) {
          const ifNoneMatch = headers.get('if-none-match');
          if (ifNoneMatch) {
            const trimmed = ifNoneMatch.trim();
            if (trimmed === '*' && existing) {
              return {
                status: 412,
                headers: cors,
                body: new TextEncoder().encode('Precondition Failed: resource already exists'),
              };
            }
            if (existing && etagHeaderMatches(trimmed, existing.etag)) {
              return {
                status: 412,
                headers: cors,
                body: new TextEncoder().encode('Precondition Failed: ETag matched If-None-Match'),
              };
            }
          }

          const ifMatch = headers.get('if-match');
          if (ifMatch) {
            if (!existing) {
              return {
                status: 412,
                headers: cors,
                body: new TextEncoder().encode('Precondition Failed: resource does not exist'),
              };
            }
            if (!etagHeaderMatches(ifMatch, existing.etag)) {
              return {
                status: 412,
                headers: cors,
                body: new TextEncoder().encode('Precondition Failed: stale ETag'),
              };
            }
          }
        }

        // Quota enforcement (507 Insufficient Storage)
        if (typeof this.quirks.storageQuotaBytes === 'number') {
          const existingSize = existing?.kind === 'file' ? existing.data.byteLength : 0;
          const projected = this.getUsedBytes() - existingSize + body.byteLength;
          if (projected > this.quirks.storageQuotaBytes) {
            return {
              status: 507,
              headers: cors,
              body: new TextEncoder().encode('Insufficient Storage'),
            };
          }
        }

        const storedData = new Uint8Array(body);
        const newNode: FileNode = {
          kind: 'file',
          data: storedData,
          contentType: headers.get('content-type') ?? 'application/octet-stream',
          etag: this.nextEtag(storedData),
          lastModified: Date.now(),
        };
        this.nodes.set(normPath, newNode);

        return {
          status: existing ? 200 : 201,
          headers: { ...cors, ETag: this.formatEtag(newNode.etag) },
          body: null,
        };
      }

      case 'DELETE': {
        const existing = this.nodes.get(normPath);
        if (!existing) {
          return { status: 404, headers: cors, body: new TextEncoder().encode('Not Found') };
        }
        if (!this.quirks.ignoreConditionalHeaders) {
          const ifMatch = headers.get('if-match');
          if (ifMatch && !etagHeaderMatches(ifMatch, existing.etag)) {
            return {
              status: 412,
              headers: cors,
              body: new TextEncoder().encode('Precondition Failed: ETag mismatch on DELETE'),
            };
          }
        }
        if (normPath === '/') {
          return { status: 403, headers: cors, body: new TextEncoder().encode('Cannot delete root') };
        }
        this.nodes.delete(normPath);
        if (existing.kind === 'collection') {
          const prefix = `${normPath}/`;
          for (const key of Array.from(this.nodes.keys())) {
            if (key.startsWith(prefix)) {
              this.nodes.delete(key);
            }
          }
        }
        return { status: 204, headers: cors, body: null };
      }

      case 'MOVE': {
        const src = this.nodes.get(normPath);
        if (!src) {
          return { status: 404, headers: cors, body: new TextEncoder().encode('Not Found') };
        }
        const destHeader = headers.get('destination');
        if (!destHeader) {
          return { status: 400, headers: cors, body: new TextEncoder().encode('Missing Destination header') };
        }
        const destPath = normalizeStorePath(destHeader);
        if (pathMatchesSet(destPath, this.quirks.lockedPaths)) {
          return {
            status: 423,
            headers: { ...cors, 'Retry-After': '1' },
            body: new TextEncoder().encode('Destination Locked'),
          };
        }
        const destParent = this.nodes.get(getParentPath(destPath));
        if (!destParent || destParent.kind !== 'collection') {
          return { status: 409, headers: cors, body: new TextEncoder().encode('Conflict: missing destination parent') };
        }
        const overwrite = (headers.get('overwrite') ?? 'T').toUpperCase() !== 'F';
        const destExisting = this.nodes.get(destPath);
        if (destExisting && !overwrite) {
          return { status: 412, headers: cors, body: new TextEncoder().encode('Precondition Failed: destination exists') };
        }

        // Remove existing destination subtree if overwriting
        if (destExisting) {
          this.nodes.delete(destPath);
          if (destExisting.kind === 'collection') {
            const destPrefix = `${destPath}/`;
            for (const key of Array.from(this.nodes.keys())) {
              if (key.startsWith(destPrefix)) this.nodes.delete(key);
            }
          }
        }

        // Move source (and descendants if collection)
        this.nodes.delete(normPath);
        this.nodes.set(destPath, { ...src, lastModified: Date.now() });
        if (src.kind === 'collection') {
          const srcPrefix = `${normPath}/`;
          for (const [key, val] of Array.from(this.nodes.entries())) {
            if (key.startsWith(srcPrefix)) {
              const suffix = key.slice(normPath.length);
              this.nodes.delete(key);
              this.nodes.set(`${destPath}${suffix}`, val);
            }
          }
        }

        return { status: destExisting ? 204 : 201, headers: cors, body: null };
      }

      default:
        return {
          status: 405,
          headers: cors,
          body: new TextEncoder().encode(`Method ${method} not supported`),
        };
    }
  }

  async startHttpServer(port = 0): Promise<{ url: string; port: number; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const bodyBytes = chunks.length > 0 ? new Uint8Array(Buffer.concat(chunks)) : new Uint8Array(0);
        const headersMap = new Map<string, string>();
        for (const [k, v] of Object.entries(req.headers)) {
          if (Array.isArray(v)) headersMap.set(k.toLowerCase(), v.join(', '));
          else if (typeof v === 'string') headersMap.set(k.toLowerCase(), v);
        }
        const method = (req.method ?? 'GET').toUpperCase();
        const reqUrl = req.url ?? '/';

        this.handleRequest(method, reqUrl, headersMap, bodyBytes)
          .then((internal) => {
            res.writeHead(internal.status, internal.headers);
            if (internal.body && internal.status !== 204 && internal.status !== 304) {
              res.end(Buffer.from(internal.body));
            } else {
              res.end();
            }
          })
          .catch(() => {
            // Offline or fatal error -> abruptly close connection so client observes network failure
            if (!res.headersSent) {
              req.socket.destroy();
            } else {
              res.end();
            }
          });
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const address = server.address() as AddressInfo;
    const actualPort = address.port;
    const url = `http://127.0.0.1:${actualPort}`;

    const close = (): Promise<void> =>
      new Promise((resolve, reject) => {
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

    return { url, port: actualPort, close };
  }
}
