/**
 * S3-Compatible RemoteStorageAdapter (Cloudflare R2, Aliyun OSS, AWS S3, MinIO, Tencent COS, Backblaze B2).
 * Zero external dependencies: uses Web Crypto SigV4 / OSS-V4 signing and built-in XML parser.
 */
import type {
  CapabilityReport,
  RemoteObjectStat,
  RemoteStorageAdapter,
  S3StorageConfig,
  S3VendorPreset,
} from '../types';
import { bytesToHex } from '../crypto/encoding';
import { generateRandomBytes, sha256Hex } from '../crypto/smes';
import { createHttpStatusError, WebDAVHttpError } from '../webdav/errors';
import { normalizeEtag } from '../webdav/xml';
import { encodeRfc3986, signS3Request, type S3SignatureAlgorithm } from './s3SigV4';
import {
  buildCapabilityReport,
  createCapabilityChecksTemplate,
  describeAdapterError,
  isLocalhostHostname,
  performTimedFetch,
  splitCleanStorageSegments,
  validateHttpsEndpoint,
  type StorageAdapterOptions,
} from './types';

interface S3XmlContentItem {
  key: string;
  size: number;
  etag?: string;
  lastModified?: number;
}

interface S3ListV2Parsed {
  isTruncated: boolean;
  nextContinuationToken?: string;
  contents: S3XmlContentItem[];
  commonPrefixes: string[];
}

function decodeXmlEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (match, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        if (entity.startsWith('#x') || entity.startsWith('#X')) {
          const cp = Number.parseInt(entity.slice(2), 16);
          return Number.isFinite(cp) ? String.fromCodePoint(cp) : match;
        }
        if (entity.startsWith('#')) {
          const cp = Number.parseInt(entity.slice(1), 10);
          return Number.isFinite(cp) ? String.fromCodePoint(cp) : match;
        }
        return match;
      }
    }
  });
}

function stripNamespacePrefix(tagName: string): string {
  const colonIdx = tagName.indexOf(':');
  return colonIdx === -1 ? tagName : tagName.slice(colonIdx + 1);
}

/**
 * Lightweight stack-based S3 ListObjectsV2 XML parser.
 * Distinguishes <CommonPrefixes><Prefix> from top-level <ListBucketResult><Prefix>.
 */
