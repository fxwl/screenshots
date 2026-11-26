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

export type ObjectType = 'cookie' | 'localStorage' | 'sessionStorage' | 'indexedDb';

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

export interface SessionStorageRecord {
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

export interface IndexedDbRecord {
  logicalId: string;
  siteKey: string;
  trackId: string;
  origin: string;
  dbName: string;
  dbVersion?: number;
  storeName: string;
  keyPath?: string | string[] | null;
  autoIncrement?: boolean;
  encodedKey: string;
  encodedValue: string;
  byteLength: number;
  version: CausalVersion;
  sourceDevice: string;
  sourceDeviceName?: string;
  deleted: boolean;
  updatedAt: number;
  contextAvailable?: boolean;
  syncStatus?: CookieSyncStatus;
}

export type SyncRecord = CookieRecord | LocalStorageRecord | SessionStorageRecord | IndexedDbRecord;

export interface EphemeralTrackMeta {
  shareId: string;
  expiresAt: number;
  localOnly: boolean;
  sharedBy?: string;
  note?: string;
}

export interface SiteTrack {
  trackId: string;
  siteKey: string;
  label: string;
  originDeviceId: string;
  originDeviceName: string;
  cookieCount: number;
  localStorageCount: number;
  sessionStorageCount?: number;
  indexedDbCount?: number;
  updatedAt: number;
  memberDeviceIds: string[];
  revision?: number;
  sortOrder?: number;
  lastUsedAt?: number;
  accountNote?: string;
  color?: string;
  badgeText?: string;
  ephemeral?: EphemeralTrackMeta;
}

export type AccountCreateMode = 'clean_new' | 'save_current';

export interface CreateSiteAccountOptions {
  label?: string;
  accountNote?: string;
  color?: string;
  badgeText?: string;
  mode: AccountCreateMode;
  triggerRefresh?: boolean;
}

export interface UpdateSiteTrackPatch {
  label?: string;
  accountNote?: string;
  sortOrder?: number;
  color?: string | null;
  badgeText?: string | null;
}

export interface AccountRotationResult {
  siteKey: string;
  track: SiteTrack;
  previousTrackId?: string;
  index: number;
  total: number;
  appliedCookies: number;
  failedCookies: number;
  reloadedTabs?: number;
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

export type StorageProviderType = 'webdav' | 's3' | 'github_gist' | 'local_directory';

export type S3VendorPreset = 'r2' | 'aliyun_oss' | 'aws_s3' | 'minio' | 'cos' | 'b2' | 'custom';

export interface S3StorageConfig {
  provider: 's3';
  vendorPreset?: S3VendorPreset;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  rootPrefix: string;
  addressingStyle?: 'path' | 'virtual_hosted';
  signatureMode?: 'aws_v4' | 'oss_v4';
  requestTimeoutMs?: number;
  allowInsecureLocalhostForTesting?: boolean;
}

export interface GitHubGistStorageConfig {
  provider: 'github_gist';
  personalAccessToken: string;
  gistId?: string;
  apiBaseUrl?: string;
  rootPrefix?: string;
  requestTimeoutMs?: number;
  allowInsecureLocalhostForTesting?: boolean;
}

export interface LocalDirectoryStorageConfig {
  provider: 'local_directory';
  directoryLabel: string;
  handleKey: string;
  rootPrefix?: string;
}

export type StorageProviderConfig =
  | ({ provider: 'webdav' } & WebDAVConfig)
  | S3StorageConfig
  | GitHubGistStorageConfig
  | LocalDirectoryStorageConfig;

export type SanitizedStorageProviderConfig =
  | ({ provider: 'webdav' } & Omit<WebDAVConfig, 'password' | 'bearerToken'>)
  | Omit<S3StorageConfig, 'secretAccessKey' | 'sessionToken'>
  | Omit<GitHubGistStorageConfig, 'personalAccessToken'>
  | LocalDirectoryStorageConfig;

export interface RemoteObjectStat {
  path: string;
  href?: string;
  name: string;
  isCollection: boolean;
  etag?: string;
  size: number;
  lastModified?: number;
  status?: number;
  quotaUsedBytes?: number;
  quotaAvailableBytes?: number;
}

export interface RemoteStorageAdapter {
  readonly provider: StorageProviderType;
  readonly displayEndpoint: string;
  setStorageFormat?(format: 'binary_enc' | 'base64_txt'): void;
  validateConfig(): void;
  checkCapabilities(): Promise<CapabilityReport>;
  ensureDir(subPath: string): Promise<void>;
  list(subPath: string, depth?: 0 | 1): Promise<RemoteObjectStat[]>;
  stat(subPath: string): Promise<RemoteObjectStat | null>;
  getBytes(
    subPath: string,
    options?: { ifNoneMatch?: string },
  ): Promise<{
    notModified: boolean;
    bytes: Uint8Array;
    etag?: string;
    status: number;
  }>;
  putBytes(
    subPath: string,
    bytes: Uint8Array,
    options?: { ifMatch?: string; ifNoneMatchStar?: boolean; contentType?: string },
  ): Promise<{ etag?: string; status: number }>;
  delete(subPath: string, options?: { ifMatch?: string; isCollection?: boolean }): Promise<void>;
}

export type ToolbarBadgeDisplayMode = 'multi_or_tagged' | 'always' | 'status_only';

export interface CookieExpiryWarningSettings {
  enabled: boolean;
  warningLeadHours: number;
  criticalLeadHours: number;
  includeInactiveTracks: boolean;
}

export interface SpaceSettings {
  autoSync: boolean;
  direction: SyncDirection;
  syncCookies: boolean;
  syncLocalStorage: boolean;
  syncSessionStorage?: boolean;
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
  badgeDisplayMode?: ToolbarBadgeDisplayMode;
  expiryWarning?: CookieExpiryWarningSettings;
}

export const DEFAULT_SPACE_SETTINGS: SpaceSettings = {
  autoSync: true,
  direction: 'bidirectional',
  syncCookies: true,
  syncLocalStorage: true,
  syncSessionStorage: false,
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
  badgeDisplayMode: 'multi_or_tagged',
  expiryWarning: {
    enabled: true,
    warningLeadHours: 24,
    criticalLeadHours: 2,
    includeInactiveTracks: true,
  },
};

export interface SyncSpace {
  spaceId: string;
  opaqueId: string;
  name: string;
  provider: StorageProviderType;
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
  sessionStorageData?: Omit<SessionStorageRecord, 'version' | 'syncStatus'>;
  indexedDbData?: Omit<IndexedDbRecord, 'version' | 'syncStatus'>;
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

export interface IndexedDbTargetRule {
  dbName: string;
  objectStores?: string[];
  keyPrefixes?: string[];
}

export interface SiteRuleOverride {
  siteKey: string;
  pattern: string;
  direction: SyncDirection;
  syncCookies: boolean;
  syncLocalStorage: boolean;
  syncSessionStorage?: boolean;
  sessionStorageKeyAllowlist?: string[];
  syncIndexedDb?: boolean;
  indexedDbTargets?: IndexedDbTargetRule[];
  indexedDbMaxTotalBytes?: number;
  watchedCookieNames?: string[];
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
  syncSessionStorage?: boolean;
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
    syncSessionStorage?: boolean;
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
  appliedSessionStorage?: number;
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
  sessionStorage?: Record<string, SessionStorageRecord>;
  indexedDb?: Record<string, IndexedDbRecord>;
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
  localRecord: SyncRecord;
  remoteRecord: SyncRecord;
  winningSide: 'local' | 'remote';
  resolvedRecord: SyncRecord;
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
  sessionStorageByOrigin?: Record<string, Record<string, string>>;
  indexedDbRecords?: IndexedDbRecord[];
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
  resolvedGistId?: string;
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
  version: 1 | 2;
  webdav?: WebDAVConfig;
  storage?: StorageProviderConfig;
  spaceId: string;
  spaceName: string;
  createdAt: number;
  fromDeviceName: string;
}

export type DebugExportFormat =
  | 'curl'
  | 'fetch'
  | 'cookie_header'
  | 'headers_json'
  | 'playwright_storage_state'
  | 'postman_apifox'
  | 'netscape_cookies_txt';

export interface DebugExportRequest {
  siteKey?: string;
  trackId?: string;
  targetUrl?: string;
  format: DebugExportFormat;
  filterNoise?: boolean;
  includeLocalStorage?: boolean;
  includeSessionStorage?: boolean;
}

export interface DebugExportResult {
  format: DebugExportFormat;
  siteKey: string;
  trackId?: string;
  trackLabel?: string;
  targetUrl: string;
  content: string;
  suggestedFilename: string;
  cookieCount: number;
  originCount: number;
  liveFallback?: boolean;
}

export interface InspectedIndexedDbStore {
  name: string;
  keyPath?: string | string[] | null;
  autoIncrement?: boolean;
  recordCount: number;
  estimatedBytes: number;
}

export interface InspectedIndexedDbDatabase {
  dbName: string;
  version: number;
  stores: InspectedIndexedDbStore[];
  totalEstimatedBytes: number;
}

export interface IndexedDbMutation {
  dbName: string;
  dbVersion?: number;
  storeName: string;
  keyPath?: string | string[] | null;
  autoIncrement?: boolean;
  encodedKey: string;
  encodedValue?: string;
  deleted?: boolean;
}

export interface SessionSharePayload {
  version: 1;
  shareId: string;
  siteKey: string;
  accountLabel?: string;
  note?: string;
  sharedBy?: string;
  createdAt: number;
  expiresAt: number;
  clampCookieExpiry: boolean;
  cookies: BrowserCookieInput[];
  localStorageByOrigin?: Record<string, Record<string, string>>;
  sessionStorageByOrigin?: Record<string, Record<string, string>>;
}

export interface CreateSessionShareRequest {
  siteKey: string;
  trackId?: string;
  passphrase: string;
  ttlMs: number;
  accountLabel?: string;
  note?: string;
  sharedBy?: string;
  filterNoise?: boolean;
  excludeHttpOnly?: boolean;
  includeCookieNames?: string[];
  excludeCookieNames?: string[];
  includeLocalStorage?: boolean;
  includeSessionStorage?: boolean;
  clampCookieExpiry?: boolean;
}

export interface CreateSessionShareResult {
  code: string;
  shareId: string;
  siteKey: string;
  accountLabel: string;
  expiresAt: number;
  cookieCount: number;
  localStorageCount: number;
  sessionStorageCount: number;
}

export interface SessionSharePreview {
  shareId: string;
  siteKey: string;
  accountLabel?: string;
  note?: string;
  sharedBy?: string;
  createdAt: number;
  expiresAt: number;
  remainingMs: number;
  clampCookieExpiry: boolean;
  cookieCount: number;
  cookieNames: string[];
  localStorageCount: number;
  sessionStorageCount: number;
}

export type SessionShareImportMode = 'ephemeral_track' | 'env_target' | 'override_active';

export interface ImportSessionShareRequest {
  code: string;
  passphrase: string;
  mode: SessionShareImportMode;
  customLabel?: string;
  targetUrl?: string;
  adaptForHttp?: boolean;
}

export interface ImportSessionShareResult {
  mode: SessionShareImportMode;
  siteKey: string;
  track?: SiteTrack;
  targetUrl?: string;
  appliedCookies: number;
  appliedLocalStorage: number;
  appliedSessionStorage: number;
}

export type ExpiryHealthStatus = 'healthy' | 'expiring_soon' | 'critical' | 'expired';

export interface ExpiringCookieSummary {
  logicalId: string;
  name: string;
  domain: string;
  trackId: string;
  trackLabel?: string;
  expirationDate: number;
  remainingMs: number;
  status: Exclude<ExpiryHealthStatus, 'healthy'>;
  watched: boolean;
  httpOnly: boolean;
}

export interface SiteExpiryHealth {
  siteKey: string;
  status: ExpiryHealthStatus;
  earliestExpiryAt?: number;
  remainingMs?: number;
  expiringCookies: ExpiringCookieSummary[];
  sessionOnlyAuthCount: number;
}

export interface ArchiveBackupPayload {
  format: 'sessionmesh_archive';
  version: 1;
  exportedAt: number;
  spaceName: string;
  snapshot: SnapshotPayload;
}

export type ImportArchiveBackupMode = 'merge' | 'replace';

export interface ImportArchiveBackupResult {
  mode: ImportArchiveBackupMode;
  spaceName: string;
  importedCookies: number;
  importedLocalStorage: number;
  importedSessionStorage: number;
  importedIndexedDb: number;
  importedTracks: number;
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
  sessionStorageCount?: number;
  indexedDbCount?: number;
  latestVersionId?: string;
  sourceDeviceName?: string;
  updatedAt?: number;
  syncStatus: CookieSyncStatus;
  rollingTokenDamped?: boolean;
  expiryHealth?: SiteExpiryHealth;
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
  | 'deferred_reload'
  | 'cookie_expiring'
  | 'indexeddb_quota_exceeded'
  | 'local_dir_permission_needed'
  | 'ephemeral_track_expired';

export interface AttentionItem {
  id: string;
  kind: AttentionItemKind;
  severity: 'error' | 'warning' | 'info';
  siteKey?: string;
  trackId?: string;
  handleKey?: string;
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
  spaces: Array<{ spaceId: string; name: string; status: DeviceStatus; provider?: StorageProviderType }>;
  device?: Device;
  status: DeviceStatus;
  storageProvider?: StorageProviderType;
  storageEndpoint?: string;
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
  expiringSitesCount?: number;
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

  getSessionStorage?(origin: string): Promise<{ available: boolean; items: Record<string, string> }>;
  applySessionStorage?(
    origin: string,
    mutations: Array<{ key: string; value?: string; deleted?: boolean }>,
  ): Promise<{ applied: boolean; reason?: string }>;

  inspectIndexedDb?(
    origin: string,
  ): Promise<{ available: boolean; databases: InspectedIndexedDbDatabase[]; reason?: string }>;
  getIndexedDbRecords?(
    origin: string,
    targets: IndexedDbTargetRule[],
    maxTotalBytes?: number,
  ): Promise<{
    available: boolean;
    quotaExceeded?: boolean;
    totalBytes: number;
    records: Array<
      Omit<
        IndexedDbRecord,
        | 'logicalId'
        | 'siteKey'
        | 'trackId'
        | 'version'
        | 'sourceDevice'
        | 'sourceDeviceName'
        | 'deleted'
        | 'updatedAt'
        | 'syncStatus'
      >
    >;
    reason?: string;
  }>;
  applyIndexedDbMutations?(
    origin: string,
    mutations: IndexedDbMutation[],
    clearStores?: Array<{ dbName: string; storeName: string }>,
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
