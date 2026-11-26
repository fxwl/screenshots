/**
 * @sessionmesh/core — Authoritative Domain Types & Cross-Module Contracts
 * Covers SessionMesh V1.1 Chapters 3–18 + SiteTrack Multi-Device Auto-Discovery & Optimizations.
 */

export type DeviceStatus =
  | 'UNCONFIGURED'
  | 'INITIALIZING'
  | 'JOINING'
  | 'SYNCING'
  | 'SYNCED'
  | 'PENDING'
  | 'PARTIAL'
  | 'OFFLINE'
  | 'AUTH_ERROR'
  | 'DECRYPT_ERROR'
  | 'CONFLICT'
  | 'PAUSED'
  | 'LOCKED';

export type SyncTaskStatus =
  | 'CREATED'
  | 'QUEUED'
  | 'RUNNING'
  | 'COMMITTED'
  | 'APPLYING'
  | 'SUCCEEDED'
  | 'PARTIAL'
  | 'RETRYING'
  | 'FAILED'
  | 'CANCELLED';

export type CookieSyncStatus =
  | 'LOCAL_ONLY'
  | 'REMOTE_ONLY'
  | 'IN_SYNC'
  | 'LOCAL_NEWER'
  | 'REMOTE_NEWER'
  | 'CONCURRENT'
  | 'DELETED'
  | 'EXPIRED'
  | 'APPLY_FAILED'
  | 'EXCLUDED'
  | 'PENDING_CHOICE';

export type EventOperation = 'CREATE' | 'UPDATE' | 'DELETE' | 'RESTORE' | 'SNAPSHOT' | 'CHECKPOINT';

export type ObjectType = 'cookie' | 'localStorage';

export type SiteBindingState =
  | 'AUTO_BOUND'
  | 'USER_BOUND'
  | 'INDEPENDENT'
  | 'PENDING_CHOICE'
  | 'BLACKLISTED'
  | 'UNMANAGED';

export type SyncScopeMode = 'managed_only' | 'all_sites';

export type SyncTimingMode = 'on_page_leave' | 'realtime';

export type SpaceAuthorityMode = 'ask' | 'primary_device' | 'latest_wins';

export interface PerDeviceSyncPolicy {
  deviceId: string;
  mode: 'inherit' | 'independent_tracks' | 'follow_device';
  followDeviceId?: string;
  direction: SyncDirection;
  excludedSiteKeys?: string[];
  updatedAt: number;
}

export interface BrowserCandidateSite {
  siteKey: string;
  cookieCount: number;
  domains: string[];
  alreadyManaged: boolean;
  blacklisted: boolean;
}

export interface RemoteSpaceProbeItem {
  opaqueId: string;
  hintId: string;
  spaceId: string;
  spaceName: string;
  updatedAt?: number;
}

export interface RemoteSpacePasswordVerifyResult {
  exists: boolean;
  verified: boolean;
  spaceId?: string;
  spaceName?: string;
  keyEpoch?: number;
  errorCode?: string;
  errorMessage?: string;
}

export type DeleteScope = 'local_only' | 'remote_track_only' | 'all_devices';

export type CapabilityState = 'supported' | 'unsupported' | 'unverified';

export type ConsistencyLevel = 'strong_cas' | 'append_only_degraded' | 'incompatible';

export type WebDAVAuthType = 'basic' | 'app_password' | 'bearer';

export type RetryPolicy = 'standard' | 'aggressive' | 'low_frequency_nutstore' | 'none';

export type PayloadEncoding = 'json' | 'protobuf';

export type SyncDirection = 'inherit' | 'bidirectional' | 'push_only' | 'pull_only' | 'disabled';

export type SameSiteValue = 'no_restriction' | 'lax' | 'strict' | 'unspecified';

export interface HybridLogicalClock {
  physicalMs: number;
  logical: number;
  deviceId: string;
}

export type VectorClock = Record<string, number>;