export function parseS3ListObjectsV2Xml(xmlText: string): S3ListV2Parsed {
  const result: S3ListV2Parsed = {
    isTruncated: false,
    contents: [],
    commonPrefixes: [],
  };

  if (!xmlText || !xmlText.trim()) {
    return result;
  }

  interface Frame {
    localName: string;
    text: string;
    contentItem?: Partial<S3XmlContentItem>;
    commonPrefixText?: string;
  }

  const stack: Frame[] = [];
  const len = xmlText.length;
  let pos = 0;

  while (pos < len) {
    const lt = xmlText.indexOf('<', pos);
    if (lt === -1) {
      if (stack.length > 0) {
        stack[stack.length - 1].text += decodeXmlEntities(xmlText.slice(pos));
      }
      break;
    }

    if (lt > pos && stack.length > 0) {
      stack[stack.length - 1].text += decodeXmlEntities(xmlText.slice(pos, lt));
    }

    if (xmlText.startsWith('<!--', lt)) {
      const end = xmlText.indexOf('-->', lt + 4);
      pos = end === -1 ? len : end + 3;
      continue;
    }
    if (xmlText.startsWith('<![CDATA[', lt)) {
      const end = xmlText.indexOf(']]>', lt + 9);
      const cdata = end === -1 ? xmlText.slice(lt + 9) : xmlText.slice(lt + 9, end);
      if (stack.length > 0) {
        stack[stack.length - 1].text += cdata;
      }
      pos = end === -1 ? len : end + 3;
      continue;
    }
    if (xmlText.startsWith('<?', lt)) {
      const end = xmlText.indexOf('?>', lt + 2);
      pos = end === -1 ? len : end + 2;
      continue;
    }
    if (xmlText.startsWith('<!', lt)) {
      const end = xmlText.indexOf('>', lt + 2);
      pos = end === -1 ? len : end + 1;
      continue;
    }

    let gt = -1;
    let quoteChar: string | null = null;
    for (let i = lt + 1; i < len; i += 1) {
      const ch = xmlText[i];
      if (quoteChar) {
        if (ch === quoteChar) quoteChar = null;
      } else if (ch === '"' || ch === "'") {
        quoteChar = ch;
      } else if (ch === '>') {
        gt = i;
        break;
      }
    }
    if (gt === -1) break;

    const inside = xmlText.slice(lt + 1, gt).trim();
    pos = gt + 1;
    if (!inside) continue;

    if (inside.startsWith('/')) {
      const closeLocal = stripNamespacePrefix(inside.slice(1).trim());
      const frame = stack.pop();
      if (!frame) continue;
      const text = frame.text.trim();
      const parent = stack[stack.length - 1];

      if (frame.localName === 'IsTruncated' && parent?.localName === 'ListBucketResult') {
        result.isTruncated = text.toLowerCase() === 'true';
      } else if (frame.localName === 'NextContinuationToken' && parent?.localName === 'ListBucketResult') {
        if (text) result.nextContinuationToken = text;
      } else if (frame.localName === 'Contents' && frame.contentItem?.key) {
        result.contents.push({
          key: frame.contentItem.key,
          size: frame.contentItem.size ?? 0,
          etag: frame.contentItem.etag,
          lastModified: frame.contentItem.lastModified,
        });
      } else if (frame.localName === 'CommonPrefixes' && frame.commonPrefixText) {
        result.commonPrefixes.push(frame.commonPrefixText);
      } else if (parent?.localName === 'Contents' && parent.contentItem) {
        if (frame.localName === 'Key') parent.contentItem.key = text;
        else if (frame.localName === 'Size') {
          const parsed = Number.parseInt(text, 10);
          parent.contentItem.size = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
        } else if (frame.localName === 'ETag') {
          parent.contentItem.etag = normalizeEtag(text);
        } else if (frame.localName === 'LastModified') {
          const ms = Date.parse(text);
          if (!Number.isNaN(ms)) parent.contentItem.lastModified = ms;
        }
      } else if (parent?.localName === 'CommonPrefixes' && frame.localName === 'Prefix') {
        parent.commonPrefixText = text;
      } else if (closeLocal !== frame.localName) {
        // tolerate minor tag casing
      }
      continue;
    }

    const selfClosing = inside.endsWith('/');
    const tagBody = selfClosing ? inside.slice(0, -1).trim() : inside;
    const spaceIdx = tagBody.search(/[\s\r\n\t]/);
    const rawName = spaceIdx === -1 ? tagBody : tagBody.slice(0, spaceIdx);
    const localName = stripNamespacePrefix(rawName);
    if (selfClosing) continue;

    const frame: Frame = { localName, text: '' };
    if (localName === 'Contents') frame.contentItem = {};
    stack.push(frame);
  }

  return result;
}

function defaultAddressingStyleForPreset(
  preset: S3VendorPreset | undefined,
  hostname: string,
): 'path' | 'virtual_hosted' {
  if (isLocalhostHostname(hostname)) {
    return 'path';
  }
  if (preset === 'aliyun_oss' || preset === 'cos' || preset === 'aws_s3' || preset === 'b2') {
    return 'virtual_hosted';
  }
  return 'path';
}

function defaultSignatureModeForPreset(preset: S3VendorPreset | undefined): S3SignatureAlgorithm {
  return preset === 'aliyun_oss' ? 'oss_v4' : 'aws_v4';
}

const S3_CAPABILITY_STEPS = [
  { step: 1, id: 'config_format', name: 'S3 Endpoint & Bucket Validation' },
  { step: 2, id: 'https_enforced', name: 'HTTPS Enforcement' },
  { step: 3, id: 'bucket_access', name: 'Bucket Authentication & List Access' },
  { step: 4, id: 'temp_put', name: 'Temporary Object PUT' },
  { step: 5, id: 'temp_get', name: 'Temporary Object GET' },
  { step: 6, id: 'etag_presence', name: 'ETag Response Support' },
  { step: 7, id: 'conditional_create', name: 'Conditional Create (If-None-Match: *)' },
  { step: 8, id: 'conditional_update', name: 'Conditional Update (If-Match CAS)' },
  { step: 9, id: 'sha256_consistency', name: 'Binary Read/Write SHA-256 Consistency' },
  { step: 10, id: 'payload_size_64kb', name: '64KB Binary Payload Support' },
  { step: 11, id: 'probe_cleanup', name: 'Temporary Probe Cleanup' },
];

export class S3StorageAdapter implements RemoteStorageAdapter {
  readonly provider = 's3' as const;
  readonly displayEndpoint: string;

  private readonly config: S3StorageConfig;
  private readonly fetchImpl?: typeof fetch;

