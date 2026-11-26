import type {
  ApplyVerificationResult,
  BrowserApiAdapter,
  BrowserCookieInput,
  CookieRecord,
  PartitionKeyInfo,
} from '../types';
import { isLocalOrSingleLabelHost } from './EnvCookieMapper';

/**
 * Chromium / RFC 6265 ALWAYS forces `hostOnly = true` (bare domain, no leading dot) for:
 * - `__Host-` prefix cookies
 * - `localhost`, IPv4/IPv6 literals, and single-label intranet hostnames
 */
export function resolveEffectiveHostOnly(
  domain: string,
  hostOnly: boolean,
  name?: string,
): boolean {
  if (name?.startsWith('__Host-')) return true;
  const bare = domain.trim().toLowerCase().replace(/^\.+/, '');
  if (isLocalOrSingleLabelHost(bare)) return true;
  return Boolean(hostOnly);
}

export function normalizeCookieDomain(domain: string, hostOnly: boolean): string {
  const clean = domain.trim().toLowerCase();
  const bare = clean.replace(/^\.+/, '');
  if (hostOnly || isLocalOrSingleLabelHost(bare)) {
    return bare;
  }
  return clean.startsWith('.') ? clean : `.${clean}`;
}

export function matchesCookieIdentity(
  candidate: Pick<BrowserCookieInput, 'domain' | 'hostOnly' | 'path' | 'name' | 'partitionKey'>,
  target: {
    domain: string;
    hostOnly: boolean;
    path: string;
    name: string;
    partitionKey?: PartitionKeyInfo | null;
  },
): boolean {
  if (candidate.name !== target.name) return false;
  const candHostOnly = resolveEffectiveHostOnly(candidate.domain, candidate.hostOnly, candidate.name);
  const targetHostOnly = resolveEffectiveHostOnly(target.domain, target.hostOnly, target.name);
  if (candHostOnly !== targetHostOnly) return false;
  if (
    normalizeCookieDomain(candidate.domain, candHostOnly) !==
    normalizeCookieDomain(target.domain, targetHostOnly)
  ) {
    return false;
  }
  if ((candidate.path || '/') !== (target.path || '/')) return false;
  const candPk = candidate.partitionKey?.topLevelSite ?? '';
  const targetPk = target.partitionKey?.topLevelSite ?? '';
  return candPk === targetPk;
}

/**
 * Resolves the exact cookie from the browser jar, avoiding Chromium's `chrome.cookies.get()`
 * ambiguity when a hostOnly cookie (`app.example.com`) and a wildcard domain cookie (`.example.com`)
 * share the same `(name, path)`.
 */
export async function findExactBrowserCookie(
  browser: BrowserApiAdapter,
  target: {
    url: string;
    domain: string;
    hostOnly: boolean;
    path: string;
    name: string;
    storeId?: string;
    partitionKey?: PartitionKeyInfo | null;
  },
): Promise<BrowserCookieInput | null> {
  const first = await browser.getCookie({
    url: target.url,
    name: target.name,
    storeId: target.storeId,
    partitionKey: target.partitionKey,
  });
  if (first && matchesCookieIdentity(first, target)) {
    return first;
  }

  // Fallback to getAllCookies to disambiguate colliding hostOnly vs wildcard-domain / sibling-path cookies
  const allForUrl = await browser.getAllCookies({
    url: target.url,
    storeId: target.storeId,
  });
  const exact = allForUrl.find((c) => matchesCookieIdentity(c, target));
  if (exact) {
    return exact;
  }

  // If still not found (e.g., mock adapter ignoring `url` filter), fall back to `first` only when
  // no colliding sibling identity discrepancy exists
  if (first && first.name === target.name && (first.path || '/') === (target.path || '/')) {
    const cleanFirst = first.domain.trim().toLowerCase().replace(/^\.+/, '');
    const cleanTarget = target.domain.trim().toLowerCase().replace(/^\.+/, '');
    if (cleanFirst === cleanTarget && Boolean(first.hostOnly) === Boolean(target.hostOnly)) {
      return first;
    }
  }
  return null;
}

