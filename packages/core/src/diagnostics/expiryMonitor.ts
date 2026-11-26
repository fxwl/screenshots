import { isAnalyticsNoiseCookie } from '../psl';
import type {
  BrowserCookieInput,
  CookieExpiryWarningSettings,
  CookieRecord,
  ExpiryHealthStatus,
  ExpiringCookieSummary,
  SiteExpiryHealth,
} from '../types';

export const DEFAULT_COOKIE_EXPIRY_WARNING_SETTINGS: CookieExpiryWarningSettings = {
  enabled: true,
  warningLeadHours: 24,
  criticalLeadHours: 2,
  includeInactiveTracks: true,
};

const ANCIENT_EXPIRED_THRESHOLD_MS = 7 * 24 * 3600 * 1000;

const SHORT_LIVED_CSRF_OR_ANTIBOT_NAMES: ReadonlySet<string> = new Set([
  'csrf',
  'xsrf',
  '_csrf',
  'csrftoken',
  'xsrftoken',
  'csrf_token',
  'csrf-token',
  'xsrf-token',
  'xsrf_token',
  'x-csrf-token',
  'x-xsrf-token',
  '__requestverificationtoken',
  'nonce',
  'oauth_state',
  '_cf_bm',
  '__cf_bm',
  'cf_clearance',
  'ak_bmsc',
  'bm_sz',
  'awsalb',
  'awsalbcors',
]);

const AUTH_COOKIE_NAME_REGEX =
  /^(?:__Host-|__Secure-)|(?:sess|session|sid|token|auth|jwt|sso|login|logged_in|ticket|passport|remember|refresh|access|uid|userid|user_id|acct|credential)/i;

export interface EvaluateSiteExpiryHealthParams {
  siteKey: string;
  cookies: CookieRecord[];
  tracks?: Record<string, { label?: string }>;
  activeTrackId?: string;
  watchedCookieNames?: string[];
  settings?: Partial<CookieExpiryWarningSettings>;
  nowMs?: number;
}

export function isShortLivedCsrfOrAntiBotCookie(name: string): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (SHORT_LIVED_CSRF_OR_ANTIBOT_NAMES.has(lower)) {
    return true;
  }
  return /(?:^|[_-])(csrf|xsrf)/i.test(lower);
}

export function isLikelyAuthCookie(
  cookie: Pick<CookieRecord | BrowserCookieInput, 'name' | 'httpOnly' | 'secure'>,
  watched = false,
): boolean {
  if (watched) return true;
  if (!cookie.name) return false;
  if (isAnalyticsNoiseCookie(cookie.name)) return false;
  if (isShortLivedCsrfOrAntiBotCookie(cookie.name)) return false;
  if (cookie.httpOnly) return true;
  return AUTH_COOKIE_NAME_REGEX.test(cookie.name);
}

function toExpiryMs(expirationDate: number): number {
  return expirationDate > 1e12 ? expirationDate : expirationDate * 1000;
}

function gradeRemainingMs(
  remainingMs: number,
  warningLeadMs: number,
  criticalLeadMs: number,
): Exclude<ExpiryHealthStatus, 'healthy'> | null {
  if (remainingMs <= 0) return 'expired';
  if (remainingMs <= criticalLeadMs) return 'critical';
  if (remainingMs <= warningLeadMs) return 'expiring_soon';
  return null;
}

const STATUS_SEVERITY: Record<ExpiryHealthStatus, number> = {
  healthy: 0,
  expiring_soon: 1,
  critical: 2,
  expired: 3,
};