  constructor(config: S3StorageConfig, options?: StorageAdapterOptions) {
    this.config = { ...config };
    this.fetchImpl = options?.fetchImpl;
    this.displayEndpoint = this.computeDisplayEndpoint();
  }

  private computeDisplayEndpoint(): string {
    try {
      const parsed = new URL(this.config.endpoint);
      const style = this.config.addressingStyle ?? defaultAddressingStyleForPreset(this.config.vendorPreset, parsed.hostname);
      const prefixSegs = splitCleanStorageSegments(this.config.rootPrefix || '', 'S3');
      const suffix = prefixSegs.length > 0 ? `/${prefixSegs.join('/')}` : '';
      if (style === 'virtual_hosted' && this.config.bucket) {
        return `${parsed.protocol}//${this.config.bucket}.${parsed.host}${suffix}`;
      }
      return `${parsed.origin}/${this.config.bucket}${suffix}`;
    } catch {
      return this.config.endpoint || '';
    }
  }

  validateConfig(): void {
    const parsed = validateHttpsEndpoint(
      this.config.endpoint,
      this.config.allowInsecureLocalhostForTesting,
      'S3',
      'S3',
    );
    if (!this.config.bucket || !this.config.bucket.trim() || this.config.bucket.includes('/')) {
      throw new WebDAVHttpError({
        status: 0,
        code: 'S3_INVALID_BUCKET',
        phase: 'validate_config',
        message: `Invalid S3 bucket name: "${this.config.bucket}"`,
        retryable: false,
        suggestion: 'Provide a valid non-empty S3 bucket name.',
      });
    }
    if (!this.config.region || !this.config.region.trim()) {
      throw new WebDAVHttpError({
        status: 0,
        code: 'S3_INVALID_REGION',
        phase: 'validate_config',
        message: 'S3 region must not be empty',
        retryable: false,
        suggestion: 'Specify a valid region (e.g. us-east-1, auto for Cloudflare R2, cn-hangzhou for OSS).',
      });
    }
    if (!this.config.accessKeyId?.trim() || !this.config.secretAccessKey) {
      throw new WebDAVHttpError({
        status: 0,
        code: 'S3_MISSING_CREDENTIALS',
        phase: 'validate_config',
        message: 'S3 Access Key ID and Secret Access Key are required',
        retryable: false,
        suggestion: 'Enter both AccessKeyId and SecretAccessKey.',
      });
    }
    void parsed;
    splitCleanStorageSegments(this.config.rootPrefix || '', 'S3');
  }

  private getResolvedParams(): {
    endpointUrl: URL;
    mountSegments: string[];
    rootSegments: string[];
    addressingStyle: 'path' | 'virtual_hosted';
    signatureMode: S3SignatureAlgorithm;
  } {
    this.validateConfig();
    const endpointUrl = new URL(this.config.endpoint);
    const mountSegments = splitCleanStorageSegments(
      endpointUrl.pathname
        .split('/')
        .map((s) => {
          try {
            return decodeURIComponent(s);
          } catch {
            return s;
          }
        })
        .join('/'),
      'S3',
    );
    const rootSegments = splitCleanStorageSegments(this.config.rootPrefix || '', 'S3');
    const addressingStyle =
      this.config.addressingStyle ?? defaultAddressingStyleForPreset(this.config.vendorPreset, endpointUrl.hostname);
    const signatureMode = this.config.signatureMode ?? defaultSignatureModeForPreset(this.config.vendorPreset);
    return { endpointUrl, mountSegments, rootSegments, addressingStyle, signatureMode };
  }

  private buildRequestUrl(
    keySegments: string[],
    queryParams?: Record<string, string>,
  ): {
    url: string;
    displayPath: string;
    addressingStyle: 'path' | 'virtual_hosted';
    signatureMode: S3SignatureAlgorithm;
  } {
    const { endpointUrl, mountSegments, addressingStyle, signatureMode } = this.getResolvedParams();
    const origin =
      addressingStyle === 'virtual_hosted'
        ? `${endpointUrl.protocol}//${this.config.bucket}.${endpointUrl.host}`
        : endpointUrl.origin;

    const pathSegments =
      addressingStyle === 'virtual_hosted'
        ? [...mountSegments, ...keySegments]
        : [...mountSegments, this.config.bucket, ...keySegments];

    const pathname = pathSegments.length > 0 ? `/${pathSegments.map(encodeRfc3986).join('/')}` : '/';

    let queryStr = '';
    if (queryParams) {
      const entries = Object.entries(queryParams)
        .filter(([, v]) => v !== undefined)
        .sort(([ak], [bk]) => (ak < bk ? -1 : ak > bk ? 1 : 0));
      if (entries.length > 0) {
        queryStr = `?${entries.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join('&')}`;
      }
    }

    const displayPath = keySegments.length > 0 ? `/${keySegments.join('/')}` : '/';
    return {
      url: `${origin}${pathname}${queryStr}`,
      displayPath,
      addressingStyle,
      signatureMode,
    };
  }