export interface CausalVersion {
  hlc: HybridLogicalClock;
  vectorClock: VectorClock;
  deviceId: string;
  deviceSeq: number;
  versionId: string;
}

export type CausalComparison = 'EQUAL' | 'LOCAL_NEWER' | 'REMOTE_NEWER' | 'CONCURRENT';

export interface PartitionKeyInfo {
  topLevelSite: string;
  hasCrossSiteAncestor?: boolean;
}

export interface ApplyVerificationResult {
  accepted: boolean;
  verifiedAt: number;
  reason?: string;
  expired?: boolean;
  degradedPartitionKey?: boolean;
}

export interface CookieRecord {
  logicalId: string;
  siteKey: string;
  trackId: string;
  domain: string;
  path: string;
  name: string;
  value: string;
  storeScope: string;
  partitionKey?: PartitionKeyInfo | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSiteValue;
  session: boolean;
  expirationDate?: number;
  hostOnly: boolean;
  version: CausalVersion;
  sourceDevice: string;
  sourceDeviceName?: string;
  deleted: boolean;
  deleteReason?: string;
  updatedAt: number;
  syncStatus?: CookieSyncStatus;
  applyResult?: ApplyVerificationResult;
}

export interface LocalStorageRecord {
  logicalId: string;
  siteKey: string;
  trackId: string;
  origin: string;
  key: string;
  value: string;
  version: CausalVersion;
  sourceDevice: string;
  sourceDeviceName?: string;
  deleted: boolean;
  updatedAt: number;
  contextAvailable?: boolean;
  syncStatus?: CookieSyncStatus;
}

export interface SiteTrack {
  trackId: string;
  siteKey: string;
  label: string;
  originDeviceId: string;
  originDeviceName: string;
  cookieCount: number;
  localStorageCount: number;
  updatedAt: number;
  memberDeviceIds: string[];
  revision?: number;
  sortOrder?: number;
  lastUsedAt?: number;
  accountNote?: string;
}

export type AccountCreateMode = 'clean_new' | 'save_current';

export interface CreateSiteAccountOptions {
  label?: string;
  accountNote?: string;
  mode: AccountCreateMode;
  triggerRefresh?: boolean;
}

export interface UpdateSiteTrackPatch {
  label?: string;
  accountNote?: string;
  sortOrder?: number;
}

export interface AccountRotationResult {
  siteKey: string;
  track: SiteTrack;
  previousTrackId?: string;
  index: number;
  total: number;
  appliedCookies: number;
  failedCookies: number;
}

export interface DeviceSiteBinding {
  siteKey: string;
  state: SiteBindingState;
  trackId?: string;
  availableTrackIds?: string[];
  hasLocalBaseline: boolean;
  localCookieCount?: number;
  decidedAt?: number;
  decidedBy: 'auto' | 'user';
}

export interface PendingSiteDecision {
  siteKey: string;
  reason: 'both_sides_have_data' | 'multiple_remote_tracks';
  hasLocalData: boolean;
  localCookieCount: number;
  localLocalStorageCount: number;
  remoteTracks: SiteTrack[];
  detectedAt: number;
}

export type SiteDecisionAction =
  | { type: 'use_remote_track'; trackId: string }
  | { type: 'use_local_override_track'; trackId?: string }
  | { type: 'keep_independent'; customLabel?: string }
  | { type: 'blacklist'; scope: 'space' | 'device' };

export interface WebDAVConfig {
  url: string;
  authType: WebDAVAuthType;
  username?: string;
  password?: string;
  bearerToken?: string;
  rootPath: string;
  requestTimeoutMs?: number;
  retryPolicy?: RetryPolicy;
  storageFormat?: 'binary_enc' | 'base64_txt';
  allowInsecureLocalhostForTesting?: boolean;
}

