/**
 * Zero-dependency AWS Signature Version 4 (AWS4-HMAC-SHA256) and
 * Aliyun OSS Signature Version 4 (OSS4-HMAC-SHA256) request signer using Web Crypto API.
 */
import { bytesToHex, utf8ToBytes } from '../crypto/encoding';
import { sha256Hex } from '../crypto/smes';

export type S3SignatureAlgorithm = 'aws_v4' | 'oss_v4';

export interface S3SignRequestInput {
  method: string;
  url: string | URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  service?: string;
  signatureMode?: S3SignatureAlgorithm;
  bucket?: string;
  addressingStyle?: 'path' | 'virtual_hosted';
  headers?: Record<string, string>;
  body?: Uint8Array;
  date?: Date;
}

export interface S3SignedRequest {
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  signedHeaders: string;
  amzDate: string;
  dateStamp: string;
  payloadHash: string;
}

function getSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('CRYPTO_UNAVAILABLE: Web Crypto subtle API is unavailable');
  }
  return subtle;
}

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * RFC 3986 percent-encoding (encodes ! ' ( ) * in addition to encodeURIComponent).
 */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Canonicalizes a URL pathname per RFC 3986 while keeping "/" path separators unencoded.
 */
export function canonicalizeUri(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return normalized
    .split('/')
    .map((seg) => {
      if (!seg) return '';
      try {
        return encodeRfc3986(decodeURIComponent(seg));
      } catch {
        return encodeRfc3986(seg);
      }
    })
    .join('/');
}

function safeDecodePercent(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Canonicalizes and lexicographically sorts a query string per SigV4 / OSS-V4 rules.
 */
export function canonicalizeQueryString(search: string, omitEmptyEquals = false): string {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (!raw) return '';

  const pairs: Array<[string, string, boolean]> = [];
  for (const part of raw.split('&')) {
    if (!part) continue;
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) {
      pairs.push([encodeRfc3986(safeDecodePercent(part)), '', false]);
    } else {
      const k = encodeRfc3986(safeDecodePercent(part.slice(0, eqIdx)));
      const v = encodeRfc3986(safeDecodePercent(part.slice(eqIdx + 1)));
      pairs.push([k, v, true]);
    }
  }

  pairs.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  });

  return pairs
    .map(([k, v, hasEq]) => {
      if (!v && omitEmptyEquals && !hasEq) {
        return k;
      }
      return `${k}=${v}`;
    })
    .join('&');
}

export function formatAmzDate(date: Date = new Date()): { amzDate: string; dateStamp: string } {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return {
    amzDate,
    dateStamp: amzDate.slice(0, 8),
  };
}

