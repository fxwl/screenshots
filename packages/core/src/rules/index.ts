import type {
  BlacklistEntry,
  EnvCookieSyncRule,
  IndexedDbTargetRule,
  SiteRuleOverride,
  SpaceRuleSet,
  SpaceSettings,
  SsoDomainGroup,
  SyncDirection,
} from '../types';
import { normalizeDomain, resolveSiteKey } from '../psl';
import { parseEnvTarget } from '../sync/EnvCookieMapper';

export { buildPresetBlacklistEntries } from './presets';

export const DEFAULT_INDEXEDDB_MAX_TOTAL_BYTES = 1024 * 1024; // 1MB
export const HARD_LIMIT_INDEXEDDB_MAX_TOTAL_BYTES = 2 * 1024 * 1024; // 2MB

export interface EffectiveSitePolicy {
  excluded: boolean;
  excludedBy?: BlacklistEntry;
  direction: Exclude<SyncDirection, 'inherit'>;
  syncCookies: boolean;
  syncLocalStorage: boolean;
  syncSessionStorage: boolean;
  sessionStorageKeyAllowlist?: string[];
  syncIndexedDb: boolean;
  indexedDbTargets?: IndexedDbTargetRule[];
  indexedDbMaxTotalBytes: number;
  watchedCookieNames?: string[];
  autoRefresh: boolean;
}

interface ParsedTarget {
  raw: string;
  host: string;
  origin: string | null;
}

const VALID_MATCH_TYPES: ReadonlySet<BlacklistEntry['matchType']> = new Set([
  'exact_domain',
  'subdomain',
  'wildcard',
  'origin',
]);

const VALID_DIRECTIONS: ReadonlySet<SyncDirection> = new Set([
  'inherit',
  'bidirectional',
  'push_only',
  'pull_only',
  'disabled',
]);

const MATCH_TYPE_SPECIFICITY: Record<BlacklistEntry['matchType'], number> = {
  origin: 4,
  exact_domain: 3,
  subdomain: 2,
  wildcard: 1,
};

function parseOrigin(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed.includes('://')) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.origin && parsed.origin !== 'null') {
      return parsed.origin.toLowerCase();
    }
    return null;
  } catch {
    return null;
  }
}

function parseTarget(domainOrOriginOrUrl: string): ParsedTarget {
  const raw = domainOrOriginOrUrl.trim();
  const origin = parseOrigin(raw);
  const host = normalizeDomain(raw);
  return { raw, host, origin };
}

function globToRegExp(glob: string): RegExp {
  const collapsed = glob.trim().toLowerCase().replace(/\*+/g, '*');
  const escaped = collapsed.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = `^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`;
  return new RegExp(pattern, 'i');
}

function matchesBlacklistEntry(entry: BlacklistEntry, target: ParsedTarget): boolean {
  const rawPattern = entry.pattern.trim();
  if (!rawPattern) return false;

  switch (entry.matchType) {
    case 'origin': {
      if (!target.origin) return false;
      const patternOrigin = parseOrigin(rawPattern);
      if (!patternOrigin) return false;
      return target.origin === patternOrigin;
    }

    case 'exact_domain': {
      if (!target.host) return false;
      const patternHost = normalizeDomain(rawPattern);
      return patternHost.length > 0 && target.host === patternHost;
    }

    case 'subdomain': {
      if (!target.host) return false;
      const stripped = rawPattern.replace(/^\*\./, '');
      const baseDomain = normalizeDomain(stripped);
      if (!baseDomain) return false;
      return target.host === baseDomain || target.host.endsWith(`.${baseDomain}`);
    }

    case 'wildcard': {
      const regex = globToRegExp(rawPattern);
      if (rawPattern.includes('://') || rawPattern.includes('/')) {
        const candidate = target.origin ?? target.raw.toLowerCase();
        return regex.test(candidate) || regex.test(target.raw.toLowerCase());
      }
      if (!target.host) return false;
      return regex.test(target.host);
    }
  }
}

function findBestBlacklistMatch(
  entries: BlacklistEntry[],
  target: ParsedTarget,
): BlacklistEntry | undefined {
  let best: BlacklistEntry | undefined;
  let bestScore = -1;

  for (const entry of entries) {
    if (!matchesBlacklistEntry(entry, target)) continue;
    const score = MATCH_TYPE_SPECIFICITY[entry.matchType] ?? 0;
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }

  return best;
}

