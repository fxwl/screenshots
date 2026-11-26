import {
  base64ToBytes,
  bytesToHex,
  decodePairingCode as cryptoDecodePairingCode,
  decryptWithDek,
  decryptWithPassword,
  deriveOpaqueId,
  encodePairingCode as cryptoEncodePairingCode,
  encryptWithDek,
  encryptWithPassword,
  generateRandomBytes,
  generateSpaceDekBase64,
  isSmesEnvelope,
  parseSmesHeader,
  sha256Hex,
} from '../crypto';
import { bytesToUtf8, utf8ToBytes } from '../crypto/encoding';
import { DiagnosticLogger, toStructuredError } from '../diagnostics';
import { domainMatchesSiteKey, isAnalyticsNoiseCookie, normalizeDomain, resolveSiteKey } from '../psl';
import { AutoRefreshController } from '../refresh';
import { buildPresetBlacklistEntries, RulesEngine } from '../rules';
import {
  DEFAULT_SPACE_SETTINGS,
  type AccountRotationResult,
  type ApplyVerificationResult,
  type AttentionItem,
  type BlacklistEntry,
  type BrowserApiAdapter,
  type BrowserCandidateSite,
  type BrowserCookieInput,
  type CapabilityReport,
  type ConflictRecord,
  type ConsistencyLevel,
  type CookieRecord,
  type CreateSiteAccountOptions,
  type DeleteScope,
  type Device,
  type DeviceCheckpoint,
  type DeviceSiteBinding,
  type DeviceStatus,
  type EnvCookieSyncResult,
  type EnvCookieSyncRule,
  type EventBatch,
  type ExecuteEnvSyncInput,
  type HybridLogicalClock,
  type InitialJoinReport,
  type IntegrityReport,
  type LocalStorageRecord,
  type LogEntry,
  type PairingPayload,
  type PendingSiteDecision,
  type PerDeviceSyncPolicy,
  type RemoteSpacePasswordVerifyResult,
  type RemoteSpaceProbeItem,
  type SafetyUndoPoint,
  type SiteDecisionAction,
  type SiteRuleOverride,
  type SiteSummaryView,
  type SiteTrack,
  type SnapshotPayload,
  type SpaceAuthorityMode,
  type SpaceDescriptorPayload,
  type SpaceRuleSet,
  type SpaceSettings,
  type SsoDomainGroup,
  type StorageBackend,
  type UpdateSiteTrackPatch,
  type StructuredError,
  type SyncDirection,
  type SyncEvent,
  type SyncSpace,
  type SyncStatusSummary,
  type SyncTask,
  type SyncTimingMode,
  type Tombstone,
  type TombstoneReason,
  type VectorClock,
  type WebDAVConfig,
  type WebDAVResourceStat,
} from '../types';
import {
  applyUserSiteDecision,
  buildCookieLogicalId,
  buildLocalStorageLogicalId,
  compareVectorClocks,
  createNextCausalVersion,
  evaluateSiteDiscovery,
  HlcClock,
  incrementVectorClock,
  mergeVectorClocks,
  normalizeCookieStoreScope,
  resolveAutomaticSiteDecisionAction,
  resolveItemMerge,
  updateTombstoneReclaimability,
} from '../version';
import {
  normalizeEtag,
  WebDAVCapabilityDetector,
  WebDAVClient,
  type WebDAVClientOptions,
} from '../webdav';
import { ChangeDetector, type CoalescedCookieChange } from './ChangeDetector';
import {
  applyCookieWithVerification,
  buildCookieUrl,
  cookieContentCanonicalHash,
  findExactBrowserCookie,
  matchesCookieIdentity,
  normalizeCookieDomain,
  resolveEffectiveHostOnly,
} from './CookieApplyHelper';
import { buildEchoCookieKey, EchoSuppressor } from './EchoSuppressor';
import {
  envRuleMatchesUrl,
  isLocalOrSingleLabelHost,
  parseEnvTarget,
  selectAndMapEnvCookies,
  type ParsedEnvTarget,
  type SourceCookieCandidate,
} from './EnvCookieMapper';
import {
  backupFilePath,
  backupsDir,
  buildFileAad,
  buildSpaceMetaAad,
  checkpointFilePath,
  checkpointsDir,
  deviceEventsDir,
  deviceFilePath,
  devicesDir,
  eventBatchPath,
  eventsDir,
  parseEventFilenameSeq,
  snapshotFilePath,
  snapshotsDir,
  spaceBasePath,
  spaceInfoPath,
  spaceMetaDir,
  spaceMetaPath,
  spacesRootDir,
} from './RemotePaths';
import { RollingTokenDamper } from './RollingTokenDamper';

const GLOBAL_NS = 'global';
const CURRENT_SCHEMA_VERSION = 2;
const MAX_HISTORY_EVENTS = 2000;
const MAX_UNDO_POINTS = 20;
const OPAQUE_SPACE_ID_RE = /^sp_[a-f0-9]{16,64}$/i;

function isBlockedWebdavSelfTarget(webdavUrl: string, parsedTarget: ParsedEnvTarget): boolean {
  const parsedWebdav = parseEnvTarget(webdavUrl);
  if (!parsedWebdav) return false;
  if (parsedTarget.host !== parsedWebdav.host) return false;
  if (
    isLocalOrSingleLabelHost(parsedWebdav.host) &&
    parsedWebdav.port &&
    parsedTarget.port &&
    parsedWebdav.port !== parsedTarget.port
  ) {
    return false;
  }
  return true;
}

function sanitizeShortLabel(raw: string | undefined, maxLen = 80): string {
  if (!raw) return '';
  // Strip ASCII control characters (newlines, tabs, NUL, etc.) and collapse whitespace
  const cleaned = raw
    .split('')
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

interface GlobalDeviceIdentity {
  deviceId: string;
  instanceNonce: string;
  defaultName: string;
  createdAt: number;
}

interface LocalSpaceIndexEntry {
  spaceId: string;
  opaqueId: string;
  name: string;
  webdav: WebDAVConfig;
  status: DeviceStatus;
  consistencyLevel?: ConsistencyLevel;
  keyEpoch: number;
  dekKeyring?: Record<number, string>;
  deviceName: string;
  createdAt: number;
  updatedAt: number;
}

interface DeviceOverrideEntry {
  name?: string;
  state?: Device['state'];
  updatedAt: number;
}

interface RemoteDeviceManifest {
  device: Device;
  tracks: Record<string, SiteTrack>;
  removedTracks?: Record<string, number>;
  rulesDelta?: SpaceRuleSet;
  settingsDelta?: { settings: SpaceSettings; updatedAt: number };
  deviceOverrides?: Record<string, DeviceOverrideEntry>;
  instanceNonce: string;
  stateDigest: string;
  updatedAt: number;
}

interface PersistedSpaceMeta {
  space: SyncSpace;
  rules: SpaceRuleSet;
  deviceBlacklist: BlacklistEntry[];
  deviceEnvSyncRules?: EnvCookieSyncRule[];
  spaceMetaEtag?: string;
  globalPaused: boolean;
  lastSyncAt?: number;
  lastLatencyMs?: number;
  latestError?: StructuredError | null;
  storageFullHalted?: boolean;
  localDevice: Device;
  remoteDevices: Record<string, Device>;
  deviceOverrides: Record<string, DeviceOverrideEntry>;
  removedTracks?: Record<string, number>;
  peerDeviceEtags: Record<string, string>;
  processedEventPaths: Record<string, true>;
  corruptedPaths: string[];
  dismissedCorruptedPaths?: Record<string, true>;
  dismissedApplyFailures?: Record<string, string>;
  lastSnapshotId?: string;
  lastPushedDeviceSeq?: number;
  manifestDirty?: boolean;
  lastAutoPushAt?: number;
  autoPushBackoffUntilMs?: number;
  consecutiveTransientFailures?: number;
  appliedCookieHashes: Record<string, string>;
  appliedLsHashes: Record<string, string>;
  pendingCleanLsBySite?: Record<string, { trackId: string; clearedOrigins: string[] }>;
  pendingEnvLsByOrigin?: Record<
    string,
    {
      items: Record<string, string>;
      cleanTargetBeforeSync: boolean;
      excludeKeys: string[];
      autoReloadTarget: boolean;
    }
  >;
}

interface LoadedSpaceRuntime {
  spaceId: string;
  webdav: WebDAVConfig;
  client: WebDAVClient;
  meta: PersistedSpaceMeta;
  tracks: Record<string, SiteTrack>;
  pendingDecisions: Record<string, PendingSiteDecision>;
  cookies: Record<string, CookieRecord>;
  localStorage: Record<string, LocalStorageRecord>;
  tombstones: Record<string, Tombstone>;
  pendingOutboundEvents: SyncEvent[];
  retryTasks: SyncTask[];
  eventsHistory: SyncEvent[];
  conflicts: Record<string, ConflictRecord>;
  undoPoints: SafetyUndoPoint[];
  hlcClock: HlcClock;
  rulesEngine: RulesEngine;
  dekKeyring: Record<number, string>;
  encryptionPassword?: string;
}

export interface SyncEngineOptions {
  storage: StorageBackend;
  browser: BrowserApiAdapter;
  webdavClientOptions?: WebDAVClientOptions;
  debounceMs?: number;
  refreshCoalesceMs?: number;
  pbkdf2Iterations?: number;
  /** Minimum interval (ms) between background auto-pushes to prevent WebDAV rate-limiting (503/429). Default 0 for tests. */
  autoPushCooldownMs?: number;
  /** Number of consecutive transient server/network failures before surfacing a user warning. Default 3. */
  transientErrorAlertThreshold?: number;
  /** Default upload timing mode when space settings have not explicitly set `syncTimingMode`. Default 'realtime' for tests; extension uses 'on_page_leave'. */
  defaultSyncTimingMode?: SyncTimingMode;
  /** Max auto-reloads allowed per site per reloadWindowMs. Default 2 for tests; extension uses 1. */
  maxReloadsPerWindow?: number;
  /** Rolling window (ms) for AutoRefreshController loop guard. Default 30_000 for tests; extension uses 120_000. */
  reloadWindowMs?: number;
  keyVault?: {
    saveDek(spaceId: string, dekBase64: string): Promise<void>;
    loadDek(spaceId: string): Promise<string | null>;
    clearDek(spaceId: string): Promise<void>;
  };
  onStateChange?: () => void;
}

function spaceNs(spaceId: string): string {
  return `space:${spaceId}`;
}

function randomId(prefix: string): string {
  return `${prefix}_${bytesToHex(generateRandomBytes(8))}`;
}

function extractFilename(pathOrHref: string): string {
  const clean = pathOrHref.replace(/\/+$/, '');
  const idx = clean.lastIndexOf('/');
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

function defaultSpaceRules(nowMs: number): SpaceRuleSet {
  return {
    spaceBlacklist: [],
    siteOverrides: {},
    ssoGroups: [],
    envSyncRules: [],
    updatedAt: nowMs,
  };
}

function sortSiteTracks(tracks: SiteTrack[]): SiteTrack[] {
  return [...tracks].sort((a, b) => {
    const ao = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const bo = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    const oCmp = a.originDeviceId.localeCompare(b.originDeviceId);
    if (oCmp !== 0) return oCmp;
    return a.trackId.localeCompare(b.trackId);
  });
}

function normalizeOriginSafe(originOrUrl: string): string | null {
  try {
    const u = new URL(originOrUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

function formatApplyFailureReason(reason?: string): string {
  if (!reason) return '浏览器安全策略拒绝写入该 Cookie';
  if (reason === 'Cookie is already expired') return 'Cookie 已过期';
  if (reason === 'Invalid empty cookie domain') return 'Cookie 域名为空或无效';
  if (reason === 'browser.setCookie returned null') return '浏览器安全策略拒绝写入该 Cookie 属性';
  if (reason.startsWith('Read-back verification failed: cookie not found')) {
    return '写入后回读校验未找到该 Cookie（受浏览器隐私或前缀策略拦截）';
  }
  if (reason.startsWith('Read-back verification failed: stored cookie value differs')) {
    return '写入后浏览器实际存储值与预期不一致';
  }
  if (reason.startsWith('Read-back verification failed:')) {
    return `写入后属性回读校验未通过（${reason.replace('Read-back verification failed: ', '')}）`;
  }
  return reason;
}

function formatDeferredReloadReasons(reasons: string[]): string {
  if (!reasons || reasons.length === 0) return '页面存在未保存输入或活跃交互';
  const mapped = reasons.map((r) => {
    if (r === 'dirty_form_input' || r === 'dirty_input' || r === 'unsaved_form_input') {
      return '表单有未保存输入';
    }
    if (r === 'unsaved_contenteditable') return '富文本编辑区有未保存内容';
    if (r === 'focused_editable' || r === 'active_input_focus') return '正在编辑输入框';
    if (r === 'active_contenteditable_focus') return '正在编辑富文本区域';
    if (r === 'ime_composing') return '正在使用输入法候选输入';
    if (r === 'file_selected' || r === 'pending_file_upload') return '已选择待上传文件';
    if (r === 'beforeunload_registered') return '页面开启了离开保护';
    if (r === 'safety_probe_unavailable' || r === 'probe_unreachable') {
      return '页面安全检测暂不可达';
    }
    if (r === 'unsaved_or_active_interaction') return '页面有活跃交互';
    return r;
  });
  return Array.from(new Set(mapped)).join('、');
}

export class SyncEngine {
  private readonly storage: StorageBackend;
  private readonly browser: BrowserApiAdapter;
  private readonly webdavClientOptions?: WebDAVClientOptions;
  private readonly debounceMs: number;
  private readonly refreshCoalesceMs: number;
  private readonly pbkdf2Iterations: number;
  private readonly autoPushCooldownMs: number;
  private readonly transientErrorAlertThreshold: number;
  private readonly defaultSyncTimingMode: SyncTimingMode;
  private readonly keyVault?: SyncEngineOptions['keyVault'];
  private readonly onStateChange?: () => void;

  private readonly logger: DiagnosticLogger;
  private readonly echoSuppressor: EchoSuppressor;
  private readonly rollingTokenDamper: RollingTokenDamper;
  private readonly changeDetector: ChangeDetector;
  private readonly autoRefresh: AutoRefreshController;

  private identity!: GlobalDeviceIdentity;
  private spaceIndex: Record<string, LocalSpaceIndexEntry> = {};
  private activeSpaceId: string | null = null;
  private runtime: LoadedSpaceRuntime | null = null;

  private unsubscribeCookies: (() => void) | null = null;
  private initialized = false;
  private syncChain: Promise<unknown> = Promise.resolve();
  private autoPushAttemptCount = 0;
  private lastAnySiteVisitPullAt = 0;
  private readonly lastSiteVisitPullAt = new Map<string, number>();
  private readonly deferredOnPageLeaveSites = new Set<string>();
  private readonly releasedOnPageLeaveSites = new Set<string>();
  private readonly postReloadPushMuteUntil = new Map<string, number>();
  private readonly postTrackSwitchLeaveMuteUntil = new Map<string, number>();
  private inAutoEnvSync = false;

  constructor(options: SyncEngineOptions) {
    this.storage = options.storage;
    this.browser = options.browser;
    this.webdavClientOptions = options.webdavClientOptions;
    this.debounceMs = options.debounceMs ?? 1500;
    this.refreshCoalesceMs = options.refreshCoalesceMs ?? 800;
    this.pbkdf2Iterations = options.pbkdf2Iterations ?? 200_000;
    this.autoPushCooldownMs = Math.max(0, options.autoPushCooldownMs ?? 0);
    this.transientErrorAlertThreshold = Math.max(1, options.transientErrorAlertThreshold ?? 3);
    this.defaultSyncTimingMode = options.defaultSyncTimingMode ?? 'realtime';
    this.keyVault = options.keyVault;
    this.onStateChange = options.onStateChange;

    this.logger = new DiagnosticLogger(this.storage, 500);
    this.echoSuppressor = new EchoSuppressor();
    this.rollingTokenDamper = new RollingTokenDamper();
    this.changeDetector = new ChangeDetector({
      browser: this.browser,
      echoSuppressor: this.echoSuppressor,
      debounceMs: this.debounceMs,
      onFlushedChanges: async (changes) => {
        await this.enqueueOp(() => this.handleFlushedCookieChanges(changes));
      },
    });
    this.autoRefresh = new AutoRefreshController(this.browser, {
      coalesceMs: this.refreshCoalesceMs,
      maxReloadsPerWindow: options.maxReloadsPerWindow ?? 2,
      windowMs: options.reloadWindowMs ?? 30_000,
      getSsoGroups: () => this.runtime?.meta.rules.ssoGroups ?? [],
      onChange: () => this.emitStateChange(),
    });
  }

  private now(): number {
    return this.browser.now ? this.browser.now() : Date.now();
  }

  private isOnline(): boolean {
    return this.browser.isOnline ? this.browser.isOnline() : true;
  }

  private emitStateChange(): void {
    try {
      this.onStateChange?.();
    } catch {
      // Never let UI listener errors break engine operations
    }
  }

  private enqueueOp<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.syncChain.then(fn, fn);
    this.syncChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  getAutoRefreshController(): AutoRefreshController {
    return this.autoRefresh;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    await this.migrateStorageIfNeeded();

    const storedIdentity = await this.storage.get<GlobalDeviceIdentity>(GLOBAL_NS, 'deviceIdentity');
    if (storedIdentity && storedIdentity.deviceId) {
      this.identity = {
        ...storedIdentity,
        instanceNonce: storedIdentity.instanceNonce || randomId('inst'),
      };
    } else {
      const platform = await this.browser.getDevicePlatformInfo();
      this.identity = {
        deviceId: randomId('dev'),
        instanceNonce: randomId('inst'),
        defaultName: `${platform.platform} ${platform.browser}`.trim() || 'Edge Device',
        createdAt: this.now(),
      };
      await this.storage.set(GLOBAL_NS, 'deviceIdentity', this.identity);
    }

    this.spaceIndex =
      (await this.storage.get<Record<string, LocalSpaceIndexEntry>>(GLOBAL_NS, 'spaceIndex')) ?? {};
    this.activeSpaceId =
      (await this.storage.get<string | null>(GLOBAL_NS, 'activeSpaceId')) ?? null;

    if (this.activeSpaceId && this.spaceIndex[this.activeSpaceId]) {
      await this.loadSpaceRuntime(this.activeSpaceId);
    } else {
      this.activeSpaceId = null;
      this.runtime = null;
    }

    this.unsubscribeCookies = this.browser.onCookieChanged((event) => {
      if (!this.runtime) return;
      this.changeDetector.handleCookieChange(event);
    });

    this.initialized = true;
    this.emitStateChange();
  }

  dispose(): void {
    if (this.unsubscribeCookies) {
      this.unsubscribeCookies();
      this.unsubscribeCookies = null;
    }
    this.changeDetector.dispose();
    this.autoRefresh.dispose();
    this.initialized = false;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }

  /**
   * D-017: Storage schema migration (upgrades legacy persisted records in place without data loss).
   */
  private async migrateStorageIfNeeded(): Promise<void> {
    const version = (await this.storage.get<number>(GLOBAL_NS, 'schemaVersion')) ?? 0;
    if (version >= CURRENT_SCHEMA_VERSION) return;

    const index =
      (await this.storage.get<Record<string, LocalSpaceIndexEntry>>(GLOBAL_NS, 'spaceIndex')) ?? {};

    for (const spaceId of Object.keys(index)) {
      const ns = spaceNs(spaceId);
      const meta = await this.storage.get<Partial<PersistedSpaceMeta>>(ns, 'meta');
      if (meta && meta.space) {
        meta.space.settings = {
          ...DEFAULT_SPACE_SETTINGS,
          ...(meta.space.settings ?? {}),
        };
        meta.space.schemaVersion = CURRENT_SCHEMA_VERSION;
        meta.rules = {
          spaceBlacklist: meta.rules?.spaceBlacklist ?? [],
          siteOverrides: meta.rules?.siteOverrides ?? {},
          ssoGroups: meta.rules?.ssoGroups ?? [],
          envSyncRules: meta.rules?.envSyncRules ?? [],
          updatedAt: meta.rules?.updatedAt ?? this.now(),
        };
        meta.deviceBlacklist = meta.deviceBlacklist ?? [];
        meta.deviceEnvSyncRules = meta.deviceEnvSyncRules ?? [];
        meta.deviceOverrides = meta.deviceOverrides ?? {};
        meta.removedTracks = meta.removedTracks ?? {};
        meta.peerDeviceEtags = meta.peerDeviceEtags ?? {};
        meta.processedEventPaths = meta.processedEventPaths ?? {};
        meta.corruptedPaths = meta.corruptedPaths ?? [];
        meta.appliedCookieHashes = meta.appliedCookieHashes ?? {};
        meta.appliedLsHashes = meta.appliedLsHashes ?? {};
        meta.pendingCleanLsBySite = meta.pendingCleanLsBySite ?? {};
        meta.pendingEnvLsByOrigin = meta.pendingEnvLsByOrigin ?? {};
        await this.storage.set(ns, 'meta', meta);
      }

      // Migrate legacy cookies missing storeScope / trackId
      const cookies = (await this.storage.get<Record<string, CookieRecord>>(ns, 'cookies')) ?? {};
      let cookiesChanged = false;
      for (const [key, rec] of Object.entries(cookies)) {
        if (!rec.storeScope) {
          rec.storeScope = 'default';
          cookiesChanged = true;
        }
        if (!rec.trackId) {
          rec.trackId = `track_migrated_${rec.siteKey}`;
          cookiesChanged = true;
        }
        cookies[key] = rec;
      }
      if (cookiesChanged) {
        await this.storage.set(ns, 'cookies', cookies);
      }

      // Ensure optional collections exist
      const defaults: Array<[string, unknown]> = [
        ['tracks', {}],
        ['pendingDecisions', {}],
        ['localStorage', {}],
        ['tombstones', {}],
        ['pendingOutboundEvents', []],
        ['retryTasks', []],
        ['eventsHistory', []],
        ['conflicts', {}],
        ['undoPoints', []],
      ];
      for (const [k, def] of defaults) {
        const existing = await this.storage.get(ns, k);
        if (existing === undefined) {
          await this.storage.set(ns, k, def);
        }
      }
    }

    await this.storage.set(GLOBAL_NS, 'schemaVersion', CURRENT_SCHEMA_VERSION);
    if (version > 0 || Object.keys(index).length > 0) {
      await this.logger.log({
        level: 'info',
        phase: 'migration',
        message: `Storage schema migrated from v${version} to v${CURRENT_SCHEMA_VERSION}`,
        timestamp: this.now(),
      });
    }
  }

  private registerConfigSecrets(webdav: WebDAVConfig, password?: string): void {
    this.logger.registerSecret(webdav.password);
    this.logger.registerSecret(webdav.bearerToken);
    this.logger.registerSecret(password);
  }

  private async loadSpaceRuntime(spaceId: string, encryptionPassword?: string): Promise<LoadedSpaceRuntime> {
    const entry = this.spaceIndex[spaceId];
    if (!entry) {
      throw new Error(`Space not found: ${spaceId}`);
    }

    this.registerConfigSecrets(entry.webdav, encryptionPassword);

    const ns = spaceNs(spaceId);
    const meta = await this.storage.get<PersistedSpaceMeta>(ns, 'meta');
    if (!meta) {
      throw new Error(`Space metadata missing for space: ${spaceId}`);
    }

    meta.space.settings = {
      ...DEFAULT_SPACE_SETTINGS,
      ...meta.space.settings,
      devicePolicies: { ...(meta.space.settings?.devicePolicies ?? {}) },
    };
    meta.rules = {
      spaceBlacklist: meta.rules?.spaceBlacklist ?? [],
      siteOverrides: meta.rules?.siteOverrides ?? {},
      ssoGroups: meta.rules?.ssoGroups ?? [],
      envSyncRules: meta.rules?.envSyncRules ?? [],
      updatedAt: meta.rules?.updatedAt ?? this.now(),
    };
    meta.deviceEnvSyncRules = meta.deviceEnvSyncRules ?? [];
    meta.deviceOverrides = meta.deviceOverrides ?? {};
    meta.removedTracks = meta.removedTracks ?? {};
    meta.dismissedCorruptedPaths = meta.dismissedCorruptedPaths ?? {};
    meta.dismissedApplyFailures = meta.dismissedApplyFailures ?? {};
    meta.appliedCookieHashes = meta.appliedCookieHashes ?? {};
    meta.appliedLsHashes = meta.appliedLsHashes ?? {};
    meta.pendingCleanLsBySite = meta.pendingCleanLsBySite ?? {};
    meta.pendingEnvLsByOrigin = meta.pendingEnvLsByOrigin ?? {};

    const tracks = (await this.storage.get<Record<string, SiteTrack>>(ns, 'tracks')) ?? {};
    const pendingDecisions =
      (await this.storage.get<Record<string, PendingSiteDecision>>(ns, 'pendingDecisions')) ?? {};
    const cookies = (await this.storage.get<Record<string, CookieRecord>>(ns, 'cookies')) ?? {};
    const nowSec = this.now() / 1000;
    for (const rec of Object.values(cookies)) {
      if (
        !rec.deleted &&
        rec.syncStatus === 'APPLY_FAILED' &&
        !rec.session &&
        rec.expirationDate !== undefined &&
        rec.expirationDate <= nowSec
      ) {
        rec.syncStatus = 'EXPIRED';
      }
    }
    const localStorage =
      (await this.storage.get<Record<string, LocalStorageRecord>>(ns, 'localStorage')) ?? {};
    const tombstones = (await this.storage.get<Record<string, Tombstone>>(ns, 'tombstones')) ?? {};
    const pendingOutboundEvents =
      (await this.storage.get<SyncEvent[]>(ns, 'pendingOutboundEvents')) ?? [];
    const retryTasks = (await this.storage.get<SyncTask[]>(ns, 'retryTasks')) ?? [];
    const eventsHistory = (await this.storage.get<SyncEvent[]>(ns, 'eventsHistory')) ?? [];
    const conflicts = (await this.storage.get<Record<string, ConflictRecord>>(ns, 'conflicts')) ?? {};
    const undoPoints = (await this.storage.get<SafetyUndoPoint[]>(ns, 'undoPoints')) ?? [];
    const storedHlc = await this.storage.get<HybridLogicalClock>(ns, 'hlc');

    const dekKeyring: Record<number, string> = {};
    if (!meta.space.settings.sessionLockEnabled) {
      if (entry.dekKeyring) {
        Object.assign(dekKeyring, entry.dekKeyring);
      }
      if (this.keyVault) {
        const vaultDek = await this.keyVault.loadDek(spaceId);
        if (vaultDek) {
          dekKeyring[meta.space.keyEpoch] = vaultDek;
        }
      }
    }

    const client = new WebDAVClient(entry.webdav, this.webdavClientOptions);
    const rulesEngine = new RulesEngine(
      meta.space.settings,
      meta.rules,
      meta.deviceBlacklist,
      meta.deviceEnvSyncRules,
    );
    const hlcClock = new HlcClock(meta.localDevice.deviceId, storedHlc);

    const hasDek = Boolean(dekKeyring[meta.space.keyEpoch]);
    if (!hasDek && !encryptionPassword) {
      meta.space.status = 'LOCKED';
    } else if (meta.globalPaused) {
      meta.space.status = 'PAUSED';
    }

    const rt: LoadedSpaceRuntime = {
      spaceId,
      webdav: entry.webdav,
      client,
      meta,
      tracks,
      pendingDecisions,
      cookies,
      localStorage,
      tombstones,
      pendingOutboundEvents: this.compactPendingOutboundEvents(pendingOutboundEvents),
      retryTasks,
      eventsHistory,
      conflicts,
      undoPoints,
      hlcClock,
      rulesEngine,
      dekKeyring,
      encryptionPassword,
    };

    this.runtime = rt;
    this.activeSpaceId = spaceId;
    return rt;
  }

  private async persistRuntime(rt: LoadedSpaceRuntime): Promise<void> {
    const ns = spaceNs(rt.spaceId);

    // Update device counters before persisting
    rt.meta.localDevice.pendingEvents = rt.pendingOutboundEvents.length;
    rt.meta.localDevice.failedEvents = rt.retryTasks.filter((t) => t.status === 'FAILED').length;

    await this.storage.set(ns, 'meta', rt.meta);
    await this.storage.set(ns, 'tracks', rt.tracks);
    await this.storage.set(ns, 'pendingDecisions', rt.pendingDecisions);
    await this.storage.set(ns, 'cookies', rt.cookies);
    await this.storage.set(ns, 'localStorage', rt.localStorage);
    await this.storage.set(ns, 'tombstones', rt.tombstones);
    await this.storage.set(ns, 'pendingOutboundEvents', rt.pendingOutboundEvents);
    await this.storage.set(ns, 'retryTasks', rt.retryTasks);
    await this.storage.set(ns, 'eventsHistory', rt.eventsHistory.slice(-MAX_HISTORY_EVENTS));
    await this.storage.set(ns, 'conflicts', rt.conflicts);
    await this.storage.set(ns, 'undoPoints', rt.undoPoints.slice(0, MAX_UNDO_POINTS));
    await this.storage.set(ns, 'hlc', rt.hlcClock.current());

    const entry = this.spaceIndex[rt.spaceId];
    if (entry) {
      entry.name = rt.meta.space.name;
      entry.status = rt.meta.space.status;
      entry.keyEpoch = rt.meta.space.keyEpoch;
      entry.updatedAt = this.now();
      entry.deviceName = rt.meta.localDevice.name;
      if (rt.meta.space.settings.sessionLockEnabled) {
        delete entry.dekKeyring;
      } else if (Object.keys(rt.dekKeyring).length > 0) {
        entry.dekKeyring = { ...rt.dekKeyring };
      }
      await this.storage.set(GLOBAL_NS, 'spaceIndex', this.spaceIndex);
    }

    await this.storage.set(GLOBAL_NS, 'activeSpaceId', this.activeSpaceId);
    this.emitStateChange();
  }

  private requireRuntime(): LoadedSpaceRuntime {
    if (!this.runtime) {
      throw new Error('No active sync space configured');
    }
    return this.runtime;
  }

  private requireUnlockedRuntime(): LoadedSpaceRuntime {
    const rt = this.requireRuntime();
    this.getCurrentDek(rt);
    return rt;
  }

  private async tryPushOutboundBestEffort(rt: LoadedSpaceRuntime, phase: string): Promise<void> {
    if (
      rt.meta.globalPaused ||
      !this.isOnline() ||
      rt.meta.storageFullHalted ||
      !rt.dekKeyring[rt.meta.space.keyEpoch]
    ) {
      return;
    }
    try {
      await this.pushOutboundInternal(rt);
    } catch (err) {
      const se = toStructuredError(err, phase);
      if (se.code === 'ERR_STORAGE_FULL' || se.status === 507) {
        rt.meta.storageFullHalted = true;
      }
      this.upsertRetryTask(rt, 'push_events', se.code || 'WEBDAV_PUSH_FAILED', se.message);
      await this.logger.log({
        spaceId: rt.spaceId,
        level: 'warn',
        phase,
        code: se.code,
        message: `Local account action succeeded, but cloud push deferred (${se.message})`,
        timestamp: this.now(),
      });
    }
  }

  private getCurrentDek(rt: LoadedSpaceRuntime): string {
    const dek = rt.dekKeyring[rt.meta.space.keyEpoch];
    if (!dek) {
      throw Object.assign(new Error('Session is locked; unlock with encryption password first'), {
        code: 'LOCKED',
        phase: 'auth',
      });
    }
    return dek;
  }

  private getActiveBoundTrackIds(
    rt: LoadedSpaceRuntime,
    options?: { requirePullAllowed?: boolean },
  ): Set<string> {
    const ids = new Set<string>();
    for (const [siteKey, binding] of Object.entries(rt.meta.localDevice.siteBindings)) {
      if (
        !binding?.trackId ||
        binding.state === 'UNMANAGED' ||
        binding.state === 'BLACKLISTED' ||
        binding.state === 'PENDING_CHOICE'
      ) {
        continue;
      }
      if (!this.isSiteManagedOrRemotelyTracked(rt, siteKey)) {
        continue;
      }
      const policy = this.getEffectivePolicyForDevice(rt, siteKey, siteKey);
      if (policy.excluded || policy.direction === 'disabled') {
        continue;
      }
      if (options?.requirePullAllowed && policy.direction === 'push_only') {
        continue;
      }
      ids.add(binding.trackId);
    }
    return ids;
  }

  private getUnacknowledgedFailedCookies(rt: LoadedSpaceRuntime): CookieRecord[] {
    const boundTrackIds = this.getActiveBoundTrackIds(rt);
    if (boundTrackIds.size === 0) return [];
    const nowSec = this.now() / 1000;
    const dismissed = rt.meta.dismissedApplyFailures ?? {};
    return Object.values(rt.cookies).filter((c) => {
      if (c.deleted || c.syncStatus !== 'APPLY_FAILED') return false;
      if (!boundTrackIds.has(c.trackId)) return false;
      if (!c.session && c.expirationDate !== undefined && c.expirationDate <= nowSec) {
        return false;
      }
      if (dismissed[c.logicalId] && dismissed[c.logicalId] === cookieContentCanonicalHash(c)) {
        return false;
      }
      return true;
    });
  }

  private getActiveCorruptedPaths(rt: LoadedSpaceRuntime): string[] {
    const dismissed = rt.meta.dismissedCorruptedPaths ?? {};
    return rt.meta.corruptedPaths.filter((p) => !dismissed[p]);
  }

  /**
   * Returns true for temporary server/network errors that self-heal via automatic background backoff
   * (503, 502, 504, 429, 423, 408, timeout, network offline), as opposed to hard errors (401/403/507/DECRYPT).
   */
  private isTransientRetryableError(se: StructuredError | null | undefined): boolean {
    if (!se) return false;
    if (
      se.code === 'DECRYPT_ERROR' ||
      se.code === 'ERR_STORAGE_FULL' ||
      se.status === 401 ||
      se.status === 403 ||
      se.status === 507
    ) {
      return false;
    }
    if (
      se.retryable ||
      se.code === 'ERR_NETWORK_OFFLINE' ||
      se.code === 'WEBDAV_TIMEOUT' ||
      se.code === 'WEBDAV_NETWORK_ERROR' ||
      se.code === 'WEBDAV_RATE_LIMITED' ||
      se.code === 'WEBDAV_LOCKED' ||
      se.code === 'WEBDAV_SERVER_ERROR'
    ) {
      return true;
    }
    if (
      typeof se.status === 'number' &&
      (se.status === 408 || se.status === 423 || se.status === 429 || se.status >= 500)
    ) {
      return true;
    }
    return false;
  }

  /**
   * Deduplicates pending outbound events by `objectId`, keeping only the newest causal event
   * per Cookie/LocalStorage item so offline bursts or transient 503s never bloat the queue.
   */
  private compactPendingOutboundEvents(events: SyncEvent[]): SyncEvent[] {
    if (events.length <= 1) return [...events];
    const latestByObj = new Map<string, SyncEvent>();
    for (const ev of events) {
      const prev = latestByObj.get(ev.objectId);
      if (prev) {
        // Delete old entry first so insertion order reflects newest sequence
        latestByObj.delete(ev.objectId);
      }
      latestByObj.set(ev.objectId, ev);
    }
    return Array.from(latestByObj.values());
  }

  private enqueueOutboundEvent(rt: LoadedSpaceRuntime, event: SyncEvent): void {
    const existingIdx = rt.pendingOutboundEvents.findIndex((e) => e.objectId === event.objectId);
    if (existingIdx >= 0) {
      rt.pendingOutboundEvents.splice(existingIdx, 1);
    }
    rt.pendingOutboundEvents.push(event);
  }

  private getEffectiveSyncTimingMode(rt: LoadedSpaceRuntime): SyncTimingMode {
    return rt.meta.space.settings.syncTimingMode ?? this.defaultSyncTimingMode;
  }

  private getEffectiveAutoPushCooldownMs(rt: LoadedSpaceRuntime): number {
    if (this.autoPushCooldownMs <= 0) return 0;
    return rt.meta.space.settings.lowFrequencyMode
      ? Math.max(this.autoPushCooldownMs, 45_000)
      : this.autoPushCooldownMs;
  }

  /**
   * Returns how many milliseconds until the next background auto-push should run,
   * or `null` when nothing is waiting to be pushed automatically.
   */
  getNextAutoPushDelayMs(): number | null {
    const rt = this.runtime;
    if (!rt) return null;
    if (
      rt.meta.globalPaused ||
      rt.meta.localDevice.state !== 'active' ||
      rt.meta.storageFullHalted ||
      !rt.meta.space.settings.autoSync ||
      !rt.dekKeyring[rt.meta.space.keyEpoch]
    ) {
      return null;
    }
    const localDevPolicy = this.getLocalDevicePolicy(rt);
    if (localDevPolicy?.direction === 'disabled' || localDevPolicy?.direction === 'pull_only') {
      return null;
    }
    const timingMode = this.getEffectiveSyncTimingMode(rt);
    const readyPendingEvents =
      timingMode === 'on_page_leave'
        ? rt.pendingOutboundEvents.filter(
            (ev) =>
              !this.deferredOnPageLeaveSites.has(ev.siteKey) ||
              this.releasedOnPageLeaveSites.has(ev.siteKey),
          )
        : rt.pendingOutboundEvents;
    if (readyPendingEvents.length === 0 && !rt.meta.manifestDirty) {
      return null;
    }
    const nowMs = this.now();
    const cooldown = this.getEffectiveAutoPushCooldownMs(rt);
    const cooldownTarget =
      cooldown > 0 && rt.meta.lastAutoPushAt ? rt.meta.lastAutoPushAt + cooldown : 0;
    const backoffTarget = rt.meta.autoPushBackoffUntilMs ?? 0;
    let reloadMuteTarget = 0;
    for (const ev of readyPendingEvents) {
      const muteUntil = this.postReloadPushMuteUntil.get(ev.siteKey) ?? 0;
      if (muteUntil > nowMs) {
        reloadMuteTarget = Math.max(reloadMuteTarget, muteUntil);
      }
    }
    const targetMs = Math.max(cooldownTarget, backoffTarget, reloadMuteTarget);
    if (targetMs <= nowMs) {
      return 3_000;
    }
    return Math.min(180_000, Math.max(3_000, targetMs - nowMs));
  }

  private supersedeConflictsForObject(
    rt: LoadedSpaceRuntime,
    objectId: string,
    _nowMs: number,
  ): void {
    for (const conflict of Object.values(rt.conflicts)) {
      if (!conflict.resolved && conflict.objectId === objectId) {
        conflict.resolved = true;
        conflict.resolvedBy = 'auto';
      }
    }
  }

  private computeStatus(rt: LoadedSpaceRuntime): DeviceStatus {
    if (!rt.dekKeyring[rt.meta.space.keyEpoch]) {
      return rt.meta.space.status === 'DECRYPT_ERROR' ? 'DECRYPT_ERROR' : 'LOCKED';
    }
    if (rt.meta.space.status === 'DECRYPT_ERROR') return 'DECRYPT_ERROR';
    if (rt.meta.space.status === 'AUTH_ERROR') return 'AUTH_ERROR';
    if (rt.meta.localDevice.state === 'removed' || rt.meta.localDevice.state === 'revoked') {
      return 'LOCKED';
    }
    if (rt.meta.globalPaused || rt.meta.localDevice.state === 'paused') return 'PAUSED';
    if (!this.isOnline()) return 'OFFLINE';
    if (rt.pendingOutboundEvents.length > 0) return 'PENDING';
    const hasActionableLatestError =
      Boolean(rt.meta.latestError) &&
      (!this.isTransientRetryableError(rt.meta.latestError) ||
        (rt.meta.consecutiveTransientFailures ?? 0) >= this.transientErrorAlertThreshold);
    if (
      rt.meta.storageFullHalted ||
      this.getUnacknowledgedFailedCookies(rt).length > 0 ||
      this.getActiveCorruptedPaths(rt).length > 0 ||
      hasActionableLatestError
    ) {
      return 'PARTIAL';
    }
    return 'SYNCED';
  }

  private buildAttentionItems(rt: LoadedSpaceRuntime, status: DeviceStatus): AttentionItem[] {
    if (status === 'LOCKED' || status === 'PAUSED' || status === 'UNCONFIGURED') {
      return [];
    }

    const items: AttentionItem[] = [];

    // 1. Decrypt / Auth / Storage-Full Errors
    if (status === 'DECRYPT_ERROR') {
      items.push({
        id: 'decrypt_error',
        kind: 'decrypt_error',
        severity: 'error',
        title: '端到端加密密码校验失败',
        detail: rt.meta.latestError?.message || '远端空间元数据或密钥无法用当前主密码解密。',
        suggestion:
          rt.meta.latestError?.suggestion ||
          '若其他设备刚修改过加密主密码，请前往控制中心或重新输入新主密码解锁。',
        timestamp: rt.meta.latestError?.timestamp,
      });
      return items;
    }

    if (status === 'AUTH_ERROR') {
      items.push({
        id: 'auth_error',
        kind: 'auth_error',
        severity: 'error',
        title: 'WebDAV 账号认证或目录权限失败',
        detail: rt.meta.latestError?.message || '服务器返回 401/403，拒绝访问远端同步目录。',
        suggestion:
          rt.meta.latestError?.suggestion ||
          '请前往控制中心检查 WebDAV 账号、应用专用密码与远端根目录读写权限。',
        dismissible: true,
        timestamp: rt.meta.latestError?.timestamp,
      });
    }

    if (rt.meta.storageFullHalted) {
      items.push({
        id: 'storage_full',
        kind: 'storage_full',
        severity: 'error',
        title: 'WebDAV 云端存储空间不足（507）',
        detail: '为防止远端加密文件写入截断，已自动暂停自动上传。',
        suggestion: '可点击清理历史事件与墓碑（GC），或释放网盘配额后重新同步。',
        dismissible: true,
      });
    }

    // 2. Latest structured error — keep transient 503/429/network blips silent until persistent (>= threshold)
    const transientFailures = rt.meta.consecutiveTransientFailures ?? 0;
    let showedTransientWarning = false;
    if (rt.meta.latestError && status !== 'AUTH_ERROR' && !rt.meta.storageFullHalted) {
      const isTransient = this.isTransientRetryableError(rt.meta.latestError);
      if (!isTransient) {
        items.push({
          id: 'latest_error',
          kind: 'latest_error',
          severity: 'error',
          title: `同步执行异常 [${rt.meta.latestError.code}]`,
          detail: rt.meta.latestError.message,
          suggestion: rt.meta.latestError.suggestion,
          dismissible: true,
          timestamp: rt.meta.latestError.timestamp,
        });
      } else if (transientFailures >= this.transientErrorAlertThreshold) {
        showedTransientWarning = true;
        const statusHint = rt.meta.latestError.status
          ? `HTTP ${rt.meta.latestError.status}`
          : rt.meta.latestError.code;
        items.push({
          id: 'latest_error',
          kind: 'latest_error',
          severity: 'warning',
          count: transientFailures,
          title: `WebDAV 云端暂时繁忙（${statusHint}，已连续重试 ${transientFailures} 次）`,
          detail: '本地变更已合并保存，系统会继续在后台自动退避重试，无需手动操作。',
          suggestion: '如网盘服务持续异常可稍后点「立即同步重试」，或直接点「忽略」静默等待自动恢复。',
          dismissible: true,
          timestamp: rt.meta.latestError.timestamp,
        });
      }
    }

    // 3. Pending Multi-Track Site Decisions
    const pendingList = Object.values(rt.pendingDecisions).sort(
      (a, b) => b.detectedAt - a.detectedAt,
    );
    for (const d of pendingList) {
      const remoteTracks = Object.values(rt.tracks).filter((t) => t.siteKey === d.siteKey);
      const isMulti = d.reason === 'multiple_remote_tracks' || remoteTracks.length > 1;
      items.push({
        id: `decision:${d.siteKey}`,
        kind: 'pending_decision',
        severity: 'warning',
        siteKey: d.siteKey,
        count: remoteTracks.length,
        title: `${d.siteKey} 待确认同步版本`,
        detail: isMulti
          ? `云端存在 ${remoteTracks.length} 条独立账号轨道，请选择要跟随的轨道或设为本机独立。`
          : `本机（${d.localCookieCount} 条 Cookie）与云端均有登录数据，请选择以云端还是本机为准。`,
        timestamp: d.detectedAt,
      });
    }

    // 4. Auto-merged HLC concurrent conflicts are recorded for audit/override in SidePanel「冲突中心」
    // without spamming Popup alarms or lighting up the toolbar "!" badge on routine multi-device cookie churn.

    // 5. Failed Cookie Browser Applies (grouped by siteKey)
    const failedCookies = this.getUnacknowledgedFailedCookies(rt);
    if (failedCookies.length > 0) {
      const bySite = new Map<string, CookieRecord[]>();
      for (const c of failedCookies) {
        const list = bySite.get(c.siteKey) ?? [];
        list.push(c);
        bySite.set(c.siteKey, list);
      }
      for (const [siteKey, list] of bySite.entries()) {
        const names = list.slice(0, 3).map((c) => c.name);
        const namesLabel =
          list.length > 3 ? `${names.join(', ')} 等 ${list.length} 项` : names.join(', ');
        const firstReason = formatApplyFailureReason(list[0]?.applyResult?.reason);
        items.push({
          id: `apply_failed:${siteKey}`,
          kind: 'apply_failed',
          severity: 'warning',
          siteKey,
          logicalIds: list.map((c) => c.logicalId),
          count: list.length,
          title: `${siteKey} 有 ${list.length} 条 Cookie 写入受阻`,
          detail: `受阻项：${namesLabel}。原因：${firstReason}`,
          suggestion: '可点击「重试写入」，若属于浏览器限制的特殊 Cookie 可直接点击「忽略并关闭」。',
          dismissible: true,
        });
      }
    }

    // 6. Active Corrupted Remote Files
    const activeCorrupted = this.getActiveCorruptedPaths(rt);
    if (activeCorrupted.length > 0) {
      const names = activeCorrupted.slice(0, 2).map((p) => extractFilename(p));
      const filesLabel =
        activeCorrupted.length > 2
          ? `${names.join(', ')} 等 ${activeCorrupted.length} 个文件`
          : names.join(', ');
      items.push({
        id: 'corrupted_files',
        kind: 'corrupted_file',
        severity: 'warning',
        count: activeCorrupted.length,
        title: `发现 ${activeCorrupted.length} 个远端历史损坏或不兼容文件`,
        detail: `已自动隔离跳过（${filesLabel}），不影响当前正常数据安全。`,
        suggestion: '可点击「重建索引」重新拉取校验，或点击「忽略并关闭」消除此提示。',
        dismissible: true,
      });
    }

    // 7. Persistent Offline / Retry Tasks (routine pending uploads auto-sync silently in background)
    const pendingSites = Array.from(new Set(rt.pendingOutboundEvents.map((e) => e.siteKey)));
    const sitesLabel =
      pendingSites.length > 3
        ? `${pendingSites.slice(0, 3).join(', ')} 等 ${pendingSites.length} 个网站`
        : pendingSites.join(', ');

    if (
      status === 'OFFLINE' &&
      rt.pendingOutboundEvents.length > 0 &&
      transientFailures >= this.transientErrorAlertThreshold
    ) {
      items.push({
        id: 'offline_pending',
        kind: 'offline_pending',
        severity: 'warning',
        count: rt.pendingOutboundEvents.length,
        title: `网络持续离线，${rt.pendingOutboundEvents.length} 条变更待恢复后自动上传`,
        detail: `涉及网站：${sitesLabel}。恢复联网后将自动补偿同步。`,
        dismissible: true,
      });
    } else if (!showedTransientWarning && status !== 'OFFLINE') {
      const activeRetries = rt.retryTasks.filter(
        (t) =>
          (t.status === 'RETRYING' || t.status === 'FAILED') &&
          t.retryCount >= this.transientErrorAlertThreshold,
      );
      if (activeRetries.length > 0 && !rt.meta.latestError) {
        const topTask = activeRetries[0];
        items.push({
          id: 'retry_tasks',
          kind: 'retry_task',
          severity: 'warning',
          count: rt.pendingOutboundEvents.length || activeRetries.length,
          title: `后台同步持续重试中（已重试 ${topTask.retryCount} 次）`,
          detail: `${topTask.errorMessage || topTask.errorCode || '网络波动导致上次推送未完成'}${
            sitesLabel ? ` · 涉及：${sitesLabel}` : ''
          }`,
          dismissible: true,
        });
      }
    }

    // 8. Form-Safe Deferred Page Reloads
    for (const def of this.autoRefresh.getDeferredReloads()) {
      items.push({
        id: `deferred_reload:${def.tabId}`,
        kind: 'deferred_reload',
        severity: 'info',
        siteKey: def.siteKey,
        tabId: def.tabId,
        title: `${def.siteKey} 新登录态已写入，等待刷新页面`,
        detail: `因检测到${formatDeferredReloadReasons(def.reasons)}，已暂缓自动刷新以防丢失内容。`,
        dismissible: true,
        timestamp: def.deferredAt,
      });
    }

    return items;
  }

  // =========================================================================
  // Space Info, Managed Scope & Per-Device Policy Helpers
  // =========================================================================

  private async writeRemoteSpaceInfo(
    webdav: WebDAVConfig,
    opaqueId: string,
    info: { spaceId: string; spaceName: string; updatedAt: number },
  ): Promise<void> {
    try {
      const rawClient = new WebDAVClient(
        { ...webdav, storageFormat: 'binary_enc' },
        this.webdavClientOptions,
      );
      const payload = utf8ToBytes(
        JSON.stringify({
          spaceId: info.spaceId,
          spaceName: info.spaceName,
          updatedAt: info.updatedAt,
        }),
      );
      await rawClient.putBytes(spaceInfoPath(opaqueId), payload, {
        contentType: 'text/plain; charset=utf-8',
      });
    } catch {
      // Non-fatal: space-info.txt is an unencrypted discovery hint only
    }
  }

  private async readRemoteSpaceInfo(
    webdav: WebDAVConfig,
    opaqueId: string,
  ): Promise<{ spaceId: string; spaceName?: string; updatedAt?: number } | null> {
    try {
      const rawClient = new WebDAVClient(
        { ...webdav, storageFormat: 'binary_enc' },
        this.webdavClientOptions,
      );
      const fetched = await rawClient.getBytes(spaceInfoPath(opaqueId));
      const text = bytesToUtf8(fetched.bytes).trim();
      if (!text) return null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Fallback in case a client stored base64-encoded JSON in space-info.txt
        try {
          parsed = JSON.parse(bytesToUtf8(base64ToBytes(text)));
        } catch {
          return null;
        }
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const rec = parsed as Record<string, unknown>;
      if (typeof rec.spaceId !== 'string' || !rec.spaceId.trim()) return null;

      return {
        spaceId: rec.spaceId.trim(),
        spaceName:
          typeof rec.spaceName === 'string' && rec.spaceName.trim()
            ? rec.spaceName.trim()
            : undefined,
        updatedAt:
          typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt)
            ? rec.updatedAt
            : undefined,
      };
    } catch {
      return null;
    }
  }

  private getLocalDevicePolicy(rt: LoadedSpaceRuntime): PerDeviceSyncPolicy | undefined {
    return rt.meta.space.settings.devicePolicies?.[rt.meta.localDevice.deviceId];
  }

  private isSiteExcludedByLocalDevicePolicy(rt: LoadedSpaceRuntime, siteKey: string): boolean {
    const devPolicy = this.getLocalDevicePolicy(rt);
    if (!devPolicy?.excludedSiteKeys || devPolicy.excludedSiteKeys.length === 0) {
      return false;
    }
    const normSite = resolveSiteKey(siteKey, rt.meta.rules.ssoGroups) || normalizeDomain(siteKey);
    return devPolicy.excludedSiteKeys.some((entry) => {
      const normEntry = resolveSiteKey(entry, rt.meta.rules.ssoGroups) || normalizeDomain(entry);
      return Boolean(normEntry) && (normEntry === siteKey || normEntry === normSite);
    });
  }

  private getEffectivePolicyForDevice(
    rt: LoadedSpaceRuntime,
    domainOrOriginOrUrl: string,
    siteKeyHint?: string,
  ): {
    excluded: boolean;
    direction: Exclude<SyncDirection, 'inherit'>;
    syncCookies: boolean;
    syncLocalStorage: boolean;
    autoRefresh: boolean;
  } {
    const base = rt.rulesEngine.getEffectivePolicy(domainOrOriginOrUrl);
    if (base.excluded) {
      return base;
    }

    const siteKey =
      siteKeyHint || resolveSiteKey(domainOrOriginOrUrl, rt.meta.rules.ssoGroups) || '';
    if (siteKey && this.isSiteExcludedByLocalDevicePolicy(rt, siteKey)) {
      return {
        excluded: true,
        direction: 'disabled',
        syncCookies: false,
        syncLocalStorage: false,
        autoRefresh: false,
      };
    }

    const devPolicy = this.getLocalDevicePolicy(rt);
    if (!devPolicy || !devPolicy.direction || devPolicy.direction === 'inherit') {
      return base;
    }

    if (devPolicy.direction === 'disabled') {
      return {
        excluded: true,
        direction: 'disabled',
        syncCookies: false,
        syncLocalStorage: false,
        autoRefresh: false,
      };
    }

    let effectiveDirection: Exclude<SyncDirection, 'inherit'> = devPolicy.direction;
    if (devPolicy.direction === 'pull_only') {
      effectiveDirection =
        base.direction === 'push_only' || base.direction === 'disabled' ? 'disabled' : 'pull_only';
    } else if (devPolicy.direction === 'push_only') {
      effectiveDirection =
        base.direction === 'pull_only' || base.direction === 'disabled' ? 'disabled' : 'push_only';
    } else if (devPolicy.direction === 'bidirectional') {
      effectiveDirection = base.direction === 'disabled' ? 'disabled' : 'bidirectional';
    }

    const disabled = effectiveDirection === 'disabled';
    return {
      excluded: disabled,
      direction: effectiveDirection,
      syncCookies: disabled ? false : base.syncCookies,
      syncLocalStorage: disabled ? false : base.syncLocalStorage,
      autoRefresh: disabled ? false : base.autoRefresh,
    };
  }

  private isSiteManagedOrRemotelyTracked(
    rt: LoadedSpaceRuntime,
    siteKey: string,
    explicitInitialSet?: ReadonlySet<string>,
  ): boolean {
    const binding = rt.meta.localDevice.siteBindings[siteKey];
    if (binding?.state === 'UNMANAGED') {
      return false;
    }
    if (explicitInitialSet?.has(siteKey)) {
      return true;
    }
    if (rt.meta.space.settings.syncScopeMode !== 'managed_only') {
      return true;
    }
    const hasRemoteTrack = Object.values(rt.tracks).some((t) => t.siteKey === siteKey);
    if (
      binding &&
      (binding.state === 'AUTO_BOUND' ||
        binding.state === 'USER_BOUND' ||
        binding.state === 'INDEPENDENT' ||
        binding.state === 'PENDING_CHOICE') &&
      (binding.trackId || hasRemoteTrack)
    ) {
      return true;
    }
    if (hasRemoteTrack) {
      return true;
    }
    return false;
  }

  private async reEvaluatePendingDecisionsInternal(
    rt: LoadedSpaceRuntime,
    options?: { deferSyncAndPersist?: boolean; triggerRefresh?: boolean },
  ): Promise<{ resolvedCount: number; appliedCookies: number; failedCookies: number }> {
    let resolvedCount = 0;
    let appliedCookies = 0;
    let failedCookies = 0;

    for (const siteKey of Object.keys(rt.pendingDecisions)) {
      const pending = rt.pendingDecisions[siteKey];
      if (!pending) continue;

      if (
        rt.meta.localDevice.siteBindings[siteKey]?.state === 'UNMANAGED' ||
        this.isSiteExcludedByLocalDevicePolicy(rt, siteKey)
      ) {
        delete rt.pendingDecisions[siteKey];
        continue;
      }

      const remoteTracks = Object.values(rt.tracks).filter((t) => t.siteKey === siteKey);
      if (remoteTracks.length === 0) {
        delete rt.pendingDecisions[siteKey];
        continue;
      }

      const autoAction = resolveAutomaticSiteDecisionAction({
        localDeviceId: rt.meta.localDevice.deviceId,
        settings: rt.meta.space.settings,
        remoteTracks,
        hasLocalData: pending.hasLocalData,
      });
      if (!autoAction) continue;

      const res = await this.resolveSiteDecisionInternal(siteKey, autoAction, {
        deferSyncAndPersist: true,
        triggerRefresh: options?.triggerRefresh ?? true,
        decidedBy: 'auto',
      });
      resolvedCount += 1;
      appliedCookies += res.appliedCookies;
      failedCookies += res.failedCookies;
    }

    if (!options?.deferSyncAndPersist && resolvedCount > 0) {
      const devPolicy = this.getLocalDevicePolicy(rt);
      const canPush = devPolicy?.direction !== 'pull_only' && devPolicy?.direction !== 'disabled';
      if (canPush && rt.pendingOutboundEvents.length > 0) {
        await this.tryPushOutboundBestEffort(rt, 'auto_resolve_decisions');
      }
    }

    return { resolvedCount, appliedCookies, failedCookies };
  }

  // =========================================================================
  // Onboarding & Space Lifecycle
  // =========================================================================

  async testWebDAVConnection(config: WebDAVConfig): Promise<CapabilityReport> {
    await this.ensureInitialized();
    this.registerConfigSecrets(config);
    const detector = new WebDAVCapabilityDetector(config, this.webdavClientOptions);
    return detector.runFullCheck();
  }

  async probeRemoteSpaces(config: WebDAVConfig): Promise<RemoteSpaceProbeItem[]> {
    await this.ensureInitialized();
    this.registerConfigSecrets(config);
    const client = new WebDAVClient(config, this.webdavClientOptions);
    client.validateUrl();
    try {
      const entries = await client.propfind(spacesRootDir(), 1);
      const localByOpaque = new Map<string, LocalSpaceIndexEntry>();
      for (const entry of Object.values(this.spaceIndex)) {
        localByOpaque.set(entry.opaqueId, entry);
      }

      const spaces: RemoteSpaceProbeItem[] = [];
      const rootNorm = spacesRootDir().replace(/^\/+|\/+$/g, '');
      for (const stat of entries) {
        if (!stat.isCollection) continue;
        const normPath = stat.path.replace(/^\/+|\/+$/g, '');
        if (!normPath || normPath === rootNorm || normPath.endsWith(`/${rootNorm}`)) continue;
        const dirName = stat.name || extractFilename(normPath);
        if (!dirName || dirName === 'spaces') continue;

        const remoteInfo = await this.readRemoteSpaceInfo(config, dirName);
        const localEntry = localByOpaque.get(dirName);

        const spaceId = remoteInfo?.spaceId ?? localEntry?.spaceId ?? dirName;
        const spaceName =
          remoteInfo?.spaceName ?? localEntry?.name ?? remoteInfo?.spaceId ?? localEntry?.spaceId ?? dirName;
        const updatedAt = remoteInfo?.updatedAt ?? localEntry?.updatedAt ?? stat.lastModified;

        spaces.push({
          opaqueId: dirName,
          hintId: spaceId,
          spaceId,
          spaceName,
          updatedAt,
        });
      }
      return spaces;
    } catch (err) {
      const structured = toStructuredError(err, 'probe');
      if (structured.status === 404) {
        return [];
      }
      throw err;
    }
  }

  async verifyRemoteSpacePassword(params: {
    webdav: WebDAVConfig;
    spaceId: string;
    encryptionPassword: string;
  }): Promise<RemoteSpacePasswordVerifyResult> {
    await this.ensureInitialized();
    this.registerConfigSecrets(params.webdav, params.encryptionPassword);

    const trimmedSpaceId = params.spaceId.trim();
    if (!trimmedSpaceId) {
      throw toStructuredError(new Error('请先输入同步空间 ID'), 'verify_password');
    }
    if (!params.encryptionPassword || params.encryptionPassword.trim().length === 0) {
      throw toStructuredError(new Error('请输入端到端加密主密码'), 'verify_password');
    }

    const client = new WebDAVClient(params.webdav, this.webdavClientOptions);
    client.validateUrl();

    // Verify connectivity & WebDAV credentials first so auth/network errors are never mistaken for 404
    try {
      await client.options('');
    } catch (err) {
      throw toStructuredError(err, 'verify_password', params.webdav.url);
    }

    let opaqueId: string;
    let metaStat: WebDAVResourceStat | null = null;
    let joinedByOpaqueId = false;

    try {
      if (OPAQUE_SPACE_ID_RE.test(trimmedSpaceId)) {
        const directStat = await client.stat(spaceMetaPath(trimmedSpaceId));
        if (directStat !== null) {
          opaqueId = trimmedSpaceId;
          metaStat = directStat;
          joinedByOpaqueId = true;
        } else {
          opaqueId = await deriveOpaqueId(trimmedSpaceId, 'sp_');
          metaStat = await client.stat(spaceMetaPath(opaqueId));
        }
      } else {
        opaqueId = await deriveOpaqueId(trimmedSpaceId, 'sp_');
        metaStat = await client.stat(spaceMetaPath(opaqueId));
      }
    } catch (err) {
      throw toStructuredError(err, 'verify_password', spaceMetaPath(trimmedSpaceId));
    }

    if (metaStat === null) {
      return { exists: false, verified: false };
    }

    const metaPath = spaceMetaPath(opaqueId);
    const fetched = await client.getBytes(metaPath);

    let aadSpaceId = trimmedSpaceId;
    if (joinedByOpaqueId) {
      const hintInfo = await this.readRemoteSpaceInfo(params.webdav, opaqueId);
      if (hintInfo?.spaceId && (await deriveOpaqueId(hintInfo.spaceId, 'sp_')) === opaqueId) {
        aadSpaceId = hintInfo.spaceId;
      } else {
        try {
          const header = parseSmesHeader(fetched.bytes);
          const suffix = `|meta|space_meta|${metaPath}`;
          if (header.aad.endsWith(suffix)) {
            const candidateId = header.aad.slice(0, -suffix.length);
            if (
              candidateId &&
              ((await deriveOpaqueId(candidateId, 'sp_')) === opaqueId || candidateId === opaqueId)
            ) {
              aadSpaceId = candidateId;
            }
          }
        } catch {
          // Fall through to standard decryption error handling
        }
      }
    }

    const metaAad = buildSpaceMetaAad(aadSpaceId, metaPath);
    try {
      const descriptor = await decryptWithPassword<SpaceDescriptorPayload>(
        fetched.bytes,
        params.encryptionPassword,
        metaAad,
      );
      if (!descriptor || descriptor.verifier !== 'SESSIONMESH_SPACE_OK') {
        throw new Error('DECRYPT: Invalid space metadata verifier');
      }
      return {
        exists: true,
        verified: true,
        spaceId: descriptor.spaceId || aadSpaceId,
        spaceName: descriptor.name,
        keyEpoch: descriptor.keyEpoch,
      };
    } catch {
      return {
        exists: true,
        verified: false,
        errorCode: 'DECRYPT_ERROR',
        errorMessage: '端到端加密主密码错误，无法解密远端空间元数据，请核对后重试',
      };
    }
  }

  async saveAndJoinSpace(params: {
    webdav: WebDAVConfig;
    spaceId: string;
    spaceName: string;
    encryptionPassword: string;
    deviceName: string;
    presetCategories?: Array<'banking' | 'password_manager' | 'webdav_self' | 'localhost'>;
    settingsPatch?: Partial<SpaceSettings>;
    initialManagedSiteKeys?: string[];
  }): Promise<InitialJoinReport> {
    await this.ensureInitialized();
    return this.enqueueOp(() => this.saveAndJoinSpaceInternal(params));
  }

  private async saveAndJoinSpaceInternal(params: {
    webdav: WebDAVConfig;
    spaceId: string;
    spaceName: string;
    encryptionPassword: string;
    deviceName: string;
    presetCategories?: Array<'banking' | 'password_manager' | 'webdav_self' | 'localhost'>;
    settingsPatch?: Partial<SpaceSettings>;
    initialManagedSiteKeys?: string[];
  }): Promise<InitialJoinReport> {
    const nowMs = this.now();
    this.registerConfigSecrets(params.webdav, params.encryptionPassword);

    if (!params.encryptionPassword || params.encryptionPassword.trim().length === 0) {
      throw toStructuredError(new Error('Encryption password is required'), 'join');
    }

    const client = new WebDAVClient(params.webdav, this.webdavClientOptions);
    client.validateUrl();

    // Prohibition #6: Verify connectivity & auth before treating 404 as new space
    try {
      await client.options('');
    } catch (err) {
      const se = toStructuredError(err, 'join', params.webdav.url);
      await this.logger.log({
        spaceId: params.spaceId,
        level: 'error',
        phase: 'join',
        code: se.code,
        message: se.message,
        suggestion: se.suggestion,
        timestamp: nowMs,
      });
      throw se;
    }

    // Prevent double-hashing when joining directly with an opaque `sp_...` directory ID
    let opaqueId: string;
    let metaStat: WebDAVResourceStat | null = null;
    let joinedByOpaqueId = false;

    try {
      if (OPAQUE_SPACE_ID_RE.test(params.spaceId)) {
        const directStat = await client.stat(spaceMetaPath(params.spaceId));
        if (directStat !== null) {
          opaqueId = params.spaceId;
          metaStat = directStat;
          joinedByOpaqueId = true;
        } else {
          opaqueId = await deriveOpaqueId(params.spaceId, 'sp_');
          metaStat = await client.stat(spaceMetaPath(opaqueId));
        }
      } else {
        opaqueId = await deriveOpaqueId(params.spaceId, 'sp_');
        metaStat = await client.stat(spaceMetaPath(opaqueId));
      }
    } catch (err) {
      const se = toStructuredError(err, 'join', spaceMetaPath(params.spaceId));
      await this.logger.log({
        spaceId: params.spaceId,
        level: 'error',
        phase: 'join',
        code: se.code,
        message: se.message,
        suggestion: se.suggestion,
        timestamp: nowMs,
      });
      throw se;
    }

    const metaPath = spaceMetaPath(opaqueId);
    const cleanSettingsPatch: Partial<SpaceSettings> = {};
    if (params.settingsPatch) {
      for (const [k, v] of Object.entries(params.settingsPatch)) {
        if (v !== undefined) {
          (cleanSettingsPatch as Record<string, unknown>)[k] = v;
        }
      }
    }

    let isNewSpace = false;
    let descriptor: SpaceDescriptorPayload;
    let spaceMetaEtag: string | undefined;
    let deviceBlacklist: BlacklistEntry[] = [];
    let effectiveSpaceId = params.spaceId;

    if (metaStat !== null) {
      // Existing space: MUST decrypt cleanly before ANY write (Prohibition #5, D-014)
      isNewSpace = false;
      const fetched = await client.getBytes(metaPath);
      spaceMetaEtag = normalizeEtag(fetched.etag ?? metaStat.etag);

      let aadSpaceId = params.spaceId;
      if (joinedByOpaqueId) {
        const hintInfo = await this.readRemoteSpaceInfo(params.webdav, opaqueId);
        if (hintInfo?.spaceId && (await deriveOpaqueId(hintInfo.spaceId, 'sp_')) === opaqueId) {
          aadSpaceId = hintInfo.spaceId;
        } else {
          try {
            const header = parseSmesHeader(fetched.bytes);
            const suffix = `|meta|space_meta|${metaPath}`;
            if (header.aad.endsWith(suffix)) {
              const candidateId = header.aad.slice(0, -suffix.length);
              if (
                candidateId &&
                ((await deriveOpaqueId(candidateId, 'sp_')) === opaqueId || candidateId === opaqueId)
              ) {
                aadSpaceId = candidateId;
              }
            }
          } catch {
            // Fall through to standard decryption error reporting
          }
        }
      }

      const metaAad = buildSpaceMetaAad(aadSpaceId, metaPath);
      try {
        descriptor = await decryptWithPassword<SpaceDescriptorPayload>(
          fetched.bytes,
          params.encryptionPassword,
          metaAad,
        );
        if (!descriptor || descriptor.verifier !== 'SESSIONMESH_SPACE_OK') {
          throw new Error('DECRYPT: Invalid space metadata verifier');
        }
      } catch (err) {
        const se = toStructuredError(err, 'decrypt', metaPath);
        se.code = 'DECRYPT_ERROR';
        if (this.runtime && this.runtime.spaceId === aadSpaceId) {
          this.runtime.meta.space.status = 'DECRYPT_ERROR';
          this.runtime.meta.latestError = se;
          await this.persistRuntime(this.runtime);
        }
        await this.logger.log({
          spaceId: aadSpaceId,
          level: 'error',
          phase: 'decrypt',
          code: 'DECRYPT_ERROR',
          message: se.message,
          suggestion: se.suggestion,
          timestamp: nowMs,
        });
        throw se;
      }

      effectiveSpaceId = descriptor.spaceId || aadSpaceId;
      const mergedDevicePolicies = {
        ...(descriptor.settings?.devicePolicies ?? {}),
        ...(cleanSettingsPatch.devicePolicies ?? {}),
      };
      descriptor.settings = {
        ...DEFAULT_SPACE_SETTINGS,
        ...descriptor.settings,
        ...cleanSettingsPatch,
        devicePolicies: mergedDevicePolicies,
      };
      if (params.presetCategories && params.presetCategories.length > 0) {
        deviceBlacklist = buildPresetBlacklistEntries(
          params.presetCategories,
          params.webdav.url,
          'device',
        );
      }
    } else {
      // New space initialization
      isNewSpace = true;
      const metaAad = buildSpaceMetaAad(effectiveSpaceId, metaPath);
      const dekBase64 = await generateSpaceDekBase64();
      const initialSettings: SpaceSettings = {
        ...DEFAULT_SPACE_SETTINGS,
        ...cleanSettingsPatch,
        devicePolicies: { ...(cleanSettingsPatch.devicePolicies ?? {}) },
      };
      const presetSpaceBlacklist =
        params.presetCategories && params.presetCategories.length > 0
          ? buildPresetBlacklistEntries(params.presetCategories, params.webdav.url, 'space')
          : [];
      const initialRules: SpaceRuleSet = {
        spaceBlacklist: presetSpaceBlacklist,
        siteOverrides: {},
        ssoGroups: [],
        updatedAt: nowMs,
      };

      descriptor = {
        spaceId: effectiveSpaceId,
        opaqueId,
        name: params.spaceName,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        encryptionVersion: 2,
        keyEpoch: 1,
        currentDekBase64: dekBase64,
        dekKeyring: { 1: dekBase64 },
        createdAt: nowMs,
        updatedAt: nowMs,
        settings: initialSettings,
        rules: initialRules,
        verifier: 'SESSIONMESH_SPACE_OK',
      };

      await this.ensureRemoteSpaceDirs(client, opaqueId, this.identity.deviceId);
      const encryptedMeta = await encryptWithPassword(
        descriptor,
        params.encryptionPassword,
        metaAad,
        {
          compress: true,
          encoding: 'json',
          iterations: this.pbkdf2Iterations,
          keyEpoch: descriptor.keyEpoch,
        },
      );
      try {
        const putRes = await client.putBytes(metaPath, encryptedMeta, {
          ifNoneMatchStar: true,
          contentType: 'application/octet-stream',
        });
        spaceMetaEtag = normalizeEtag(putRes.etag);
      } catch (err) {
        // Handle simultaneous space creation race (412)
        const se = toStructuredError(err, 'join', metaPath);
        if (se.status === 412) {
          isNewSpace = false;
          const fetched = await client.getBytes(metaPath);
          spaceMetaEtag = normalizeEtag(fetched.etag);
          descriptor = await decryptWithPassword<SpaceDescriptorPayload>(
            fetched.bytes,
            params.encryptionPassword,
            metaAad,
          );
          effectiveSpaceId = descriptor.spaceId || effectiveSpaceId;
        } else {
          throw se;
        }
      }
    }

    // Ensure our device directories exist
    await this.ensureRemoteSpaceDirs(client, opaqueId, this.identity.deviceId);

    // Publish lightweight readable space-info.txt hint (contains ZERO cookies/domains/secrets)
    await this.writeRemoteSpaceInfo(params.webdav, opaqueId, {
      spaceId: effectiveSpaceId,
      spaceName: descriptor.name || params.spaceName,
      updatedAt: descriptor.updatedAt ?? nowMs,
    });

    const platform = await this.browser.getDevicePlatformInfo();
    const deviceId = this.identity.deviceId;

    const localDevice: Device = {
      deviceId,
      spaceId: effectiveSpaceId,
      name: params.deviceName || this.identity.defaultName,
      browser: platform.browser,
      browserVersion: platform.browserVersion,
      extensionVersion: platform.extensionVersion,
      platform: platform.platform,
      createdAt: nowMs,
      lastSeenAt: nowMs,
      sequence: 0,
      localRevision: 0,
      remoteRevision: 0,
      pendingEvents: 0,
      failedEvents: 0,
      checkpoint: {
        deviceId,
        spaceId: effectiveSpaceId,
        processedVectorClock: {},
        updatedAt: nowMs,
      },
      siteBindings: {},
      state: 'active',
    };

    const syncSpace: SyncSpace = {
      spaceId: effectiveSpaceId,
      opaqueId,
      name: descriptor.name || params.spaceName,
      provider: 'webdav',
      rootPath: params.webdav.rootPath,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      encryptionVersion: descriptor.encryptionVersion ?? 2,
      keyEpoch: descriptor.keyEpoch,
      createdAt: descriptor.createdAt ?? nowMs,
      updatedAt: descriptor.updatedAt ?? nowMs,
      settings: descriptor.settings,
      status: 'JOINING',
    };

    const meta: PersistedSpaceMeta = {
      space: syncSpace,
      rules: descriptor.rules ?? defaultSpaceRules(nowMs),
      deviceBlacklist,
      spaceMetaEtag,
      globalPaused: false,
      localDevice,
      remoteDevices: {},
      deviceOverrides: {},
      removedTracks: {},
      peerDeviceEtags: {},
      processedEventPaths: {},
      corruptedPaths: [],
      appliedCookieHashes: {},
      appliedLsHashes: {},
      pendingCleanLsBySite: {},
      pendingEnvLsByOrigin: {},
    };

    const dekKeyring: Record<number, string> = {
      ...(descriptor.dekKeyring ?? {}),
      [descriptor.keyEpoch]: descriptor.currentDekBase64,
    };

    if (this.keyVault && !descriptor.settings.sessionLockEnabled) {
      await this.keyVault.saveDek(effectiveSpaceId, descriptor.currentDekBase64);
    }

    this.spaceIndex[effectiveSpaceId] = {
      spaceId: effectiveSpaceId,
      opaqueId,
      name: syncSpace.name,
      webdav: params.webdav,
      status: 'JOINING',
      keyEpoch: descriptor.keyEpoch,
      dekKeyring: descriptor.settings.sessionLockEnabled ? undefined : { ...dekKeyring },
      deviceName: localDevice.name,
      createdAt: nowMs,
      updatedAt: nowMs,
    };

    const rt: LoadedSpaceRuntime = {
      spaceId: effectiveSpaceId,
      webdav: params.webdav,
      client,
      meta,
      tracks: {},
      pendingDecisions: {},
      cookies: {},
      localStorage: {},
      tombstones: {},
      pendingOutboundEvents: [],
      retryTasks: [],
      eventsHistory: [],
      conflicts: {},
      undoPoints: [],
      hlcClock: new HlcClock(deviceId),
      rulesEngine: new RulesEngine(descriptor.settings, meta.rules, deviceBlacklist),
      dekKeyring,
      encryptionPassword: params.encryptionPassword,
    };

    this.runtime = rt;
    this.activeSpaceId = effectiveSpaceId;
    this.echoSuppressor.clear();
    this.rollingTokenDamper.reset();

    // Check duplicate device identity collision on remote before publishing
    await this.checkAndResolveDuplicateDeviceId(rt);

    // Step 1 (Prohibition #2 & #3, S-001): Pull remote snapshot + peer manifests + events FIRST
    if (!isNewSpace) {
      await this.loadLatestSnapshotIfAvailable(rt);
      await this.pullRemoteInternal(rt, { applyToBrowser: false });
    }

    // Normalize optional initialManagedSiteKeys (used in opt-in `managed_only` mode)
    const initialManagedSet = new Set<string>();
    for (const rawKey of params.initialManagedSiteKeys ?? []) {
      const normalized =
        resolveSiteKey(rawKey, rt.meta.rules.ssoGroups) || normalizeDomain(rawKey);
      if (normalized) initialManagedSet.add(normalized);
    }

    // Step 2: Scan local browser cookies & run SiteDiscoveryEngine across local ∪ remote sites
    const allLocalCookies = await this.browser.getAllCookies();
    const localCookiesBySite = new Map<string, BrowserCookieInput[]>();
    for (const c of allLocalCookies) {
      const siteKey = resolveSiteKey(c.domain, rt.meta.rules.ssoGroups);
      if (!siteKey) continue;
      const list = localCookiesBySite.get(siteKey) ?? [];
      list.push(c);
      localCookiesBySite.set(siteKey, list);
    }

    const remoteSiteKeys = new Set<string>();
    for (const track of Object.values(rt.tracks)) {
      remoteSiteKeys.add(track.siteKey);
    }

    const allSiteKeys = new Set<string>([
      ...localCookiesBySite.keys(),
      ...remoteSiteKeys,
      ...initialManagedSet,
    ]);

    const autoSyncedSites: string[] = [];
    const localUploadedSites: string[] = [];
    const pendingDecisions: PendingSiteDecision[] = [];
    const excludedBlacklistedSites: string[] = [];
    const isManagedOnly = rt.meta.space.settings.syncScopeMode === 'managed_only';

    for (const siteKey of allSiteKeys) {
      const remoteTracks = Object.values(rt.tracks).filter((t) => t.siteKey === siteKey);

      // Opt-In Managed Sites Mode: skip bystander browser sites not explicitly opted-in or remotely tracked
      if (isManagedOnly && remoteTracks.length === 0 && !initialManagedSet.has(siteKey)) {
        continue;
      }

      const localSiteCookies = localCookiesBySite.get(siteKey) ?? [];
      const isBlacklisted =
        rt.rulesEngine.isBlacklisted(siteKey).blacklisted ||
        (localSiteCookies.length > 0 &&
          localSiteCookies.every((c) => rt.rulesEngine.isBlacklisted(c.domain).blacklisted));

      if (!isBlacklisted && this.isSiteExcludedByLocalDevicePolicy(rt, siteKey)) {
        continue;
      }

      const policy = this.getEffectivePolicyForDevice(rt, siteKey, siteKey);
      if (!isBlacklisted && policy.direction === 'disabled') {
        continue;
      }

      const decision = evaluateSiteDiscovery({
        siteKey,
        isBlacklisted,
        existingBinding: rt.meta.localDevice.siteBindings[siteKey],
        localCookies: localSiteCookies,
        localStorageCount: 0,
        remoteTracks,
        deviceId: rt.meta.localDevice.deviceId,
        deviceName: rt.meta.localDevice.name,
        filterNoise: rt.meta.space.settings.filterAnalyticsNoiseCookies,
        nowMs,
      });

      rt.meta.localDevice.siteBindings[siteKey] = decision.binding;

      if (decision.action === 'skip_blacklisted') {
        excludedBlacklistedSites.push(siteKey);
        continue;
      }

      if (decision.action === 'await_user_choice' && decision.pendingDecision) {
        const autoAction = resolveAutomaticSiteDecisionAction({
          localDeviceId: rt.meta.localDevice.deviceId,
          settings: rt.meta.space.settings,
          remoteTracks,
          hasLocalData: decision.pendingDecision.hasLocalData,
        });
        if (autoAction) {
          await this.resolveSiteDecisionInternal(siteKey, autoAction, {
            deferSyncAndPersist: true,
            triggerRefresh: false,
            decidedBy: 'auto',
          });
          if (autoAction.type === 'use_remote_track') {
            if (policy.direction !== 'push_only' && policy.direction !== 'disabled') {
              autoSyncedSites.push(siteKey);
            }
          } else if (
            (autoAction.type === 'use_local_override_track' ||
              autoAction.type === 'keep_independent') &&
            policy.direction !== 'pull_only' &&
            policy.direction !== 'disabled'
          ) {
            localUploadedSites.push(siteKey);
          }
          continue;
        }
        rt.pendingDecisions[siteKey] = decision.pendingDecision;
        pendingDecisions.push(decision.pendingDecision);
        continue;
      }

      if (decision.action === 'create_initial_track' && decision.createdTrack) {
        const filteredCookies = rt.meta.space.settings.filterAnalyticsNoiseCookies
          ? localSiteCookies.filter((c) => !isAnalyticsNoiseCookie(c.name))
          : localSiteCookies;

        if (filteredCookies.length === 0 && !initialManagedSet.has(siteKey)) {
          // Only noise cookies — skip creating track
          delete rt.meta.localDevice.siteBindings[siteKey];
          continue;
        }

        if (policy.excluded || policy.direction === 'disabled') {
          excludedBlacklistedSites.push(siteKey);
          continue;
        }

        if (policy.direction === 'pull_only') {
          delete rt.meta.localDevice.siteBindings[siteKey];
          continue;
        }

        rt.tracks[decision.createdTrack.trackId] = decision.createdTrack;
        if (policy.syncCookies) {
          let createdCount = 0;
          for (const c of filteredCookies) {
            if (rt.rulesEngine.isBlacklisted(c.domain).blacklisted) continue;
            const emitted = await this.emitLocalCookieUpsert(
              rt,
              siteKey,
              decision.createdTrack.trackId,
              c,
              'CREATE',
            );
            if (emitted) createdCount += 1;
          }
          decision.createdTrack.cookieCount = createdCount;
          if (createdCount > 0) {
            localUploadedSites.push(siteKey);
          }
        }
        continue;
      }

      if (
        decision.action === 'sync_bound_track' &&
        !decision.binding.trackId &&
        initialManagedSet.has(siteKey) &&
        remoteTracks.length === 0
      ) {
        if (policy.direction !== 'pull_only' && policy.direction !== 'disabled') {
          const trackId = `trk_${rt.meta.localDevice.deviceId}_${siteKey}`;
          rt.tracks[trackId] = {
            trackId,
            siteKey,
            label: `${rt.meta.localDevice.name} 的版本`,
            originDeviceId: rt.meta.localDevice.deviceId,
            originDeviceName: rt.meta.localDevice.name,
            cookieCount: 0,
            localStorageCount: 0,
            updatedAt: nowMs,
            memberDeviceIds: [rt.meta.localDevice.deviceId],
            revision: 1,
          };
          rt.meta.localDevice.siteBindings[siteKey] = {
            siteKey,
            state: 'USER_BOUND',
            trackId,
            availableTrackIds: [trackId],
            hasLocalBaseline: false,
            localCookieCount: 0,
            decidedAt: nowMs,
            decidedBy: 'user',
          };
        }
        continue;
      }

      if (decision.action === 'auto_pull_remote' && decision.binding.trackId) {
        const trackId = decision.binding.trackId;
        const track = rt.tracks[trackId];
        if (track && !track.memberDeviceIds.includes(rt.meta.localDevice.deviceId)) {
          track.memberDeviceIds.push(rt.meta.localDevice.deviceId);
          track.updatedAt = nowMs;
        }
        if (!policy.excluded && policy.direction !== 'push_only' && policy.direction !== 'disabled') {
          await this.applyTrackToBrowser(rt, siteKey, trackId, {
            cleanStale: false,
            triggerRefresh: true,
          });
          autoSyncedSites.push(siteKey);
        }
      }
    }

    // Capture LocalStorage from any already-open browser tabs for newly created/bound local tracks
    try {
      const openTabs = await this.browser.queryTabs();
      const seenOrigins = new Set<string>();
      for (const tab of openTabs) {
        if (!tab.url) continue;
        const origin = normalizeOriginSafe(tab.url);
        if (!origin || seenOrigins.has(origin)) continue;
        seenOrigins.add(origin);

        const siteKey = resolveSiteKey(origin, rt.meta.rules.ssoGroups);
        if (!siteKey || !this.isSiteManagedOrRemotelyTracked(rt, siteKey, initialManagedSet)) {
          continue;
        }
        const binding = rt.meta.localDevice.siteBindings[siteKey];
        if (
          !binding?.trackId ||
          binding.state === 'UNMANAGED' ||
          binding.state === 'BLACKLISTED' ||
          binding.state === 'PENDING_CHOICE'
        ) {
          continue;
        }
        const policy = this.getEffectivePolicyForDevice(rt, origin, siteKey);
        const sitePolicy = this.getEffectivePolicyForDevice(rt, siteKey, siteKey);
        if (
          policy.excluded ||
          sitePolicy.excluded ||
          !sitePolicy.syncLocalStorage ||
          sitePolicy.direction === 'disabled' ||
          sitePolicy.direction === 'pull_only'
        ) {
          continue;
        }
        // Only auto-seed local-only LocalStorage when this device originated the track or no remote LS exists yet
        const lsState = await this.browser.getLocalStorage(origin);
        if (!lsState.available) continue;
        for (const [k, v] of Object.entries(lsState.items)) {
          const lid = buildLocalStorageLogicalId(binding.trackId, origin, k);
          if (!rt.localStorage[lid] && !rt.tombstones[lid]) {
            const emitted = await this.emitLocalStorageUpsert(
              rt,
              siteKey,
              binding.trackId,
              origin,
              k,
              v,
              'CREATE',
            );
            if (emitted && !localUploadedSites.includes(siteKey) && !autoSyncedSites.includes(siteKey)) {
              localUploadedSites.push(siteKey);
            }
          }
        }
      }
    } catch {
      // Non-fatal if tab query is unavailable
    }

    // Step 3: Push outbound events + upload our device manifest & checkpoint
    // Clear any pre-join buffered cookie events already captured by the full initial scan
    this.changeDetector.clear();
    await this.pushOutboundInternal(rt);
    await this.uploadDeviceManifest(rt);
    await this.uploadCheckpoint(rt);

    rt.meta.lastSyncAt = this.now();
    rt.meta.space.status = this.computeStatus(rt);
    await this.persistRuntime(rt);

    await this.logger.log({
      spaceId: rt.spaceId,
      level: 'info',
      phase: 'join',
      deviceId: rt.meta.localDevice.deviceId,
      message: `${isNewSpace ? 'Created' : 'Joined'} space "${rt.meta.space.name}" (autoSynced=${autoSyncedSites.length}, uploaded=${localUploadedSites.length}, pending=${pendingDecisions.length})`,
      timestamp: this.now(),
    });

    return {
      spaceId: rt.spaceId,
      spaceName: rt.meta.space.name,
      isNewSpace,
      deviceId: rt.meta.localDevice.deviceId,
      autoSyncedSites,
      localUploadedSites,
      pendingDecisions,
      excludedBlacklistedSites,
    };
  }

  private async ensureRemoteSpaceDirs(
    client: WebDAVClient,
    opaqueId: string,
    deviceId: string,
  ): Promise<void> {
    await client.ensureDir(spaceMetaDir(opaqueId));
    await client.ensureDir(devicesDir(opaqueId));
    await client.ensureDir(deviceEventsDir(opaqueId, deviceId));
    await client.ensureDir(checkpointsDir(opaqueId));
    await client.ensureDir(snapshotsDir(opaqueId));
    await client.ensureDir(backupsDir(opaqueId));
  }

  /**
   * Detects accidental duplicate deviceId (e.g. cloned browser profile) and regenerates cleanly.
   */
  private async checkAndResolveDuplicateDeviceId(rt: LoadedSpaceRuntime): Promise<void> {
    const devPath = deviceFilePath(rt.meta.space.opaqueId, rt.meta.localDevice.deviceId);
    try {
      const stat = await rt.client.stat(devPath);
      if (!stat) return;
      const fetched = await rt.client.getBytes(devPath);
      const { data } = await decryptWithDek<RemoteDeviceManifest>(
        fetched.bytes,
        rt.dekKeyring,
        `${rt.spaceId}|`,
      );
      if (data.instanceNonce && data.instanceNonce !== this.identity.instanceNonce) {
        const oldId = rt.meta.localDevice.deviceId;
        const newId = randomId('dev');
        this.identity.deviceId = newId;
        await this.storage.set(GLOBAL_NS, 'deviceIdentity', this.identity);

        rt.meta.localDevice.deviceId = newId;
        rt.meta.localDevice.checkpoint.deviceId = newId;
        rt.hlcClock = new HlcClock(newId, rt.hlcClock.current());
        await rt.client.ensureDir(deviceEventsDir(rt.meta.space.opaqueId, newId));

        await this.logger.log({
          spaceId: rt.spaceId,
          level: 'warn',
          phase: 'device_identity',
          deviceId: newId,
          message: `Detected duplicate deviceId (${oldId}) on remote; regenerated unique deviceId (${newId})`,
          timestamp: this.now(),
        });
      }
    } catch {
      // Ignore probe failure here; regular pull will handle corrupted files
    }
  }

  async unlockSession(encryptionPassword: string, spaceId?: string): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(() => this.unlockSessionInternal(encryptionPassword, spaceId));
  }

  private async unlockSessionInternal(encryptionPassword: string, spaceId?: string): Promise<void> {
    const targetSpaceId = spaceId ?? this.activeSpaceId;
    if (!targetSpaceId || !this.spaceIndex[targetSpaceId]) {
      throw new Error('No space available to unlock');
    }

    const rt =
      this.runtime && this.runtime.spaceId === targetSpaceId
        ? this.runtime
        : await this.loadSpaceRuntime(targetSpaceId);

    this.logger.registerSecret(encryptionPassword);
    const metaPath = spaceMetaPath(rt.meta.space.opaqueId);
    const metaAad = buildSpaceMetaAad(rt.spaceId, metaPath);

    try {
      const fetched = await rt.client.getBytes(metaPath);
      const descriptor = await decryptWithPassword<SpaceDescriptorPayload>(
        fetched.bytes,
        encryptionPassword,
        metaAad,
      );
      if (!descriptor || descriptor.verifier !== 'SESSIONMESH_SPACE_OK') {
        throw new Error('DECRYPT: Invalid space verifier');
      }

      rt.encryptionPassword = encryptionPassword;
      rt.dekKeyring = {
        ...(descriptor.dekKeyring ?? {}),
        [descriptor.keyEpoch]: descriptor.currentDekBase64,
      };
      rt.meta.space.keyEpoch = descriptor.keyEpoch;
      rt.meta.spaceMetaEtag = normalizeEtag(fetched.etag);
      rt.meta.latestError = null;
      rt.meta.space.status = 'SYNCED';
      rt.meta.space.status = this.computeStatus(rt);

      if (this.keyVault && !rt.meta.space.settings.sessionLockEnabled) {
        await this.keyVault.saveDek(rt.spaceId, descriptor.currentDekBase64);
      }

      await this.persistRuntime(rt);
    } catch (err) {
      const se = toStructuredError(err, 'unlock', metaPath);
      if (se.code === 'DECRYPT_ERROR' || /decrypt/i.test(se.message)) {
        se.code = 'DECRYPT_ERROR';
        rt.meta.space.status = 'DECRYPT_ERROR';
      }
      rt.meta.latestError = se;
      await this.persistRuntime(rt);
      await this.logger.log({
        spaceId: rt.spaceId,
        level: 'error',
        phase: 'unlock',
        code: se.code,
        message: se.message,
        suggestion: se.suggestion,
        timestamp: this.now(),
      });
      throw se;
    }
  }

  async lockSession(): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.runtime;
      if (!rt) return;

      rt.encryptionPassword = undefined;
      rt.dekKeyring = {};
      rt.meta.space.status = 'LOCKED';
      if (this.keyVault) {
        await this.keyVault.clearDek(rt.spaceId);
      }
      const entry = this.spaceIndex[rt.spaceId];
      if (entry) {
        delete entry.dekKeyring;
      }
      await this.persistRuntime(rt);
    });
  }

  async switchSpace(spaceId: string, encryptionPassword?: string): Promise<void> {
    await this.ensureInitialized();
    if (this.runtime && this.runtime.spaceId !== spaceId) {
      await this.changeDetector.flush();
    }
    return this.enqueueOp(() => this.switchSpaceInternal(spaceId, encryptionPassword));
  }

  private async switchSpaceInternal(spaceId: string, encryptionPassword?: string): Promise<void> {
    if (!this.spaceIndex[spaceId]) {
      throw new Error(`Space "${spaceId}" does not exist locally`);
    }

    // Persist current space before switching context (D-011)
    if (this.runtime && this.runtime.spaceId !== spaceId) {
      await this.persistRuntime(this.runtime);
    }

    this.echoSuppressor.clear();
    this.rollingTokenDamper.reset();

    const rt = await this.loadSpaceRuntime(spaceId, encryptionPassword);
    await this.storage.set(GLOBAL_NS, 'activeSpaceId', spaceId);
    if (encryptionPassword) {
      await this.unlockSessionInternal(encryptionPassword, spaceId);
    } else {
      this.emitStateChange();
    }
    // Keep reference valid
    this.runtime = rt;
  }

  async createSpace(
    spaceId: string,
    spaceName: string,
    encryptionPassword: string,
    settingsPatch?: Partial<SpaceSettings>,
  ): Promise<InitialJoinReport> {
    await this.ensureInitialized();
    const current = this.requireRuntime();
    return this.saveAndJoinSpace({
      webdav: current.webdav,
      spaceId,
      spaceName,
      encryptionPassword,
      deviceName: current.meta.localDevice.name,
      settingsPatch,
    });
  }

  async renameSpace(spaceId: string, newName: string): Promise<void> {
    await this.ensureInitialized();
    const trimmed = newName.trim();
    if (!trimmed) throw new Error('Space name cannot be empty');

    return this.enqueueOp(async () => {
      const entry = this.spaceIndex[spaceId];
      if (!entry) throw new Error(`Space "${spaceId}" not found`);

      const nowMs = this.now();
      entry.name = trimmed;
      entry.updatedAt = nowMs;
      await this.storage.set(GLOBAL_NS, 'spaceIndex', this.spaceIndex);

      if (this.runtime && this.runtime.spaceId === spaceId) {
        const nextUpdatedAt = Math.max(nowMs, this.runtime.meta.space.updatedAt + 1);
        this.runtime.meta.space.name = trimmed;
        this.runtime.meta.space.updatedAt = nextUpdatedAt;
        await this.updateRemoteSpaceMetaIfPossible(this.runtime, (desc) => ({
          ...desc,
          name: trimmed,
          updatedAt: nextUpdatedAt,
        }));
        await this.writeRemoteSpaceInfo(this.runtime.webdav, this.runtime.meta.space.opaqueId, {
          spaceId,
          spaceName: trimmed,
          updatedAt: nextUpdatedAt,
        });
        await this.persistRuntime(this.runtime);
      } else {
        const ns = spaceNs(spaceId);
        const meta = await this.storage.get<PersistedSpaceMeta>(ns, 'meta');
        if (meta) {
          meta.space.name = trimmed;
          meta.space.updatedAt = Math.max(nowMs, meta.space.updatedAt + 1);
          await this.storage.set(ns, 'meta', meta);
        }
        await this.writeRemoteSpaceInfo(entry.webdav, entry.opaqueId, {
          spaceId,
          spaceName: trimmed,
          updatedAt: nowMs,
        });
        this.emitStateChange();
      }
    });
  }

  async rotateSpacePassword(oldPassword: string, newPassword: string): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      this.logger.registerSecret(oldPassword);
      this.logger.registerSecret(newPassword);

      if (!newPassword || newPassword.trim().length === 0) {
        throw new Error('New encryption password cannot be empty');
      }

      const metaPath = spaceMetaPath(rt.meta.space.opaqueId);
      const metaAad = buildSpaceMetaAad(rt.spaceId, metaPath);

      const fetched = await rt.client.getBytes(metaPath);
      let descriptor: SpaceDescriptorPayload;
      try {
        descriptor = await decryptWithPassword<SpaceDescriptorPayload>(
          fetched.bytes,
          oldPassword,
          metaAad,
        );
        if (!descriptor || descriptor.verifier !== 'SESSIONMESH_SPACE_OK') {
          throw new Error('DECRYPT: Invalid space verifier');
        }
      } catch (err) {
        const se = toStructuredError(err, 'rotate_password', metaPath);
        se.code = 'DECRYPT_ERROR';
        throw se;
      }

      const newEpoch = (descriptor.keyEpoch ?? 1) + 1;
      const newDek = await generateSpaceDekBase64();
      const updatedKeyring: Record<number, string> = {
        ...(descriptor.dekKeyring ?? {}),
        [descriptor.keyEpoch]: descriptor.currentDekBase64,
        [newEpoch]: newDek,
      };

      const updatedDescriptor: SpaceDescriptorPayload = {
        ...descriptor,
        keyEpoch: newEpoch,
        currentDekBase64: newDek,
        dekKeyring: updatedKeyring,
        updatedAt: this.now(),
      };

      const encrypted = await encryptWithPassword(updatedDescriptor, newPassword, metaAad, {
        compress: true,
        encoding: 'json',
        iterations: this.pbkdf2Iterations,
        keyEpoch: newEpoch,
      });

      const putRes = await rt.client.putBytes(metaPath, encrypted, {
        ifMatch: normalizeEtag(fetched.etag),
        contentType: 'application/octet-stream',
      });

      rt.encryptionPassword = newPassword;
      rt.dekKeyring = updatedKeyring;
      rt.meta.space.keyEpoch = newEpoch;
      rt.meta.space.updatedAt = this.now();
      rt.meta.spaceMetaEtag = normalizeEtag(putRes.etag);
      rt.meta.latestError = null;
      rt.meta.space.status = 'SYNCED';
      rt.meta.space.status = this.computeStatus(rt);

      if (this.keyVault && !rt.meta.space.settings.sessionLockEnabled) {
        await this.keyVault.saveDek(rt.spaceId, newDek);
      }

      await this.uploadDeviceManifest(rt);
      await this.persistRuntime(rt);

      await this.logger.log({
        spaceId: rt.spaceId,
        level: 'info',
        phase: 'rotate_password',
        message: `Rotated space encryption password and DEK to keyEpoch ${newEpoch}`,
        timestamp: this.now(),
      });
    });
  }

  async deleteLocalSpace(spaceId: string, deleteRemote = false): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const entry = this.spaceIndex[spaceId];
      if (!entry) return;

      if (deleteRemote) {
        const client = new WebDAVClient(entry.webdav, this.webdavClientOptions);
        try {
          await client.delete(spaceBasePath(entry.opaqueId));
        } catch (err) {
          const se = toStructuredError(err, 'delete_space');
          if (se.status !== 404) {
            throw se;
          }
        }
      }

      await this.storage.clearNamespace(spaceNs(spaceId));
      if (this.keyVault) {
        await this.keyVault.clearDek(spaceId);
      }
      delete this.spaceIndex[spaceId];
      await this.storage.set(GLOBAL_NS, 'spaceIndex', this.spaceIndex);

      if (this.activeSpaceId === spaceId) {
        // Drop in-memory runtime & pending buffer BEFORE switching so switchSpace
        // NEVER re-persists the deleted space's data back into IndexedDB!
        this.changeDetector.clear();
        this.runtime = null;
        const remainingIds = Object.keys(this.spaceIndex);
        if (remainingIds.length > 0) {
          await this.switchSpaceInternal(remainingIds[0]);
        } else {
          this.activeSpaceId = null;
          await this.storage.set(GLOBAL_NS, 'activeSpaceId', null);
          this.emitStateChange();
        }
      } else {
        this.emitStateChange();
      }
    });
  }

  async generatePairingCode(passphrase: string): Promise<string> {
    await this.ensureInitialized();
    const rt = this.requireRuntime();
    if (!passphrase || passphrase.trim().length === 0) {
      throw new Error('Passphrase is required to generate pairing code');
    }
    this.logger.registerSecret(passphrase);
    const payload: PairingPayload = {
      version: 1,
      webdav: rt.webdav,
      spaceId: rt.spaceId,
      spaceName: rt.meta.space.name,
      createdAt: this.now(),
      fromDeviceName: rt.meta.localDevice.name,
    };
    return cryptoEncodePairingCode(payload, passphrase);
  }

  async decodePairingCode(
    code: string,
    passphrase: string,
  ): Promise<{
    webdav: WebDAVConfig;
    spaceId: string;
    spaceName: string;
    fromDeviceName: string;
  }> {
    await this.ensureInitialized();
    this.logger.registerSecret(passphrase);
    const payload = await cryptoDecodePairingCode(code, passphrase);
    this.registerConfigSecrets(payload.webdav);
    return {
      webdav: payload.webdav,
      spaceId: payload.spaceId,
      spaceName: payload.spaceName,
      fromDeviceName: payload.fromDeviceName,
    };
  }

  // =========================================================================
  // Sync Operations & Triggers
  // =========================================================================

  async syncNow(options?: {
    siteKey?: string;
    direction?: 'both' | 'push' | 'pull';
    triggerRefresh?: boolean;
    /** Explicit user click (e.g. "立即同步"): allows probing recovery after a prior 507 storage-full halt. */
    userInitiated?: boolean;
  }): Promise<{
    pushedEvents: number;
    pulledEvents: number;
    appliedCookies: number;
    failedCookies: number;
    errorMessage?: string;
    errorCode?: string;
  }> {
    await this.ensureInitialized();
    await this.changeDetector.flush();
    return this.enqueueOp(() => this.syncNowInternal(options));
  }

  private async syncNowInternal(options?: {
    siteKey?: string;
    direction?: 'both' | 'push' | 'pull';
    triggerRefresh?: boolean;
    userInitiated?: boolean;
  }): Promise<{
    pushedEvents: number;
    pulledEvents: number;
    appliedCookies: number;
    failedCookies: number;
    errorMessage?: string;
    errorCode?: string;
  }> {
    const rt = this.runtime;
    if (!rt) {
      return { pushedEvents: 0, pulledEvents: 0, appliedCookies: 0, failedCookies: 0 };
    }

    const direction = options?.direction ?? 'both';
    const siteKeyFilter = options?.siteKey;
    const triggerRefresh = options?.triggerRefresh ?? true;

    // Guard against locked / decrypt_error / paused / removed / revoked states
    if (
      !rt.dekKeyring[rt.meta.space.keyEpoch] ||
      rt.meta.space.status === 'DECRYPT_ERROR' ||
      rt.meta.space.status === 'LOCKED'
    ) {
      return { pushedEvents: 0, pulledEvents: 0, appliedCookies: 0, failedCookies: 0 };
    }

    if (rt.meta.globalPaused || rt.meta.localDevice.state !== 'active') {
      return { pushedEvents: 0, pulledEvents: 0, appliedCookies: 0, failedCookies: 0 };
    }

    const localDevPolicy = this.getLocalDevicePolicy(rt);
    if (localDevPolicy?.direction === 'disabled') {
      return { pushedEvents: 0, pulledEvents: 0, appliedCookies: 0, failedCookies: 0 };
    }

    if (!this.isOnline()) {
      rt.meta.space.status = 'OFFLINE';
      if (rt.pendingOutboundEvents.length > 0) {
        rt.meta.consecutiveTransientFailures = (rt.meta.consecutiveTransientFailures ?? 0) + 1;
        this.upsertRetryTask(rt, 'push_events', 'ERR_NETWORK_OFFLINE', 'Device is offline');
      }
      await this.persistRuntime(rt);
      return {
        pushedEvents: 0,
        pulledEvents: 0,
        appliedCookies: 0,
        failedCookies: 0,
        errorMessage: '当前设备处于离线状态，恢复联网后将自动补偿同步。',
        errorCode: 'ERR_NETWORK_OFFLINE',
      };
    }

    const startMs = this.now();
    rt.meta.space.status = 'SYNCING';

    let pushedEvents = 0;
    let pulledEvents = 0;
    let appliedCookies = 0;
    let failedCookies = 0;
    let errorMessage: string | undefined;
    let errorCode: string | undefined;

    try {
      const canPushBeforePull = localDevPolicy?.direction !== 'pull_only';
      // Explicit user-initiated sync probes recovery after a 507 storage-full halt
      // (if server is still full, 507 catch immediately re-trips storageFullHalted).
      if (options?.userInitiated && rt.meta.storageFullHalted && (direction === 'both' || direction === 'push')) {
        rt.meta.storageFullHalted = false;
      }
      // 1. Push outbound events if direction allows (explicit sync bypasses cooldown/backoff/on_page_leave hold)
      if ((direction === 'both' || direction === 'push') && canPushBeforePull) {
        // Reconcile live open-tab localStorage changes (CREATE/UPDATE/DELETE) before pushing so
        // explicit "立即同步" / "当前网站上传" never misses recent SPA token mutations waiting on content-script poll!
        if (rt.meta.space.settings.syncLocalStorage) {
          try {
            const openTabs = await this.browser.queryTabs();
            const openSiteKeys = new Set<string>();
            for (const tab of openTabs) {
              const origin = tab.url ? normalizeOriginSafe(tab.url) : null;
              if (!origin) continue;
              const sk = resolveSiteKey(origin, rt.meta.rules.ssoGroups);
              if (!sk) continue;
              if (siteKeyFilter && sk !== siteKeyFilter) continue;
              openSiteKeys.add(sk);
            }
            for (const sk of openSiteKeys) {
              if (rt.rulesEngine.isBlacklisted(sk).blacklisted) continue;
              const binding = rt.meta.localDevice.siteBindings[sk];
              if (
                !binding?.trackId ||
                binding.state === 'BLACKLISTED' ||
                binding.state === 'UNMANAGED' ||
                binding.state === 'PENDING_CHOICE'
              ) {
                continue;
              }
              await this.reconcileOpenTabLocalStorage(rt, sk, binding.trackId, {
                prequeriedTabs: openTabs,
                allowLocalTrackSwitch: false,
                detectDeletes: Boolean(options?.userInitiated),
              });
            }
          } catch {
            // Non-fatal: continue pushing queued events even if tab query fails
          }
        }
        pushedEvents = await this.pushOutboundInternal(rt, siteKeyFilter);
        if (siteKeyFilter) {
          this.deferredOnPageLeaveSites.delete(siteKeyFilter);
          this.releasedOnPageLeaveSites.delete(siteKeyFilter);
        } else {
          this.deferredOnPageLeaveSites.clear();
          this.releasedOnPageLeaveSites.clear();
        }
      }

      // 2. Pull remote events & apply to browser if direction allows
      if (direction === 'both' || direction === 'pull') {
        const pullRes = await this.pullRemoteInternal(rt, {
          applyToBrowser: true,
          siteKeyFilter,
          triggerRefresh,
        });
        pulledEvents = pullRes.pulledEvents;
        appliedCookies = pullRes.appliedCookies;
        failedCookies = pullRes.failedCookies;

        // If device was just marked removed/revoked by a peer override, halt immediately (D-013)
        if (rt.meta.localDevice.state !== 'active') {
          rt.meta.space.status = rt.meta.localDevice.state === 'paused' ? 'PAUSED' : 'LOCKED';
          await this.persistRuntime(rt);
          return { pushedEvents, pulledEvents, appliedCookies, failedCookies };
        }

        // If auto-resolution during pull queued new outbound events (e.g. keep_independent or authority override), push them immediately
        const postPullDevPolicy = this.getLocalDevicePolicy(rt);
        const canPushAfterPull =
          postPullDevPolicy?.direction !== 'pull_only' &&
          postPullDevPolicy?.direction !== 'disabled';
        if (
          direction === 'both' &&
          canPushAfterPull &&
          rt.pendingOutboundEvents.length > 0 &&
          !rt.meta.storageFullHalted
        ) {
          pushedEvents += await this.pushOutboundInternal(rt, siteKeyFilter);
        }

        // Upload updated checkpoint/device manifest if pull changed our bindings or vector clock
        if (pullRes.updatedCheckpoint && !rt.meta.storageFullHalted) {
          try {
            await this.uploadCheckpoint(rt);
          } catch {
            // Checkpoint upload failure is non-fatal
          }
        }
        if (pullRes.updatedLocalBindings && !rt.meta.storageFullHalted) {
          try {
            await this.uploadDeviceManifest(rt);
          } catch {
            // Non-fatal
          }
        }
      }

      const doneMs = this.now();
      rt.meta.lastSyncAt = doneMs;
      rt.meta.lastLatencyMs = Math.max(0, doneMs - startMs);
      if (pushedEvents > 0) {
        rt.meta.lastAutoPushAt = doneMs;
      }
      rt.meta.consecutiveTransientFailures = 0;
      rt.meta.autoPushBackoffUntilMs = undefined;
      if (!rt.meta.storageFullHalted) {
        rt.meta.latestError = null;
        if (rt.pendingOutboundEvents.length === 0) {
          for (const task of rt.retryTasks) {
            if (task.status === 'RETRYING' || task.status === 'FAILED') {
              task.status = 'SUCCEEDED';
              task.completedAt = doneMs;
            }
          }
        }
      }
      rt.meta.space.status = this.computeStatus(rt);
      await this.persistRuntime(rt);
    } catch (err) {
      const se = toStructuredError(err, 'sync');
      const errNow = this.now();
      rt.meta.latestError = se;
      errorMessage = se.message;
      errorCode = se.code;

      if (se.code === 'ERR_STORAGE_FULL' || se.status === 507) {
        rt.meta.storageFullHalted = true;
        this.haltWriteRetryTasks(rt, se);
        rt.meta.space.status = 'PARTIAL';
      } else if (se.code === 'DECRYPT_ERROR') {
        rt.encryptionPassword = undefined;
        rt.meta.space.status = 'DECRYPT_ERROR';
      } else if (se.status === 401 || se.status === 403) {
        rt.meta.space.status = 'AUTH_ERROR';
      } else if (this.isTransientRetryableError(se)) {
        const failures = (rt.meta.consecutiveTransientFailures ?? 0) + 1;
        rt.meta.consecutiveTransientFailures = failures;
        const retryAfterMs = (err as { retryAfterMs?: number })?.retryAfterMs;
        const baseBackoff = Math.min(180_000, 15_000 * 2 ** Math.min(failures - 1, 4));
        const backoffMs =
          typeof retryAfterMs === 'number' && retryAfterMs > 0
            ? Math.min(180_000, Math.max(5_000, retryAfterMs))
            : baseBackoff;
        if (this.autoPushCooldownMs > 0) {
          rt.meta.autoPushBackoffUntilMs = errNow + backoffMs;
        }
        this.upsertRetryTask(rt, 'push_events', se.code, se.message);
        rt.meta.space.status =
          se.code === 'ERR_NETWORK_OFFLINE' ? 'OFFLINE' : this.computeStatus(rt);
      } else {
        rt.meta.space.status = 'PARTIAL';
      }

      await this.logger.log({
        spaceId: rt.spaceId,
        level: this.isTransientRetryableError(se) ? 'warn' : 'error',
        phase: se.phase,
        code: se.code,
        message: se.message,
        suggestion: se.suggestion,
        deviceId: rt.meta.localDevice.deviceId,
        timestamp: errNow,
      });
      await this.persistRuntime(rt);
    }

    return {
      pushedEvents,
      pulledEvents,
      appliedCookies,
      failedCookies,
      errorMessage,
      errorCode,
    };
  }

  async onSiteVisited(url: string): Promise<void> {
    await this.ensureInitialized();
    const rt = this.runtime;
    if (!rt || !rt.meta.space.settings.checkOnNavigate) return;
    if (rt.meta.globalPaused || rt.meta.localDevice.state !== 'active') return;

    const siteKey = resolveSiteKey(url, rt.meta.rules.ssoGroups);
    if (!siteKey) return;

    const policy = this.getEffectivePolicyForDevice(rt, url, siteKey);
    if (policy.excluded || policy.direction === 'disabled') return;

    const alreadyKnownManaged = this.isSiteManagedOrRemotelyTracked(rt, siteKey);
    const nowMs = this.now();
    const inBackoff =
      this.autoPushCooldownMs > 0 &&
      Boolean(rt.meta.autoPushBackoffUntilMs) &&
      nowMs < (rt.meta.autoPushBackoffUntilMs ?? 0);

    if (!alreadyKnownManaged) {
      // A peer device may have newly added this site to the shared space since our last poll!
      // Perform a lightweight ETag-short-circuited pull (throttled) so opening a newly shared site on Device B works immediately.
      const unknownSiteCooldownMs = rt.meta.space.settings.lowFrequencyMode ? 30_000 : 8_000;
      const recentlyCheckedUnknown =
        this.autoPushCooldownMs > 0 && nowMs - this.lastAnySiteVisitPullAt < unknownSiteCooldownMs;
      if (!inBackoff && !recentlyCheckedUnknown) {
        this.lastAnySiteVisitPullAt = nowMs;
        await this.syncNow({ direction: 'pull', triggerRefresh: false });
      }
      // If still not managed or remotely tracked after checking cloud, stay 100% hands-off (never scrape/upload unmanaged sites)
      if (!this.isSiteManagedOrRemotelyTracked(rt, siteKey)) return;
    } else {
      const prevSitePull = this.lastSiteVisitPullAt.get(siteKey) ?? 0;
      const siteRecentlyPulled = this.autoPushCooldownMs > 0 && nowMs - prevSitePull < 15_000;
      const anyRecentlyPulled =
        this.autoPushCooldownMs > 0 && nowMs - this.lastAnySiteVisitPullAt < 5_000;

      if (!inBackoff && !siteRecentlyPulled && !anyRecentlyPulled) {
        this.lastSiteVisitPullAt.set(siteKey, nowMs);
        this.lastAnySiteVisitPullAt = nowMs;
        // Pull & apply ALL managed remote updates in one WebDAV round-trip (so multi-tab restore never skips sibling sites)
        await this.syncNow({ direction: 'pull', triggerRefresh: false });
      }
    }

    // If LocalStorage sync is enabled, check origin context and apply any pending remote LS
    const origin = normalizeOriginSafe(url);
    if (origin && policy.syncLocalStorage) {
      const ls = await this.browser.getLocalStorage(origin);
      if (ls.available) {
        await this.ingestLocalStorageSnapshot(origin, ls.items);
      }
    }
  }

  /**
   * Called when a tab closes (`tabs.onRemoved`), navigates away to another site, or fires `pagehide`.
   * In `on_page_leave` timing mode, releases the site's compacted local changes for automatic background upload.
   */
  async onSitePageLeft(siteKeyOrUrl: string): Promise<void> {
    await this.ensureInitialized();
    const rt = this.runtime;
    if (!rt) return;
    const siteKey =
      resolveSiteKey(siteKeyOrUrl, rt.meta.rules.ssoGroups) || normalizeDomain(siteKeyOrUrl);
    if (!siteKey) return;

    await this.changeDetector.flush();
    await this.enqueueOp(async () => {
      const activeRt = this.runtime;
      if (!activeRt) return;
      const openSites = await this.getOpenTabSiteKeys(activeRt);
      if (openSites.has(siteKey)) {
        // User stayed on the same site (same-site link navigation / reload, or another tab for
        // this site is still open): keep buffered changes deferred until the last tab leaves/closes.
        this.releasedOnPageLeaveSites.delete(siteKey);
        if (activeRt.pendingOutboundEvents.some((ev) => ev.siteKey === siteKey)) {
          this.deferredOnPageLeaveSites.add(siteKey);
          activeRt.meta.space.status = this.computeStatus(activeRt);
          await this.persistRuntime(activeRt);
        }
        return;
      }
      this.deferredOnPageLeaveSites.delete(siteKey);
      this.releasedOnPageLeaveSites.add(siteKey);
      const hasPending =
        activeRt.pendingOutboundEvents.some((ev) => ev.siteKey === siteKey) ||
        activeRt.meta.manifestDirty;
      if (!hasPending) {
        this.releasedOnPageLeaveSites.delete(siteKey);
        return;
      }
      await this.attemptAutoPush(activeRt, 'page_leave_push');
    });
  }

  async flushPendingLocalChanges(): Promise<void> {
    await this.ensureInitialized();
    const attemptsBefore = this.autoPushAttemptCount;
    await this.changeDetector.flush();
    await this.enqueueOp(async () => {
      const rt = this.runtime;
      if (!rt) return;
      // Drain queued pending outbound events or dirty manifest once cooldown/backoff elapses
      if (
        this.autoPushAttemptCount === attemptsBefore &&
        (rt.pendingOutboundEvents.length > 0 || rt.meta.manifestDirty)
      ) {
        await this.attemptAutoPush(rt, 'scheduled_flush');
        return;
      }
      await this.persistRuntime(rt);
    });
  }

  /**
   * Reconciles live browser cookies for already-bound managed sites against the last known
   * synced/applied cookie hashes. Recovers any login/cookie change that happened right before
   * an abrupt browser exit or crash (before ChangeDetector's debounce could persist to IndexedDB),
   * without ever overwriting newer remote peer updates or falsely deleting cleared session cookies.
   */
  async reconcileLocalManagedCookies(): Promise<number> {
    await this.ensureInitialized();
    await this.changeDetector.flush();
    return this.enqueueOp(async () => {
      const rt = this.runtime;
      if (!rt) return 0;
      if (
        rt.meta.globalPaused ||
        rt.meta.localDevice.state !== 'active' ||
        rt.meta.storageFullHalted ||
        !rt.dekKeyring[rt.meta.space.keyEpoch]
      ) {
        return 0;
      }
      const localDevPolicy = this.getLocalDevicePolicy(rt);
      if (localDevPolicy?.direction === 'disabled' || localDevPolicy?.direction === 'pull_only') {
        return 0;
      }

      const allCookies = await this.browser.getAllCookies();
      const nowSec = this.now() / 1000;
      let recoveredCount = 0;

      for (const cookie of allCookies) {
        if (!cookie.session && cookie.expirationDate !== undefined && cookie.expirationDate <= nowSec) {
          continue;
        }
        const siteKey = resolveSiteKey(cookie.domain, rt.meta.rules.ssoGroups);
        if (!siteKey) continue;

        const binding = rt.meta.localDevice.siteBindings[siteKey];
        if (
          !binding ||
          !binding.trackId ||
          binding.state === 'BLACKLISTED' ||
          binding.state === 'PENDING_CHOICE' ||
          binding.state === 'UNMANAGED'
        ) {
          continue;
        }
        if (
          rt.meta.space.settings.filterAnalyticsNoiseCookies &&
          isAnalyticsNoiseCookie(cookie.name)
        ) {
          continue;
        }

        const policy = this.getEffectivePolicyForDevice(rt, cookie.domain, siteKey);
        const sitePolicy = this.getEffectivePolicyForDevice(rt, siteKey, siteKey);
        if (
          policy.excluded ||
          sitePolicy.excluded ||
          !sitePolicy.syncCookies ||
          sitePolicy.direction === 'disabled' ||
          sitePolicy.direction === 'pull_only'
        ) {
          continue;
        }

        const storeScope = normalizeCookieStoreScope(cookie.storeId);
        const isHostPrefix = cookie.name.startsWith('__Host-');
        const hostOnly = resolveEffectiveHostOnly(cookie.domain, cookie.hostOnly, cookie.name);
        const normDomain = normalizeCookieDomain(cookie.domain, hostOnly);
        const path = isHostPrefix ? '/' : cookie.path || '/';
        const secure =
          isHostPrefix ||
          cookie.name.startsWith('__Secure-') ||
          cookie.sameSite === 'no_restriction'
            ? true
            : cookie.secure;

        const logicalId = buildCookieLogicalId({
          trackId: binding.trackId,
          storeScope,
          partitionKey: cookie.partitionKey,
          hostOnly,
          domain: normDomain,
          path,
          name: cookie.name,
        });

        const liveHash = cookieContentCanonicalHash({
          ...cookie,
          domain: normDomain,
          path,
          hostOnly,
          secure,
        });

        const existing = rt.cookies[logicalId];
        const lastAppliedHash = rt.meta.appliedCookieHashes[logicalId];
        // If live cookie matches either last applied hash or current known record, no missed local edit occurred
        if (lastAppliedHash && lastAppliedHash === liveHash) {
          continue;
        }
        if (existing && !existing.deleted && cookieContentCanonicalHash(existing) === liveHash) {
          rt.meta.appliedCookieHashes[logicalId] = liveHash;
          continue;
        }
        // If a remote peer owns an unapplied record (never applied to this browser yet), don't clobber it on startup
        if (!lastAppliedHash && existing && existing.sourceDevice !== rt.meta.localDevice.deviceId) {
          continue;
        }

        const emitted = await this.emitLocalCookieUpsert(
          rt,
          siteKey,
          binding.trackId,
          cookie,
          existing && !existing.deleted ? 'UPDATE' : 'CREATE',
        );
        if (emitted) {
          recoveredCount += 1;
        }
      }

      if (recoveredCount > 0) {
        rt.meta.space.status = this.computeStatus(rt);
        await this.persistRuntime(rt);
        await this.attemptAutoPush(rt, 'startup_reconcile_push');
      }

      return recoveredCount;
    });
  }

  async setGlobalPaused(paused: boolean): Promise<void> {
    await this.ensureInitialized();
    const rt = this.requireRuntime();
    rt.meta.globalPaused = paused;
    rt.meta.space.status = paused ? 'PAUSED' : this.computeStatus(rt);
    await this.persistRuntime(rt);
  }

  async updateSpaceSettings(patch: Partial<SpaceSettings>): Promise<SpaceSettings> {
    await this.ensureInitialized();
    const rt = this.requireRuntime();
    const nextUpdatedAt = Math.max(this.now(), rt.meta.space.updatedAt + 1);

    rt.meta.space.settings = {
      ...rt.meta.space.settings,
      ...patch,
      devicePolicies:
        patch.devicePolicies !== undefined
          ? { ...patch.devicePolicies }
          : { ...(rt.meta.space.settings.devicePolicies ?? {}) },
    };
    rt.meta.space.updatedAt = nextUpdatedAt;
    rt.rulesEngine.update(rt.meta.space.settings, rt.meta.rules, rt.meta.deviceBlacklist);

    if (rt.meta.space.settings.sessionLockEnabled && this.keyVault) {
      await this.keyVault.clearDek(rt.spaceId);
    } else if (!rt.meta.space.settings.sessionLockEnabled && this.keyVault) {
      const dek = rt.dekKeyring[rt.meta.space.keyEpoch];
      if (dek) {
        await this.keyVault.saveDek(rt.spaceId, dek);
      }
    }

    await this.updateRemoteSpaceMetaIfPossible(rt, (desc) => ({
      ...desc,
      settings: rt.meta.space.settings,
      updatedAt: nextUpdatedAt,
    }));
    await this.uploadDeviceManifestIfOnline(rt);
    await this.persistRuntime(rt);

    return { ...rt.meta.space.settings };
  }

  // =========================================================================
  // Core Push / Pull & Change Handling
  // =========================================================================

  private async handleFlushedCookieChanges(changes: CoalescedCookieChange[]): Promise<void> {
    const rt = this.runtime;
    if (!rt) return;
    if (rt.meta.globalPaused || rt.meta.localDevice.state !== 'active') return;
    if (!rt.dekKeyring[rt.meta.space.keyEpoch]) return;

    const changedSourceSites = new Set<string>();
    for (const change of changes) {
      if (change.cause !== 'expired' && change.cause !== 'evicted') {
        const sk = resolveSiteKey(change.cookie.domain, rt.meta.rules.ssoGroups);
        if (sk) changedSourceSites.add(sk);
      }
    }

    const localDevPolicy = this.getLocalDevicePolicy(rt);
    if (localDevPolicy?.direction === 'disabled' || localDevPolicy?.direction === 'pull_only') {
      if (changedSourceSites.size > 0) {
        await this.runAutoEnvSyncForSourceSites(rt, changedSourceSites);
      }
      return;
    }

    const nowMs = this.now();
    let activeSiteKeys: Set<string> | null = null;
    let mutated = false;

    for (const change of changes) {
      const cookie = change.cookie;
      const siteKey = resolveSiteKey(cookie.domain, rt.meta.rules.ssoGroups);
      if (!siteKey) continue;

      // Enforce Opt-In Managed Sites mode & explicit UNMANAGED exclusions
      if (!this.isSiteManagedOrRemotelyTracked(rt, siteKey)) {
        continue;
      }

      // Filter analytics noise cookies if enabled
      if (rt.meta.space.settings.filterAnalyticsNoiseCookies && isAnalyticsNoiseCookie(cookie.name)) {
        continue;
      }

      // Check blacklist, per-device policy & per-site policy
      const policy = this.getEffectivePolicyForDevice(rt, cookie.domain, siteKey);
      const sitePolicy = this.getEffectivePolicyForDevice(rt, siteKey, siteKey);
      if (policy.excluded || sitePolicy.excluded || !sitePolicy.syncCookies) {
        continue;
      }
      if (sitePolicy.direction === 'disabled' || sitePolicy.direction === 'pull_only') {
        continue;
      }

      let binding = rt.meta.localDevice.siteBindings[siteKey];
      if (
        binding?.state === 'BLACKLISTED' ||
        binding?.state === 'PENDING_CHOICE' ||
        binding?.state === 'UNMANAGED'
      ) {
        continue;
      }

      // Auto-discover binding for newly visited/logged-in site
      if (!binding || !binding.trackId) {
        if (change.kind === 'delete') continue;
        const remoteTracks = Object.values(rt.tracks).filter((t) => t.siteKey === siteKey);
        const decision = evaluateSiteDiscovery({
          siteKey,
          isBlacklisted: false,
          existingBinding: binding,
          localCookies: [cookie],
          localStorageCount: 0,
          remoteTracks,
          deviceId: rt.meta.localDevice.deviceId,
          deviceName: rt.meta.localDevice.name,
          filterNoise: rt.meta.space.settings.filterAnalyticsNoiseCookies,
          nowMs,
        });
        rt.meta.localDevice.siteBindings[siteKey] = decision.binding;
        binding = decision.binding;

        if (decision.action === 'await_user_choice' && decision.pendingDecision) {
          const autoAction = resolveAutomaticSiteDecisionAction({
            localDeviceId: rt.meta.localDevice.deviceId,
            settings: rt.meta.space.settings,
            remoteTracks,
            hasLocalData: decision.pendingDecision.hasLocalData,
          });
          if (autoAction) {
            await this.resolveSiteDecisionInternal(siteKey, autoAction, {
              deferSyncAndPersist: true,
              triggerRefresh: true,
              decidedBy: 'auto',
            });
            binding = rt.meta.localDevice.siteBindings[siteKey];
            mutated = true;
            if (autoAction.type === 'use_remote_track') {
              continue;
            }
          } else {
            rt.pendingDecisions[siteKey] = decision.pendingDecision;
            mutated = true;
            continue;
          }
        }
        if (decision.createdTrack) {
          rt.tracks[decision.createdTrack.trackId] = decision.createdTrack;
          mutated = true;
        }
      }

      const trackId = binding?.trackId;
      if (!trackId) continue;

      // RollingTokenDamper check (Optimization #7)
      const echoKey = buildEchoCookieKey(cookie);
      if (change.kind === 'upsert') {
        this.rollingTokenDamper.recordUpdate(echoKey, siteKey, rt.meta.localDevice.deviceId, nowMs);
        if (this.rollingTokenDamper.isCookieDamped(echoKey, nowMs)) {
          if (activeSiteKeys === null) {
            activeSiteKeys = await this.getActiveTabSiteKeys(rt);
          }
          const hasActiveTab = activeSiteKeys.has(siteKey);
          if (this.rollingTokenDamper.shouldSuppressLocalPush(echoKey, siteKey, hasActiveTab, nowMs)) {
            await this.logger.log({
              spaceId: rt.spaceId,
              level: 'warn',
              phase: 'rolling_token_damper',
              siteKey,
              message: `Suppressed background-device push for damped rolling token cookie "${cookie.name}"`,
              timestamp: nowMs,
            });
            continue;
          }
        }

        // Defense-in-depth: if this cookie was explicitly tombstoned right before a stale
        // debounced upsert flushed (e.g. user deleted the cookie within the debounce window),
        // verify it still exists in the live browser jar before resurrecting the tombstone!
        const isHostPrefixUp = cookie.name.startsWith('__Host-');
        const effHostOnlyUp = resolveEffectiveHostOnly(cookie.domain, cookie.hostOnly, cookie.name);
        const effPathUp = isHostPrefixUp ? '/' : cookie.path || '/';
        const upsertLogicalId = buildCookieLogicalId({
          trackId,
          storeScope: normalizeCookieStoreScope(cookie.storeId),
          partitionKey: cookie.partitionKey,
          hostOnly: effHostOnlyUp,
          domain: normalizeCookieDomain(cookie.domain, effHostOnlyUp),
          path: effPathUp,
          name: cookie.name,
        });
        if (rt.cookies[upsertLogicalId]?.deleted) {
          const liveCookie = await this.browser.getCookie({
            url: buildCookieUrl(cookie),
            name: cookie.name,
            storeId: cookie.storeId,
            partitionKey: cookie.partitionKey,
          });
          if (!liveCookie) {
            continue;
          }
        }

        // Clear session-rejected guard when user actively logs in locally again
        this.autoRefresh.clearSessionRejected(siteKey);

        const emitted = await this.emitLocalCookieUpsert(rt, siteKey, trackId, cookie, 'UPDATE');
        if (emitted) mutated = true;
      } else {
        // S-015: Distinguish explicit removal / HTTP Set-Cookie Max-Age=0 (`expired_overwrite`)
        // vs natural clock expiration (`expired`) / browser LRU eviction (`evicted`)
        const isHostPrefix = cookie.name.startsWith('__Host-');
        const effectiveHostOnly = resolveEffectiveHostOnly(
          cookie.domain,
          cookie.hostOnly,
          cookie.name,
        );
        const effectivePath = isHostPrefix ? '/' : cookie.path || '/';
        const logicalId = buildCookieLogicalId({
          trackId,
          storeScope: normalizeCookieStoreScope(cookie.storeId),
          partitionKey: cookie.partitionKey,
          hostOnly: effectiveHostOnly,
          domain: normalizeCookieDomain(cookie.domain, effectiveHostOnly),
          path: effectivePath,
          name: cookie.name,
        });
        const existing = rt.cookies[logicalId];

        if (change.cause === 'expired') {
          // Natural timer expiration: mark local record as EXPIRED without emitting a destructive cross-device logout tombstone
          if (existing && !existing.deleted) {
            existing.syncStatus = 'EXPIRED';
            existing.updatedAt = nowMs;
            mutated = true;
            await this.logger.log({
              spaceId: rt.spaceId,
              level: 'info',
              phase: 'change_detector',
              siteKey,
              objectId: logicalId,
              message: `Cookie "${cookie.name}" expired locally (not propagated as explicit logout)`,
              timestamp: nowMs,
            });
          }
          continue;
        }

        if (change.cause === 'evicted') {
          if (existing && !existing.deleted) {
            existing.syncStatus = 'REMOTE_ONLY';
            existing.updatedAt = nowMs;
            mutated = true;
          }
          continue;
        }

        // Explicit removal or HTTP `Set-Cookie: Max-Age=0` (`expired_overwrite`) -> emit DELETE + Tombstone (S-007)
        if (existing && !existing.deleted && existing.syncStatus !== 'REMOTE_ONLY') {
          const reason: TombstoneReason =
            change.cause === 'expired_overwrite' ? 'logout' : 'explicit';
          await this.emitLocalCookieDelete(rt, existing, reason, reason);
          mutated = true;
        }
      }
    }

    if (mutated) {
      rt.meta.space.status = this.computeStatus(rt);
      await this.persistRuntime(rt);
      await this.attemptAutoPush(rt, 'cookie_auto_push');
    }

    if (changedSourceSites.size > 0) {
      await this.runAutoEnvSyncForSourceSites(rt, changedSourceSites);
    }
  }

  private async attemptAutoPush(rt: LoadedSpaceRuntime, phase: string): Promise<void> {
    this.autoPushAttemptCount += 1;
    if (
      !rt.meta.space.settings.autoSync ||
      rt.meta.globalPaused ||
      rt.meta.localDevice.state !== 'active' ||
      rt.meta.storageFullHalted ||
      !rt.dekKeyring[rt.meta.space.keyEpoch]
    ) {
      return;
    }
    const localDevPolicy = this.getLocalDevicePolicy(rt);
    if (localDevPolicy?.direction === 'disabled' || localDevPolicy?.direction === 'pull_only') {
      return;
    }
    if (rt.pendingOutboundEvents.length === 0 && !rt.meta.manifestDirty) {
      return;
    }
    if (!this.isOnline()) {
      rt.meta.space.status = this.computeStatus(rt);
      await this.persistRuntime(rt);
      return;
    }

    const nowMs = this.now();
    const timingMode = this.getEffectiveSyncTimingMode(rt);
    const excludeSiteKeys = new Set<string>();

    if (timingMode === 'on_page_leave') {
      const openSites = await this.getOpenTabSiteKeys(rt);
      for (const ev of rt.pendingOutboundEvents) {
        if (openSites.has(ev.siteKey) && !this.releasedOnPageLeaveSites.has(ev.siteKey)) {
          excludeSiteKeys.add(ev.siteKey);
          this.deferredOnPageLeaveSites.add(ev.siteKey);
        } else {
          this.deferredOnPageLeaveSites.delete(ev.siteKey);
        }
      }
    }

    // Post-reload echo shield: never immediately bounce server-rotated Set-Cookies right after a tab auto-reload
    for (const ev of rt.pendingOutboundEvents) {
      const muteUntil = this.postReloadPushMuteUntil.get(ev.siteKey) ?? 0;
      if (muteUntil > nowMs && !this.releasedOnPageLeaveSites.has(ev.siteKey)) {
        excludeSiteKeys.add(ev.siteKey);
      } else if (muteUntil > 0 && muteUntil <= nowMs) {
        this.postReloadPushMuteUntil.delete(ev.siteKey);
      }
    }

    const hasReadyEvent = rt.pendingOutboundEvents.some((ev) => !excludeSiteKeys.has(ev.siteKey));
    if (!hasReadyEvent && !rt.meta.manifestDirty) {
      return;
    }

    if (
      this.autoPushCooldownMs > 0 &&
      rt.meta.autoPushBackoffUntilMs &&
      nowMs < rt.meta.autoPushBackoffUntilMs
    ) {
      return;
    }
    const cooldown = this.getEffectiveAutoPushCooldownMs(rt);
    if (cooldown > 0 && rt.meta.lastAutoPushAt && nowMs - rt.meta.lastAutoPushAt < cooldown) {
      return;
    }

    try {
      const pushed = await this.pushOutboundInternal(
        rt,
        undefined,
        excludeSiteKeys.size > 0 ? excludeSiteKeys : undefined,
      );
      const doneMs = this.now();
      if (pushed > 0 || !rt.meta.manifestDirty) {
        rt.meta.lastAutoPushAt = doneMs;
        rt.meta.lastSyncAt = doneMs;
      }
      for (const sk of Array.from(this.releasedOnPageLeaveSites)) {
        if (!rt.pendingOutboundEvents.some((ev) => ev.siteKey === sk)) {
          this.releasedOnPageLeaveSites.delete(sk);
        }
      }
      rt.meta.consecutiveTransientFailures = 0;
      rt.meta.autoPushBackoffUntilMs = undefined;
      if (!rt.meta.storageFullHalted) {
        rt.meta.latestError = null;
        if (rt.pendingOutboundEvents.length === 0) {
          for (const task of rt.retryTasks) {
            if (task.status === 'RETRYING' || task.status === 'FAILED') {
              task.status = 'SUCCEEDED';
              task.completedAt = doneMs;
            }
          }
        }
      }
      rt.meta.space.status = this.computeStatus(rt);
      await this.persistRuntime(rt);
    } catch (err) {
      const se = toStructuredError(err, phase);
      const errNow = this.now();
      rt.meta.latestError = se;

      if (se.code === 'ERR_STORAGE_FULL' || se.status === 507) {
        rt.meta.storageFullHalted = true;
        this.haltWriteRetryTasks(rt, se);
        rt.meta.space.status = 'PARTIAL';
      } else if (se.status === 401 || se.status === 403) {
        rt.meta.space.status = 'AUTH_ERROR';
      } else if (this.isTransientRetryableError(se)) {
        const failures = (rt.meta.consecutiveTransientFailures ?? 0) + 1;
        rt.meta.consecutiveTransientFailures = failures;
        const retryAfterMs = (err as { retryAfterMs?: number })?.retryAfterMs;
        const baseBackoff = Math.min(180_000, 15_000 * 2 ** Math.min(failures - 1, 4));
        const backoffMs =
          typeof retryAfterMs === 'number' && retryAfterMs > 0
            ? Math.min(180_000, Math.max(5_000, retryAfterMs))
            : baseBackoff;
        if (this.autoPushCooldownMs > 0) {
          rt.meta.autoPushBackoffUntilMs = errNow + backoffMs;
        }
        this.upsertRetryTask(rt, 'push_events', se.code, se.message);
        rt.meta.space.status = this.computeStatus(rt);
      } else {
        rt.meta.space.status = this.computeStatus(rt);
      }

      await this.logger.log({
        spaceId: rt.spaceId,
        level: this.isTransientRetryableError(se) ? 'warn' : 'error',
        phase,
        code: se.code,
        message: se.message,
        suggestion: se.suggestion,
        deviceId: rt.meta.localDevice.deviceId,
        timestamp: errNow,
      });
      await this.persistRuntime(rt);
    }
  }

  private async getActiveTabSiteKeys(rt: LoadedSpaceRuntime): Promise<Set<string>> {
    const out = new Set<string>();
    try {
      const tabs = await this.browser.queryTabs({ active: true });
      for (const tab of tabs) {
        if (!tab.url) continue;
        const sk = resolveSiteKey(tab.url, rt.meta.rules.ssoGroups);
        if (sk) out.add(sk);
      }
    } catch {
      // ignore
    }
    return out;
  }

  private async getOpenTabSiteKeys(rt: LoadedSpaceRuntime): Promise<Set<string>> {
    const out = new Set<string>();
    try {
      const tabs = await this.browser.queryTabs();
      for (const tab of tabs) {
        if (!tab.url) continue;
        const sk = resolveSiteKey(tab.url, rt.meta.rules.ssoGroups);
        if (sk) out.add(sk);
      }
    } catch {
      // ignore
    }
    return out;
  }

  private async emitLocalCookieUpsert(
    rt: LoadedSpaceRuntime,
    siteKey: string,
    trackId: string,
    cookie: BrowserCookieInput,
    preferredOp: 'CREATE' | 'UPDATE' | 'RESTORE',
    forceBaseVc?: VectorClock,
  ): Promise<CookieRecord | null> {
    const nowMs = this.now();
    const storeScope = normalizeCookieStoreScope(cookie.storeId);
    const hostOnly = resolveEffectiveHostOnly(cookie.domain, cookie.hostOnly, cookie.name);
    const normDomain = normalizeCookieDomain(cookie.domain, hostOnly);
    const path = cookie.name.startsWith('__Host-') ? '/' : cookie.path || '/';
    const secure =
      cookie.name.startsWith('__Host-') ||
      cookie.name.startsWith('__Secure-') ||
      cookie.sameSite === 'no_restriction'
        ? true
        : cookie.secure;

    const logicalId = buildCookieLogicalId({
      trackId,
      storeScope,
      partitionKey: cookie.partitionKey,
      hostOnly,
      domain: normDomain,
      path,
      name: cookie.name,
    });

    const normalizedCookie: BrowserCookieInput = {
      ...cookie,
      domain: normDomain,
      path,
      hostOnly,
      secure,
      storeId: storeScope,
    };

    const newHash = cookieContentCanonicalHash(normalizedCookie);
    const existing = rt.cookies[logicalId];
    const existingTombstone = rt.tombstones[logicalId];

    // S-012: Skip emitting event if live cookie has identical canonical value & attributes
    if (
      preferredOp !== 'RESTORE' &&
      !forceBaseVc &&
      existing &&
      !existing.deleted &&
      cookieContentCanonicalHash(existing) === newHash
    ) {
      return null;
    }

    let baseVc: VectorClock = { ...rt.meta.localDevice.checkpoint.processedVectorClock };
    if (existing?.version?.vectorClock) {
      baseVc = mergeVectorClocks(baseVc, existing.version.vectorClock);
    }
    if (existingTombstone?.deleteVersion?.vectorClock) {
      baseVc = mergeVectorClocks(baseVc, existingTombstone.deleteVersion.vectorClock);
    }
    if (forceBaseVc) {
      baseVc = mergeVectorClocks(baseVc, forceBaseVc);
    }

    const nextSeq = rt.meta.localDevice.sequence + 1;
    rt.meta.localDevice.sequence = nextSeq;
    rt.meta.localDevice.localRevision += 1;

    const version = createNextCausalVersion({
      clock: rt.hlcClock,
      baseVectorClock: baseVc,
      deviceId: rt.meta.localDevice.deviceId,
      nextDeviceSeq: nextSeq,
      nowMs,
    });

    rt.meta.localDevice.checkpoint.processedVectorClock = incrementVectorClock(
      rt.meta.localDevice.checkpoint.processedVectorClock,
      rt.meta.localDevice.deviceId,
      nextSeq,
    );
    rt.meta.localDevice.checkpoint.updatedAt = nowMs;

    const record: CookieRecord = {
      logicalId,
      siteKey,
      trackId,
      domain: normDomain,
      path,
      name: cookie.name,
      value: cookie.value,
      storeScope,
      partitionKey: cookie.partitionKey ?? null,
      secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      session: cookie.session,
      expirationDate: cookie.session ? undefined : cookie.expirationDate,
      hostOnly,
      version,
      sourceDevice: rt.meta.localDevice.deviceId,
      sourceDeviceName: rt.meta.localDevice.name,
      deleted: false,
      updatedAt: nowMs,
      syncStatus: 'LOCAL_NEWER',
    };

    rt.cookies[logicalId] = record;
    delete rt.tombstones[logicalId];
    rt.meta.appliedCookieHashes[logicalId] = newHash;

    const op = existing ? preferredOp : preferredOp === 'RESTORE' ? 'RESTORE' : 'CREATE';
    const { version: _v, syncStatus: _s, applyResult: _a, ...cookieData } = record;
    const payloadHash = await sha256Hex(newHash);

    const event: SyncEvent = {
      eventId: randomId('evt'),
      spaceId: rt.spaceId,
      trackId,
      siteKey,
      deviceId: rt.meta.localDevice.deviceId,
      deviceName: rt.meta.localDevice.name,
      deviceSeq: nextSeq,
      objectType: 'cookie',
      objectId: logicalId,
      operation: op,
      baseVersion: existing?.version ?? existingTombstone?.deleteVersion ?? null,
      version,
      cookieData,
      payloadHash,
      createdAt: nowMs,
      status: 'QUEUED',
    };

    this.supersedeConflictsForObject(rt, event.objectId, nowMs);
    this.enqueueOutboundEvent(rt, event);
    rt.eventsHistory.push(event);
    this.refreshTrackCounts(rt, trackId, nowMs);

    return record;
  }

  private async emitLocalCookieDelete(
    rt: LoadedSpaceRuntime,
    record: CookieRecord,
    reason: TombstoneReason,
    deleteReason: string,
    forceBaseVc?: VectorClock,
  ): Promise<void> {
    const nowMs = this.now();
    let baseVc = mergeVectorClocks(
      rt.meta.localDevice.checkpoint.processedVectorClock,
      record.version.vectorClock,
    );
    if (rt.tombstones[record.logicalId]?.deleteVersion?.vectorClock) {
      baseVc = mergeVectorClocks(baseVc, rt.tombstones[record.logicalId].deleteVersion.vectorClock);
    }
    if (forceBaseVc) {
      baseVc = mergeVectorClocks(baseVc, forceBaseVc);
    }

    const nextSeq = rt.meta.localDevice.sequence + 1;
    rt.meta.localDevice.sequence = nextSeq;
    rt.meta.localDevice.localRevision += 1;

    const version = createNextCausalVersion({
      clock: rt.hlcClock,
      baseVectorClock: baseVc,
      deviceId: rt.meta.localDevice.deviceId,
      nextDeviceSeq: nextSeq,
      nowMs,
    });

    rt.meta.localDevice.checkpoint.processedVectorClock = incrementVectorClock(
      rt.meta.localDevice.checkpoint.processedVectorClock,
      rt.meta.localDevice.deviceId,
      nextSeq,
    );
    rt.meta.localDevice.checkpoint.updatedAt = nowMs;

    const deletedRecord: CookieRecord = {
      ...record,
      version,
      sourceDevice: rt.meta.localDevice.deviceId,
      sourceDeviceName: rt.meta.localDevice.name,
      deleted: true,
      deleteReason,
      updatedAt: nowMs,
      syncStatus: 'DELETED',
    };
    rt.cookies[record.logicalId] = deletedRecord;
    delete rt.meta.appliedCookieHashes[record.logicalId];

    const tombstone: Tombstone = {
      objectId: record.logicalId,
      objectType: 'cookie',
      siteKey: record.siteKey,
      trackId: record.trackId,
      deleteVersion: version,
      previousVersion: record.version,
      sourceDevice: rt.meta.localDevice.deviceId,
      reason,
      createdAt: nowMs,
      acknowledgedDevices: [rt.meta.localDevice.deviceId],
      reclaimable: false,
    };
    rt.tombstones[record.logicalId] = tombstone;

    const { version: _v, syncStatus: _s, applyResult: _a, ...cookieData } = deletedRecord;
    const payloadHash = await sha256Hex(`delete:${record.logicalId}:${version.versionId}`);

    const event: SyncEvent = {
      eventId: randomId('evt'),
      spaceId: rt.spaceId,
      trackId: record.trackId,
      siteKey: record.siteKey,
      deviceId: rt.meta.localDevice.deviceId,
      deviceName: rt.meta.localDevice.name,
      deviceSeq: nextSeq,
      objectType: 'cookie',
      objectId: record.logicalId,
      operation: 'DELETE',
      baseVersion: record.version,
      version,
      cookieData,
      deleteReason,
      payloadHash,
      createdAt: nowMs,
      status: 'QUEUED',
    };

    this.supersedeConflictsForObject(rt, event.objectId, nowMs);
    this.enqueueOutboundEvent(rt, event);
    rt.eventsHistory.push(event);
    this.refreshTrackCounts(rt, record.trackId, nowMs);
  }

  private async emitLocalStorageUpsert(
    rt: LoadedSpaceRuntime,
    siteKey: string,
    trackId: string,
    origin: string,
    key: string,
    value: string,
    preferredOp: 'CREATE' | 'UPDATE' | 'RESTORE',
    forceBaseVc?: VectorClock,
  ): Promise<LocalStorageRecord | null> {
    const MAX_LOCAL_STORAGE_VALUE_LENGTH = 256 * 1024;
    if (value.length > MAX_LOCAL_STORAGE_VALUE_LENGTH) {
      return null;
    }
    const nowMs = this.now();
    const logicalId = buildLocalStorageLogicalId(trackId, origin, key);
    const existing = rt.localStorage[logicalId];
    const existingTombstone = rt.tombstones[logicalId];

    if (
      preferredOp !== 'RESTORE' &&
      !forceBaseVc &&
      existing &&
      !existing.deleted &&
      existing.value === value
    ) {
      return null;
    }

    let baseVc = { ...rt.meta.localDevice.checkpoint.processedVectorClock };
    if (existing?.version?.vectorClock) {
      baseVc = mergeVectorClocks(baseVc, existing.version.vectorClock);
    }
    if (existingTombstone?.deleteVersion?.vectorClock) {
      baseVc = mergeVectorClocks(baseVc, existingTombstone.deleteVersion.vectorClock);
    }
    if (forceBaseVc) {
      baseVc = mergeVectorClocks(baseVc, forceBaseVc);
    }

    const nextSeq = rt.meta.localDevice.sequence + 1;
    rt.meta.localDevice.sequence = nextSeq;
    rt.meta.localDevice.localRevision += 1;

    const version = createNextCausalVersion({
      clock: rt.hlcClock,
      baseVectorClock: baseVc,
      deviceId: rt.meta.localDevice.deviceId,
      nextDeviceSeq: nextSeq,
      nowMs,
    });

    rt.meta.localDevice.checkpoint.processedVectorClock = incrementVectorClock(
      rt.meta.localDevice.checkpoint.processedVectorClock,
      rt.meta.localDevice.deviceId,
      nextSeq,
    );
    rt.meta.localDevice.checkpoint.updatedAt = nowMs;

    const record: LocalStorageRecord = {
      logicalId,
      siteKey,
      trackId,
      origin,
      key,
      value,
      version,
      sourceDevice: rt.meta.localDevice.deviceId,
      sourceDeviceName: rt.meta.localDevice.name,
      deleted: false,
      updatedAt: nowMs,
      contextAvailable: true,
      syncStatus: 'LOCAL_NEWER',
    };

    rt.localStorage[logicalId] = record;
    delete rt.tombstones[logicalId];
    rt.meta.appliedLsHashes[logicalId] = value;

    const { version: _v, syncStatus: _s, ...localStorageData } = record;
    const payloadHash = await sha256Hex(`${origin}:${key}:${value}`);

    const event: SyncEvent = {
      eventId: randomId('evt'),
      spaceId: rt.spaceId,
      trackId,
      siteKey,
      deviceId: rt.meta.localDevice.deviceId,
      deviceName: rt.meta.localDevice.name,
      deviceSeq: nextSeq,
      objectType: 'localStorage',
      objectId: logicalId,
      operation: existing ? preferredOp : preferredOp === 'RESTORE' ? 'RESTORE' : 'CREATE',
      baseVersion: existing?.version ?? existingTombstone?.deleteVersion ?? null,
      version,
      localStorageData,
      payloadHash,
      createdAt: nowMs,
      status: 'QUEUED',
    };

    this.supersedeConflictsForObject(rt, event.objectId, nowMs);
    this.enqueueOutboundEvent(rt, event);
    rt.eventsHistory.push(event);
    this.refreshTrackCounts(rt, trackId, nowMs);
    return record;
  }

  private async emitLocalStorageDelete(
    rt: LoadedSpaceRuntime,
    record: LocalStorageRecord,
    reason: TombstoneReason,
    deleteReason: string,
  ): Promise<void> {
    const nowMs = this.now();
    let baseVc = mergeVectorClocks(
      rt.meta.localDevice.checkpoint.processedVectorClock,
      record.version.vectorClock,
    );
    if (rt.tombstones[record.logicalId]?.deleteVersion?.vectorClock) {
      baseVc = mergeVectorClocks(baseVc, rt.tombstones[record.logicalId].deleteVersion.vectorClock);
    }

    const nextSeq = rt.meta.localDevice.sequence + 1;
    rt.meta.localDevice.sequence = nextSeq;
    rt.meta.localDevice.localRevision += 1;

    const version = createNextCausalVersion({
      clock: rt.hlcClock,
      baseVectorClock: baseVc,
      deviceId: rt.meta.localDevice.deviceId,
      nextDeviceSeq: nextSeq,
      nowMs,
    });

    rt.meta.localDevice.checkpoint.processedVectorClock = incrementVectorClock(
      rt.meta.localDevice.checkpoint.processedVectorClock,
      rt.meta.localDevice.deviceId,
      nextSeq,
    );
    rt.meta.localDevice.checkpoint.updatedAt = nowMs;

    const deletedRec: LocalStorageRecord = {
      ...record,
      version,
      sourceDevice: rt.meta.localDevice.deviceId,
      sourceDeviceName: rt.meta.localDevice.name,
      deleted: true,
      updatedAt: nowMs,
      syncStatus: 'DELETED',
    };
    rt.localStorage[record.logicalId] = deletedRec;
    delete rt.meta.appliedLsHashes[record.logicalId];

    rt.tombstones[record.logicalId] = {
      objectId: record.logicalId,
      objectType: 'localStorage',
      siteKey: record.siteKey,
      trackId: record.trackId,
      deleteVersion: version,
      previousVersion: record.version,
      sourceDevice: rt.meta.localDevice.deviceId,
      reason,
      createdAt: nowMs,
      acknowledgedDevices: [rt.meta.localDevice.deviceId],
      reclaimable: false,
    };

    const { version: _v, syncStatus: _s, ...localStorageData } = deletedRec;
    const payloadHash = await sha256Hex(`delete_ls:${record.logicalId}:${version.versionId}`);

    const event: SyncEvent = {
      eventId: randomId('evt'),
      spaceId: rt.spaceId,
      trackId: record.trackId,
      siteKey: record.siteKey,
      deviceId: rt.meta.localDevice.deviceId,
      deviceName: rt.meta.localDevice.name,
      deviceSeq: nextSeq,
      objectType: 'localStorage',
      objectId: record.logicalId,
      operation: 'DELETE',
      baseVersion: record.version,
      version,
      localStorageData,
      deleteReason,
      payloadHash,
      createdAt: nowMs,
      status: 'QUEUED',
    };

    this.supersedeConflictsForObject(rt, event.objectId, nowMs);
    this.enqueueOutboundEvent(rt, event);
    rt.eventsHistory.push(event);
    this.refreshTrackCounts(rt, record.trackId, nowMs);
  }

  private refreshTrackCounts(rt: LoadedSpaceRuntime, trackId: string, nowMs: number): void {
    const track = rt.tracks[trackId];
    if (!track) return;
    track.cookieCount = Object.values(rt.cookies).filter(
      (c) => c.trackId === trackId && !c.deleted,
    ).length;
    track.localStorageCount = Object.values(rt.localStorage).filter(
      (l) => l.trackId === trackId && !l.deleted,
    ).length;
    track.updatedAt = nowMs;
    track.revision = (track.revision ?? 0) + 1;
  }

  private async pushOutboundInternal(
    rt: LoadedSpaceRuntime,
    siteKeyFilter?: string,
    excludeSiteKeys?: Set<string>,
  ): Promise<number> {
    if (rt.meta.storageFullHalted) {
      return 0;
    }

    const localDevPolicy = this.getLocalDevicePolicy(rt);
    if (localDevPolicy?.direction === 'disabled' || localDevPolicy?.direction === 'pull_only') {
      return 0;
    }

    // Compact duplicate pending events for the same objectId before chunking & uploading
    rt.pendingOutboundEvents = this.compactPendingOutboundEvents(rt.pendingOutboundEvents);

    const eligible = rt.pendingOutboundEvents.filter((ev) => {
      if (siteKeyFilter && ev.siteKey !== siteKeyFilter) return false;
      if (excludeSiteKeys && excludeSiteKeys.has(ev.siteKey)) return false;
      const policy = this.getEffectivePolicyForDevice(rt, ev.siteKey, ev.siteKey);
      if (policy.excluded || policy.direction === 'disabled' || policy.direction === 'pull_only') {
        return false;
      }
      return true;
    });

    if (eligible.length === 0) {
      if (rt.meta.manifestDirty) {
        await this.uploadDeviceManifest(rt);
        await this.uploadCheckpoint(rt);
      }
      return 0;
    }

    const MAX_EVENTS_PER_BATCH = 60;
    const MAX_BATCH_EST_BYTES = 384 * 1024;
    const dek = this.getCurrentDek(rt);
    const nowMs = this.now();
    let totalPushed = 0;

    // Sort eligible events in ascending deviceSeq order so chunk ranges stay monotonic
    eligible.sort((a, b) => a.deviceSeq - b.deviceSeq);
    const eligibleIds = new Set(eligible.map((e) => e.eventId));
    const deferredPendingSeqs = rt.pendingOutboundEvents
      .filter((e) => !eligibleIds.has(e.eventId))
      .map((e) => e.deviceSeq);

    // Build chunks bounded by BOTH event count (<=60) AND estimated payload size (<=384 KB)
    const chunks: SyncEvent[][] = [];
    let currentChunk: SyncEvent[] = [];
    let currentBytes = 0;
    for (const ev of eligible) {
      const estSize =
        ev.objectType === 'localStorage'
          ? (ev.localStorageData?.value?.length ?? 0) + (ev.localStorageData?.key?.length ?? 0) + 256
          : (ev.cookieData?.value?.length ?? 0) + (ev.cookieData?.name?.length ?? 0) + 256;
      if (
        currentChunk.length > 0 &&
        (currentChunk.length >= MAX_EVENTS_PER_BATCH || currentBytes + estSize > MAX_BATCH_EST_BYTES)
      ) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentBytes = 0;
      }
      currentChunk.push(ev);
      currentBytes += estSize;
    }
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    let prevCommittedSeq = rt.meta.lastPushedDeviceSeq ?? 0;

    for (const chunk of chunks) {
      const rawFromSeq = Math.min(...chunk.map((e) => e.deviceSeq));
      const toSeq = Math.max(...chunk.map((e) => e.deviceSeq));
      // If earlier deviceSeq numbers were locally compacted/superseded before upload (and none remain
      // deferred in pendingOutboundEvents), include them in fromSeq so integrity checks never report
      // false sequence gaps while still detecting genuinely missing remote batch files.
      const hasDeferredInRange =
        prevCommittedSeq > 0 && rawFromSeq > prevCommittedSeq + 1
          ? deferredPendingSeqs.some((s) => s > prevCommittedSeq && s < rawFromSeq)
          : false;
      const fromSeq =
        prevCommittedSeq > 0 && rawFromSeq > prevCommittedSeq + 1 && !hasDeferredInRange
          ? prevCommittedSeq + 1
          : rawFromSeq;
      const batchId = randomId('b');

      const touchedTrackIds = new Set(chunk.map((e) => e.trackId));
      const tracksDelta: SiteTrack[] = [];
      for (const tid of touchedTrackIds) {
        if (rt.tracks[tid]) tracksDelta.push(rt.tracks[tid]);
      }

      const batch: EventBatch = {
        batchId,
        spaceId: rt.spaceId,
        deviceId: rt.meta.localDevice.deviceId,
        deviceName: rt.meta.localDevice.name,
        fromSeq,
        toSeq,
        createdAt: nowMs,
        events: chunk,
        tracksDelta,
      };

      const remotePath = eventBatchPath(
        rt.meta.space.opaqueId,
        rt.meta.localDevice.deviceId,
        toSeq,
        batchId,
      );
      const aad = buildFileAad(rt.spaceId, rt.meta.space.keyEpoch, 'event_batch', remotePath);

      const encrypted = await encryptWithDek(batch, dek, rt.meta.space.keyEpoch, aad, {
        compress: rt.meta.space.settings.compression,
        encoding: rt.meta.space.settings.payloadEncoding,
      });

      try {
        await this.putBytesWithTransientRetry(rt, remotePath, encrypted, {
          ifNoneMatchStar: true,
          contentType: 'application/octet-stream',
        });
      } catch (err) {
        const se = toStructuredError(err, 'push', remotePath);
        if (se.status === 412) {
          // Already committed before crash
        } else {
          throw err;
        }
      }

      const pushedIds = new Set(chunk.map((e) => e.eventId));
      for (const ev of chunk) {
        ev.status = 'COMMITTED';
        ev.committedAt = nowMs;
        if (ev.objectType === 'cookie') {
          const rec = rt.cookies[ev.objectId];
          if (rec && !rec.deleted && rec.syncStatus === 'LOCAL_NEWER') {
            rec.syncStatus = 'IN_SYNC';
          }
        } else {
          const rec = rt.localStorage[ev.objectId];
          if (rec && !rec.deleted && rec.syncStatus === 'LOCAL_NEWER') {
            rec.syncStatus = 'IN_SYNC';
          }
        }
      }

      rt.pendingOutboundEvents = rt.pendingOutboundEvents.filter((e) => !pushedIds.has(e.eventId));
      rt.meta.processedEventPaths[remotePath] = true;
      rt.meta.manifestDirty = true;
      prevCommittedSeq = Math.max(prevCommittedSeq, toSeq);
      rt.meta.lastPushedDeviceSeq = Math.max(rt.meta.lastPushedDeviceSeq ?? 0, toSeq);
      totalPushed += chunk.length;
    }

    // Mark queued/retrying push tasks as SUCCEEDED once eligible events are drained
    if (rt.pendingOutboundEvents.length === 0) {
      for (const task of rt.retryTasks) {
        if (task.taskType === 'push_events' && task.status !== 'SUCCEEDED') {
          task.status = 'SUCCEEDED';
          task.completedAt = nowMs;
        }
      }
    }

    rt.meta.localDevice.lastSyncAt = nowMs;
    rt.meta.localDevice.lastSeenAt = nowMs;

    await this.uploadDeviceManifest(rt);
    await this.uploadCheckpoint(rt);

    return totalPushed;
  }

  private async putBytesWithTransientRetry(
    rt: LoadedSpaceRuntime,
    remotePath: string,
    bytes: Uint8Array,
    options?: {
      ifMatch?: string;
      ifNoneMatchStar?: boolean;
      contentType?: string;
    },
  ): Promise<{ status: number; etag?: string }> {
    const maxRetries = 2;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await rt.client.putBytes(remotePath, bytes, options);
      } catch (err) {
        lastErr = err;
        const se = toStructuredError(err, 'push', remotePath);
        const isTransientRateOrUnavailable = se.status === 429 || se.status === 503;
        if (!isTransientRateOrUnavailable || attempt >= maxRetries) {
          throw err;
        }
        const retryAfterMs =
          typeof (err as { retryAfterMs?: number })?.retryAfterMs === 'number'
            ? (err as { retryAfterMs: number }).retryAfterMs
            : 300 * (attempt + 1);
        const delayMs = Math.max(100, Math.min(retryAfterMs, 1500));
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastErr;
  }

  private async uploadDeviceManifest(rt: LoadedSpaceRuntime): Promise<void> {
    if (rt.meta.storageFullHalted) return;
    const dek = this.getCurrentDek(rt);
    const nowMs = this.now();
    rt.meta.localDevice.lastSeenAt = nowMs;
    rt.meta.localDevice.pendingEvents = rt.pendingOutboundEvents.length;

    const remotePath = deviceFilePath(rt.meta.space.opaqueId, rt.meta.localDevice.deviceId);
    const aad = buildFileAad(rt.spaceId, rt.meta.space.keyEpoch, 'device', remotePath);

    const stateDigest = await sha256Hex(
      JSON.stringify({
        seq: rt.meta.localDevice.sequence,
        bindings: rt.meta.localDevice.siteBindings,
        tracks: Object.keys(rt.tracks).sort(),
        removedTracks: rt.meta.removedTracks ?? {},
        rulesAt: rt.meta.rules.updatedAt,
        settingsAt: rt.meta.space.updatedAt,
        overrides: rt.meta.deviceOverrides,
      }),
    );

    const manifest: RemoteDeviceManifest = {
      device: rt.meta.localDevice,
      tracks: rt.tracks,
      removedTracks: rt.meta.removedTracks ?? {},
      rulesDelta: rt.meta.rules,
      settingsDelta: {
        settings: rt.meta.space.settings,
        updatedAt: rt.meta.space.updatedAt,
      },
      deviceOverrides: rt.meta.deviceOverrides,
      instanceNonce: this.identity.instanceNonce,
      stateDigest,
      updatedAt: nowMs,
    };

    const encrypted = await encryptWithDek(manifest, dek, rt.meta.space.keyEpoch, aad, {
      compress: rt.meta.space.settings.compression,
      encoding: rt.meta.space.settings.payloadEncoding,
    });

    await this.putBytesWithTransientRetry(rt, remotePath, encrypted, {
      contentType: 'application/octet-stream',
    });
    rt.meta.manifestDirty = false;
  }

  private async uploadDeviceManifestIfOnline(rt: LoadedSpaceRuntime): Promise<void> {
    rt.meta.manifestDirty = true;
    if (
      rt.meta.globalPaused ||
      !this.isOnline() ||
      rt.meta.storageFullHalted ||
      !rt.dekKeyring[rt.meta.space.keyEpoch]
    ) {
      return;
    }
    try {
      await this.uploadDeviceManifest(rt);
    } catch {
      // Offline / transient error (e.g. 423 Locked) keeps manifestDirty=true for next sync retry
    }
  }

  private async uploadCheckpoint(rt: LoadedSpaceRuntime): Promise<void> {
    if (rt.meta.storageFullHalted) return;
    const dek = this.getCurrentDek(rt);
    const remotePath = checkpointFilePath(rt.meta.space.opaqueId, rt.meta.localDevice.deviceId);
    const aad = buildFileAad(rt.spaceId, rt.meta.space.keyEpoch, 'checkpoint', remotePath);
    rt.meta.localDevice.checkpoint.updatedAt = this.now();

    const encrypted = await encryptWithDek(
      rt.meta.localDevice.checkpoint,
      dek,
      rt.meta.space.keyEpoch,
      aad,
      {
        compress: rt.meta.space.settings.compression,
        encoding: rt.meta.space.settings.payloadEncoding,
      },
    );

    await this.putBytesWithTransientRetry(rt, remotePath, encrypted, {
      contentType: 'application/octet-stream',
    });
  }

  private async updateRemoteSpaceMetaIfPossible(
    rt: LoadedSpaceRuntime,
    updater: (desc: SpaceDescriptorPayload) => SpaceDescriptorPayload,
  ): Promise<void> {
    if (!rt.encryptionPassword || !this.isOnline() || rt.meta.storageFullHalted) {
      return;
    }

    const metaPath = spaceMetaPath(rt.meta.space.opaqueId);
    const metaAad = buildSpaceMetaAad(rt.spaceId, metaPath);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fetched = await rt.client.getBytes(metaPath);
        const current = await decryptWithPassword<SpaceDescriptorPayload>(
          fetched.bytes,
          rt.encryptionPassword,
          metaAad,
        );
        const next = updater(current);
        const encrypted = await encryptWithPassword(next, rt.encryptionPassword, metaAad, {
          compress: true,
          encoding: 'json',
          iterations: this.pbkdf2Iterations,
          keyEpoch: next.keyEpoch,
        });
        const putRes = await rt.client.putBytes(metaPath, encrypted, {
          ifMatch: normalizeEtag(fetched.etag),
          contentType: 'application/octet-stream',
        });
        rt.meta.spaceMetaEtag = normalizeEtag(putRes.etag);
        return;
      } catch (err) {
        const se = toStructuredError(err, 'space_meta', metaPath);
        if (se.status === 412 && attempt < 2) {
          continue;
        }
        return;
      }
    }
  }

  private async pullRemoteInternal(
    rt: LoadedSpaceRuntime,
    options: { applyToBrowser: boolean; siteKeyFilter?: string; triggerRefresh?: boolean },
  ): Promise<{
    pulledEvents: number;
    appliedCookies: number;
    failedCookies: number;
    updatedCheckpoint: boolean;
    updatedLocalBindings: boolean;
  }> {
    const nowMs = this.now();
    let pulledEvents = 0;
    let appliedCookies = 0;
    let failedCookies = 0;
    let updatedCheckpoint = false;
    let updatedLocalBindings = false;
    let settingsUpdated = false;

    // 1. Check metadata/space.enc with If-None-Match (only when password is in memory)
    if (rt.encryptionPassword) {
      const metaPath = spaceMetaPath(rt.meta.space.opaqueId);
      const metaAad = buildSpaceMetaAad(rt.spaceId, metaPath);
      try {
        const fetched = await rt.client.getBytes(metaPath, {
          ifNoneMatch: rt.meta.spaceMetaEtag,
        });
        if (!fetched.notModified && fetched.bytes.length > 0) {
          const desc = await decryptWithPassword<SpaceDescriptorPayload>(
            fetched.bytes,
            rt.encryptionPassword,
            metaAad,
          );
          if (desc.verifier === 'SESSIONMESH_SPACE_OK') {
            rt.meta.spaceMetaEtag = normalizeEtag(fetched.etag);
            rt.dekKeyring = {
              ...rt.dekKeyring,
              ...(desc.dekKeyring ?? {}),
              [desc.keyEpoch]: desc.currentDekBase64,
            };
            rt.meta.space.keyEpoch = Math.max(rt.meta.space.keyEpoch, desc.keyEpoch);
            if (desc.updatedAt > rt.meta.space.updatedAt) {
              rt.meta.space.name = desc.name;
              rt.meta.space.settings = {
                ...DEFAULT_SPACE_SETTINGS,
                ...desc.settings,
                devicePolicies: { ...(desc.settings?.devicePolicies ?? {}) },
              };
              rt.meta.space.updatedAt = desc.updatedAt;
              settingsUpdated = true;
            }
            if (desc.rules && desc.rules.updatedAt > rt.meta.rules.updatedAt) {
              rt.meta.rules = desc.rules;
            }
            rt.rulesEngine.update(rt.meta.space.settings, rt.meta.rules, rt.meta.deviceBlacklist);
          }
        }
      } catch (err) {
        const se = toStructuredError(err, 'pull_space_meta', metaPath);
        if (se.code === 'DECRYPT_ERROR') {
          throw se;
        }
      }
    }

    // 2. ETag Short-Circuit: Single PROPFIND Depth:1 on devices/
    const devDir = devicesDir(rt.meta.space.opaqueId);
    let deviceStats: WebDAVResourceStat[] = [];
    try {
      deviceStats = await rt.client.propfind(devDir, 1);
    } catch (err) {
      const se = toStructuredError(err, 'pull_devices', devDir);
      if (se.status === 404) {
        deviceStats = [];
      } else {
        throw err;
      }
    }

    const touchedSites = new Set<string>();
    const deleteReasonsByObject = new Map<string, string>();
    const changedPeers: string[] = [];

    for (const stat of deviceStats) {
      if (stat.isCollection) continue;
      const filename = stat.name || extractFilename(stat.path);
      if (!filename.endsWith('.enc')) continue;
      const peerId = filename.slice(0, -4);
      if (!peerId || peerId === rt.meta.localDevice.deviceId) continue;

      const remoteEtag = normalizeEtag(stat.etag);
      const isReliableEtag =
        Boolean(remoteEtag) &&
        remoteEtag !== '1' &&
        remoteEtag !== '0' &&
        remoteEtag !== 'true' &&
        remoteEtag !== 'false';
      const remoteMarker = isReliableEtag ? `${remoteEtag}:${stat.size}` : undefined;
      const cachedEtag = rt.meta.peerDeviceEtags[peerId];

      // ETag Short-Circuit: unchanged peer manifest => ZERO extra GET/PROPFIND calls!
      if (remoteMarker && cachedEtag && (cachedEtag === remoteMarker || cachedEtag === remoteEtag)) {
        continue;
      }

      const peerDevPath = deviceFilePath(rt.meta.space.opaqueId, peerId);
      try {
        const fetched = await rt.client.getBytes(peerDevPath);
        const { data: manifest, header } = await decryptWithDek<RemoteDeviceManifest>(
          fetched.bytes,
          rt.dekKeyring,
          `${rt.spaceId}|`,
        );

        const expectedAad = buildFileAad(rt.spaceId, header.keyEpoch, 'device', peerDevPath);
        if (header.aad !== expectedAad) {
          throw new Error(`AAD mismatch on ${peerDevPath}`);
        }

        // Merge peer device info
        rt.meta.remoteDevices[peerId] = manifest.device;

        // Propagate space-level removedTracks before merging tracks
        if (manifest.removedTracks) {
          rt.meta.removedTracks = rt.meta.removedTracks ?? {};
          for (const [tid, removedAt] of Object.entries(manifest.removedTracks)) {
            if (removedAt > (rt.meta.removedTracks[tid] ?? 0)) {
              rt.meta.removedTracks[tid] = removedAt;
            }
            const existingTrack = rt.tracks[tid];
            if (existingTrack && existingTrack.updatedAt <= removedAt) {
              const removedSiteKey = existingTrack.siteKey;
              delete rt.tracks[tid];
              const remainingForSite = Object.values(rt.tracks).some(
                (t) => t.siteKey === removedSiteKey,
              );
              if (rt.meta.localDevice.siteBindings[removedSiteKey]?.trackId === tid) {
                if (remainingForSite || rt.meta.space.settings.syncScopeMode === 'managed_only') {
                  delete rt.meta.localDevice.siteBindings[removedSiteKey];
                } else {
                  rt.meta.localDevice.siteBindings[removedSiteKey] = {
                    siteKey: removedSiteKey,
                    state: 'UNMANAGED',
                    trackId: undefined,
                    hasLocalBaseline: false,
                    decidedAt: nowMs,
                    decidedBy: 'auto',
                  };
                }
                updatedLocalBindings = true;
              }
              if (!remainingForSite) {
                delete rt.pendingDecisions[removedSiteKey];
              }
              // Clear dangling sourceTrackId references on envSyncRules when a peer deletes a track
              for (const rule of rt.meta.rules.envSyncRules ?? []) {
                if (rule.sourceTrackId === tid) {
                  rule.sourceTrackId = undefined;
                }
              }
              for (const rule of rt.meta.deviceEnvSyncRules ?? []) {
                if (rule.sourceTrackId === tid) {
                  rule.sourceTrackId = undefined;
                }
              }
            }
          }
        }

        // Merge peer tracks
        if (manifest.tracks) {
          for (const [tid, peerTrack] of Object.entries(manifest.tracks)) {
            this.mergeRemoteTrack(rt, tid, peerTrack);
            if (rt.tracks[tid]) {
              touchedSites.add(peerTrack.siteKey);
            }
          }
        }

        // Merge rules & settings deltas if newer
        if (manifest.rulesDelta && manifest.rulesDelta.updatedAt > rt.meta.rules.updatedAt) {
          rt.meta.rules = {
            ...manifest.rulesDelta,
            envSyncRules: manifest.rulesDelta.envSyncRules ?? [],
          };
          rt.rulesEngine.update(
            rt.meta.space.settings,
            rt.meta.rules,
            rt.meta.deviceBlacklist,
            rt.meta.deviceEnvSyncRules,
          );
          this.reconcileBlacklistBindings(rt);
        }
        if (
          manifest.settingsDelta &&
          manifest.settingsDelta.updatedAt > rt.meta.space.updatedAt
        ) {
          rt.meta.space.settings = {
            ...DEFAULT_SPACE_SETTINGS,
            ...manifest.settingsDelta.settings,
            devicePolicies: { ...(manifest.settingsDelta.settings?.devicePolicies ?? {}) },
          };
          rt.meta.space.updatedAt = manifest.settingsDelta.updatedAt;
          rt.rulesEngine.update(rt.meta.space.settings, rt.meta.rules, rt.meta.deviceBlacklist);
          settingsUpdated = true;
        }

        // Merge deviceOverrides (for pause/remove/revoke/rename across devices D-013)
        if (manifest.deviceOverrides) {
          for (const [targetDevId, override] of Object.entries(manifest.deviceOverrides)) {
            const existingOv = rt.meta.deviceOverrides[targetDevId];
            if (!existingOv || override.updatedAt > existingOv.updatedAt) {
              rt.meta.deviceOverrides[targetDevId] = override;
              if (targetDevId === rt.meta.localDevice.deviceId) {
                if (override.name) rt.meta.localDevice.name = override.name;
                if (override.state) rt.meta.localDevice.state = override.state;
              }
            }
          }
        }

        // If our own device was removed/revoked by peer, abort applying further changes (D-013)
        if (rt.meta.localDevice.state === 'removed' || rt.meta.localDevice.state === 'revoked') {
          return {
            pulledEvents,
            appliedCookies,
            failedCookies,
            updatedCheckpoint,
            updatedLocalBindings,
          };
        }

        changedPeers.push(peerId);

        // Scan peer's events directory for unprocessed event batches
        const peerEvtDir = deviceEventsDir(rt.meta.space.opaqueId, peerId);
        let eventStats: WebDAVResourceStat[] = [];
        try {
          eventStats = await rt.client.propfind(peerEvtDir, 1);
        } catch (err) {
          const se = toStructuredError(err, 'pull_events', peerEvtDir);
          if (se.status === 404) {
            eventStats = [];
          } else {
            throw err;
          }
        }

        const eventFiles = eventStats
          .filter((s) => !s.isCollection && (s.name || extractFilename(s.path)).endsWith('.enc'))
          .sort((a, b) => {
            const na = a.name || extractFilename(a.path);
            const nb = b.name || extractFilename(b.path);
            const seqDiff = parseEventFilenameSeq(na) - parseEventFilenameSeq(nb);
            return seqDiff !== 0 ? seqDiff : na.localeCompare(nb);
          });

        let peerHadCorruption = false;

        for (const evStat of eventFiles) {
          const evFileName = evStat.name || extractFilename(evStat.path);
          const evPath = `${peerEvtDir}/${evFileName}`;
          if (rt.meta.processedEventPaths[evPath]) {
            continue;
          }

          try {
            const evFetched = await rt.client.getBytes(evPath);
            const { data: batch, header: evHeader } = await decryptWithDek<EventBatch>(
              evFetched.bytes,
              rt.dekKeyring,
              `${rt.spaceId}|`,
            );

            const expectedEvAad = buildFileAad(
              rt.spaceId,
              evHeader.keyEpoch,
              'event_batch',
              evPath,
            );
            if (evHeader.aad !== expectedEvAad) {
              throw new Error(`AAD mismatch on ${evPath}`);
            }

            if (batch.tracksDelta) {
              for (const tr of batch.tracksDelta) {
                this.mergeRemoteTrack(rt, tr.trackId, tr);
                touchedSites.add(tr.siteKey);
              }
            }

            for (const ev of batch.events) {
              const appliedEv = this.integrateRemoteEvent(rt, ev, nowMs);
              if (appliedEv) {
                pulledEvents += 1;
                touchedSites.add(ev.siteKey);
                if (ev.operation === 'DELETE' && ev.deleteReason) {
                  deleteReasonsByObject.set(ev.objectId, ev.deleteReason);
                }
              }
              rt.meta.localDevice.checkpoint.processedVectorClock = incrementVectorClock(
                rt.meta.localDevice.checkpoint.processedVectorClock,
                ev.deviceId,
                ev.deviceSeq,
              );
              rt.meta.localDevice.remoteRevision += 1;
              updatedCheckpoint = true;
            }

            rt.meta.processedEventPaths[evPath] = true;
          } catch (evErr) {
            if (
              (evErr as { code?: string })?.code === 'DECRYPT_KEY_EPOCH_MISSING' ||
              /No DEK found in keyring for keyEpoch/i.test(String(evErr))
            ) {
              const se = toStructuredError(evErr, 'pull_key_rotation', evPath);
              se.code = 'DECRYPT_ERROR';
              se.message = '远端空间的端到端加密密码已更新，请使用新主密码重新解锁。';
              se.suggestion = '请在弹窗中输入更新后的端到端加密主密码以拉取最新密钥版本。';
              throw se;
            }
            const evSe = toStructuredError(evErr, 'pull_event', evPath);
            if (evSe.status === 404) {
              // Event batch was concurrently garbage-collected by another device — not corruption
              continue;
            }
            if (this.isTransportOrAuthError(evSe)) {
              throw evErr;
            }
            // W-015: Isolate corrupt remote event file without crashing or applying corrupt data
            peerHadCorruption = true;
            this.recordCorruptedPath(rt, evPath, evErr, nowMs);
          }
        }

        const effectiveEtag = normalizeEtag(fetched.etag ?? remoteEtag);
        const isValidEtag =
          Boolean(effectiveEtag) &&
          effectiveEtag !== '1' &&
          effectiveEtag !== '0' &&
          effectiveEtag !== 'true' &&
          effectiveEtag !== 'false';
        if (isValidEtag && !peerHadCorruption) {
          const sizePart = stat.size > 0 ? stat.size : fetched.bytes.byteLength;
          rt.meta.peerDeviceEtags[peerId] = `${effectiveEtag}:${sizePart}`;
        }
      } catch (devErr) {
        const devPhase = (devErr as { phase?: string })?.phase;
        if (
          devPhase === 'pull_key_rotation' ||
          (devErr as { code?: string })?.code === 'DECRYPT_KEY_EPOCH_MISSING' ||
          /No DEK found in keyring for keyEpoch/i.test(String(devErr))
        ) {
          const se = toStructuredError(devErr, 'pull_key_rotation', peerDevPath);
          se.code = 'DECRYPT_ERROR';
          if (/No DEK found in keyring for keyEpoch/i.test(se.message)) {
            se.message = '远端空间的端到端加密密码已更新，请使用新主密码重新解锁。';
            se.suggestion = '请在弹窗中输入更新后的端到端加密主密码以拉取最新密钥版本。';
          }
          throw se;
        }
        const devSe = toStructuredError(devErr, 'pull_device', peerDevPath);
        if (devSe.status === 404) {
          continue;
        }
        if (this.isTransportOrAuthError(devSe)) {
          throw devErr;
        }
        // W-015: Isolate corrupt device manifest without crashing
        this.recordCorruptedPath(rt, peerDevPath, devErr, nowMs);
      }
    }

    // 3. Evaluate site discovery for newly touched remote sites & apply to browser if requested
    if (options.applyToBrowser) {
      if (settingsUpdated && Object.keys(rt.pendingDecisions).length > 0) {
        const reEvalRes = await this.reEvaluatePendingDecisionsInternal(rt, {
          deferSyncAndPersist: true,
          triggerRefresh: options.triggerRefresh ?? true,
        });
        appliedCookies += reEvalRes.appliedCookies;
        failedCookies += reEvalRes.failedCookies;
        if (reEvalRes.resolvedCount > 0) {
          updatedLocalBindings = true;
        }
      }

      const candidateSites = new Set<string>(touchedSites);
      if (options.siteKeyFilter) {
        candidateSites.add(options.siteKeyFilter);
      }
      // Also include any bound sites that have remote-newer records pending apply
      for (const rec of Object.values(rt.cookies)) {
        if (rec.syncStatus === 'REMOTE_NEWER' || rec.syncStatus === 'REMOTE_ONLY') {
          candidateSites.add(rec.siteKey);
        }
      }

      const allLocalCookies = candidateSites.size > 0 ? await this.browser.getAllCookies() : [];

      for (const siteKey of candidateSites) {
        if (options.siteKeyFilter && siteKey !== options.siteKeyFilter) continue;

        const policy = this.getEffectivePolicyForDevice(rt, siteKey, siteKey);
        if (policy.excluded || policy.direction === 'disabled' || policy.direction === 'push_only') {
          continue;
        }

        let binding = rt.meta.localDevice.siteBindings[siteKey];
        if (binding?.state === 'UNMANAGED') {
          continue;
        }

        if (!binding) {
          const localSiteCookies = allLocalCookies.filter((c) =>
            domainMatchesSiteKey(c.domain, siteKey, rt.meta.rules.ssoGroups),
          );
          const remoteTracks = Object.values(rt.tracks).filter((t) => t.siteKey === siteKey);
          if (remoteTracks.length === 0) continue;

          const decision = evaluateSiteDiscovery({
            siteKey,
            isBlacklisted: policy.excluded,
            existingBinding: undefined,
            localCookies: localSiteCookies,
            localStorageCount: 0,
            remoteTracks,
            deviceId: rt.meta.localDevice.deviceId,
            deviceName: rt.meta.localDevice.name,
            filterNoise: rt.meta.space.settings.filterAnalyticsNoiseCookies,
            nowMs,
          });

          rt.meta.localDevice.siteBindings[siteKey] = decision.binding;
          binding = decision.binding;
          updatedLocalBindings = true;

          if (decision.action === 'await_user_choice' && decision.pendingDecision) {
            const autoAction = resolveAutomaticSiteDecisionAction({
              localDeviceId: rt.meta.localDevice.deviceId,
              settings: rt.meta.space.settings,
              remoteTracks,
              hasLocalData: decision.pendingDecision.hasLocalData,
            });
            if (autoAction) {
              const autoRes = await this.resolveSiteDecisionInternal(siteKey, autoAction, {
                deferSyncAndPersist: true,
                triggerRefresh: options.triggerRefresh ?? true,
                decidedBy: 'auto',
              });
              appliedCookies += autoRes.appliedCookies;
              failedCookies += autoRes.failedCookies;
              binding = rt.meta.localDevice.siteBindings[siteKey];
              continue;
            }
            rt.pendingDecisions[siteKey] = decision.pendingDecision;
            continue;
          }
          if (decision.action === 'auto_pull_remote' && decision.binding.trackId) {
            const tr = rt.tracks[decision.binding.trackId];
            if (tr && !tr.memberDeviceIds.includes(rt.meta.localDevice.deviceId)) {
              tr.memberDeviceIds.push(rt.meta.localDevice.deviceId);
              tr.updatedAt = nowMs;
            }
          }
        }

        if (
          !binding ||
          !binding.trackId ||
          binding.state === 'PENDING_CHOICE' ||
          binding.state === 'BLACKLISTED' ||
          binding.state === 'UNMANAGED'
        ) {
          continue;
        }

        const applyRes = await this.applyTrackToBrowser(rt, siteKey, binding.trackId, {
          cleanStale: false,
          triggerRefresh: options.triggerRefresh ?? true,
          deleteReasonsByObject,
        });
        appliedCookies += applyRes.appliedCookies;
        failedCookies += applyRes.failedCookies;
      }

      if (candidateSites.size > 0) {
        await this.runAutoEnvSyncForSourceSites(rt, candidateSites);
      }
    }

    return {
      pulledEvents,
      appliedCookies,
      failedCookies,
      updatedCheckpoint,
      updatedLocalBindings,
    };
  }

  private mergeRemoteTrack(rt: LoadedSpaceRuntime, trackId: string, peerTrack: SiteTrack): void {
    const removedAt = rt.meta.removedTracks?.[trackId];
    if (removedAt !== undefined) {
      if (peerTrack.updatedAt <= removedAt) {
        return;
      }
      if (rt.meta.removedTracks) {
        delete rt.meta.removedTracks[trackId];
      }
    }

    const existing = rt.tracks[trackId];
    if (!existing) {
      rt.tracks[trackId] = {
        ...peerTrack,
        memberDeviceIds: Array.from(new Set(peerTrack.memberDeviceIds ?? [])),
      };
      return;
    }

    const mergedMembers = Array.from(
      new Set([...(existing.memberDeviceIds ?? []), ...(peerTrack.memberDeviceIds ?? [])]),
    );
    const peerIsNewer =
      (peerTrack.revision ?? 0) > (existing.revision ?? 0) ||
      ((peerTrack.revision ?? 0) === (existing.revision ?? 0) &&
        peerTrack.updatedAt > existing.updatedAt);

    rt.tracks[trackId] = {
      ...(peerIsNewer ? peerTrack : existing),
      sortOrder: (peerIsNewer ? peerTrack.sortOrder : existing.sortOrder) ?? existing.sortOrder ?? peerTrack.sortOrder,
      accountNote: (peerIsNewer ? peerTrack.accountNote : existing.accountNote) ?? existing.accountNote ?? peerTrack.accountNote,
      lastUsedAt: Math.max(existing.lastUsedAt ?? 0, peerTrack.lastUsedAt ?? 0) || undefined,
      memberDeviceIds: mergedMembers,
      revision: Math.max(existing.revision ?? 0, peerTrack.revision ?? 0),
      updatedAt: Math.max(existing.updatedAt, peerTrack.updatedAt),
    };
  }

  private integrateRemoteEvent(
    rt: LoadedSpaceRuntime,
    ev: SyncEvent,
    nowMs: number,
    options: { recordHistory?: boolean; defaultSyncStatus?: 'REMOTE_NEWER' | 'LOCAL_NEWER' } = {},
  ): boolean {
    const applySyncStatus = options.defaultSyncStatus ?? 'REMOTE_NEWER';
    // Advance HLC monotonically on receive (S-014 clock skew resilience)
    rt.hlcClock.receive(ev.version.hlc, nowMs);

    // Avoid duplicating event in history
    if (options.recordHistory !== false && !rt.eventsHistory.some((h) => h.eventId === ev.eventId)) {
      rt.eventsHistory.push({ ...ev, status: 'COMMITTED' });
    }

    const primaryDeviceId =
      rt.meta.space.settings.authorityMode === 'primary_device' &&
      rt.meta.space.settings.primaryDeviceId
        ? rt.meta.space.settings.primaryDeviceId
        : undefined;

    if (ev.objectType === 'cookie') {
      const localRec = rt.cookies[ev.objectId];
      const localTomb = rt.tombstones[ev.objectId];

      let remoteRec: CookieRecord | undefined;
      let remoteTomb: Tombstone | undefined;

      if (ev.operation === 'DELETE') {
        remoteTomb = {
          objectId: ev.objectId,
          objectType: 'cookie',
          siteKey: ev.siteKey,
          trackId: ev.trackId,
          deleteVersion: ev.version,
          previousVersion: ev.baseVersion ?? null,
          sourceDevice: ev.deviceId,
          reason: (ev.deleteReason === 'logout'
            ? 'logout'
            : ev.deleteReason === 'expired'
              ? 'expired'
              : ev.deleteReason === 'evicted'
                ? 'evicted'
                : 'explicit') as TombstoneReason,
          createdAt: ev.createdAt,
          acknowledgedDevices: [ev.deviceId, rt.meta.localDevice.deviceId],
          reclaimable: false,
        };
      } else if (ev.cookieData) {
        remoteRec = {
          ...ev.cookieData,
          version: ev.version,
          sourceDevice: ev.deviceId,
          sourceDeviceName: ev.deviceName,
          deleted: false,
          updatedAt: ev.createdAt,
        };
      } else {
        return false;
      }

      const outcome = resolveItemMerge<CookieRecord>({
        spaceId: rt.spaceId,
        localRecord: localRec && !localRec.deleted ? localRec : undefined,
        localTombstone: localTomb,
        remoteRecord: remoteRec,
        remoteTombstone: remoteTomb,
        primaryDeviceId,
      });

      if (outcome.conflict) {
        this.supersedeConflictsForObject(rt, ev.objectId, nowMs);
        rt.conflicts[outcome.conflict.conflictId] = outcome.conflict;
      } else if (outcome.comparison === 'REMOTE_NEWER') {
        this.supersedeConflictsForObject(rt, ev.objectId, nowMs);
      }

      if (outcome.winner === 'tombstone' && outcome.tombstone) {
        const ack = new Set(outcome.tombstone.acknowledgedDevices ?? []);
        ack.add(rt.meta.localDevice.deviceId);
        outcome.tombstone.acknowledgedDevices = Array.from(ack);
        rt.tombstones[ev.objectId] = outcome.tombstone;

        const baseRec = localRec ?? (ev.cookieData ? { ...ev.cookieData, version: ev.version } : undefined);
        if (baseRec) {
          rt.cookies[ev.objectId] = {
            ...baseRec,
            version: outcome.tombstone.deleteVersion,
            deleted: true,
            deleteReason: ev.deleteReason ?? baseRec.deleteReason ?? 'explicit',
            updatedAt: Math.max(baseRec.updatedAt, ev.createdAt),
            syncStatus: 'DELETED',
          };
        }
        return outcome.changedLocal || Boolean(localRec && !localRec.deleted);
      }

      if (outcome.winner === 'remote' && outcome.record) {
        // Track rolling token flips
        const echoKey = buildEchoCookieKey(outcome.record);
        this.rollingTokenDamper.recordUpdate(echoKey, ev.siteKey, ev.deviceId, nowMs);

        rt.cookies[ev.objectId] = {
          ...outcome.record,
          deleted: false,
          syncStatus: applySyncStatus,
        };
        delete rt.tombstones[ev.objectId];
        return true;
      }

      if (outcome.winner === 'local' && outcome.record) {
        rt.cookies[ev.objectId] = outcome.record;
      }
      return false;
    }

    // LocalStorage event
    const localRec = rt.localStorage[ev.objectId];
    const localTomb = rt.tombstones[ev.objectId];

    let remoteRec: LocalStorageRecord | undefined;
    let remoteTomb: Tombstone | undefined;

    if (ev.operation === 'DELETE') {
      remoteTomb = {
        objectId: ev.objectId,
        objectType: 'localStorage',
        siteKey: ev.siteKey,
        trackId: ev.trackId,
        deleteVersion: ev.version,
        previousVersion: ev.baseVersion ?? null,
        sourceDevice: ev.deviceId,
        reason: 'explicit',
        createdAt: ev.createdAt,
        acknowledgedDevices: [ev.deviceId, rt.meta.localDevice.deviceId],
        reclaimable: false,
      };
    } else if (ev.localStorageData) {
      remoteRec = {
        ...ev.localStorageData,
        version: ev.version,
        sourceDevice: ev.deviceId,
        sourceDeviceName: ev.deviceName,
        deleted: false,
        updatedAt: ev.createdAt,
      };
    } else {
      return false;
    }

    const outcome = resolveItemMerge<LocalStorageRecord>({
      spaceId: rt.spaceId,
      localRecord: localRec && !localRec.deleted ? localRec : undefined,
      localTombstone: localTomb,
      remoteRecord: remoteRec,
      remoteTombstone: remoteTomb,
      primaryDeviceId,
    });

    if (outcome.conflict) {
      this.supersedeConflictsForObject(rt, ev.objectId, nowMs);
      rt.conflicts[outcome.conflict.conflictId] = outcome.conflict;
    } else if (outcome.comparison === 'REMOTE_NEWER') {
      this.supersedeConflictsForObject(rt, ev.objectId, nowMs);
    }

    if (outcome.winner === 'tombstone' && outcome.tombstone) {
      rt.tombstones[ev.objectId] = outcome.tombstone;
      const baseRec =
        localRec ?? (ev.localStorageData ? { ...ev.localStorageData, version: ev.version } : undefined);
      if (baseRec) {
        rt.localStorage[ev.objectId] = {
          ...baseRec,
          version: outcome.tombstone.deleteVersion,
          deleted: true,
          updatedAt: Math.max(baseRec.updatedAt, ev.createdAt),
          syncStatus: 'DELETED',
        };
      }
      return outcome.changedLocal || Boolean(localRec && !localRec.deleted);
    }

    if (outcome.winner === 'remote' && outcome.record) {
      rt.localStorage[ev.objectId] = {
        ...outcome.record,
        deleted: false,
        syncStatus: applySyncStatus,
      };
      delete rt.tombstones[ev.objectId];
      return true;
    }

    return false;
  }

  /**
   * Chromium's `chrome.cookies.remove({ url, name })` removes ALL cookies matching `(url, name)`
   * regardless of `domain`, `hostOnly`, or `path` — e.g. deleting `sub.example.com /admin`
   * collaterally destroys `sub.example.com /` and `.example.com /` siblings with the same name!
   * Snapshots innocent colliding siblings before removal, suppresses collateral remove/restore
   * echoes, deletes the exact target, and immediately restores any collaterally removed siblings.
   */
  private async removeExactBrowserCookie(
    target: Pick<
      BrowserCookieInput,
      'domain' | 'hostOnly' | 'path' | 'name' | 'secure' | 'sameSite' | 'partitionKey'
    > & { storeId?: string; storeScope?: string },
    targetHash: string,
    nowMs: number,
  ): Promise<void> {
    const url = buildCookieUrl(target);
    const rawStore = target.storeId ?? target.storeScope;
    const storeId = rawStore && rawStore !== 'default' ? rawStore : undefined;
    const targetPk = target.partitionKey?.topLevelSite ?? '';

    let collidingSiblings: BrowserCookieInput[] = [];
    try {
      const matched = await this.browser.getAllCookies({ url, storeId });
      collidingSiblings = matched.filter(
        (c) =>
          c.name === target.name &&
          (c.partitionKey?.topLevelSite ?? '') === targetPk &&
          !matchesCookieIdentity(c, {
            domain: target.domain,
            hostOnly: target.hostOnly,
            path: target.path || '/',
            name: target.name,
            partitionKey: target.partitionKey,
          }),
      );
    } catch {
      collidingSiblings = [];
    }

    this.changeDetector.discardCookieKey(buildEchoCookieKey(target));
    this.echoSuppressor.registerCookieMutation(target, 'remove', targetHash, nowMs);

    for (const sib of collidingSiblings) {
      const sibHash = cookieContentCanonicalHash(sib);
      this.changeDetector.discardCookieKey(buildEchoCookieKey(sib));
      this.echoSuppressor.registerCookieMutation(sib, 'remove', sibHash, nowMs);
    }

    await this.browser.removeCookie({
      url,
      name: target.name,
      storeId,
      partitionKey: target.partitionKey,
    });

    for (const sib of collidingSiblings) {
      const sibUrl = buildCookieUrl(sib);
      const stillPresent = await findExactBrowserCookie(this.browser, {
        url: sibUrl,
        domain: sib.domain,
        hostOnly: sib.hostOnly,
        path: sib.path || '/',
        name: sib.name,
        storeId: sib.storeId && sib.storeId !== 'default' ? sib.storeId : undefined,
        partitionKey: sib.partitionKey,
      });
      if (!stillPresent) {
        const sibHash = cookieContentCanonicalHash(sib);
        this.echoSuppressor.registerCookieMutation(sib, 'set', sibHash, nowMs);
        await applyCookieWithVerification(this.browser, sib, nowMs);
      }
    }
  }

  private async applyTrackToBrowser(
    rt: LoadedSpaceRuntime,
    siteKey: string,
    trackId: string,
    options: {
      cleanStale: boolean;
      triggerRefresh: boolean;
      allowLocalTrackSwitch?: boolean;
      deleteReasonsByObject?: Map<string, string>;
    },
  ): Promise<{
    appliedCookies: number;
    failedCookies: number;
    changedAny: boolean;
    changedLocalStorage: boolean;
  }> {
    const nowMs = this.now();
    const policy = this.getEffectivePolicyForDevice(rt, siteKey, siteKey);
    const isBlacklisted = rt.rulesEngine.isBlacklisted(siteKey).blacklisted;
    if (
      isBlacklisted ||
      (!options.allowLocalTrackSwitch &&
        (policy.excluded || policy.direction === 'disabled' || policy.direction === 'push_only'))
    ) {
      return { appliedCookies: 0, failedCookies: 0, changedAny: false, changedLocalStorage: false };
    }
    const shouldApplyCookies = options.allowLocalTrackSwitch ? true : policy.syncCookies;
    const shouldApplyLs = options.allowLocalTrackSwitch
      ? rt.meta.space.settings.syncLocalStorage
      : policy.syncLocalStorage;
    let appliedCookies = 0;
    let failedCookies = 0;
    let changedLocalStorage = false;
    const changedVersions: string[] = [];

    const trackCookies = Object.values(rt.cookies).filter((c) => c.trackId === trackId);
    const liveTrackCookies = trackCookies.filter((c) => !c.deleted);
    const deletedTrackCookies = trackCookies.filter((c) => c.deleted);

    // Clean Track Switch: remove stale browser cookies for siteKey not present in target track
    if (options.cleanStale && shouldApplyCookies) {
      const targetKeys = new Set(liveTrackCookies.map((c) => buildEchoCookieKey(c)));
      const browserCookies = await this.browser.getAllCookies();
      for (const bc of browserCookies) {
        if (!domainMatchesSiteKey(bc.domain, siteKey, rt.meta.rules.ssoGroups)) continue;
        if (rt.meta.space.settings.filterAnalyticsNoiseCookies && isAnalyticsNoiseCookie(bc.name)) {
          continue;
        }
        const key = buildEchoCookieKey(bc);
        if (!targetKeys.has(key)) {
          try {
            await this.removeExactBrowserCookie(bc, cookieContentCanonicalHash(bc), nowMs);
            changedVersions.push(`clean:${key}`);
          } catch {
            // ignore removal error for already missing cookie
          }
        }
      }
    }

    // Apply deletions (Tombstones) unless scope was remote_track_only
    if (shouldApplyCookies) {
      for (const delRec of deletedTrackCookies) {
        const delReason = options.deleteReasonsByObject?.get(delRec.logicalId) ?? delRec.deleteReason;
        if (delReason === 'remote_track_only') {
          continue;
        }
        const url = buildCookieUrl(delRec);
        const existingInJar = await findExactBrowserCookie(this.browser, {
          url,
          domain: delRec.domain,
          hostOnly: delRec.hostOnly,
          path: delRec.path || '/',
          name: delRec.name,
          storeId: delRec.storeScope !== 'default' ? delRec.storeScope : undefined,
          partitionKey: delRec.partitionKey,
        });
        if (existingInJar) {
          await this.removeExactBrowserCookie(
            delRec,
            cookieContentCanonicalHash(existingInJar),
            nowMs,
          );
          delete rt.meta.appliedCookieHashes[delRec.logicalId];
          changedVersions.push(`del:${delRec.logicalId}:${delRec.version.versionId}`);
        }
      }

      // Apply live cookies with EchoSuppressor + read-back verification
      for (const rec of liveTrackCookies) {
        // Never silently re-apply a locally expired or local_only-deleted cookie until a newer version arrives
        if (!options.cleanStale && (rec.syncStatus === 'EXPIRED' || rec.syncStatus === 'REMOTE_ONLY')) {
          continue;
        }
        const targetHash = cookieContentCanonicalHash(rec);
        const url = buildCookieUrl(rec);
        const currentInJar = await findExactBrowserCookie(this.browser, {
          url,
          domain: rec.domain,
          hostOnly: rec.hostOnly,
          path: rec.path || '/',
          name: rec.name,
          storeId: rec.storeScope !== 'default' ? rec.storeScope : undefined,
          partitionKey: rec.partitionKey,
        });

        if (currentInJar && cookieContentCanonicalHash(currentInJar) === targetHash) {
          if (rec.syncStatus !== 'LOCAL_NEWER') {
            rec.syncStatus = 'IN_SYNC';
          }
          rt.meta.appliedCookieHashes[rec.logicalId] = targetHash;
          continue;
        }

        this.echoSuppressor.registerCookieMutation(rec, 'set', targetHash, nowMs);
        const verification = await applyCookieWithVerification(this.browser, rec, nowMs);
        rec.applyResult = verification;

        if (verification.accepted) {
          rec.syncStatus = 'IN_SYNC';
          rt.meta.appliedCookieHashes[rec.logicalId] = targetHash;
          if (rt.meta.dismissedApplyFailures) {
            delete rt.meta.dismissedApplyFailures[rec.logicalId];
          }
          appliedCookies += 1;
          changedVersions.push(`set:${rec.logicalId}:${rec.version.versionId}`);
        } else if (
          verification.expired ||
          (!rec.session && rec.expirationDate !== undefined && rec.expirationDate <= nowMs / 1000)
        ) {
          rec.syncStatus = 'EXPIRED';
        } else {
          rec.syncStatus = 'APPLY_FAILED';
          failedCookies += 1;
          await this.logger.log({
            spaceId: rt.spaceId,
            level: 'warn',
            phase: 'apply_cookie',
            siteKey,
            objectId: rec.logicalId,
            message: `Failed to apply cookie "${rec.name}": ${verification.reason ?? 'unknown reason'}`,
            timestamp: nowMs,
          });
        }
      }
    }

    // Apply LocalStorage records grouped by strict Origin
    if (shouldApplyLs) {
      const trackLs = Object.values(rt.localStorage).filter((l) => l.trackId === trackId);
      const byOrigin = new Map<string, LocalStorageRecord[]>();
      for (const l of trackLs) {
        const arr = byOrigin.get(l.origin) ?? [];
        arr.push(l);
        byOrigin.set(l.origin, arr);
      }

      // During Clean Track Switch (e.g. account rotation or clean_new), also include every
      // known site origin (other tracks' LS records) and every currently open tab origin
      // for this siteKey so stale LocalStorage from the previous account is wiped even when
      // the target account has 0 LocalStorage records.
      const clearedOrigins: string[] = [];
      if (options.cleanStale) {
        for (const rec of Object.values(rt.localStorage)) {
          if (rec.siteKey === siteKey && !byOrigin.has(rec.origin)) {
            byOrigin.set(rec.origin, []);
          }
        }
        try {
          const tabs = await this.browser.queryTabs();
          for (const tab of tabs) {
            const origin = tab.url ? normalizeOriginSafe(tab.url) : null;
            if (
              origin &&
              resolveSiteKey(origin, rt.meta.rules.ssoGroups) === siteKey &&
              !byOrigin.has(origin)
            ) {
              byOrigin.set(origin, []);
            }
          }
        } catch {
          // ignore tab query errors
        }
      }

      for (const [origin, records] of byOrigin.entries()) {
        const lsState = await this.browser.getLocalStorage(origin);
        if (!lsState.available) {
          for (const rec of records) {
            if (!rec.deleted) {
              rec.contextAvailable = false;
              if (rec.syncStatus !== 'IN_SYNC') {
                rec.syncStatus = 'REMOTE_NEWER';
              }
            }
          }
          continue;
        }
        if (options.cleanStale) {
          clearedOrigins.push(origin);
        }

        const mutations: Array<{ key: string; value?: string; deleted?: boolean }> = [];
        if (options.cleanStale) {
          const liveKeys = new Set(records.filter((r) => !r.deleted).map((r) => r.key));
          for (const k of Object.keys(lsState.items)) {
            if (!liveKeys.has(k)) {
              this.echoSuppressor.registerLocalStorageMutation(origin, k, 'remove', '', nowMs);
              mutations.push({ key: k, deleted: true });
            }
          }
        }

        for (const rec of records) {
          if (rec.deleted) {
            const delReason = options.deleteReasonsByObject?.get(rec.logicalId);
            if (delReason !== 'remote_track_only' && Object.prototype.hasOwnProperty.call(lsState.items, rec.key)) {
              this.echoSuppressor.registerLocalStorageMutation(origin, rec.key, 'remove', '', nowMs);
              mutations.push({ key: rec.key, deleted: true });
            }
          } else {
            rec.contextAvailable = true;
            const hasOwnKey = Object.prototype.hasOwnProperty.call(lsState.items, rec.key);
            const currentLsVal = hasOwnKey ? lsState.items[rec.key] : undefined;
            if (!hasOwnKey || currentLsVal !== rec.value) {
              this.echoSuppressor.registerLocalStorageMutation(origin, rec.key, 'set', rec.value, nowMs);
              mutations.push({ key: rec.key, value: rec.value });
            }
            rec.syncStatus = 'IN_SYNC';
            rt.meta.appliedLsHashes[rec.logicalId] = rec.value;
          }
        }

        if (mutations.length > 0) {
          const res = await this.browser.applyLocalStorage(origin, mutations);
          if (res.applied) {
            changedLocalStorage = true;
          } else {
            for (const rec of records) {
              if (!rec.deleted) rec.contextAvailable = false;
            }
          }
        }
      }

      if (options.cleanStale) {
        rt.meta.pendingCleanLsBySite = rt.meta.pendingCleanLsBySite ?? {};
        rt.meta.pendingCleanLsBySite[siteKey] = {
          trackId,
          clearedOrigins,
        };
      }
    }

    // Only real Cookie changes (never LocalStorage-only background churn) may trigger optional page reloads
    const changedAny = changedVersions.length > 0;
    if (changedAny && options.triggerRefresh) {
      changedVersions.sort();
      const versionDigest = await sha256Hex(changedVersions.join('|'));
      const refreshRes = await this.autoRefresh.notifyAppliedChanges({
        siteKey,
        versionDigest,
        autoRefreshEnabled: policy.autoRefresh && rt.meta.space.settings.autoRefresh,
        refreshProtectionEnabled: rt.meta.space.settings.refreshProtection,
        immediate: this.refreshCoalesceMs <= 0,
      });
      if (refreshRes.reloadedTabIds.length > 0) {
        // Shield against reload-induced server Set-Cookie ping-pong loops
        this.postReloadPushMuteUntil.set(siteKey, this.now() + 12_000);
      }
    }

    return { appliedCookies, failedCookies, changedAny, changedLocalStorage };
  }

  private isTransportOrAuthError(se: StructuredError): boolean {
    if (se.code === 'ERR_NETWORK_OFFLINE' || se.code === 'ERR_STORAGE_FULL' || se.retryable) {
      return true;
    }
    if (
      se.status === 401 ||
      se.status === 403 ||
      se.status === 408 ||
      se.status === 423 ||
      se.status === 429 ||
      se.status === 507 ||
      (typeof se.status === 'number' && se.status >= 500)
    ) {
      return true;
    }
    return false;
  }

  private recordCorruptedPath(
    rt: LoadedSpaceRuntime,
    path: string,
    err: unknown,
    nowMs: number,
  ): void {
    if (!rt.meta.corruptedPaths.includes(path)) {
      rt.meta.corruptedPaths.push(path);
    }
    const se = toStructuredError(err, 'decrypt', path);
    void this.logger.log({
      spaceId: rt.spaceId,
      level: 'error',
      phase: 'integrity',
      code: se.code || 'ERR_CORRUPT_REMOTE_FILE',
      message: `Isolated corrupt remote file ${path}: ${se.message}`,
      suggestion: se.suggestion,
      timestamp: nowMs,
    });
  }

  private upsertRetryTask(
    rt: LoadedSpaceRuntime,
    taskType: SyncTask['taskType'],
    errorCode: string,
    errorMessage: string,
  ): void {
    const nowMs = this.now();
    const existing = rt.retryTasks.find(
      (t) => t.taskType === taskType && (t.status === 'RETRYING' || t.status === 'QUEUED'),
    );
    if (existing) {
      existing.retryCount += 1;
      existing.errorCode = errorCode;
      existing.errorMessage = errorMessage;
      existing.nextRetryAt = nowMs + Math.min(300_000, 5_000 * 2 ** Math.min(existing.retryCount, 6));
      existing.relatedObjectIds = rt.pendingOutboundEvents.map((e) => e.objectId);
      return;
    }

    rt.retryTasks.push({
      taskId: randomId('task'),
      spaceId: rt.spaceId,
      taskType,
      relatedObjectIds: rt.pendingOutboundEvents.map((e) => e.objectId),
      status: 'RETRYING',
      retryCount: 1,
      nextRetryAt: nowMs + 5_000,
      errorCode,
      errorMessage,
      createdAt: nowMs,
    });
  }

  private haltWriteRetryTasks(rt: LoadedSpaceRuntime, err: StructuredError): void {
    for (const task of rt.retryTasks) {
      if (task.status === 'RETRYING' || task.status === 'QUEUED') {
        task.status = 'FAILED';
        task.errorCode = err.code;
        task.errorMessage = err.message;
        task.nextRetryAt = undefined;
      }
    }
  }

  // =========================================================================
  // LocalStorage Hooks (Content Script Bridge)
  // =========================================================================

  async ingestLocalStorageSnapshot(origin: string, items: Record<string, string>): Promise<void> {
    await this.ensureInitialized();
    const normOrigin = normalizeOriginSafe(origin);
    if (!normOrigin) return;

    return this.enqueueOp(async () => {
      const rt = this.runtime;
      if (!rt || rt.meta.globalPaused || rt.meta.localDevice.state !== 'active') return;
      if (!rt.dekKeyring[rt.meta.space.keyEpoch]) return;

      const nowMs = this.now();
      const siteKey = resolveSiteKey(normOrigin, rt.meta.rules.ssoGroups);
      if (!siteKey) return;

      const hasItems = Object.keys(items).length > 0;
      const cascadeAutoLsEnvSync = async () => {
        // 1. If this mounted page is the TARGET of any enabled autoSync + syncLocalStorage env rule
        // (e.g. developer opened http://localhost:3000 AFTER logging into prod), hydrate target LS/cookies!
        await this.hydrateAutoEnvTargetsOnMount(rt, normOrigin);
        // 2. If this mounted page is a SOURCE with items, cascade to target environments
        if (hasItems) {
          await this.runAutoEnvSyncForSourceSites(rt, [siteKey], { onlyWithLocalStorage: true });
        }
      };

      if (!this.isSiteManagedOrRemotelyTracked(rt, siteKey)) {
        await cascadeAutoLsEnvSync();
        return;
      }

      const policy = this.getEffectivePolicyForDevice(rt, normOrigin, siteKey);
      const sitePolicy = this.getEffectivePolicyForDevice(rt, siteKey, siteKey);
      if (policy.excluded || sitePolicy.excluded) {
        // Still allow target-side dev env hydration when localhost preset blacklist is active!
        await this.hydrateAutoEnvTargetsOnMount(rt, normOrigin);
        return;
      }
      if (!sitePolicy.syncLocalStorage || sitePolicy.direction === 'disabled') {
        await cascadeAutoLsEnvSync();
        return;
      }

      let binding = rt.meta.localDevice.siteBindings[siteKey];
      if (binding?.state === 'BLACKLISTED') {
        await this.hydrateAutoEnvTargetsOnMount(rt, normOrigin);
        return;
      }
      if (binding?.state === 'PENDING_CHOICE' || binding?.state === 'UNMANAGED') {
        await cascadeAutoLsEnvSync();
        return;
      }

      if (!binding || !binding.trackId) {
        const remoteTracks = Object.values(rt.tracks).filter((t) => t.siteKey === siteKey);
        const itemCount = Object.keys(items).length;
        if (itemCount === 0 && remoteTracks.length === 0) return;
        if (remoteTracks.length === 0 && sitePolicy.direction === 'pull_only') {
          await cascadeAutoLsEnvSync();
          return;
        }

        const decision = evaluateSiteDiscovery({
          siteKey,
          isBlacklisted: false,
          existingBinding: undefined,
          localCookies: [],
          localStorageCount: itemCount,
          remoteTracks,
          deviceId: rt.meta.localDevice.deviceId,
          deviceName: rt.meta.localDevice.name,
          filterNoise: rt.meta.space.settings.filterAnalyticsNoiseCookies,
          nowMs,
        });
        rt.meta.localDevice.siteBindings[siteKey] = decision.binding;
        binding = decision.binding;

        if (decision.action === 'await_user_choice' && decision.pendingDecision) {
          const autoAction = resolveAutomaticSiteDecisionAction({
            localDeviceId: rt.meta.localDevice.deviceId,
            settings: rt.meta.space.settings,
            remoteTracks,
            hasLocalData: decision.pendingDecision.hasLocalData,
          });
          if (autoAction) {
            await this.resolveSiteDecisionInternal(siteKey, autoAction, {
              deferSyncAndPersist: true,
              triggerRefresh: false,
              decidedBy: 'auto',
            });
            binding = rt.meta.localDevice.siteBindings[siteKey];
          } else {
            rt.pendingDecisions[siteKey] = decision.pendingDecision;
            await this.persistRuntime(rt);
            await cascadeAutoLsEnvSync();
            return;
          }
        }
        if (decision.createdTrack) {
          rt.tracks[decision.createdTrack.trackId] = decision.createdTrack;
        }
      }

      const trackId = binding?.trackId;
      if (!trackId) {
        await cascadeAutoLsEnvSync();
        return;
      }

      // Apply any deferred one-shot env injection or safety-undo LocalStorage snapshot before
      // comparing or uploading local keys, so stale disk LS never overwrites the target track.
      if (rt.meta.pendingEnvLsByOrigin?.[normOrigin]) {
        await this.hydrateAutoEnvTargetsOnMount(rt, normOrigin);
        return;
      }

      // 1. Apply pending remote LocalStorage records & tombstones for this strict origin (D-008)
      //    If this origin had a deferred Clean Track Switch wipe (tab was closed when track changed),
      //    evict stale keys from the previous account BEFORE uploading local-only keys, and reload once.
      const mutationsToApply: Array<{ key: string; value?: string; deleted?: boolean }> = [];
      let stateMutated = false;
      const remoteRecords = Object.values(rt.localStorage).filter(
        (r) => r.trackId === trackId && r.origin === normOrigin,
      );
      const handledKeys = new Set<string>();

      const pendingSiteClean = rt.meta.pendingCleanLsBySite?.[siteKey];
      const isPendingOriginClean = Boolean(
        pendingSiteClean &&
          pendingSiteClean.trackId === trackId &&
          !pendingSiteClean.clearedOrigins.includes(normOrigin),
      );
      let effectiveItems: Record<string, string> = items;
      if (isPendingOriginClean && pendingSiteClean) {
        pendingSiteClean.clearedOrigins.push(normOrigin);
        stateMutated = true;
        const liveRemoteKeys = new Set(remoteRecords.filter((r) => !r.deleted).map((r) => r.key));
        const filtered: Record<string, string> = Object.create(null);
        for (const [k, v] of Object.entries(items)) {
          if (!liveRemoteKeys.has(k)) {
            this.echoSuppressor.registerLocalStorageMutation(normOrigin, k, 'remove', '', nowMs);
            mutationsToApply.push({ key: k, deleted: true });
          } else {
            Object.defineProperty(filtered, k, {
              value: v,
              enumerable: true,
              writable: true,
              configurable: true,
            });
          }
        }
        effectiveItems = filtered;
      }

      for (const rec of remoteRecords) {
        handledKeys.add(rec.key);
        if (rec.deleted) {
          if (
            (isPendingOriginClean ||
              (policy.direction !== 'push_only' && sitePolicy.direction !== 'push_only')) &&
            Object.prototype.hasOwnProperty.call(items, rec.key)
          ) {
            this.echoSuppressor.registerLocalStorageMutation(normOrigin, rec.key, 'remove', '', nowMs);
            mutationsToApply.push({ key: rec.key, deleted: true });
          }
        } else {
          if (!rec.contextAvailable) {
            rec.contextAvailable = true;
            stateMutated = true;
          }
          const hasOwnKey = Object.prototype.hasOwnProperty.call(items, rec.key);
          const currentLsVal = hasOwnKey ? items[rec.key] : undefined;
          if (
            (isPendingOriginClean ||
              (policy.direction !== 'push_only' && sitePolicy.direction !== 'push_only')) &&
            (!hasOwnKey || currentLsVal !== rec.value) &&
            (isPendingOriginClean ||
              rec.syncStatus === 'REMOTE_NEWER' ||
              rec.syncStatus === 'REMOTE_ONLY' ||
              !hasOwnKey)
          ) {
            this.echoSuppressor.registerLocalStorageMutation(normOrigin, rec.key, 'set', rec.value, nowMs);
            mutationsToApply.push({ key: rec.key, value: rec.value });
            rec.syncStatus = 'IN_SYNC';
            rt.meta.appliedLsHashes[rec.logicalId] = rec.value;
            stateMutated = true;
          } else if (hasOwnKey && currentLsVal === rec.value && rec.syncStatus !== 'IN_SYNC' && rec.syncStatus !== 'LOCAL_NEWER') {
            rec.syncStatus = 'IN_SYNC';
            rt.meta.appliedLsHashes[rec.logicalId] = rec.value;
            stateMutated = true;
          }
        }
      }

      if (mutationsToApply.length > 0) {
        await this.browser.applyLocalStorage(normOrigin, mutationsToApply);
        if (isPendingOriginClean) {
          this.postTrackSwitchLeaveMuteUntil.set(siteKey, this.now() + 2_500);
          await this.reloadTabsForUserAction(rt, (tabUrl) => normalizeOriginSafe(tabUrl) === normOrigin);
        }
      }

      // 2. Upload local-only keys if direction allows push
      let emittedAny = false;
      if (sitePolicy.direction !== 'pull_only') {
        for (const [key, value] of Object.entries(effectiveItems)) {
          if (handledKeys.has(key)) {
            const logicalId = buildLocalStorageLogicalId(trackId, normOrigin, key);
            const existing = rt.localStorage[logicalId];
            if (
              existing &&
              !existing.deleted &&
              existing.value !== value &&
              !mutationsToApply.some((m) => m.key === key)
            ) {
              const res = await this.emitLocalStorageUpsert(
                rt,
                siteKey,
                trackId,
                normOrigin,
                key,
                value,
                'UPDATE',
              );
              if (res) emittedAny = true;
            }
            continue;
          }
          const logicalId = buildLocalStorageLogicalId(trackId, normOrigin, key);
          if (rt.tombstones[logicalId]) {
            continue;
          }
          const res = await this.emitLocalStorageUpsert(
            rt,
            siteKey,
            trackId,
            normOrigin,
            key,
            value,
            'CREATE',
          );
          if (res) emittedAny = true;
        }
      }

      if (stateMutated || mutationsToApply.length > 0 || emittedAny) {
        rt.meta.space.status = this.computeStatus(rt);
        await this.persistRuntime(rt);
      }
      if (emittedAny) {
        await this.attemptAutoPush(rt, 'localstorage_snapshot_push');
      }
      await cascadeAutoLsEnvSync();
    });
  }

  async ingestLocalStorageMutations(
    origin: string,
    changes: Array<{ key: string; value?: string; deleted?: boolean }>,
    options?: { isPageLeaving?: boolean },
  ): Promise<void> {
    await this.ensureInitialized();
    const normOrigin = normalizeOriginSafe(origin);
    if (!normOrigin || changes.length === 0) return;

    return this.enqueueOp(async () => {
      const rt = this.runtime;
      if (!rt || rt.meta.globalPaused || rt.meta.localDevice.state !== 'active') return;
      if (!rt.dekKeyring[rt.meta.space.keyEpoch]) return;

      const nowMs = this.now();
      const siteKey = resolveSiteKey(normOrigin, rt.meta.rules.ssoGroups);
      if (!siteKey) return;

      // Shield newly switched/rotated/clean_new accounts from stale pagehide LS writes
      // emitted by the unloading page of the previous account.
      if (options?.isPageLeaving) {
        const leaveMuteUntil = this.postTrackSwitchLeaveMuteUntil.get(siteKey) ?? 0;
        if (leaveMuteUntil > nowMs) {
          return;
        }
      }

      // Filter out echo-suppressed localStorage mutations once up front
      const nonEchoChanges = changes.filter((ch) => {
        const op = ch.deleted ? 'remove' : 'set';
        const val = ch.value ?? '';
        return !this.echoSuppressor.shouldSuppressLocalStorageEvent(normOrigin, ch.key, op, val, nowMs);
      });
      if (nonEchoChanges.length === 0) return;

      const cascadeAutoLsEnvSync = async () => {
        await this.runAutoEnvSyncForSourceSites(rt, [siteKey], { onlyWithLocalStorage: true });
      };

      if (!this.isSiteManagedOrRemotelyTracked(rt, siteKey)) {
        await cascadeAutoLsEnvSync();
        return;
      }

      const policy = this.getEffectivePolicyForDevice(rt, normOrigin, siteKey);
      const sitePolicy = this.getEffectivePolicyForDevice(rt, siteKey, siteKey);
      if (policy.excluded || sitePolicy.excluded) {
        return;
      }
      if (
        !sitePolicy.syncLocalStorage ||
        sitePolicy.direction === 'disabled' ||
        sitePolicy.direction === 'pull_only'
      ) {
        await cascadeAutoLsEnvSync();
        return;
      }

      let binding = rt.meta.localDevice.siteBindings[siteKey];
      if (binding?.state === 'BLACKLISTED') {
        return;
      }
      if (binding?.state === 'PENDING_CHOICE' || binding?.state === 'UNMANAGED') {
        await cascadeAutoLsEnvSync();
        return;
      }

      if (!binding || !binding.trackId) {
        const remoteTracks = Object.values(rt.tracks).filter((t) => t.siteKey === siteKey);
        const decision = evaluateSiteDiscovery({
          siteKey,
          isBlacklisted: false,
          existingBinding: undefined,
          localCookies: [],
          localStorageCount: nonEchoChanges.filter((c) => !c.deleted).length,
          remoteTracks,
          deviceId: rt.meta.localDevice.deviceId,
          deviceName: rt.meta.localDevice.name,
          filterNoise: rt.meta.space.settings.filterAnalyticsNoiseCookies,
          nowMs,
        });
        rt.meta.localDevice.siteBindings[siteKey] = decision.binding;
        binding = decision.binding;
        if (decision.action === 'await_user_choice' && decision.pendingDecision) {
          const autoAction = resolveAutomaticSiteDecisionAction({
            localDeviceId: rt.meta.localDevice.deviceId,
            settings: rt.meta.space.settings,
            remoteTracks,
            hasLocalData: decision.pendingDecision.hasLocalData,
          });
          if (autoAction) {
            await this.resolveSiteDecisionInternal(siteKey, autoAction, {
              deferSyncAndPersist: true,
              triggerRefresh: false,
              decidedBy: 'auto',
            });
            binding = rt.meta.localDevice.siteBindings[siteKey];
            if (autoAction.type === 'use_remote_track') {
              await this.persistRuntime(rt);
              await cascadeAutoLsEnvSync();
              return;
            }
          } else {
            rt.pendingDecisions[siteKey] = decision.pendingDecision;
            await this.persistRuntime(rt);
            await cascadeAutoLsEnvSync();
            return;
          }
        }
        if (decision.createdTrack) {
          rt.tracks[decision.createdTrack.trackId] = decision.createdTrack;
        }
      }

      const trackId = binding?.trackId;
      if (!trackId) {
        await cascadeAutoLsEnvSync();
        return;
      }

      let emittedAny = false;
      for (const ch of nonEchoChanges) {
        const val = ch.value ?? '';
        const logicalId = buildLocalStorageLogicalId(trackId, normOrigin, ch.key);
        if (ch.deleted) {
          const existing = rt.localStorage[logicalId];
          if (existing && !existing.deleted) {
            await this.emitLocalStorageDelete(rt, existing, 'explicit', 'explicit');
            emittedAny = true;
          }
        } else {
          const res = await this.emitLocalStorageUpsert(
            rt,
            siteKey,
            trackId,
            normOrigin,
            ch.key,
            val,
            'UPDATE',
          );
          if (res) emittedAny = true;
        }
      }

      if (emittedAny) {
        rt.meta.space.status = this.computeStatus(rt);
        await this.persistRuntime(rt);
        await this.attemptAutoPush(rt, 'localstorage_mutation_push');
      }
      await cascadeAutoLsEnvSync();
    });
  }

  // =========================================================================
  // Multi-Track Decisions, Clean Track Switch & Safety Undo
  // =========================================================================

  async getPendingDecisions(): Promise<PendingSiteDecision[]> {
    await this.ensureInitialized();
    const rt = this.runtime;
    if (!rt) return [];
    return Object.values(rt.pendingDecisions).map((d) => ({
      ...d,
      remoteTracks: Object.values(rt.tracks).filter((t) => t.siteKey === d.siteKey),
    }));
  }

  private async captureSafetyUndoPoint(
    rt: LoadedSpaceRuntime,
    siteKey: string,
    reason: string,
  ): Promise<SafetyUndoPoint> {
    const nowMs = this.now();
    const allCookies = await this.browser.getAllCookies();
    const siteCookies = allCookies.filter((c) =>
      domainMatchesSiteKey(c.domain, siteKey, rt.meta.rules.ssoGroups),
    );

    const localStorageByOrigin: Record<string, Record<string, string>> = {};
    const candidateOrigins = new Set<string>();
    for (const lsRec of Object.values(rt.localStorage)) {
      if (lsRec.siteKey === siteKey) candidateOrigins.add(lsRec.origin);
    }
    try {
      const tabs = await this.browser.queryTabs();
      for (const tab of tabs) {
        if (!tab.url) continue;
        const origin = normalizeOriginSafe(tab.url);
        if (origin && resolveSiteKey(origin, rt.meta.rules.ssoGroups) === siteKey) {
          candidateOrigins.add(origin);
        }
      }
    } catch {
      // ignore
    }

    for (const origin of candidateOrigins) {
      const ls = await this.browser.getLocalStorage(origin);
      if (ls.available) {
        localStorageByOrigin[origin] = { ...ls.items };
      }
    }

    const prevBinding = rt.meta.localDevice.siteBindings[siteKey]
      ? { ...rt.meta.localDevice.siteBindings[siteKey] }
      : undefined;

    const point: SafetyUndoPoint = {
      undoId: randomId('undo'),
      spaceId: rt.spaceId,
      siteKey,
      reason,
      createdAt: nowMs,
      previousBinding: prevBinding,
      cookies: siteCookies,
      localStorageByOrigin,
    };

    rt.undoPoints.unshift(point);
    if (rt.undoPoints.length > MAX_UNDO_POINTS) {
      rt.undoPoints = rt.undoPoints.slice(0, MAX_UNDO_POINTS);
    }
    return point;
  }

  async resolveSiteDecision(siteKey: string, action: SiteDecisionAction): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      await this.resolveSiteDecisionInternal(siteKey, action);
    });
  }

  private async resolveSiteDecisionInternal(
    siteKey: string,
    action: SiteDecisionAction,
    options?: {
      deferSyncAndPersist?: boolean;
      triggerRefresh?: boolean;
      decidedBy?: 'auto' | 'user';
    },
  ): Promise<{ appliedCookies: number; failedCookies: number }> {
    const rt = this.requireRuntime();
    const nowMs = this.now();
    const effectivePolicy = this.getEffectivePolicyForDevice(rt, siteKey, siteKey);

    const remoteTracks = Object.values(rt.tracks).filter((t) => t.siteKey === siteKey);
    const allLocalCookies = await this.browser.getAllCookies();
    const localSiteCookies = allLocalCookies.filter(
      (c) =>
        domainMatchesSiteKey(c.domain, siteKey, rt.meta.rules.ssoGroups) &&
        (!rt.meta.space.settings.filterAnalyticsNoiseCookies || !isAnalyticsNoiseCookie(c.name)),
    );

    const outcome = applyUserSiteDecision({
      siteKey,
      action,
      currentBinding: rt.meta.localDevice.siteBindings[siteKey],
      remoteTracks,
      deviceId: rt.meta.localDevice.deviceId,
      deviceName: rt.meta.localDevice.name,
      localCookieCount: localSiteCookies.length,
      localStorageCount: 0,
      nowMs,
    });
    if (options?.decidedBy) {
      outcome.binding.decidedBy = options.decidedBy;
    }

    if (outcome.mode === 'blacklisted') {
      if (outcome.blacklistToAdd) {
        await this.addBlacklistEntryInternal(rt, {
          pattern: outcome.blacklistToAdd.pattern,
          matchType: 'subdomain',
          scope: outcome.blacklistToAdd.scope,
          reason: 'Blacklisted from site decision',
        });
      }
      rt.meta.localDevice.siteBindings[siteKey] = outcome.binding;
      delete rt.pendingDecisions[siteKey];
      if (!options?.deferSyncAndPersist) {
        await this.uploadDeviceManifestIfOnline(rt);
        await this.persistRuntime(rt);
      }
      return { appliedCookies: 0, failedCookies: 0 };
    }

    if (outcome.mode === 'pull_remote_into_local') {
      const targetTrackId = outcome.binding.trackId!;
      // Save SafetyUndoPoint BEFORE overwriting local browser cookies!
      await this.captureSafetyUndoPoint(rt, siteKey, `use_remote_track:${targetTrackId}`);

      rt.meta.localDevice.siteBindings[siteKey] = outcome.binding;
      delete rt.pendingDecisions[siteKey];

      const track = rt.tracks[targetTrackId];
      if (track && !track.memberDeviceIds.includes(rt.meta.localDevice.deviceId)) {
        track.memberDeviceIds.push(rt.meta.localDevice.deviceId);
        track.updatedAt = nowMs;
      }

      let appliedCookies = 0;
      let failedCookies = 0;
      if (
        !effectivePolicy.excluded &&
        effectivePolicy.direction !== 'push_only' &&
        effectivePolicy.direction !== 'disabled'
      ) {
        // Clean Track Switch: remove old local cookies not in target track, then apply target track
        const applyRes = await this.applyTrackToBrowser(rt, siteKey, targetTrackId, {
          cleanStale: true,
          triggerRefresh: options?.triggerRefresh ?? true,
        });
        appliedCookies = applyRes.appliedCookies;
        failedCookies = applyRes.failedCookies;
      }

      if (!options?.deferSyncAndPersist) {
        await this.uploadDeviceManifestIfOnline(rt);
        await this.persistRuntime(rt);
      }
      return { appliedCookies, failedCookies };
    }

    if (outcome.mode === 'push_local_override_remote') {
      const targetTrackId = outcome.binding.trackId!;
      rt.meta.localDevice.siteBindings[siteKey] = outcome.binding;
      delete rt.pendingDecisions[siteKey];

      if (outcome.newTrack) {
        rt.tracks[outcome.newTrack.trackId] = outcome.newTrack;
      }
      const track = rt.tracks[targetTrackId];
      if (track && !track.memberDeviceIds.includes(rt.meta.localDevice.deviceId)) {
        track.memberDeviceIds.push(rt.meta.localDevice.deviceId);
        track.updatedAt = nowMs;
      }

      const canPush =
        !effectivePolicy.excluded &&
        effectivePolicy.direction !== 'pull_only' &&
        effectivePolicy.direction !== 'disabled';

      if (canPush) {
        // Compute which logicalIds exist locally on this device
        const localLogicalIds = new Set<string>();
        for (const c of localSiteCookies) {
          const cHostOnly = resolveEffectiveHostOnly(c.domain, c.hostOnly, c.name);
          const lid = buildCookieLogicalId({
            trackId: targetTrackId,
            storeScope: normalizeCookieStoreScope(c.storeId),
            partitionKey: c.partitionKey,
            hostOnly: cHostOnly,
            domain: normalizeCookieDomain(c.domain, cHostOnly),
            path: c.name.startsWith('__Host-') ? '/' : c.path || '/',
            name: c.name,
          });
          localLogicalIds.add(lid);
        }

        // Delete existing remote cookies on targetTrackId that are NOT present locally (clean override!)
        const existingTrackCookies = Object.values(rt.cookies).filter(
          (c) => c.trackId === targetTrackId && !c.deleted,
        );
        for (const oldRec of existingTrackCookies) {
          if (!localLogicalIds.has(oldRec.logicalId)) {
            await this.emitLocalCookieDelete(rt, oldRec, 'explicit', 'explicit');
          }
        }

        // Upsert all local cookies as causal successors on targetTrackId
        for (const c of localSiteCookies) {
          const cHostOnly = resolveEffectiveHostOnly(c.domain, c.hostOnly, c.name);
          const lid = buildCookieLogicalId({
            trackId: targetTrackId,
            storeScope: normalizeCookieStoreScope(c.storeId),
            partitionKey: c.partitionKey,
            hostOnly: cHostOnly,
            domain: normalizeCookieDomain(c.domain, cHostOnly),
            path: c.name.startsWith('__Host-') ? '/' : c.path || '/',
            name: c.name,
          });
          const existingRec = rt.cookies[lid];
          await this.emitLocalCookieUpsert(
            rt,
            siteKey,
            targetTrackId,
            c,
            'UPDATE',
            existingRec?.version.vectorClock,
          );
        }
      }

      if (!options?.deferSyncAndPersist) {
        if (canPush) {
          await this.tryPushOutboundBestEffort(rt, 'resolve_site_decision');
        }
        await this.uploadDeviceManifestIfOnline(rt);
        await this.persistRuntime(rt);
      }
      return { appliedCookies: 0, failedCookies: 0 };
    }

    if (outcome.mode === 'push_local_new_track' && outcome.newTrack) {
      rt.tracks[outcome.newTrack.trackId] = outcome.newTrack;
      rt.meta.localDevice.siteBindings[siteKey] = outcome.binding;
      delete rt.pendingDecisions[siteKey];

      const canPush =
        !effectivePolicy.excluded &&
        effectivePolicy.direction !== 'pull_only' &&
        effectivePolicy.direction !== 'disabled';

      if (canPush) {
        for (const c of localSiteCookies) {
          await this.emitLocalCookieUpsert(rt, siteKey, outcome.newTrack.trackId, c, 'CREATE');
        }
      }

      if (!options?.deferSyncAndPersist) {
        if (canPush) {
          await this.tryPushOutboundBestEffort(rt, 'resolve_site_decision_new_track');
        }
        await this.uploadDeviceManifestIfOnline(rt);
        await this.persistRuntime(rt);
      }
    }

    return { appliedCookies: 0, failedCookies: 0 };
  }

  async resolveBatchDecisions(siteKeys: string[], action: SiteDecisionAction): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      for (const siteKey of siteKeys) {
        await this.resolveSiteDecisionInternal(siteKey, action);
      }
    });
  }

  private ensureSiteTrackSortOrders(rt: LoadedSpaceRuntime, siteKey: string): SiteTrack[] {
    const sorted = sortSiteTracks(Object.values(rt.tracks).filter((t) => t.siteKey === siteKey));
    sorted.forEach((tr, idx) => {
      if (tr.sortOrder === undefined) {
        tr.sortOrder = idx + 1;
      }
    });
    return sorted;
  }

  private async reconcileSiteTrackFromLiveJar(
    rt: LoadedSpaceRuntime,
    siteKey: string,
    trackId: string,
  ): Promise<boolean> {
    const track = rt.tracks[trackId];
    if (!track || track.siteKey !== siteKey) return false;

    const allCookies = await this.browser.getAllCookies();
    const nowSec = this.now() / 1000;
    let mutated = false;

    for (const cookie of allCookies) {
      if (!cookie.session && cookie.expirationDate !== undefined && cookie.expirationDate <= nowSec) {
        continue;
      }
      if (!domainMatchesSiteKey(cookie.domain, siteKey, rt.meta.rules.ssoGroups)) {
        continue;
      }
      if (
        rt.meta.space.settings.filterAnalyticsNoiseCookies &&
        isAnalyticsNoiseCookie(cookie.name)
      ) {
        continue;
      }

      const storeScope = normalizeCookieStoreScope(cookie.storeId);
      const isHostPrefix = cookie.name.startsWith('__Host-');
      const hostOnly = resolveEffectiveHostOnly(cookie.domain, cookie.hostOnly, cookie.name);
      const normDomain = normalizeCookieDomain(cookie.domain, hostOnly);
      const path = isHostPrefix ? '/' : cookie.path || '/';
      const secure =
        isHostPrefix ||
        cookie.name.startsWith('__Secure-') ||
        cookie.sameSite === 'no_restriction'
          ? true
          : cookie.secure;

      const logicalId = buildCookieLogicalId({
        trackId,
        storeScope,
        partitionKey: cookie.partitionKey,
        hostOnly,
        domain: normDomain,
        path,
        name: cookie.name,
      });

      const liveHash = cookieContentCanonicalHash({
        ...cookie,
        domain: normDomain,
        path,
        hostOnly,
        secure,
      });

      const existing = rt.cookies[logicalId];
      const lastAppliedHash = rt.meta.appliedCookieHashes[logicalId];
      if (lastAppliedHash && lastAppliedHash === liveHash) {
        continue;
      }
      if (existing && !existing.deleted && cookieContentCanonicalHash(existing) === liveHash) {
        rt.meta.appliedCookieHashes[logicalId] = liveHash;
        continue;
      }
      if (
        !lastAppliedHash &&
        existing &&
        existing.sourceDevice !== rt.meta.localDevice.deviceId &&
        (existing.syncStatus === 'REMOTE_NEWER' || existing.syncStatus === 'REMOTE_ONLY')
      ) {
        continue;
      }

      const emitted = await this.emitLocalCookieUpsert(
        rt,
        siteKey,
        trackId,
        cookie,
        existing && !existing.deleted ? 'UPDATE' : 'CREATE',
      );
      if (emitted) {
        rt.meta.appliedCookieHashes[logicalId] = liveHash;
        mutated = true;
      }
    }

    if (rt.meta.space.settings.syncLocalStorage) {
      const lsMutated = await this.reconcileOpenTabLocalStorage(rt, siteKey, trackId, {
        allowLocalTrackSwitch: true,
        detectDeletes: true,
      });
      if (lsMutated) mutated = true;
    }

    return mutated;
  }

  private async reconcileOpenTabLocalStorage(
    rt: LoadedSpaceRuntime,
    siteKey: string,
    trackId: string,
    options?: {
      prequeriedTabs?: Awaited<ReturnType<BrowserApiAdapter['queryTabs']>>;
      allowLocalTrackSwitch?: boolean;
      detectDeletes?: boolean;
    },
  ): Promise<boolean> {
    if (!rt.meta.space.settings.syncLocalStorage) return false;
    const track = rt.tracks[trackId];
    if (!track || track.siteKey !== siteKey) return false;

    const sitePolicy = this.getEffectivePolicyForDevice(rt, siteKey, siteKey);
    if (
      !options?.allowLocalTrackSwitch &&
      (sitePolicy.excluded ||
        !sitePolicy.syncLocalStorage ||
        sitePolicy.direction === 'disabled' ||
        sitePolicy.direction === 'pull_only')
    ) {
      return false;
    }

    let mutated = false;
    try {
      const tabs = options?.prequeriedTabs ?? (await this.browser.queryTabs());
      const origins = new Set<string>();
      for (const tab of tabs) {
        const origin = tab.url ? normalizeOriginSafe(tab.url) : null;
        if (origin && resolveSiteKey(origin, rt.meta.rules.ssoGroups) === siteKey) {
          origins.add(origin);
        }
      }

      for (const origin of origins) {
        const lsState = await this.browser.getLocalStorage(origin);
        if (!lsState.available) continue;

        // 1. Capture CREATE & UPDATE
        for (const [k, v] of Object.entries(lsState.items)) {
          const lsLogicalId = buildLocalStorageLogicalId(trackId, origin, k);
          const existingLs = rt.localStorage[lsLogicalId];
          const lastAppliedLs = rt.meta.appliedLsHashes[lsLogicalId];
          if (existingLs && !existingLs.deleted && existingLs.value === v) {
            rt.meta.appliedLsHashes[lsLogicalId] = v;
            continue;
          }
          if (
            lastAppliedLs === undefined &&
            existingLs &&
            existingLs.sourceDevice !== rt.meta.localDevice.deviceId &&
            (existingLs.syncStatus === 'REMOTE_NEWER' || existingLs.syncStatus === 'REMOTE_ONLY')
          ) {
            continue;
          }
          const emittedLs = await this.emitLocalStorageUpsert(
            rt,
            siteKey,
            trackId,
            origin,
            k,
            v,
            existingLs && !existingLs.deleted ? 'UPDATE' : 'CREATE',
          );
          if (emittedLs) {
            rt.meta.appliedLsHashes[lsLogicalId] = v;
            mutated = true;
          }
        }

        // 2. Capture DELETE for keys previously applied/created on this browser that were removed locally
        // Only run when explicitly reconciling user-initiated push or track switch (never on passive background polls)
        // and never cancel an unpushed CREATE/UPDATE already queued in pendingOutboundEvents.
        if (options?.detectDeletes) {
          const pendingUpsertIds = new Set(
            rt.pendingOutboundEvents
              .filter((ev) => ev.objectType === 'localStorage' && ev.operation !== 'DELETE')
              .map((ev) => ev.objectId),
          );
          for (const rec of Object.values(rt.localStorage)) {
            if (rec.trackId !== trackId || rec.origin !== origin || rec.deleted) continue;
            if (Object.prototype.hasOwnProperty.call(lsState.items, rec.key)) continue;
            if (rt.meta.appliedLsHashes[rec.logicalId] === undefined) continue;
            if (pendingUpsertIds.has(rec.logicalId)) continue;
            if (rec.syncStatus === 'REMOTE_ONLY' || rec.syncStatus === 'REMOTE_NEWER') continue;
            await this.emitLocalStorageDelete(rt, rec, 'explicit', 'explicit');
            mutated = true;
          }
        }
      }
    } catch {
      // Ignore tab query errors during reconciliation
    }
    return mutated;
  }

  private async reloadTabsForUserAction(
    rt: LoadedSpaceRuntime,
    predicate: (tabUrl: string) => boolean,
  ): Promise<number> {
    let reloaded = 0;
    let tabs: Awaited<ReturnType<BrowserApiAdapter['queryTabs']>> = [];
    try {
      tabs = await this.browser.queryTabs();
    } catch {
      return 0;
    }

    const BLOCKING_USER_RELOAD_REASONS = new Set([
      'dirty_form_input',
      'dirty_input',
      'unsaved_form_input',
      'unsaved_contenteditable',
      'focused_editable',
      'active_input_focus',
      'active_contenteditable_focus',
      'ime_composing',
      'file_selected',
      'pending_file_upload',
      'beforeunload_registered',
    ]);

    const checkSafety = rt.meta.space.settings.refreshProtection;
    for (const tab of tabs) {
      if (!tab.url || !predicate(tab.url)) continue;
      if (checkSafety) {
        try {
          const safety = await this.browser.checkTabSafeToReload(tab.id);
          if (!safety.safe) {
            const hasActiveEditBlocker = safety.reasons.some((r) =>
              BLOCKING_USER_RELOAD_REASONS.has(r),
            );
            if (hasActiveEditBlocker) {
              continue;
            }
          }
        } catch {
          // For explicit user-initiated account rotation / env sync actions, an unreachable
          // content script probe (e.g. tab opened before extension install) should not block reload.
        }
      }
      try {
        await this.browser.reloadTab(tab.id);
        reloaded += 1;
      } catch {
        // ignore closed tab
      }
    }
    return reloaded;
  }

  private siteTabMatcher(rt: LoadedSpaceRuntime, siteKey: string): (tabUrl: string) => boolean {
    return (tabUrl: string) => {
      try {
        const parsed = new URL(tabUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
        return (
          domainMatchesSiteKey(parsed.hostname, siteKey, rt.meta.rules.ssoGroups) ||
          resolveSiteKey(parsed.hostname, rt.meta.rules.ssoGroups) === siteKey
        );
      } catch {
        return false;
      }
    };
  }

  async switchSiteTrack(siteKey: string, targetTrackId: string): Promise<void> {
    await this.ensureInitialized();
    await this.changeDetector.flush();
    return this.enqueueOp(async () => {
      const rt = this.requireUnlockedRuntime();
      const normSiteKey =
        resolveSiteKey(siteKey, rt.meta.rules.ssoGroups) || normalizeDomain(siteKey) || siteKey;
      if (rt.rulesEngine.isBlacklisted(normSiteKey).blacklisted) {
        throw new Error(`站点 "${normSiteKey}" 处于黑名单保护中，禁止切换轨道`);
      }
      const targetTrack = rt.tracks[targetTrackId];
      if (!targetTrack || targetTrack.siteKey !== normSiteKey) {
        throw new Error(`Track "${targetTrackId}" does not exist for site "${normSiteKey}"`);
      }

      const nowMs = this.now();
      const prevBinding = rt.meta.localDevice.siteBindings[normSiteKey];

      // Flush any live edits on the previously active track before switching away
      let reconciledPrev = false;
      if (
        prevBinding?.trackId &&
        prevBinding.trackId !== targetTrackId &&
        prevBinding.state !== 'PENDING_CHOICE' &&
        prevBinding.state !== 'BLACKLISTED' &&
        prevBinding.state !== 'UNMANAGED'
      ) {
        reconciledPrev = await this.reconcileSiteTrackFromLiveJar(
          rt,
          normSiteKey,
          prevBinding.trackId,
        );
      }

      // Save SafetyUndoPoint BEFORE Clean Track Switch!
      await this.captureSafetyUndoPoint(rt, normSiteKey, `switch_track:${targetTrackId}`);

      // Remove this device from old track's member list
      if (prevBinding?.trackId && prevBinding.trackId !== targetTrackId) {
        const oldTrack = rt.tracks[prevBinding.trackId];
        if (oldTrack) {
          oldTrack.memberDeviceIds = oldTrack.memberDeviceIds.filter(
            (id) => id !== rt.meta.localDevice.deviceId,
          );
          oldTrack.updatedAt = nowMs;
        }
      }

      // Add this device to target track
      if (!targetTrack.memberDeviceIds.includes(rt.meta.localDevice.deviceId)) {
        targetTrack.memberDeviceIds.push(rt.meta.localDevice.deviceId);
      }
      targetTrack.updatedAt = nowMs;
      targetTrack.lastUsedAt = nowMs;
      targetTrack.revision = (targetTrack.revision ?? 0) + 1;

      rt.meta.localDevice.siteBindings[normSiteKey] = {
        siteKey: normSiteKey,
        state: 'USER_BOUND',
        trackId: targetTrackId,
        availableTrackIds: Object.values(rt.tracks)
          .filter((t) => t.siteKey === normSiteKey)
          .map((t) => t.trackId),
        hasLocalBaseline: true,
        decidedAt: nowMs,
        decidedBy: 'user',
      };
      delete rt.pendingDecisions[normSiteKey];

      // Discard stale debounced events for this site before switching tracks
      this.changeDetector.discardWhere((c) =>
        domainMatchesSiteKey(c.domain, normSiteKey, rt.meta.rules.ssoGroups),
      );
      // Mute unloading-page pagehide LS writes from polluting the newly switched track
      this.postTrackSwitchLeaveMuteUntil.set(normSiteKey, this.now() + 2_500);

      // Clean Track Switch: wipe old cookies/LS not in target track, then apply target track
      const applyRes = await this.applyTrackToBrowser(rt, normSiteKey, targetTrackId, {
        cleanStale: true,
        triggerRefresh: true,
        allowLocalTrackSwitch: true,
      });

      if (!rt.meta.space.settings.autoRefresh && (applyRes.changedAny || applyRes.changedLocalStorage)) {
        const reloaded = await this.reloadTabsForUserAction(
          rt,
          this.siteTabMatcher(rt, normSiteKey),
        );
        if (reloaded > 0) {
          this.postReloadPushMuteUntil.set(normSiteKey, this.now() + 12_000);
        }
      }

      const prevTrackHasPending = Boolean(
        prevBinding?.trackId &&
          rt.pendingOutboundEvents.some((e) => e.trackId === prevBinding.trackId),
      );
      if (reconciledPrev || prevTrackHasPending) {
        await this.tryPushOutboundBestEffort(rt, 'switch_track_push');
      }
      await this.uploadDeviceManifestIfOnline(rt);
      await this.runAutoEnvSyncForSourceSites(rt, [normSiteKey]);
      await this.persistRuntime(rt);
    });
  }

  async splitSiteIndependent(siteKey: string, customLabel?: string): Promise<void> {
    await this.ensureInitialized();
    await this.changeDetector.flush();
    return this.enqueueOp(async () => {
      const rt = this.requireUnlockedRuntime();
      const normSiteKey =
        resolveSiteKey(siteKey, rt.meta.rules.ssoGroups) || normalizeDomain(siteKey) || siteKey;
      if (rt.rulesEngine.isBlacklisted(normSiteKey).blacklisted) {
        throw new Error(`站点 "${normSiteKey}" 处于黑名单保护中，禁止拆分轨道`);
      }
      const nowMs = this.now();
      const prevBinding = rt.meta.localDevice.siteBindings[normSiteKey];

      if (prevBinding?.trackId) {
        const oldTrack = rt.tracks[prevBinding.trackId];
        if (oldTrack) {
          oldTrack.memberDeviceIds = oldTrack.memberDeviceIds.filter(
            (id) => id !== rt.meta.localDevice.deviceId,
          );
          oldTrack.updatedAt = nowMs;
        }
      }

      const existingSorted = this.ensureSiteTrackSortOrders(rt, normSiteKey);
      const nextSortOrder =
        existingSorted.reduce((max, t) => Math.max(max, t.sortOrder ?? 0), 0) + 1;

      const newTrackId = randomId('trk');
      const allLocalCookies = await this.browser.getAllCookies();
      const localSiteCookies = allLocalCookies.filter(
        (c) =>
          domainMatchesSiteKey(c.domain, normSiteKey, rt.meta.rules.ssoGroups) &&
          (!rt.meta.space.settings.filterAnalyticsNoiseCookies || !isAnalyticsNoiseCookie(c.name)),
      );

      const newTrack: SiteTrack = {
        trackId: newTrackId,
        siteKey: normSiteKey,
        label: sanitizeShortLabel(customLabel) || `${rt.meta.localDevice.name} 独立轨道`,
        originDeviceId: rt.meta.localDevice.deviceId,
        originDeviceName: rt.meta.localDevice.name,
        cookieCount: localSiteCookies.length,
        localStorageCount: 0,
        updatedAt: nowMs,
        sortOrder: nextSortOrder,
        lastUsedAt: nowMs,
        memberDeviceIds: [rt.meta.localDevice.deviceId],
        revision: 1,
      };
      rt.tracks[newTrackId] = newTrack;

      rt.meta.localDevice.siteBindings[normSiteKey] = {
        siteKey: normSiteKey,
        state: 'INDEPENDENT',
        trackId: newTrackId,
        availableTrackIds: Object.values(rt.tracks)
          .filter((t) => t.siteKey === normSiteKey)
          .map((t) => t.trackId),
        hasLocalBaseline: true,
        localCookieCount: localSiteCookies.length,
        decidedAt: nowMs,
        decidedBy: 'user',
      };
      delete rt.pendingDecisions[normSiteKey];

      for (const c of localSiteCookies) {
        await this.emitLocalCookieUpsert(rt, normSiteKey, newTrackId, c, 'CREATE');
      }

      await this.tryPushOutboundBestEffort(rt, 'split_independent_push');
      await this.uploadDeviceManifestIfOnline(rt);
      await this.persistRuntime(rt);
    });
  }

  async createSiteAccountTrack(
    siteKey: string,
    options: CreateSiteAccountOptions,
  ): Promise<SiteTrack> {
    await this.ensureInitialized();
    await this.changeDetector.flush();
    return this.enqueueOp(async () => {
      const rt = this.requireUnlockedRuntime();
      const normSiteKey =
        resolveSiteKey(siteKey, rt.meta.rules.ssoGroups) || normalizeDomain(siteKey);
      if (!normSiteKey) {
        throw new Error('Invalid siteKey for multi-account management');
      }
      if (rt.rulesEngine.isBlacklisted(normSiteKey).blacklisted) {
        throw new Error(`Site "${normSiteKey}" is blacklisted; remove it from blacklist first`);
      }

      const nowMs = this.now();
      const nowSec = nowMs / 1000;
      const allLocalCookies = await this.browser.getAllCookies();
      const localSiteCookies = allLocalCookies.filter(
        (c) =>
          (c.session || c.expirationDate === undefined || c.expirationDate > nowSec) &&
          domainMatchesSiteKey(c.domain, normSiteKey, rt.meta.rules.ssoGroups) &&
          (!rt.meta.space.settings.filterAnalyticsNoiseCookies || !isAnalyticsNoiseCookie(c.name)),
      );

      let existingSorted = this.ensureSiteTrackSortOrders(rt, normSiteKey);
      const prevBinding = rt.meta.localDevice.siteBindings[normSiteKey];

      if (options.mode === 'clean_new') {
        // 1. Preserve current active account before clearing browser jar!
        if (
          prevBinding?.trackId &&
          rt.tracks[prevBinding.trackId] &&
          prevBinding.state !== 'PENDING_CHOICE' &&
          prevBinding.state !== 'BLACKLISTED' &&
          prevBinding.state !== 'UNMANAGED'
        ) {
          await this.reconcileSiteTrackFromLiveJar(rt, normSiteKey, prevBinding.trackId);
          const oldTrack = rt.tracks[prevBinding.trackId];
          if (oldTrack) {
            oldTrack.memberDeviceIds = oldTrack.memberDeviceIds.filter(
              (id) => id !== rt.meta.localDevice.deviceId,
            );
            oldTrack.updatedAt = nowMs;
          }
        } else {
          // Site was either untracked, UNMANAGED, or PENDING_CHOICE on this device:
          // check live browser cookies + open-tab localStorage so existing login is NEVER silently wiped!
          let liveLsCount = 0;
          if (rt.meta.space.settings.syncLocalStorage) {
            try {
              const tabs = await this.browser.queryTabs();
              const origins = new Set<string>();
              for (const tab of tabs) {
                const origin = tab.url ? normalizeOriginSafe(tab.url) : null;
                if (origin && resolveSiteKey(origin, rt.meta.rules.ssoGroups) === normSiteKey) {
                  origins.add(origin);
                }
              }
              for (const origin of origins) {
                const lsState = await this.browser.getLocalStorage(origin);
                if (lsState.available) {
                  liveLsCount += Object.keys(lsState.items).length;
                }
              }
            } catch {
              // ignore tab query errors
            }
          }

          if (localSiteCookies.length > 0 || liveLsCount > 0) {
            const initialOrder =
              existingSorted.reduce((max, t) => Math.max(max, t.sortOrder ?? 0), 0) + 1;
            const initialTrackId = randomId('trk');
            if (rt.meta.removedTracks) delete rt.meta.removedTracks[initialTrackId];
            const initialTrack: SiteTrack = {
              trackId: initialTrackId,
              siteKey: normSiteKey,
              label: existingSorted.length === 0 ? '默认账号' : `${rt.meta.localDevice.name} 原账号`,
              originDeviceId: rt.meta.localDevice.deviceId,
              originDeviceName: rt.meta.localDevice.name,
              cookieCount: localSiteCookies.length,
              localStorageCount: liveLsCount,
              updatedAt: nowMs,
              sortOrder: initialOrder,
              lastUsedAt: nowMs,
              memberDeviceIds: [],
              revision: 1,
            };
            rt.tracks[initialTrackId] = initialTrack;
            for (const c of localSiteCookies) {
              await this.emitLocalCookieUpsert(rt, normSiteKey, initialTrackId, c, 'CREATE');
            }
            await this.reconcileSiteTrackFromLiveJar(rt, normSiteKey, initialTrackId);
            existingSorted = this.ensureSiteTrackSortOrders(rt, normSiteKey);
          }
        }

        await this.captureSafetyUndoPoint(rt, normSiteKey, `create_clean_account:${normSiteKey}`);

        const nextOrder =
          existingSorted.reduce((max, t) => Math.max(max, t.sortOrder ?? 0), 0) + 1;
        const newTrackId = randomId('trk');
        if (rt.meta.removedTracks) delete rt.meta.removedTracks[newTrackId];

        const newTrack: SiteTrack = {
          trackId: newTrackId,
          siteKey: normSiteKey,
          label: sanitizeShortLabel(options.label) || `账号 ${existingSorted.length + 1}`,
          accountNote: sanitizeShortLabel(options.accountNote, 160) || undefined,
          originDeviceId: rt.meta.localDevice.deviceId,
          originDeviceName: rt.meta.localDevice.name,
          cookieCount: 0,
          localStorageCount: 0,
          updatedAt: nowMs,
          sortOrder: nextOrder,
          lastUsedAt: nowMs,
          memberDeviceIds: [rt.meta.localDevice.deviceId],
          revision: 1,
        };
        rt.tracks[newTrackId] = newTrack;

        rt.meta.localDevice.siteBindings[normSiteKey] = {
          siteKey: normSiteKey,
          state: 'USER_BOUND',
          trackId: newTrackId,
          availableTrackIds: Object.values(rt.tracks)
            .filter((t) => t.siteKey === normSiteKey)
            .map((t) => t.trackId),
          hasLocalBaseline: true,
          localCookieCount: 0,
          decidedAt: nowMs,
          decidedBy: 'user',
        };
        delete rt.pendingDecisions[normSiteKey];

        this.changeDetector.discardWhere((c) =>
          domainMatchesSiteKey(c.domain, normSiteKey, rt.meta.rules.ssoGroups),
        );
        // Shield brand-new blank account from pagehide LS writes fired when reloading away from old account
        this.postTrackSwitchLeaveMuteUntil.set(normSiteKey, this.now() + 2_500);

        // Wipe browser cookies AND open-tab localStorage cleanly using EchoSuppressor
        // (does NOT emit logout tombstones on previous account!)
        await this.applyTrackToBrowser(rt, normSiteKey, newTrackId, {
          cleanStale: true,
          triggerRefresh: false,
          allowLocalTrackSwitch: true,
        });

        if (options.triggerRefresh !== false) {
          const reloaded = await this.reloadTabsForUserAction(
            rt,
            this.siteTabMatcher(rt, normSiteKey),
          );
          if (reloaded > 0) {
            this.postReloadPushMuteUntil.set(normSiteKey, this.now() + 12_000);
          }
        }

        if (rt.pendingOutboundEvents.length > 0) {
          await this.tryPushOutboundBestEffort(rt, 'create_account_push');
        }
        await this.uploadDeviceManifestIfOnline(rt);
        await this.runAutoEnvSyncForSourceSites(rt, [normSiteKey]);
        await this.persistRuntime(rt);
        return { ...newTrack };
      }

      // mode === 'save_current': Snapshot current browser cookies & open-tab LS into a new named account track
      if (
        prevBinding?.trackId &&
        rt.tracks[prevBinding.trackId] &&
        prevBinding.state !== 'PENDING_CHOICE' &&
        prevBinding.state !== 'BLACKLISTED' &&
        prevBinding.state !== 'UNMANAGED'
      ) {
        // Flush live open-tab localStorage onto prevBinding.trackId alongside already-flushed cookies
        // so prevBinding.trackId never suffers Cookie/LS split-brain when save_current runs right after login!
        await this.reconcileSiteTrackFromLiveJar(rt, normSiteKey, prevBinding.trackId);
        const oldTrack = rt.tracks[prevBinding.trackId];
        oldTrack.memberDeviceIds = oldTrack.memberDeviceIds.filter(
          (id) => id !== rt.meta.localDevice.deviceId,
        );
        oldTrack.updatedAt = nowMs;
      }

      const nextOrder =
        existingSorted.reduce((max, t) => Math.max(max, t.sortOrder ?? 0), 0) + 1;
      const newTrackId = randomId('trk');
      if (rt.meta.removedTracks) delete rt.meta.removedTracks[newTrackId];

      const newTrack: SiteTrack = {
        trackId: newTrackId,
        siteKey: normSiteKey,
        label: sanitizeShortLabel(options.label) || `账号 ${existingSorted.length + 1}`,
        accountNote: sanitizeShortLabel(options.accountNote, 160) || undefined,
        originDeviceId: rt.meta.localDevice.deviceId,
        originDeviceName: rt.meta.localDevice.name,
        cookieCount: localSiteCookies.length,
        localStorageCount: 0,
        updatedAt: nowMs,
        sortOrder: nextOrder,
        lastUsedAt: nowMs,
        memberDeviceIds: [rt.meta.localDevice.deviceId],
        revision: 1,
      };
      rt.tracks[newTrackId] = newTrack;

      rt.meta.localDevice.siteBindings[normSiteKey] = {
        siteKey: normSiteKey,
        state: 'USER_BOUND',
        trackId: newTrackId,
        availableTrackIds: Object.values(rt.tracks)
          .filter((t) => t.siteKey === normSiteKey)
          .map((t) => t.trackId),
        hasLocalBaseline: true,
        localCookieCount: localSiteCookies.length,
        decidedAt: nowMs,
        decidedBy: 'user',
      };
      delete rt.pendingDecisions[normSiteKey];

      for (const c of localSiteCookies) {
        await this.emitLocalCookieUpsert(rt, normSiteKey, newTrackId, c, 'CREATE');
      }

      await this.reconcileSiteTrackFromLiveJar(rt, normSiteKey, newTrackId);

      await this.tryPushOutboundBestEffort(rt, 'save_current_account_push');
      await this.uploadDeviceManifestIfOnline(rt);
      await this.runAutoEnvSyncForSourceSites(rt, [normSiteKey]);
      await this.persistRuntime(rt);
      return { ...rt.tracks[newTrackId] };
    });
  }

  async rotateSiteTrack(
    siteKey: string,
    direction: 'next' | 'prev' = 'next',
  ): Promise<AccountRotationResult> {
    await this.ensureInitialized();
    await this.changeDetector.flush();
    return this.enqueueOp(async () => {
      const rt = this.requireUnlockedRuntime();
      const normSiteKey =
        resolveSiteKey(siteKey, rt.meta.rules.ssoGroups) || normalizeDomain(siteKey) || siteKey;
      if (rt.rulesEngine.isBlacklisted(normSiteKey).blacklisted) {
        throw new Error(`站点 "${normSiteKey}" 处于黑名单保护中，禁止轮换账号`);
      }

      const sorted = this.ensureSiteTrackSortOrders(rt, normSiteKey);
      if (sorted.length === 0) {
        throw new Error(`站点 "${normSiteKey}" 暂无已保存的账号轨道`);
      }

      const nowMs = this.now();
      const prevBinding = rt.meta.localDevice.siteBindings[normSiteKey];
      const prevTrackId = prevBinding?.trackId;
      const currentIdx = prevTrackId ? sorted.findIndex((t) => t.trackId === prevTrackId) : -1;

      const nextIdx =
        sorted.length === 1
          ? 0
          : currentIdx < 0
            ? direction === 'prev'
              ? sorted.length - 1
              : 0
            : direction === 'prev'
              ? (currentIdx - 1 + sorted.length) % sorted.length
              : (currentIdx + 1) % sorted.length;

      const targetTrack = sorted[nextIdx];

      // No-op fast path: only 1 track exists and we are already actively bound to it
      if (
        sorted.length === 1 &&
        prevTrackId === targetTrack.trackId &&
        prevBinding?.state !== 'PENDING_CHOICE' &&
        prevBinding?.state !== 'UNMANAGED'
      ) {
        return {
          siteKey: normSiteKey,
          track: { ...targetTrack },
          previousTrackId: prevTrackId,
          index: 1,
          total: 1,
          appliedCookies: 0,
          failedCookies: 0,
        };
      }

      let reconciledPrev = false;
      if (
        prevTrackId &&
        prevTrackId !== targetTrack.trackId &&
        prevBinding &&
        prevBinding.state !== 'PENDING_CHOICE' &&
        prevBinding.state !== 'BLACKLISTED' &&
        prevBinding.state !== 'UNMANAGED'
      ) {
        reconciledPrev = await this.reconcileSiteTrackFromLiveJar(rt, normSiteKey, prevTrackId);
      }

      if (prevTrackId !== targetTrack.trackId) {
        await this.captureSafetyUndoPoint(
          rt,
          normSiteKey,
          `rotate_track:${targetTrack.trackId}`,
        );
      }

      if (prevTrackId && prevTrackId !== targetTrack.trackId) {
        const oldTrack = rt.tracks[prevTrackId];
        if (oldTrack) {
          oldTrack.memberDeviceIds = oldTrack.memberDeviceIds.filter(
            (id) => id !== rt.meta.localDevice.deviceId,
          );
          oldTrack.updatedAt = nowMs;
        }
      }

      if (!targetTrack.memberDeviceIds.includes(rt.meta.localDevice.deviceId)) {
        targetTrack.memberDeviceIds.push(rt.meta.localDevice.deviceId);
      }
      targetTrack.updatedAt = nowMs;
      targetTrack.lastUsedAt = nowMs;
      targetTrack.revision = (targetTrack.revision ?? 0) + 1;

      rt.meta.localDevice.siteBindings[normSiteKey] = {
        siteKey: normSiteKey,
        state: 'USER_BOUND',
        trackId: targetTrack.trackId,
        availableTrackIds: sorted.map((t) => t.trackId),
        hasLocalBaseline: true,
        decidedAt: nowMs,
        decidedBy: 'user',
      };
      delete rt.pendingDecisions[normSiteKey];

      this.changeDetector.discardWhere((c) =>
        domainMatchesSiteKey(c.domain, normSiteKey, rt.meta.rules.ssoGroups),
      );
      this.postTrackSwitchLeaveMuteUntil.set(normSiteKey, this.now() + 2_500);

      const applyRes = await this.applyTrackToBrowser(rt, normSiteKey, targetTrack.trackId, {
        cleanStale: true,
        triggerRefresh: false,
        allowLocalTrackSwitch: true,
      });

      const reloaded = await this.reloadTabsForUserAction(
        rt,
        this.siteTabMatcher(rt, normSiteKey),
      );
      if (reloaded > 0) {
        this.postReloadPushMuteUntil.set(normSiteKey, this.now() + 12_000);
      }

      const prevTrackHasPending = Boolean(
        prevTrackId && rt.pendingOutboundEvents.some((e) => e.trackId === prevTrackId),
      );
      if (reconciledPrev || prevTrackHasPending) {
        await this.tryPushOutboundBestEffort(rt, 'rotate_track_push');
      }
      await this.uploadDeviceManifestIfOnline(rt);
      await this.runAutoEnvSyncForSourceSites(rt, [normSiteKey]);
      await this.persistRuntime(rt);

      return {
        siteKey: normSiteKey,
        track: { ...targetTrack },
        previousTrackId: prevTrackId,
        index: nextIdx + 1,
        total: sorted.length,
        appliedCookies: applyRes.appliedCookies,
        failedCookies: applyRes.failedCookies,
      };
    });
  }

  async deleteSiteTrack(
    siteKey: string,
    trackId: string,
  ): Promise<{ deletedTrackId: string; switchedToTrack?: SiteTrack }> {
    await this.ensureInitialized();
    await this.changeDetector.flush();
    return this.enqueueOp(async () => {
      const rt = this.requireUnlockedRuntime();
      const normSiteKey =
        resolveSiteKey(siteKey, rt.meta.rules.ssoGroups) || normalizeDomain(siteKey) || siteKey;
      const track = rt.tracks[trackId];
      if (!track || track.siteKey !== normSiteKey) {
        throw new Error(`Track "${trackId}" not found for site "${normSiteKey}"`);
      }

      const nowMs = this.now();

      // Emit tombstones for live records belonging to this deleted account track
      for (const rec of Object.values(rt.cookies)) {
        if (rec.trackId === trackId && !rec.deleted) {
          await this.emitLocalCookieDelete(rt, rec, 'user_delete', 'all_devices');
        }
      }
      for (const rec of Object.values(rt.localStorage)) {
        if (rec.trackId === trackId && !rec.deleted) {
          await this.emitLocalStorageDelete(rt, rec, 'user_delete', 'all_devices');
        }
      }

      rt.meta.removedTracks = rt.meta.removedTracks ?? {};
      rt.meta.removedTracks[trackId] = Math.max(nowMs, track.updatedAt + 1);
      delete rt.tracks[trackId];

      // Clear dangling sourceTrackId references on envSyncRules
      for (const rule of rt.meta.rules.envSyncRules ?? []) {
        if (rule.sourceTrackId === trackId) {
          rule.sourceTrackId = undefined;
          rule.updatedAt = nowMs;
        }
      }
      for (const rule of rt.meta.deviceEnvSyncRules ?? []) {
        if (rule.sourceTrackId === trackId) {
          rule.sourceTrackId = undefined;
          rule.updatedAt = nowMs;
        }
      }

      const remaining = this.ensureSiteTrackSortOrders(rt, normSiteKey);
      let switchedToTrack: SiteTrack | undefined;

      const curBinding = rt.meta.localDevice.siteBindings[normSiteKey];
      if (curBinding?.trackId === trackId) {
        await this.captureSafetyUndoPoint(rt, normSiteKey, `delete_track:${trackId}`);
        if (remaining.length > 0) {
          const nextTrack = remaining[0];
          if (!nextTrack.memberDeviceIds.includes(rt.meta.localDevice.deviceId)) {
            nextTrack.memberDeviceIds.push(rt.meta.localDevice.deviceId);
          }
          nextTrack.updatedAt = nowMs;
          nextTrack.lastUsedAt = nowMs;
          nextTrack.revision = (nextTrack.revision ?? 0) + 1;

          rt.meta.localDevice.siteBindings[normSiteKey] = {
            siteKey: normSiteKey,
            state: 'USER_BOUND',
            trackId: nextTrack.trackId,
            availableTrackIds: remaining.map((t) => t.trackId),
            hasLocalBaseline: true,
            decidedAt: nowMs,
            decidedBy: 'user',
          };

          this.changeDetector.discardWhere((c) =>
            domainMatchesSiteKey(c.domain, normSiteKey, rt.meta.rules.ssoGroups),
          );
          this.postTrackSwitchLeaveMuteUntil.set(normSiteKey, this.now() + 2_500);
          await this.applyTrackToBrowser(rt, normSiteKey, nextTrack.trackId, {
            cleanStale: true,
            triggerRefresh: false,
            allowLocalTrackSwitch: true,
          });
          const reloaded = await this.reloadTabsForUserAction(
            rt,
            this.siteTabMatcher(rt, normSiteKey),
          );
          if (reloaded > 0) {
            this.postReloadPushMuteUntil.set(normSiteKey, this.now() + 12_000);
          }
          switchedToTrack = { ...nextTrack };
        } else {
          rt.meta.localDevice.siteBindings[normSiteKey] = {
            siteKey: normSiteKey,
            state: 'UNMANAGED',
            trackId: undefined,
            hasLocalBaseline: false,
            decidedAt: nowMs,
            decidedBy: 'user',
          };
        }
      } else if (curBinding) {
        curBinding.availableTrackIds = remaining.map((t) => t.trackId);
      }

      await this.tryPushOutboundBestEffort(rt, 'delete_track_push');
      await this.uploadDeviceManifestIfOnline(rt);
      if (switchedToTrack) {
        await this.runAutoEnvSyncForSourceSites(rt, [normSiteKey]);
      }
      await this.persistRuntime(rt);
      return { deletedTrackId: trackId, switchedToTrack };
    });
  }

  async renameSiteTrack(siteKey: string, trackId: string, label: string): Promise<void> {
    await this.updateSiteTrack(siteKey, trackId, { label });
  }

  async updateSiteTrack(
    siteKey: string,
    trackId: string,
    patch: UpdateSiteTrackPatch,
  ): Promise<SiteTrack> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireUnlockedRuntime();
      const normSiteKey =
        resolveSiteKey(siteKey, rt.meta.rules.ssoGroups) || normalizeDomain(siteKey) || siteKey;
      const track = rt.tracks[trackId];
      if (!track || track.siteKey !== normSiteKey) {
        throw new Error(`Track "${trackId}" not found for site "${normSiteKey}"`);
      }

      if (patch.label !== undefined) {
        const trimmed = sanitizeShortLabel(patch.label);
        if (!trimmed) throw new Error('Track label cannot be empty');
        track.label = trimmed;
      }

      if (patch.accountNote !== undefined) {
        const cleanedNote = sanitizeShortLabel(patch.accountNote, 160);
        track.accountNote = cleanedNote || undefined;
      }

      if (patch.sortOrder !== undefined && Number.isFinite(patch.sortOrder)) {
        track.sortOrder = Math.max(1, Math.floor(patch.sortOrder));
      }

      track.updatedAt = this.now();
      track.revision = (track.revision ?? 0) + 1;

      await this.uploadDeviceManifestIfOnline(rt);
      await this.persistRuntime(rt);
      return { ...track };
    });
  }

  async reorderSiteTracks(siteKey: string, orderedTrackIds: string[]): Promise<SiteTrack[]> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireUnlockedRuntime();
      const normSiteKey =
        resolveSiteKey(siteKey, rt.meta.rules.ssoGroups) || normalizeDomain(siteKey) || siteKey;
      const existingSorted = this.ensureSiteTrackSortOrders(rt, normSiteKey);
      if (existingSorted.length === 0) {
        throw new Error(`站点 "${normSiteKey}" 暂无可排序的账号轨道`);
      }

      const byId = new Map(existingSorted.map((t) => [t.trackId, t]));
      const finalOrder: SiteTrack[] = [];
      const seen = new Set<string>();

      for (const id of orderedTrackIds) {
        const found = byId.get(id);
        if (found && !seen.has(id)) {
          seen.add(id);
          finalOrder.push(found);
        }
      }
      for (const tr of existingSorted) {
        if (!seen.has(tr.trackId)) {
          seen.add(tr.trackId);
          finalOrder.push(tr);
        }
      }

      const nowMs = this.now();
      finalOrder.forEach((tr, idx) => {
        const nextOrder = idx + 1;
        if (tr.sortOrder !== nextOrder) {
          tr.sortOrder = nextOrder;
          tr.updatedAt = nowMs;
          tr.revision = (tr.revision ?? 0) + 1;
        }
      });

      const curBinding = rt.meta.localDevice.siteBindings[normSiteKey];
      if (curBinding) {
        curBinding.availableTrackIds = finalOrder.map((t) => t.trackId);
      }

      await this.uploadDeviceManifestIfOnline(rt);
      await this.persistRuntime(rt);
      return finalOrder.map((t) => ({ ...t }));
    });
  }

  // =========================================================================
  // Queries & Data Management
  // =========================================================================

  async getStatusSummary(_activeUrl?: string): Promise<SyncStatusSummary> {
    await this.ensureInitialized();
    const spaces = Object.values(this.spaceIndex).map((s) => ({
      spaceId: s.spaceId,
      name: s.name,
      status: s.status,
    }));

    const rt = this.runtime;
    if (!rt) {
      return {
        configured: false,
        locked: false,
        spaces,
        status: 'UNCONFIGURED',
        webdavConnected: false,
        pendingUploads: 0,
        pendingApplies: 0,
        pendingDecisionsCount: 0,
        unresolvedConflictsCount: 0,
        undoPointsCount: 0,
        latestError: null,
        attentionItems: [],
      };
    }

    const locked = !rt.dekKeyring[rt.meta.space.keyEpoch];
    const status = this.computeStatus(rt);
    const pullBoundTrackIds = this.getActiveBoundTrackIds(rt, { requirePullAllowed: true });
    const pendingApplies =
      Object.values(rt.cookies).filter(
        (c) =>
          !c.deleted &&
          pullBoundTrackIds.has(c.trackId) &&
          (c.syncStatus === 'REMOTE_NEWER' || c.syncStatus === 'REMOTE_ONLY'),
      ).length +
      Object.values(rt.localStorage).filter(
        (l) =>
          !l.deleted &&
          pullBoundTrackIds.has(l.trackId) &&
          (l.syncStatus === 'REMOTE_NEWER' || l.contextAvailable === false),
      ).length;
    const attentionItems =
      locked && status !== 'DECRYPT_ERROR' ? [] : this.buildAttentionItems(rt, status);

    return {
      configured: true,
      locked,
      activeSpaceId: rt.spaceId,
      activeSpaceName: rt.meta.space.name,
      spaces,
      device: { ...rt.meta.localDevice },
      status,
      webdavConnected: this.isOnline() && status !== 'AUTH_ERROR' && status !== 'OFFLINE',
      webdavUrl: rt.webdav.url,
      consistencyLevel: this.spaceIndex[rt.spaceId]?.consistencyLevel,
      lastSyncAt: rt.meta.lastSyncAt,
      lastLatencyMs: rt.meta.lastLatencyMs,
      pendingUploads: rt.pendingOutboundEvents.length,
      pendingApplies,
      pendingDecisionsCount: Object.keys(rt.pendingDecisions).length,
      unresolvedConflictsCount: Object.values(rt.conflicts).filter((c) => !c.resolved).length,
      undoPointsCount: rt.undoPoints.length,
      latestError: rt.meta.latestError ?? null,
      attentionItems,
    };
  }

  async getWebDAVConfig(): Promise<WebDAVConfig | null> {
    await this.ensureInitialized();
    if (!this.runtime) return null;
    return { ...this.runtime.webdav };
  }

  async getSpaceSettings(): Promise<SpaceSettings> {
    await this.ensureInitialized();
    if (!this.runtime) {
      return {
        ...DEFAULT_SPACE_SETTINGS,
        syncTimingMode: this.defaultSyncTimingMode,
      };
    }
    return {
      ...this.runtime.meta.space.settings,
      syncTimingMode: this.getEffectiveSyncTimingMode(this.runtime),
    };
  }

  async getSitesOverview(): Promise<SiteSummaryView[]> {
    await this.ensureInitialized();
    const rt = this.runtime;
    if (!rt) return [];

    const nowMs = this.now();
    const isManagedOnly = rt.meta.space.settings.syncScopeMode === 'managed_only';
    const siteKeys = new Set<string>();
    for (const sk of Object.keys(rt.meta.localDevice.siteBindings)) siteKeys.add(sk);
    for (const tr of Object.values(rt.tracks)) siteKeys.add(tr.siteKey);
    for (const pd of Object.keys(rt.pendingDecisions)) siteKeys.add(pd);

    const summaries: SiteSummaryView[] = [];
    for (const siteKey of Array.from(siteKeys).sort()) {
      const existingBinding = rt.meta.localDevice.siteBindings[siteKey];
      if (existingBinding?.state === 'UNMANAGED') {
        continue;
      }
      if (
        isManagedOnly &&
        !this.isSiteManagedOrRemotelyTracked(rt, siteKey) &&
        !rt.pendingDecisions[siteKey]
      ) {
        continue;
      }

      const binding: DeviceSiteBinding = existingBinding ?? {
        siteKey,
        state: rt.rulesEngine.isBlacklisted(siteKey).blacklisted ? 'BLACKLISTED' : 'PENDING_CHOICE',
        hasLocalBaseline: false,
        decidedBy: 'auto',
      };
      const allTracks = sortSiteTracks(
        Object.values(rt.tracks).filter((t) => t.siteKey === siteKey),
      );
      const activeTrack = binding.trackId ? rt.tracks[binding.trackId] : undefined;

      const activeCookies = activeTrack
        ? Object.values(rt.cookies).filter((c) => c.trackId === activeTrack.trackId && !c.deleted)
        : Object.values(rt.cookies).filter((c) => c.siteKey === siteKey && !c.deleted);
      const activeLs = activeTrack
        ? Object.values(rt.localStorage).filter(
            (l) => l.trackId === activeTrack.trackId && !l.deleted,
          )
        : Object.values(rt.localStorage).filter((l) => l.siteKey === siteKey && !l.deleted);

      let latestRec: (CookieRecord | LocalStorageRecord) | undefined;
      for (const r of [...activeCookies, ...activeLs]) {
        if (!latestRec || r.updatedAt > latestRec.updatedAt) {
          latestRec = r;
        }
      }

      let syncStatus: SiteSummaryView['syncStatus'] = 'IN_SYNC';
      if (binding.state === 'BLACKLISTED') syncStatus = 'EXCLUDED';
      else if (binding.state === 'PENDING_CHOICE') syncStatus = 'PENDING_CHOICE';
      else if (activeCookies.some((c) => c.syncStatus === 'APPLY_FAILED')) syncStatus = 'APPLY_FAILED';
      else if (activeCookies.some((c) => c.syncStatus === 'LOCAL_NEWER')) syncStatus = 'LOCAL_NEWER';
      else if (activeCookies.some((c) => c.syncStatus === 'REMOTE_NEWER')) syncStatus = 'REMOTE_NEWER';

      summaries.push({
        siteKey,
        binding,
        activeTrack,
        allTracks,
        cookieCount: activeCookies.length,
        localStorageCount: activeLs.length,
        latestVersionId: latestRec?.version.versionId,
        sourceDeviceName: latestRec?.sourceDeviceName,
        updatedAt: latestRec?.updatedAt ?? activeTrack?.updatedAt,
        syncStatus,
        rollingTokenDamped: this.rollingTokenDamper.isSiteDamped(siteKey, nowMs),
      });
    }

    return summaries;
  }

  // =========================================================================
  // Opt-In Managed Sites, Authority Mode & Per-Device Sync Policies
  // =========================================================================

  async scanBrowserCandidateSites(): Promise<BrowserCandidateSite[]> {
    await this.ensureInitialized();
    const rt = this.runtime;
    const ssoGroups = rt?.meta.rules.ssoGroups ?? [];
    const filterNoise = rt
      ? rt.meta.space.settings.filterAnalyticsNoiseCookies
      : DEFAULT_SPACE_SETTINGS.filterAnalyticsNoiseCookies;

    const allCookies = await this.browser.getAllCookies();
    const grouped = new Map<string, { cookieCount: number; domains: Set<string> }>();

    for (const c of allCookies) {
      if (filterNoise && isAnalyticsNoiseCookie(c.name)) continue;
      const siteKey = resolveSiteKey(c.domain, ssoGroups);
      if (!siteKey) continue;

      let bucket = grouped.get(siteKey);
      if (!bucket) {
        bucket = { cookieCount: 0, domains: new Set<string>() };
        grouped.set(siteKey, bucket);
      }
      bucket.cookieCount += 1;
      const cleanDomain = normalizeDomain(c.domain);
      if (cleanDomain) bucket.domains.add(cleanDomain);
    }

    const candidates: BrowserCandidateSite[] = [];
    for (const [siteKey, bucket] of grouped.entries()) {
      if (bucket.cookieCount <= 0) continue;

      const binding = rt?.meta.localDevice.siteBindings[siteKey];
      const blacklisted = Boolean(
        rt &&
          (binding?.state === 'BLACKLISTED' || rt.rulesEngine.isBlacklisted(siteKey).blacklisted),
      );
      const alreadyManaged = Boolean(
        rt &&
          !blacklisted &&
          binding &&
          binding.state !== 'UNMANAGED' &&
          binding.state !== 'BLACKLISTED' &&
          (Boolean(binding.trackId) ||
            binding.state === 'PENDING_CHOICE' ||
            Object.values(rt.tracks).some((t) => t.siteKey === siteKey)),
      );

      candidates.push({
        siteKey,
        cookieCount: bucket.cookieCount,
        domains: Array.from(bucket.domains).sort(),
        alreadyManaged,
        blacklisted,
      });
    }

    candidates.sort(
      (a, b) => b.cookieCount - a.cookieCount || a.siteKey.localeCompare(b.siteKey),
    );
    return candidates;
  }

  async addManagedSites(
    siteKeys: string[],
  ): Promise<{ added: string[]; pendingDecisions: PendingSiteDecision[] }> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      if (
        this.isOnline() &&
        rt.meta.localDevice.state === 'active' &&
        !rt.meta.globalPaused &&
        Boolean(rt.dekKeyring[rt.meta.space.keyEpoch])
      ) {
        try {
          // Pull latest remote tracks/rules/items before local track creation to avoid duplicate tracks on concurrent managed-site adds.
          await this.pullRemoteInternal(rt, { applyToBrowser: false });
        } catch {
          // Best-effort pre-pull: fall back to cached remote state when WebDAV is temporarily unreachable.
        }
        if (rt.meta.localDevice.state !== 'active') {
          rt.meta.space.status = this.computeStatus(rt);
          await this.persistRuntime(rt);
          return { added: [], pendingDecisions: [] };
        }
      }
      const nowMs = this.now();
      const allLocalCookies = await this.browser.getAllCookies();

      const originsBySite = new Map<string, Set<string>>();
      try {
        const tabs = await this.browser.queryTabs();
        for (const tab of tabs) {
          if (!tab.url) continue;
          const origin = normalizeOriginSafe(tab.url);
          if (!origin) continue;
          const sk = resolveSiteKey(origin, rt.meta.rules.ssoGroups);
          if (!sk) continue;
          let set = originsBySite.get(sk);
          if (!set) {
            set = new Set<string>();
            originsBySite.set(sk, set);
          }
          set.add(origin);
        }
      } catch {
        // Ignore tab query errors
      }
      for (const lsRec of Object.values(rt.localStorage)) {
        if (lsRec.deleted) continue;
        let set = originsBySite.get(lsRec.siteKey);
        if (!set) {
          set = new Set<string>();
          originsBySite.set(lsRec.siteKey, set);
        }
        set.add(lsRec.origin);
      }

      const normalizedKeys = Array.from(
        new Set(
          siteKeys
            .map((raw) => {
              const trimmed = raw.trim();
              if (!trimmed) return '';
              return resolveSiteKey(trimmed, rt.meta.rules.ssoGroups) || normalizeDomain(trimmed);
            })
            .filter(Boolean),
        ),
      );

      const added: string[] = [];
      const pendingDecisions: PendingSiteDecision[] = [];

      for (const siteKey of normalizedKeys) {
        if (rt.rulesEngine.isBlacklisted(siteKey).blacklisted) {
          continue;
        }
        const policy = this.getEffectivePolicyForDevice(rt, siteKey, siteKey);
        if (policy.excluded || policy.direction === 'disabled') {
          continue;
        }

        if (rt.meta.localDevice.siteBindings[siteKey]?.state === 'UNMANAGED') {
          delete rt.meta.localDevice.siteBindings[siteKey];
        }

        const localSiteCookies = allLocalCookies.filter((c) =>
          domainMatchesSiteKey(c.domain, siteKey, rt.meta.rules.ssoGroups),
        );
        const meaningfulCookies = rt.meta.space.settings.filterAnalyticsNoiseCookies
          ? localSiteCookies.filter((c) => !isAnalyticsNoiseCookie(c.name))
          : localSiteCookies;

        const localLsByOrigin: Array<{ origin: string; items: Record<string, string> }> = [];
        let localLsCount = 0;
        const candidateOrigins = originsBySite.get(siteKey);
        if (candidateOrigins && policy.syncLocalStorage) {
          for (const origin of candidateOrigins) {
            try {
              const ls = await this.browser.getLocalStorage(origin);
              if (ls.available) {
                const count = Object.keys(ls.items).length;
                if (count > 0) {
                  localLsByOrigin.push({ origin, items: ls.items });
                  localLsCount += count;
                }
              }
            } catch {
              // Ignore unavailable origin context
            }
          }
        }

        const remoteTracks = Object.values(rt.tracks).filter((t) => t.siteKey === siteKey);
        const existingBinding = rt.meta.localDevice.siteBindings[siteKey];

        const decision = evaluateSiteDiscovery({
          siteKey,
          isBlacklisted: false,
          existingBinding,
          localCookies: localSiteCookies,
          localStorageCount: localLsCount,
          remoteTracks,
          deviceId: rt.meta.localDevice.deviceId,
          deviceName: rt.meta.localDevice.name,
          filterNoise: rt.meta.space.settings.filterAnalyticsNoiseCookies,
          nowMs,
        });

        if (decision.action === 'await_user_choice' && decision.pendingDecision) {
          const autoAction = resolveAutomaticSiteDecisionAction({
            localDeviceId: rt.meta.localDevice.deviceId,
            settings: rt.meta.space.settings,
            remoteTracks,
            hasLocalData: decision.pendingDecision.hasLocalData,
          });
          if (autoAction) {
            await this.resolveSiteDecisionInternal(siteKey, autoAction, {
              deferSyncAndPersist: true,
              triggerRefresh: true,
              decidedBy: 'auto',
            });
            added.push(siteKey);
            continue;
          }
          rt.meta.localDevice.siteBindings[siteKey] = decision.binding;
          rt.pendingDecisions[siteKey] = decision.pendingDecision;
          pendingDecisions.push(decision.pendingDecision);
          continue;
        }

        if (decision.action === 'create_initial_track' && decision.createdTrack) {
          const trackId = decision.createdTrack.trackId;
          const trackUpdatedAt = Math.max(nowMs, (rt.meta.removedTracks?.[trackId] ?? 0) + 1);
          if (rt.meta.removedTracks) delete rt.meta.removedTracks[trackId];
          decision.createdTrack.updatedAt = trackUpdatedAt;

          rt.tracks[trackId] = decision.createdTrack;
          rt.meta.localDevice.siteBindings[siteKey] = {
            ...decision.binding,
            state: 'USER_BOUND',
            decidedAt: nowMs,
            decidedBy: 'user',
          };
          delete rt.pendingDecisions[siteKey];

          if (policy.direction !== 'pull_only') {
            if (policy.syncCookies) {
              for (const c of meaningfulCookies) {
                if (rt.rulesEngine.isBlacklisted(c.domain).blacklisted) continue;
                await this.emitLocalCookieUpsert(rt, siteKey, trackId, c, 'CREATE');
              }
            }
            if (policy.syncLocalStorage) {
              for (const { origin, items } of localLsByOrigin) {
                for (const [key, value] of Object.entries(items)) {
                  await this.emitLocalStorageUpsert(
                    rt,
                    siteKey,
                    trackId,
                    origin,
                    key,
                    value,
                    'CREATE',
                  );
                }
              }
            }
          }
          added.push(siteKey);
          continue;
        }

        if (decision.action === 'auto_pull_remote' && decision.binding.trackId) {
          const trackId = decision.binding.trackId;
          rt.meta.localDevice.siteBindings[siteKey] = {
            ...decision.binding,
            state: 'USER_BOUND',
            decidedAt: nowMs,
            decidedBy: 'user',
          };
          delete rt.pendingDecisions[siteKey];
          const tr = rt.tracks[trackId];
          if (tr && !tr.memberDeviceIds.includes(rt.meta.localDevice.deviceId)) {
            tr.memberDeviceIds.push(rt.meta.localDevice.deviceId);
            tr.updatedAt = Math.max(nowMs, tr.updatedAt + 1);
          }
          if (policy.direction !== 'push_only') {
            await this.applyTrackToBrowser(rt, siteKey, trackId, {
              cleanStale: false,
              triggerRefresh: true,
            });
          }
          added.push(siteKey);
          continue;
        }

        // Pre-add empty initial SiteTrack + USER_BOUND binding so future login auto-syncs immediately
        if (!decision.binding.trackId && remoteTracks.length === 0) {
          const trackId = `trk_${rt.meta.localDevice.deviceId}_${siteKey}`;
          const trackUpdatedAt = Math.max(nowMs, (rt.meta.removedTracks?.[trackId] ?? 0) + 1);
          if (rt.meta.removedTracks) delete rt.meta.removedTracks[trackId];

          rt.tracks[trackId] = {
            trackId,
            siteKey,
            label: `${rt.meta.localDevice.name} 的版本`,
            originDeviceId: rt.meta.localDevice.deviceId,
            originDeviceName: rt.meta.localDevice.name,
            cookieCount: 0,
            localStorageCount: 0,
            updatedAt: trackUpdatedAt,
            memberDeviceIds: [rt.meta.localDevice.deviceId],
            revision: 1,
          };
          rt.meta.localDevice.siteBindings[siteKey] = {
            siteKey,
            state: 'USER_BOUND',
            trackId,
            availableTrackIds: [trackId],
            hasLocalBaseline: false,
            localCookieCount: 0,
            decidedAt: nowMs,
            decidedBy: 'user',
          };
          delete rt.pendingDecisions[siteKey];
          added.push(siteKey);
          continue;
        }

        if (decision.binding.trackId) {
          const trackId = decision.binding.trackId;
          rt.meta.localDevice.siteBindings[siteKey] = decision.binding;
          if (policy.direction !== 'pull_only' && policy.syncLocalStorage) {
            for (const { origin, items } of localLsByOrigin) {
              for (const [key, value] of Object.entries(items)) {
                const lid = buildLocalStorageLogicalId(trackId, origin, key);
                if (!rt.localStorage[lid] && !rt.tombstones[lid]) {
                  await this.emitLocalStorageUpsert(
                    rt,
                    siteKey,
                    trackId,
                    origin,
                    key,
                    value,
                    'CREATE',
                  );
                }
              }
            }
          }
          added.push(siteKey);
        }
      }

      const localDevPolicy = this.getLocalDevicePolicy(rt);
      const canPush =
        localDevPolicy?.direction !== 'pull_only' && localDevPolicy?.direction !== 'disabled';
      if (canPush) {
        await this.tryPushOutboundBestEffort(rt, 'add_managed_sites');
      }
      await this.uploadDeviceManifestIfOnline(rt);
      rt.meta.space.status = this.computeStatus(rt);
      await this.persistRuntime(rt);

      return { added, pendingDecisions };
    });
  }

  async removeManagedSite(
    siteKey: string,
    scope: 'device_unmanage' | 'space_remove',
  ): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const nowMs = this.now();
      const normSiteKey =
        resolveSiteKey(siteKey, rt.meta.rules.ssoGroups) || normalizeDomain(siteKey) || siteKey;

      if (scope === 'device_unmanage') {
        const prevBinding = rt.meta.localDevice.siteBindings[normSiteKey];
        if (prevBinding?.trackId && rt.tracks[prevBinding.trackId]) {
          const tr = rt.tracks[prevBinding.trackId];
          tr.memberDeviceIds = tr.memberDeviceIds.filter(
            (id) => id !== rt.meta.localDevice.deviceId,
          );
          tr.updatedAt = Math.max(nowMs, tr.updatedAt + 1);
        }

        rt.meta.localDevice.siteBindings[normSiteKey] = {
          siteKey: normSiteKey,
          state: 'UNMANAGED',
          trackId: undefined,
          hasLocalBaseline: false,
          decidedAt: nowMs,
          decidedBy: 'user',
        };
        delete rt.pendingDecisions[normSiteKey];
        rt.pendingOutboundEvents = rt.pendingOutboundEvents.filter(
          (ev) => ev.siteKey !== normSiteKey,
        );

        rt.meta.space.status = this.computeStatus(rt);
        await this.uploadDeviceManifestIfOnline(rt);
        await this.persistRuntime(rt);
        return;
      }

      // scope === 'space_remove': emit all_devices tombstones for remote cookies & LS, drop tracks, unmanage locally
      const siteCookies = Object.values(rt.cookies).filter(
        (c) => c.siteKey === normSiteKey && !c.deleted,
      );
      for (const rec of siteCookies) {
        await this.emitLocalCookieDelete(rt, rec, 'user_delete', 'all_devices');
      }

      const siteLs = Object.values(rt.localStorage).filter(
        (l) => l.siteKey === normSiteKey && !l.deleted,
      );
      for (const rec of siteLs) {
        await this.emitLocalStorageDelete(rt, rec, 'user_delete', 'all_devices');
      }

      rt.meta.removedTracks = rt.meta.removedTracks ?? {};
      for (const [tid, tr] of Object.entries(rt.tracks)) {
        if (tr.siteKey === normSiteKey) {
          rt.meta.removedTracks[tid] = Math.max(nowMs, tr.updatedAt + 1);
          delete rt.tracks[tid];
        }
      }

      delete rt.pendingDecisions[normSiteKey];
      rt.meta.localDevice.siteBindings[normSiteKey] = {
        siteKey: normSiteKey,
        state: 'UNMANAGED',
        trackId: undefined,
        hasLocalBaseline: false,
        decidedAt: nowMs,
        decidedBy: 'user',
      };

      const localDevPolicy = this.getLocalDevicePolicy(rt);
      const canPush =
        localDevPolicy?.direction !== 'pull_only' && localDevPolicy?.direction !== 'disabled';
      if (canPush) {
        await this.tryPushOutboundBestEffort(rt, 'remove_managed_site');
      }
      await this.uploadDeviceManifestIfOnline(rt);
      rt.meta.space.status = this.computeStatus(rt);
      await this.persistRuntime(rt);
    });
  }

  async setSpaceAuthorityPolicy(params: {
    authorityMode: SpaceAuthorityMode;
    primaryDeviceId?: string;
  }): Promise<SpaceSettings> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const nextUpdatedAt = Math.max(this.now(), rt.meta.space.updatedAt + 1);

      rt.meta.space.settings = {
        ...rt.meta.space.settings,
        authorityMode: params.authorityMode,
        primaryDeviceId:
          params.authorityMode === 'primary_device' ? params.primaryDeviceId : undefined,
      };
      rt.meta.space.updatedAt = nextUpdatedAt;
      rt.rulesEngine.update(rt.meta.space.settings, rt.meta.rules, rt.meta.deviceBlacklist);

      await this.updateRemoteSpaceMetaIfPossible(rt, (desc) => ({
        ...desc,
        settings: rt.meta.space.settings,
        updatedAt: nextUpdatedAt,
      }));

      await this.reEvaluatePendingDecisionsInternal(rt, {
        deferSyncAndPersist: false,
        triggerRefresh: true,
      });

      await this.uploadDeviceManifestIfOnline(rt);
      rt.meta.space.status = this.computeStatus(rt);
      await this.persistRuntime(rt);

      return { ...rt.meta.space.settings };
    });
  }

  async upsertDevicePolicy(policy: PerDeviceSyncPolicy): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const nowMs = this.now();
      const nextUpdatedAt = Math.max(nowMs, rt.meta.space.updatedAt + 1);

      const normalizedExcluded = policy.excludedSiteKeys
        ? Array.from(
            new Set(
              policy.excludedSiteKeys
                .map((k) => {
                  const trimmed = k.trim();
                  if (!trimmed) return '';
                  return (
                    resolveSiteKey(trimmed, rt.meta.rules.ssoGroups) || normalizeDomain(trimmed)
                  );
                })
                .filter(Boolean),
            ),
          )
        : undefined;

      const normalizedPolicy: PerDeviceSyncPolicy = {
        ...policy,
        excludedSiteKeys: normalizedExcluded,
        updatedAt: policy.updatedAt || nowMs,
      };

      rt.meta.space.settings = {
        ...rt.meta.space.settings,
        devicePolicies: {
          ...(rt.meta.space.settings.devicePolicies ?? {}),
          [policy.deviceId]: normalizedPolicy,
        },
      };
      rt.meta.space.updatedAt = nextUpdatedAt;
      rt.rulesEngine.update(rt.meta.space.settings, rt.meta.rules, rt.meta.deviceBlacklist);

      await this.updateRemoteSpaceMetaIfPossible(rt, (desc) => ({
        ...desc,
        settings: rt.meta.space.settings,
        updatedAt: nextUpdatedAt,
      }));

      if (policy.deviceId === rt.meta.localDevice.deviceId) {
        await this.reEvaluatePendingDecisionsInternal(rt, {
          deferSyncAndPersist: false,
          triggerRefresh: true,
        });
      }

      await this.uploadDeviceManifestIfOnline(rt);
      rt.meta.space.status = this.computeStatus(rt);
      await this.persistRuntime(rt);
    });
  }

  async removeDevicePolicy(deviceId: string): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const nextUpdatedAt = Math.max(this.now(), rt.meta.space.updatedAt + 1);

      const nextPolicies = { ...(rt.meta.space.settings.devicePolicies ?? {}) };
      delete nextPolicies[deviceId];

      rt.meta.space.settings = {
        ...rt.meta.space.settings,
        devicePolicies: nextPolicies,
      };
      rt.meta.space.updatedAt = nextUpdatedAt;
      rt.rulesEngine.update(rt.meta.space.settings, rt.meta.rules, rt.meta.deviceBlacklist);

      await this.updateRemoteSpaceMetaIfPossible(rt, (desc) => ({
        ...desc,
        settings: rt.meta.space.settings,
        updatedAt: nextUpdatedAt,
      }));

      if (deviceId === rt.meta.localDevice.deviceId) {
        await this.reEvaluatePendingDecisionsInternal(rt, {
          deferSyncAndPersist: false,
          triggerRefresh: true,
        });
      }

      await this.uploadDeviceManifestIfOnline(rt);
      rt.meta.space.status = this.computeStatus(rt);
      await this.persistRuntime(rt);
    });
  }

  async dismissLatestError(): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.runtime;
      if (!rt) return;
      rt.meta.latestError = null;
      rt.meta.consecutiveTransientFailures = 0;
      for (const t of rt.retryTasks) {
        if (t.status === 'RETRYING' || t.status === 'FAILED') {
          t.status = 'CANCELLED';
        }
      }
      if (rt.meta.space.status === 'AUTH_ERROR') {
        rt.meta.space.status = 'SYNCED';
      }
      rt.meta.space.status = this.computeStatus(rt);
      await this.persistRuntime(rt);
    });
  }

  async dismissAttentionItem(itemId: string): Promise<void> {
    await this.ensureInitialized();
    if (itemId.startsWith('deferred_reload:')) {
      const tabId = Number(itemId.slice('deferred_reload:'.length));
      if (Number.isFinite(tabId)) {
        this.autoRefresh.dismissDeferredForTab(tabId);
      }
      return;
    }

    return this.enqueueOp(async () => {
      const rt = this.runtime;
      if (!rt) return;

      if (itemId === 'all') {
        rt.meta.latestError = null;
        rt.meta.consecutiveTransientFailures = 0;
        rt.meta.storageFullHalted = false;
        if (rt.meta.space.status === 'AUTH_ERROR') {
          rt.meta.space.status = 'SYNCED';
        }
        rt.meta.dismissedApplyFailures = rt.meta.dismissedApplyFailures ?? {};
        for (const c of this.getUnacknowledgedFailedCookies(rt)) {
          rt.meta.dismissedApplyFailures[c.logicalId] = cookieContentCanonicalHash(c);
        }
        rt.meta.dismissedCorruptedPaths = rt.meta.dismissedCorruptedPaths ?? {};
        for (const p of rt.meta.corruptedPaths) {
          rt.meta.dismissedCorruptedPaths[p] = true;
        }
        for (const t of rt.retryTasks) {
          if (t.status === 'RETRYING' || t.status === 'FAILED') {
            t.status = 'CANCELLED';
          }
        }
        for (const def of this.autoRefresh.getDeferredReloads()) {
          this.autoRefresh.dismissDeferredForTab(def.tabId);
        }
      } else if (itemId === 'latest_error' || itemId === 'auth_error') {
        rt.meta.latestError = null;
        rt.meta.consecutiveTransientFailures = 0;
        for (const t of rt.retryTasks) {
          if (t.status === 'RETRYING' || t.status === 'FAILED') {
            t.status = 'CANCELLED';
          }
        }
        if (rt.meta.space.status === 'AUTH_ERROR') {
          rt.meta.space.status = 'SYNCED';
        }
      } else if (itemId === 'storage_full') {
        rt.meta.storageFullHalted = false;
        rt.meta.latestError = null;
      } else if (itemId === 'corrupted_files') {
        rt.meta.dismissedCorruptedPaths = rt.meta.dismissedCorruptedPaths ?? {};
        for (const p of rt.meta.corruptedPaths) {
          rt.meta.dismissedCorruptedPaths[p] = true;
        }
      } else if (itemId === 'retry_tasks' || itemId === 'offline_pending') {
        rt.meta.consecutiveTransientFailures = 0;
        for (const t of rt.retryTasks) {
          if (t.status === 'RETRYING' || t.status === 'FAILED') {
            t.status = 'CANCELLED';
          }
        }
      } else if (itemId.startsWith('apply_failed:')) {
        const targetSiteKey = itemId.slice('apply_failed:'.length);
        rt.meta.dismissedApplyFailures = rt.meta.dismissedApplyFailures ?? {};
        for (const c of this.getUnacknowledgedFailedCookies(rt)) {
          if (!targetSiteKey || c.siteKey === targetSiteKey) {
            rt.meta.dismissedApplyFailures[c.logicalId] = cookieContentCanonicalHash(c);
          }
        }
      }

      rt.meta.space.status = this.computeStatus(rt);
      await this.persistRuntime(rt);
    });
  }

  async retryFailedCookies(
    siteKey?: string,
  ): Promise<{ retried: number; succeeded: number; failed: number }> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const nowMs = this.now();
      const targets = this.getUnacknowledgedFailedCookies(rt).filter(
        (c) => !siteKey || c.siteKey === siteKey,
      );
      let succeeded = 0;
      let failed = 0;

      for (const rec of targets) {
        const hash = cookieContentCanonicalHash(rec);
        this.echoSuppressor.registerCookieMutation(rec, 'set', hash, nowMs);
        const verification = await applyCookieWithVerification(this.browser, rec, nowMs);
        rec.applyResult = verification;
        if (verification.accepted) {
          rec.syncStatus = 'IN_SYNC';
          rt.meta.appliedCookieHashes[rec.logicalId] = hash;
          if (rt.meta.dismissedApplyFailures) {
            delete rt.meta.dismissedApplyFailures[rec.logicalId];
          }
          succeeded += 1;
        } else if (verification.expired) {
          rec.syncStatus = 'EXPIRED';
        } else {
          rec.syncStatus = 'APPLY_FAILED';
          failed += 1;
        }
      }

      rt.meta.space.status = this.computeStatus(rt);
      await this.persistRuntime(rt);
      return { retried: targets.length, succeeded, failed };
    });
  }

  async forceReloadDeferredTab(tabId: number): Promise<boolean> {
    await this.ensureInitialized();
    return this.autoRefresh.forceReloadTab(tabId);
  }

  async getSiteCookies(siteKey: string, trackId?: string): Promise<CookieRecord[]> {
    await this.ensureInitialized();
    const rt = this.runtime;
    if (!rt) return [];

    const effectiveTrackId = trackId ?? rt.meta.localDevice.siteBindings[siteKey]?.trackId;
    return Object.values(rt.cookies)
      .filter((c) => {
        if (c.deleted) return false;
        if (effectiveTrackId) return c.trackId === effectiveTrackId;
        return c.siteKey === siteKey;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async upsertCookie(
    siteKey: string,
    cookie: BrowserCookieInput,
    trackId?: string,
  ): Promise<CookieRecord> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const emitted = await this.upsertCookieInternal(rt, siteKey, cookie, trackId);

      rt.meta.space.status = this.computeStatus(rt);
      await this.persistRuntime(rt);
      if (rt.meta.space.settings.autoSync) {
        await this.tryPushOutboundBestEffort(rt, 'upsert_cookie');
        rt.meta.space.status = this.computeStatus(rt);
        await this.persistRuntime(rt);
      }

      return { ...emitted };
    });
  }

  private async upsertCookieInternal(
    rt: LoadedSpaceRuntime,
    siteKey: string,
    cookie: BrowserCookieInput,
    explicitTrackId?: string,
  ): Promise<CookieRecord> {
    const nowMs = this.now();
    const effectiveSiteKey = siteKey || resolveSiteKey(cookie.domain, rt.meta.rules.ssoGroups);

    const boundTrackId = rt.meta.localDevice.siteBindings[effectiveSiteKey]?.trackId;
    let trackId: string | undefined;
    if (explicitTrackId) {
      const targetTrack = rt.tracks[explicitTrackId];
      if (!targetTrack || targetTrack.siteKey !== effectiveSiteKey) {
        throw new Error(`Track "${explicitTrackId}" not found for site "${effectiveSiteKey}"`);
      }
      trackId = explicitTrackId;
    } else {
      trackId = boundTrackId;
    }

    if (!trackId) {
      const existingTracks = Object.values(rt.tracks).filter(
        (t) => t.siteKey === effectiveSiteKey,
      );
      if (existingTracks.length === 1) {
        trackId = existingTracks[0].trackId;
        rt.meta.localDevice.siteBindings[effectiveSiteKey] = {
          siteKey: effectiveSiteKey,
          state: 'USER_BOUND',
          trackId,
          hasLocalBaseline: true,
          decidedAt: nowMs,
          decidedBy: 'user',
        };
      } else {
        trackId = randomId('trk');
        rt.tracks[trackId] = {
          trackId,
          siteKey: effectiveSiteKey,
          label: `${rt.meta.localDevice.name} 的版本`,
          originDeviceId: rt.meta.localDevice.deviceId,
          originDeviceName: rt.meta.localDevice.name,
          cookieCount: 0,
          localStorageCount: 0,
          updatedAt: nowMs,
          memberDeviceIds: [rt.meta.localDevice.deviceId],
          revision: 1,
        };
        rt.meta.localDevice.siteBindings[effectiveSiteKey] = {
          siteKey: effectiveSiteKey,
          state: 'USER_BOUND',
          trackId,
          hasLocalBaseline: true,
          decidedAt: nowMs,
          decidedBy: 'user',
        };
      }
    }

    const isActiveBoundTrack =
      !explicitTrackId ||
      rt.meta.localDevice.siteBindings[effectiveSiteKey]?.trackId === trackId;

    // Canonicalize cookie attributes to match Chromium's actual storage semantics
    // (e.g. `__Host-`, `localhost`, IPv4/IPv6, and single-label hosts are ALWAYS hostOnly=true)
    const effectiveHostOnly = resolveEffectiveHostOnly(cookie.domain, cookie.hostOnly, cookie.name);
    const effectivePath = cookie.name.startsWith('__Host-') ? '/' : cookie.path || '/';
    const effectiveSecure =
      cookie.name.startsWith('__Host-') ||
      cookie.name.startsWith('__Secure-') ||
      cookie.sameSite === 'no_restriction'
        ? true
        : cookie.secure;
    const normalizedCookie: BrowserCookieInput = {
      ...cookie,
      domain: normalizeCookieDomain(cookie.domain, effectiveHostOnly),
      path: effectivePath,
      hostOnly: effectiveHostOnly,
      secure: effectiveSecure,
      sameSite: cookie.sameSite || 'unspecified',
    };

    const hash = cookieContentCanonicalHash(normalizedCookie);
    let verification: ApplyVerificationResult | undefined;
    if (isActiveBoundTrack) {
      // Apply to local browser with EchoSuppressor & read-back verification
      this.changeDetector.discardCookieKey(buildEchoCookieKey(normalizedCookie));
      this.echoSuppressor.registerCookieMutation(normalizedCookie, 'set', hash, nowMs);
      verification = await applyCookieWithVerification(this.browser, normalizedCookie, nowMs);
    }

    const emitted =
      (await this.emitLocalCookieUpsert(rt, effectiveSiteKey, trackId, normalizedCookie, 'UPDATE')) ??
      rt.cookies[
        buildCookieLogicalId({
          trackId,
          storeScope: normalizeCookieStoreScope(normalizedCookie.storeId),
          partitionKey: normalizedCookie.partitionKey,
          hostOnly: effectiveHostOnly,
          domain: normalizedCookie.domain,
          path: effectivePath,
          name: normalizedCookie.name,
        })
      ];

    if (verification) {
      emitted.applyResult = verification;
      if (verification.accepted) {
        rt.meta.appliedCookieHashes[emitted.logicalId] = hash;
        if (rt.meta.dismissedApplyFailures) {
          delete rt.meta.dismissedApplyFailures[emitted.logicalId];
        }
      } else if (verification.expired) {
        emitted.syncStatus = 'EXPIRED';
      } else {
        emitted.syncStatus = 'APPLY_FAILED';
      }
    }

    return emitted;
  }

  async applyCookieToBrowser(logicalId: string): Promise<CookieRecord> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const rec = rt.cookies[logicalId];
      if (!rec) {
        throw new Error(`Cookie record not found: ${logicalId}`);
      }

      const nowMs = this.now();
      const hash = cookieContentCanonicalHash(rec);
      this.changeDetector.discardCookieKey(buildEchoCookieKey(rec));
      this.echoSuppressor.registerCookieMutation(rec, 'set', hash, nowMs);
      const verification = await applyCookieWithVerification(this.browser, rec, nowMs);
      rec.applyResult = verification;
      if (verification.accepted) {
        rec.syncStatus = 'IN_SYNC';
        rt.meta.appliedCookieHashes[rec.logicalId] = hash;
        if (rt.meta.dismissedApplyFailures) {
          delete rt.meta.dismissedApplyFailures[rec.logicalId];
        }
      } else if (verification.expired) {
        rec.syncStatus = 'EXPIRED';
      } else {
        rec.syncStatus = 'APPLY_FAILED';
      }

      rt.meta.space.status = this.computeStatus(rt);
      await this.persistRuntime(rt);
      return { ...rec };
    });
  }

  async deleteCookies(
    logicalIds: string[],
    scope: DeleteScope,
    _siteKey?: string,
  ): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const nowMs = this.now();
      let pushedNeeded = false;

      for (const lid of logicalIds) {
        const rec = rt.cookies[lid];
        if (!rec) continue;
        const isActiveTrack =
          rt.meta.localDevice.siteBindings[rec.siteKey]?.trackId === rec.trackId;

        if (scope === 'local_only') {
          if (isActiveTrack) {
            await this.removeExactBrowserCookie(rec, cookieContentCanonicalHash(rec), nowMs);
          }
          delete rt.meta.appliedCookieHashes[lid];
          rec.syncStatus = 'REMOTE_ONLY';
          rec.updatedAt = nowMs;
          continue;
        }

        if (scope === 'remote_track_only') {
          await this.emitLocalCookieDelete(rt, rec, 'user_delete', 'remote_track_only');
          pushedNeeded = true;
          continue;
        }

        if (scope === 'all_devices') {
          if (isActiveTrack) {
            await this.removeExactBrowserCookie(rec, cookieContentCanonicalHash(rec), nowMs);
          }
          await this.emitLocalCookieDelete(rt, rec, 'user_delete', 'all_devices');
          pushedNeeded = true;
        }
      }

      await this.persistRuntime(rt);
      if (pushedNeeded && rt.meta.space.settings.autoSync) {
        await this.tryPushOutboundBestEffort(rt, 'delete_cookies');
        rt.meta.space.status = this.computeStatus(rt);
        await this.persistRuntime(rt);
      }
    });
  }

  async importCookiesJson(
    cookies: BrowserCookieInput[],
    siteKey?: string,
    trackId?: string,
  ): Promise<number> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      let count = 0;
      for (const c of cookies) {
        const targetSite = siteKey || resolveSiteKey(c.domain, rt.meta.rules.ssoGroups);
        if (!targetSite) continue;
        await this.upsertCookieInternal(rt, targetSite, c, trackId);
        count += 1;
      }

      if (count > 0) {
        rt.meta.space.status = this.computeStatus(rt);
        await this.persistRuntime(rt);
        if (rt.meta.space.settings.autoSync) {
          await this.tryPushOutboundBestEffort(rt, 'import_cookies');
          rt.meta.space.status = this.computeStatus(rt);
          await this.persistRuntime(rt);
        }
      }

      return count;
    });
  }

  async exportCookiesJson(siteKey?: string, trackId?: string): Promise<BrowserCookieInput[]> {
    await this.ensureInitialized();
    const rt = this.runtime;
    if (!rt) return [];

    let records: CookieRecord[];
    if (siteKey) {
      records = await this.getSiteCookies(siteKey, trackId);
    } else if (trackId) {
      records = Object.values(rt.cookies).filter((c) => !c.deleted && c.trackId === trackId);
    } else {
      records = Object.values(rt.cookies).filter((c) => !c.deleted);
    }

    return records.map((c) => ({
      domain: c.domain,
      name: c.name,
      value: c.value,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      session: c.session,
      expirationDate: c.expirationDate,
      hostOnly: c.hostOnly,
      storeId: c.storeScope && c.storeScope !== 'default' ? c.storeScope : undefined,
      partitionKey: c.partitionKey,
    }));
  }

  async getLocalStorageRecords(filter?: {
    siteKey?: string;
    origin?: string;
    trackId?: string;
  }): Promise<LocalStorageRecord[]> {
    await this.ensureInitialized();
    const rt = this.runtime;
    if (!rt) return [];

    return Object.values(rt.localStorage)
      .filter((r) => {
        if (r.deleted) return false;
        if (filter?.origin && r.origin !== filter.origin) return false;
        if (filter?.trackId) {
          return r.trackId === filter.trackId;
        }
        if (filter?.siteKey) {
          const boundTrack = rt.meta.localDevice.siteBindings[filter.siteKey]?.trackId;
          if (boundTrack) return r.trackId === boundTrack;
          return r.siteKey === filter.siteKey;
        }
        return true;
      })
      .sort((a, b) => a.origin.localeCompare(b.origin) || a.key.localeCompare(b.key));
  }

  async upsertLocalStorageItem(
    origin: string,
    key: string,
    value: string,
    explicitTrackId?: string,
  ): Promise<LocalStorageRecord> {
    await this.ensureInitialized();
    const normOrigin = normalizeOriginSafe(origin);
    if (!normOrigin) throw new Error(`Invalid origin: ${origin}`);

    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const nowMs = this.now();
      const siteKey = resolveSiteKey(normOrigin, rt.meta.rules.ssoGroups);

      const boundTrackId = rt.meta.localDevice.siteBindings[siteKey]?.trackId;
      let trackId: string | undefined;
      if (explicitTrackId) {
        const targetTrack = rt.tracks[explicitTrackId];
        if (!targetTrack || targetTrack.siteKey !== siteKey) {
          throw new Error(`Track "${explicitTrackId}" not found for site "${siteKey}"`);
        }
        trackId = explicitTrackId;
      } else {
        trackId = boundTrackId;
      }

      if (!trackId) {
        const existingTracks = Object.values(rt.tracks).filter((t) => t.siteKey === siteKey);
        if (existingTracks.length === 1) {
          trackId = existingTracks[0].trackId;
        } else {
          trackId = randomId('trk');
          rt.tracks[trackId] = {
            trackId,
            siteKey,
            label: `${rt.meta.localDevice.name} 的版本`,
            originDeviceId: rt.meta.localDevice.deviceId,
            originDeviceName: rt.meta.localDevice.name,
            cookieCount: 0,
            localStorageCount: 0,
            updatedAt: nowMs,
            memberDeviceIds: [rt.meta.localDevice.deviceId],
            revision: 1,
          };
        }
        rt.meta.localDevice.siteBindings[siteKey] = {
          siteKey,
          state: 'USER_BOUND',
          trackId,
          hasLocalBaseline: true,
          decidedAt: nowMs,
          decidedBy: 'user',
        };
      }

      const isActiveBoundTrack =
        !explicitTrackId || rt.meta.localDevice.siteBindings[siteKey]?.trackId === trackId;

      let contextAvailable = false;
      if (isActiveBoundTrack) {
        this.echoSuppressor.registerLocalStorageMutation(normOrigin, key, 'set', value, nowMs);
        const applyRes = await this.browser.applyLocalStorage(normOrigin, [{ key, value }]);
        contextAvailable = applyRes.applied;
      }

      const rec =
        (await this.emitLocalStorageUpsert(rt, siteKey, trackId, normOrigin, key, value, 'UPDATE')) ??
        rt.localStorage[buildLocalStorageLogicalId(trackId, normOrigin, key)];

      rec.contextAvailable = contextAvailable;
      await this.persistRuntime(rt);

      if (rt.meta.space.settings.autoSync) {
        await this.tryPushOutboundBestEffort(rt, 'upsert_local_storage');
        rt.meta.space.status = this.computeStatus(rt);
        await this.persistRuntime(rt);
      }
      return { ...rec };
    });
  }

  async applyLocalStorageItem(logicalId: string): Promise<LocalStorageRecord> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const rec = rt.localStorage[logicalId];
      if (!rec) throw new Error(`LocalStorage record not found: ${logicalId}`);

      const nowMs = this.now();
      this.echoSuppressor.registerLocalStorageMutation(rec.origin, rec.key, 'set', rec.value, nowMs);
      const res = await this.browser.applyLocalStorage(rec.origin, [
        { key: rec.key, value: rec.value },
      ]);
      rec.contextAvailable = res.applied;
      rec.syncStatus = res.applied ? 'IN_SYNC' : 'REMOTE_NEWER';
      await this.persistRuntime(rt);
      return { ...rec };
    });
  }

  async deleteLocalStorageItems(logicalIds: string[], scope: DeleteScope): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const nowMs = this.now();
      let pushNeeded = false;

      for (const lid of logicalIds) {
        const rec = rt.localStorage[lid];
        if (!rec) continue;
        const isActiveTrack =
          rt.meta.localDevice.siteBindings[rec.siteKey]?.trackId === rec.trackId;

        if (scope === 'local_only') {
          if (isActiveTrack) {
            this.echoSuppressor.registerLocalStorageMutation(rec.origin, rec.key, 'remove', '', nowMs);
            await this.browser.applyLocalStorage(rec.origin, [{ key: rec.key, deleted: true }]);
          }
          rec.syncStatus = 'REMOTE_ONLY';
          continue;
        }

        if (scope === 'remote_track_only') {
          await this.emitLocalStorageDelete(rt, rec, 'user_delete', 'remote_track_only');
          pushNeeded = true;
          continue;
        }

        if (scope === 'all_devices') {
          if (isActiveTrack) {
            this.echoSuppressor.registerLocalStorageMutation(rec.origin, rec.key, 'remove', '', nowMs);
            await this.browser.applyLocalStorage(rec.origin, [{ key: rec.key, deleted: true }]);
          }
          await this.emitLocalStorageDelete(rt, rec, 'user_delete', 'all_devices');
          pushNeeded = true;
        }
      }

      await this.persistRuntime(rt);
      if (pushNeeded && rt.meta.space.settings.autoSync) {
        await this.tryPushOutboundBestEffort(rt, 'delete_local_storage');
        rt.meta.space.status = this.computeStatus(rt);
        await this.persistRuntime(rt);
      }
    });
  }

  // =========================================================================
  // Rules & Blacklists
  // =========================================================================

  private syncRulesEngineState(rt: LoadedSpaceRuntime): void {
    rt.rulesEngine.update(
      rt.meta.space.settings,
      rt.meta.rules,
      rt.meta.deviceBlacklist,
      rt.meta.deviceEnvSyncRules ?? [],
    );
  }

  getCachedSsoGroups(): SsoDomainGroup[] {
    return this.runtime?.meta.rules.ssoGroups ?? [];
  }

  async getRulesAndBlacklist(): Promise<{
    spaceBlacklist: BlacklistEntry[];
    deviceBlacklist: BlacklistEntry[];
    siteOverrides: Record<string, SiteRuleOverride>;
    ssoGroups: SsoDomainGroup[];
    envSyncRules: EnvCookieSyncRule[];
  }> {
    await this.ensureInitialized();
    const rt = this.runtime;
    if (!rt) {
      return {
        spaceBlacklist: [],
        deviceBlacklist: [],
        siteOverrides: {},
        ssoGroups: [],
        envSyncRules: [],
      };
    }
    const spaceEnvRules = (rt.meta.rules.envSyncRules ?? []).map((r) => ({
      ...r,
      scope: 'space' as const,
    }));
    const deviceEnvRules = (rt.meta.deviceEnvSyncRules ?? []).map((r) => ({
      ...r,
      scope: 'device' as const,
    }));
    return {
      spaceBlacklist: [...rt.meta.rules.spaceBlacklist],
      deviceBlacklist: [...rt.meta.deviceBlacklist],
      siteOverrides: { ...rt.meta.rules.siteOverrides },
      ssoGroups: [...rt.meta.rules.ssoGroups],
      envSyncRules: [...deviceEnvRules, ...spaceEnvRules],
    };
  }

  async addBlacklistEntry(entry: Omit<BlacklistEntry, 'id' | 'createdAt'>): Promise<BlacklistEntry> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const created = await this.addBlacklistEntryInternal(rt, entry);
      await this.persistRuntime(rt);
      return created;
    });
  }

  private async addBlacklistEntryInternal(
    rt: LoadedSpaceRuntime,
    entry: Omit<BlacklistEntry, 'id' | 'createdAt'>,
  ): Promise<BlacklistEntry> {
    const nowMs = this.now();
    const created: BlacklistEntry = {
      ...entry,
      id: randomId('bl'),
      createdAt: nowMs,
    };

    if (entry.scope === 'space') {
      rt.meta.rules.spaceBlacklist.push(created);
      rt.meta.rules.updatedAt = nowMs;
    } else {
      rt.meta.deviceBlacklist.push(created);
    }

    rt.rulesEngine.update(rt.meta.space.settings, rt.meta.rules, rt.meta.deviceBlacklist);
    this.reconcileBlacklistBindings(rt);

    if (entry.scope === 'space') {
      await this.updateRemoteSpaceMetaIfPossible(rt, (desc) => ({
        ...desc,
        rules: rt.meta.rules,
        updatedAt: nowMs,
      }));
      await this.uploadDeviceManifestIfOnline(rt);
    }

    return created;
  }

  private reconcileBlacklistBindings(rt: LoadedSpaceRuntime): void {
    const nowMs = this.now();
    for (const siteKey of Object.keys(rt.meta.localDevice.siteBindings)) {
      if (rt.rulesEngine.isBlacklisted(siteKey).blacklisted) {
        rt.meta.localDevice.siteBindings[siteKey] = {
          ...rt.meta.localDevice.siteBindings[siteKey],
          state: 'BLACKLISTED',
          decidedAt: nowMs,
        };
        delete rt.pendingDecisions[siteKey];
      }
    }
    for (const siteKey of Object.keys(rt.pendingDecisions)) {
      if (rt.rulesEngine.isBlacklisted(siteKey).blacklisted) {
        delete rt.pendingDecisions[siteKey];
      }
    }
  }

  async removeBlacklistEntry(id: string, scope: 'space' | 'device'): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const nowMs = this.now();

      if (scope === 'space') {
        rt.meta.rules.spaceBlacklist = rt.meta.rules.spaceBlacklist.filter((b) => b.id !== id);
        rt.meta.rules.updatedAt = nowMs;
      } else {
        rt.meta.deviceBlacklist = rt.meta.deviceBlacklist.filter((b) => b.id !== id);
      }

      rt.rulesEngine.update(rt.meta.space.settings, rt.meta.rules, rt.meta.deviceBlacklist);

      // Restore previously bound sites (or clear stale BLACKLISTED bindings) once no longer blacklisted
      for (const [siteKey, binding] of Object.entries(rt.meta.localDevice.siteBindings)) {
        if (binding.state === 'BLACKLISTED' && !rt.rulesEngine.isBlacklisted(siteKey).blacklisted) {
          if (binding.trackId && rt.tracks[binding.trackId]) {
            rt.meta.localDevice.siteBindings[siteKey] = {
              ...binding,
              state: 'USER_BOUND',
              decidedAt: nowMs,
            };
          } else {
            delete rt.meta.localDevice.siteBindings[siteKey];
          }
        }
      }

      if (scope === 'space') {
        await this.updateRemoteSpaceMetaIfPossible(rt, (desc) => ({
          ...desc,
          rules: rt.meta.rules,
          updatedAt: nowMs,
        }));
        await this.uploadDeviceManifestIfOnline(rt);
      }
      await this.persistRuntime(rt);
    });
  }

  async upsertSiteRule(rule: SiteRuleOverride): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const nowMs = this.now();
      rt.meta.rules.siteOverrides[rule.siteKey] = { ...rule, updatedAt: nowMs };
      rt.meta.rules.updatedAt = nowMs;
      rt.rulesEngine.update(rt.meta.space.settings, rt.meta.rules, rt.meta.deviceBlacklist);

      await this.updateRemoteSpaceMetaIfPossible(rt, (desc) => ({
        ...desc,
        rules: rt.meta.rules,
        updatedAt: nowMs,
      }));
      await this.uploadDeviceManifestIfOnline(rt);
      await this.persistRuntime(rt);
    });
  }

  async removeSiteRule(siteKey: string): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const nowMs = this.now();
      delete rt.meta.rules.siteOverrides[siteKey];
      rt.meta.rules.updatedAt = nowMs;
      rt.rulesEngine.update(rt.meta.space.settings, rt.meta.rules, rt.meta.deviceBlacklist);

      await this.updateRemoteSpaceMetaIfPossible(rt, (desc) => ({
        ...desc,
        rules: rt.meta.rules,
        updatedAt: nowMs,
      }));
      await this.uploadDeviceManifestIfOnline(rt);
      await this.persistRuntime(rt);
    });
  }

  async upsertSsoGroup(group: SsoDomainGroup): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const nowMs = this.now();
      const idx = rt.meta.rules.ssoGroups.findIndex((g) => g.groupId === group.groupId);
      if (idx >= 0) {
        rt.meta.rules.ssoGroups[idx] = { ...group };
      } else {
        rt.meta.rules.ssoGroups.push({ ...group });
      }
      rt.meta.rules.updatedAt = nowMs;
      rt.rulesEngine.update(rt.meta.space.settings, rt.meta.rules, rt.meta.deviceBlacklist);

      await this.updateRemoteSpaceMetaIfPossible(rt, (desc) => ({
        ...desc,
        rules: rt.meta.rules,
        updatedAt: nowMs,
      }));
      await this.uploadDeviceManifestIfOnline(rt);
      await this.persistRuntime(rt);
    });
  }

  async removeSsoGroup(groupId: string): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const nowMs = this.now();
      rt.meta.rules.ssoGroups = rt.meta.rules.ssoGroups.filter((g) => g.groupId !== groupId);
      rt.meta.rules.updatedAt = nowMs;
      this.syncRulesEngineState(rt);

      await this.updateRemoteSpaceMetaIfPossible(rt, (desc) => ({
        ...desc,
        rules: rt.meta.rules,
        updatedAt: nowMs,
      }));
      await this.uploadDeviceManifestIfOnline(rt);
      await this.persistRuntime(rt);
    });
  }

  async upsertEnvSyncRule(
    input: Omit<EnvCookieSyncRule, 'id' | 'name' | 'createdAt' | 'updatedAt'> & {
      id?: string;
      name?: string;
    },
  ): Promise<EnvCookieSyncRule> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireUnlockedRuntime();
      const nowMs = this.now();

      const normSource =
        resolveSiteKey(input.sourceSiteKey, rt.meta.rules.ssoGroups) ||
        normalizeDomain(input.sourceSiteKey);
      if (!normSource) {
        throw new Error('请输入有效的源环境域名（例如 example.com）');
      }

      const parsedTarget = parseEnvTarget(input.targetUrl);
      if (!parsedTarget) {
        throw new Error('请输入有效的目标环境地址（例如 http://localhost:3000 或 dev.example.com）');
      }

      const syncCookies = input.syncCookies ?? true;
      const syncLocalStorage = input.syncLocalStorage ?? false;
      if (!syncCookies && !syncLocalStorage) {
        throw new Error('请至少开启 Cookie 或 LocalStorage 之一进行跨环境同步');
      }

      if (isBlockedWebdavSelfTarget(rt.webdav.url, parsedTarget)) {
        throw new Error('禁止将目标环境指向当前 WebDAV 存储服务器自身域名');
      }

      const canonicalTargetUrl = parsedTarget.explicitWildcardDomain
        ? `.${parsedTarget.host}`
        : parsedTarget.origin;

      rt.meta.rules.envSyncRules = rt.meta.rules.envSyncRules ?? [];
      rt.meta.deviceEnvSyncRules = rt.meta.deviceEnvSyncRules ?? [];

      const scope: 'space' | 'device' = input.scope === 'space' ? 'space' : 'device';
      const rawSrcHost = normalizeDomain(input.sourceSiteKey);
      const effectiveSourceHostFilter = input.sourceHostFilter?.trim()
        ? normalizeDomain(input.sourceHostFilter)
        : rawSrcHost && rawSrcHost !== normSource
          ? rawSrcHost
          : undefined;

      const existingById = input.id
        ? (rt.meta.rules.envSyncRules.find((r) => r.id === input.id) ??
          rt.meta.deviceEnvSyncRules.find((r) => r.id === input.id))
        : undefined;
      // Deduplicate when id is omitted (e.g. clicking "注入并自动同步" repeatedly in Popup)
      const sameScopeList =
        scope === 'space' ? rt.meta.rules.envSyncRules : rt.meta.deviceEnvSyncRules;
      const existingByKey = !input.id?.trim()
        ? sameScopeList.find(
            (r) =>
              r.sourceSiteKey === normSource &&
              (r.sourceHostFilter ?? '') === (effectiveSourceHostFilter ?? '') &&
              parseEnvTarget(r.targetUrl)?.origin === parsedTarget.origin,
          )
        : undefined;
      const prev = existingById ?? existingByKey;
      const ruleId = input.id?.trim() || prev?.id || randomId('env');

      const cleanInclude = input.includeCookieNames
        ?.map((n) => n.trim())
        .filter(Boolean);
      const cleanExclude = input.excludeCookieNames
        ?.map((n) => n.trim())
        .filter(Boolean);

      // Strip accidental userinfo/query/hash if caller passed a raw URL containing credentials in `name`
      const sanitizedInputName = input.name
        ? sanitizeShortLabel(
            input.name.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi, '$1'),
          )
        : '';

      const saved: EnvCookieSyncRule = {
        id: ruleId,
        name:
          sanitizedInputName ||
          `${effectiveSourceHostFilter || normSource} → ${parsedTarget.host}${parsedTarget.port ? `:${parsedTarget.port}` : ''}`,
        scope,
        enabled: input.enabled ?? true,
        sourceSiteKey: normSource,
        sourceHostFilter: effectiveSourceHostFilter,
        sourceTrackId: input.sourceTrackId?.trim() || undefined,
        targetUrl: canonicalTargetUrl,
        syncCookies,
        syncLocalStorage,
        adaptForHttp: input.adaptForHttp ?? true,
        cleanTargetBeforeSync: input.cleanTargetBeforeSync ?? false,
        autoSync: input.autoSync ?? true,
        autoReloadTarget: input.autoReloadTarget ?? false,
        includeCookieNames: cleanInclude && cleanInclude.length > 0 ? cleanInclude : undefined,
        excludeCookieNames: cleanExclude && cleanExclude.length > 0 ? cleanExclude : undefined,
        lastSyncedAt: prev?.lastSyncedAt,
        lastSyncedCount: prev?.lastSyncedCount,
        createdAt: prev?.createdAt ?? nowMs,
        updatedAt: nowMs,
      };

      // Remove from both lists first (handles scope migration cleanly)
      const prevSpaceLen = rt.meta.rules.envSyncRules.length;
      rt.meta.rules.envSyncRules = rt.meta.rules.envSyncRules.filter((r) => r.id !== ruleId);
      rt.meta.deviceEnvSyncRules = rt.meta.deviceEnvSyncRules.filter((r) => r.id !== ruleId);

      let spaceMutated = rt.meta.rules.envSyncRules.length !== prevSpaceLen;
      if (scope === 'space') {
        rt.meta.rules.envSyncRules.push(saved);
        rt.meta.rules.updatedAt = nowMs;
        spaceMutated = true;
      } else {
        rt.meta.deviceEnvSyncRules.push(saved);
      }

      this.syncRulesEngineState(rt);

      if (spaceMutated) {
        await this.updateRemoteSpaceMetaIfPossible(rt, (desc) => ({
          ...desc,
          rules: rt.meta.rules,
          updatedAt: nowMs,
        }));
        await this.uploadDeviceManifestIfOnline(rt);
      }
      await this.persistRuntime(rt);
      return { ...saved };
    });
  }

  async removeEnvSyncRule(ruleId: string, scope?: 'space' | 'device'): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireUnlockedRuntime();
      const nowMs = this.now();
      rt.meta.rules.envSyncRules = rt.meta.rules.envSyncRules ?? [];
      rt.meta.deviceEnvSyncRules = rt.meta.deviceEnvSyncRules ?? [];

      let spaceChanged = false;
      if (!scope || scope === 'space') {
        const before = rt.meta.rules.envSyncRules.length;
        rt.meta.rules.envSyncRules = rt.meta.rules.envSyncRules.filter((r) => r.id !== ruleId);
        if (rt.meta.rules.envSyncRules.length !== before) {
          rt.meta.rules.updatedAt = nowMs;
          spaceChanged = true;
        }
      }
      if (!scope || scope === 'device') {
        rt.meta.deviceEnvSyncRules = rt.meta.deviceEnvSyncRules.filter((r) => r.id !== ruleId);
      }

      this.syncRulesEngineState(rt);

      if (spaceChanged) {
        await this.updateRemoteSpaceMetaIfPossible(rt, (desc) => ({
          ...desc,
          rules: rt.meta.rules,
          updatedAt: nowMs,
        }));
        await this.uploadDeviceManifestIfOnline(rt);
      }
      await this.persistRuntime(rt);
    });
  }

  async executeEnvCookieSync(input: ExecuteEnvSyncInput): Promise<EnvCookieSyncResult> {
    await this.ensureInitialized();
    await this.changeDetector.flush();
    return this.enqueueOp(async () => {
      const rt = this.requireUnlockedRuntime();
      return this.executeEnvCookieSyncInternal(rt, input, true);
    });
  }

  private async runAutoEnvSyncForSourceSites(
    rt: LoadedSpaceRuntime,
    sourceSites: Iterable<string>,
    options?: { onlyWithLocalStorage?: boolean },
  ): Promise<void> {
    if (this.inAutoEnvSync || rt.meta.globalPaused) return;
    const siteSet = new Set(sourceSites);
    if (siteSet.size === 0) return;

    const allRules = [
      ...(rt.meta.deviceEnvSyncRules ?? []),
      ...(rt.meta.rules.envSyncRules ?? []),
    ];
    const matchingRules = allRules.filter((r) => {
      if (!r.enabled || !r.autoSync) return false;
      if (options?.onlyWithLocalStorage && !r.syncLocalStorage) return false;
      const normSrc =
        resolveSiteKey(r.sourceSiteKey, rt.meta.rules.ssoGroups) ||
        normalizeDomain(r.sourceSiteKey);
      return siteSet.has(normSrc);
    });

    if (matchingRules.length === 0) return;

    this.inAutoEnvSync = true;
    let executedAny = false;
    try {
      for (const rule of matchingRules) {
        try {
          await this.executeEnvCookieSyncInternal(rt, { ruleId: rule.id }, false);
          executedAny = true;
        } catch (err) {
          await this.logger.log({
            spaceId: rt.spaceId,
            level: 'warn',
            phase: 'env_cookie_sync',
            siteKey: rule.sourceSiteKey,
            message: `Auto env cookie sync "${rule.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: this.now(),
          });
        }
      }
      if (executedAny) {
        await this.persistRuntime(rt);
      }
    } finally {
      this.inAutoEnvSync = false;
    }
  }

  private async applyEnvLsEntriesToOpenOrigin(
    targetOrigin: string,
    currentItems: Record<string, string>,
    targetEntries: Array<[string, string]>,
    cleanTargetBeforeSync: boolean,
    excludeSet: Set<string>,
    nowMs: number,
  ): Promise<{ applied: boolean; mutated: boolean }> {
    const mutations: Array<{ key: string; value?: string; deleted?: boolean }> = [];
    if (cleanTargetBeforeSync) {
      const keepKeys = new Set(targetEntries.map(([k]) => k));
      for (const existingKey of Object.keys(currentItems)) {
        if (!keepKeys.has(existingKey) && !excludeSet.has(existingKey)) {
          this.echoSuppressor.registerLocalStorageMutation(
            targetOrigin,
            existingKey,
            'remove',
            '',
            nowMs,
          );
          mutations.push({ key: existingKey, deleted: true });
        }
      }
    }
    for (const [k, v] of targetEntries) {
      const hasOwnKey = Object.prototype.hasOwnProperty.call(currentItems, k);
      if (!hasOwnKey || currentItems[k] !== v) {
        this.echoSuppressor.registerLocalStorageMutation(targetOrigin, k, 'set', v, nowMs);
        mutations.push({ key: k, value: v });
      }
    }
    if (mutations.length === 0) {
      return { applied: true, mutated: false };
    }
    const lsApply = await this.browser.applyLocalStorage(targetOrigin, mutations);
    return { applied: lsApply.applied, mutated: lsApply.applied };
  }

  private async hydrateAutoEnvTargetsOnMount(
    rt: LoadedSpaceRuntime,
    mountedOrigin: string,
  ): Promise<void> {
    if (this.inAutoEnvSync || rt.meta.globalPaused) return;

    const allRules = [
      ...(rt.meta.deviceEnvSyncRules ?? []),
      ...(rt.meta.rules.envSyncRules ?? []),
    ];
    const matchingTargetRules = allRules.filter(
      (r) =>
        r.enabled &&
        r.autoSync &&
        r.syncLocalStorage &&
        envRuleMatchesUrl(r, mountedOrigin, rt.meta.rules.ssoGroups) === 'target',
    );
    const pendingAdhoc = rt.meta.pendingEnvLsByOrigin?.[mountedOrigin];
    if (matchingTargetRules.length === 0 && !pendingAdhoc) return;

    this.inAutoEnvSync = true;
    let executedAny = false;
    try {
      for (const rule of matchingTargetRules) {
        try {
          await this.executeEnvCookieSyncInternal(rt, { ruleId: rule.id }, false);
          executedAny = true;
        } catch (err) {
          await this.logger.log({
            spaceId: rt.spaceId,
            level: 'warn',
            phase: 'env_cookie_sync',
            siteKey: rule.sourceSiteKey,
            message: `Target mount hydration "${rule.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: this.now(),
          });
        }
      }

      const remainingAdhoc = rt.meta.pendingEnvLsByOrigin?.[mountedOrigin];
      if (remainingAdhoc) {
        delete rt.meta.pendingEnvLsByOrigin![mountedOrigin];
        executedAny = true;
        const targetLs = await this.browser.getLocalStorage(mountedOrigin);
        if (targetLs.available) {
          const entries = Object.entries(remainingAdhoc.items);
          const applyRes = await this.applyEnvLsEntriesToOpenOrigin(
            mountedOrigin,
            targetLs.items,
            entries,
            remainingAdhoc.cleanTargetBeforeSync,
            new Set(remainingAdhoc.excludeKeys),
            this.now(),
          );
          if (applyRes.mutated && remainingAdhoc.autoReloadTarget) {
            this.postTrackSwitchLeaveMuteUntil.set(
              resolveSiteKey(mountedOrigin, rt.meta.rules.ssoGroups) || mountedOrigin,
              this.now() + 2_500,
            );
            await this.reloadTabsForUserAction(rt, (tabUrl) => normalizeOriginSafe(tabUrl) === mountedOrigin);
          }
        }
      }

      if (executedAny) {
        await this.persistRuntime(rt);
      }
    } finally {
      this.inAutoEnvSync = false;
    }
  }

  private async executeEnvCookieSyncInternal(
    rt: LoadedSpaceRuntime,
    input: ExecuteEnvSyncInput,
    persistAfter: boolean,
  ): Promise<EnvCookieSyncResult> {
    const nowMs = this.now();
    let matchedRule: EnvCookieSyncRule | undefined;

    if (input.ruleId) {
      matchedRule =
        (rt.meta.deviceEnvSyncRules ?? []).find((r) => r.id === input.ruleId) ??
        (rt.meta.rules.envSyncRules ?? []).find((r) => r.id === input.ruleId);
      if (!matchedRule) {
        throw new Error(`未找到环境同步规则: ${input.ruleId}`);
      }
    } else if (!input.adHoc) {
      throw new Error('缺少环境同步配置参数 (ruleId 或 adHoc)');
    }

    const baseSourceSite = matchedRule ? matchedRule.sourceSiteKey : input.adHoc!.sourceSiteKey;
    const baseSourceHostFilter = matchedRule
      ? matchedRule.sourceHostFilter
      : input.adHoc!.sourceHostFilter;
    const baseSourceTrackId = matchedRule ? matchedRule.sourceTrackId : input.adHoc!.sourceTrackId;
    const baseTargetUrl = matchedRule ? matchedRule.targetUrl : input.adHoc!.targetUrl;

    const rawSource = input.reverse ? baseTargetUrl : baseSourceSite;
    // On reverse sync, target wildcard `.domain` unless user explicitly pinned a sourceHostFilter
    // or the source is a local/IP host, so cookies written back reach subdomains like app.example.com.
    const reverseTargetDefault =
      baseSourceHostFilter ||
      (isLocalOrSingleLabelHost(normalizeDomain(baseSourceSite))
        ? baseSourceSite
        : `.${normalizeDomain(baseSourceSite)}`);
    const rawTarget = input.reverse ? reverseTargetDefault : baseTargetUrl;
    const effectiveSourceHostFilter = input.reverse
      ? undefined
      : baseSourceHostFilter ||
        (() => {
          const rawHost = normalizeDomain(baseSourceSite);
          const resolvedKey =
            resolveSiteKey(baseSourceSite, rt.meta.rules.ssoGroups) || rawHost;
          return rawHost && rawHost !== resolvedKey ? rawHost : undefined;
        })();
    const effectiveSourceTrackId = input.reverse ? undefined : baseSourceTrackId;
    const destReverseTrackId = input.reverse ? baseSourceTrackId : undefined;

    const parsedSourceTarget = parseEnvTarget(rawSource);
    const srcHost = parsedSourceTarget?.host || normalizeDomain(rawSource);
    const srcSiteKey =
      resolveSiteKey(srcHost, rt.meta.rules.ssoGroups) || normalizeDomain(srcHost);
    if (!srcSiteKey) {
      throw new Error(`无效的源环境域名: ${rawSource}`);
    }

    const parsedTarget: ParsedEnvTarget | null = parseEnvTarget(rawTarget);
    if (!parsedTarget) {
      throw new Error(`无效的目标环境地址: ${rawTarget}`);
    }

    if (isBlockedWebdavSelfTarget(rt.webdav.url, parsedTarget)) {
      throw new Error('禁止覆盖当前 WebDAV 服务器自身域名的 Cookie');
    }

    // Block sensitive banking / password_manager / webdav_self blacklists on source (allow localhost preset;
    // for webdav_self, allow differing local/IP dev ports via isBlockedWebdavSelfTarget just like target check)
    const srcBl = rt.rulesEngine.isBlacklisted(srcHost || srcSiteKey);
    if (
      srcBl.blacklisted &&
      srcBl.entry?.presetCategory &&
      srcBl.entry.presetCategory !== 'localhost' &&
      srcBl.entry.presetCategory !== 'custom' &&
      !(
        srcBl.entry.presetCategory === 'webdav_self' &&
        parsedSourceTarget &&
        !isBlockedWebdavSelfTarget(rt.webdav.url, parsedSourceTarget)
      )
    ) {
      throw new Error(`源站点 "${srcSiteKey}" 属于受保护敏感黑名单 (${srcBl.entry.presetCategory})，禁止跨环境导出`);
    }

    const syncCookies = matchedRule
      ? matchedRule.syncCookies
      : (input.adHoc?.syncCookies ?? true);
    const syncLocalStorage = matchedRule
      ? matchedRule.syncLocalStorage
      : (input.adHoc?.syncLocalStorage ?? false);
    const adaptForHttp = matchedRule
      ? matchedRule.adaptForHttp
      : (input.adHoc?.adaptForHttp ?? true);
    // Safety guard: never wipe production/source cookies during reverse sync!
    const cleanTargetBeforeSync = input.reverse
      ? false
      : matchedRule
        ? matchedRule.cleanTargetBeforeSync
        : (input.adHoc?.cleanTargetBeforeSync ?? false);
    const autoReloadTarget = matchedRule
      ? matchedRule.autoReloadTarget
      : (input.adHoc?.autoReloadTarget ?? false);
    const includeCookieNames = matchedRule
      ? matchedRule.includeCookieNames
      : input.adHoc?.includeCookieNames;
    const excludeCookieNames = matchedRule
      ? matchedRule.excludeCookieNames
      : input.adHoc?.excludeCookieNames;

    const activeBoundTrackId = rt.meta.localDevice.siteBindings[srcSiteKey]?.trackId;
    const validPinnedTrackId =
      effectiveSourceTrackId && rt.tracks[effectiveSourceTrackId]
        ? effectiveSourceTrackId
        : undefined;
    const isPinnedBackgroundTrack = Boolean(
      validPinnedTrackId && validPinnedTrackId !== activeBoundTrackId,
    );
    const reverseDestSiteKey = input.reverse
      ? resolveSiteKey(baseSourceSite, rt.meta.rules.ssoGroups) || normalizeDomain(baseSourceSite)
      : '';
    const reverseDestActiveTrackId = reverseDestSiteKey
      ? rt.meta.localDevice.siteBindings[reverseDestSiteKey]?.trackId
      : undefined;
    const reverseTargetTrackId = input.reverse
      ? destReverseTrackId && rt.tracks[destReverseTrackId]
        ? destReverseTrackId
        : reverseDestActiveTrackId
      : undefined;
    const isPinnedInactiveReverseTarget = Boolean(
      input.reverse &&
        reverseTargetTrackId &&
        reverseTargetTrackId !== reverseDestActiveTrackId,
    );

    let appliedCookies = 0;
    let failedCookies = 0;
    let removedStaleCookies = 0;
    let appliedLocalStorage = 0;
    let skippedCookies = 0;
    let actuallyMutatedTarget = false;
    let pendingLsUpdated = false;
    let reverseMutatedManagedState = false;
    const errors: string[] = [];

    if (syncCookies) {
      const candidates: SourceCookieCandidate[] = [];

      if (isPinnedBackgroundTrack) {
        for (const rec of Object.values(rt.cookies)) {
          if (rec.trackId === effectiveSourceTrackId && !rec.deleted) {
            candidates.push({ cookie: rec, updatedAt: rec.updatedAt });
          }
        }
      } else {
        const fallbackTrackId =
          activeBoundTrackId ??
          Object.values(rt.tracks).find((t) => t.siteKey === srcSiteKey)?.trackId;
        if (fallbackTrackId) {
          for (const rec of Object.values(rt.cookies)) {
            if (rec.trackId === fallbackTrackId && !rec.deleted) {
              candidates.push({ cookie: rec, updatedAt: rec.updatedAt });
            }
          }
        }

        const allLiveCookies = await this.browser.getAllCookies();
        for (const bc of allLiveCookies) {
          const bcNorm = normalizeDomain(bc.domain);
          const matchesSrc =
            domainMatchesSiteKey(bc.domain, srcSiteKey, rt.meta.rules.ssoGroups) ||
            (srcHost && (bcNorm === srcHost || bcNorm.endsWith(`.${srcHost}`)));
          if (matchesSrc) {
            candidates.push({ cookie: bc, updatedAt: nowMs + 1 });
          }
        }
      }

      const selection = selectAndMapEnvCookies({
        candidates,
        target: parsedTarget,
        nowMs,
        adaptForHttp,
        filterNoise: rt.meta.space.settings.filterAnalyticsNoiseCookies,
        sourceHostFilter: effectiveSourceHostFilter,
        includeCookieNames,
        excludeCookieNames,
      });
      skippedCookies = selection.skipped;

      const excludeSet = new Set((excludeCookieNames ?? []).map((n) => n.trim()).filter(Boolean));

      // Never wipe target cookies if source and target share the exact same host (same cookie jar, e.g. localhost:3000 -> localhost:8080)
      if (cleanTargetBeforeSync && !isPinnedInactiveReverseTarget && srcHost !== parsedTarget.host) {
        const mappedKeys = new Set(
          selection.mapped.map(
            (mc) =>
              `${mc.hostOnly ? 'h' : 'd'}::${normalizeCookieDomain(mc.domain, mc.hostOnly)}::${mc.path || '/'}::${mc.name}`,
          ),
        );
        const existingTargetCookies = await this.browser.getAllCookies({
          domain: parsedTarget.host,
        });
        for (const tc of existingTargetCookies) {
          // Strict host scope check: getAllCookies({ domain: 'dev.example.com' }) also returns
          // child subdomains like 'api.dev.example.com'; never delete unrelated child-subdomain cookies!
          const tcHost = normalizeDomain(tc.domain);
          const inTargetScope = parsedTarget.explicitWildcardDomain
            ? tcHost === parsedTarget.host || tcHost.endsWith(`.${parsedTarget.host}`)
            : tcHost === parsedTarget.host;
          if (!inTargetScope) continue;
          if (excludeSet.has(tc.name)) continue;
          const tcKey = `${tc.hostOnly ? 'h' : 'd'}::${normalizeCookieDomain(tc.domain, tc.hostOnly)}::${tc.path || '/'}::${tc.name}`;
          if (!mappedKeys.has(tcKey)) {
            try {
              await this.removeExactBrowserCookie(tc, cookieContentCanonicalHash(tc), nowMs);
              removedStaleCookies += 1;
              actuallyMutatedTarget = true;
            } catch {
              // ignore removal error
            }
          }
        }
      }

      if (isPinnedInactiveReverseTarget && reverseTargetTrackId && reverseDestSiteKey) {
        for (const mc of selection.mapped) {
          const existingRec = Object.values(rt.cookies).find(
            (r) => r.trackId === reverseTargetTrackId && matchesCookieIdentity(r, mc),
          );
          const emitted = await this.emitLocalCookieUpsert(
            rt,
            reverseDestSiteKey,
            reverseTargetTrackId,
            mc,
            existingRec ? 'UPDATE' : 'CREATE',
          );
          if (emitted) {
            reverseMutatedManagedState = true;
          }
          appliedCookies += 1;
        }
      } else {
        for (const mc of selection.mapped) {
          const targetHash = cookieContentCanonicalHash(mc);
          const url = buildCookieUrl(mc);
          const existingInJar = await findExactBrowserCookie(this.browser, {
            url,
            domain: mc.domain,
            hostOnly: mc.hostOnly,
            path: mc.path || '/',
            name: mc.name,
            storeId: mc.storeId,
            partitionKey: mc.partitionKey,
          });

          if (existingInJar && cookieContentCanonicalHash(existingInJar) === targetHash) {
            if (input.reverse && reverseTargetTrackId && reverseDestSiteKey) {
              const existingRec = Object.values(rt.cookies).find(
                (r) => r.trackId === reverseTargetTrackId && matchesCookieIdentity(r, mc),
              );
              const emitted = await this.emitLocalCookieUpsert(
                rt,
                reverseDestSiteKey,
                reverseTargetTrackId,
                mc,
                existingRec ? 'UPDATE' : 'CREATE',
              );
              if (emitted) reverseMutatedManagedState = true;
            }
            appliedCookies += 1;
            continue;
          }

          this.echoSuppressor.registerCookieMutation(mc, 'set', targetHash, nowMs);
          const verification = await applyCookieWithVerification(this.browser, mc, nowMs);
          if (verification.accepted) {
            if (input.reverse && reverseTargetTrackId && reverseDestSiteKey) {
              const existingRec = Object.values(rt.cookies).find(
                (r) => r.trackId === reverseTargetTrackId && matchesCookieIdentity(r, mc),
              );
              const emitted = await this.emitLocalCookieUpsert(
                rt,
                reverseDestSiteKey,
                reverseTargetTrackId,
                mc,
                existingRec ? 'UPDATE' : 'CREATE',
              );
              if (emitted) reverseMutatedManagedState = true;
            }
            appliedCookies += 1;
            actuallyMutatedTarget = true;
          } else {
            failedCookies += 1;
            errors.push(`${mc.name}: ${verification.reason || '写入校验未通过'}`);
          }
        }
      }
    }

    if (syncLocalStorage) {
      const sourceLsMap = new Map<string, string>();
      const includeSet =
        includeCookieNames && includeCookieNames.length > 0
          ? new Set(includeCookieNames.map((n) => n.trim()).filter(Boolean))
          : null;
      const excludeSet = new Set((excludeCookieNames ?? []).map((n) => n.trim()).filter(Boolean));

      const originMatchesSourceLsFilter = (origin: string): boolean => {
        if (origin === parsedTarget.origin) return false;
        if (input.reverse && parsedSourceTarget?.port) {
          return origin === parsedSourceTarget.origin;
        }
        if (effectiveSourceHostFilter) {
          const origHost = normalizeDomain(origin);
          return (
            origHost === effectiveSourceHostFilter ||
            origHost.endsWith(`.${effectiveSourceHostFilter}`)
          );
        }
        return true;
      };

      if (isPinnedBackgroundTrack) {
        for (const rec of Object.values(rt.localStorage)) {
          if (
            rec.trackId === effectiveSourceTrackId &&
            !rec.deleted &&
            originMatchesSourceLsFilter(rec.origin)
          ) {
            sourceLsMap.set(rec.key, rec.value);
          }
        }
      } else {
        const fallbackTrackId =
          activeBoundTrackId ??
          Object.values(rt.tracks).find((t) => t.siteKey === srcSiteKey)?.trackId;
        if (fallbackTrackId) {
          for (const rec of Object.values(rt.localStorage)) {
            if (
              rec.trackId === fallbackTrackId &&
              !rec.deleted &&
              originMatchesSourceLsFilter(rec.origin)
            ) {
              sourceLsMap.set(rec.key, rec.value);
            }
          }
        }

        // Overlay live localStorage from open source tabs if available
        try {
          const tabs = await this.browser.queryTabs();
          const candidateOrigins = new Set<string>();
          if (parsedSourceTarget?.origin && input.reverse && originMatchesSourceLsFilter(parsedSourceTarget.origin)) {
            candidateOrigins.add(parsedSourceTarget.origin);
          }
          for (const tab of tabs) {
            const origin = tab.url ? normalizeOriginSafe(tab.url) : null;
            if (!origin || !originMatchesSourceLsFilter(origin)) continue;
            if (
              resolveSiteKey(origin, rt.meta.rules.ssoGroups) === srcSiteKey ||
              normalizeDomain(origin) === srcHost
            ) {
              candidateOrigins.add(origin);
            }
          }
          for (const origin of candidateOrigins) {
            const lsState = await this.browser.getLocalStorage(origin);
            if (lsState.available) {
              for (const [k, v] of Object.entries(lsState.items)) {
                sourceLsMap.set(k, v);
              }
            }
          }
        } catch {
          // ignore live tab LS errors
        }
      }

      const filteredEntries = Array.from(sourceLsMap.entries()).filter(([k]) => {
        if (includeSet && !includeSet.has(k)) return false;
        if (excludeSet.has(k)) return false;
        return true;
      });

      const targetLsOrigins = new Set<string>();
      try {
        const tabs = await this.browser.queryTabs();
        const baseTargetSiteKey =
          resolveSiteKey(parsedTarget.host, rt.meta.rules.ssoGroups) || parsedTarget.host;
        for (const tab of tabs) {
          const tabOrigin = tab.url ? normalizeOriginSafe(tab.url) : null;
          if (!tabOrigin || tabOrigin === parsedSourceTarget?.origin) continue;
          const parsedTab = parseEnvTarget(tabOrigin);
          if (!parsedTab) continue;
          const hostOk = parsedTarget.explicitWildcardDomain
            ? parsedTab.host === parsedTarget.host ||
              parsedTab.host.endsWith(`.${parsedTarget.host}`) ||
              (Boolean(input.reverse) &&
                !baseSourceHostFilter &&
                resolveSiteKey(parsedTab.host, rt.meta.rules.ssoGroups) === baseTargetSiteKey)
            : parsedTab.host === parsedTarget.host;
          const portOk = !parsedTarget.port || parsedTab.port === parsedTarget.port;
          if (hostOk && portOk) {
            targetLsOrigins.add(tabOrigin);
          }
        }
      } catch {
        // ignore tab query errors
      }
      if (targetLsOrigins.size === 0 && parsedTarget.origin !== parsedSourceTarget?.origin) {
        targetLsOrigins.add(parsedTarget.origin);
      }

      const succeededLsKeys = new Set<string>();
      if (isPinnedInactiveReverseTarget && reverseTargetTrackId && reverseDestSiteKey) {
        const inactiveDestOrigins = new Set<string>();
        for (const rec of Object.values(rt.localStorage)) {
          if (
            (rec.trackId === reverseTargetTrackId || rec.siteKey === reverseDestSiteKey) &&
            !rec.deleted
          ) {
            inactiveDestOrigins.add(rec.origin);
          }
        }
        if (inactiveDestOrigins.size === 0) {
          const fallbackHost = baseSourceHostFilter || reverseDestSiteKey;
          inactiveDestOrigins.add(
            isLocalOrSingleLabelHost(fallbackHost)
              ? `http://${fallbackHost}`
              : `https://${fallbackHost}`,
          );
        }
        for (const destOrigin of inactiveDestOrigins) {
          for (const [k, v] of filteredEntries) {
            const existingLs =
              rt.localStorage[buildLocalStorageLogicalId(reverseTargetTrackId, destOrigin, k)];
            const emitted = await this.emitLocalStorageUpsert(
              rt,
              reverseDestSiteKey,
              reverseTargetTrackId,
              destOrigin,
              k,
              v,
              existingLs && !existingLs.deleted ? 'UPDATE' : 'CREATE',
            );
            if (emitted) reverseMutatedManagedState = true;
            succeededLsKeys.add(k);
          }
        }
      } else {
        for (const targetOrigin of targetLsOrigins) {
          const targetLs = await this.browser.getLocalStorage(targetOrigin);
          if (!targetLs.available) {
            if (!input.reverse && (filteredEntries.length > 0 || cleanTargetBeforeSync)) {
              rt.meta.pendingEnvLsByOrigin = rt.meta.pendingEnvLsByOrigin ?? {};
              rt.meta.pendingEnvLsByOrigin[targetOrigin] = {
                items: Object.fromEntries(filteredEntries),
                cleanTargetBeforeSync,
                excludeKeys: Array.from(excludeSet),
                autoReloadTarget,
              };
              pendingLsUpdated = true;
            }
            continue;
          }

          if (rt.meta.pendingEnvLsByOrigin?.[targetOrigin]) {
            delete rt.meta.pendingEnvLsByOrigin[targetOrigin];
            pendingLsUpdated = true;
          }
          const lsApplyRes = await this.applyEnvLsEntriesToOpenOrigin(
            targetOrigin,
            targetLs.items,
            filteredEntries,
            cleanTargetBeforeSync,
            excludeSet,
            nowMs,
          );
          if (lsApplyRes.mutated) {
            actuallyMutatedTarget = true;
          }
          if (lsApplyRes.applied) {
            for (const [k, v] of filteredEntries) {
              if (input.reverse && reverseTargetTrackId && reverseDestSiteKey) {
                const existingLs =
                  rt.localStorage[buildLocalStorageLogicalId(reverseTargetTrackId, targetOrigin, k)];
                const emitted = await this.emitLocalStorageUpsert(
                  rt,
                  reverseDestSiteKey,
                  reverseTargetTrackId,
                  targetOrigin,
                  k,
                  v,
                  existingLs && !existingLs.deleted ? 'UPDATE' : 'CREATE',
                );
                if (emitted) reverseMutatedManagedState = true;
              }
              succeededLsKeys.add(k);
            }
          }
        }
      }
      appliedLocalStorage = succeededLsKeys.size;
    }

    let reloadedTabs = 0;
    if (autoReloadTarget && actuallyMutatedTarget && !isPinnedInactiveReverseTarget) {
      reloadedTabs = await this.reloadTabsForUserAction(rt, (tabUrl) => {
        const parsedTab = parseEnvTarget(tabUrl);
        if (!parsedTab) return false;
        const hostOk = parsedTarget.explicitWildcardDomain
          ? parsedTab.host === parsedTarget.host || parsedTab.host.endsWith(`.${parsedTarget.host}`)
          : parsedTab.host === parsedTarget.host;
        const portOk = !parsedTarget.port || parsedTab.port === parsedTarget.port;
        return hostOk && portOk;
      });
    }

    if (matchedRule) {
      matchedRule.lastSyncedAt = nowMs;
      matchedRule.lastSyncedCount = appliedCookies + appliedLocalStorage;
    }
    if (reverseMutatedManagedState) {
      rt.meta.space.status = this.computeStatus(rt);
    }
    if (persistAfter && (matchedRule || pendingLsUpdated || reverseMutatedManagedState)) {
      await this.persistRuntime(rt);
    }
    if (reverseMutatedManagedState && rt.meta.space.settings.autoSync) {
      await this.tryPushOutboundBestEffort(rt, 'env_reverse_sync_push');
    }

    return {
      ruleId: matchedRule?.id,
      sourceSiteKey: srcSiteKey,
      targetUrl: parsedTarget.origin,
      targetHost: parsedTarget.host,
      appliedCookies,
      failedCookies,
      removedStaleCookies,
      appliedLocalStorage,
      skippedCookies,
      reloadedTabs,
      errors,
    };
  }

  async importRulesJson(jsonOrObj: unknown): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const nowMs = this.now();
      const rawJson = typeof jsonOrObj === 'string' ? jsonOrObj : JSON.stringify(jsonOrObj);
      const parsed = RulesEngine.parseRulesJson(rawJson);

      if (parsed.spaceRules.spaceBlacklist) {
        rt.meta.rules.spaceBlacklist = parsed.spaceRules.spaceBlacklist;
      }
      if (parsed.spaceRules.siteOverrides) {
        rt.meta.rules.siteOverrides = parsed.spaceRules.siteOverrides;
      }
      if (parsed.spaceRules.ssoGroups) {
        rt.meta.rules.ssoGroups = parsed.spaceRules.ssoGroups;
      }
      if (parsed.spaceRules.envSyncRules) {
        const seenIds = new Set<string>();
        rt.meta.rules.envSyncRules = parsed.spaceRules.envSyncRules.filter((r) => {
          const pt = parseEnvTarget(r.targetUrl);
          if (!pt || isBlockedWebdavSelfTarget(rt.webdav.url, pt) || seenIds.has(r.id)) {
            return false;
          }
          seenIds.add(r.id);
          return true;
        });
      }
      if (parsed.deviceBlacklist && parsed.deviceBlacklist.length > 0) {
        rt.meta.deviceBlacklist = parsed.deviceBlacklist;
      }
      if (parsed.deviceEnvSyncRules && parsed.deviceEnvSyncRules.length > 0) {
        const seenDevIds = new Set<string>();
        rt.meta.deviceEnvSyncRules = parsed.deviceEnvSyncRules.filter((r) => {
          const pt = parseEnvTarget(r.targetUrl);
          if (!pt || isBlockedWebdavSelfTarget(rt.webdav.url, pt) || seenDevIds.has(r.id)) {
            return false;
          }
          seenDevIds.add(r.id);
          return true;
        });
      }
      rt.meta.rules.updatedAt = nowMs;
      this.syncRulesEngineState(rt);
      this.reconcileBlacklistBindings(rt);

      await this.updateRemoteSpaceMetaIfPossible(rt, (desc) => ({
        ...desc,
        rules: rt.meta.rules,
        updatedAt: nowMs,
      }));
      await this.uploadDeviceManifestIfOnline(rt);
      await this.persistRuntime(rt);
    });
  }

  async exportRulesJson(): Promise<string> {
    await this.ensureInitialized();
    const rt = this.requireRuntime();
    return rt.rulesEngine.exportRulesJson();
  }

  // =========================================================================
  // Devices, History, Conflicts & Safety Undo
  // =========================================================================

  async getDevices(): Promise<Device[]> {
    await this.ensureInitialized();
    const rt = this.runtime;
    if (!rt) return [];

    const map = new Map<string, Device>();
    for (const [id, dev] of Object.entries(rt.meta.remoteDevices)) {
      const ov = rt.meta.deviceOverrides[id];
      map.set(id, {
        ...dev,
        name: ov?.name ?? dev.name,
        state: ov?.state ?? dev.state,
      });
    }
    const localOv = rt.meta.deviceOverrides[rt.meta.localDevice.deviceId];
    map.set(rt.meta.localDevice.deviceId, {
      ...rt.meta.localDevice,
      name: localOv?.name ?? rt.meta.localDevice.name,
      state: localOv?.state ?? rt.meta.localDevice.state,
    });

    return Array.from(map.values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  async renameDevice(deviceId: string, name: string): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const trimmed = name.trim();
      if (!trimmed) throw new Error('Device name cannot be empty');

      const nowMs = this.now();
      if (deviceId === rt.meta.localDevice.deviceId) {
        rt.meta.localDevice.name = trimmed;
      } else if (rt.meta.remoteDevices[deviceId]) {
        rt.meta.remoteDevices[deviceId].name = trimmed;
      }
      rt.meta.deviceOverrides[deviceId] = {
        ...rt.meta.deviceOverrides[deviceId],
        name: trimmed,
        updatedAt: nowMs,
      };

      await this.uploadDeviceManifestIfOnline(rt);
      await this.persistRuntime(rt);
    });
  }

  async setDeviceState(
    deviceId: string,
    state: 'active' | 'paused' | 'removed' | 'revoked',
  ): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const nowMs = this.now();

      if (deviceId === rt.meta.localDevice.deviceId) {
        rt.meta.localDevice.state = state;
      } else if (rt.meta.remoteDevices[deviceId]) {
        rt.meta.remoteDevices[deviceId].state = state;
      }
      rt.meta.deviceOverrides[deviceId] = {
        ...rt.meta.deviceOverrides[deviceId],
        state,
        updatedAt: nowMs,
      };

      rt.meta.space.status = this.computeStatus(rt);
      await this.uploadDeviceManifestIfOnline(rt);
      await this.persistRuntime(rt);
    });
  }

  async getHistoryAndLogs(filter?: {
    siteKey?: string;
    objectId?: string;
    limit?: number;
  }): Promise<{ events: SyncEvent[]; logs: LogEntry[] }> {
    await this.ensureInitialized();
    const rt = this.runtime;
    if (!rt) return { events: [], logs: [] };

    let events = [...rt.eventsHistory].reverse();
    if (filter?.siteKey) {
      events = events.filter((e) => e.siteKey === filter.siteKey);
    }
    if (filter?.objectId) {
      events = events.filter((e) => e.objectId === filter.objectId);
    }
    if (filter?.limit && filter.limit > 0) {
      events = events.slice(0, filter.limit);
    }

    const logs = await this.logger.list({
      spaceId: rt.spaceId,
      siteKey: filter?.siteKey,
      limit: filter?.limit,
    });

    return { events, logs };
  }

  /**
   * D-009: Restores an older version by creating a NEW causal successor RESTORE event
   * (never rewrites history or rolls back vector clock).
   */
  async restoreHistoricalEvent(eventId: string): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const target = rt.eventsHistory.find((e) => e.eventId === eventId);
      if (!target) {
        throw new Error(`Historical event not found: ${eventId}`);
      }

      const nowMs = this.now();
      if (target.objectType === 'cookie' && target.cookieData) {
        const cookieInput: BrowserCookieInput = {
          domain: target.cookieData.domain,
          name: target.cookieData.name,
          value: target.cookieData.value,
          path: target.cookieData.path,
          secure: target.cookieData.secure,
          httpOnly: target.cookieData.httpOnly,
          sameSite: target.cookieData.sameSite,
          session: target.cookieData.session,
          expirationDate: target.cookieData.expirationDate,
          hostOnly: target.cookieData.hostOnly,
          storeId:
            target.cookieData.storeScope && target.cookieData.storeScope !== 'default'
              ? target.cookieData.storeScope
              : undefined,
          partitionKey: target.cookieData.partitionKey,
        };

        const existing = rt.cookies[target.objectId];
        const existingTomb = rt.tombstones[target.objectId];
        let forceVc = existing?.version.vectorClock ?? {};
        if (existingTomb) {
          forceVc = mergeVectorClocks(forceVc, existingTomb.deleteVersion.vectorClock);
        }

        const emitted = await this.emitLocalCookieUpsert(
          rt,
          target.siteKey,
          target.trackId,
          cookieInput,
          'RESTORE',
          forceVc,
        );
        if (emitted) {
          const hash = cookieContentCanonicalHash(emitted);
          this.changeDetector.discardCookieKey(buildEchoCookieKey(emitted));
          this.echoSuppressor.registerCookieMutation(emitted, 'set', hash, nowMs);
          const verification = await applyCookieWithVerification(this.browser, emitted, nowMs);
          emitted.applyResult = verification;
          if (verification.accepted) {
            rt.meta.appliedCookieHashes[emitted.logicalId] = hash;
          } else if (verification.expired) {
            emitted.syncStatus = 'EXPIRED';
          } else {
            emitted.syncStatus = 'APPLY_FAILED';
          }
        }
      } else if (target.objectType === 'localStorage' && target.localStorageData) {
        const existing = rt.localStorage[target.objectId];
        const existingTomb = rt.tombstones[target.objectId];
        let forceVc = existing?.version.vectorClock ?? {};
        if (existingTomb) {
          forceVc = mergeVectorClocks(forceVc, existingTomb.deleteVersion.vectorClock);
        }

        await this.emitLocalStorageUpsert(
          rt,
          target.siteKey,
          target.trackId,
          target.localStorageData.origin,
          target.localStorageData.key,
          target.localStorageData.value,
          'RESTORE',
          forceVc,
        );
        this.echoSuppressor.registerLocalStorageMutation(
          target.localStorageData.origin,
          target.localStorageData.key,
          'set',
          target.localStorageData.value,
          nowMs,
        );
        await this.browser.applyLocalStorage(target.localStorageData.origin, [
          { key: target.localStorageData.key, value: target.localStorageData.value },
        ]);
      }

      await this.persistRuntime(rt);
      if (rt.meta.space.settings.autoSync) {
        await this.tryPushOutboundBestEffort(rt, 'restore_historical_event');
        rt.meta.space.status = this.computeStatus(rt);
        await this.persistRuntime(rt);
      }
    });
  }

  async getConflicts(): Promise<ConflictRecord[]> {
    await this.ensureInitialized();
    const rt = this.runtime;
    if (!rt) return [];
    return Object.values(rt.conflicts).sort((a, b) => b.detectedAt - a.detectedAt);
  }

  async resolveConflict(conflictId: string, choose: 'local' | 'remote'): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const conflict = rt.conflicts[conflictId];
      if (!conflict) {
        throw new Error(`Conflict not found: ${conflictId}`);
      }

      const nowMs = this.now();
      const chosen = choose === 'local' ? conflict.localRecord : conflict.remoteRecord;
      const mergedVc = mergeVectorClocks(
        conflict.localRecord.version.vectorClock,
        conflict.remoteRecord.version.vectorClock,
      );

      if (conflict.objectType === 'cookie') {
        const rec = chosen as CookieRecord;
        const cookieInput: BrowserCookieInput = {
          domain: rec.domain,
          name: rec.name,
          value: rec.value,
          path: rec.path,
          secure: rec.secure,
          httpOnly: rec.httpOnly,
          sameSite: rec.sameSite,
          session: rec.session,
          expirationDate: rec.expirationDate,
          hostOnly: rec.hostOnly,
          storeId: rec.storeScope && rec.storeScope !== 'default' ? rec.storeScope : undefined,
          partitionKey: rec.partitionKey,
        };
        const emitted = await this.emitLocalCookieUpsert(
          rt,
          conflict.siteKey,
          conflict.trackId,
          cookieInput,
          'RESTORE',
          mergedVc,
        );
        if (emitted) {
          const hash = cookieContentCanonicalHash(emitted);
          this.changeDetector.discardCookieKey(buildEchoCookieKey(emitted));
          this.echoSuppressor.registerCookieMutation(emitted, 'set', hash, nowMs);
          const verification = await applyCookieWithVerification(this.browser, emitted, nowMs);
          emitted.applyResult = verification;
          if (verification.accepted) {
            rt.meta.appliedCookieHashes[emitted.logicalId] = hash;
          } else if (verification.expired) {
            emitted.syncStatus = 'EXPIRED';
          } else {
            emitted.syncStatus = 'APPLY_FAILED';
          }
          conflict.resolvedRecord = emitted;
        }
      } else {
        const rec = chosen as LocalStorageRecord;
        const emitted = await this.emitLocalStorageUpsert(
          rt,
          conflict.siteKey,
          conflict.trackId,
          rec.origin,
          rec.key,
          rec.value,
          'RESTORE',
          mergedVc,
        );
        if (emitted) {
          this.echoSuppressor.registerLocalStorageMutation(
            rec.origin,
            rec.key,
            'set',
            rec.value,
            nowMs,
          );
          await this.browser.applyLocalStorage(rec.origin, [{ key: rec.key, value: rec.value }]);
          conflict.resolvedRecord = emitted;
        }
      }

      conflict.winningSide = choose;
      conflict.resolved = true;
      conflict.resolvedBy = 'user';

      rt.meta.space.status = this.computeStatus(rt);
      await this.persistRuntime(rt);
      if (rt.meta.space.settings.autoSync) {
        await this.tryPushOutboundBestEffort(rt, 'resolve_conflict');
        rt.meta.space.status = this.computeStatus(rt);
        await this.persistRuntime(rt);
      }
    });
  }

  async getUndoPoints(): Promise<SafetyUndoPoint[]> {
    await this.ensureInitialized();
    const rt = this.runtime;
    if (!rt) return [];
    return [...rt.undoPoints];
  }

  async applyUndoPoint(undoId: string): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const idx = rt.undoPoints.findIndex((u) => u.undoId === undoId);
      if (idx < 0) {
        throw new Error(`Undo point not found: ${undoId}`);
      }

      const point = rt.undoPoints[idx];
      const nowMs = this.now();

      // Restore previous binding FIRST so any browser cookie events fired during rollback
      // can NEVER be emitted onto the track we are rolling back from!
      const prevBoundTrackId = rt.meta.localDevice.siteBindings[point.siteKey]?.trackId;
      if (
        prevBoundTrackId &&
        prevBoundTrackId !== point.previousBinding?.trackId &&
        rt.tracks[prevBoundTrackId]
      ) {
        const oldTr = rt.tracks[prevBoundTrackId];
        oldTr.memberDeviceIds = oldTr.memberDeviceIds.filter(
          (id) => id !== rt.meta.localDevice.deviceId,
        );
        oldTr.updatedAt = Math.max(nowMs, oldTr.updatedAt + 1);
      }
      if (point.previousBinding) {
        if (point.previousBinding.trackId && !rt.tracks[point.previousBinding.trackId]) {
          // Guard against dangling trackId if the previous track was deleted before undo:
          // if other tracks still exist for this site, move to PENDING_CHOICE so the site
          // remains visible and the restored cookies are not overwritten; otherwise UNMANAGED.
          const remainingTracks = Object.values(rt.tracks).filter(
            (t) => t.siteKey === point.siteKey,
          );
          if (remainingTracks.length > 0) {
            const localLsCount = Object.values(point.localStorageByOrigin).reduce(
              (sum, obj) => sum + Object.keys(obj).length,
              0,
            );
            rt.meta.localDevice.siteBindings[point.siteKey] = {
              ...point.previousBinding,
              state: 'PENDING_CHOICE',
              trackId: undefined,
              availableTrackIds: remainingTracks.map((t) => t.trackId),
            };
            rt.pendingDecisions[point.siteKey] = {
              siteKey: point.siteKey,
              reason:
                remainingTracks.length > 1 ? 'multiple_remote_tracks' : 'both_sides_have_data',
              hasLocalData: point.cookies.length > 0 || localLsCount > 0,
              localCookieCount: point.cookies.length,
              localLocalStorageCount: localLsCount,
              remoteTracks: remainingTracks,
              detectedAt: nowMs,
            };
          } else {
            rt.meta.localDevice.siteBindings[point.siteKey] = {
              ...point.previousBinding,
              state: 'UNMANAGED',
              trackId: undefined,
            };
          }
        } else {
          rt.meta.localDevice.siteBindings[point.siteKey] = { ...point.previousBinding };
        }
        if (point.previousBinding.state === 'PENDING_CHOICE') {
          const remoteTracks = Object.values(rt.tracks).filter((t) => t.siteKey === point.siteKey);
          if (remoteTracks.length > 0) {
            const localLsCount = Object.values(point.localStorageByOrigin).reduce(
              (sum, obj) => sum + Object.keys(obj).length,
              0,
            );
            rt.pendingDecisions[point.siteKey] = {
              siteKey: point.siteKey,
              reason: remoteTracks.length > 1 ? 'multiple_remote_tracks' : 'both_sides_have_data',
              hasLocalData: point.cookies.length > 0 || localLsCount > 0,
              localCookieCount: point.cookies.length,
              localLocalStorageCount: localLsCount,
              remoteTracks,
              detectedAt: nowMs,
            };
          }
        }
      } else {
        delete rt.meta.localDevice.siteBindings[point.siteKey];
      }

      // Discard any stale debounced cookie events for this site before rolling back
      this.changeDetector.discardWhere((c) =>
        domainMatchesSiteKey(c.domain, point.siteKey, rt.meta.rules.ssoGroups),
      );

      // Remove current browser cookies for point.siteKey
      const currentCookies = await this.browser.getAllCookies();
      for (const bc of currentCookies) {
        if (!domainMatchesSiteKey(bc.domain, point.siteKey, rt.meta.rules.ssoGroups)) continue;
        this.echoSuppressor.registerCookieMutation(
          bc,
          'remove',
          cookieContentCanonicalHash(bc),
          nowMs,
        );
        await this.browser.removeCookie({
          url: buildCookieUrl(bc),
          name: bc.name,
          storeId: bc.storeId,
          partitionKey: bc.partitionKey,
        });
      }

      // Restore snapshotted cookies
      for (const c of point.cookies) {
        this.echoSuppressor.registerCookieMutation(c, 'set', cookieContentCanonicalHash(c), nowMs);
        await applyCookieWithVerification(this.browser, c, nowMs);
      }

      // Clear any deferred clean-switch marker for this site before restoring the undo point
      if (rt.meta.pendingCleanLsBySite?.[point.siteKey]) {
        delete rt.meta.pendingCleanLsBySite[point.siteKey];
      }

      // Restore snapshotted LocalStorage (including clearing stale LS on open & closed origins)
      const lsTargets = new Map<string, Record<string, string>>(
        Object.entries(point.localStorageByOrigin),
      );
      for (const lsRec of Object.values(rt.localStorage)) {
        if (lsRec.siteKey === point.siteKey && !lsTargets.has(lsRec.origin)) {
          lsTargets.set(lsRec.origin, {});
        }
      }
      try {
        const tabs = await this.browser.queryTabs();
        for (const tab of tabs) {
          const origin = tab.url ? normalizeOriginSafe(tab.url) : null;
          if (
            origin &&
            resolveSiteKey(origin, rt.meta.rules.ssoGroups) === point.siteKey &&
            !lsTargets.has(origin)
          ) {
            lsTargets.set(origin, {});
          }
        }
      } catch {
        // ignore tab query errors
      }
      let changedOpenLs = false;
      for (const [origin, items] of lsTargets.entries()) {
        const currentLs = await this.browser.getLocalStorage(origin);
        if (!currentLs.available) {
          rt.meta.pendingEnvLsByOrigin = rt.meta.pendingEnvLsByOrigin ?? {};
          rt.meta.pendingEnvLsByOrigin[origin] = {
            items: { ...items },
            cleanTargetBeforeSync: true,
            excludeKeys: [],
            autoReloadTarget: true,
          };
          continue;
        }
        if (rt.meta.pendingEnvLsByOrigin?.[origin]) {
          delete rt.meta.pendingEnvLsByOrigin[origin];
        }
        const applyRes = await this.applyEnvLsEntriesToOpenOrigin(
          origin,
          currentLs.items,
          Object.entries(items),
          true,
          new Set(),
          nowMs,
        );
        if (applyRes.mutated) {
          changedOpenLs = true;
        }
      }

      rt.undoPoints.splice(idx, 1);

      const sitePolicy = this.getEffectivePolicyForDevice(rt, point.siteKey, point.siteKey);
      const versionDigest = await sha256Hex(`undo:${point.undoId}:${nowMs}`);
      const refreshRes = await this.autoRefresh.notifyAppliedChanges({
        siteKey: point.siteKey,
        versionDigest,
        autoRefreshEnabled: sitePolicy.autoRefresh && rt.meta.space.settings.autoRefresh,
        refreshProtectionEnabled: rt.meta.space.settings.refreshProtection,
        immediate: this.refreshCoalesceMs <= 0,
      });
      if (
        !(sitePolicy.autoRefresh && rt.meta.space.settings.autoRefresh) &&
        refreshRes.reloadedTabIds.length === 0 &&
        (changedOpenLs || point.cookies.length > 0 || currentCookies.some((c) => domainMatchesSiteKey(c.domain, point.siteKey, rt.meta.rules.ssoGroups)))
      ) {
        const reloaded = await this.reloadTabsForUserAction(rt, this.siteTabMatcher(rt, point.siteKey));
        if (reloaded > 0) {
          this.postReloadPushMuteUntil.set(point.siteKey, this.now() + 12_000);
        }
      }

      rt.meta.space.status = this.computeStatus(rt);
      await this.uploadDeviceManifestIfOnline(rt);
      await this.persistRuntime(rt);
    });
  }

  // =========================================================================
  // WebDAV Maintenance, Integrity, Snapshots, GC & Backups
  // =========================================================================

  async listRemoteDir(subPath?: string): Promise<WebDAVResourceStat[]> {
    await this.ensureInitialized();
    const rt = this.requireRuntime();
    const base = spaceBasePath(rt.meta.space.opaqueId);
    const target = subPath ? `${base}/${subPath.replace(/^\/+/, '')}` : base;
    const targetNorm = target.replace(/^\/+|\/+$/g, '');
    const entries = await rt.client.propfind(target, 1);
    return entries.filter((entry) => {
      const entryNorm = entry.path.replace(/^\/+|\/+$/g, '');
      return Boolean(entryNorm) && entryNorm !== targetNorm && !entryNorm.endsWith(`/${targetNorm}`);
    });
  }

  async checkIntegrity(): Promise<IntegrityReport> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const checkedAt = this.now();
      const corruptedPaths: string[] = [];
      const missingSeqGaps: string[] = [];
      const details: string[] = [];

      // 1. Check space.enc
      let spaceMetadataOk = false;
      const metaPath = spaceMetaPath(rt.meta.space.opaqueId);
      try {
        const fetched = await rt.client.getBytes(metaPath);
        if (!isSmesEnvelope(fetched.bytes)) {
          throw new Error('Invalid SMES header');
        }
        if (rt.encryptionPassword) {
          const desc = await decryptWithPassword<SpaceDescriptorPayload>(
            fetched.bytes,
            rt.encryptionPassword,
            buildSpaceMetaAad(rt.spaceId, metaPath),
          );
          if (desc.verifier !== 'SESSIONMESH_SPACE_OK') {
            throw new Error('Space verifier mismatch');
          }
        }
        spaceMetadataOk = true;
      } catch (err) {
        corruptedPaths.push(metaPath);
        details.push(`Space metadata error: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 2. Check devices/*.enc
      let deviceFilesCount = 0;
      const devIds: string[] = [];
      try {
        const stats = await rt.client.propfind(devicesDir(rt.meta.space.opaqueId), 1);
        for (const s of stats) {
          if (s.isCollection) continue;
          const name = s.name || extractFilename(s.path);
          if (!name.endsWith('.enc')) continue;
          deviceFilesCount += 1;
          const devId = name.slice(0, -4);
          devIds.push(devId);
          const p = deviceFilePath(rt.meta.space.opaqueId, devId);
          try {
            const fetched = await rt.client.getBytes(p);
            const { header } = await decryptWithDek(fetched.bytes, rt.dekKeyring, `${rt.spaceId}|`);
            if (header.aad !== buildFileAad(rt.spaceId, header.keyEpoch, 'device', p)) {
              throw new Error('AAD mismatch');
            }
          } catch (err) {
            corruptedPaths.push(p);
            details.push(`Corrupted device file ${p}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        details.push(`Failed listing devices: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 3. Check events/{devId}/*.enc & sequence gaps
      let eventFilesCount = 0;
      for (const devId of devIds) {
        const dir = deviceEventsDir(rt.meta.space.opaqueId, devId);
        try {
          const stats = await rt.client.propfind(dir, 1);
          const files = stats
            .filter((s) => !s.isCollection && (s.name || extractFilename(s.path)).endsWith('.enc'))
            .sort((a, b) => {
              const na = a.name || extractFilename(a.path);
              const nb = b.name || extractFilename(b.path);
              return parseEventFilenameSeq(na) - parseEventFilenameSeq(nb);
            });

          let prevToSeq = 0;
          for (const s of files) {
            const name = s.name || extractFilename(s.path);
            const p = `${dir}/${name}`;
            eventFilesCount += 1;
            try {
              const fetched = await rt.client.getBytes(p);
              const { data: batch, header } = await decryptWithDek<EventBatch>(
                fetched.bytes,
                rt.dekKeyring,
                `${rt.spaceId}|`,
              );
              if (header.aad !== buildFileAad(rt.spaceId, header.keyEpoch, 'event_batch', p)) {
                throw new Error('AAD mismatch');
              }
              if (prevToSeq > 0 && batch.fromSeq > prevToSeq + 1) {
                const isLocalDeferredOnly =
                  devId === rt.meta.localDevice.deviceId &&
                  rt.pendingOutboundEvents.some(
                    (pe) => pe.deviceSeq > prevToSeq && pe.deviceSeq < batch.fromSeq,
                  );
                if (!isLocalDeferredOnly) {
                  missingSeqGaps.push(`${devId}:${prevToSeq + 1}..${batch.fromSeq - 1}`);
                }
              }
              prevToSeq = Math.max(prevToSeq, batch.toSeq);
            } catch (err) {
              corruptedPaths.push(p);
              details.push(`Corrupted event batch ${p}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } catch {
          // Device may have no event files yet
        }
      }

      // 4. Check snapshots/*.enc
      let snapshotFilesCount = 0;
      try {
        const stats = await rt.client.propfind(snapshotsDir(rt.meta.space.opaqueId), 1);
        for (const s of stats) {
          if (s.isCollection) continue;
          const name = s.name || extractFilename(s.path);
          if (!name.endsWith('.enc')) continue;
          snapshotFilesCount += 1;
          const p = snapshotFilePath(rt.meta.space.opaqueId, name);
          try {
            const fetched = await rt.client.getBytes(p);
            const { header } = await decryptWithDek(fetched.bytes, rt.dekKeyring, `${rt.spaceId}|`);
            if (header.aad !== buildFileAad(rt.spaceId, header.keyEpoch, 'snapshot', p)) {
              throw new Error('AAD mismatch');
            }
          } catch (err) {
            corruptedPaths.push(p);
            details.push(`Corrupted snapshot ${p}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch {
        // Snapshots dir might be empty
      }

      rt.meta.corruptedPaths = [...corruptedPaths];
      await this.persistRuntime(rt);

      return {
        checkedAt,
        ok: spaceMetadataOk && corruptedPaths.length === 0 && missingSeqGaps.length === 0,
        spaceMetadataOk,
        deviceFilesCount,
        eventFilesCount,
        snapshotFilesCount,
        corruptedPaths,
        missingSeqGaps,
        details,
      };
    });
  }

  async rebuildIndex(): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const nowMs = this.now();
      const localDevId = rt.meta.localDevice.deviceId;
      const boundTrackIds = new Set(
        Object.values(rt.meta.localDevice.siteBindings)
          .map((b) => b.trackId)
          .filter((id): id is string => Boolean(id)),
      );
      const pendingTrackIds = new Set(rt.pendingOutboundEvents.map((ev) => ev.trackId));
      const preservedLocalTracks = Object.values(rt.tracks)
        .filter(
          (tr) =>
            boundTrackIds.has(tr.trackId) ||
            pendingTrackIds.has(tr.trackId) ||
            tr.memberDeviceIds.includes(localDevId),
        )
        .map((tr) => ({ ...tr, memberDeviceIds: [...tr.memberDeviceIds] }));
      const pendingEventsSnapshot = [...rt.pendingOutboundEvents].sort(
        (a, b) => a.deviceSeq - b.deviceSeq,
      );

      rt.meta.peerDeviceEtags = {};
      rt.meta.processedEventPaths = {};
      rt.meta.corruptedPaths = [];
      rt.meta.dismissedCorruptedPaths = {};
      rt.cookies = {};
      rt.localStorage = {};
      rt.tombstones = {};
      rt.tracks = {};
      rt.conflicts = {};

      await this.loadLatestSnapshotIfAvailable(rt);

      // Replay our own remote events as well so nothing is lost on rebuild
      await this.replayDeviceEvents(rt, rt.meta.localDevice.deviceId);

      // Re-integrate unpushed local tracks & pending outbound mutations before pulling remote
      for (const tr of preservedLocalTracks) {
        this.mergeRemoteTrack(rt, tr.trackId, tr);
      }
      for (const ev of pendingEventsSnapshot) {
        this.integrateRemoteEvent(rt, ev, nowMs, {
          recordHistory: false,
          defaultSyncStatus: 'LOCAL_NEWER',
        });
      }

      await this.pullRemoteInternal(rt, { applyToBrowser: true });

      rt.meta.localDevice.pendingEvents = rt.pendingOutboundEvents.length;
      rt.meta.space.status = this.computeStatus(rt);
      await this.persistRuntime(rt);
    });
  }

  private async replayDeviceEvents(rt: LoadedSpaceRuntime, devId: string): Promise<void> {
    const dir = deviceEventsDir(rt.meta.space.opaqueId, devId);
    let stats: WebDAVResourceStat[] = [];
    try {
      stats = await rt.client.propfind(dir, 1);
    } catch {
      return;
    }

    const files = stats
      .filter((s) => !s.isCollection && (s.name || extractFilename(s.path)).endsWith('.enc'))
      .sort((a, b) => {
        const na = a.name || extractFilename(a.path);
        const nb = b.name || extractFilename(b.path);
        const seqDiff = parseEventFilenameSeq(na) - parseEventFilenameSeq(nb);
        return seqDiff !== 0 ? seqDiff : na.localeCompare(nb);
      });

    const nowMs = this.now();
    for (const s of files) {
      const name = s.name || extractFilename(s.path);
      const p = `${dir}/${name}`;
      try {
        const fetched = await rt.client.getBytes(p);
        const { data: batch, header } = await decryptWithDek<EventBatch>(
          fetched.bytes,
          rt.dekKeyring,
          `${rt.spaceId}|`,
        );
        if (header.aad !== buildFileAad(rt.spaceId, header.keyEpoch, 'event_batch', p)) {
          throw new Error(`AAD mismatch on ${p}`);
        }
        if (batch.tracksDelta) {
          for (const tr of batch.tracksDelta) {
            this.mergeRemoteTrack(rt, tr.trackId, tr);
          }
        }
        for (const ev of batch.events) {
          this.integrateRemoteEvent(rt, ev, nowMs);
        }
        rt.meta.processedEventPaths[p] = true;
      } catch (err) {
        this.recordCorruptedPath(rt, p, err, nowMs);
      }
    }
  }

  private async loadLatestSnapshotIfAvailable(rt: LoadedSpaceRuntime): Promise<boolean> {
    const dir = snapshotsDir(rt.meta.space.opaqueId);
    let stats: WebDAVResourceStat[] = [];
    try {
      stats = await rt.client.propfind(dir, 1);
    } catch {
      return false;
    }

    const snapFiles = stats
      .filter((s) => !s.isCollection && (s.name || extractFilename(s.path)).endsWith('.enc'))
      .sort((a, b) => (b.name || extractFilename(b.path)).localeCompare(a.name || extractFilename(a.path)));

    for (const s of snapFiles) {
      const name = s.name || extractFilename(s.path);
      const p = snapshotFilePath(rt.meta.space.opaqueId, name);
      try {
        const fetched = await rt.client.getBytes(p);
        const { data: snap, header } = await decryptWithDek<SnapshotPayload>(
          fetched.bytes,
          rt.dekKeyring,
          `${rt.spaceId}|`,
        );
        if (header.aad !== buildFileAad(rt.spaceId, header.keyEpoch, 'snapshot', p)) {
          throw new Error('Snapshot AAD mismatch');
        }
        Object.assign(rt.tracks, snap.tracks ?? {});
        Object.assign(rt.cookies, snap.cookies ?? {});
        Object.assign(rt.localStorage, snap.localStorage ?? {});
        Object.assign(rt.tombstones, snap.tombstones ?? {});
        if (snap.rules && snap.rules.updatedAt > rt.meta.rules.updatedAt) {
          rt.meta.rules = { ...snap.rules, envSyncRules: snap.rules.envSyncRules ?? [] };
          this.syncRulesEngineState(rt);
        }
        rt.meta.localDevice.checkpoint.processedVectorClock = mergeVectorClocks(
          rt.meta.localDevice.checkpoint.processedVectorClock,
          snap.coveredVectorClock ?? {},
        );
        rt.meta.localDevice.checkpoint.lastSnapshotId = snap.snapshotId;
        rt.meta.lastSnapshotId = snap.snapshotId;
        return true;
      } catch (err) {
        this.recordCorruptedPath(rt, p, err, this.now());
      }
    }
    return false;
  }

  async createSnapshot(): Promise<{ snapshotId: string }> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const dek = this.getCurrentDek(rt);
      const nowMs = this.now();
      const snapshotId = `snap_${String(nowMs).padStart(14, '0')}_${bytesToHex(generateRandomBytes(4))}`;

      const payload: SnapshotPayload = {
        snapshotId,
        spaceId: rt.spaceId,
        createdAt: nowMs,
        createdByDevice: rt.meta.localDevice.deviceId,
        coveredVectorClock: { ...rt.meta.localDevice.checkpoint.processedVectorClock },
        cookies: { ...rt.cookies },
        localStorage: { ...rt.localStorage },
        tombstones: { ...rt.tombstones },
        tracks: { ...rt.tracks },
        rules: { ...rt.meta.rules },
      };

      const p = snapshotFilePath(rt.meta.space.opaqueId, snapshotId);
      const aad = buildFileAad(rt.spaceId, rt.meta.space.keyEpoch, 'snapshot', p);
      const encrypted = await encryptWithDek(payload, dek, rt.meta.space.keyEpoch, aad, {
        compress: rt.meta.space.settings.compression,
        encoding: rt.meta.space.settings.payloadEncoding,
      });

      await rt.client.putBytes(p, encrypted, {
        ifNoneMatchStar: true,
        contentType: 'application/octet-stream',
      });

      rt.meta.lastSnapshotId = snapshotId;
      rt.meta.localDevice.checkpoint.lastSnapshotId = snapshotId;
      await this.uploadCheckpoint(rt);
      await this.persistRuntime(rt);

      return { snapshotId };
    });
  }

  async garbageCollectHistory(): Promise<{
    removedEventFiles: number;
    reclaimedTombstones: number;
  }> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const nowMs = this.now();

      // Load all checkpoints
      const checkpoints: Record<string, DeviceCheckpoint> = {
        [rt.meta.localDevice.deviceId]: rt.meta.localDevice.checkpoint,
      };
      try {
        const chkStats = await rt.client.propfind(checkpointsDir(rt.meta.space.opaqueId), 1);
        for (const s of chkStats) {
          if (s.isCollection) continue;
          const name = s.name || extractFilename(s.path);
          if (!name.endsWith('.enc')) continue;
          const devId = name.slice(0, -4);
          const p = checkpointFilePath(rt.meta.space.opaqueId, devId);
          try {
            const fetched = await rt.client.getBytes(p);
            const { data } = await decryptWithDek<DeviceCheckpoint>(
              fetched.bytes,
              rt.dekKeyring,
              `${rt.spaceId}|`,
            );
            checkpoints[devId] = data;
          } catch {
            // Skip unreadable checkpoint
          }
        }
      } catch {
        // ignore
      }

      const allDevices = await this.getDevices();
      const activeDeviceIds = allDevices
        .filter((d) => d.state === 'active' || d.state === 'paused')
        .map((d) => d.deviceId);

      // 1. Reclaim tombstones acknowledged by all active devices
      let reclaimedTombstones = 0;
      for (const [objId, tomb] of Object.entries(rt.tombstones)) {
        const updated = updateTombstoneReclaimability(tomb, activeDeviceIds, checkpoints, nowMs, 0);
        if (updated.reclaimable) {
          delete rt.tombstones[objId];
          if (rt.cookies[objId]?.deleted) delete rt.cookies[objId];
          if (rt.localStorage[objId]?.deleted) delete rt.localStorage[objId];
          reclaimedTombstones += 1;
        } else {
          rt.tombstones[objId] = updated;
        }
      }

      // 2. Remove old event files already covered by all active devices' checkpoints AND snapshot
      let removedEventFiles = 0;
      if (rt.meta.lastSnapshotId) {
        const minCoveredByDev: Record<string, number> = {};
        for (const devId of activeDeviceIds) {
          const seqs = activeDeviceIds.map((peer) => checkpoints[peer]?.processedVectorClock?.[devId] ?? 0);
          minCoveredByDev[devId] = seqs.length > 0 ? Math.min(...seqs) : 0;
        }

        for (const [devId, coveredSeq] of Object.entries(minCoveredByDev)) {
          if (coveredSeq <= 0) continue;
          const dir = deviceEventsDir(rt.meta.space.opaqueId, devId);
          try {
            const evStats = await rt.client.propfind(dir, 1);
            for (const s of evStats) {
              if (s.isCollection) continue;
              const name = s.name || extractFilename(s.path);
              if (!name.endsWith('.enc')) continue;
              const seq = parseEventFilenameSeq(name);
              if (seq > 0 && seq <= coveredSeq) {
                await rt.client.delete(`${dir}/${name}`);
                removedEventFiles += 1;
              }
            }
          } catch {
            // ignore
          }
        }
      }

      // Clear storageFullHalted if space was freed
      if (removedEventFiles > 0) {
        rt.meta.storageFullHalted = false;
      }

      await this.persistRuntime(rt);
      return { removedEventFiles, reclaimedTombstones };
    });
  }

  async createBackup(): Promise<{ backupId: string }> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const dek = this.getCurrentDek(rt);
      const nowMs = this.now();
      const backupId = `backup_${String(nowMs).padStart(14, '0')}_${bytesToHex(generateRandomBytes(4))}`;

      const payload: SnapshotPayload = {
        snapshotId: backupId,
        spaceId: rt.spaceId,
        createdAt: nowMs,
        createdByDevice: rt.meta.localDevice.deviceId,
        coveredVectorClock: { ...rt.meta.localDevice.checkpoint.processedVectorClock },
        cookies: { ...rt.cookies },
        localStorage: { ...rt.localStorage },
        tombstones: { ...rt.tombstones },
        tracks: { ...rt.tracks },
        rules: { ...rt.meta.rules },
      };

      const p = backupFilePath(rt.meta.space.opaqueId, backupId);
      const aad = buildFileAad(rt.spaceId, rt.meta.space.keyEpoch, 'backup', p);
      const encrypted = await encryptWithDek(payload, dek, rt.meta.space.keyEpoch, aad, {
        compress: rt.meta.space.settings.compression,
        encoding: rt.meta.space.settings.payloadEncoding,
      });

      await rt.client.putBytes(p, encrypted, {
        ifNoneMatchStar: true,
        contentType: 'application/octet-stream',
      });

      return { backupId };
    });
  }

  async listBackups(): Promise<WebDAVResourceStat[]> {
    await this.ensureInitialized();
    const rt = this.requireRuntime();
    try {
      const stats = await rt.client.propfind(backupsDir(rt.meta.space.opaqueId), 1);
      return stats
        .filter((s) => !s.isCollection && (s.name || extractFilename(s.path)).endsWith('.enc'))
        .sort((a, b) => (b.name || extractFilename(b.path)).localeCompare(a.name || extractFilename(a.path)));
    } catch (err) {
      const se = toStructuredError(err, 'list_backups');
      if (se.status === 404) return [];
      throw err;
    }
  }

  async restoreBackup(backupId: string): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const cleanId = backupId.endsWith('.enc') ? backupId.slice(0, -4) : backupId;
      const p = backupFilePath(rt.meta.space.opaqueId, cleanId);

      const fetched = await rt.client.getBytes(p);
      const { data: backup, header } = await decryptWithDek<SnapshotPayload>(
        fetched.bytes,
        rt.dekKeyring,
        `${rt.spaceId}|`,
      );
      if (header.aad !== buildFileAad(rt.spaceId, header.keyEpoch, 'backup', p)) {
        throw new Error('Backup AAD verification failed');
      }

      const affectedSites = new Set<string>();
      for (const tr of Object.values(backup.tracks ?? {})) affectedSites.add(tr.siteKey);
      for (const c of Object.values(backup.cookies ?? {})) affectedSites.add(c.siteKey);

      // Save SafetyUndoPoints before restoring backup!
      for (const siteKey of affectedSites) {
        await this.captureSafetyUndoPoint(rt, siteKey, `restore_backup:${cleanId}`);
      }

      // Restore tracks & rules (clearing removedTracks tombstones and bumping timestamps/revisions
      // so peer devices accept the resurrected tracks instead of re-deleting them!)
      const restoreNow = this.now();
      for (const [tid, tr] of Object.entries(backup.tracks ?? {})) {
        if (rt.meta.removedTracks) {
          delete rt.meta.removedTracks[tid];
        }
        rt.tracks[tid] = {
          ...tr,
          updatedAt: Math.max(restoreNow, tr.updatedAt + 1),
          revision: (tr.revision ?? 0) + 1,
        };
      }
      if (backup.rules) {
        rt.meta.rules = {
          ...backup.rules,
          envSyncRules: backup.rules.envSyncRules ?? [],
          updatedAt: restoreNow,
        };
        this.syncRulesEngineState(rt);
      }

      // Emit new causal successor RESTORE events for all live cookies in the backup
      const backupLiveCookieIds = new Set<string>();
      for (const c of Object.values(backup.cookies ?? {})) {
        if (c.deleted) continue;
        backupLiveCookieIds.add(c.logicalId);
        const existingVc = rt.cookies[c.logicalId]?.version.vectorClock;
        const tombVc = rt.tombstones[c.logicalId]?.deleteVersion.vectorClock;
        let forceVc = existingVc ?? {};
        if (tombVc) forceVc = mergeVectorClocks(forceVc, tombVc);

        await this.emitLocalCookieUpsert(
          rt,
          c.siteKey,
          c.trackId,
          {
            domain: c.domain,
            name: c.name,
            value: c.value,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            sameSite: c.sameSite,
            session: c.session,
            expirationDate: c.expirationDate,
            hostOnly: c.hostOnly,
            storeId: c.storeScope && c.storeScope !== 'default' ? c.storeScope : undefined,
            partitionKey: c.partitionKey,
          },
          'RESTORE',
          forceVc,
        );
      }

      // Delete cookies on affected sites that didn't exist in the backup
      for (const cur of Object.values(rt.cookies)) {
        if (!cur.deleted && affectedSites.has(cur.siteKey) && !backupLiveCookieIds.has(cur.logicalId)) {
          await this.emitLocalCookieDelete(rt, cur, 'explicit', 'restore_backup');
        }
      }

      // Restore LocalStorage records from backup
      for (const ls of Object.values(backup.localStorage ?? {})) {
        if (ls.deleted) continue;
        const existingVc = rt.localStorage[ls.logicalId]?.version.vectorClock;
        await this.emitLocalStorageUpsert(
          rt,
          ls.siteKey,
          ls.trackId,
          ls.origin,
          ls.key,
          ls.value,
          'RESTORE',
          existingVc,
        );
      }

      // Discard any stale debounced cookie events on affected sites before applying restored backup tracks
      this.changeDetector.discardWhere((c) =>
        affectedSites.has(resolveSiteKey(c.domain, rt.meta.rules.ssoGroups)),
      );

      // Apply restored tracks to local browser cleanly
      for (const siteKey of affectedSites) {
        const trackId =
          rt.meta.localDevice.siteBindings[siteKey]?.trackId ??
          Object.values(rt.tracks).find((t) => t.siteKey === siteKey)?.trackId;
        if (trackId) {
          rt.meta.localDevice.siteBindings[siteKey] = {
            siteKey,
            state: 'USER_BOUND',
            trackId,
            hasLocalBaseline: true,
            decidedAt: this.now(),
            decidedBy: 'user',
          };
          await this.applyTrackToBrowser(rt, siteKey, trackId, {
            cleanStale: true,
            triggerRefresh: true,
          });
        }
      }

      if (this.isOnline() && !rt.meta.storageFullHalted) {
        await this.pushOutboundInternal(rt);
      }
      await this.uploadDeviceManifestIfOnline(rt);
      await this.persistRuntime(rt);
    });
  }

  /**
   * Expose persisted retry tasks for diagnostics & acceptance testing (D-016).
   */
  async getRetryTasks(): Promise<SyncTask[]> {
    await this.ensureInitialized();
    const rt = this.runtime;
    if (!rt) return [];
    return [...rt.retryTasks];
  }
}

// Keep unused-import lint clean for compareVectorClocks if needed by callers
export { compareVectorClocks, normalizeDomain };