export function buildCookieUrl(
  cookie: Pick<BrowserCookieInput, 'domain' | 'path' | 'secure' | 'name' | 'sameSite'>,
): string {
  const host = cookie.domain.trim().toLowerCase().replace(/^\.+/, '');
  const mustBeHttps =
    cookie.secure ||
    cookie.name.startsWith('__Host-') ||
    cookie.name.startsWith('__Secure-') ||
    cookie.sameSite === 'no_restriction';
  const scheme = mustBeHttps ? 'https' : 'http';
  const rawPath = cookie.name.startsWith('__Host-') ? '/' : cookie.path || '/';
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  return `${scheme}://${host}${path}`;
}

/**
 * Deterministic canonical fingerprint of cookie value + attributes (excluding causal metadata).
 * Used for S-012 (avoiding spurious versions when nothing actually changed) and EchoSuppressor.
 */
export function cookieContentCanonicalHash(
  cookie: Pick<
    BrowserCookieInput,
    | 'domain'
    | 'path'
    | 'name'
    | 'value'
    | 'secure'
    | 'httpOnly'
    | 'sameSite'
    | 'session'
    | 'expirationDate'
    | 'hostOnly'
    | 'partitionKey'
  >,
): string {
  const exp =
    cookie.session || cookie.expirationDate === undefined
      ? 'session'
      : String(Math.round(cookie.expirationDate));
  const pk = cookie.partitionKey?.topLevelSite ?? '';
  const dom = cookie.domain.trim().toLowerCase().replace(/^\.+/, '');
  const effectiveHostOnly = resolveEffectiveHostOnly(cookie.domain, cookie.hostOnly, cookie.name);
  return JSON.stringify([
    dom,
    effectiveHostOnly ? 1 : 0,
    cookie.path || '/',
    cookie.name,
    cookie.value,
    cookie.secure ? 1 : 0,
    cookie.httpOnly ? 1 : 0,
    cookie.sameSite || 'unspecified',
    exp,
    pk,
  ]);
}

/**
 * Applies a cookie to BrowserApiAdapter while handling Chromium edge cases:
 * - __Host- prefix (hostOnly=true, path='/', secure=true, https URL, no domain attr)
 * - __Secure- prefix & SameSite=None (secure=true, https URL)
 * - CHIPS partitionKey with graceful degradation fallback if browser rejects partitionKey
 * - Mandatory read-back verification via browser.getCookie() (Prohibition #7)
 */
