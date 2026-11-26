import { sendSessionMeshCommand, unwrapCommand } from '@sessionmesh/shared';
import type {
  AccountRotationResult,
  BlacklistEntry,
  BrowserCandidateSite,
  BrowserCookieInput,
  CapabilityReport,
  ConflictRecord,
  CookieRecord,
  CreateSessionShareRequest,
  CreateSessionShareResult,
  CreateSiteAccountOptions,
  CurrentSiteSnapshot,
  DebugExportRequest,
  DebugExportResult,
  DeleteScope,
  Device,
  EnvCookieSyncResult,
  EnvCookieSyncRule,
  ExecuteEnvSyncInput,
  ImportArchiveBackupMode,
  ImportArchiveBackupResult,
  ImportSessionShareRequest,
  ImportSessionShareResult,
  IndexedDbRecord,
  InspectedIndexedDbDatabase,
  LocalStorageRecord,
  LogEntry,
  PendingSiteDecision,
  PerDeviceSyncPolicy,
  RemoteSpacePasswordVerifyResult,
  RemoteSpaceProbeItem,
  SafetyUndoPoint,
  SanitizedStorageProviderConfig,
  SessionMeshCommand,
  SessionMeshResponse,
  SessionSharePreview,
  SessionStorageRecord,
  SiteDecisionAction,
  SiteRuleOverride,
  SiteSummaryView,
  SiteTrack,
  SpaceAuthorityMode,
  SpaceSettings,
  SsoDomainGroup,
  StorageProviderConfig,
  SyncEvent,
  SyncRuleUpdatePayload,
  SyncStatusSummary,
  UpdateSiteTrackPatch,
  WebDAVConfig,
} from '@sessionmesh/shared';

export interface StatusSummaryWithSettings {
  status: SyncStatusSummary;
  currentSite?: CurrentSiteSnapshot | null;
  settings?: SpaceSettings;
  webdav?: Omit<WebDAVConfig, 'password' | 'bearerToken'> | null;
  storage?: SanitizedStorageProviderConfig | null;
}

export interface AddManagedSitesResult {
  added: string[];
  pendingDecisions: PendingSiteDecision[];
}

export interface SyncNowResult {
  pushedEvents: number;
  pulledEvents: number;
  appliedCookies: number;
  failedCookies: number;
  errorMessage?: string;
  errorCode?: string;
}

export interface RulesAndBlacklistData {
  spaceBlacklist: BlacklistEntry[];
  deviceBlacklist: BlacklistEntry[];
  siteOverrides: Record<string, SiteRuleOverride>;
  ssoGroups: SsoDomainGroup[];
  envSyncRules: EnvCookieSyncRule[];
}

export interface HistoryAndLogsData {
  events: SyncEvent[];
  logs: LogEntry[];
}

export async function runCommand<T>(cmd: SessionMeshCommand): Promise<T> {
  return unwrapCommand<T>(cmd);
}

export async function tryCommand<T>(cmd: SessionMeshCommand): Promise<SessionMeshResponse<T>> {
  return sendSessionMeshCommand<T>(cmd);
}

