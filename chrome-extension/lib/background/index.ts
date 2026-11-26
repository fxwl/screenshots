import {
  DEFAULT_SPACE_SETTINGS,
  envRuleMatchesUrl,
  resolveSiteKey,
  RulesEngine,
  SyncEngine,
  toStructuredError,
  type SanitizedStorageProviderConfig,
  type SiteSummaryView,
  type SpaceSettings,
  type SyncStatusSummary,
  type WebDAVConfig,
} from '@sessionmesh/core';
import {
  isSyncableHttpUrl,
  type ContentPageMountConfig,
  type CurrentSiteSnapshot,
  type PopupSummaryPayload,
  type SessionMeshCommand,
  type SessionMeshResponse,
} from '@sessionmesh/shared';
import {
  defaultDirHandleStore,
  IndexedDBStorageBackend,
  localeStorage,
  NonExtractableKeyVault,
  uiStateStorage,
} from '@sessionmesh/storage';
import { deriveTrackBadgeText, updateBadgeForTab, updateBadgeFromStatus } from './badge';
import { ChromeBrowserAdapter } from './chromeBrowserAdapter';
import {
  consumePendingTabAccountToast,
  registerCommandShortcutsListener,
  savePendingTabAccountToast,
} from './commands';
import { registerContextMenuListener, setupContextMenus } from './contextMenu';

const ALARM_POLL = 'sessionmesh-poll';
const ALARM_FLUSH = 'sessionmesh-flush';
const ALARM_EXPIRY_CHECK = 'sessionmesh-expiry-check';
const EXPIRY_CHECK_PERIOD_MINUTES = 30;
const MIN_POLL_PERIOD_MINUTES = 0.5;
const LOW_FREQ_MIN_POLL_MINUTES = 5;
const SITE_VISIT_DEDUPE_MS = 1_500;

// Instantiate persistent storage, key vault, and browser adapter at top-level
// so chrome.cookies.onChanged is attached synchronously on cold MV3 SW wakeups.
const storageBackend = new IndexedDBStorageBackend('sessionmesh_db');
const keyVault = new NonExtractableKeyVault({ dbName: 'sessionmesh_vault' });

let engineInstance: SyncEngine | null = null;
let engineInitPromise: Promise<SyncEngine> | null = null;
let uiBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
let lastPollPeriodMinutes: number | null = null;
let scheduledAutoPushAt = 0;
let cookieFlushAlarmArmedUntil = 0;

// Short dedupe map for webNavigation.onCommitted + tabs.onUpdated on the same tab/origin
const recentSiteVisits = new Map<string, number>();
// Track each tab's current URL (backed by chrome.storage.session so it survives MV3 SW cold suspension!)
const TAB_URL_SESSION_KEY = 'sessionmesh_tab_urls_v1';
const tabUrlById = new Map<number, string>();
let tabUrlPersistTimer: ReturnType<typeof setTimeout> | null = null;
const recentSiteLeaves = new Map<string, number>();
const SITE_LEAVE_DEDUPE_MS = 1_500;

function persistTabUrlCacheSoon(): void {
  if (typeof chrome === 'undefined' || !chrome.storage?.session?.set) return;
  if (tabUrlPersistTimer !== null) return;
  tabUrlPersistTimer = setTimeout(() => {
    tabUrlPersistTimer = null;
    try {
      const obj: Record<string, string> = {};
      for (const [id, url] of tabUrlById.entries()) {
        obj[String(id)] = url;
      }
      void chrome.storage.session.set({ [TAB_URL_SESSION_KEY]: obj }).catch(() => undefined);
    } catch {
      // ignore session storage errors
    }
  }, 120);
}

function rememberTabUrl(tabId: number, url: string): void {
  if (!isSyncableHttpUrl(url)) return;
  if (tabUrlById.get(tabId) === url) return;
  tabUrlById.set(tabId, url);
  persistTabUrlCacheSoon();
}

function forgetTabUrl(tabId: number): void {
  if (!tabUrlById.delete(tabId)) return;
  persistTabUrlCacheSoon();
}

async function resolveRememberedTabUrl(tabId: number): Promise<string | undefined> {
  const cached = tabUrlById.get(tabId);
  if (cached) return cached;
  if (typeof chrome === 'undefined' || !chrome.storage?.session?.get) return undefined;
  try {
    const res = await chrome.storage.session.get(TAB_URL_SESSION_KEY);
    const map = res?.[TAB_URL_SESSION_KEY] as Record<string, string> | undefined;
    if (map && typeof map === 'object') {
      for (const [k, v] of Object.entries(map)) {
        const numId = Number(k);
        if (Number.isFinite(numId) && typeof v === 'string' && !tabUrlById.has(numId)) {
          tabUrlById.set(numId, v);
        }
      }
      return map[String(tabId)];
    }
  } catch {
    // ignore
  }
  return undefined;
}

function seedTabUrlCache(): void {
  if (typeof chrome === 'undefined' || !chrome.tabs?.query) return;
  try {
    chrome.tabs.query({}, tabs => {
      if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
      for (const tab of tabs) {
        if (tab.id !== undefined && tab.url && isSyncableHttpUrl(tab.url)) {
          tabUrlById.set(tab.id, tab.url);
        }
      }
      persistTabUrlCacheSoon();
    });
  } catch {
    // ignore
  }
}

function scheduleFlushAlarm(delayMs = 3_500): void {
  if (typeof chrome === 'undefined' || !chrome.alarms?.create) return;
  try {
    // Schedule short alarm so pending debounced mutations or deferred auto-pushes flush even if SW suspends
    chrome.alarms.create(ALARM_FLUSH, { when: Date.now() + Math.max(1_000, delayMs) });
  } catch {
    // ignore alarms errors
  }
}

function scheduleAutoPushAlarmIfNeeded(engine: SyncEngine): void {
  const delayMs = engine.getNextAutoPushDelayMs();
  if (delayMs === null) {
    scheduledAutoPushAt = 0;
    return;
  }
  const now = Date.now();
  const target = now + delayMs;
  if (scheduledAutoPushAt > now && Math.abs(scheduledAutoPushAt - target) < 2_000) {
    return;
  }
  scheduledAutoPushAt = target;
  scheduleFlushAlarm(delayMs);
}

async function syncPollAlarmFromSettings(settings: SpaceSettings): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.alarms) return;
  try {
    if (!settings.autoSync || !settings.backgroundCheck) {
      await chrome.alarms.clear(ALARM_POLL);
      lastPollPeriodMinutes = null;
      return;
    }

    const minMinutes = settings.lowFrequencyMode ? LOW_FREQ_MIN_POLL_MINUTES : MIN_POLL_PERIOD_MINUTES;
    const desiredMinutes = Math.max(minMinutes, (settings.pollingIntervalSec || 60) / 60);

    if (lastPollPeriodMinutes !== desiredMinutes) {
      await chrome.alarms.create(ALARM_POLL, {
        delayInMinutes: desiredMinutes,
        periodInMinutes: desiredMinutes,
      });
      lastPollPeriodMinutes = desiredMinutes;
    }
  } catch (err) {
    console.warn('SessionMesh failed to configure poll alarm:', err);
  }
}

async function ensureExpiryCheckAlarm(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.alarms?.create) return;
  try {
    await chrome.alarms.create(ALARM_EXPIRY_CHECK, {
      delayInMinutes: EXPIRY_CHECK_PERIOD_MINUTES,
      periodInMinutes: EXPIRY_CHECK_PERIOD_MINUTES,
    });
  } catch {
    // ignore expiry alarm errors
  }
}