export function evaluateSiteExpiryHealth(
  params: EvaluateSiteExpiryHealthParams,
): SiteExpiryHealth {
  const settings: CookieExpiryWarningSettings = {
    ...DEFAULT_COOKIE_EXPIRY_WARNING_SETTINGS,
    ...params.settings,
  };

  if (!settings.enabled) {
    return {
      siteKey: params.siteKey,
      status: 'healthy',
      expiringCookies: [],
      sessionOnlyAuthCount: 0,
    };
  }

  const nowMs = params.nowMs ?? Date.now();
  const warningLeadMs = Math.max(0, settings.warningLeadHours) * 3600_000;
  const criticalLeadMs = Math.max(0, settings.criticalLeadHours) * 3600_000;

  const watchedSet = new Set(
    (params.watchedCookieNames ?? [])
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const isWatchedName = (name: string): boolean =>
    watchedSet.has(name.trim().toLowerCase());

  const activeCookies = params.cookies.filter((c) => {
    if (!c || c.deleted) return false;
    if (!settings.includeInactiveTracks && params.activeTrackId && c.trackId !== params.activeTrackId) {
      return false;
    }
    return true;
  });

  let sessionOnlyAuthCount = 0;
  const persistentByTrack = new Map<string, CookieRecord[]>();

  for (const cookie of activeCookies) {
    const watched = isWatchedName(cookie.name);
    if (cookie.session || cookie.expirationDate === undefined) {
      if (watched || isLikelyAuthCookie(cookie)) {
        sessionOnlyAuthCount += 1;
      }
      continue;
    }

    const list = persistentByTrack.get(cookie.trackId);
    if (list) {
      list.push(cookie);
    } else {
      persistentByTrack.set(cookie.trackId, [cookie]);
    }
  }

  const expiringCookies: ExpiringCookieSummary[] = [];

  for (const [trackId, trackPersistent] of persistentByTrack.entries()) {
    const trackLabel = params.tracks?.[trackId]?.label;
    const l12Matched = trackPersistent.filter(
      (c) => isWatchedName(c.name) || isLikelyAuthCookie(c),
    );

    const evaluateCandidates = (candidates: CookieRecord[]): void => {
      for (const cookie of candidates) {
        if (cookie.expirationDate === undefined) continue;
        const watched = isWatchedName(cookie.name);
        const expMs = toExpiryMs(cookie.expirationDate);
        if (!Number.isFinite(expMs)) continue;
        const remainingMs = expMs - nowMs;

        if (!watched && remainingMs < -ANCIENT_EXPIRED_THRESHOLD_MS) {
          continue;
        }

        const graded = gradeRemainingMs(remainingMs, warningLeadMs, criticalLeadMs);
        if (!graded) continue;

        expiringCookies.push({
          logicalId: cookie.logicalId,
          name: cookie.name,
          domain: cookie.domain,
          trackId,
          trackLabel,
          expirationDate: cookie.expirationDate,
          remainingMs,
          status: graded,
          watched,
          httpOnly: Boolean(cookie.httpOnly),
        });
      }
    };

    if (l12Matched.length > 0) {
      evaluateCandidates(l12Matched);
    } else {
      // L3 fallback: no persistent cookie matched L1/L2 on this track; flag only if all recent non-noise persistent cookies expire soon.
      const recentNonNoise = trackPersistent.filter((c) => {
        if (isAnalyticsNoiseCookie(c.name) || isShortLivedCsrfOrAntiBotCookie(c.name)) {
          return false;
        }
        if (c.expirationDate === undefined) return false;
        const expMs = toExpiryMs(c.expirationDate);
        if (!Number.isFinite(expMs)) return false;
        return expMs - nowMs >= -ANCIENT_EXPIRED_THRESHOLD_MS;
      });

      if (
        recentNonNoise.length > 0 &&
        recentNonNoise.every((c) => toExpiryMs(c.expirationDate!) - nowMs <= warningLeadMs)
      ) {
        evaluateCandidates(recentNonNoise);
      }
    }
  }

  expiringCookies.sort((a, b) => a.remainingMs - b.remainingMs);

  let status: ExpiryHealthStatus = 'healthy';
  for (const item of expiringCookies) {
    if (STATUS_SEVERITY[item.status] > STATUS_SEVERITY[status]) {
      status = item.status;
    }
  }

  const earliest = expiringCookies[0];

  return {
    siteKey: params.siteKey,
    status,
    earliestExpiryAt: earliest ? nowMs + earliest.remainingMs : undefined,
    remainingMs: earliest ? earliest.remainingMs : undefined,
    expiringCookies,
    sessionOnlyAuthCount,
  };
}
