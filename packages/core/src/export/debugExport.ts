import { isAnalyticsNoiseCookie, normalizeDomain } from '../psl';
import type {
  BrowserCookieInput,
  CookieRecord,
  DebugExportFormat,
  DebugExportResult,
  SameSiteValue,
} from '../types';

export interface SelectDebugCookiesOptions {
  targetUrl?: string;
  nowMs?: number;
  filterNoise?: boolean;
  format?: DebugExportFormat;
}

export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export interface PlaywrightOriginEntry {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

export interface PlaywrightStorageState {
  cookies: PlaywrightCookie[];
  origins: PlaywrightOriginEntry[];
}

export interface PostmanApifoxCookie {
  key: string;
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSiteValue;
  session: boolean;
  expirationDate?: number;
}

export interface BuildDebugExportParams {
  format: DebugExportFormat;
  siteKey: string;
  trackId?: string;
  trackLabel?: string;
  targetUrl?: string;
  cookies: Array<BrowserCookieInput | CookieRecord>;
  localStorageByOrigin?: Record<string, Record<string, string>>;
  sessionStorageByOrigin?: Record<string, Record<string, string>>;
  filterNoise?: boolean;
  liveFallback?: boolean;
  nowMs?: number;
}

const HTTP_REQUEST_FORMATS: ReadonlySet<DebugExportFormat> = new Set([
  'curl',
  'fetch',
  'cookie_header',
  'headers_json',
]);

function stripCrLf(value: string): string {
  return value.replace(/[\r\n]+/g, '');
}

function stripCrLfAndTabs(value: string): string {
  return value.replace(/[\r\n\t]+/g, '');
}

function escapePosixSingleQuote(value: string): string {
  return stripCrLf(value).replace(/'/g, "'\\''");
}

function toExpiryMs(expirationDate: number): number {
  return expirationDate > 1e12 ? expirationDate : expirationDate * 1000;
}

function toUnixSeconds(expirationDate: number): number {
  return expirationDate > 1e12 ? Math.floor(expirationDate / 1000) : expirationDate;
}

function parseHttpTargetUrl(
  rawUrl?: string,
): { urlHost: string; urlPath: string; isHttps: boolean; isLocalhost: boolean } | null {
  if (!rawUrl || !rawUrl.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  const urlHost = normalizeDomain(parsed.hostname);
  if (!urlHost) return null;
  const isHttps = parsed.protocol === 'https:';
  const isLocalhost =
    urlHost === 'localhost' || urlHost === '127.0.0.1' || urlHost === '[::1]';
  const urlPath = parsed.pathname || '/';
  return { urlHost, urlPath, isHttps, isLocalhost };
}

function rfc6265PathMatches(urlPath: string, cookiePath: string): boolean {
  const normCookiePath = cookiePath || '/';
  if (urlPath === normCookiePath) return true;
  if (!urlPath.startsWith(normCookiePath)) return false;
  return normCookiePath.endsWith('/') || urlPath[normCookiePath.length] === '/';
}

function compareStringsDeterministic(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function getCookieUpdatedAt(cookie: BrowserCookieInput | CookieRecord): number {
  return 'updatedAt' in cookie && typeof cookie.updatedAt === 'number'
    ? cookie.updatedAt
    : 0;
}

function getCookieExpiryRank(cookie: BrowserCookieInput | CookieRecord): number {
  if (cookie.session) return Number.MAX_SAFE_INTEGER;
  return cookie.expirationDate !== undefined ? toExpiryMs(cookie.expirationDate) : 0;
}

/**
 * Filters, deduplicates, and sorts cookies for debug export.
 * Applies RFC 6265 scheme, domain, and path matching when a valid HTTP(S) `targetUrl` is supplied
 * for HTTP-request formats (or when `format` is omitted).
 */
export function selectCookiesForDebugExport<T extends BrowserCookieInput | CookieRecord>(
  cookies: readonly T[],
  options: SelectDebugCookiesOptions = {},
): T[] {
  const nowMs = options.nowMs ?? Date.now();
  const filterNoise = options.filterNoise !== false;
  const shouldMatchTargetUrl =
    options.format === undefined || HTTP_REQUEST_FORMATS.has(options.format);
  const parsedTarget = shouldMatchTargetUrl ? parseHttpTargetUrl(options.targetUrl) : null;

  const deduped = new Map<string, T>();

  for (const cookie of cookies) {
    if (!cookie || !cookie.name) continue;
    if ('deleted' in cookie && cookie.deleted === true) continue;

    if (!cookie.session && cookie.expirationDate !== undefined) {
      const expMs = toExpiryMs(cookie.expirationDate);
      if (!Number.isFinite(expMs) || expMs <= nowMs) {
        continue;
      }
    }

    if (filterNoise && isAnalyticsNoiseCookie(cookie.name)) {
      continue;
    }

    const normDomain = normalizeDomain(cookie.domain);
    const cookiePath = cookie.path || '/';

    if (parsedTarget) {
      if (cookie.secure && !parsedTarget.isHttps && !parsedTarget.isLocalhost) {
        continue;
      }
      if (!normDomain) continue;
      const domainMatches = cookie.hostOnly
        ? parsedTarget.urlHost === normDomain
        : parsedTarget.urlHost === normDomain ||
          parsedTarget.urlHost.endsWith(`.${normDomain}`);
      if (!domainMatches) continue;
      if (!rfc6265PathMatches(parsedTarget.urlPath, cookiePath)) continue;
    }

    const identityKey = `${cookie.hostOnly ? 'h' : 'd'}::${normDomain}::${cookiePath}::${cookie.name}`;
    const existing = deduped.get(identityKey);
    if (!existing) {
      deduped.set(identityKey, cookie);
    } else {
      const nextUpdatedAt = getCookieUpdatedAt(cookie);
      const prevUpdatedAt = getCookieUpdatedAt(existing);
      if (
        nextUpdatedAt > prevUpdatedAt ||
        (nextUpdatedAt === prevUpdatedAt &&
          getCookieExpiryRank(cookie) > getCookieExpiryRank(existing))
      ) {
        deduped.set(identityKey, cookie);
      }
    }
  }

  return Array.from(deduped.values()).sort((a, b) => {
    const aPath = a.path || '/';
    const bPath = b.path || '/';
    if (bPath.length !== aPath.length) {
      return bPath.length - aPath.length;
    }
    const aHostOnly = a.hostOnly ? 1 : 0;
    const bHostOnly = b.hostOnly ? 1 : 0;
    if (bHostOnly !== aHostOnly) {
      return bHostOnly - aHostOnly;
    }
    const aDomain = normalizeDomain(a.domain);
    const bDomain = normalizeDomain(b.domain);
    if (bDomain.length !== aDomain.length) {
      return bDomain.length - aDomain.length;
    }
    const byName = compareStringsDeterministic(a.name, b.name);
    if (byName !== 0) return byName;
    const byPath = compareStringsDeterministic(aPath, bPath);
    if (byPath !== 0) return byPath;
    return compareStringsDeterministic(aDomain, bDomain);
  });
}

export function formatCookieHeaderString(
  cookies: readonly Pick<BrowserCookieInput, 'name' | 'value'>[],
): string {
  return cookies
    .map((c) => `${stripCrLf(c.name)}=${stripCrLf(c.value)}`)
    .join('; ');
}

export function formatCurlCommand(
  targetUrl: string,
  cookies: readonly Pick<BrowserCookieInput, 'name' | 'value'>[],
): string {
  const escapedUrl = escapePosixSingleQuote(targetUrl);
  const escapedHeader = escapePosixSingleQuote(formatCookieHeaderString(cookies));
  return `curl '${escapedUrl}' -H 'Cookie: ${escapedHeader}'`;
}

export function formatFetchSnippet(
  targetUrl: string,
  cookies: readonly Pick<BrowserCookieInput, 'name' | 'value'>[],
): string {
  const safeUrl = JSON.stringify(stripCrLf(targetUrl));
  const safeCookieHeader = JSON.stringify(formatCookieHeaderString(cookies));
  return [
    '// Note: Node.js/Server fetch only — browser fetch forbids setting the "Cookie" header manually.',
    `fetch(${safeUrl}, {`,
    '  headers: {',
    `    "Cookie": ${safeCookieHeader}`,
    '  }',
    '});',
  ].join('\n');
}

export function formatHeadersJson(
  cookies: readonly Pick<BrowserCookieInput, 'name' | 'value'>[],
): string {
  return JSON.stringify(
    {
      Cookie: formatCookieHeaderString(cookies),
    },
    null,
    2,
  );
}

function mapPlaywrightSameSite(sameSite: SameSiteValue | undefined): 'Strict' | 'Lax' | 'None' {
  switch (sameSite) {
    case 'no_restriction':
      return 'None';
    case 'strict':
      return 'Strict';
    case 'lax':
    case 'unspecified':
    default:
      return 'Lax';
  }
}

function formatCookieDomainForJar(domain: string, hostOnly: boolean, fallbackSiteKey = ''): string {
  const cleanHost = normalizeDomain(domain) || normalizeDomain(fallbackSiteKey);
  if (!cleanHost) return '';
  if (hostOnly) return cleanHost;
  return domain.trim().startsWith('.') ? `.${cleanHost}` : `.${cleanHost}`;
}

export function buildPlaywrightStorageState(
  cookies: readonly BrowserCookieInput[],
  localStorageByOrigin?: Record<string, Record<string, string>>,
  sessionStorageByOrigin?: Record<string, Record<string, string>>,
): PlaywrightStorageState {
  // Playwright storageState.json schema models cookies + localStorage origins; accept sessionStorageByOrigin for uniform formatter invocation.
  void sessionStorageByOrigin;

  const pwCookies: PlaywrightCookie[] = cookies.map((c) => {
    const domain = formatCookieDomainForJar(c.domain, Boolean(c.hostOnly));
    const expires =
      c.session || c.expirationDate === undefined || c.expirationDate === null
        ? -1
        : toUnixSeconds(c.expirationDate);
    return {
      name: c.name,
      value: c.value,
      domain,
      path: c.path || '/',
      expires,
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite: mapPlaywrightSameSite(c.sameSite),
    };
  });

  const origins: PlaywrightOriginEntry[] = [];
  if (localStorageByOrigin) {
    const sortedOrigins = Object.keys(localStorageByOrigin).sort(compareStringsDeterministic);
    for (const origin of sortedOrigins) {
      const entries = localStorageByOrigin[origin];
      if (!entries) continue;
      const sortedKeys = Object.keys(entries).sort(compareStringsDeterministic);
      if (sortedKeys.length === 0) continue;
      origins.push({
        origin,
        localStorage: sortedKeys.map((name) => ({
          name,
          value: entries[name] ?? '',
        })),
      });
    }
  }

  return {
    cookies: pwCookies,
    origins,
  };
}

export function formatPlaywrightStorageState(
  cookies: readonly BrowserCookieInput[],
  localStorageByOrigin?: Record<string, Record<string, string>>,
  sessionStorageByOrigin?: Record<string, Record<string, string>>,
): string {
  return JSON.stringify(
    buildPlaywrightStorageState(cookies, localStorageByOrigin, sessionStorageByOrigin),
    null,
    2,
  );
}

export function formatPostmanApifoxCookies(
  cookies: readonly BrowserCookieInput[],
  siteKey: string,
): string {
  const items: PostmanApifoxCookie[] = cookies.map((c) => {
    const item: PostmanApifoxCookie = {
      key: c.name,
      name: c.name,
      value: c.value,
      domain: formatCookieDomainForJar(c.domain, Boolean(c.hostOnly), siteKey),
      hostOnly: Boolean(c.hostOnly),
      path: c.path || '/',
      secure: Boolean(c.secure),
      httpOnly: Boolean(c.httpOnly),
      sameSite: c.sameSite ?? 'unspecified',
      session: Boolean(c.session),
    };
    if (!c.session && c.expirationDate !== undefined) {
      item.expirationDate = toUnixSeconds(c.expirationDate);
    }
    return item;
  });
  return JSON.stringify(items, null, 2);
}

export function formatNetscapeCookiesTxt(cookies: readonly BrowserCookieInput[]): string {
  const lines = [
    '# Netscape HTTP Cookie File',
    '# https://curl.se/docs/http-cookies.html',
    '# Generated by SessionMesh',
  ];

  for (const c of cookies) {
    const cleanHost = normalizeDomain(c.domain);
    if (!cleanHost) continue;
    const includeSubdomains = !c.hostOnly;
    const baseDomain = includeSubdomains ? `.${cleanHost}` : cleanHost;
    const domainField = c.httpOnly ? `#HttpOnly_${baseDomain}` : baseDomain;
    const flag = includeSubdomains ? 'TRUE' : 'FALSE';
    const pathField = stripCrLfAndTabs(c.path || '/');
    const secureField = c.secure ? 'TRUE' : 'FALSE';
    const expiryField =
      c.session || !c.expirationDate ? '0' : String(Math.floor(toUnixSeconds(c.expirationDate)));
    const nameField = stripCrLfAndTabs(c.name);
    const valueField = stripCrLfAndTabs(c.value);

    lines.push(
      [domainField, flag, pathField, secureField, expiryField, nameField, valueField].join('\t'),
    );
  }

  return `${lines.join('\n')}\n`;
}

function resolveDefaultTargetUrl(
  siteKey: string,
  cookies: readonly (BrowserCookieInput | CookieRecord)[],
): string {
  const normSite = normalizeDomain(siteKey);
  if (normSite) {
    const isLocal =
      normSite === 'localhost' || normSite === '127.0.0.1' || normSite === '[::1]';
    const allInsecure = cookies.length > 0 && cookies.every((c) => !c.secure);
    const scheme = isLocal && allInsecure ? 'http' : 'https';
    return `${scheme}://${normSite}/`;
  }
  const firstHost = cookies[0]?.domain ? normalizeDomain(cookies[0].domain) : '';
  return `https://${firstHost || 'example.com'}/`;
}

function buildSuggestedFilename(siteKey: string, format: DebugExportFormat): string {
  const safeSite = (normalizeDomain(siteKey) || 'site').replace(/[^a-z0-9._-]/gi, '_');
  switch (format) {
    case 'curl':
      return `${safeSite}.curl.sh`;
    case 'fetch':
      return `${safeSite}.fetch.js`;
    case 'cookie_header':
      return `${safeSite}.cookie.txt`;
    case 'headers_json':
      return `${safeSite}.headers.json`;
    case 'playwright_storage_state':
      return `${safeSite}.storageState.json`;
    case 'postman_apifox':
      return `${safeSite}.cookies.json`;
    case 'netscape_cookies_txt':
      return `${safeSite}.cookies.txt`;
  }
}

export function buildDebugExportResult(params: BuildDebugExportParams): DebugExportResult {
  const selectedCookies = selectCookiesForDebugExport(params.cookies, {
    targetUrl: params.targetUrl,
    nowMs: params.nowMs,
    filterNoise: params.filterNoise,
    format: params.format,
  });

  const targetUrl =
    params.targetUrl && params.targetUrl.trim()
      ? params.targetUrl.trim()
      : resolveDefaultTargetUrl(params.siteKey, selectedCookies);

  let content: string;
  let originCount = 0;

  switch (params.format) {
    case 'curl':
      content = formatCurlCommand(targetUrl, selectedCookies);
      break;
    case 'fetch':
      content = formatFetchSnippet(targetUrl, selectedCookies);
      break;
    case 'cookie_header':
      content = formatCookieHeaderString(selectedCookies);
      break;
    case 'headers_json':
      content = formatHeadersJson(selectedCookies);
      break;
    case 'playwright_storage_state': {
      const storageState = buildPlaywrightStorageState(
        selectedCookies,
        params.localStorageByOrigin,
        params.sessionStorageByOrigin,
      );
      originCount = storageState.origins.length;
      content = JSON.stringify(storageState, null, 2);
      break;
    }
    case 'postman_apifox':
      content = formatPostmanApifoxCookies(selectedCookies, params.siteKey);
      break;
    case 'netscape_cookies_txt':
      content = formatNetscapeCookiesTxt(selectedCookies);
      break;
  }

  return {
    format: params.format,
    siteKey: params.siteKey,
    trackId: params.trackId,
    trackLabel: params.trackLabel,
    targetUrl,
    content,
    suggestedFilename: buildSuggestedFilename(params.siteKey, params.format),
    cookieCount: selectedCookies.length,
    originCount,
    liveFallback: params.liveFallback,
  };
}