export async function applyCookieWithVerification(
  browser: BrowserApiAdapter,
  cookie: Pick<
    CookieRecord | BrowserCookieInput,
    | 'domain'
    | 'name'
    | 'value'
    | 'path'
    | 'secure'
    | 'httpOnly'
    | 'sameSite'
    | 'session'
    | 'expirationDate'
    | 'hostOnly'
    | 'partitionKey'
  > & { storeId?: string; storeScope?: string },
  nowMs: number,
): Promise<ApplyVerificationResult> {
  // Never write already-expired persistent cookies
  if (!cookie.session && cookie.expirationDate !== undefined && cookie.expirationDate <= nowMs / 1000) {
    return {
      accepted: false,
      verifiedAt: nowMs,
      expired: true,
      reason: 'Cookie is already expired',
    };
  }

  const isHostPrefix = cookie.name.startsWith('__Host-');
  const isSecurePrefix = cookie.name.startsWith('__Secure-');
  const isSameSiteNone = cookie.sameSite === 'no_restriction';

  // Enforce Chromium prefix/SameSite & localhost/IP hostOnly constraints
  const effectiveHostOnly = resolveEffectiveHostOnly(cookie.domain, cookie.hostOnly, cookie.name);
  const effectivePath = isHostPrefix ? '/' : cookie.path || '/';
  const effectiveSecure = isHostPrefix || isSecurePrefix || isSameSiteNone ? true : cookie.secure;
  const effectiveDomain = normalizeCookieDomain(cookie.domain, effectiveHostOnly);

  // If the incoming record explicitly violated __Host- / __Secure- / SameSite=None invariants
  // AND had incompatible attributes that we shouldn't silently lie about, check:
  // Actually Chromium requires secure=true for __Host-/__Secure-/SameSite=None and path='/' + hostOnly for __Host-.
  // We construct a compliant details payload (omitting domain semantics via hostOnly:true for __Host-)
  // unless caller passed an unfixable invalid domain (empty).
  const host = effectiveDomain.replace(/^\.+/, '');
  if (!host) {
    return {
      accepted: false,
      verifiedAt: nowMs,
      reason: 'Invalid empty cookie domain',
    };
  }

  const url = buildCookieUrl({
    domain: host,
    path: effectivePath,
    secure: effectiveSecure,
    name: cookie.name,
    sameSite: cookie.sameSite,
  });

  const rawStoreId = cookie.storeId ?? cookie.storeScope;
  const storeId = rawStoreId && rawStoreId !== 'default' ? rawStoreId : undefined;
  let usedPartitionKey: PartitionKeyInfo | null | undefined = cookie.partitionKey ?? undefined;
  let degradedPartitionKey = false;

  const baseDetails: BrowserCookieInput & { url: string } = {
    url,
    domain: effectiveHostOnly ? host : effectiveDomain,
    name: cookie.name,
    value: cookie.value,
    path: effectivePath,
    secure: effectiveSecure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    session: cookie.session,
    expirationDate: cookie.session ? undefined : cookie.expirationDate,
    hostOnly: effectiveHostOnly,
    storeId,
    partitionKey: usedPartitionKey,
  };

  let setResult: { cookie: BrowserCookieInput | null; error?: string };
  try {
    setResult = await browser.setCookie(baseDetails);
  } catch (err) {
    setResult = {
      cookie: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Graceful fallback for CHIPS partitionKey if browser rejects it
  if ((!setResult.cookie || setResult.error) && usedPartitionKey) {
    usedPartitionKey = undefined;
    degradedPartitionKey = true;
    try {
      setResult = await browser.setCookie({
        ...baseDetails,
        partitionKey: undefined,
      });
    } catch (err) {
      setResult = {
        cookie: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (!setResult.cookie || setResult.error) {
    return {
      accepted: false,
      verifiedAt: nowMs,
      reason: setResult.error || 'browser.setCookie returned null',
      degradedPartitionKey: degradedPartitionKey || undefined,
    };
  }

  // Mandatory read-back verification (Prohibition #7)
  // Uses exact identity matching to avoid Chromium's `chrome.cookies.get()` ambiguity when
  // hostOnly (`app.example.com`) and wildcard-domain (`.example.com`) cookies share `(name, path)`.
  let readBack: BrowserCookieInput | null = null;
  try {
    readBack = await findExactBrowserCookie(browser, {
      url,
      domain: effectiveHostOnly ? host : effectiveDomain,
      hostOnly: effectiveHostOnly,
      path: effectivePath,
      name: cookie.name,
      storeId,
      partitionKey: usedPartitionKey,
    });
  } catch (err) {
    return {
      accepted: false,
      verifiedAt: nowMs,
      reason: `Read-back getCookie failed: ${err instanceof Error ? err.message : String(err)}`,
      degradedPartitionKey: degradedPartitionKey || undefined,
    };
  }

  if (!readBack) {
    return {
      accepted: false,
      verifiedAt: nowMs,
      reason: 'Read-back verification failed: cookie not found in browser jar after setCookie',
      degradedPartitionKey: degradedPartitionKey || undefined,
    };
  }

  if (readBack.value !== cookie.value) {
    return {
      accepted: false,
      verifiedAt: nowMs,
      reason: 'Read-back verification failed: stored cookie value differs from expected value',
      degradedPartitionKey: degradedPartitionKey || undefined,
    };
  }

  if ((readBack.path || '/') !== effectivePath) {
    return {
      accepted: false,
      verifiedAt: nowMs,
      reason: `Read-back verification failed: path mismatch (${readBack.path} !== ${effectivePath})`,
      degradedPartitionKey: degradedPartitionKey || undefined,
    };
  }

  if (Boolean(readBack.secure) !== Boolean(effectiveSecure)) {
    return {
      accepted: false,
      verifiedAt: nowMs,
      reason: 'Read-back verification failed: secure attribute mismatch',
      degradedPartitionKey: degradedPartitionKey || undefined,
    };
  }

  if (Boolean(readBack.httpOnly) !== Boolean(cookie.httpOnly)) {
    return {
      accepted: false,
      verifiedAt: nowMs,
      reason: 'Read-back verification failed: httpOnly attribute mismatch',
      degradedPartitionKey: degradedPartitionKey || undefined,
    };
  }

  return {
    accepted: true,
    verifiedAt: nowMs,
    degradedPartitionKey: degradedPartitionKey || undefined,
  };
}
