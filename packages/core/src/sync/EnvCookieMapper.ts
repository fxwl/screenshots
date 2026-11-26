import { isAnalyticsNoiseCookie, normalizeDomain, resolveSiteKey } from '../psl';
import type {
  BrowserCookieInput,
  CookieRecord,
  EnvCookieSyncRule,
  SsoDomainGroup,
} from '../types';

export interface ParsedEnvTarget {
  scheme: 'http' | 'https';
  host: string;
  port: string;
  origin: string;
  canonicalUrl: string;
  isLocalOrIp: boolean;
  explicitWildcardDomain: boolean;
}

function isIpv4Host(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

function isPrivateIpv4Host(host: string): boolean {
  if (!isIpv4Host(host)) return false;
  const [a, b] = host.split('.').map(Number);
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function isIpv6Host(host: string): boolean {
  return (host.startsWith('[') && host.endsWith(']')) || host.includes(':');
}

export function isLocalOrSingleLabelHost(host: string): boolean {
  if (!host) return false;
  const clean = host.toLowerCase();
  return (
    clean === 'localhost' ||
    isIpv4Host(clean) ||
    isIpv6Host(clean) ||
    !clean.includes('.')
  );
}

export function isDevLikeUrlOrHost(urlOrHost?: string): boolean {
  if (!urlOrHost) return false;
  const trimmed = urlOrHost.trim();
  if (!trimmed) return false;

  const parsed = parseEnvTarget(trimmed);
  if (!parsed) return false;

  if (
    parsed.host === 'localhost' ||
    isPrivateIpv4Host(parsed.host) ||
    parsed.host === '[::1]' ||
    !parsed.host.includes('.')
  ) {
    return true;
  }

  if (
    parsed.host.endsWith('.local') ||
    parsed.host.endsWith('.test') ||
    parsed.host.endsWith('.internal') ||
    parsed.host.endsWith('.localhost') ||
    parsed.host.startsWith('dev.') ||
    parsed.host.startsWith('local.') ||
    parsed.host.startsWith('uat.') ||
    parsed.host.startsWith('staging.')
  ) {
    return true;
  }

  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    return true;
  }

  return false;
}

/**
 * Parses a target environment string (e.g. `http://localhost:3000`, `127.0.0.1:5173`,
 * `https://dev.example.com`, `.dev.example.com`) into canonical origin & cookie domain parameters.
 */
export function parseEnvTarget(rawTarget: string): ParsedEnvTarget | null {
  // Normalize accidental full-width CJK punctuation from IME (e.g. `localhost：3000` or `dev。local`)
  const trimmed = rawTarget.trim().replace(/：/g, ':').replace(/。/g, '.');
  if (!trimmed) return null;

  const explicitWildcardDomain = !trimmed.includes('://') && trimmed.startsWith('.');
  const withoutLeadingDot = explicitWildcardDomain ? trimmed.replace(/^\.+/, '') : trimmed;

  let explicitScheme: 'http' | 'https' | null = null;
  let candidateForUrl = withoutLeadingDot;

  if (/^https?:\/\//i.test(withoutLeadingDot)) {
    explicitScheme = withoutLeadingDot.toLowerCase().startsWith('https://') ? 'https' : 'http';
  } else if (withoutLeadingDot.includes('://')) {
    return null;
  } else if (!withoutLeadingDot.startsWith('[') && (withoutLeadingDot.match(/:/g)?.length ?? 0) >= 2) {
    // Support bare IPv6 literals like `::1` or `2001:db8::1`
    candidateForUrl = `http://[${withoutLeadingDot}]`;
  } else {
    candidateForUrl = `http://${withoutLeadingDot}`;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(candidateForUrl);
  } catch {
    return null;
  }

  const host = normalizeDomain(parsedUrl.hostname);
  if (!host) return null;

  const port = parsedUrl.port || '';
  const isLocalOrIp = isLocalOrSingleLabelHost(host);

  const scheme: 'http' | 'https' =
    explicitScheme ??
    (isLocalOrIp ||
    isPrivateIpv4Host(host) ||
    host.endsWith('.local') ||
    host.endsWith('.test') ||
    (port !== '' && port !== '443')
      ? 'http'
      : 'https');

  const origin = `${scheme}://${host}${port ? `:${port}` : ''}`;
  return {
    scheme,
    host,
    port,
    origin,
    canonicalUrl: `${origin}/`,
    isLocalOrIp,
    explicitWildcardDomain: explicitWildcardDomain && !isLocalOrIp,
  };
}

export function envRuleMatchesUrl(
  rule: EnvCookieSyncRule,
  activeUrl: string,
  ssoGroups?: SsoDomainGroup[],
): 'source' | 'target' | null {
  const activeTarget = parseEnvTarget(activeUrl);
  const ruleTarget = parseEnvTarget(rule.targetUrl);
  if (!activeTarget || !ruleTarget) return null;

  // Match target environment (if rule specifies a port, match exact host+port; otherwise match host)
  const targetHostMatches = ruleTarget.explicitWildcardDomain
    ? activeTarget.host === ruleTarget.host || activeTarget.host.endsWith(`.${ruleTarget.host}`)
    : activeTarget.host === ruleTarget.host;
  const targetPortMatches = !ruleTarget.port || activeTarget.port === ruleTarget.port;
  if (targetHostMatches && targetPortMatches) {
    return 'target';
  }

  // Match source environment
  const activeSiteKey = resolveSiteKey(activeUrl, ssoGroups) || activeTarget.host;
  const ruleSourceSiteKey =
    resolveSiteKey(rule.sourceSiteKey, ssoGroups) || normalizeDomain(rule.sourceSiteKey);
  if (rule.sourceHostFilter) {
    const filterHost = normalizeDomain(rule.sourceHostFilter);
    if (
      filterHost &&
      (activeTarget.host === filterHost || activeTarget.host.endsWith(`.${filterHost}`))
    ) {
      return 'source';
    }
  } else if (ruleSourceSiteKey && activeSiteKey === ruleSourceSiteKey) {
    return 'source';
  }

  return null;
}

/**
 * Rewrites a source cookie for injection into `target` environment, safely adapting
 * `domain`, `hostOnly`, `secure`, `sameSite`, and `partitionKey` for HTTP / localhost debugging.
 */
export function mapCookieToTargetEnv(
  source: Pick<
    BrowserCookieInput | CookieRecord,
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
  target: ParsedEnvTarget,
  options: { adaptForHttp: boolean },
): BrowserCookieInput {
  const isHostPrefix = source.name.startsWith('__Host-');
  const isSecurePrefix = source.name.startsWith('__Secure-');

  const hostOnly = isHostPrefix || target.isLocalOrIp || !target.explicitWildcardDomain;
  const domain = hostOnly ? target.host : `.${target.host}`;
  const path = isHostPrefix ? '/' : source.path || '/';

  const shouldDowngradeHttp =
    options.adaptForHttp && target.scheme === 'http' && !isHostPrefix && !isSecurePrefix;

  const secure = shouldDowngradeHttp
    ? false
    : isHostPrefix || isSecurePrefix
      ? true
      : Boolean(source.secure);

  const sameSite =
    !secure && source.sameSite === 'no_restriction'
      ? 'lax'
      : source.sameSite || 'unspecified';

  // Always drop CHIPS partitionKey when mapping across environments because the source
  // top-level partition site does not match the target dev/staging/prod environment.
  const partitionKey = null;
  const rawStore = source.storeId ?? source.storeScope;
  const storeId = rawStore && rawStore !== 'default' ? rawStore : undefined;

  return {
    domain,
    name: source.name,
    value: source.value,
    path,
    secure,
    httpOnly: Boolean(source.httpOnly),
    sameSite,
    session: Boolean(source.session),
    expirationDate: source.session ? undefined : source.expirationDate,
    hostOnly,
    storeId,
    partitionKey,
  };
}

export interface SourceCookieCandidate {
  cookie: BrowserCookieInput | CookieRecord;
  updatedAt?: number;
}

/**
 * Filters and deduplicates source cookies before rewriting to a target dev/prod host.
 * When multiple source subdomains (e.g. `.example.com` and `app.example.com`) carry the same
 * `(name, path)` cookie and flatten onto a single target host (`localhost`), the more specific
 * `hostOnly` / `sourceHostFilter` / fresher cookie deterministically wins.
 */
export function selectAndMapEnvCookies(params: {
  candidates: SourceCookieCandidate[];
  target: ParsedEnvTarget;
  nowMs: number;
  adaptForHttp: boolean;
  filterNoise: boolean;
  sourceHostFilter?: string;
  includeCookieNames?: string[];
  excludeCookieNames?: string[];
}): { mapped: BrowserCookieInput[]; skipped: number } {
  const {
    candidates,
    target,
    nowMs,
    adaptForHttp,
    filterNoise,
    sourceHostFilter,
    includeCookieNames,
    excludeCookieNames,
  } = params;

  const normFilterHost = sourceHostFilter ? normalizeDomain(sourceHostFilter) : '';
  const includeSet =
    includeCookieNames && includeCookieNames.length > 0
      ? new Set(includeCookieNames.map((n) => n.trim()).filter(Boolean))
      : null;
  const excludeSet =
    excludeCookieNames && excludeCookieNames.length > 0
      ? new Set(excludeCookieNames.map((n) => n.trim()).filter(Boolean))
      : null;

  let skipped = 0;
  const winners = new Map<
    string,
    { mapped: BrowserCookieInput; score: number; updatedAt: number; exp: number }
  >();

  for (const item of candidates) {
    const c = item.cookie;
    if (!c.name) {
      skipped += 1;
      continue;
    }
    if (!c.session && c.expirationDate !== undefined && c.expirationDate <= nowMs / 1000) {
      skipped += 1;
      continue;
    }
    if (filterNoise && isAnalyticsNoiseCookie(c.name) && (!includeSet || !includeSet.has(c.name))) {
      skipped += 1;
      continue;
    }
    if (includeSet && !includeSet.has(c.name)) {
      skipped += 1;
      continue;
    }
    if (excludeSet && excludeSet.has(c.name)) {
      skipped += 1;
      continue;
    }

    const srcDom = normalizeDomain(c.domain);
    if (normFilterHost) {
      const matchesFilter = c.hostOnly
        ? srcDom === normFilterHost
        : normFilterHost === srcDom || normFilterHost.endsWith(`.${srcDom}`);
      if (!matchesFilter) {
        skipped += 1;
        continue;
      }
    }

    const mapped = mapCookieToTargetEnv(c, target, { adaptForHttp });
    const identityKey = `${mapped.hostOnly ? 'h' : 'd'}::${mapped.domain}::${mapped.path || '/'}::${mapped.name}`;

    let specificityScore = 0;
    if (normFilterHost && srcDom === normFilterHost) specificityScore += 100;
    if (c.hostOnly) specificityScore += 20;
    specificityScore += Math.min(19, srcDom.split('.').length);

    const updatedAt = item.updatedAt ?? ('updatedAt' in c && typeof c.updatedAt === 'number' ? c.updatedAt : 0);
    const exp = c.session ? Number.MAX_SAFE_INTEGER : (c.expirationDate ?? 0);

    const prev = winners.get(identityKey);
    if (
      !prev ||
      specificityScore > prev.score ||
      (specificityScore === prev.score && updatedAt > prev.updatedAt) ||
      (specificityScore === prev.score && updatedAt === prev.updatedAt && exp > prev.exp)
    ) {
      winners.set(identityKey, { mapped, score: specificityScore, updatedAt, exp });
    }
  }

  return {
    mapped: Array.from(winners.values()).map((w) => w.mapped),
    skipped,
  };
}