  private async signedFetch(params: {
    method: string;
    keySegments: string[];
    queryParams?: Record<string, string>;
    headers?: Record<string, string>;
    body?: Uint8Array;
    phase: string;
  }): Promise<{ response: Response; displayPath: string }> {
    const target = this.buildRequestUrl(params.keySegments, params.queryParams);
    const signed = await signS3Request({
      method: params.method,
      url: target.url,
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      sessionToken: this.config.sessionToken,
      signatureMode: target.signatureMode,
      bucket: this.config.bucket,
      addressingStyle: target.addressingStyle,
      headers: params.headers,
      body: params.body,
    });

    const response = await performTimedFetch({
      fetchImpl: this.fetchImpl,
      url: target.url,
      method: params.method,
      headers: signed.headers,
      body: params.body,
      timeoutMs: this.config.requestTimeoutMs ?? 30_000,
      phase: params.phase,
      displayPath: target.displayPath,
      providerLabel: 'S3',
      errorCodePrefix: 'S3',
    });

    return { response, displayPath: target.displayPath };
  }

  async ensureDir(subPath: string): Promise<void> {
    this.validateConfig();
    splitCleanStorageSegments(subPath, 'S3');
    // S3 uses flat object keys; virtual directories do not require creation.
  }

  private async listObjectsV2All(prefix: string, delimiter?: string): Promise<{
    contents: S3XmlContentItem[];
    commonPrefixes: string[];
  }> {
    const allContents: S3XmlContentItem[] = [];
    const allPrefixes: string[] = [];
    let continuationToken: string | undefined;

    do {
      const queryParams: Record<string, string> = {
        'list-type': '2',
      };
      if (prefix) {
        queryParams['prefix'] = prefix;
      }
      if (delimiter) {
        queryParams['delimiter'] = delimiter;
      }
      if (continuationToken) {
        queryParams['continuation-token'] = continuationToken;
      }

      const { response, displayPath } = await this.signedFetch({
        method: 'GET',
        keySegments: [],
        queryParams,
        phase: 'list',
      });

      if (response.status < 200 || response.status >= 300) {
        throw createHttpStatusError(response.status, 'list', displayPath, response.headers.get('retry-after'));
      }

      const xmlText = await response.text();
      const parsed = parseS3ListObjectsV2Xml(xmlText);
      allContents.push(...parsed.contents);
      allPrefixes.push(...parsed.commonPrefixes);
      continuationToken = parsed.isTruncated ? parsed.nextContinuationToken : undefined;
      if (parsed.isTruncated && !continuationToken) {
        break;
      }
    } while (continuationToken);

    return { contents: allContents, commonPrefixes: allPrefixes };
  }

