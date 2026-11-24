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
  type AttentionItem,
  type BlacklistEntry,
  type BrowserApiAdapter,
  type BrowserCandidateSite,
  type BrowserCookieInput,
  type CapabilityReport,
  type ConflictRecord,
  type ConsistencyLevel,
  type CookieRecord,
  type DeleteScope,
  type Device,
  type DeviceCheckpoint,
  type DeviceSiteBinding,
  type DeviceStatus,
  type EventBatch,
  type HybridLogicalClock,
  type InitialJoinReport,
  type IntegrityReport,
  type LocalStorageRecord,
  type LogEntry,
  type PairingPayload,
  type PendingSiteDecision,
  type PerDeviceSyncPolicy,
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
} from './CookieApplyHelper';
import { buildEchoCookieKey, EchoSuppressor } from './EchoSuppressor';
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
  manifestDirty?: boolean;
  lastAutoPushAt?: number;
  autoPushBackoffUntilMs?: number;
  consecutiveTransientFailures?: number;
  appliedCookieHashes: Record<string, string>;
  appliedLsHashes: Record<string, string>;
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
    updatedAt: nowMs,
  };
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
          updatedAt: meta.rules?.updatedAt ?? this.now(),
        };
        meta.deviceBlacklist = meta.deviceBlacklist ?? [];
        meta.deviceOverrides = meta.deviceOverrides ?? {};
        meta.removedTracks = meta.removedTracks ?? {};
        meta.peerDeviceEtags = meta.peerDeviceEtags ?? {};
        meta.processedEventPaths = meta.processedEventPaths ?? {};
        meta.corruptedPaths = meta.corruptedPaths ?? [];
        meta.appliedCookieHashes = meta.appliedCookieHashes ?? {};
        meta.appliedLsHashes = meta.appliedLsHashes ?? {};
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
    meta.deviceOverrides = meta.deviceOverrides ?? {};
    meta.removedTracks = meta.removedTracks ?? {};
    meta.dismissedCorruptedPaths = meta.dismissedCorruptedPaths ?? {};
    meta.dismissedApplyFailures = meta.dismissedApplyFailures ?? {};
    meta.appliedCookieHashes = meta.appliedCookieHashes ?? {};
    meta.appliedLsHashes = meta.appliedLsHashes ?? {};

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
    const rulesEngine = new RulesEngine(meta.space.settings, meta.rules, meta.deviceBlacklist);
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
      if (canPush && rt.pendingOutboundEvents.length > 0 && this.isOnline() && !rt.meta.storageFullHalted) {
        await this.pushOutboundInternal(rt);
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
      if (params.spaceId.startsWith('sp_')) {
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
  }

  async switchSpace(spaceId: string, encryptionPassword?: string): Promise<void> {
    await this.ensureInitialized();
    if (!this.spaceIndex[spaceId]) {
      throw new Error(`Space "${spaceId}" does not exist locally`);
    }

    // Flush current space's buffered cookie changes before switching context (D-011)
    if (this.runtime && this.runtime.spaceId !== spaceId) {
      await this.changeDetector.flush();
      await this.persistRuntime(this.runtime);
    }

    this.echoSuppressor.clear();
    this.rollingTokenDamper.reset();

    const rt = await this.loadSpaceRuntime(spaceId, encryptionPassword);
    if (encryptionPassword) {
      await this.unlockSession(encryptionPassword, spaceId);
    } else {
      await this.storage.set(GLOBAL_NS, 'activeSpaceId', spaceId);
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
    const entry = this.spaceIndex[spaceId];
    if (!entry) throw new Error(`Space "${spaceId}" not found`);

    const trimmed = newName.trim();
    if (!trimmed) throw new Error('Space name cannot be empty');

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
  }

  async rotateSpacePassword(oldPassword: string, newPassword: string): Promise<void> {
    await this.ensureInitialized();
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
  }

  async deleteLocalSpace(spaceId: string, deleteRemote = false): Promise<void> {
    await this.ensureInitialized();
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
        await this.switchSpace(remainingIds[0]);
      } else {
        this.activeSpaceId = null;
        await this.storage.set(GLOBAL_NS, 'activeSpaceId', null);
        this.emitStateChange();
      }
    } else {
      this.emitStateChange();
    }
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
        const hostOnly = isHostPrefix ? true : cookie.hostOnly;
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

    const localDevPolicy = this.getLocalDevicePolicy(rt);
    if (localDevPolicy?.direction === 'disabled' || localDevPolicy?.direction === 'pull_only') {
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
        const effHostOnlyUp = isHostPrefixUp ? true : cookie.hostOnly;
        const effPathUp = isHostPrefixUp ? '/' : cookie.path || '/';
        const upsertLogicalId = buildCookieLogicalId({
          trackId,
          storeScope: cookie.storeId || 'default',
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
        const effectiveHostOnly = isHostPrefix ? true : cookie.hostOnly;
        const effectivePath = isHostPrefix ? '/' : cookie.path || '/';
        const logicalId = buildCookieLogicalId({
          trackId,
          storeScope: cookie.storeId || 'default',
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
        if (existing && !existing.deleted) {
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
    const normDomain = normalizeCookieDomain(cookie.domain, cookie.hostOnly);
    const path = cookie.name.startsWith('__Host-') ? '/' : cookie.path || '/';
    const hostOnly = cookie.name.startsWith('__Host-') ? true : cookie.hostOnly;
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

    for (const chunk of chunks) {
      const fromSeq = Math.min(...chunk.map((e) => e.deviceSeq));
      const toSeq = Math.max(...chunk.map((e) => e.deviceSeq));
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
    if (!this.isOnline() || rt.meta.storageFullHalted || !rt.dekKeyring[rt.meta.space.keyEpoch]) {
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
          rt.meta.rules = manifest.rulesDelta;
          rt.rulesEngine.update(rt.meta.space.settings, rt.meta.rules, rt.meta.deviceBlacklist);
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
      memberDeviceIds: mergedMembers,
      revision: Math.max(existing.revision ?? 0, peerTrack.revision ?? 0),
      updatedAt: Math.max(existing.updatedAt, peerTrack.updatedAt),
    };
  }

  private integrateRemoteEvent(
    rt: LoadedSpaceRuntime,
    ev: SyncEvent,
    nowMs: number,
  ): boolean {
    // Advance HLC monotonically on receive (S-014 clock skew resilience)
    rt.hlcClock.receive(ev.version.hlc, nowMs);

    // Avoid duplicating event in history
    if (!rt.eventsHistory.some((h) => h.eventId === ev.eventId)) {
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
          syncStatus: 'REMOTE_NEWER',
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
        syncStatus: 'REMOTE_NEWER',
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
      deleteReasonsByObject?: Map<string, string>;
    },
  ): Promise<{ appliedCookies: number; failedCookies: number; changedAny: boolean }> {
    const nowMs = this.now();
    const policy = this.getEffectivePolicyForDevice(rt, siteKey, siteKey);
    if (policy.excluded || policy.direction === 'disabled' || policy.direction === 'push_only') {
      return { appliedCookies: 0, failedCookies: 0, changedAny: false };
    }
    let appliedCookies = 0;
    let failedCookies = 0;
    const changedVersions: string[] = [];

    const trackCookies = Object.values(rt.cookies).filter((c) => c.trackId === trackId);
    const liveTrackCookies = trackCookies.filter((c) => !c.deleted);
    const deletedTrackCookies = trackCookies.filter((c) => c.deleted);

    // Clean Track Switch: remove stale browser cookies for siteKey not present in target track
    if (options.cleanStale && policy.syncCookies) {
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
    if (policy.syncCookies) {
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
    if (policy.syncLocalStorage) {
      const trackLs = Object.values(rt.localStorage).filter((l) => l.trackId === trackId);
      const byOrigin = new Map<string, LocalStorageRecord[]>();
      for (const l of trackLs) {
        const arr = byOrigin.get(l.origin) ?? [];
        arr.push(l);
        byOrigin.set(l.origin, arr);
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
          if (!res.applied) {
            for (const rec of records) {
              if (!rec.deleted) rec.contextAvailable = false;
            }
          }
        }
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

    return { appliedCookies, failedCookies, changedAny };
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

      if (!this.isSiteManagedOrRemotelyTracked(rt, siteKey)) return;

      const policy = this.getEffectivePolicyForDevice(rt, normOrigin, siteKey);
      const sitePolicy = this.getEffectivePolicyForDevice(rt, siteKey, siteKey);
      if (policy.excluded || sitePolicy.excluded || !sitePolicy.syncLocalStorage) return;
      if (sitePolicy.direction === 'disabled') return;

      let binding = rt.meta.localDevice.siteBindings[siteKey];
      if (
        binding?.state === 'BLACKLISTED' ||
        binding?.state === 'PENDING_CHOICE' ||
        binding?.state === 'UNMANAGED'
      ) {
        return;
      }

      if (!binding || !binding.trackId) {
        const remoteTracks = Object.values(rt.tracks).filter((t) => t.siteKey === siteKey);
        const itemCount = Object.keys(items).length;
        if (itemCount === 0 && remoteTracks.length === 0) return;
        if (remoteTracks.length === 0 && sitePolicy.direction === 'pull_only') return;

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
            return;
          }
        }
        if (decision.createdTrack) {
          rt.tracks[decision.createdTrack.trackId] = decision.createdTrack;
        }
      }

      const trackId = binding?.trackId;
      if (!trackId) return;

      // 1. Apply pending remote LocalStorage records & tombstones for this strict origin (D-008)
      const mutationsToApply: Array<{ key: string; value?: string; deleted?: boolean }> = [];
      let stateMutated = false;
      const remoteRecords = Object.values(rt.localStorage).filter(
        (r) => r.trackId === trackId && r.origin === normOrigin,
      );
      const handledKeys = new Set<string>();

      for (const rec of remoteRecords) {
        handledKeys.add(rec.key);
        if (rec.deleted) {
          if (
            policy.direction !== 'push_only' &&
            sitePolicy.direction !== 'push_only' &&
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
            policy.direction !== 'push_only' &&
            sitePolicy.direction !== 'push_only' &&
            (!hasOwnKey || currentLsVal !== rec.value) &&
            (rec.syncStatus === 'REMOTE_NEWER' || rec.syncStatus === 'REMOTE_ONLY' || !hasOwnKey)
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
      }

      // 2. Upload local-only keys if direction allows push
      let emittedAny = false;
      if (sitePolicy.direction !== 'pull_only') {
        for (const [key, value] of Object.entries(items)) {
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
    });
  }

  async ingestLocalStorageMutations(
    origin: string,
    changes: Array<{ key: string; value?: string; deleted?: boolean }>,
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

      if (!this.isSiteManagedOrRemotelyTracked(rt, siteKey)) return;

      const policy = this.getEffectivePolicyForDevice(rt, normOrigin, siteKey);
      const sitePolicy = this.getEffectivePolicyForDevice(rt, siteKey, siteKey);
      if (
        policy.excluded ||
        sitePolicy.excluded ||
        !sitePolicy.syncLocalStorage ||
        sitePolicy.direction === 'disabled' ||
        sitePolicy.direction === 'pull_only'
      ) {
        return;
      }

      let binding = rt.meta.localDevice.siteBindings[siteKey];
      if (
        binding?.state === 'BLACKLISTED' ||
        binding?.state === 'PENDING_CHOICE' ||
        binding?.state === 'UNMANAGED'
      ) {
        return;
      }

      if (!binding || !binding.trackId) {
        const remoteTracks = Object.values(rt.tracks).filter((t) => t.siteKey === siteKey);
        const decision = evaluateSiteDiscovery({
          siteKey,
          isBlacklisted: false,
          existingBinding: undefined,
          localCookies: [],
          localStorageCount: changes.filter((c) => !c.deleted).length,
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
              return;
            }
          } else {
            rt.pendingDecisions[siteKey] = decision.pendingDecision;
            await this.persistRuntime(rt);
            return;
          }
        }
        if (decision.createdTrack) {
          rt.tracks[decision.createdTrack.trackId] = decision.createdTrack;
        }
      }

      const trackId = binding?.trackId;
      if (!trackId) return;

      let emittedAny = false;
      for (const ch of changes) {
        const op = ch.deleted ? 'remove' : 'set';
        const val = ch.value ?? '';
        if (this.echoSuppressor.shouldSuppressLocalStorageEvent(normOrigin, ch.key, op, val, nowMs)) {
          continue;
        }

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
          const lid = buildCookieLogicalId({
            trackId: targetTrackId,
            storeScope: c.storeId || 'default',
            partitionKey: c.partitionKey,
            hostOnly: c.name.startsWith('__Host-') ? true : c.hostOnly,
            domain: normalizeCookieDomain(
              c.domain,
              c.name.startsWith('__Host-') ? true : c.hostOnly,
            ),
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
          const lid = buildCookieLogicalId({
            trackId: targetTrackId,
            storeScope: c.storeId || 'default',
            partitionKey: c.partitionKey,
            hostOnly: c.name.startsWith('__Host-') ? true : c.hostOnly,
            domain: normalizeCookieDomain(
              c.domain,
              c.name.startsWith('__Host-') ? true : c.hostOnly,
            ),
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
        if (canPush && this.isOnline() && !rt.meta.storageFullHalted) {
          await this.pushOutboundInternal(rt);
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
        if (canPush && this.isOnline() && !rt.meta.storageFullHalted) {
          await this.pushOutboundInternal(rt);
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

  async switchSiteTrack(siteKey: string, targetTrackId: string): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const targetTrack = rt.tracks[targetTrackId];
      if (!targetTrack || targetTrack.siteKey !== siteKey) {
        throw new Error(`Track "${targetTrackId}" does not exist for site "${siteKey}"`);
      }

      const nowMs = this.now();
      const prevBinding = rt.meta.localDevice.siteBindings[siteKey];

      // Save SafetyUndoPoint BEFORE Clean Track Switch!
      await this.captureSafetyUndoPoint(rt, siteKey, `switch_track:${targetTrackId}`);

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
      targetTrack.revision = (targetTrack.revision ?? 0) + 1;

      rt.meta.localDevice.siteBindings[siteKey] = {
        siteKey,
        state: 'USER_BOUND',
        trackId: targetTrackId,
        availableTrackIds: Object.values(rt.tracks)
          .filter((t) => t.siteKey === siteKey)
          .map((t) => t.trackId),
        hasLocalBaseline: true,
        decidedAt: nowMs,
        decidedBy: 'user',
      };
      delete rt.pendingDecisions[siteKey];

      // Discard stale debounced events for this site before switching tracks
      this.changeDetector.discardWhere((c) =>
        domainMatchesSiteKey(c.domain, siteKey, rt.meta.rules.ssoGroups),
      );

      // Clean Track Switch: wipe old cookies not in target track, then apply target track
      await this.applyTrackToBrowser(rt, siteKey, targetTrackId, {
        cleanStale: true,
        triggerRefresh: true,
      });

      await this.uploadDeviceManifestIfOnline(rt);
      await this.persistRuntime(rt);
    });
  }

  async splitSiteIndependent(siteKey: string, customLabel?: string): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const nowMs = this.now();
      const prevBinding = rt.meta.localDevice.siteBindings[siteKey];

      if (prevBinding?.trackId) {
        const oldTrack = rt.tracks[prevBinding.trackId];
        if (oldTrack) {
          oldTrack.memberDeviceIds = oldTrack.memberDeviceIds.filter(
            (id) => id !== rt.meta.localDevice.deviceId,
          );
          oldTrack.updatedAt = nowMs;
        }
      }

      const newTrackId = randomId('trk');
      const allLocalCookies = await this.browser.getAllCookies();
      const localSiteCookies = allLocalCookies.filter(
        (c) =>
          domainMatchesSiteKey(c.domain, siteKey, rt.meta.rules.ssoGroups) &&
          (!rt.meta.space.settings.filterAnalyticsNoiseCookies || !isAnalyticsNoiseCookie(c.name)),
      );

      const newTrack: SiteTrack = {
        trackId: newTrackId,
        siteKey,
        label: customLabel?.trim() || `${rt.meta.localDevice.name} 独立轨道`,
        originDeviceId: rt.meta.localDevice.deviceId,
        originDeviceName: rt.meta.localDevice.name,
        cookieCount: localSiteCookies.length,
        localStorageCount: 0,
        updatedAt: nowMs,
        memberDeviceIds: [rt.meta.localDevice.deviceId],
        revision: 1,
      };
      rt.tracks[newTrackId] = newTrack;

      rt.meta.localDevice.siteBindings[siteKey] = {
        siteKey,
        state: 'INDEPENDENT',
        trackId: newTrackId,
        availableTrackIds: Object.values(rt.tracks)
          .filter((t) => t.siteKey === siteKey)
          .map((t) => t.trackId),
        hasLocalBaseline: true,
        localCookieCount: localSiteCookies.length,
        decidedAt: nowMs,
        decidedBy: 'user',
      };
      delete rt.pendingDecisions[siteKey];

      for (const c of localSiteCookies) {
        await this.emitLocalCookieUpsert(rt, siteKey, newTrackId, c, 'CREATE');
      }

      if (this.isOnline() && !rt.meta.storageFullHalted) {
        await this.pushOutboundInternal(rt);
      }
      await this.uploadDeviceManifestIfOnline(rt);
      await this.persistRuntime(rt);
    });
  }

  async renameSiteTrack(siteKey: string, trackId: string, label: string): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const track = rt.tracks[trackId];
      if (!track || track.siteKey !== siteKey) {
        throw new Error(`Track "${trackId}" not found for site "${siteKey}"`);
      }
      const trimmed = label.trim();
      if (!trimmed) throw new Error('Track label cannot be empty');

      track.label = trimmed;
      track.updatedAt = this.now();
      track.revision = (track.revision ?? 0) + 1;

      await this.uploadDeviceManifestIfOnline(rt);
      await this.persistRuntime(rt);
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
      const allTracks = Object.values(rt.tracks).filter((t) => t.siteKey === siteKey);
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
      if (canPush && this.isOnline() && !rt.meta.storageFullHalted) {
        await this.pushOutboundInternal(rt);
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
      if (canPush && this.isOnline() && !rt.meta.storageFullHalted) {
        await this.pushOutboundInternal(rt);
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

  async upsertCookie(siteKey: string, cookie: BrowserCookieInput): Promise<CookieRecord> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const emitted = await this.upsertCookieInternal(rt, siteKey, cookie);

      rt.meta.space.status = this.computeStatus(rt);
      await this.persistRuntime(rt);
      if (rt.meta.space.settings.autoSync && this.isOnline() && !rt.meta.storageFullHalted) {
        await this.pushOutboundInternal(rt);
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
  ): Promise<CookieRecord> {
    const nowMs = this.now();
    const effectiveSiteKey = siteKey || resolveSiteKey(cookie.domain, rt.meta.rules.ssoGroups);

    let trackId = rt.meta.localDevice.siteBindings[effectiveSiteKey]?.trackId;
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

    // Apply to local browser with EchoSuppressor & read-back verification
    const hash = cookieContentCanonicalHash(cookie);
    this.changeDetector.discardCookieKey(buildEchoCookieKey(cookie));
    this.echoSuppressor.registerCookieMutation(cookie, 'set', hash, nowMs);
    const verification = await applyCookieWithVerification(this.browser, cookie, nowMs);

    const emitted =
      (await this.emitLocalCookieUpsert(rt, effectiveSiteKey, trackId, cookie, 'UPDATE')) ??
      rt.cookies[
        buildCookieLogicalId({
          trackId,
          storeScope: cookie.storeId || 'default',
          partitionKey: cookie.partitionKey,
          hostOnly: cookie.name.startsWith('__Host-') ? true : cookie.hostOnly,
          domain: normalizeCookieDomain(
            cookie.domain,
            cookie.name.startsWith('__Host-') ? true : cookie.hostOnly,
          ),
          path: cookie.name.startsWith('__Host-') ? '/' : cookie.path || '/',
          name: cookie.name,
        })
      ];

    emitted.applyResult = verification;
    if (verification.accepted) {
      if (rt.meta.dismissedApplyFailures) {
        delete rt.meta.dismissedApplyFailures[emitted.logicalId];
      }
    } else if (verification.expired) {
      emitted.syncStatus = 'EXPIRED';
    } else {
      emitted.syncStatus = 'APPLY_FAILED';
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

        if (scope === 'local_only') {
          await this.removeExactBrowserCookie(rec, cookieContentCanonicalHash(rec), nowMs);
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
          await this.removeExactBrowserCookie(rec, cookieContentCanonicalHash(rec), nowMs);
          await this.emitLocalCookieDelete(rt, rec, 'user_delete', 'all_devices');
          pushedNeeded = true;
        }
      }

      await this.persistRuntime(rt);
      if (pushedNeeded && rt.meta.space.settings.autoSync && this.isOnline() && !rt.meta.storageFullHalted) {
        await this.pushOutboundInternal(rt);
        await this.persistRuntime(rt);
      }
    });
  }

  async importCookiesJson(cookies: BrowserCookieInput[], siteKey?: string): Promise<number> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      let count = 0;
      for (const c of cookies) {
        const targetSite = siteKey || resolveSiteKey(c.domain, rt.meta.rules.ssoGroups);
        if (!targetSite) continue;
        await this.upsertCookieInternal(rt, targetSite, c);
        count += 1;
      }

      if (count > 0) {
        rt.meta.space.status = this.computeStatus(rt);
        await this.persistRuntime(rt);
        if (rt.meta.space.settings.autoSync && this.isOnline() && !rt.meta.storageFullHalted) {
          await this.pushOutboundInternal(rt);
          rt.meta.space.status = this.computeStatus(rt);
          await this.persistRuntime(rt);
        }
      }

      return count;
    });
  }

  async exportCookiesJson(siteKey?: string): Promise<BrowserCookieInput[]> {
    await this.ensureInitialized();
    const rt = this.runtime;
    if (!rt) return [];

    let records: CookieRecord[];
    if (siteKey) {
      records = await this.getSiteCookies(siteKey);
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
      storeId: c.storeScope,
      partitionKey: c.partitionKey,
    }));
  }

  async getLocalStorageRecords(filter?: {
    siteKey?: string;
    origin?: string;
  }): Promise<LocalStorageRecord[]> {
    await this.ensureInitialized();
    const rt = this.runtime;
    if (!rt) return [];

    return Object.values(rt.localStorage)
      .filter((r) => {
        if (r.deleted) return false;
        if (filter?.origin && r.origin !== filter.origin) return false;
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
  ): Promise<LocalStorageRecord> {
    await this.ensureInitialized();
    const normOrigin = normalizeOriginSafe(origin);
    if (!normOrigin) throw new Error(`Invalid origin: ${origin}`);

    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
      const nowMs = this.now();
      const siteKey = resolveSiteKey(normOrigin, rt.meta.rules.ssoGroups);

      let trackId = rt.meta.localDevice.siteBindings[siteKey]?.trackId;
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

      this.echoSuppressor.registerLocalStorageMutation(normOrigin, key, 'set', value, nowMs);
      const applyRes = await this.browser.applyLocalStorage(normOrigin, [{ key, value }]);

      const rec =
        (await this.emitLocalStorageUpsert(rt, siteKey, trackId, normOrigin, key, value, 'UPDATE')) ??
        rt.localStorage[buildLocalStorageLogicalId(trackId, normOrigin, key)];

      rec.contextAvailable = applyRes.applied;
      await this.persistRuntime(rt);

      if (rt.meta.space.settings.autoSync && this.isOnline() && !rt.meta.storageFullHalted) {
        await this.pushOutboundInternal(rt);
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

        if (scope === 'local_only') {
          this.echoSuppressor.registerLocalStorageMutation(rec.origin, rec.key, 'remove', '', nowMs);
          await this.browser.applyLocalStorage(rec.origin, [{ key: rec.key, deleted: true }]);
          rec.syncStatus = 'REMOTE_ONLY';
          continue;
        }

        if (scope === 'remote_track_only') {
          await this.emitLocalStorageDelete(rt, rec, 'user_delete', 'remote_track_only');
          pushNeeded = true;
          continue;
        }

        if (scope === 'all_devices') {
          this.echoSuppressor.registerLocalStorageMutation(rec.origin, rec.key, 'remove', '', nowMs);
          await this.browser.applyLocalStorage(rec.origin, [{ key: rec.key, deleted: true }]);
          await this.emitLocalStorageDelete(rt, rec, 'user_delete', 'all_devices');
          pushNeeded = true;
        }
      }

      await this.persistRuntime(rt);
      if (pushNeeded && rt.meta.space.settings.autoSync && this.isOnline() && !rt.meta.storageFullHalted) {
        await this.pushOutboundInternal(rt);
        await this.persistRuntime(rt);
      }
    });
  }

  // =========================================================================
  // Rules & Blacklists
  // =========================================================================

  async getRulesAndBlacklist(): Promise<{
    spaceBlacklist: BlacklistEntry[];
    deviceBlacklist: BlacklistEntry[];
    siteOverrides: Record<string, SiteRuleOverride>;
    ssoGroups: SsoDomainGroup[];
  }> {
    await this.ensureInitialized();
    const rt = this.runtime;
    if (!rt) {
      return { spaceBlacklist: [], deviceBlacklist: [], siteOverrides: {}, ssoGroups: [] };
    }
    return {
      spaceBlacklist: [...rt.meta.rules.spaceBlacklist],
      deviceBlacklist: [...rt.meta.deviceBlacklist],
      siteOverrides: { ...rt.meta.rules.siteOverrides },
      ssoGroups: [...rt.meta.rules.ssoGroups],
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

      // Clear BLACKLISTED bindings that are no longer blacklisted
      for (const [siteKey, binding] of Object.entries(rt.meta.localDevice.siteBindings)) {
        if (binding.state === 'BLACKLISTED' && !rt.rulesEngine.isBlacklisted(siteKey).blacklisted) {
          delete rt.meta.localDevice.siteBindings[siteKey];
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
      if (parsed.deviceBlacklist && parsed.deviceBlacklist.length > 0) {
        rt.meta.deviceBlacklist = parsed.deviceBlacklist;
      }
      rt.meta.rules.updatedAt = nowMs;
      rt.rulesEngine.update(rt.meta.space.settings, rt.meta.rules, rt.meta.deviceBlacklist);
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
      if (rt.meta.space.settings.autoSync && this.isOnline() && !rt.meta.storageFullHalted) {
        await this.pushOutboundInternal(rt);
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
      if (rt.meta.space.settings.autoSync && this.isOnline() && !rt.meta.storageFullHalted) {
        await this.pushOutboundInternal(rt);
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
        rt.meta.localDevice.siteBindings[point.siteKey] = { ...point.previousBinding };
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

      // Restore snapshotted LocalStorage
      for (const [origin, items] of Object.entries(point.localStorageByOrigin)) {
        const currentLs = await this.browser.getLocalStorage(origin);
        if (!currentLs.available) continue;
        const mutations: Array<{ key: string; value?: string; deleted?: boolean }> = [];
        for (const k of Object.keys(currentLs.items)) {
          if (!Object.prototype.hasOwnProperty.call(items, k)) {
            this.echoSuppressor.registerLocalStorageMutation(origin, k, 'remove', '', nowMs);
            mutations.push({ key: k, deleted: true });
          }
        }
        for (const [k, v] of Object.entries(items)) {
          this.echoSuppressor.registerLocalStorageMutation(origin, k, 'set', v, nowMs);
          mutations.push({ key: k, value: v });
        }
        if (mutations.length > 0) {
          await this.browser.applyLocalStorage(origin, mutations);
        }
      }

      rt.undoPoints.splice(idx, 1);

      const sitePolicy = this.getEffectivePolicyForDevice(rt, point.siteKey, point.siteKey);
      const versionDigest = await sha256Hex(`undo:${point.undoId}:${nowMs}`);
      await this.autoRefresh.notifyAppliedChanges({
        siteKey: point.siteKey,
        versionDigest,
        autoRefreshEnabled: sitePolicy.autoRefresh && rt.meta.space.settings.autoRefresh,
        refreshProtectionEnabled: rt.meta.space.settings.refreshProtection,
        immediate: this.refreshCoalesceMs <= 0,
      });

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
              missingSeqGaps.push(`${devId}:${prevToSeq + 1}..${batch.fromSeq - 1}`);
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
  }

  async rebuildIndex(): Promise<void> {
    await this.ensureInitialized();
    return this.enqueueOp(async () => {
      const rt = this.requireRuntime();
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
      await this.pullRemoteInternal(rt, { applyToBrowser: true });

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
        return parseEventFilenameSeq(na) - parseEventFilenameSeq(nb);
      });

    const nowMs = this.now();
    for (const s of files) {
      const name = s.name || extractFilename(s.path);
      const p = `${dir}/${name}`;
      try {
        const fetched = await rt.client.getBytes(p);
        const { data: batch } = await decryptWithDek<EventBatch>(
          fetched.bytes,
          rt.dekKeyring,
          `${rt.spaceId}|`,
        );
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
          rt.meta.rules = snap.rules;
          rt.rulesEngine.update(rt.meta.space.settings, rt.meta.rules, rt.meta.deviceBlacklist);
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

      // Restore tracks & rules
      for (const [tid, tr] of Object.entries(backup.tracks ?? {})) {
        rt.tracks[tid] = { ...tr };
      }
      if (backup.rules) {
        rt.meta.rules = { ...backup.rules, updatedAt: this.now() };
        rt.rulesEngine.update(rt.meta.space.settings, rt.meta.rules, rt.meta.deviceBlacklist);
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
            storeId: c.storeScope,
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
