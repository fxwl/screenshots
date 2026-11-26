/**
 * SessionMesh Runtime IPC Protocol (Background <-> Popup / Options / SidePanel / Content Script)
 */
import type {
  AccountCreateMode,
  AccountRotationResult,
  AccountSwitchToastPayload,
  AttentionItem,
  AttentionItemKind,
  BlacklistEntry,
  BrowserCandidateSite,
  BrowserCookieInput,
  CapabilityReport,
  ConflictRecord,
  ContentPageMountConfig,
  CookieExpiryWarningSettings,
  CookieRecord,
  CreateSessionShareRequest,
  CreateSessionShareResult,
  CreateSiteAccountOptions,
  DebugExportFormat,
  DebugExportRequest,
  DebugExportResult,
  DeleteScope,
  Device,
  EnvCookieSyncResult,
  EnvCookieSyncRule,
  ExecuteEnvSyncInput,
  ExpiryHealthStatus,
  GitHubGistStorageConfig,
  ImportArchiveBackupMode,
  ImportArchiveBackupResult,
  ImportSessionShareRequest,
  ImportSessionShareResult,
  IndexedDbMutation,
  IndexedDbRecord,
  IndexedDbTargetRule,
  InitialJoinReport,
  InspectedIndexedDbDatabase,
  InspectedIndexedDbStore,
  IntegrityReport,
  LocalDirectoryStorageConfig,
  LocalStorageRecord,
  LogEntry,
  PageReloadSafetyStatus,
  PendingSiteDecision,
  PerDeviceSyncPolicy,
  RemoteObjectStat,
  RemoteSpacePasswordVerifyResult,
  RemoteSpaceProbeItem,
  S3StorageConfig,
  S3VendorPreset,
  SafetyUndoPoint,
  SanitizedStorageProviderConfig,
  SessionShareImportMode,
  SessionSharePayload,
  SessionSharePreview,
  SessionStorageRecord,
  SiteDecisionAction,
  SiteExpiryHealth,
  SiteRuleOverride,
  SiteSummaryView,
  SpaceAuthorityMode,
  SpaceSettings,
  SsoDomainGroup,
  StorageProviderConfig,
  StorageProviderType,
  SyncEvent,
  SyncRecord,
  SyncRuleUpdatePayload,
  SyncStatusSummary,
  ToolbarBadgeDisplayMode,
  UpdateSiteTrackPatch,
  WebDAVConfig,
  WebDAVResourceStat,
} from './extra';

export * from './extra';