function scoreOverrideMatch(
  override: SiteRuleOverride,
  target: ParsedTarget,
  targetSiteKey: string,
): number {
  const pattern = (override.pattern || override.siteKey || '').trim();
  if (!pattern) return 0;

  // 1. Exact origin match (highest specificity)
  if (pattern.includes('://')) {
    const patternOrigin = parseOrigin(pattern);
    if (patternOrigin && target.origin && target.origin === patternOrigin) {
      return 4000 + pattern.length;
    }
    if (pattern.includes('*') || pattern.includes('?')) {
      const regex = globToRegExp(pattern);
      const candidate = target.origin ?? target.raw.toLowerCase();
      if (regex.test(candidate) || regex.test(target.raw.toLowerCase())) {
        return 1000 + pattern.length;
      }
    }
    return 0;
  }

  // 2. Subdomain pattern (*.example.com)
  if (pattern.startsWith('*.')) {
    const base = normalizeDomain(pattern.slice(2));
    if (base && (target.host === base || target.host.endsWith(`.${base}`))) {
      return 2000 + base.length;
    }
    return 0;
  }

  // 3. General wildcard glob (*bank*, *.example.*)
  if (pattern.includes('*') || pattern.includes('?')) {
    if (target.host && globToRegExp(pattern).test(target.host)) {
      return 1000 + pattern.length;
    }
    return 0;
  }

  // 4. Exact domain match
  const normPattern = normalizeDomain(pattern);
  if (normPattern && target.host === normPattern) {
    return 3000 + normPattern.length;
  }

  // 5. Subdomain under exact pattern or matching canonical siteKey (including SSO groups)
  if (normPattern && target.host.endsWith(`.${normPattern}`)) {
    return 2000 + normPattern.length;
  }

  const normOverrideSiteKey = normalizeDomain(override.siteKey);
  if (normOverrideSiteKey && targetSiteKey && normOverrideSiteKey === targetSiteKey) {
    return 2000 + normOverrideSiteKey.length;
  }

  return 0;
}

function sanitizeBlacklistEntry(
  raw: unknown,
  defaultScope: 'space' | 'device',
  index: number,
): BlacklistEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const pattern = typeof obj.pattern === 'string' ? obj.pattern.trim() : '';
  if (!pattern) return null;

  const rawMatchType = obj.matchType;
  const matchType: BlacklistEntry['matchType'] =
    typeof rawMatchType === 'string' &&
    VALID_MATCH_TYPES.has(rawMatchType as BlacklistEntry['matchType'])
      ? (rawMatchType as BlacklistEntry['matchType'])
      : pattern.includes('://')
        ? 'origin'
        : pattern.startsWith('*.')
          ? 'subdomain'
          : pattern.includes('*') || pattern.includes('?')
            ? 'wildcard'
            : 'exact_domain';

  const scope: 'space' | 'device' =
    obj.scope === 'space' || obj.scope === 'device' ? obj.scope : defaultScope;

  const id =
    typeof obj.id === 'string' && obj.id.trim()
      ? obj.id.trim()
      : `imported_${scope}_${index}_${Date.now()}`;

  const createdAt =
    typeof obj.createdAt === 'number' && Number.isFinite(obj.createdAt)
      ? obj.createdAt
      : Date.now();

  const entry: BlacklistEntry = {
    id,
    pattern,
    matchType,
    scope,
    createdAt,
  };

  if (typeof obj.reason === 'string') {
    entry.reason = obj.reason;
  }
  if (
    obj.presetCategory === 'banking' ||
    obj.presetCategory === 'password_manager' ||
    obj.presetCategory === 'webdav_self' ||
    obj.presetCategory === 'localhost' ||
    obj.presetCategory === 'custom'
  ) {
    entry.presetCategory = obj.presetCategory;
  }

  return entry;
}

