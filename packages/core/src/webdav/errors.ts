/**
 * Structured WebDAV HTTP & Transport Error Classification.
 * Ensures 401/403/507 are strictly non-retryable and never confused with 404 or empty spaces.
 */

export interface WebDAVHttpErrorInit {
  status: number;
  code: string;
  phase: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  suggestion: string;
}

export class WebDAVHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly phase: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly suggestion: string;

  constructor(init: WebDAVHttpErrorInit) {
    super(init.message);
    this.name = 'WebDAVHttpError';
    this.status = init.status;
    this.code = init.code;
    this.phase = init.phase;
    this.retryable = init.retryable;
    this.retryAfterMs = init.retryAfterMs;
    this.suggestion = init.suggestion;
  }
}

export function parseRetryAfterMs(headerValue?: string | null): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

export function createHttpStatusError(
  status: number,
  phase: string,
  targetPath: string,
  retryAfterHeader?: string | null,
): WebDAVHttpError {
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader);

  switch (status) {
    case 400:
      return new WebDAVHttpError({
        status,
        code: 'WEBDAV_BAD_REQUEST',
        phase,
        message: `WebDAV ${phase} failed with 400 Bad Request (${targetPath})`,
        retryable: false,
        suggestion: 'Check WebDAV URL format, root path, and request headers.',
      });
    case 401:
      return new WebDAVHttpError({
        status,
        code: 'WEBDAV_AUTH_FAILED',
        phase,
        message: `WebDAV authentication failed (401 Unauthorized) during ${phase}`,
        retryable: false,
        suggestion: 'Verify your WebDAV username, password / app password, or Bearer token.',
      });
    case 403:
      return new WebDAVHttpError({
        status,
        code: 'WEBDAV_FORBIDDEN',
        phase,
        message: `WebDAV permission denied (403 Forbidden) during ${phase} (${targetPath})`,
        retryable: false,
        suggestion: 'Confirm this account has read/write permissions for the configured WebDAV root path.',
      });
    case 404:
      return new WebDAVHttpError({
        status,
        code: 'WEBDAV_NOT_FOUND',
        phase,
        message: `WebDAV resource not found (404) during ${phase} (${targetPath})`,
        retryable: false,
        suggestion: 'Ensure the target directory or file exists on the WebDAV server.',
      });
    case 405:
      return new WebDAVHttpError({
        status,
        code: 'WEBDAV_METHOD_NOT_ALLOWED',
        phase,
        message: `WebDAV method not allowed (405) during ${phase} (${targetPath})`,
        retryable: false,
        suggestion: 'Verify the server supports WebDAV RFC 4918 methods or whether the resource already exists.',
      });
    case 409:
      return new WebDAVHttpError({
        status,
        code: 'WEBDAV_CONFLICT',
        phase,
        message: `WebDAV conflict (409) during ${phase} (${targetPath})`,
        retryable: false,
        suggestion: 'Parent directory may be missing; create parent directories before writing.',
      });
    case 412:
      return new WebDAVHttpError({
        status,
        code: 'WEBDAV_PRECONDITION_FAILED',
        phase,
        message: `WebDAV precondition failed (412) during ${phase} (${targetPath})`,
        retryable: true,
        suggestion: 'Remote resource changed concurrently or already exists; re-read remote state and merge.',
      });
    case 423:
      return new WebDAVHttpError({
        status,
        code: 'WEBDAV_LOCKED',
        phase,
        message: `WebDAV resource locked (423) during ${phase} (${targetPath})`,
        retryable: true,
        retryAfterMs: retryAfterMs ?? 2000,
        suggestion: 'Resource is temporarily locked on the server; sync will retry automatically.',
      });
    case 429:
      return new WebDAVHttpError({
        status,
        code: 'WEBDAV_RATE_LIMITED',
        phase,
        message: `WebDAV rate limit exceeded (429 Too Many Requests) during ${phase}`,
        retryable: true,
        retryAfterMs: retryAfterMs ?? 5000,
        suggestion: 'Server rate limit reached; enable Low-Frequency Mode or wait before retrying.',
      });
    case 507:
      return new WebDAVHttpError({
        status,
        code: 'WEBDAV_INSUFFICIENT_STORAGE',
        phase,
        message: `WebDAV storage quota exceeded (507 Insufficient Storage) during ${phase}`,
        retryable: false,
        suggestion: 'Free up WebDAV storage space or clean up old backups/history before resuming uploads.',
      });
    default: {
      const is5xx = status >= 500 && status <= 599;
      return new WebDAVHttpError({
        status,
        code: is5xx ? 'WEBDAV_SERVER_ERROR' : 'WEBDAV_HTTP_ERROR',
        phase,
        message: `WebDAV ${phase} failed with HTTP ${status} (${targetPath})`,
        retryable: is5xx,
        retryAfterMs,
        suggestion: is5xx
          ? 'WebDAV server encountered a temporary error; sync will retry automatically.'
          : 'Check WebDAV server configuration and compatibility.',
      });
    }
  }
}