export const sidePanelApi = {
  async getStatusSummaryWithSettings(activeUrl?: string): Promise<StatusSummaryWithSettings> {
    const res = await runCommand<StatusSummaryWithSettings | SyncStatusSummary>({
      type: 'GET_STATUS_SUMMARY',
      activeUrl,
    });
    if (res && typeof res === 'object' && 'status' in res) {
      return res as StatusSummaryWithSettings;
    }
    return { status: res as SyncStatusSummary };
  },

  syncNow(options?: { siteKey?: string; direction?: 'both' | 'push' | 'pull' }): Promise<SyncNowResult> {
    return runCommand<SyncNowResult>({
      type: 'SYNC_NOW',
      siteKey: options?.siteKey,
      direction: options?.direction,
    });
  },

  setGlobalPaused(paused: boolean): Promise<void> {
    return runCommand<void>({ type: 'SET_GLOBAL_PAUSED', paused });
  },

  updateSpaceSettings(settings: Partial<SpaceSettings>): Promise<SpaceSettings> {
    return runCommand<SpaceSettings>({ type: 'UPDATE_SPACE_SETTINGS', settings });
  },

  dismissLatestError(): Promise<void> {
    return runCommand<void>({ type: 'DISMISS_LATEST_ERROR' });
  },

  dismissAttentionItem(itemId: string): Promise<void> {
    return runCommand<void>({ type: 'DISMISS_ATTENTION_ITEM', itemId });
  },

  retryFailedCookies(siteKey?: string): Promise<{ retried: number; succeeded: number; failed: number }> {
    return runCommand<{ retried: number; succeeded: number; failed: number }>({
      type: 'RETRY_FAILED_COOKIES',
      siteKey,
    });
  },

  forceReloadTab(tabId: number): Promise<{ reloaded: boolean }> {
    return runCommand<{ reloaded: boolean }>({ type: 'FORCE_RELOAD_TAB', tabId });
  },

  rebuildIndex(): Promise<void> {
    return runCommand<void>({ type: 'WEBDAV_REBUILD_INDEX' });
  },

  garbageCollect(): Promise<{ removedEventFiles: number; reclaimedTombstones: number }> {
    return runCommand<{ removedEventFiles: number; reclaimedTombstones: number }>({
      type: 'WEBDAV_GARBAGE_COLLECT',
    });
  },

  switchSpace(spaceId: string, encryptionPassword?: string): Promise<void> {
    return runCommand<void>({ type: 'SWITCH_SPACE', spaceId, encryptionPassword });
  },

  unlockSession(encryptionPassword: string, spaceId?: string): Promise<void> {
    return runCommand<void>({ type: 'UNLOCK_SESSION', encryptionPassword, spaceId });
  },

  lockSession(): Promise<void> {
    return runCommand<void>({ type: 'LOCK_SESSION' });
  },

  getSitesOverview(): Promise<SiteSummaryView[]> {
    return runCommand<SiteSummaryView[]>({ type: 'GET_SITES_OVERVIEW' });
  },

  scanBrowserCandidateSites(): Promise<BrowserCandidateSite[]> {
    return runCommand<BrowserCandidateSite[]>({ type: 'SCAN_BROWSER_CANDIDATE_SITES' });
  },

  addManagedSites(siteKeys: string[]): Promise<AddManagedSitesResult> {
    return runCommand<AddManagedSitesResult>({ type: 'ADD_MANAGED_SITES', siteKeys });
  },

  removeManagedSite(siteKey: string, scope: 'device_unmanage' | 'space_remove'): Promise<void> {
    return runCommand<void>({ type: 'REMOVE_MANAGED_SITE', siteKey, scope });
  },

  setSpaceAuthorityPolicy(authorityMode: SpaceAuthorityMode, primaryDeviceId?: string): Promise<SpaceSettings> {
    return runCommand<SpaceSettings>({
      type: 'SET_SPACE_AUTHORITY_POLICY',
      authorityMode,
      primaryDeviceId,
    });
  },

  upsertDevicePolicy(policy: PerDeviceSyncPolicy): Promise<void> {
    return runCommand<void>({ type: 'UPSERT_DEVICE_POLICY', policy });
  },

  removeDevicePolicy(deviceId: string): Promise<void> {
    return runCommand<void>({ type: 'REMOVE_DEVICE_POLICY', deviceId });
  },

  getPendingDecisions(): Promise<PendingSiteDecision[]> {
    return runCommand<PendingSiteDecision[]>({ type: 'GET_PENDING_DECISIONS' });
  },

  resolveSiteDecision(siteKey: string, action: SiteDecisionAction): Promise<void> {
    return runCommand<void>({ type: 'RESOLVE_SITE_DECISION', siteKey, action });
  },

  resolveBatchDecisions(siteKeys: string[], action: SiteDecisionAction): Promise<void> {
    return runCommand<void>({ type: 'RESOLVE_BATCH_DECISIONS', siteKeys, action });
  },

  switchSiteTrack(siteKey: string, targetTrackId: string): Promise<void> {
    return runCommand<void>({ type: 'SWITCH_SITE_TRACK', siteKey, targetTrackId });
  },

  splitSiteIndependent(siteKey: string, customLabel?: string): Promise<void> {
    return runCommand<void>({ type: 'SPLIT_SITE_INDEPENDENT', siteKey, customLabel });
  },

  renameSiteTrack(siteKey: string, trackId: string, label: string): Promise<void> {
    return runCommand<void>({ type: 'RENAME_SITE_TRACK', siteKey, trackId, label });
  },

  updateSiteTrack(siteKey: string, trackId: string, patch: UpdateSiteTrackPatch): Promise<SiteTrack> {
    return runCommand<SiteTrack>({ type: 'UPDATE_SITE_TRACK', siteKey, trackId, patch });
  },

  reorderSiteTracks(siteKey: string, orderedTrackIds: string[]): Promise<SiteTrack[]> {
    return runCommand<SiteTrack[]>({ type: 'REORDER_SITE_TRACKS', siteKey, orderedTrackIds });
  },

  createSiteAccountTrack(siteKey: string, options: CreateSiteAccountOptions): Promise<SiteTrack> {
    return runCommand<SiteTrack>({ type: 'CREATE_SITE_ACCOUNT_TRACK', siteKey, options });
  },

  rotateSiteTrack(siteKey: string, direction: 'next' | 'prev' = 'next'): Promise<AccountRotationResult> {
    return runCommand<AccountRotationResult>({ type: 'ROTATE_SITE_TRACK', siteKey, direction });
  },

  deleteSiteTrack(siteKey: string, trackId: string): Promise<{ deletedTrackId: string; switchedToTrack?: SiteTrack }> {
    return runCommand<{ deletedTrackId: string; switchedToTrack?: SiteTrack }>({
      type: 'DELETE_SITE_TRACK',
      siteKey,
      trackId,
    });
  },

  getSiteCookies(siteKey: string, trackId?: string): Promise<CookieRecord[]> {
    return runCommand<CookieRecord[]>({ type: 'GET_SITE_COOKIES', siteKey, trackId });
  },

  upsertCookie(siteKey: string, cookie: BrowserCookieInput, trackId?: string): Promise<CookieRecord> {
    return runCommand<CookieRecord>({ type: 'UPSERT_COOKIE', siteKey, cookie, trackId });
  },

  applyCookieToBrowser(logicalId: string): Promise<CookieRecord> {
    return runCommand<CookieRecord>({ type: 'APPLY_COOKIE_TO_BROWSER', logicalId });
  },

  deleteCookies(logicalIds: string[], scope: DeleteScope, siteKey?: string): Promise<void> {
    return runCommand<void>({ type: 'DELETE_COOKIES', logicalIds, scope, siteKey });
  },

  async importCookiesJson(cookies: BrowserCookieInput[], siteKey?: string, trackId?: string): Promise<number> {
    const res = await runCommand<number | { imported?: number; count?: number }>({
      type: 'IMPORT_COOKIES_JSON',
      siteKey,
      trackId,
      cookies,
    });
    if (typeof res === 'number') return res;
    return res?.imported ?? res?.count ?? cookies.length;
  },

  async exportCookiesJson(siteKey?: string, trackId?: string): Promise<BrowserCookieInput[]> {
    const res = await runCommand<BrowserCookieInput[] | { cookies?: BrowserCookieInput[] }>({
      type: 'EXPORT_COOKIES_JSON',
      siteKey,
      trackId,
    });
    if (Array.isArray(res)) return res;
    return res?.cookies ?? [];
  },

  getLocalStorageRecords(filter?: {
    siteKey?: string;
    origin?: string;
    trackId?: string;
  }): Promise<LocalStorageRecord[]> {
    return runCommand<LocalStorageRecord[]>({
      type: 'GET_LOCAL_STORAGE_RECORDS',
      siteKey: filter?.siteKey,
      origin: filter?.origin,
      trackId: filter?.trackId,
    });
  },

  upsertLocalStorageItem(origin: string, key: string, value: string, trackId?: string): Promise<LocalStorageRecord> {
    return runCommand<LocalStorageRecord>({
      type: 'UPSERT_LOCAL_STORAGE_ITEM',
      origin,
      key,
      value,
      trackId,
    });
  },

  applyLocalStorageItem(logicalId: string): Promise<LocalStorageRecord> {
    return runCommand<LocalStorageRecord>({
      type: 'APPLY_LOCAL_STORAGE_ITEM',
      logicalId,
    });
  },

  deleteLocalStorageItems(logicalIds: string[], scope: DeleteScope): Promise<void> {
    return runCommand<void>({
      type: 'DELETE_LOCAL_STORAGE_ITEMS',
      logicalIds,
      scope,
    });
  },

  getRulesAndBlacklist(): Promise<RulesAndBlacklistData> {
    return runCommand<RulesAndBlacklistData>({ type: 'GET_RULES_AND_BLACKLIST' });
  },

  addBlacklistEntry(entry: Omit<BlacklistEntry, 'id' | 'createdAt'>): Promise<BlacklistEntry> {
    return runCommand<BlacklistEntry>({ type: 'ADD_BLACKLIST_ENTRY', entry });
  },

  removeBlacklistEntry(id: string, scope: 'space' | 'device'): Promise<void> {
    return runCommand<void>({ type: 'REMOVE_BLACKLIST_ENTRY', id, scope });
  },

  upsertSiteRule(rule: SiteRuleOverride): Promise<void> {
    return runCommand<void>({ type: 'UPSERT_SITE_RULE', rule });
  },

  removeSiteRule(siteKey: string): Promise<void> {
    return runCommand<void>({ type: 'REMOVE_SITE_RULE', siteKey });
  },

  upsertSsoGroup(group: SsoDomainGroup): Promise<void> {
    return runCommand<void>({ type: 'UPSERT_SSO_GROUP', group });
  },

  removeSsoGroup(groupId: string): Promise<void> {
    return runCommand<void>({ type: 'REMOVE_SSO_GROUP', groupId });
  },

  upsertEnvSyncRule(
    rule: Omit<EnvCookieSyncRule, 'id' | 'name' | 'createdAt' | 'updatedAt'> & {
      id?: string;
      name?: string;
    },
  ): Promise<EnvCookieSyncRule> {
    return runCommand<EnvCookieSyncRule>({ type: 'UPSERT_ENV_SYNC_RULE', rule });
  },

  removeEnvSyncRule(ruleId: string, scope?: 'space' | 'device'): Promise<void> {
    return runCommand<void>({ type: 'REMOVE_ENV_SYNC_RULE', ruleId, scope });
  },

  executeEnvSync(input: ExecuteEnvSyncInput): Promise<EnvCookieSyncResult> {
    return runCommand<EnvCookieSyncResult>({ type: 'EXECUTE_ENV_SYNC', input });
  },

  importRulesJson(payload: SyncRuleUpdatePayload): Promise<void> {
    return runCommand<void>({ type: 'IMPORT_RULES_JSON', payload });
  },

  async exportRulesJson(): Promise<string> {
    const res = await runCommand<string | Record<string, unknown>>({ type: 'EXPORT_RULES_JSON' });
    return typeof res === 'string' ? res : JSON.stringify(res, null, 2);
  },

  getDevices(): Promise<Device[]> {
    return runCommand<Device[]>({ type: 'GET_DEVICES' });
  },

  renameDevice(deviceId: string, name: string): Promise<void> {
    return runCommand<void>({ type: 'RENAME_DEVICE', deviceId, name });
  },

  setDeviceState(deviceId: string, state: 'active' | 'paused' | 'removed' | 'revoked'): Promise<void> {
    return runCommand<void>({ type: 'SET_DEVICE_STATE', deviceId, state });
  },

  getHistoryAndLogs(filter?: { siteKey?: string; objectId?: string; limit?: number }): Promise<HistoryAndLogsData> {
    return runCommand<HistoryAndLogsData>({
      type: 'GET_HISTORY_AND_LOGS',
      siteKey: filter?.siteKey,
      objectId: filter?.objectId,
      limit: filter?.limit,
    });
  },

  restoreHistoricalEvent(eventId: string): Promise<void> {
    return runCommand<void>({ type: 'RESTORE_HISTORICAL_EVENT', eventId });
  },

  getConflicts(): Promise<ConflictRecord[]> {
    return runCommand<ConflictRecord[]>({ type: 'GET_CONFLICTS' });
  },

  resolveConflict(conflictId: string, choose: 'local' | 'remote'): Promise<void> {
    return runCommand<void>({ type: 'RESOLVE_CONFLICT', conflictId, choose });
  },

  getUndoPoints(): Promise<SafetyUndoPoint[]> {
    return runCommand<SafetyUndoPoint[]>({ type: 'GET_UNDO_POINTS' });
  },

  applyUndoPoint(undoId: string): Promise<void> {
    return runCommand<void>({ type: 'APPLY_UNDO_POINT', undoId });
  },

  exportDebugState(request: DebugExportRequest): Promise<DebugExportResult> {
    return runCommand<DebugExportResult>({ type: 'EXPORT_DEBUG_STATE', request });
  },

  toggleWatchedCookie(
    siteKey: string,
    cookieName: string,
    watched: boolean,
  ): Promise<{ watchedCookieNames: string[] }> {
    return runCommand<{ watchedCookieNames: string[] }>({
      type: 'TOGGLE_WATCHED_COOKIE',
      siteKey,
      cookieName,
      watched,
    });
  },

  createSessionShare(request: CreateSessionShareRequest): Promise<CreateSessionShareResult> {
    return runCommand<CreateSessionShareResult>({ type: 'CREATE_SESSION_SHARE', request });
  },

  previewSessionShare(code: string, passphrase: string): Promise<SessionSharePreview> {
    return runCommand<SessionSharePreview>({ type: 'PREVIEW_SESSION_SHARE', code, passphrase });
  },

  importSessionShare(request: ImportSessionShareRequest): Promise<ImportSessionShareResult> {
    return runCommand<ImportSessionShareResult>({ type: 'IMPORT_SESSION_SHARE', request });
  },

  getSessionStorageRecords(filter?: {
    siteKey?: string;
    origin?: string;
    trackId?: string;
  }): Promise<SessionStorageRecord[]> {
    return runCommand<SessionStorageRecord[]>({
      type: 'GET_SESSION_STORAGE_RECORDS',
      siteKey: filter?.siteKey,
      origin: filter?.origin,
      trackId: filter?.trackId,
    });
  },

  upsertSessionStorageItem(
    origin: string,
    key: string,
    value: string,
    trackId?: string,
  ): Promise<SessionStorageRecord> {
    return runCommand<SessionStorageRecord>({
      type: 'UPSERT_SESSION_STORAGE_ITEM',
      origin,
      key,
      value,
      trackId,
    });
  },

  applySessionStorageItem(logicalId: string): Promise<SessionStorageRecord> {
    return runCommand<SessionStorageRecord>({ type: 'APPLY_SESSION_STORAGE_ITEM', logicalId });
  },

  deleteSessionStorageItems(logicalIds: string[], scope: DeleteScope): Promise<void> {
    return runCommand<void>({ type: 'DELETE_SESSION_STORAGE_ITEMS', logicalIds, scope });
  },

  inspectPageIndexedDb(
    origin: string,
  ): Promise<{ available: boolean; databases: InspectedIndexedDbDatabase[]; reason?: string }> {
    return runCommand<{ available: boolean; databases: InspectedIndexedDbDatabase[]; reason?: string }>({
      type: 'INSPECT_PAGE_INDEXED_DB',
      origin,
    });
  },

  getIndexedDbRecords(filter?: {
    siteKey?: string;
    origin?: string;
    trackId?: string;
    dbName?: string;
  }): Promise<IndexedDbRecord[]> {
    return runCommand<IndexedDbRecord[]>({
      type: 'GET_INDEXED_DB_RECORDS',
      siteKey: filter?.siteKey,
      origin: filter?.origin,
      trackId: filter?.trackId,
      dbName: filter?.dbName,
    });
  },

  applyIndexedDbRecord(logicalId: string): Promise<IndexedDbRecord> {
    return runCommand<IndexedDbRecord>({ type: 'APPLY_INDEXED_DB_RECORD', logicalId });
  },

  deleteIndexedDbRecords(logicalIds: string[], scope: DeleteScope): Promise<void> {
    return runCommand<void>({ type: 'DELETE_INDEXED_DB_RECORDS', logicalIds, scope });
  },

  capturePageExtendedStorageNow(origin: string): Promise<{ capturedSession: number; capturedIndexedDb: number }> {
    return runCommand<{ capturedSession: number; capturedIndexedDb: number }>({
      type: 'CAPTURE_PAGE_EXTENDED_STORAGE_NOW',
      origin,
    });
  },

  testStorageConnection(storage: StorageProviderConfig): Promise<CapabilityReport> {
    return runCommand<CapabilityReport>({ type: 'TEST_STORAGE_CONNECTION', storage });
  },

  probeStorageSpaces(storage: StorageProviderConfig): Promise<RemoteSpaceProbeItem[]> {
    return runCommand<RemoteSpaceProbeItem[]>({ type: 'PROBE_STORAGE_SPACES', storage });
  },

  verifyStorageSpacePassword(
    storage: StorageProviderConfig,
    spaceId: string,
    encryptionPassword: string,
  ): Promise<RemoteSpacePasswordVerifyResult> {
    return runCommand<RemoteSpacePasswordVerifyResult>({
      type: 'VERIFY_STORAGE_SPACE_PASSWORD',
      storage,
      spaceId,
      encryptionPassword,
    });
  },

  updateSpaceStorageConfig(storage: StorageProviderConfig): Promise<{ updated: boolean }> {
    return runCommand<{ updated: boolean }>({ type: 'UPDATE_SPACE_STORAGE_CONFIG', storage });
  },

  notifyLocalDirPermissionGranted(handleKey?: string): Promise<{ ok: boolean }> {
    return runCommand<{ ok: boolean }>({ type: 'NOTIFY_LOCAL_DIR_PERMISSION_GRANTED', handleKey });
  },

  exportArchiveBackup(passphrase?: string): Promise<{ base64: string; suggestedFilename: string; byteLength: number }> {
    return runCommand<{ base64: string; suggestedFilename: string; byteLength: number }>({
      type: 'EXPORT_ARCHIVE_BACKUP',
      passphrase,
    });
  },

  importArchiveBackup(
    base64: string,
    mode: ImportArchiveBackupMode,
    passphrase?: string,
  ): Promise<ImportArchiveBackupResult> {
    return runCommand<ImportArchiveBackupResult>({
      type: 'IMPORT_ARCHIVE_BACKUP',
      base64,
      mode,
      passphrase,
    });
  },
};

export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return '操作失败，请查看诊断日志';
}