function sanitizeSiteOverrides(raw: unknown): Record<string, SiteRuleOverride> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<string, SiteRuleOverride> = {};

  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== 'object') continue;
    const obj = val as Record<string, unknown>;
    const siteKey =
      typeof obj.siteKey === 'string' && obj.siteKey.trim() ? obj.siteKey.trim() : key.trim();
    const pattern =
      typeof obj.pattern === 'string' && obj.pattern.trim() ? obj.pattern.trim() : siteKey;
    if (!siteKey) continue;

    const direction: SyncDirection =
      typeof obj.direction === 'string' && VALID_DIRECTIONS.has(obj.direction as SyncDirection)
        ? (obj.direction as SyncDirection)
        : 'inherit';

    const sessionStorageKeyAllowlist = Array.isArray(obj.sessionStorageKeyAllowlist)
      ? obj.sessionStorageKeyAllowlist
          .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
          .map((k) => k.trim())
      : undefined;

    const watchedCookieNames = Array.isArray(obj.watchedCookieNames)
      ? obj.watchedCookieNames
          .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
          .map((k) => k.trim())
      : undefined;

    const indexedDbTargets: IndexedDbTargetRule[] | undefined = Array.isArray(obj.indexedDbTargets)
      ? obj.indexedDbTargets
          .filter((t): t is Record<string, unknown> => Boolean(t && typeof t === 'object'))
          .map((t) => {
            const dbName = typeof t.dbName === 'string' ? t.dbName.trim() : '';
            if (!dbName) return null;
            const objectStores = Array.isArray(t.objectStores)
              ? t.objectStores
                  .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
                  .map((s) => s.trim())
              : undefined;
            const keyPrefixes = Array.isArray(t.keyPrefixes)
              ? t.keyPrefixes
                  .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
                  .map((p) => p.trim())
              : undefined;
            const rule: IndexedDbTargetRule = { dbName };
            if (objectStores && objectStores.length > 0) rule.objectStores = objectStores;
            if (keyPrefixes && keyPrefixes.length > 0) rule.keyPrefixes = keyPrefixes;
            return rule;
          })
          .filter((r): r is IndexedDbTargetRule => r !== null)
      : undefined;

    const rawMaxBytes =
      typeof obj.indexedDbMaxTotalBytes === 'number' && Number.isFinite(obj.indexedDbMaxTotalBytes)
        ? Math.max(64 * 1024, Math.min(HARD_LIMIT_INDEXEDDB_MAX_TOTAL_BYTES, Math.floor(obj.indexedDbMaxTotalBytes)))
        : undefined;

    result[siteKey] = {
      siteKey,
      pattern,
      direction,
      syncCookies: typeof obj.syncCookies === 'boolean' ? obj.syncCookies : true,
      syncLocalStorage: typeof obj.syncLocalStorage === 'boolean' ? obj.syncLocalStorage : true,
      syncSessionStorage: typeof obj.syncSessionStorage === 'boolean' ? obj.syncSessionStorage : undefined,
      sessionStorageKeyAllowlist:
        sessionStorageKeyAllowlist && sessionStorageKeyAllowlist.length > 0 ? sessionStorageKeyAllowlist : undefined,
      syncIndexedDb: typeof obj.syncIndexedDb === 'boolean' ? obj.syncIndexedDb : undefined,
      indexedDbTargets: indexedDbTargets && indexedDbTargets.length > 0 ? indexedDbTargets : undefined,
      indexedDbMaxTotalBytes: rawMaxBytes,
      watchedCookieNames: watchedCookieNames && watchedCookieNames.length > 0 ? watchedCookieNames : undefined,
      autoRefresh: typeof obj.autoRefresh === 'boolean' ? obj.autoRefresh : true,
      updatedAt:
        typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt)
          ? obj.updatedAt
          : Date.now(),
    };
  }

  return result;
}

function sanitizeSsoGroups(raw: unknown): SsoDomainGroup[] {
  if (!Array.isArray(raw)) return [];
  const groups: SsoDomainGroup[] = [];

  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const primarySiteKey =
      typeof obj.primarySiteKey === 'string' ? normalizeDomain(obj.primarySiteKey) : '';
    const domains = Array.isArray(obj.domains)
      ? obj.domains
          .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
          .map((d) => d.trim())
      : [];

    if (!primarySiteKey || domains.length === 0) continue;

    groups.push({
      groupId:
        typeof obj.groupId === 'string' && obj.groupId.trim()
          ? obj.groupId.trim()
          : `sso_${i}_${primarySiteKey}`,
      name:
        typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : primarySiteKey,
      primarySiteKey,
      domains,
    });
  }

  return groups;
}