export async function hmacSha256Bytes(key: Uint8Array | string, data: Uint8Array | string): Promise<Uint8Array> {
  const subtle = getSubtleCrypto();
  const keyBytes = typeof key === 'string' ? utf8ToBytes(key) : key;
  const dataBytes = typeof data === 'string' ? utf8ToBytes(data) : data;
  const cryptoKey = await subtle.importKey(
    'raw',
    toExactArrayBuffer(keyBytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await subtle.sign('HMAC', cryptoKey, toExactArrayBuffer(dataBytes));
  return new Uint8Array(sig);
}

function normalizeHeaderValue(val: string): string {
  return val.trim().replace(/\s+/g, ' ');
}

function resolveOssCanonicalUri(
  urlPathname: string,
  bucket?: string,
  addressingStyle?: 'path' | 'virtual_hosted',
): string {
  const baseUri = canonicalizeUri(urlPathname);
  if (!bucket || addressingStyle !== 'virtual_hosted') {
    return baseUri;
  }
  const encodedBucket = encodeRfc3986(bucket);
  if (baseUri === '/') {
    return `/${encodedBucket}/`;
  }
  if (baseUri === `/${encodedBucket}` || baseUri.startsWith(`/${encodedBucket}/`)) {
    return baseUri;
  }
  return `/${encodedBucket}${baseUri}`;
}

export async function signS3Request(input: S3SignRequestInput): Promise<S3SignedRequest> {
  const urlObj = input.url instanceof URL ? input.url : new URL(input.url);
  const method = input.method.toUpperCase();
  const mode: S3SignatureAlgorithm = input.signatureMode ?? 'aws_v4';
  const service = input.service ?? (mode === 'oss_v4' ? 'oss' : 's3');
  const { amzDate, dateStamp } = formatAmzDate(input.date ?? new Date());
  const payloadHash = await sha256Hex(input.body ?? new Uint8Array(0));

  // Preserve caller headers (lowercased) excluding stale auth/host headers
  const outputHeaders: Record<string, string> = {};
  const signingHeaders: Record<string, string> = {
    host: urlObj.host,
  };

  if (input.headers) {
    for (const [rawKey, rawVal] of Object.entries(input.headers)) {
      if (rawVal === undefined || rawVal === null) continue;
      const lowerKey = rawKey.toLowerCase();
      if (lowerKey === 'authorization' || lowerKey === 'host') continue;
      const normalizedVal = normalizeHeaderValue(rawVal);
      outputHeaders[rawKey] = normalizedVal;
      signingHeaders[lowerKey] = normalizedVal;
    }
  }

  if (mode === 'oss_v4') {
    const contentHashHeaderVal = 'UNSIGNED-PAYLOAD';
    outputHeaders['x-oss-date'] = amzDate;
    outputHeaders['x-oss-content-sha256'] = contentHashHeaderVal;
    signingHeaders['x-oss-date'] = amzDate;
    signingHeaders['x-oss-content-sha256'] = contentHashHeaderVal;

    if (input.sessionToken) {
      outputHeaders['x-oss-security-token'] = input.sessionToken;
      signingHeaders['x-oss-security-token'] = normalizeHeaderValue(input.sessionToken);
    }

    const canonicalUri = resolveOssCanonicalUri(urlObj.pathname, input.bucket, input.addressingStyle);
    const canonicalQuery = canonicalizeQueryString(urlObj.search, true);

    const sortedKeys = Object.keys(signingHeaders).sort();
    const canonicalHeaders = sortedKeys.map((k) => `${k}:${signingHeaders[k]}\n`).join('');
    const additionalHeadersList = sortedKeys.filter(
      (k) => !k.startsWith('x-oss-') && k !== 'content-type' && k !== 'content-md5',
    );
    const additionalHeadersStr = additionalHeadersList.join(';');

    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      additionalHeadersStr,
      contentHashHeaderVal,
    ].join('\n');

    const scope = `${dateStamp}/${input.region}/${service}/aliyun_v4_request`;
    const canonicalRequestHash = await sha256Hex(canonicalRequest);
    const stringToSign = ['OSS4-HMAC-SHA256', amzDate, scope, canonicalRequestHash].join('\n');

    const kDate = await hmacSha256Bytes(`aliyun_v4${input.secretAccessKey}`, dateStamp);
    const kRegion = await hmacSha256Bytes(kDate, input.region);
    const kService = await hmacSha256Bytes(kRegion, service);
    const kSigning = await hmacSha256Bytes(kService, 'aliyun_v4_request');
    const signature = bytesToHex(await hmacSha256Bytes(kSigning, stringToSign));

    const additionalPart = additionalHeadersStr ? `,AdditionalHeaders=${additionalHeadersStr}` : '';
    outputHeaders['Authorization'] =
      `OSS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}${additionalPart},Signature=${signature}`;

    return {
      headers: outputHeaders,
      canonicalRequest,
      stringToSign,
      signature,
      signedHeaders: sortedKeys.join(';'),
      amzDate,
      dateStamp,
      payloadHash,
    };
  }

  // Standard AWS Signature Version 4 (AWS4-HMAC-SHA256)
  outputHeaders['x-amz-date'] = amzDate;
  outputHeaders['x-amz-content-sha256'] = payloadHash;
  signingHeaders['x-amz-date'] = amzDate;
  signingHeaders['x-amz-content-sha256'] = payloadHash;

  if (input.sessionToken) {
    outputHeaders['x-amz-security-token'] = input.sessionToken;
    signingHeaders['x-amz-security-token'] = normalizeHeaderValue(input.sessionToken);
  }

  const canonicalUri = canonicalizeUri(urlObj.pathname);
  const canonicalQuery = canonicalizeQueryString(urlObj.search, false);

  const sortedKeys = Object.keys(signingHeaders).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${signingHeaders[k]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const canonicalRequestHash = await sha256Hex(canonicalRequest);
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, canonicalRequestHash].join('\n');

  const kDate = await hmacSha256Bytes(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = await hmacSha256Bytes(kDate, input.region);
  const kService = await hmacSha256Bytes(kRegion, service);
  const kSigning = await hmacSha256Bytes(kService, 'aws4_request');
  const signature = bytesToHex(await hmacSha256Bytes(kSigning, stringToSign));

  outputHeaders['Authorization'] =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    headers: outputHeaders,
    canonicalRequest,
    stringToSign,
    signature,
    signedHeaders,
    amzDate,
    dateStamp,
    payloadHash,
  };
}
