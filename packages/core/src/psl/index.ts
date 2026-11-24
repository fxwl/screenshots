import type { SsoDomainGroup } from '../types';
import {
  ANALYTICS_COOKIE_PATTERNS,
  ANALYTICS_EXACT_COOKIE_NAMES,
  MULTI_LABEL_PUBLIC_SUFFIXES,
} from './suffixes';

function isIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const num = Number(part);
    if (num < 0 || num > 255) return false;
  }
  return true;
}

function isIpv6Literal(host: string): boolean {
  return (host.startsWith('[') && host.endsWith(']')) || host.includes(':');
}

function stripLeadingWildcard(pattern: string): string {
  return pattern.trim().replace(/^\*\./, '');
}

/**
 * Normalizes a domain, host, or URL into a canonical lowercase hostname:
 * - Extracts hostname from full URLs
 * - Strips port numbers
 * - Strips leading/trailing dots
 * - Normalizes IPv6 literals to bracketed lowercase (e.g. `[::1]`)
 * - Preserves IPv4 and `localhost`
 */
export function normalizeDomain(domainOrHost: string): string {
  if (!domainOrHost) return '';
  const trimmed = domainOrHost.trim();
  if (!trimmed) return '';

  let host = trimmed;

  if (host.includes('://')) {
    try {
      const parsed = new URL(host);
      host = parsed.hostname;
    } catch {
      // Fallback: strip scheme and path manually
      const afterScheme = host.slice(host.indexOf('://') + 3);
      host = afterScheme.split(/[/?#]/, 1)[0] ?? '';
    }
  } else {
    // Strip any path/query/fragment if accidentally included without scheme
    host = host.split(/[/?#]/, 1)[0] ?? '';
  }

  host = host.trim().toLowerCase();
  if (!host) return '';

  // Strip userinfo if present (e.g. user:pass@host)
  const atIndex = host.lastIndexOf('@');
  if (atIndex !== -1) {
    host = host.slice(atIndex + 1);
  }

  // Handle bracketed IPv6 with optional :port, e.g. [::1]:8080 or [2001:db8::1]
  if (host.startsWith('[')) {
    const closeBracket = host.indexOf(']');
    if (closeBracket !== -1) {
      return host.slice(0, closeBracket + 1);
    }
    return host;
  }

  // Handle unbracketed IPv6 literals (two or more colons), e.g. ::1 or 2001:db8::1
  const firstColon = host.indexOf(':');
  if (firstColon !== -1) {
    const lastColon = host.lastIndexOf(':');
    if (firstColon !== lastColon) {
      return `[${host}]`;
    }
    // Single colon: strip :port
    host = host.slice(0, firstColon);
  }

  // Strip leading & trailing dots (cookie domain leading dot, DNS trailing root dot)
  host = host.replace(/^\.+/, '').replace(/\.+$/, '');
  return host;
}

/**
 * Extracts the registrable domain (eTLD+1) using built-in PSL rules.
 * Returns `localhost` and IPv4/IPv6 literals as-is.
 */
export function getRegistrableDomain(domainOrHostOrUrl: string): string {
  const host = normalizeDomain(domainOrHostOrUrl);
  if (!host) return '';

  if (host === 'localhost' || isIpv4(host) || isIpv6Literal(host)) {
    return host;
  }

  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 1) {
    return host;
  }

  // Check 3-label multi-label public suffix (e.g. s3.amazonaws.com)
  if (labels.length >= 3) {
    const last3 = labels.slice(-3).join('.');
    if (MULTI_LABEL_PUBLIC_SUFFIXES.has(last3)) {
      return labels.length === 3 ? host : labels.slice(-4).join('.');
    }
  }

  // Check 2-label multi-label public suffix (e.g. com.cn, co.uk, github.io, vercel.app)
  const last2 = labels.slice(-2).join('.');
  if (MULTI_LABEL_PUBLIC_SUFFIXES.has(last2)) {
    return labels.length === 2 ? host : labels.slice(-3).join('.');
  }

  // Standard 1-label TLD -> eTLD+1
  return last2;
}

function hostMatchesDomainPattern(host: string, rawDomain: string): boolean {
  const normPattern = normalizeDomain(stripLeadingWildcard(rawDomain));
  if (!normPattern) return false;
  return host === normPattern || host.endsWith(`.${normPattern}`);
}

/**
 * Resolves a domain or URL to its canonical SessionMesh `siteKey`.
 * If the host matches an entry in `ssoGroups`, returns that group's normalized `primarySiteKey`.
 * Otherwise returns `getRegistrableDomain(domainOrUrl)`.
 */
export function resolveSiteKey(domainOrUrl: string, ssoGroups?: SsoDomainGroup[]): string {
  const host = normalizeDomain(domainOrUrl);
  if (!host) return '';

  if (ssoGroups && ssoGroups.length > 0) {
    for (const group of ssoGroups) {
      const primary = normalizeDomain(group.primarySiteKey);
      if (!primary) continue;

      if (hostMatchesDomainPattern(host, primary)) {
        return primary;
      }

      for (const candidate of group.domains) {
        if (hostMatchesDomainPattern(host, candidate)) {
          return primary;
        }
      }
    }
  }

  return getRegistrableDomain(host);
}

/**
 * Returns true ONLY for well-known pure analytics/tracking noise cookies.
 * Never filters real authentication or session cookies.
 */
export function isAnalyticsNoiseCookie(cookieName: string): boolean {
  if (!cookieName) return false;
  const normalized = cookieName.trim().toLowerCase();
  if (!normalized) return false;

  if (ANALYTICS_EXACT_COOKIE_NAMES.has(normalized)) {
    return true;
  }

  for (const pattern of ANALYTICS_COOKIE_PATTERNS) {
    if (pattern.test(normalized)) {
      return true;
    }
  }

  return false;
}

/**
 * Determines whether a cookie's domain belongs to the given `siteKey`,
 * taking eTLD+1 grouping and optional SSO domain groups into account.
 */
export function domainMatchesSiteKey(
  cookieDomain: string,
  siteKey: string,
  ssoGroups?: SsoDomainGroup[],
): boolean {
  const normCookie = normalizeDomain(cookieDomain);
  const normSiteKey = normalizeDomain(siteKey);
  if (!normCookie || !normSiteKey) return false;

  const resolvedCookie = resolveSiteKey(normCookie, ssoGroups);
  if (resolvedCookie === normSiteKey) {
    return true;
  }

  // Fallback when siteKey itself is a specific subdomain (not remapped to a different SSO group)
  const resolvedTarget = resolveSiteKey(normSiteKey, ssoGroups);
  if (
    resolvedCookie === resolvedTarget &&
    (normCookie === normSiteKey || normCookie.endsWith(`.${normSiteKey}`))
  ) {
    return true;
  }

  return false;
}
