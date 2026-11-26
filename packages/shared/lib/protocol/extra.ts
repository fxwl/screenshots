import type {
  BlacklistEntry,
  EnvCookieSyncRule,
  SiteRuleOverride,
  SiteSummaryView,
  SsoDomainGroup,
  SyncStatusSummary,
} from '@sessionmesh/core';

export * from '@sessionmesh/core';

export interface SyncRuleUpdatePayload {
  spaceBlacklist?: BlacklistEntry[];
  deviceBlacklist?: BlacklistEntry[];
  siteOverrides?: Record<string, SiteRuleOverride>;
  ssoGroups?: SsoDomainGroup[];
  envSyncRules?: EnvCookieSyncRule[];
  deviceEnvSyncRules?: EnvCookieSyncRule[];
}

export interface CurrentSiteSnapshot {
  siteKey: string;
  origin?: string;
  url?: string;
  favIconUrl?: string;
  summary?: SiteSummaryView;
  matchingEnvRules?: EnvCookieSyncRule[];
}

export interface PopupSummaryPayload {
  status: SyncStatusSummary;
  currentSite?: CurrentSiteSnapshot | null;
}