function sanitizeEnvSyncRule(
  raw: unknown,
  defaultScope: 'space' | 'device',
  index: number,
): EnvCookieSyncRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const rawSource = typeof obj.sourceSiteKey === 'string' ? obj.sourceSiteKey.trim() : '';
  const sourceSiteKey = rawSource ? resolveSiteKey(rawSource) || normalizeDomain(rawSource) : '';
  const targetUrl = typeof obj.targetUrl === 'string' ? obj.targetUrl.trim() : '';
  if (!sourceSiteKey || !targetUrl || !parseEnvTarget(targetUrl)) return null;

  const rawSourceHost = normalizeDomain(rawSource);
  const sanitizedHostFilter =
    typeof obj.sourceHostFilter === 'string' && obj.sourceHostFilter.trim()
      ? normalizeDomain(obj.sourceHostFilter)
      : rawSourceHost && rawSourceHost !== sourceSiteKey
        ? rawSourceHost
        : undefined;

  const scope: 'space' | 'device' =
    obj.scope === 'space' || obj.scope === 'device' ? obj.scope : defaultScope;
  const now = Date.now();
  const createdAt =
    typeof obj.createdAt === 'number' && Number.isFinite(obj.createdAt) ? obj.createdAt : now;
  const updatedAt =
    typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) ? obj.updatedAt : now;

  const includeCookieNames = Array.isArray(obj.includeCookieNames)
    ? obj.includeCookieNames
        .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
        .map((n) => n.trim())
    : undefined;
  const excludeCookieNames = Array.isArray(obj.excludeCookieNames)
    ? obj.excludeCookieNames
        .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
        .map((n) => n.trim())
    : undefined;

  return {
    id:
      typeof obj.id === 'string' && obj.id.trim()
        ? obj.id.trim()
        : `env_${scope}_${index}_${now}`,
    name:
      typeof obj.name === 'string' && obj.name.trim()
        ? obj.name.trim()
        : `${sourceSiteKey} → ${targetUrl}`,
    scope,
    enabled: typeof obj.enabled === 'boolean' ? obj.enabled : true,
    sourceSiteKey,
    sourceHostFilter: sanitizedHostFilter,
    sourceTrackId:
      typeof obj.sourceTrackId === 'string' && obj.sourceTrackId.trim()
        ? obj.sourceTrackId.trim()
        : undefined,
    targetUrl,
    syncCookies: typeof obj.syncCookies === 'boolean' ? obj.syncCookies : true,
    syncLocalStorage: typeof obj.syncLocalStorage === 'boolean' ? obj.syncLocalStorage : false,
    syncSessionStorage: typeof obj.syncSessionStorage === 'boolean' ? obj.syncSessionStorage : undefined,
    adaptForHttp: typeof obj.adaptForHttp === 'boolean' ? obj.adaptForHttp : true,
    cleanTargetBeforeSync:
      typeof obj.cleanTargetBeforeSync === 'boolean' ? obj.cleanTargetBeforeSync : false,
    autoSync: typeof obj.autoSync === 'boolean' ? obj.autoSync : true,
    autoReloadTarget: typeof obj.autoReloadTarget === 'boolean' ? obj.autoReloadTarget : false,
    includeCookieNames: includeCookieNames && includeCookieNames.length > 0 ? includeCookieNames : undefined,
    excludeCookieNames: excludeCookieNames && excludeCookieNames.length > 0 ? excludeCookieNames : undefined,
    lastSyncedAt: typeof obj.lastSyncedAt === 'number' ? obj.lastSyncedAt : undefined,
    lastSyncedCount: typeof obj.lastSyncedCount === 'number' ? obj.lastSyncedCount : undefined,
    createdAt,
    updatedAt,
  };
}

/**
 * Two-Tier Blacklist & Rules Engine.
 * Priority: Device Blacklist > Space Blacklist > Per-Site Overrides (origin > exact > subdomain > wildcard) > Global Defaults.
 */
export class RulesEngine {
  private spaceSettings: SpaceSettings;
  private spaceRules: SpaceRuleSet;
  private deviceBlacklist: BlacklistEntry[];
  private deviceEnvSyncRules: EnvCookieSyncRule[];

  constructor(
    spaceSettings: SpaceSettings,
    spaceRules: SpaceRuleSet,
    deviceBlacklist: BlacklistEntry[] = [],
    deviceEnvSyncRules: EnvCookieSyncRule[] = [],
  ) {
    this.spaceSettings = { ...spaceSettings };
    this.spaceRules = {
      spaceBlacklist: [...(spaceRules.spaceBlacklist ?? [])],
      siteOverrides: { ...(spaceRules.siteOverrides ?? {}) },
      ssoGroups: [...(spaceRules.ssoGroups ?? [])],
      envSyncRules: [...(spaceRules.envSyncRules ?? [])],
      updatedAt: spaceRules.updatedAt,
    };
    this.deviceBlacklist = [...deviceBlacklist];
    this.deviceEnvSyncRules = [...deviceEnvSyncRules];
  }