export type SessionMeshCommand =
  | { type: 'GET_STATUS_SUMMARY'; activeUrl?: string }
  | { type: 'TEST_WEBDAV_CONNECTION'; config: WebDAVConfig }
  | { type: 'TEST_STORAGE_CONNECTION'; storage: StorageProviderConfig }
  | { type: 'PROBE_REMOTE_SPACES'; config: WebDAVConfig }
  | { type: 'PROBE_STORAGE_SPACES'; storage: StorageProviderConfig }
  | {
      type: 'VERIFY_SPACE_PASSWORD';
      webdav: WebDAVConfig;
      spaceId: string;
      encryptionPassword: string;
    }
  | {
      type: 'VERIFY_STORAGE_SPACE_PASSWORD';
      storage: StorageProviderConfig;
      spaceId: string;
      encryptionPassword: string;
    }
  | {
      type: 'SAVE_AND_JOIN_SPACE';
      webdav?: WebDAVConfig;
      storage?: StorageProviderConfig;
      spaceId: string;
      spaceName: string;
      encryptionPassword: string;
      deviceName: string;
      presetCategories?: Array<'banking' | 'password_manager' | 'webdav_self' | 'localhost'>;
      settingsPatch?: Partial<SpaceSettings>;
      initialManagedSiteKeys?: string[];
    }
  | { type: 'UPDATE_SPACE_STORAGE_CONFIG'; storage: StorageProviderConfig }
  | { type: 'NOTIFY_LOCAL_DIR_PERMISSION_GRANTED'; handleKey?: string }
  | { type: 'UNLOCK_SESSION'; encryptionPassword: string; spaceId?: string }
  | { type: 'LOCK_SESSION' }
  | { type: 'GENERATE_PAIRING_CODE'; passphrase?: string }
  | { type: 'DECODE_PAIRING_CODE'; code: string; passphrase: string }
  | { type: 'SYNC_NOW'; siteKey?: string; direction?: 'both' | 'push' | 'pull'; triggerRefresh?: boolean }
  | { type: 'SET_GLOBAL_PAUSED'; paused: boolean }
  | { type: 'UPDATE_SPACE_SETTINGS'; settings: Partial<SpaceSettings> }
  | { type: 'SWITCH_SPACE'; spaceId: string; encryptionPassword?: string }
  | { type: 'CREATE_SPACE'; spaceId: string; spaceName: string; encryptionPassword: string }
  | { type: 'RENAME_SPACE'; spaceId: string; newName: string }
  | { type: 'ROTATE_SPACE_PASSWORD'; oldPassword: string; newPassword: string }
  | { type: 'DELETE_LOCAL_SPACE'; spaceId: string; deleteRemote?: boolean }
  | { type: 'GET_SITES_OVERVIEW' }
  | { type: 'SCAN_BROWSER_CANDIDATE_SITES' }
  | { type: 'ADD_MANAGED_SITES'; siteKeys: string[] }
  | { type: 'REMOVE_MANAGED_SITE'; siteKey: string; scope: 'device_unmanage' | 'space_remove' }
  | { type: 'SET_SPACE_AUTHORITY_POLICY'; authorityMode: SpaceAuthorityMode; primaryDeviceId?: string }
  | { type: 'UPSERT_DEVICE_POLICY'; policy: PerDeviceSyncPolicy }
  | { type: 'REMOVE_DEVICE_POLICY'; deviceId: string }
  | { type: 'DISMISS_LATEST_ERROR' }
  | { type: 'DISMISS_ATTENTION_ITEM'; itemId: string }
  | { type: 'RETRY_FAILED_COOKIES'; siteKey?: string }
  | { type: 'FORCE_RELOAD_TAB'; tabId: number }
  | { type: 'GET_PENDING_DECISIONS' }
  | { type: 'RESOLVE_SITE_DECISION'; siteKey: string; action: SiteDecisionAction }
  | { type: 'RESOLVE_BATCH_DECISIONS'; siteKeys: string[]; action: SiteDecisionAction }
  | { type: 'SWITCH_SITE_TRACK'; siteKey: string; targetTrackId: string }
  | { type: 'SPLIT_SITE_INDEPENDENT'; siteKey: string; customLabel?: string }
  | { type: 'RENAME_SITE_TRACK'; siteKey: string; trackId: string; label: string }
  | { type: 'UPDATE_SITE_TRACK'; siteKey: string; trackId: string; patch: UpdateSiteTrackPatch }
  | { type: 'REORDER_SITE_TRACKS'; siteKey: string; orderedTrackIds: string[] }
  | { type: 'CREATE_SITE_ACCOUNT_TRACK'; siteKey: string; options: CreateSiteAccountOptions }
  | { type: 'ROTATE_SITE_TRACK'; siteKey: string; direction?: 'next' | 'prev' }
  | { type: 'DELETE_SITE_TRACK'; siteKey: string; trackId: string }
  | { type: 'GET_SITE_COOKIES'; siteKey: string; trackId?: string }
  | { type: 'UPSERT_COOKIE'; siteKey: string; cookie: BrowserCookieInput; trackId?: string }
  | { type: 'APPLY_COOKIE_TO_BROWSER'; logicalId: string }
  | { type: 'DELETE_COOKIES'; logicalIds: string[]; siteKey?: string; scope: DeleteScope }
  | { type: 'IMPORT_COOKIES_JSON'; siteKey?: string; trackId?: string; cookies: BrowserCookieInput[] }
  | { type: 'EXPORT_COOKIES_JSON'; siteKey?: string; trackId?: string }
  | { type: 'EXPORT_DEBUG_STATE'; request: DebugExportRequest }
  | { type: 'TOGGLE_WATCHED_COOKIE'; siteKey: string; cookieName: string; watched: boolean }
  | { type: 'CREATE_SESSION_SHARE'; request: CreateSessionShareRequest }
  | { type: 'PREVIEW_SESSION_SHARE'; code: string; passphrase: string }
  | { type: 'IMPORT_SESSION_SHARE'; request: ImportSessionShareRequest }
  | { type: 'GET_LOCAL_STORAGE_RECORDS'; siteKey?: string; origin?: string; trackId?: string }
  | { type: 'UPSERT_LOCAL_STORAGE_ITEM'; origin: string; key: string; value: string; trackId?: string }
  | { type: 'APPLY_LOCAL_STORAGE_ITEM'; logicalId: string }
  | { type: 'DELETE_LOCAL_STORAGE_ITEMS'; logicalIds: string[]; scope: DeleteScope }
  | { type: 'GET_SESSION_STORAGE_RECORDS'; siteKey?: string; origin?: string; trackId?: string }
  | { type: 'UPSERT_SESSION_STORAGE_ITEM'; origin: string; key: string; value: string; trackId?: string }
  | { type: 'APPLY_SESSION_STORAGE_ITEM'; logicalId: string }
  | { type: 'DELETE_SESSION_STORAGE_ITEMS'; logicalIds: string[]; scope: DeleteScope }
  | { type: 'INSPECT_PAGE_INDEXED_DB'; origin: string }
  | { type: 'GET_INDEXED_DB_RECORDS'; siteKey?: string; origin?: string; trackId?: string; dbName?: string }
  | { type: 'APPLY_INDEXED_DB_RECORD'; logicalId: string }
  | { type: 'DELETE_INDEXED_DB_RECORDS'; logicalIds: string[]; scope: DeleteScope }
  | { type: 'CAPTURE_PAGE_EXTENDED_STORAGE_NOW'; origin: string }
  | { type: 'GET_RULES_AND_BLACKLIST' }
  | { type: 'ADD_BLACKLIST_ENTRY'; entry: Omit<BlacklistEntry, 'id' | 'createdAt'> }
  | { type: 'REMOVE_BLACKLIST_ENTRY'; id: string; scope: 'space' | 'device' }
  | { type: 'UPSERT_SITE_RULE'; rule: SiteRuleOverride }
  | { type: 'REMOVE_SITE_RULE'; siteKey: string }
  | { type: 'UPSERT_SSO_GROUP'; group: SsoDomainGroup }
  | { type: 'REMOVE_SSO_GROUP'; groupId: string }
  | {
      type: 'UPSERT_ENV_SYNC_RULE';
      rule: Omit<EnvCookieSyncRule, 'id' | 'name' | 'createdAt' | 'updatedAt'> & {
        id?: string;
        name?: string;
      };
    }
  | { type: 'REMOVE_ENV_SYNC_RULE'; ruleId: string; scope?: 'space' | 'device' }
  | { type: 'EXECUTE_ENV_SYNC'; input: ExecuteEnvSyncInput }
  | { type: 'IMPORT_RULES_JSON'; payload: SyncRuleUpdatePayload }
  | { type: 'EXPORT_RULES_JSON' }
  | { type: 'GET_DEVICES' }
  | { type: 'RENAME_DEVICE'; deviceId: string; name: string }
  | { type: 'SET_DEVICE_STATE'; deviceId: string; state: 'active' | 'paused' | 'removed' | 'revoked' }
  | { type: 'GET_HISTORY_AND_LOGS'; siteKey?: string; objectId?: string; limit?: number }
  | { type: 'RESTORE_HISTORICAL_EVENT'; eventId: string }
  | { type: 'GET_CONFLICTS' }
  | { type: 'RESOLVE_CONFLICT'; conflictId: string; choose: 'local' | 'remote' }
  | { type: 'GET_UNDO_POINTS' }
  | { type: 'APPLY_UNDO_POINT'; undoId: string }
  | { type: 'WEBDAV_LIST_DIR'; subPath?: string }
  | { type: 'WEBDAV_CHECK_INTEGRITY' }
  | { type: 'WEBDAV_REBUILD_INDEX' }
  | { type: 'WEBDAV_CREATE_SNAPSHOT' }
  | { type: 'WEBDAV_GARBAGE_COLLECT' }
  | { type: 'WEBDAV_CREATE_BACKUP' }
  | { type: 'WEBDAV_LIST_BACKUPS' }
  | { type: 'WEBDAV_RESTORE_BACKUP'; backupId: string }
  | { type: 'EXPORT_ARCHIVE_BACKUP'; passphrase?: string }
  | {
      type: 'IMPORT_ARCHIVE_BACKUP';
      base64: string;
      passphrase?: string;
      mode: ImportArchiveBackupMode;
    }
  | {
      type: 'CONTENT_LOCAL_STORAGE_CHANGED';
      origin: string;
      changes: Array<{ key: string; value?: string; deleted?: boolean }>;
    }
  | {
      type: 'CONTENT_SESSION_STORAGE_CHANGED';
      origin: string;
      changes: Array<{ key: string; value?: string; deleted?: boolean }>;
    }
  | {
      type: 'CONTENT_INDEXED_DB_CHANGED';
      origin: string;
    }
  | {
      type: 'CONTENT_PAGE_MOUNTED';
      origin: string;
      items: Record<string, string>;
      sessionItems?: Record<string, string>;
    }
  | {
      type: 'CONTENT_PAGE_LEAVING';
      origin: string;
      changes: Array<{ key: string; value?: string; deleted?: boolean }>;
      sessionChanges?: Array<{ key: string; value?: string; deleted?: boolean }>;
    };

