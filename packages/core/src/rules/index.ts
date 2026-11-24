import type {
  BlacklistEntry,
  SiteRuleOverride,
  SpaceRuleSet,
  SpaceSettings,
  SsoDomainGroup,
  SyncDirection,
} from '../types';
import { normalizeDomain, resolveSiteKey } from '../psl';

export { buildPresetBlacklistEntries } from './presets';

export interface EffectiveSitePolicy {
  excluded: boolean;
  excludedBy?: BlacklistEntry;
  direction: Exclude<SyncDirection, 'inherit'>;
  syncCookies: boolean;
  syncLocalStorage: boolean;
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

    result[siteKey] = {
      siteKey,
      pattern,
      direction,
      syncCookies: typeof obj.syncCookies === 'boolean' ? obj.syncCookies : true,
      syncLocalStorage: typeof obj.syncLocalStorage === 'boolean' ? obj.syncLocalStorage : true,
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

/**
 * Two-Tier Blacklist & Rules Engine.
 * Priority: Device Blacklist > Space Blacklist > Per-Site Overrides (origin > exact > subdomain > wildcard) > Global Defaults.
 */
export class RulesEngine {
  private spaceSettings: SpaceSettings;
  private spaceRules: SpaceRuleSet;
  private deviceBlacklist: BlacklistEntry[];

  constructor(
    spaceSettings: SpaceSettings,
    spaceRules: SpaceRuleSet,
    deviceBlacklist: BlacklistEntry[] = [],
  ) {
    this.spaceSettings = { ...spaceSettings };
    this.spaceRules = {
      spaceBlacklist: [...(spaceRules.spaceBlacklist ?? [])],
      siteOverrides: { ...(spaceRules.siteOverrides ?? {}) },
      ssoGroups: [...(spaceRules.ssoGroups ?? [])],
      updatedAt: spaceRules.updatedAt,
    };
    this.deviceBlacklist = [...deviceBlacklist];
  }

  update(
    spaceSettings: SpaceSettings,
    spaceRules: SpaceRuleSet,
    deviceBlacklist: BlacklistEntry[] = [],
  ): void {
    this.spaceSettings = { ...spaceSettings };
    this.spaceRules = {
      spaceBlacklist: [...(spaceRules.spaceBlacklist ?? [])],
      siteOverrides: { ...(spaceRules.siteOverrides ?? {}) },
      ssoGroups: [...(spaceRules.ssoGroups ?? [])],
      updatedAt: spaceRules.updatedAt,
    };
    this.deviceBlacklist = [...deviceBlacklist];
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

      return {
        excluded: disabled,
        direction: effectiveDirection,
        syncCookies: disabled ? false : bestOverride.syncCookies,
        syncLocalStorage: disabled ? false : bestOverride.syncLocalStorage,
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
          updatedAt: this.spaceRules.updatedAt,
        },
        deviceBlacklist: this.deviceBlacklist,
      },
      null,
      2,
    );
  }

  static parseRulesJson(
    json: string,
  ): { spaceRules: Partial<SpaceRuleSet>; deviceBlacklist: BlacklistEntry[] } {
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

    if (typeof rawSpaceRules.updatedAt === 'number' && Number.isFinite(rawSpaceRules.updatedAt)) {
      spaceRules.updatedAt = rawSpaceRules.updatedAt;
    }

    const rawDeviceBlacklist = Array.isArray(root.deviceBlacklist) ? root.deviceBlacklist : [];
    const deviceBlacklist = rawDeviceBlacklist
      .map((item, idx) => sanitizeBlacklistEntry(item, 'device', idx))
      .filter((item): item is BlacklistEntry => item !== null);

    return { spaceRules, deviceBlacklist };
  }
}
