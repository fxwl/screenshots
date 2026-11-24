import type {
  BlacklistEntry,
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
}

export interface CurrentSiteSnapshot {
  siteKey: string;
  origin?: string;
  url?: string;
  favIconUrl?: string;
  summary?: SiteSummaryView;
}

export interface PopupSummaryPayload {
  status: SyncStatusSummary;
  currentSite?: CurrentSiteSnapshot | null;
}
