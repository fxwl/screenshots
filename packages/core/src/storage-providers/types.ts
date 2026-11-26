/**
 * Shared types and path/network helpers for Multi-Provider Storage Adapters.
 */
import type {
  CapabilityCheckResult,
  CapabilityReport,
  ConsistencyLevel,
  GitHubGistStorageConfig,
  LocalDirectoryStorageConfig,
  RemoteObjectStat,
  RemoteStorageAdapter,
  S3StorageConfig,
  S3VendorPreset,
  SanitizedStorageProviderConfig,
  StorageProviderConfig,
  StorageProviderType,
} from '../types';
import { WebDAVHttpError } from '../webdav/errors';

export type {
  RemoteStorageAdapter,
  RemoteObjectStat,
  StorageProviderType,
  StorageProviderConfig,
  SanitizedStorageProviderConfig,
  S3StorageConfig,
  S3VendorPreset,
  GitHubGistStorageConfig,
  LocalDirectoryStorageConfig,
};

export interface LocalDirEntry {
  name: string;
  kind: 'file' | 'directory';
}

export interface VirtualDirectoryHandle {
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<VirtualDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<{
    getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; size: number; lastModified: number }>;
    createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }>;
  }>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterableIterator<[string, { kind: 'file' | 'directory'; name?: string }]>;
}

export type DirectoryHandleResolver = (handleKey: string) => Promise<VirtualDirectoryHandle | null>;

export interface StorageAdapterOptions {
  fetchImpl?: typeof fetch;
  resolveDirectoryHandle?: DirectoryHandleResolver;
}

export type StorageAdapterFactoryOptions = StorageAdapterOptions;

export function isLocalhostHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'localhost' || lower === '127.0.0.1' || lower === '[::1]' || lower === '::1';
}

export function splitCleanStorageSegments(pathStr: string, providerLabel = 'storage'): string[] {
  const raw = (pathStr || '').split('/');
  const out: string[] = [];
  for (const seg of raw) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      throw new WebDAVHttpError({
        status: 400,
        code: 'STORAGE_INVALID_PATH',
        phase: 'validate_path',
        message: `Path traversal ("..") is not permitted in ${providerLabel} path: ${pathStr}`,
        retryable: false,
        suggestion: 'Use a valid relative path without ".." segments.',
      });
    }
    out.push(seg);
  }
  return out;
}

export function validateHttpsEndpoint(
  rawUrl: string,
  allowInsecureLocalhostForTesting: boolean | undefined,
  providerLabel: string,
  errorCodePrefix: string,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new WebDAVHttpError({
      status: 0,
      code: `${errorCodePrefix}_INVALID_URL`,
      phase: 'validate_url',
      message: `Invalid ${providerLabel} URL: "${rawUrl}"`,
      retryable: false,
      suggestion: `Enter a valid full HTTPS ${providerLabel} URL.`,
    });
  }

  if (parsed.protocol === 'https:') {
    return parsed;
  }

  if (
    parsed.protocol === 'http:' &&
    allowInsecureLocalhostForTesting === true &&
    isLocalhostHostname(parsed.hostname)
  ) {
    return parsed;
  }

  if (parsed.protocol === 'http:') {
    throw new WebDAVHttpError({
      status: 0,
      code: `${errorCodePrefix}_INSECURE_HTTP`,
      phase: 'validate_url',
      message: `Insecure http:// ${providerLabel} URLs are forbidden; HTTPS is required.`,
      retryable: false,
      suggestion: `Update the ${providerLabel} endpoint URL to use https://.`,
    });
  }

  throw new WebDAVHttpError({
    status: 0,
    code: `${errorCodePrefix}_INVALID_PROTOCOL`,
    phase: 'validate_url',
    message: `Unsupported ${providerLabel} URL protocol: "${parsed.protocol}"`,
    retryable: false,
    suggestion: `Use an https:// ${providerLabel} URL.`,
  });
}

export function toExactBodyUint8Array(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

export async function performTimedFetch(params: {
  fetchImpl?: typeof fetch;
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: BodyInit | Uint8Array;
  timeoutMs?: number;
  phase: string;
  displayPath: string;
  providerLabel: string;
  errorCodePrefix: string;
}): Promise<Response> {
  const timeoutMs = params.timeoutMs ?? 30_000;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (typeof AbortController !== 'undefined' && timeoutMs > 0) {
    controller = new AbortController();
    timer = setTimeout(() => controller?.abort(), timeoutMs);
  }

  const fetchFn =
    params.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

  const bodyToSend: BodyInit | undefined =
    params.body instanceof Uint8Array ? toExactBodyUint8Array(params.body) : params.body;

  try {
    return await fetchFn(params.url, {
      method: params.method,
      headers: params.headers,
      body: bodyToSend,
      cache: 'no-store',
      signal: controller?.signal,
    });
  } catch (err: unknown) {
    const isAbort =
      err instanceof Error && (err.name === 'AbortError' || err.message.toLowerCase().includes('aborted'));
    if (isAbort) {
      throw new WebDAVHttpError({
        status: 0,
        code: `${params.errorCodePrefix}_TIMEOUT`,
        phase: params.phase,
        message: `${params.providerLabel} ${params.phase} timed out after ${timeoutMs}ms (${params.displayPath})`,
        retryable: true,
        suggestion: 'Check network latency or increase the request timeout.',
      });
    }
    const errMsg = err instanceof Error ? err.message : 'Network error';
    throw new WebDAVHttpError({
      status: 0,
      code: `${params.errorCodePrefix}_NETWORK_ERROR`,
      phase: params.phase,
      message: `${params.providerLabel} ${params.phase} network error (${params.displayPath}): ${errMsg}`,
      retryable: true,
      suggestion: 'Check your internet connection, DNS, TLS certificate, and service availability.',
    });
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function describeAdapterError(err: unknown): string {
  if (err instanceof WebDAVHttpError) {
    return `${err.code} (HTTP ${err.status}): ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function createCapabilityChecksTemplate(
  specs: Array<{ step: number; id: string; name: string }>,
): CapabilityCheckResult[] {
  return specs.map((s) => ({
    id: s.id,
    step: s.step,
    name: s.name,
    state: 'unverified',
  }));
}

export function buildCapabilityReport(params: {
  startedAt: number;
  url: string;
  consistencyLevel: ConsistencyLevel;
  overallOk: boolean;
  checks: CapabilityCheckResult[];
  resolvedGistId?: string;
  summaryMessage: string;
}): CapabilityReport {
  return {
    testedAt: params.startedAt,
    url: params.url,
    overallOk: params.overallOk,
    consistencyLevel: params.consistencyLevel,
    checks: params.checks,
    totalLatencyMs: Math.max(0, Date.now() - params.startedAt),
    ...(params.resolvedGistId ? { resolvedGistId: params.resolvedGistId } : {}),
    summaryMessage: params.summaryMessage,
  };
}