export type ContentScriptCommand =
  | { type: 'CS_GET_LOCAL_STORAGE'; origin: string }
  | {
      type: 'CS_APPLY_LOCAL_STORAGE';
      origin: string;
      mutations: Array<{ key: string; value?: string; deleted?: boolean }>;
    }
  | { type: 'CS_GET_SESSION_STORAGE'; origin: string }
  | {
      type: 'CS_APPLY_SESSION_STORAGE';
      origin: string;
      mutations: Array<{ key: string; value?: string; deleted?: boolean }>;
    }
  | { type: 'CS_INSPECT_INDEXED_DB'; origin: string }
  | {
      type: 'CS_GET_INDEXED_DB_RECORDS';
      origin: string;
      targets: IndexedDbTargetRule[];
      maxTotalBytes?: number;
    }
  | {
      type: 'CS_APPLY_INDEXED_DB_MUTATIONS';
      origin: string;
      mutations: IndexedDbMutation[];
      clearStores?: Array<{ dbName: string; storeName: string }>;
    }
  | {
      type: 'CS_CONFIGURE_EXTENDED_MONITORS';
      origin: string;
      syncSessionStorage: boolean;
      sessionStorageKeyAllowlist?: string[];
      syncIndexedDb: boolean;
      indexedDbTargets?: IndexedDbTargetRule[];
      indexedDbMaxTotalBytes?: number;
    }
  | { type: 'CS_SHOW_ACCOUNT_TOAST'; payload: AccountSwitchToastPayload }
  | { type: 'CS_COPY_TEXT_TO_CLIPBOARD'; text: string; toastMessage?: string }
  | { type: 'CS_CHECK_PAGE_SAFE_TO_RELOAD' };