async function syncVaultAndAlarms(engine: SyncEngine): Promise<void> {
  try {
    const settings = await engine.getSpaceSettings();
    await keyVault.setSessionLockEnabled(Boolean(settings.sessionLockEnabled));
    await syncPollAlarmFromSettings(settings);
    await ensureExpiryCheckAlarm();
  } catch (err) {
    console.warn('SessionMesh failed to sync vault/alarm settings:', err);
  }
}

async function refreshTabBadgeForUrl(
  engine: SyncEngine,
  tabId: number,
  url: string | undefined,
  summary: SyncStatusSummary,
  settings?: SpaceSettings,
  sitesBySiteKey?: Map<string, SiteSummaryView>,
): Promise<void> {
  const effectiveSettings = settings ?? (await engine.getSpaceSettings().catch(() => DEFAULT_SPACE_SETTINGS));
  const ssoGroups = engine.getCachedSsoGroups();
  const siteKey = isSyncableHttpUrl(url) ? resolveSiteKey(url!, ssoGroups) : '';
  let siteSummary = siteKey ? sitesBySiteKey?.get(siteKey) : undefined;
  if (siteKey && !sitesBySiteKey) {
    const overview = await engine.getSitesOverview().catch(() => []);
    siteSummary = overview.find(item => item.siteKey === siteKey);
  }
  updateBadgeForTab({
    tabId,
    summary,
    siteSummary,
    badgeDisplayMode: effectiveSettings.badgeDisplayMode ?? 'multi_or_tagged',
  });
}

async function refreshAllTabBadges(engine: SyncEngine, summary: SyncStatusSummary): Promise<void> {
  try {
    const [tabs, settings, overview] = await Promise.all([
      browserAdapter.queryTabs(),
      engine.getSpaceSettings().catch(() => DEFAULT_SPACE_SETTINGS),
      engine.getSitesOverview().catch(() => [] as SiteSummaryView[]),
    ]);
    const sitesByKey = new Map<string, SiteSummaryView>();
    for (const item of overview) {
      sitesByKey.set(item.siteKey, item);
    }
    const ssoGroups = engine.getCachedSsoGroups();
    for (const tab of tabs) {
      if (typeof tab.id !== 'number') continue;
      const siteKey = isSyncableHttpUrl(tab.url) ? resolveSiteKey(tab.url!, ssoGroups) : '';
      updateBadgeForTab({
        tabId: tab.id,
        summary,
        siteSummary: siteKey ? sitesByKey.get(siteKey) : undefined,
        badgeDisplayMode: settings.badgeDisplayMode ?? 'multi_or_tagged',
      });
    }
  } catch {
    // ignore per-tab badge refresh errors
  }
}

async function propagateExtendedMonitorsToOpenTabs(engine: SyncEngine, filterSiteKey?: string): Promise<void> {
  try {
    const tabs = await browserAdapter.queryTabs();
    const ssoGroups = engine.getCachedSsoGroups();
    const seenOrigins = new Set<string>();
    for (const tab of tabs) {
      if (!isSyncableHttpUrl(tab.url)) continue;
      let origin: string;
      try {
        origin = new URL(tab.url!).origin;
      } catch {
        continue;
      }
      if (seenOrigins.has(origin)) continue;
      seenOrigins.add(origin);
      if (filterSiteKey && resolveSiteKey(origin, ssoGroups) !== filterSiteKey) continue;

      const cfg = await engine.getPageMountConfig(origin).catch(() => null);
      if (!cfg) continue;
      await browserAdapter.configureOriginExtendedMonitors(origin, {
        syncSessionStorage: Boolean(cfg.syncSessionStorage),
        sessionStorageKeyAllowlist: cfg.sessionStorageKeyAllowlist,
        syncIndexedDb: Boolean(cfg.syncIndexedDb),
        indexedDbTargets: cfg.indexedDbTargets,
        indexedDbMaxTotalBytes: cfg.indexedDbMaxTotalBytes,
      });
    }
  } catch {
    // ignore extended monitor propagation errors
  }
}

async function broadcastUiStateNow(): Promise<void> {
  try {
    const engine = await ensureEngineReady();
    const summary = await engine.getStatusSummary();
    updateBadgeFromStatus(summary);
    await refreshAllTabBadges(engine, summary);
    await uiStateStorage.publishStatus(summary);
    scheduleAutoPushAlarmIfNeeded(engine);
  } catch (err) {
    console.warn('SessionMesh UI state broadcast failed:', err);
  }
}

function scheduleUiBroadcast(): void {
  if (uiBroadcastTimer !== null) return;
  uiBroadcastTimer = setTimeout(() => {
    uiBroadcastTimer = null;
    void broadcastUiStateNow();
  }, 60);
}

const browserAdapter = new ChromeBrowserAdapter({
  onRawCookieActivity: () => {
    // Ensure SyncEngine is awake and arm the MV3 flush alarm without starving it on continuous cookie churn
    void ensureEngineReady().catch(() => undefined);
    const now = Date.now();
    if (cookieFlushAlarmArmedUntil <= now) {
      cookieFlushAlarmArmedUntil = now + 3_500;
      scheduledAutoPushAt = 0;
      scheduleFlushAlarm(3_500);
    }
  },
});

/**
 * Concurrency-safe lazy singleton initializer for SyncEngine inside MV3 Service Worker.
 */
export async function ensureEngineReady(): Promise<SyncEngine> {
  if (engineInstance) {
    return engineInstance;
  }
  if (!engineInitPromise) {
    engineInitPromise = (async () => {
      const engine = new SyncEngine({
        storage: storageBackend,
        browser: browserAdapter,
        storageAdapterOptions: {
          resolveDirectoryHandle: async handleKey => defaultDirHandleStore.getDirectoryHandle(handleKey),
        },
        keyVault,
        debounceMs: 3_000,
        refreshCoalesceMs: 1_200,
        autoPushCooldownMs: 12_000,
        transientErrorAlertThreshold: 3,
        defaultSyncTimingMode: 'on_page_leave',
        maxReloadsPerWindow: 1,
        reloadWindowMs: 120_000,
        onStateChange: () => {
          scheduleUiBroadcast();
        },
      });
      await engine.init();
      engineInstance = engine;
      seedTabUrlCache();
      await syncVaultAndAlarms(engine);
      // Recover any cookie written right before an abrupt browser crash/exit (before debounce flushed)
      void engine
        .reconcileLocalManagedCookies()
        .then(recovered => {
          if (recovered > 0) scheduleUiBroadcast();
        })
        .catch(() => undefined);
      scheduleUiBroadcast();
      return engine;
    })().catch(err => {
      engineInitPromise = null;
      throw err;
    });
  }
  return engineInitPromise;
}

function sanitizeWebDAVConfig(config: WebDAVConfig | null): Omit<WebDAVConfig, 'password' | 'bearerToken'> | null {
  if (!config) return null;
  return {
    url: config.url,
    authType: config.authType,
    username: config.username,
    rootPath: config.rootPath,
    requestTimeoutMs: config.requestTimeoutMs,
    retryPolicy: config.retryPolicy,
    storageFormat: config.storageFormat,
  };
}