  update(
    spaceSettings: SpaceSettings,
    spaceRules: SpaceRuleSet,
    deviceBlacklist: BlacklistEntry[] = [],
    deviceEnvSyncRules?: EnvCookieSyncRule[],
  ): void {
    this.spaceSettings = { ...spaceSettings };
    this.spaceRules = {
      spaceBlacklist: [...(spaceRules.spaceBlacklist ?? [])],
      siteOverrides: { ...(spaceRules.siteOverrides ?? {}) },
      ssoGroups: [...(spaceRules.ssoGroups ?? [])],
      envSyncRules: [...(spaceRules.envSyncRules ?? [])],
      updatedAt: spaceRules.updatedAt,
    };
    this.deviceBlacklist = [...deviceBlacklist];
    if (deviceEnvSyncRules !== undefined) {
      this.deviceEnvSyncRules = [...deviceEnvSyncRules];
    }
  }

  isBlacklisted(domainOrOriginOrUrl: string): { blacklisted: boolean; entry?: BlacklistEntry } {
    const target = parseTarget(domainOrOriginOrUrl);
    if (!target.host && !target.origin) {
      return { blacklisted: false };
    }

    // 1. Device-local blacklist has highest precedence
    const deviceMatch = findBestBlacklistMatch(this.deviceBlacklist, target);
    if (deviceMatch) {
      return { blacklisted: true, entry: deviceMatch };
    }

    // 2. Space-level synced blacklist
    const spaceMatch = findBestBlacklistMatch(this.spaceRules.spaceBlacklist, target);
    if (spaceMatch) {
      return { blacklisted: true, entry: spaceMatch };
    }

    return { blacklisted: false };
  }

  getEffectivePolicy(domainOrOriginOrUrl: string): EffectiveSitePolicy {
    // 1. Two-tier blacklist always takes absolute top priority over siteOverrides & global defaults
    const blacklistCheck = this.isBlacklisted(domainOrOriginOrUrl);
    if (blacklistCheck.blacklisted) {
      return {
        excluded: true,
        excludedBy: blacklistCheck.entry,
        direction: 'disabled',
        syncCookies: false,
        syncLocalStorage: false,
        syncSessionStorage: false,
        syncIndexedDb: false,
        indexedDbMaxTotalBytes: DEFAULT_INDEXEDDB_MAX_TOTAL_BYTES,
        autoRefresh: false,
      };
    }

    const globalDirection: Exclude<SyncDirection, 'inherit'> =
      this.spaceSettings.direction === 'inherit'
        ? 'bidirectional'
        : this.spaceSettings.direction;

    const target = parseTarget(domainOrOriginOrUrl);
    const targetSiteKey = target.host
      ? resolveSiteKey(target.host, this.spaceRules.ssoGroups)
      : '';

    // 2. Find highest-specificity matching site rule override
    let bestOverride: SiteRuleOverride | undefined;
    let bestScore = 0;

    for (const override of Object.values(this.spaceRules.siteOverrides)) {
      const score = scoreOverrideMatch(override, target, targetSiteKey);
      if (
        score > bestScore ||
        (score > 0 &&
          score === bestScore &&
          bestOverride &&
          override.updatedAt > bestOverride.updatedAt)
      ) {
        bestOverride = override;
        bestScore = score;
      }
    }

    if (bestOverride) {
      const effectiveDirection: Exclude<SyncDirection, 'inherit'> =
        bestOverride.direction === 'inherit' ? globalDirection : bestOverride.direction;
      const disabled = effectiveDirection === 'disabled';
      const maxIdbBytes = Math.max(
        64 * 1024,
        Math.min(
          HARD_LIMIT_INDEXEDDB_MAX_TOTAL_BYTES,
          bestOverride.indexedDbMaxTotalBytes ?? DEFAULT_INDEXEDDB_MAX_TOTAL_BYTES,
        ),
      );
      const idbEnabled = Boolean(
        !disabled &&
          bestOverride.syncIndexedDb &&
          bestOverride.indexedDbTargets &&
          bestOverride.indexedDbTargets.length > 0,
      );

      return {
        excluded: disabled,
        direction: effectiveDirection,
        syncCookies: disabled ? false : bestOverride.syncCookies,
        syncLocalStorage: disabled ? false : bestOverride.syncLocalStorage,
        syncSessionStorage: disabled
          ? false
          : (bestOverride.syncSessionStorage ?? Boolean(this.spaceSettings.syncSessionStorage)),
        sessionStorageKeyAllowlist: bestOverride.sessionStorageKeyAllowlist,
        syncIndexedDb: idbEnabled,
        indexedDbTargets: idbEnabled ? bestOverride.indexedDbTargets : undefined,
        indexedDbMaxTotalBytes: maxIdbBytes,
        watchedCookieNames: bestOverride.watchedCookieNames,
        autoRefresh: disabled ? false : bestOverride.autoRefresh,
      };
    }

    // 3. Global space defaults
    const globalDisabled = globalDirection === 'disabled';
    return {
      excluded: globalDisabled,
      direction: globalDirection,
      syncCookies: globalDisabled ? false : this.spaceSettings.syncCookies,
      syncLocalStorage: globalDisabled ? false : this.spaceSettings.syncLocalStorage,
      syncSessionStorage: globalDisabled ? false : Boolean(this.spaceSettings.syncSessionStorage),
      syncIndexedDb: false,
      indexedDbMaxTotalBytes: DEFAULT_INDEXEDDB_MAX_TOTAL_BYTES,
      autoRefresh: globalDisabled ? false : this.spaceSettings.autoRefresh,
    };
  }