  async list(subPath: string, depth: 0 | 1 = 1): Promise<RemoteObjectStat[]> {
    if (depth === 0) {
      const st = await this.stat(subPath);
      return st ? [st] : [];
    }

    const { rootSegments } = this.getResolvedParams();
    const subSegments = splitCleanStorageSegments(subPath, 'S3');
    const subNorm = subSegments.join('/');
    const prefixSegments = [...rootSegments, ...subSegments];
    const prefix = prefixSegments.length > 0 ? `${prefixSegments.join('/')}/` : '';
    const rootBasePrefix = rootSegments.length > 0 ? `${rootSegments.join('/')}/` : '';

    const { contents, commonPrefixes } = await this.listObjectsV2All(prefix, '/');
    const byPath = new Map<string, RemoteObjectStat>();

    const stripRootPrefix = (rawKey: string): string => {
      if (rootBasePrefix && rawKey.startsWith(rootBasePrefix)) {
        return rawKey.slice(rootBasePrefix.length);
      }
      if (rootBasePrefix && rawKey === rootSegments.join('/')) {
        return '';
      }
      return rawKey;
    };

    for (const rawDirPrefix of commonPrefixes) {
      const cleanRaw = rawDirPrefix.replace(/\/+$/, '');
      const rel = stripRootPrefix(cleanRaw).replace(/^\/+|\/+$/g, '');
      if (!rel || rel === subNorm) continue;
      const segs = rel.split('/').filter(Boolean);
      const name = segs[segs.length - 1] ?? '';
      const relPath = `/${segs.join('/')}`;
      if (!byPath.has(relPath)) {
        byPath.set(relPath, {
          path: relPath,
          name,
          isCollection: true,
          size: 0,
          status: 200,
        });
      }
    }

    for (const item of contents) {
      if (item.key === prefix) continue;
      const isDirMarker = item.key.endsWith('/');
      const cleanRaw = item.key.replace(/\/+$/, '');
      const rel = stripRootPrefix(cleanRaw).replace(/^\/+|\/+$/g, '');
      if (!rel || rel === subNorm) continue;
      const segs = rel.split('/').filter(Boolean);
      const name = segs[segs.length - 1] ?? '';
      const relPath = `/${segs.join('/')}`;
      if (isDirMarker) {
        if (!byPath.has(relPath)) {
          byPath.set(relPath, {
            path: relPath,
            name,
            isCollection: true,
            size: 0,
            lastModified: item.lastModified,
            status: 200,
          });
        }
      } else {
        byPath.set(relPath, {
          path: relPath,
          name,
          isCollection: false,
          etag: item.etag,
          size: item.size,
          lastModified: item.lastModified,
          status: 200,
        });
      }
    }

    return Array.from(byPath.values());
  }

  async stat(subPath: string): Promise<RemoteObjectStat | null> {
    const { rootSegments } = this.getResolvedParams();
    const subSegments = splitCleanStorageSegments(subPath, 'S3');

    if (subSegments.length === 0) {
      const { response, displayPath } = await this.signedFetch({
        method: 'HEAD',
        keySegments: [],
        phase: 'stat',
      });
      if (response.status === 404) return null;
      if (response.status < 200 || response.status >= 300) {
        throw createHttpStatusError(response.status, 'stat', displayPath, response.headers.get('retry-after'));
      }
      return {
        path: '/',
        name: '',
        isCollection: true,
        size: 0,
        status: 200,
      };
    }

    const { response, displayPath } = await this.signedFetch({
      method: 'HEAD',
      keySegments: [...rootSegments, ...subSegments],
      phase: 'stat',
    });

    if (response.status === 404) {
      return null;
    }
    if (response.status < 200 || response.status >= 300) {
      throw createHttpStatusError(response.status, 'stat', displayPath, response.headers.get('retry-after'));
    }

    const sizeHeader = response.headers.get('content-length');
    const parsedSize = sizeHeader ? Number.parseInt(sizeHeader, 10) : 0;
    const lmHeader = response.headers.get('last-modified');
    const lmMs = lmHeader ? Date.parse(lmHeader) : Number.NaN;

    return {
      path: `/${subSegments.join('/')}`,
      name: subSegments[subSegments.length - 1],
      isCollection: false,
      etag: normalizeEtag(response.headers.get('etag')),
      size: Number.isFinite(parsedSize) && parsedSize >= 0 ? parsedSize : 0,
      lastModified: Number.isNaN(lmMs) ? undefined : lmMs,
      status: response.status,
    };
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
    const { rootSegments } = this.getResolvedParams();
    const subSegments = splitCleanStorageSegments(subPath, 'S3');
    const keySegments = [...rootSegments, ...subSegments];

    const headers: Record<string, string> = {};
    if (options?.ifNoneMatch) {
      const normalized = normalizeEtag(options.ifNoneMatch) ?? options.ifNoneMatch;
      headers['If-None-Match'] = normalized === '*' ? '*' : `"${normalized}"`;
    }

    let { response, displayPath } = await this.signedFetch({
      method: 'GET',
      keySegments,
      headers,
      phase: 'getBytes',
    });

    if (options?.ifNoneMatch && (response.status === 400 || response.status === 501)) {
      const fallback = await this.signedFetch({
        method: 'GET',
        keySegments,
        phase: 'getBytes',
      });
      response = fallback.response;
      displayPath = fallback.displayPath;
    }

    const etag = normalizeEtag(response.headers.get('etag'));

    if (response.status === 304) {
      return {
        notModified: true,
        bytes: new Uint8Array(0),
        etag: etag ?? normalizeEtag(options?.ifNoneMatch),
        status: 304,
      };
    }

    if (response.status < 200 || response.status >= 300) {
      throw createHttpStatusError(response.status, 'getBytes', displayPath, response.headers.get('retry-after'));
    }

    const buf = await response.arrayBuffer();
    return {
      notModified: false,
      bytes: new Uint8Array(buf),
      etag,
      status: response.status,
    };
  }