async function buildCurrentSiteSnapshot(engine: SyncEngine, activeUrl?: string): Promise<CurrentSiteSnapshot | null> {
  if (!isSyncableHttpUrl(activeUrl)) {
    return null;
  }
  const url = activeUrl!;
  let origin: string | undefined;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }

  let rulesSnapshot: Awaited<ReturnType<SyncEngine['getRulesAndBlacklist']>> | null = null;
  try {
    rulesSnapshot = await engine.getRulesAndBlacklist();
  } catch {
    rulesSnapshot = null;
  }

  const siteKey = resolveSiteKey(url, rulesSnapshot?.ssoGroups);
  if (!siteKey) return null;

  let summary: SiteSummaryView | undefined;
  try {
    const overview = await engine.getSitesOverview();
    summary = overview.find((item: SiteSummaryView) => item.siteKey === siteKey);
  } catch {
    summary = undefined;
  }

  if (!summary && rulesSnapshot) {
    const rulesEngine = new RulesEngine(
      DEFAULT_SPACE_SETTINGS,
      {
        spaceBlacklist: rulesSnapshot.spaceBlacklist,
        siteOverrides: rulesSnapshot.siteOverrides,
        ssoGroups: rulesSnapshot.ssoGroups,
        updatedAt: 0,
      },
      rulesSnapshot.deviceBlacklist,
    );
    if (rulesEngine.isBlacklisted(url).blacklisted || rulesEngine.isBlacklisted(siteKey).blacklisted) {
      summary = {
        siteKey,
        binding: {
          siteKey,
          state: 'BLACKLISTED',
          hasLocalBaseline: false,
          decidedBy: 'user',
        },
        allTracks: [],
        cookieCount: 0,
        localStorageCount: 0,
        syncStatus: 'EXCLUDED',
      };
    }
  }

  let favIconUrl = summary?.favIconUrl;
  if (!favIconUrl) {
    try {
      const activeTabs = await browserAdapter.queryTabs({ active: true });
      const matchingTab = activeTabs.find(t => t.url === url);
      favIconUrl = matchingTab?.favIconUrl;
    } catch {
      // ignore favicon lookup failure
    }
  }

  const matchingEnvRules = (rulesSnapshot?.envSyncRules ?? []).filter(
    r => envRuleMatchesUrl(r, url, rulesSnapshot?.ssoGroups) !== null,
  );

  return {
    siteKey,
    origin,
    url,
    favIconUrl,
    summary,
    matchingEnvRules,
  };
}

async function handleSiteVisited(url?: string, tabId?: number): Promise<void> {
  if (!isSyncableHttpUrl(url)) return;
  const targetUrl = url!;

  let originKey = targetUrl;
  try {
    originKey = new URL(targetUrl).origin;
  } catch {
    return;
  }

  const dedupeKey = `${tabId ?? 'any'}|${originKey}`;
  const now = Date.now();
  const prev = recentSiteVisits.get(dedupeKey);
  if (prev && now - prev < SITE_VISIT_DEDUPE_MS) {
    return;
  }
  recentSiteVisits.set(dedupeKey, now);
  if (recentSiteVisits.size > 100) {
    for (const [k, ts] of recentSiteVisits.entries()) {
      if (now - ts > SITE_VISIT_DEDUPE_MS * 4) {
        recentSiteVisits.delete(k);
      }
    }
  }

  try {
    const engine = await ensureEngineReady();
    await engine.onSiteVisited(targetUrl);
  } catch (err) {
    console.warn('SessionMesh onSiteVisited error:', err);
  }
}

async function handleSitePageLeft(urlOrSiteKey?: string): Promise<void> {
  if (!urlOrSiteKey) return;
  const cachedGroups = engineInstance?.getCachedSsoGroups();
  const initialSiteKey = isSyncableHttpUrl(urlOrSiteKey)
    ? resolveSiteKey(urlOrSiteKey, cachedGroups)
    : resolveSiteKey(`https://${urlOrSiteKey}`, cachedGroups);
  if (!initialSiteKey) return;

  try {
    // Allow 150ms for any final in-flight Set-Cookie / pagehide IPC to arrive before flushing
    await new Promise(resolve => setTimeout(resolve, 150));
    const engine = await ensureEngineReady();
    const ssoGroups = engine.getCachedSsoGroups();
    const siteKey = isSyncableHttpUrl(urlOrSiteKey)
      ? resolveSiteKey(urlOrSiteKey, ssoGroups)
      : resolveSiteKey(`https://${urlOrSiteKey}`, ssoGroups);
    if (!siteKey) return;

    const now = Date.now();
    const prev = recentSiteLeaves.get(siteKey);
    if (prev && now - prev < SITE_LEAVE_DEDUPE_MS) {
      return;
    }
    recentSiteLeaves.set(siteKey, now);

    await engine.onSitePageLeft(urlOrSiteKey);
    await broadcastUiStateNow();
  } catch (err) {
    console.warn('SessionMesh onSitePageLeft error:', err);
  }
}

async function handleTabNavigationChange(tabId: number, nextUrl: string | undefined, isReload: boolean): Promise<void> {
  const prevUrl = await resolveRememberedTabUrl(tabId);
  if (nextUrl && isSyncableHttpUrl(nextUrl)) {
    rememberTabUrl(tabId, nextUrl);
  } else if (nextUrl) {
    forgetTabUrl(tabId);
  }

  const ssoGroups =
    engineInstance?.getCachedSsoGroups() ?? (await ensureEngineReady().catch(() => null))?.getCachedSsoGroups() ?? [];
  const prevSiteKey = prevUrl && isSyncableHttpUrl(prevUrl) ? resolveSiteKey(prevUrl, ssoGroups) : '';
  const nextSiteKey = nextUrl && isSyncableHttpUrl(nextUrl) ? resolveSiteKey(nextUrl, ssoGroups) : '';

  if (prevSiteKey && prevSiteKey !== nextSiteKey) {
    void handleSitePageLeft(prevUrl);
  }

  if (!isReload && nextSiteKey && prevSiteKey !== nextSiteKey) {
    void handleSiteVisited(nextUrl, tabId);
  }
}

async function handleTabRemoved(tabId: number): Promise<void> {
  const closedUrl = await resolveRememberedTabUrl(tabId);
  forgetTabUrl(tabId);
  if (closedUrl && isSyncableHttpUrl(closedUrl)) {
    await handleSitePageLeft(closedUrl);
  }
}

async function buildAccountSwitchToast(
  engine: SyncEngine,
  siteKey: string,
  trackId: string,
): Promise<{
  siteKey: string;
  label: string;
  badgeText: string;
  color?: string;
  index: number;
  total: number;
} | null> {
  const overview = await engine.getSitesOverview().catch(() => []);
  const site = overview.find(item => item.siteKey === siteKey);
  if (!site) return null;
  const idx = site.allTracks.findIndex(t => t.trackId === trackId);
  const track = (idx >= 0 ? site.allTracks[idx] : site.activeTrack) ?? site.allTracks[0];
  if (!track) return null;
  const total = Math.max(1, site.allTracks.length);
  const indexOneBased = idx >= 0 ? idx + 1 : 1;
  return {
    siteKey,
    label: track.label,
    badgeText: deriveTrackBadgeText(track, indexOneBased, total),
    color: track.color,
    index: indexOneBased,
    total,
  };
}

async function resolveNextRotationPreviewToast(
  engine: SyncEngine,
  siteKey: string,
  direction: 'next' | 'prev',
): Promise<{
  siteKey: string;
  label: string;
  badgeText: string;
  color?: string;
  index: number;
  total: number;
} | null> {
  const overview = await engine.getSitesOverview().catch(() => []);
  const site = overview.find(item => item.siteKey === siteKey);
  if (!site || site.allTracks.length === 0) return null;
  const sorted = site.allTracks;
  const currentIdx = site.binding.trackId ? sorted.findIndex(t => t.trackId === site.binding.trackId) : -1;
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
  const target = sorted[nextIdx];
  const indexOneBased = nextIdx + 1;
  const total = sorted.length;
  return {
    siteKey,
    label: target.label,
    badgeText: deriveTrackBadgeText(target, indexOneBased, total),
    color: target.color,
    index: indexOneBased,
    total,
  };
}