export interface SpaceSettings {
  autoSync: boolean;
  direction: SyncDirection;
  syncCookies: boolean;
  syncLocalStorage: boolean;
  checkOnNavigate: boolean;
  backgroundCheck: boolean;
  pollingIntervalSec: number;
  autoRefresh: boolean;
  refreshProtection: boolean;
  payloadEncoding: PayloadEncoding;
  compression: boolean;
  lowFrequencyMode: boolean;
  filterAnalyticsNoiseCookies: boolean;
  sessionLockEnabled: boolean;
  keepSessionCookiesAlive?: boolean;
  syncScopeMode?: SyncScopeMode;
  syncTimingMode?: SyncTimingMode;
  authorityMode?: SpaceAuthorityMode;
  primaryDeviceId?: string;
  devicePolicies?: Record<string, PerDeviceSyncPolicy>;
}

export const DEFAULT_SPACE_SETTINGS: SpaceSettings = {
  autoSync: true,
  direction: 'bidirectional',
  syncCookies: true,
  syncLocalStorage: true,
  checkOnNavigate: true,
  backgroundCheck: true,
  pollingIntervalSec: 60,
  autoRefresh: true,
  refreshProtection: true,
  payloadEncoding: 'json',
  compression: true,
  lowFrequencyMode: false,
  filterAnalyticsNoiseCookies: true,
  sessionLockEnabled: false,
  keepSessionCookiesAlive: false,
  syncScopeMode: 'all_sites',
  authorityMode: 'ask',
  devicePolicies: {},
};

export interface SyncSpace {
  spaceId: string;
  opaqueId: string;
  name: string;
  provider: 'webdav';
  rootPath: string;
  schemaVersion: number;
  encryptionVersion: number;
  keyEpoch: number;
  createdAt: number;
  updatedAt: number;
  settings: SpaceSettings;
  status: DeviceStatus;
}

export interface DeviceCheckpoint {
  deviceId: string;
  spaceId: string;
  processedVectorClock: VectorClock;
  lastSnapshotId?: string;
  updatedAt: number;
}

export interface Device {
  deviceId: string;
  spaceId: string;
  name: string;
  browser: string;
  browserVersion: string;
  extensionVersion: string;
  platform: string;
  createdAt: number;
  lastSeenAt: number;
  lastSyncAt?: number;
  sequence: number;
  localRevision: number;
  remoteRevision: number;
  pendingEvents: number;
  failedEvents: number;
  checkpoint: DeviceCheckpoint;
  siteBindings: Record<string, DeviceSiteBinding>;
  state: 'active' | 'paused' | 'removed' | 'revoked';
}

export interface SyncEvent {
  eventId: string;
  spaceId: string;
  trackId: string;
  siteKey: string;
  deviceId: string;
  deviceName?: string;
  deviceSeq: number;
  objectType: ObjectType;
  objectId: string;
  operation: EventOperation;
  baseVersion?: CausalVersion | null;
  version: CausalVersion;
  cookieData?: Omit<CookieRecord, 'version' | 'syncStatus' | 'applyResult'>;
  localStorageData?: Omit<LocalStorageRecord, 'version' | 'syncStatus'>;
  deleteReason?: string;
  payloadHash: string;
  createdAt: number;
  committedAt?: number;
  status: SyncTaskStatus;
}

export interface EventBatch {
  batchId: string;
  spaceId: string;
  deviceId: string;
  deviceName?: string;
  fromSeq: number;
  toSeq: number;
  createdAt: number;
  events: SyncEvent[];
  tracksDelta?: SiteTrack[];
}

export type TombstoneReason = 'explicit' | 'logout' | 'expired' | 'evicted' | 'user_delete';

export interface Tombstone {
  objectId: string;
  objectType: ObjectType;
  siteKey: string;
  trackId: string;
  deleteVersion: CausalVersion;
  previousVersion?: CausalVersion | null;
  sourceDevice: string;
  reason: TombstoneReason;
  createdAt: number;
  acknowledgedDevices: string[];
  reclaimable: boolean;
}