  async putBytes(
    subPath: string,
    bytes: Uint8Array,
    options?: { ifMatch?: string; ifNoneMatchStar?: boolean; contentType?: string },
  ): Promise<{ etag?: string; status: number }> {
    const { rootSegments } = this.getResolvedParams();
    const subSegments = splitCleanStorageSegments(subPath, 'S3');
    const keySegments = [...rootSegments, ...subSegments];
    const effectiveContentType = options?.contentType ?? 'application/octet-stream';

    const headers: Record<string, string> = {
      'Content-Type': effectiveContentType,
    };
    const hasConditional = Boolean(options?.ifMatch || options?.ifNoneMatchStar);
    if (options?.ifMatch) {
      const normalized = normalizeEtag(options.ifMatch) ?? options.ifMatch;
      headers['If-Match'] = normalized === '*' ? '*' : `"${normalized}"`;
    }
    if (options?.ifNoneMatchStar) {
      headers['If-None-Match'] = '*';
    }

    let { response, displayPath } = await this.signedFetch({
      method: 'PUT',
      keySegments,
      headers,
      body: bytes,
      phase: 'putBytes',
    });

    // Retry plain PUT if gateway rejects conditional headers with 400/501 (NEVER 412!)
    if (hasConditional && (response.status === 400 || response.status === 501)) {
      const fallback = await this.signedFetch({
        method: 'PUT',
        keySegments,
        headers: { 'Content-Type': effectiveContentType },
        body: bytes,
        phase: 'putBytes',
      });
      response = fallback.response;
      displayPath = fallback.displayPath;
    }

    if (response.status !== 200 && response.status !== 201 && response.status !== 202 && response.status !== 204) {
      throw createHttpStatusError(response.status, 'putBytes', displayPath, response.headers.get('retry-after'));
    }

    return {
      etag: normalizeEtag(response.headers.get('etag')),
      status: response.status,
    };
  }

  async delete(subPath: string, options?: { ifMatch?: string; isCollection?: boolean }): Promise<void> {
    const { rootSegments } = this.getResolvedParams();
    const subSegments = splitCleanStorageSegments(subPath, 'S3');

    if (options?.isCollection) {
      const prefixSegments = [...rootSegments, ...subSegments];
      const prefix = prefixSegments.length > 0 ? `${prefixSegments.join('/')}/` : '';
      const { contents } = await this.listObjectsV2All(prefix);
      for (const item of contents) {
        const itemSegments = item.key.split('/').filter(Boolean);
        const { response, displayPath } = await this.signedFetch({
          method: 'DELETE',
          keySegments: itemSegments,
          phase: 'delete',
        });
        if (
          response.status !== 200 &&
          response.status !== 202 &&
          response.status !== 204 &&
          response.status !== 404
        ) {
          throw createHttpStatusError(response.status, 'delete', displayPath, response.headers.get('retry-after'));
        }
      }
      return;
    }

    const keySegments = [...rootSegments, ...subSegments];
    const headers: Record<string, string> = {};
    if (options?.ifMatch) {
      const normalized = normalizeEtag(options.ifMatch) ?? options.ifMatch;
      headers['If-Match'] = normalized === '*' ? '*' : `"${normalized}"`;
    }

    let { response, displayPath } = await this.signedFetch({
      method: 'DELETE',
      keySegments,
      headers,
      phase: 'delete',
    });

    if (options?.ifMatch && (response.status === 400 || response.status === 501)) {
      const fallback = await this.signedFetch({
        method: 'DELETE',
        keySegments,
        phase: 'delete',
      });
      response = fallback.response;
      displayPath = fallback.displayPath;
    }

    if (
      response.status === 200 ||
      response.status === 202 ||
      response.status === 204 ||
      response.status === 404
    ) {
      return;
    }

    throw createHttpStatusError(response.status, 'delete', displayPath, response.headers.get('retry-after'));
  }