async function executeCommand(cmd: SessionMeshCommand, sender?: chrome.runtime.MessageSender): Promise<unknown> {
  const engine = await ensureEngineReady();

  switch (cmd.type) {
    case 'GET_STATUS_SUMMARY': {
      const status = await engine.getStatusSummary(cmd.activeUrl);
      const currentSite = await buildCurrentSiteSnapshot(engine, cmd.activeUrl);
      const [settings, webdav, storage] = await Promise.all([
        engine.getSpaceSettings().catch(() => undefined),
        engine.getWebDAVConfig().catch(() => null),
        engine.getSanitizedStorageConfig().catch(() => null),
      ]);
      updateBadgeFromStatus(status);
      const payload: PopupSummaryPayload & {
        settings?: SpaceSettings;
        webdav?: Omit<WebDAVConfig, 'password' | 'bearerToken'> | null;
        storage?: SanitizedStorageProviderConfig | null;
      } = {
        status,
        currentSite,
        settings,
        webdav: sanitizeWebDAVConfig(webdav),
        storage,
      };
      return payload;
    }

    case 'TEST_WEBDAV_CONNECTION':
      return engine.testWebDAVConnection(cmd.config);

    case 'TEST_STORAGE_CONNECTION':
      return engine.testStorageConnection(cmd.storage);

    case 'PROBE_REMOTE_SPACES':
      return engine.probeRemoteSpaces(cmd.config);

    case 'PROBE_STORAGE_SPACES':
      return engine.probeStorageSpaces(cmd.storage);

    case 'VERIFY_SPACE_PASSWORD':
      return engine.verifyRemoteSpacePassword({
        webdav: cmd.webdav,
        spaceId: cmd.spaceId,
        encryptionPassword: cmd.encryptionPassword,
      });

    case 'VERIFY_STORAGE_SPACE_PASSWORD':
      return engine.verifyStorageSpacePassword({
        storage: cmd.storage,
        spaceId: cmd.spaceId,
        encryptionPassword: cmd.encryptionPassword,
      });

    case 'SAVE_AND_JOIN_SPACE': {
      if (cmd.settingsPatch?.sessionLockEnabled !== undefined) {
        await keyVault.setSessionLockEnabled(Boolean(cmd.settingsPatch.sessionLockEnabled));
      }
      const effectiveSettingsPatch: Partial<SpaceSettings> = {
        ...cmd.settingsPatch,
        syncScopeMode: cmd.settingsPatch?.syncScopeMode ?? 'managed_only',
        syncTimingMode: cmd.settingsPatch?.syncTimingMode ?? 'on_page_leave',
        autoRefresh: cmd.settingsPatch?.autoRefresh ?? false,
      };
      const report = await engine.saveAndJoinSpace({
        webdav: cmd.webdav,
        storage: cmd.storage,
        spaceId: cmd.spaceId,
        spaceName: cmd.spaceName,
        encryptionPassword: cmd.encryptionPassword,
        deviceName: cmd.deviceName,
        presetCategories: cmd.presetCategories,
        settingsPatch: effectiveSettingsPatch,
        initialManagedSiteKeys: cmd.initialManagedSiteKeys,
      });
      await syncVaultAndAlarms(engine);
      await broadcastUiStateNow();
      return report;
    }

    case 'UPDATE_SPACE_STORAGE_CONFIG': {
      await engine.updateSpaceStorageConfig(cmd.storage);
      await syncVaultAndAlarms(engine);
      await broadcastUiStateNow();
      return { updated: true };
    }

    case 'NOTIFY_LOCAL_DIR_PERMISSION_GRANTED': {
      await engine.clearLocalDirPermissionError(cmd.handleKey);
      await engine.syncNow({ userInitiated: true }).catch(() => undefined);
      await broadcastUiStateNow();
      return { ok: true };
    }

    case 'UNLOCK_SESSION': {
      await engine.unlockSession(cmd.encryptionPassword, cmd.spaceId);
      await syncVaultAndAlarms(engine);
      await broadcastUiStateNow();
      // Immediately pull any updates missed while locked / during peer key rotation (non-blocking & silent)
      void engine
        .syncNow({ direction: 'pull', triggerRefresh: false })
        .then(() => broadcastUiStateNow())
        .catch(() => undefined);
      return { unlocked: true };
    }

    case 'LOCK_SESSION': {
      await engine.lockSession();
      await keyVault.clearAllDeks();
      await broadcastUiStateNow();
      return { locked: true };
    }

    case 'GENERATE_PAIRING_CODE':
      return engine.generatePairingCode(cmd.passphrase ?? '');

    case 'DECODE_PAIRING_CODE':
      return engine.decodePairingCode(cmd.code, cmd.passphrase);

    case 'SYNC_NOW': {
      const result = await engine.syncNow({
        siteKey: cmd.siteKey,
        direction: cmd.direction,
        triggerRefresh: cmd.triggerRefresh,
        userInitiated: true,
      });
      await broadcastUiStateNow();
      return result;
    }

    case 'SET_GLOBAL_PAUSED': {
      await engine.setGlobalPaused(cmd.paused);
      await propagateExtendedMonitorsToOpenTabs(engine);
      await broadcastUiStateNow();
      return { paused: cmd.paused };
    }

    case 'UPDATE_SPACE_SETTINGS': {
      const updated = await engine.updateSpaceSettings(cmd.settings);
      await keyVault.setSessionLockEnabled(Boolean(updated.sessionLockEnabled));
      await syncPollAlarmFromSettings(updated);
      await propagateExtendedMonitorsToOpenTabs(engine);
      await broadcastUiStateNow();
      return updated;
    }

    case 'SWITCH_SPACE': {
      await engine.switchSpace(cmd.spaceId, cmd.encryptionPassword);
      await syncVaultAndAlarms(engine);
      await broadcastUiStateNow();
      return { spaceId: cmd.spaceId };
    }

    case 'CREATE_SPACE': {
      const report = await engine.createSpace(cmd.spaceId, cmd.spaceName, cmd.encryptionPassword, {
        syncScopeMode: 'managed_only',
        syncTimingMode: 'on_page_leave',
        autoRefresh: false,
      });
      await syncVaultAndAlarms(engine);
      await broadcastUiStateNow();
      return report;
    }

    case 'RENAME_SPACE': {
      await engine.renameSpace(cmd.spaceId, cmd.newName);
      await broadcastUiStateNow();
      return { spaceId: cmd.spaceId, name: cmd.newName };
    }

    case 'ROTATE_SPACE_PASSWORD': {
      await engine.rotateSpacePassword(cmd.oldPassword, cmd.newPassword);
      await broadcastUiStateNow();
      return { rotated: true };
    }

    case 'DELETE_LOCAL_SPACE': {
      await engine.deleteLocalSpace(cmd.spaceId, cmd.deleteRemote);
      await keyVault.clearDek(cmd.spaceId);
      await syncVaultAndAlarms(engine);
      await broadcastUiStateNow();
      return { deleted: true };
    }

    case 'GET_SITES_OVERVIEW':
      return engine.getSitesOverview();

    case 'SCAN_BROWSER_CANDIDATE_SITES':
      return engine.scanBrowserCandidateSites();

    case 'ADD_MANAGED_SITES': {
      const res = await engine.addManagedSites(cmd.siteKeys);
      scheduleFlushAlarm();
      await broadcastUiStateNow();
      return res;
    }

    case 'REMOVE_MANAGED_SITE': {
      await engine.removeManagedSite(cmd.siteKey, cmd.scope);
      scheduleFlushAlarm();
      await broadcastUiStateNow();
      return { removed: true };
    }

    case 'SET_SPACE_AUTHORITY_POLICY': {
      const updated = await engine.setSpaceAuthorityPolicy({
        authorityMode: cmd.authorityMode,
        primaryDeviceId: cmd.primaryDeviceId,
      });
      await broadcastUiStateNow();
      return updated;
    }

    case 'UPSERT_DEVICE_POLICY': {
      await engine.upsertDevicePolicy(cmd.policy);
      await broadcastUiStateNow();
      return { saved: true };
    }

    case 'REMOVE_DEVICE_POLICY': {
      await engine.removeDevicePolicy(cmd.deviceId);
      await broadcastUiStateNow();
      return { removed: true };
    }

    case 'DISMISS_LATEST_ERROR': {
      await engine.dismissLatestError();
      await broadcastUiStateNow();
      return { dismissed: true };
    }

    case 'DISMISS_ATTENTION_ITEM': {
      await engine.dismissAttentionItem(cmd.itemId);
      await broadcastUiStateNow();
      return { dismissed: true };
    }

    case 'RETRY_FAILED_COOKIES': {
      const res = await engine.retryFailedCookies(cmd.siteKey);
      await broadcastUiStateNow();
      return res;
    }

    case 'FORCE_RELOAD_TAB': {
      const reloaded = await engine.forceReloadDeferredTab(cmd.tabId);
      await broadcastUiStateNow();
      return { reloaded };
    }

    case 'GET_PENDING_DECISIONS':
      return engine.getPendingDecisions();

    case 'RESOLVE_SITE_DECISION': {
      await engine.resolveSiteDecision(cmd.siteKey, cmd.action);
      await broadcastUiStateNow();
      return { resolved: true };
    }

    case 'RESOLVE_BATCH_DECISIONS': {
      await engine.resolveBatchDecisions(cmd.siteKeys, cmd.action);
      await broadcastUiStateNow();
      return { resolved: cmd.siteKeys.length };
    }

    case 'SWITCH_SITE_TRACK': {
      await engine.switchSiteTrack(cmd.siteKey, cmd.targetTrackId);
      await broadcastUiStateNow();
      return { switched: true };
    }

    case 'SPLIT_SITE_INDEPENDENT': {
      await engine.splitSiteIndependent(cmd.siteKey, cmd.customLabel);
      await broadcastUiStateNow();
      return { split: true };
    }

    case 'RENAME_SITE_TRACK': {
      await engine.renameSiteTrack(cmd.siteKey, cmd.trackId, cmd.label);
      await broadcastUiStateNow();
      return { renamed: true };
    }

    case 'UPDATE_SITE_TRACK': {
      const updated = await engine.updateSiteTrack(cmd.siteKey, cmd.trackId, cmd.patch);
      await broadcastUiStateNow();
      return updated;
    }

    case 'REORDER_SITE_TRACKS': {
      const tracks = await engine.reorderSiteTracks(cmd.siteKey, cmd.orderedTrackIds);
      await broadcastUiStateNow();
      return tracks;
    }

    case 'CREATE_SITE_ACCOUNT_TRACK': {
      const created = await engine.createSiteAccountTrack(cmd.siteKey, cmd.options);
      scheduleFlushAlarm();
      await broadcastUiStateNow();
      return created;
    }

    case 'ROTATE_SITE_TRACK': {
      const rotated = await engine.rotateSiteTrack(cmd.siteKey, cmd.direction);
      scheduleFlushAlarm();
      await broadcastUiStateNow();
      return rotated;
    }

    case 'DELETE_SITE_TRACK': {
      const res = await engine.deleteSiteTrack(cmd.siteKey, cmd.trackId);
      scheduleFlushAlarm();
      await broadcastUiStateNow();
      return res;
    }

    case 'GET_SITE_COOKIES':
      return engine.getSiteCookies(cmd.siteKey, cmd.trackId);

    case 'UPSERT_COOKIE': {
      const record = await engine.upsertCookie(cmd.siteKey, cmd.cookie, cmd.trackId);
      scheduleFlushAlarm();
      await broadcastUiStateNow();
      return record;
    }

    case 'APPLY_COOKIE_TO_BROWSER': {
      const record = await engine.applyCookieToBrowser(cmd.logicalId);
      await broadcastUiStateNow();
      return record;
    }

    case 'DELETE_COOKIES': {
      await engine.deleteCookies(cmd.logicalIds, cmd.scope, cmd.siteKey);
      scheduleFlushAlarm();
      await broadcastUiStateNow();
      return { deleted: cmd.logicalIds.length };
    }

    case 'IMPORT_COOKIES_JSON': {
      const count = await engine.importCookiesJson(cmd.cookies, cmd.siteKey, cmd.trackId);
      scheduleFlushAlarm();
      await broadcastUiStateNow();
      return count;
    }

    case 'EXPORT_COOKIES_JSON':
      return engine.exportCookiesJson(cmd.siteKey, cmd.trackId);

    case 'EXPORT_DEBUG_STATE':
      return engine.exportDebugState(cmd.request);

    case 'TOGGLE_WATCHED_COOKIE': {
      const watchedCookieNames = await engine.toggleWatchedCookie(cmd.siteKey, cmd.cookieName, cmd.watched);
      await broadcastUiStateNow();
      return { watchedCookieNames };
    }

    case 'CREATE_SESSION_SHARE':
      return engine.createSessionShare(cmd.request);

    case 'PREVIEW_SESSION_SHARE':
      return engine.previewSessionShare(cmd.code, cmd.passphrase);

    case 'IMPORT_SESSION_SHARE': {
      const res = await engine.importSessionShare(cmd.request);
      scheduleFlushAlarm();
      await broadcastUiStateNow();
      return res;
    }

    case 'GET_LOCAL_STORAGE_RECORDS':
      return engine.getLocalStorageRecords({
        siteKey: cmd.siteKey,
        origin: cmd.origin,
        trackId: cmd.trackId,
      });

    case 'UPSERT_LOCAL_STORAGE_ITEM': {
      const record = await engine.upsertLocalStorageItem(cmd.origin, cmd.key, cmd.value, cmd.trackId);
      scheduleFlushAlarm();
      await broadcastUiStateNow();
      return record;
    }

    case 'APPLY_LOCAL_STORAGE_ITEM': {
      const record = await engine.applyLocalStorageItem(cmd.logicalId);
      await broadcastUiStateNow();
      return record;
    }

    case 'DELETE_LOCAL_STORAGE_ITEMS': {
      await engine.deleteLocalStorageItems(cmd.logicalIds, cmd.scope);
      scheduleFlushAlarm();
      await broadcastUiStateNow();
      return { deleted: cmd.logicalIds.length };
    }

    case 'GET_SESSION_STORAGE_RECORDS':
      return engine.getSessionStorageRecords({
        siteKey: cmd.siteKey,
        origin: cmd.origin,
        trackId: cmd.trackId,
      });

    case 'UPSERT_SESSION_STORAGE_ITEM': {
      const record = await engine.upsertSessionStorageItem(cmd.origin, cmd.key, cmd.value, cmd.trackId);
      scheduleFlushAlarm();
      await broadcastUiStateNow();
      return record;
    }

    case 'APPLY_SESSION_STORAGE_ITEM': {
      const record = await engine.applySessionStorageItem(cmd.logicalId);
      await broadcastUiStateNow();
      return record;
    }

    case 'DELETE_SESSION_STORAGE_ITEMS': {
      await engine.deleteSessionStorageItems(cmd.logicalIds, cmd.scope);
      scheduleFlushAlarm();
      await broadcastUiStateNow();
      return { deleted: cmd.logicalIds.length };
    }

    case 'INSPECT_PAGE_INDEXED_DB':
      return engine.inspectPageIndexedDb(cmd.origin);

    case 'GET_INDEXED_DB_RECORDS':
      return engine.getIndexedDbRecords({
        siteKey: cmd.siteKey,
        origin: cmd.origin,
        trackId: cmd.trackId,
        dbName: cmd.dbName,
      });

    case 'APPLY_INDEXED_DB_RECORD': {
      const record = await engine.applyIndexedDbRecord(cmd.logicalId);
      await broadcastUiStateNow();
      return record;
    }

    case 'DELETE_INDEXED_DB_RECORDS': {
      await engine.deleteIndexedDbRecords(cmd.logicalIds, cmd.scope);
      scheduleFlushAlarm();
      await broadcastUiStateNow();
      return { deleted: cmd.logicalIds.length };
    }

    case 'CAPTURE_PAGE_EXTENDED_STORAGE_NOW': {
      const res = await engine.capturePageExtendedStorageNow(cmd.origin);
      scheduleFlushAlarm();
      await broadcastUiStateNow();
      return res;
    }

    case 'GET_RULES_AND_BLACKLIST':
      return engine.getRulesAndBlacklist();

    case 'ADD_BLACKLIST_ENTRY': {
      const entry = await engine.addBlacklistEntry(cmd.entry);
      await propagateExtendedMonitorsToOpenTabs(engine);
      await broadcastUiStateNow();
      return entry;
    }

    case 'REMOVE_BLACKLIST_ENTRY': {
      await engine.removeBlacklistEntry(cmd.id, cmd.scope);
      await propagateExtendedMonitorsToOpenTabs(engine);
      await broadcastUiStateNow();
      return { removed: true };
    }

    case 'UPSERT_SITE_RULE': {
      await engine.upsertSiteRule(cmd.rule);
      await propagateExtendedMonitorsToOpenTabs(engine, cmd.rule.siteKey);
      await broadcastUiStateNow();
      return { saved: true };
    }

    case 'REMOVE_SITE_RULE': {
      await engine.removeSiteRule(cmd.siteKey);
      await propagateExtendedMonitorsToOpenTabs(engine, cmd.siteKey);
      await broadcastUiStateNow();
      return { removed: true };
    }

    case 'UPSERT_SSO_GROUP': {
      await engine.upsertSsoGroup(cmd.group);
      await broadcastUiStateNow();
      return { saved: true };
    }

    case 'REMOVE_SSO_GROUP': {
      await engine.removeSsoGroup(cmd.groupId);
      await broadcastUiStateNow();
      return { removed: true };
    }

    case 'UPSERT_ENV_SYNC_RULE': {
      const saved = await engine.upsertEnvSyncRule(cmd.rule);
      await broadcastUiStateNow();
      return saved;
    }

    case 'REMOVE_ENV_SYNC_RULE': {
      await engine.removeEnvSyncRule(cmd.ruleId, cmd.scope);
      await broadcastUiStateNow();
      return { removed: true };
    }

    case 'EXECUTE_ENV_SYNC': {
      const res = await engine.executeEnvCookieSync(cmd.input);
      await broadcastUiStateNow();
      return res;
    }

    case 'IMPORT_RULES_JSON': {
      await engine.importRulesJson(cmd.payload);
      await propagateExtendedMonitorsToOpenTabs(engine);
      await broadcastUiStateNow();
      return { imported: true };
    }

    case 'EXPORT_RULES_JSON':
      return engine.exportRulesJson();

    case 'GET_DEVICES':
      return engine.getDevices();

    case 'RENAME_DEVICE': {
      await engine.renameDevice(cmd.deviceId, cmd.name);
      await broadcastUiStateNow();
      return { renamed: true };
    }

    case 'SET_DEVICE_STATE': {
      await engine.setDeviceState(cmd.deviceId, cmd.state);
      await broadcastUiStateNow();
      return { updated: true };
    }

    case 'GET_HISTORY_AND_LOGS':
      return engine.getHistoryAndLogs({
        siteKey: cmd.siteKey,
        objectId: cmd.objectId,
        limit: cmd.limit,
      });

    case 'RESTORE_HISTORICAL_EVENT': {
      await engine.restoreHistoricalEvent(cmd.eventId);
      await broadcastUiStateNow();
      return { restored: true };
    }

    case 'GET_CONFLICTS':
      return engine.getConflicts();

    case 'RESOLVE_CONFLICT': {
      await engine.resolveConflict(cmd.conflictId, cmd.choose);
      await broadcastUiStateNow();
      return { resolved: true };
    }

    case 'GET_UNDO_POINTS':
      return engine.getUndoPoints();

    case 'APPLY_UNDO_POINT': {
      await engine.applyUndoPoint(cmd.undoId);
      await broadcastUiStateNow();
      return { applied: true };
    }

    case 'WEBDAV_LIST_DIR':
      return engine.listRemoteDir(cmd.subPath);

    case 'WEBDAV_CHECK_INTEGRITY':
      return engine.checkIntegrity();

    case 'WEBDAV_REBUILD_INDEX': {
      await engine.rebuildIndex();
      await broadcastUiStateNow();
      return { rebuilt: true };
    }

    case 'WEBDAV_CREATE_SNAPSHOT': {
      const res = await engine.createSnapshot();
      await broadcastUiStateNow();
      return res;
    }

    case 'WEBDAV_GARBAGE_COLLECT': {
      const res = await engine.garbageCollectHistory();
      await broadcastUiStateNow();
      return res;
    }

    case 'WEBDAV_CREATE_BACKUP':
      return engine.createBackup();

    case 'WEBDAV_LIST_BACKUPS':
      return engine.listBackups();

    case 'WEBDAV_RESTORE_BACKUP': {
      await engine.restoreBackup(cmd.backupId);
      await broadcastUiStateNow();
      return { restored: true };
    }

    case 'EXPORT_ARCHIVE_BACKUP': {
      const res = await engine.exportArchiveBackup(cmd.passphrase);
      return {
        base64: res.base64,
        suggestedFilename: res.suggestedFilename,
        byteLength: res.byteLength,
      };
    }

    case 'IMPORT_ARCHIVE_BACKUP': {
      const res = await engine.importArchiveBackup({
        base64: cmd.base64,
        passphrase: cmd.passphrase,
        mode: cmd.mode,
      });
      scheduleFlushAlarm();
      await broadcastUiStateNow();
      return res;
    }

    case 'CONTENT_PAGE_MOUNTED': {
      await engine.ingestLocalStorageSnapshot(cmd.origin, cmd.items);
      if (cmd.sessionItems) {
        await engine.ingestSessionStorageSnapshot(cmd.origin, cmd.sessionItems);
      }
      const mountConfig = await engine.getPageMountConfig(cmd.origin);
      const siteKey = resolveSiteKey(cmd.origin, engine.getCachedSsoGroups());
      const pendingToast =
        sender?.tab?.id !== undefined ? await consumePendingTabAccountToast(sender.tab.id, siteKey || undefined) : null;
      if (mountConfig.syncSessionStorage || mountConfig.syncIndexedDb) {
        setTimeout(() => {
          void ensureEngineReady()
            .then(async eng => {
              await eng.reconcileOriginExtendedStorage(cmd.origin);
              await broadcastUiStateNow();
            })
            .catch(() => undefined);
        }, 80);
      }
      await broadcastUiStateNow();
      const response: ContentPageMountConfig = {
        ...mountConfig,
        pendingToast,
      };
      return response;
    }

    case 'CONTENT_LOCAL_STORAGE_CHANGED': {
      await engine.ingestLocalStorageMutations(cmd.origin, cmd.changes);
      await broadcastUiStateNow();
      return { acknowledged: true };
    }

    case 'CONTENT_SESSION_STORAGE_CHANGED': {
      await engine.ingestSessionStorageMutations(cmd.origin, cmd.changes);
      await broadcastUiStateNow();
      return { acknowledged: true };
    }

    case 'CONTENT_INDEXED_DB_CHANGED': {
      await engine.captureOriginIndexedDb(cmd.origin);
      await broadcastUiStateNow();
      return { acknowledged: true };
    }

    case 'CONTENT_PAGE_LEAVING': {
      if (cmd.changes.length > 0) {
        await engine.ingestLocalStorageMutations(cmd.origin, cmd.changes, { isPageLeaving: true });
      }
      if (cmd.sessionChanges && cmd.sessionChanges.length > 0) {
        await engine.ingestSessionStorageMutations(cmd.origin, cmd.sessionChanges, { isPageLeaving: true });
      }
      // Delay briefly so Chromium updates/closes the unloading tab before checking if any tab for this site remains open;
      // keeps same-site navigations deferred in on_page_leave mode without blocking real cross-site leave/close dedupe.
      setTimeout(() => {
        void ensureEngineReady()
          .then(async eng => {
            await eng.onSitePageLeft(cmd.origin);
            await broadcastUiStateNow();
          })
          .catch(() => undefined);
      }, 180);
      return { acknowledged: true };
    }

    default: {
      const exhaustiveCheck: never = cmd;
      throw new Error(`Unsupported SessionMeshCommand: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

// =============================================================================
// Top-Level MV3 Event Registrations (MUST be synchronous at module evaluation)
// =============================================================================

async function performTabAccountRotation(
  direction: 'next' | 'prev',
  tabUrl?: string,
  explicitTabId?: number,
): Promise<void> {
  if (!isSyncableHttpUrl(tabUrl)) return;
  const engine = await ensureEngineReady();
  const ssoGroups = engine.getCachedSsoGroups();
  const siteKey = resolveSiteKey(tabUrl!, ssoGroups);
  if (!siteKey) return;

  let targetTabId = explicitTabId;
  if (targetTabId === undefined) {
    const activeTabs = await browserAdapter.queryTabs({ active: true }).catch(() => []);
    targetTabId = activeTabs.find(t => t.url === tabUrl)?.id;
  }

  const previewToast = await resolveNextRotationPreviewToast(engine, siteKey, direction);
  if (targetTabId !== undefined && previewToast) {
    await savePendingTabAccountToast(targetTabId, previewToast);
  }

  const res = await engine.rotateSiteTrack(siteKey, direction);
  if (targetTabId !== undefined) {
    const exactToast = (await buildAccountSwitchToast(engine, siteKey, res.track.trackId)) ?? {
      siteKey,
      label: res.track.label,
      badgeText: deriveTrackBadgeText(res.track, res.index, res.total),
      color: res.track.color,
      index: res.index,
      total: res.total,
    };
    if (res.total <= 1 || res.previousTrackId === res.track.trackId || !res.reloadedTabs) {
      await consumePendingTabAccountToast(targetTabId, siteKey);
      await browserAdapter.sendAccountToastToTab(targetTabId, exactToast);
    } else {
      const stillPending = await consumePendingTabAccountToast(targetTabId, siteKey);
      if (stillPending) {
        await savePendingTabAccountToast(targetTabId, exactToast);
      }
    }
  }

  scheduleFlushAlarm();
  await broadcastUiStateNow();
}

// 1. Context menu click listener (top-level so it survives SW restarts)
registerContextMenuListener({
  onAddManagedSite: async tabUrl => {
    if (!isSyncableHttpUrl(tabUrl)) return;
    try {
      const engine = await ensureEngineReady();
      const rules = await engine.getRulesAndBlacklist().catch(() => null);
      const siteKey = resolveSiteKey(tabUrl!, rules?.ssoGroups);
      if (!siteKey) return;
      await engine.addManagedSites([siteKey]);
      scheduleFlushAlarm();
      await broadcastUiStateNow();
    } catch (err) {
      console.warn('SessionMesh contextMenu addManagedSite failed:', err);
    }
  },
  onRotateSiteAccount: async tabUrl => {
    try {
      await performTabAccountRotation('next', tabUrl);
    } catch (err) {
      console.warn('SessionMesh contextMenu rotateSiteAccount failed:', err);
    }
  },
  onSyncCurrentSite: async tabUrl => {
    try {
      const engine = await ensureEngineReady();
      const ssoGroups = engine.getCachedSsoGroups();
      const siteKey = isSyncableHttpUrl(tabUrl) ? resolveSiteKey(tabUrl!, ssoGroups) : undefined;
      await engine.syncNow(siteKey ? { siteKey, userInitiated: true } : { userInitiated: true });
      await broadcastUiStateNow();
    } catch (err) {
      console.warn('SessionMesh contextMenu sync failed:', err);
    }
  },
  onTogglePause: async () => {
    try {
      const engine = await ensureEngineReady();
      const summary = await engine.getStatusSummary();
      await engine.setGlobalPaused(summary.status !== 'PAUSED');
      await broadcastUiStateNow();
    } catch (err) {
      console.warn('SessionMesh contextMenu toggle pause failed:', err);
    }
  },
  onBlacklistCurrentSite: async tabUrl => {
    if (!isSyncableHttpUrl(tabUrl)) return;
    try {
      const engine = await ensureEngineReady();
      const siteKey = resolveSiteKey(tabUrl!, engine.getCachedSsoGroups());
      if (!siteKey) return;
      await engine.addBlacklistEntry({
        pattern: `*.${siteKey}`,
        matchType: 'subdomain',
        scope: 'device',
        reason: 'Added from context menu',
        presetCategory: 'custom',
      });
      await broadcastUiStateNow();
    } catch (err) {
      console.warn('SessionMesh contextMenu blacklist failed:', err);
    }
  },
});

// 1b. Keyboard shortcut commands listener (top-level so it survives SW restarts)
registerCommandShortcutsListener({
  onRotateAccount: async (direction, tab) => {
    try {
      await performTabAccountRotation(direction, tab?.url, tab?.id);
    } catch (err) {
      console.warn('SessionMesh shortcut rotateAccount failed:', err);
    }
  },
  onSyncCurrentSite: async tab => {
    try {
      const engine = await ensureEngineReady();
      const ssoGroups = engine.getCachedSsoGroups();
      const siteKey = isSyncableHttpUrl(tab?.url) ? resolveSiteKey(tab!.url!, ssoGroups) : undefined;
      await engine.syncNow(siteKey ? { siteKey, userInitiated: true } : { userInitiated: true });
      await broadcastUiStateNow();
      if (tab?.id !== undefined && siteKey) {
        const isEn = localeStorage.resolve() === 'en';
        await browserAdapter.sendAccountToastToTab(tab.id, {
          siteKey,
          label: siteKey,
          message: isEn ? 'Current site synced' : '当前站点已完成双向同步',
        });
      }
    } catch (err) {
      console.warn('SessionMesh shortcut syncCurrentSite failed:', err);
    }
  },
  onCopyCurrentCurl: async tab => {
    if (!tab?.url || !isSyncableHttpUrl(tab.url) || tab.id === undefined) return;
    try {
      const engine = await ensureEngineReady();
      const res = await engine.exportDebugState({
        targetUrl: tab.url,
        format: 'curl',
      });
      const isEn = localeStorage.resolve() === 'en';
      await browserAdapter.copyTextInTab(
        tab.id,
        res.content,
        isEn
          ? `Copied cURL for ${res.siteKey} (contains live session)`
          : `已复制 ${res.siteKey} 的 cURL 命令（含敏感登录态，切勿外泄）`,
      );
    } catch (err) {
      console.warn('SessionMesh shortcut copyCurrentCurl failed:', err);
    }
  },
});

// Rebuild right-click menus and refresh toolbar badge tooltips whenever UI language changes
localeStorage.subscribe(() => {
  setupContextMenus(localeStorage.resolve());
  void broadcastUiStateNow();
});

// 2. Runtime install & update lifecycle
chrome.runtime.onInstalled.addListener(details => {
  try {
    chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => undefined);
  } catch {
    // ignore on browsers without sidePanel
  }

  setupContextMenus();
  void ensureExpiryCheckAlarm();

  void ensureEngineReady()
    .then(() => broadcastUiStateNow())
    .catch(err => console.warn('SessionMesh init onInstalled error:', err));

  if (details.reason === 'install') {
    const onboardingUrl = chrome.runtime.getURL('options/index.html?onboarding=1');
    chrome.tabs.create({ url: onboardingUrl }, () => {
      void chrome.runtime.lastError;
    });
  }
});

// 3. Browser startup lifecycle
chrome.runtime.onStartup.addListener(() => {
  setupContextMenus();
  seedTabUrlCache();
  void ensureExpiryCheckAlarm();
  void ensureEngineReady()
    .then(async engine => {
      await engine.cleanupExpiredEphemeralTracks().catch(() => 0);
      const summary = await engine.getStatusSummary();
      const settings = await engine.getSpaceSettings();
      if (summary.configured && !summary.locked && settings.autoSync && summary.status !== 'PAUSED') {
        // Recover any pre-exit cookie edits, flush leftover closed-session edits, and silently pull remote updates
        await engine.reconcileLocalManagedCookies();
        await engine.flushPendingLocalChanges();
        await engine.syncNow({
          direction: settings.syncTimingMode === 'on_page_leave' ? 'pull' : 'both',
          triggerRefresh: false,
        });
      }
      await broadcastUiStateNow();
    })
    .catch(err => console.warn('SessionMesh init onStartup error:', err));
});

// 4. Alarms for periodic polling, durable debounced flush & ephemeral/expiry checks
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_POLL) {
    void ensureEngineReady()
      .then(async engine => {
        const summary = await engine.getStatusSummary();
        const settings = await engine.getSpaceSettings();
        if (
          summary.configured &&
          !summary.locked &&
          settings.autoSync &&
          settings.backgroundCheck &&
          summary.status !== 'PAUSED'
        ) {
          // Safety-net flush: drains any closed-tab pending events (open tabs remain held in on_page_leave mode!)
          await engine.flushPendingLocalChanges();
          // Background poll writes cookies silently (never hijacks/reloads active tabs)
          await engine.syncNow({
            direction: settings.syncTimingMode === 'on_page_leave' ? 'pull' : 'both',
            triggerRefresh: false,
          });
          await broadcastUiStateNow();
        }
      })
      .catch(err => console.warn('SessionMesh poll alarm error:', err));
  } else if (alarm.name === ALARM_FLUSH) {
    scheduledAutoPushAt = 0;
    cookieFlushAlarmArmedUntil = 0;
    void ensureEngineReady()
      .then(async engine => {
        await engine.flushPendingLocalChanges();
        await broadcastUiStateNow();
      })
      .catch(err => console.warn('SessionMesh flush alarm error:', err));
  } else if (alarm.name === ALARM_EXPIRY_CHECK) {
    void ensureEngineReady()
      .then(async engine => {
        await engine.cleanupExpiredEphemeralTracks();
        await broadcastUiStateNow();
      })
      .catch(err => console.warn('SessionMesh expiry check alarm error:', err));
  }
});

// 5. Navigation & Tab close/leave lifecycle triggers (upload on leave/close; silent pull on site entry; never re-trigger on reloads!)
chrome.tabs.onCreated.addListener(tab => {
  if (tab.id !== undefined && tab.url && isSyncableHttpUrl(tab.url)) {
    rememberTabUrl(tab.id, tab.url);
    // Trigger initial silent visit check here too (recentSiteVisits dedupes against onCommitted)
    void handleSiteVisited(tab.url, tab.id);
    void ensureEngineReady()
      .then(async engine => {
        const summary = await engine.getStatusSummary(tab.url);
        await refreshTabBadgeForUrl(engine, tab.id!, tab.url, summary);
      })
      .catch(() => undefined);
  }
});

chrome.webNavigation?.onCommitted.addListener(details => {
  if (details.frameId !== 0) return;
  const isReload = details.transitionType === 'reload' || details.transitionType === 'auto_subframe';
  void handleTabNavigationChange(details.tabId, details.url, isReload);
  void ensureEngineReady()
    .then(async engine => {
      const summary = await engine.getStatusSummary(details.url);
      await refreshTabBadgeForUrl(engine, details.tabId, details.url, summary);
    })
    .catch(() => undefined);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // ONLY trigger navigation/visit sync on URL changes — NEVER on status='loading' (prevents reload loops!)
  if (changeInfo.url) {
    void handleTabNavigationChange(tabId, changeInfo.url, false);
  }
  if (changeInfo.url || changeInfo.status === 'complete') {
    const activeUrl = changeInfo.url ?? tab?.url;
    void ensureEngineReady()
      .then(async engine => {
        const summary = await engine.getStatusSummary(activeUrl);
        await refreshTabBadgeForUrl(engine, tabId, activeUrl, summary);
      })
      .catch(() => undefined);
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  void handleTabRemoved(tabId);
});

chrome.tabs.onActivated.addListener(activeInfo => {
  // Keep tabUrlById fresh and update active tab badge without triggering disruptive pulls or reloads
  chrome.tabs.get(activeInfo.tabId, tab => {
    if (chrome.runtime.lastError || !tab?.url || tab.id === undefined) return;
    if (isSyncableHttpUrl(tab.url)) {
      rememberTabUrl(tab.id, tab.url);
    }
    void ensureEngineReady()
      .then(async engine => {
        const summary = await engine.getStatusSummary(tab.url);
        await refreshTabBadgeForUrl(engine, tab.id!, tab.url, summary);
      })
      .catch(() => undefined);
  });
});

// 6. Runtime IPC command router (Popup / Options / SidePanel / Content Script -> Background)
chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: SessionMeshResponse) => void,
  ): boolean | void => {
    if (!message || typeof message !== 'object' || !('type' in message)) {
      return;
    }

    const cmd = message as SessionMeshCommand;
    // Ignore ContentScriptCommand types (those are sent Background -> Content Script)
    if (typeof cmd.type !== 'string' || cmd.type.startsWith('CS_')) {
      return;
    }

    void executeCommand(cmd, sender)
      .then(data => {
        sendResponse({ ok: true, data });
      })
      .catch(err => {
        const structured = toStructuredError(err, 'background');
        sendResponse({
          ok: false,
          error: {
            code: structured.code,
            phase: structured.phase,
            message: structured.message,
            suggestion: structured.suggestion,
          },
        });
      });

    // Keep message channel open for async sendResponse
    return true;
  },
);

// Kick off lazy initialization when Service Worker starts
void ensureEngineReady().catch(err => {
  console.warn('SessionMesh initial startup warning:', err);
});