  exportRulesJson(): string {
    return JSON.stringify(
      {
        version: 1,
        exportedAt: Date.now(),
        spaceRules: {
          spaceBlacklist: this.spaceRules.spaceBlacklist,
          siteOverrides: this.spaceRules.siteOverrides,
          ssoGroups: this.spaceRules.ssoGroups,
          envSyncRules: this.spaceRules.envSyncRules ?? [],
          updatedAt: this.spaceRules.updatedAt,
        },
        deviceBlacklist: this.deviceBlacklist,
        deviceEnvSyncRules: this.deviceEnvSyncRules,
      },
      null,
      2,
    );
  }

  static parseRulesJson(
    json: string,
  ): {
    spaceRules: Partial<SpaceRuleSet>;
    deviceBlacklist: BlacklistEntry[];
    deviceEnvSyncRules: EnvCookieSyncRule[];
  } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      throw new Error(
        `Invalid rules JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid rules JSON: root must be a JSON object');
    }

    const root = parsed as Record<string, unknown>;
    const rawSpaceRules =
      root.spaceRules && typeof root.spaceRules === 'object' && !Array.isArray(root.spaceRules)
        ? (root.spaceRules as Record<string, unknown>)
        : root;

    const spaceRules: Partial<SpaceRuleSet> = {};

    if (Array.isArray(rawSpaceRules.spaceBlacklist)) {
      spaceRules.spaceBlacklist = rawSpaceRules.spaceBlacklist
        .map((item, idx) => sanitizeBlacklistEntry(item, 'space', idx))
        .filter((item): item is BlacklistEntry => item !== null);
    }

    if (
      rawSpaceRules.siteOverrides &&
      typeof rawSpaceRules.siteOverrides === 'object' &&
      !Array.isArray(rawSpaceRules.siteOverrides)
    ) {
      spaceRules.siteOverrides = sanitizeSiteOverrides(rawSpaceRules.siteOverrides);
    }

    if (Array.isArray(rawSpaceRules.ssoGroups)) {
      spaceRules.ssoGroups = sanitizeSsoGroups(rawSpaceRules.ssoGroups);
    }

    if (Array.isArray(rawSpaceRules.envSyncRules)) {
      spaceRules.envSyncRules = rawSpaceRules.envSyncRules
        .map((item, idx) => sanitizeEnvSyncRule(item, 'space', idx))
        .filter((item): item is EnvCookieSyncRule => item !== null);
    }

    if (typeof rawSpaceRules.updatedAt === 'number' && Number.isFinite(rawSpaceRules.updatedAt)) {
      spaceRules.updatedAt = rawSpaceRules.updatedAt;
    }

    const rawDeviceBlacklist = Array.isArray(root.deviceBlacklist) ? root.deviceBlacklist : [];
    const deviceBlacklist = rawDeviceBlacklist
      .map((item, idx) => sanitizeBlacklistEntry(item, 'device', idx))
      .filter((item): item is BlacklistEntry => item !== null);

    const rawDeviceEnvRules = Array.isArray(root.deviceEnvSyncRules)
      ? root.deviceEnvSyncRules
      : [];
    const deviceEnvSyncRules = rawDeviceEnvRules
      .map((item, idx) => sanitizeEnvSyncRule(item, 'device', idx))
      .filter((item): item is EnvCookieSyncRule => item !== null);

    return { spaceRules, deviceBlacklist, deviceEnvSyncRules };
  }
}