  async checkCapabilities(): Promise<CapabilityReport> {
    const startedAt = Date.now();
    const checks = createCapabilityChecksTemplate(S3_CAPABILITY_STEPS);
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
      const parsed = new URL(this.config.endpoint);
      setCheck(1, 'supported', `Valid S3 endpoint (${parsed.origin}) & bucket "${this.config.bucket}"`);
      setCheck(
        2,
        'supported',
        parsed.protocol === 'https:' ? 'HTTPS protocol enforced' : 'Localhost HTTP explicitly allowed for testing',
      );
    } catch (err) {
      const msg = describeAdapterError(err);
      if (err instanceof WebDAVHttpError && (err.code === 'S3_INSECURE_HTTP' || err.code === 'S3_INVALID_PROTOCOL')) {
        setCheck(1, 'supported', 'Endpoint format parsed');
        setCheck(2, 'unsupported', msg);
      } else {
        setCheck(1, 'unsupported', msg);
      }
      return buildCapabilityReport({
        startedAt,
        url: this.displayEndpoint,
        consistencyLevel: 'incompatible',
        overallOk: false,
        checks,
        summaryMessage: `S3 configuration check failed: ${msg}`,
      });
    }

    const tBucket = Date.now();
    try {
      await this.list('', 1);
      setCheck(3, 'supported', `Bucket "${this.config.bucket}" authenticated & listable`, Date.now() - tBucket);
    } catch (err) {
      setCheck(3, 'unsupported', describeAdapterError(err), Date.now() - tBucket);
      return buildCapabilityReport({
        startedAt,
        url: this.displayEndpoint,
        consistencyLevel: 'incompatible',
        overallOk: false,
        checks,
        summaryMessage: `S3 bucket access failed: ${describeAdapterError(err)}`,
      });
    }

    const probeToken = bytesToHex(generateRandomBytes(6));
    const probeDir = `sm_probe_${probeToken}`;
    const basicFile = `${probeDir}/basic.enc`;
    const casCreateFile = `${probeDir}/cas_create.enc`;
    const casUpdateFile = `${probeDir}/cas_update.enc`;
    const shaFile = `${probeDir}/sha_check.enc`;
    const size64File = `${probeDir}/size_64k.enc`;

    let basicOk = true;
    let abortMsg: string | undefined;

    try {
      const probeBytes = new TextEncoder().encode(`sessionmesh-s3-probe:${probeToken}`);
      let putEtag: string | undefined;
      let getEtag: string | undefined;

      const tPut = Date.now();
      try {
        const putRes = await this.putBytes(basicFile, probeBytes);
        putEtag = putRes.etag;
        setCheck(4, 'supported', `HTTP ${putRes.status}`, Date.now() - tPut);
      } catch (err) {
        basicOk = false;
        abortMsg = `S3 probe PUT failed: ${describeAdapterError(err)}`;
        setCheck(4, 'unsupported', describeAdapterError(err), Date.now() - tPut);
      }

      if (basicOk) {
        const tGet = Date.now();
        try {
          const getRes = await this.getBytes(basicFile);
          getEtag = getRes.etag;
          if (getRes.bytes.byteLength === probeBytes.byteLength) {
            setCheck(5, 'supported', `HTTP ${getRes.status} (${getRes.bytes.byteLength} bytes)`, Date.now() - tGet);
          } else {
            basicOk = false;
            abortMsg = `S3 probe GET size mismatch (${getRes.bytes.byteLength} != ${probeBytes.byteLength})`;
            setCheck(5, 'unsupported', abortMsg, Date.now() - tGet);
          }
        } catch (err) {
          basicOk = false;
          abortMsg = `S3 probe GET failed: ${describeAdapterError(err)}`;
          setCheck(5, 'unsupported', describeAdapterError(err), Date.now() - tGet);
        }
      }

      if (basicOk) {
        let detectedEtag = putEtag ?? getEtag;
        if (!detectedEtag) {
          const st = await this.stat(basicFile).catch(() => null);
          detectedEtag = st?.etag;
        }
        if (detectedEtag) {
          setCheck(6, 'supported', `ETag returned (${detectedEtag})`);
        } else {
          setCheck(6, 'unsupported', 'S3 endpoint did not return ETag');
        }

        // Step 7: If-None-Match: *
        const tCondCreate = Date.now();
        try {
          await this.putBytes(casCreateFile, new TextEncoder().encode('v1'), { ifNoneMatchStar: true });
          let rejected412 = false;
          let failReason = '';
          try {
            await this.putBytes(casCreateFile, new TextEncoder().encode('v2'), { ifNoneMatchStar: true });
            failReason = 'Server ignored If-None-Match: * and overwrote existing object';
          } catch (dupErr) {
            if (dupErr instanceof WebDAVHttpError && dupErr.status === 412) {
              rejected412 = true;
            } else {
              failReason = `Unexpected error on duplicate create: ${describeAdapterError(dupErr)}`;
            }
          }
          setCheck(
            7,
            rejected412 ? 'supported' : 'unsupported',
            rejected412 ? 'Duplicate create rejected with HTTP 412' : failReason,
            Date.now() - tCondCreate,
          );
        } catch (err) {
          setCheck(7, 'unsupported', describeAdapterError(err), Date.now() - tCondCreate);
        }

        // Step 8: If-Match CAS
        const tCondUpdate = Date.now();
        try {
          const init = await this.putBytes(casUpdateFile, new TextEncoder().encode('cas-v1'));
          const etagV1 = init.etag ?? (await this.stat(casUpdateFile))?.etag;
          if (!etagV1) {
            setCheck(8, 'unsupported', 'Missing ETag for If-Match verification', Date.now() - tCondUpdate);
          } else {
            await this.putBytes(casUpdateFile, new TextEncoder().encode('cas-v2'), { ifMatch: etagV1 });
            let rejectedStale = false;
            let staleReason = '';
            try {
              await this.putBytes(casUpdateFile, new TextEncoder().encode('cas-v3-stale'), { ifMatch: etagV1 });
              staleReason = 'Server accepted stale ETag instead of returning HTTP 412';
            } catch (staleErr) {
              if (staleErr instanceof WebDAVHttpError && staleErr.status === 412) {
                rejectedStale = true;
              } else {
                staleReason = `Unexpected error on stale If-Match: ${describeAdapterError(staleErr)}`;
              }
            }
            setCheck(
              8,
              rejectedStale ? 'supported' : 'unsupported',
              rejectedStale ? 'Valid If-Match succeeded; stale ETag rejected with HTTP 412' : staleReason,
              Date.now() - tCondUpdate,
            );
          }
        } catch (err) {
          setCheck(8, 'unsupported', describeAdapterError(err), Date.now() - tCondUpdate);
        }

        // Step 9: 512B binary SHA-256
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
            setCheck(9, 'supported', `SHA-256 verified (${expectedHash.slice(0, 12)}...)`, Date.now() - tSha);
          } else {
            basicOk = false;
            setCheck(9, 'unsupported', 'Binary payload SHA-256 mismatch', Date.now() - tSha);
          }
        } catch (err) {
          basicOk = false;
          setCheck(9, 'unsupported', describeAdapterError(err), Date.now() - tSha);
        }