export interface BlacklistEntry {
  id: string;
  pattern: string;
  matchType: 'exact_domain' | 'subdomain' | 'wildcard' | 'origin';
  scope: 'space' | 'device';
  reason?: string;
  presetCategory?: 'banking' | 'password_manager' | 'webdav_self' | 'localhost' | 'custom';
  createdAt: number;
}

export interface SiteRuleOverride {
  siteKey: string;
  pattern: string;
  direction: SyncDirection;
  syncCookies: boolean;
  syncLocalStorage: boolean;
  autoRefresh: boolean;
  updatedAt: number;
}

export interface SsoDomainGroup {
  groupId: string;
  name: string;
  primarySiteKey: string;
  domains: string[];
}

export interface EnvCookieSyncRule {
  id: string;
  name: string;
  scope: 'space' | 'device';
  enabled: boolean;
  sourceSiteKey: string;
  sourceHostFilter?: string;
  sourceTrackId?: string;
  targetUrl: string;
  syncCookies: boolean;
  syncLocalStorage: boolean;
  adaptForHttp: boolean;
  cleanTargetBeforeSync: boolean;
  autoSync: boolean;
  autoReloadTarget: boolean;
  includeCookieNames?: string[];
  excludeCookieNames?: string[];
  lastSyncedAt?: number;
  lastSyncedCount?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ExecuteEnvSyncInput {
  ruleId?: string;
  reverse?: boolean;
  adHoc?: {
    sourceSiteKey: string;
    sourceHostFilter?: string;
    sourceTrackId?: string;
    targetUrl: string;
    syncCookies?: boolean;
    syncLocalStorage?: boolean;
    adaptForHttp?: boolean;
    cleanTargetBeforeSync?: boolean;
    autoReloadTarget?: boolean;
    includeCookieNames?: string[];
    excludeCookieNames?: string[];
  };
}

export interface EnvCookieSyncResult {
  ruleId?: string;
  sourceSiteKey: string;
  targetUrl: string;
  targetHost: string;
  appliedCookies: number;
  failedCookies: number;
  removedStaleCookies: number;
  appliedLocalStorage: number;
  skippedCookies: number;
  reloadedTabs: number;
  errors: string[];
}

export interface SpaceRuleSet {
  spaceBlacklist: BlacklistEntry[];
  siteOverrides: Record<string, SiteRuleOverride>;
  ssoGroups: SsoDomainGroup[];
  envSyncRules?: EnvCookieSyncRule[];
  updatedAt: number;
}

export interface SnapshotPayload {
  snapshotId: string;
  spaceId: string;
  createdAt: number;
  createdByDevice: string;
  coveredVectorClock: VectorClock;
  cookies: Record<string, CookieRecord>;
  localStorage: Record<string, LocalStorageRecord>;
  tombstones: Record<string, Tombstone>;
  tracks: Record<string, SiteTrack>;
  rules: SpaceRuleSet;
}

export interface ConflictRecord {
  conflictId: string;
  spaceId: string;
  siteKey: string;
  trackId: string;
  objectType: ObjectType;
  objectId: string;
  localRecord: CookieRecord | LocalStorageRecord;
  remoteRecord: CookieRecord | LocalStorageRecord;
  winningSide: 'local' | 'remote';
  resolvedRecord: CookieRecord | LocalStorageRecord;
  detectedAt: number;
  resolved: boolean;
  resolvedBy?: 'auto' | 'user';
}

export interface BrowserCookieInput {
  domain: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSiteValue;
  session: boolean;
  expirationDate?: number;
  hostOnly: boolean;
  storeId?: string;
  partitionKey?: PartitionKeyInfo | null;
}

export type BrowserCookieChangeCause = 'evicted' | 'expired' | 'explicit' | 'expired_overwrite' | 'overwrite';

export interface BrowserCookieChangeEvent {
  removed: boolean;
  cookie: BrowserCookieInput;
  cause: BrowserCookieChangeCause;
}

export interface BrowserTabInfo {
  id: number;
  url?: string;
  title?: string;
  favIconUrl?: string;
  active: boolean;
  windowId?: number;
  status?: 'loading' | 'complete';
}

export interface PageReloadSafetyStatus {
  safe: boolean;
  reasons: string[];
}

export interface SafetyUndoPoint {
  undoId: string;
  spaceId: string;
  siteKey: string;
  reason: string;
  createdAt: number;
  previousBinding?: DeviceSiteBinding;
  cookies: BrowserCookieInput[];
  localStorageByOrigin: Record<string, Record<string, string>>;
}

export interface SyncTask {
  taskId: string;
  spaceId: string;
  taskType: 'push_events' | 'pull_remote' | 'pull_site' | 'snapshot' | 'gc' | 'delete_remote';
  relatedObjectIds: string[];
  status: SyncTaskStatus;
  retryCount: number;
  nextRetryAt?: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: number;
  completedAt?: number;
}

export interface WebDAVFile {
  fileId: string;
  spaceId: string;
  remotePath: string;
  fileType: 'space_meta' | 'device' | 'event_batch' | 'checkpoint' | 'snapshot' | 'backup';
  etag?: string;
  contentHash?: string;
  size: number;
  encryptionVersion: number;
  schemaVersion: number;
  lastCheckedAt: number;
  status: 'valid' | 'corrupted' | 'missing';
}

export interface WebDAVResourceStat {
  path: string;
  href: string;
  name: string;
  isCollection: boolean;
  etag?: string;
  size: number;
  lastModified?: number;
  status: number;
  quotaUsedBytes?: number;
  quotaAvailableBytes?: number;
}

export interface CapabilityCheckResult {
  id: string;
  step: number;
  name: string;
  state: CapabilityState;
  latencyMs?: number;
  detail?: string;
}

export interface CapabilityReport {
  testedAt: number;
  url: string;
  overallOk: boolean;
  consistencyLevel: ConsistencyLevel;
  checks: CapabilityCheckResult[];
  totalLatencyMs: number;
  quotaUsedBytes?: number;
  quotaAvailableBytes?: number;
  recommendedStorageFormat?: 'binary_enc' | 'base64_txt';
  summaryMessage: string;
}

export interface StructuredError {
  code: string;
  phase: string;
  message: string;
  target?: string;
  status?: number;
  retryable: boolean;
  suggestion: string;
  timestamp: number;
}

export interface LogEntry {
  id: string;
  spaceId?: string;
  level: 'info' | 'warn' | 'error';
  phase: string;
  code?: string;
  message: string;
  siteKey?: string;
  objectId?: string;
  deviceId?: string;
  suggestion?: string;
  timestamp: number;
}

export interface IntegrityReport {
  checkedAt: number;
  ok: boolean;
  spaceMetadataOk: boolean;
  deviceFilesCount: number;
  eventFilesCount: number;
  snapshotFilesCount: number;
  corruptedPaths: string[];
  missingSeqGaps: string[];
  details: string[];
}

export interface PairingPayload {
  version: 1;
  webdav: WebDAVConfig;
  spaceId: string;
  spaceName: string;
  createdAt: number;
  fromDeviceName: string;
}

export interface SpaceDescriptorPayload {
  spaceId: string;
  opaqueId: string;
  name: string;
  schemaVersion: number;
  encryptionVersion: number;
  keyEpoch: number;
  currentDekBase64: string;
  dekKeyring: Record<number, string>;
  createdAt: number;
  updatedAt: number;
  settings: SpaceSettings;
  rules: SpaceRuleSet;
  verifier: 'SESSIONMESH_SPACE_OK';
}

export interface InitialJoinReport {
  spaceId: string;
  spaceName: string;
  isNewSpace: boolean;
  deviceId: string;
  autoSyncedSites: string[];
  localUploadedSites: string[];
  pendingDecisions: PendingSiteDecision[];
  excludedBlacklistedSites: string[];
}

export interface SiteSummaryView {
  siteKey: string;
  favIconUrl?: string;
  binding: DeviceSiteBinding;
  activeTrack?: SiteTrack;
  allTracks: SiteTrack[];
  cookieCount: number;
  localStorageCount: number;
  latestVersionId?: string;
  sourceDeviceName?: string;
  updatedAt?: number;
  syncStatus: CookieSyncStatus;
  rollingTokenDamped?: boolean;
}

export type AttentionItemKind =
  | 'auth_error'
  | 'decrypt_error'
  | 'storage_full'
  | 'latest_error'
  | 'pending_decision'
  | 'conflict'
  | 'apply_failed'
  | 'corrupted_file'
  | 'offline_pending'
  | 'pending_upload'
  | 'retry_task'
  | 'deferred_reload';

export interface AttentionItem {
  id: string;
  kind: AttentionItemKind;
  severity: 'error' | 'warning' | 'info';
  siteKey?: string;
  tabId?: number;
  conflictId?: string;
  logicalIds?: string[];
  count?: number;
  title: string;
  detail: string;
  suggestion?: string;
  dismissible?: boolean;
  timestamp?: number;
}

export interface SyncStatusSummary {
  configured: boolean;
  locked: boolean;
  activeSpaceId?: string;
  activeSpaceName?: string;
  spaces: Array<{ spaceId: string; name: string; status: DeviceStatus }>;
  device?: Device;
  status: DeviceStatus;
  webdavConnected: boolean;
  webdavUrl?: string;
  consistencyLevel?: ConsistencyLevel;
  lastSyncAt?: number;
  lastLatencyMs?: number;
  pendingUploads: number;
  pendingApplies: number;
  pendingDecisionsCount: number;
  unresolvedConflictsCount: number;
  undoPointsCount: number;
  latestError?: StructuredError | null;
  attentionItems: AttentionItem[];
}

/**
 * StorageBackend — Pluggable key-value / namespace storage for IndexedDB & In-Memory testing.
 */
export interface StorageBackend {
  get<T>(namespace: string, key: string): Promise<T | undefined>;
  set<T>(namespace: string, key: string, value: T): Promise<void>;
  delete(namespace: string, key: string): Promise<void>;
  getAll<T>(namespace: string, prefix?: string): Promise<Record<string, T>>;
  clearNamespace(namespace: string): Promise<void>;
}

/**
 * BrowserApiAdapter — Decouples @sessionmesh/core from chrome.* globals.
 */
export interface BrowserApiAdapter {
  getAllCookies(filter?: { domain?: string; url?: string; storeId?: string }): Promise<BrowserCookieInput[]>;
  getCookie(details: {
    url: string;
    name: string;
    storeId?: string;
    partitionKey?: PartitionKeyInfo | null;
  }): Promise<BrowserCookieInput | null>;
  setCookie(
    details: BrowserCookieInput & { url: string },
  ): Promise<{ cookie: BrowserCookieInput | null; error?: string }>;
  removeCookie(details: {
    url: string;
    name: string;
    storeId?: string;
    partitionKey?: PartitionKeyInfo | null;
  }): Promise<void>;
  onCookieChanged(listener: (event: BrowserCookieChangeEvent) => void): () => void;

  queryTabs(filter?: { active?: boolean; url?: string }): Promise<BrowserTabInfo[]>;
  reloadTab(tabId: number): Promise<void>;
  checkTabSafeToReload(tabId: number): Promise<PageReloadSafetyStatus>;

  getLocalStorage(origin: string): Promise<{ available: boolean; items: Record<string, string> }>;
  applyLocalStorage(
    origin: string,
    mutations: Array<{ key: string; value?: string; deleted?: boolean }>,
  ): Promise<{ applied: boolean; reason?: string }>;

  getDevicePlatformInfo(): Promise<{
    browser: string;
    browserVersion: string;
    extensionVersion: string;
    platform: string;
  }>;

  isOnline?(): boolean;
  now?(): number;
}
