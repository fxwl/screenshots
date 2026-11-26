import type {
  BlacklistEntry,
  EnvCookieSyncRule,
  SanitizedStorageProviderConfig,
  SiteRuleOverride,
  SiteSummaryView,
  SpaceSettings,
  SsoDomainGroup,
  SyncStatusSummary,
  WebDAVConfig,
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
  settings?: SpaceSettings;
  webdav?: Omit<WebDAVConfig, 'password' | 'bearerToken'> | null;
  storage?: SanitizedStorageProviderConfig | null;
}

export interface AccountSwitchToastPayload {
  siteKey: string;
  label: string;
  badgeText?: string;
  color?: string;
  index?: number;
  total?: number;
  message?: string;
}

export interface ContentPageMountConfig {
  acknowledged: boolean;
  syncSessionStorage?: boolean;
  sessionStorageKeyAllowlist?: string[];
  syncIndexedDb?: boolean;
  indexedDbTargets?: Array<{ dbName: string; objectStores?: string[]; keyPrefixes?: string[] }>;
  indexedDbMaxTotalBytes?: number;
  pendingToast?: AccountSwitchToastPayload | null;
}