        // Step 10: 64KB payload
        const t64 = Date.now();
        try {
          const p64 = generateRandomBytes(64 * 1024);
          const h64 = await sha256Hex(p64);
          await this.putBytes(size64File, p64);
          const r64 = await this.getBytes(size64File);
          if (r64.bytes.byteLength === p64.byteLength && (await sha256Hex(r64.bytes)) === h64) {
            setCheck(10, 'supported', '64KB binary round-trip SHA-256 verified', Date.now() - t64);
          } else {
            basicOk = false;
            setCheck(10, 'unsupported', '64KB payload corruption detected', Date.now() - t64);
          }
        } catch (err) {
          basicOk = false;
          setCheck(10, 'unsupported', describeAdapterError(err), Date.now() - t64);
        }
      }
    } finally {
      const tClean = Date.now();
      try {
        await this.delete(probeDir, { isCollection: true });
        setCheck(11, 'supported', `Cleaned up probe prefix ${probeDir}`, Date.now() - tClean);
      } catch (err) {
        setCheck(11, 'unsupported', describeAdapterError(err), Date.now() - tClean);
      }
    }

    if (!basicOk || abortMsg) {
      return buildCapabilityReport({
        startedAt,
        url: this.displayEndpoint,
        consistencyLevel: 'incompatible',
        overallOk: false,
        checks,
        summaryMessage: abortMsg ?? 'S3 object storage failed core read/write integrity checks.',
      });
    }

    const strongCas =
      checks[5].state === 'supported' && checks[6].state === 'supported' && checks[7].state === 'supported';

    return buildCapabilityReport({
      startedAt,
      url: this.displayEndpoint,
      consistencyLevel: strongCas ? 'strong_cas' : 'append_only_degraded',
      overallOk: true,
      checks,
      summaryMessage: strongCas
        ? 'S3 storage passed all checks with full strong CAS (If-Match / If-None-Match) protection.'
        : 'S3 storage passed encrypted CRUD checks, operating in append-only degraded mode (conditional CAS headers unsupported).',
    });
  }
}