export interface SessionMeshResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    phase?: string;
    message: string;
    suggestion?: string;
  };
}

export type {
  AccountCreateMode,
  AccountRotationResult,
  AccountSwitchToastPayload,
  AttentionItem,
  AttentionItemKind,
  BlacklistEntry,
  BrowserCandidateSite,
  BrowserCookieInput,
  CapabilityReport,
  ConflictRecord,
  ContentPageMountConfig,
  CookieExpiryWarningSettings,
  CookieRecord,
  CreateSessionShareRequest,
  CreateSessionShareResult,
  CreateSiteAccountOptions,
  DebugExportFormat,
  DebugExportRequest,
  DebugExportResult,
  DeleteScope,
  Device,
  EnvCookieSyncResult,
  EnvCookieSyncRule,
  ExecuteEnvSyncInput,
  ExpiryHealthStatus,
  GitHubGistStorageConfig,
  ImportArchiveBackupMode,
  ImportArchiveBackupResult,
  ImportSessionShareRequest,
  ImportSessionShareResult,
  IndexedDbMutation,
  IndexedDbRecord,
  IndexedDbTargetRule,
  InitialJoinReport,
  InspectedIndexedDbDatabase,
  InspectedIndexedDbStore,
  IntegrityReport,
  LocalDirectoryStorageConfig,
  LocalStorageRecord,
  LogEntry,
  PageReloadSafetyStatus,
  PendingSiteDecision,
  PerDeviceSyncPolicy,
  RemoteObjectStat,
  RemoteSpacePasswordVerifyResult,
  RemoteSpaceProbeItem,
  S3StorageConfig,
  S3VendorPreset,
  SafetyUndoPoint,
  SanitizedStorageProviderConfig,
  SessionShareImportMode,
  SessionSharePayload,
  SessionSharePreview,
  SessionStorageRecord,
  SiteDecisionAction,
  SiteExpiryHealth,
  SiteRuleOverride,
  SiteSummaryView,
  SpaceAuthorityMode,
  SpaceSettings,
  SsoDomainGroup,
  StorageProviderConfig,
  StorageProviderType,
  SyncEvent,
  SyncRecord,
  SyncStatusSummary,
  ToolbarBadgeDisplayMode,
  UpdateSiteTrackPatch,
  WebDAVConfig,
  WebDAVResourceStat,
};
