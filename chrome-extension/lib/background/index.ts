import {
  DEFAULT_SPACE_SETTINGS,
  resolveSiteKey,
  RulesEngine,
  SyncEngine,
  toStructuredError,
  type SiteSummaryView,
  type SpaceSettings,
  type WebDAVConfig,
} from '@sessionmesh/core';
import {
  isSyncableHttpUrl,
  type CurrentSiteSnapshot,
  type PopupSummaryPayload,
  type SessionMeshCommand,
  type SessionMeshResponse,
} from '@sessionmesh/shared';
import { IndexedDBStorageBackend, NonExtractableKeyVault, uiStateStorage } from '@sessionmesh/storage';
import { updateBadgeFromStatus } from './badge';
import { ChromeBrowserAdapter } from './chromeBrowserAdapter';
import { registerContextMenuListener, setupContextMenus } from './contextMenu';

const ALARM_POLL = 'sessionmesh-poll';
const ALARM_FLUSH = 'sessionmesh-flush';
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

async function syncVaultAndAlarms(engine: SyncEngine): Promise<void> {
  try {
    const settings = await engine.getSpaceSettings();
    await keyVault.setSessionLockEnabled(Boolean(settings.sessionLockEnabled));
    await syncPollAlarmFromSettings(settings);
  } catch (err) {
    console.warn('SessionMesh failed to sync vault/alarm settings:', err);
  }
}

async function broadcastUiStateNow(): Promise<void> {
  try {
    const engine = await ensureEngineReady();
    const summary = await engine.getStatusSummary();
    updateBadgeFromStatus(summary);
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

  return {
    siteKey,
    origin,
    url,
    favIconUrl,
    summary,
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
  const siteKey = isSyncableHttpUrl(urlOrSiteKey)
    ? resolveSiteKey(urlOrSiteKey)
    : resolveSiteKey(`https://${urlOrSiteKey}`);
  if (!siteKey) return;

  const now = Date.now();
  const prev = recentSiteLeaves.get(siteKey);
  if (prev && now - prev < SITE_LEAVE_DEDUPE_MS) {
    return;
  }
  recentSiteLeaves.set(siteKey, now);

  try {
    // Allow 150ms for any final in-flight Set-Cookie / pagehide IPC to arrive before flushing
    await new Promise(resolve => setTimeout(resolve, 150));
    const engine = await ensureEngineReady();
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

  const prevSiteKey = prevUrl && isSyncableHttpUrl(prevUrl) ? resolveSiteKey(prevUrl) : '';
  const nextSiteKey = nextUrl && isSyncableHttpUrl(nextUrl) ? resolveSiteKey(nextUrl) : '';

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

async function executeCommand(cmd: SessionMeshCommand): Promise<unknown> {
  const engine = await ensureEngineReady();

  switch (cmd.type) {
    case 'GET_STATUS_SUMMARY': {
      const status = await engine.getStatusSummary(cmd.activeUrl);
      const currentSite = await buildCurrentSiteSnapshot(engine, cmd.activeUrl);
      const [settings, webdav] = await Promise.all([
        engine.getSpaceSettings().catch(() => undefined),
        engine.getWebDAVConfig().catch(() => null),
      ]);
      updateBadgeFromStatus(status);
      const payload: PopupSummaryPayload & {
        settings?: SpaceSettings;
        webdav?: Omit<WebDAVConfig, 'password' | 'bearerToken'> | null;
      } = {
        status,
        currentSite,
        settings,
        webdav: sanitizeWebDAVConfig(webdav),
      };
      return payload;
    }

    case 'TEST_WEBDAV_CONNECTION':
      return engine.testWebDAVConnection(cmd.config);

    case 'PROBE_REMOTE_SPACES':
      return engine.probeRemoteSpaces(cmd.config);

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
      await broadcastUiStateNow();
      return { paused: cmd.paused };
    }

    case 'UPDATE_SPACE_SETTINGS': {
      const updated = await engine.updateSpaceSettings(cmd.settings);
      await keyVault.setSessionLockEnabled(Boolean(updated.sessionLockEnabled));
      await syncPollAlarmFromSettings(updated);
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

    case 'GET_SITE_COOKIES':
      return engine.getSiteCookies(cmd.siteKey, cmd.trackId);

    case 'UPSERT_COOKIE': {
      const record = await engine.upsertCookie(cmd.siteKey, cmd.cookie);
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
      const count = await engine.importCookiesJson(cmd.cookies, cmd.siteKey);
      scheduleFlushAlarm();
      await broadcastUiStateNow();
      return count;
    }

    case 'EXPORT_COOKIES_JSON':
      return engine.exportCookiesJson(cmd.siteKey);

    case 'GET_LOCAL_STORAGE_RECORDS':
      return engine.getLocalStorageRecords({
        siteKey: cmd.siteKey,
        origin: cmd.origin,
      });

    case 'UPSERT_LOCAL_STORAGE_ITEM': {
      const record = await engine.upsertLocalStorageItem(cmd.origin, cmd.key, cmd.value);
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

    case 'GET_RULES_AND_BLACKLIST':
      return engine.getRulesAndBlacklist();

    case 'ADD_BLACKLIST_ENTRY': {
      const entry = await engine.addBlacklistEntry(cmd.entry);
      await broadcastUiStateNow();
      return entry;
    }

    case 'REMOVE_BLACKLIST_ENTRY': {
      await engine.removeBlacklistEntry(cmd.id, cmd.scope);
      await broadcastUiStateNow();
      return { removed: true };
    }

    case 'UPSERT_SITE_RULE': {
      await engine.upsertSiteRule(cmd.rule);
      await broadcastUiStateNow();
      return { saved: true };
    }

    case 'REMOVE_SITE_RULE': {
      await engine.removeSiteRule(cmd.siteKey);
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

    case 'IMPORT_RULES_JSON': {
      await engine.importRulesJson(cmd.payload);
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

    case 'CONTENT_PAGE_MOUNTED': {
      await engine.ingestLocalStorageSnapshot(cmd.origin, cmd.items);
      await broadcastUiStateNow();
      return { acknowledged: true };
    }

    case 'CONTENT_LOCAL_STORAGE_CHANGED': {
      await engine.ingestLocalStorageMutations(cmd.origin, cmd.changes);
      await broadcastUiStateNow();
      return { acknowledged: true };
    }

    case 'CONTENT_PAGE_LEAVING': {
      if (cmd.changes.length > 0) {
        await engine.ingestLocalStorageMutations(cmd.origin, cmd.changes);
      }
      await engine.onSitePageLeft(cmd.origin);
      await broadcastUiStateNow();
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
  onSyncCurrentSite: async tabUrl => {
    try {
      const engine = await ensureEngineReady();
      const siteKey = isSyncableHttpUrl(tabUrl) ? resolveSiteKey(tabUrl!) : undefined;
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
      const siteKey = resolveSiteKey(tabUrl!);
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

// 2. Runtime install & update lifecycle
chrome.runtime.onInstalled.addListener(details => {
  try {
    chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => undefined);
  } catch {
    // ignore on browsers without sidePanel
  }

  setupContextMenus();

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
  void ensureEngineReady()
    .then(async engine => {
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

// 4. Alarms for periodic polling & durable debounced flush
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
  }
});

// 5. Navigation & Tab close/leave lifecycle triggers (upload on leave/close; silent pull on site entry; never re-trigger on reloads!)
chrome.tabs.onCreated.addListener(tab => {
  if (tab.id !== undefined && tab.url && isSyncableHttpUrl(tab.url)) {
    rememberTabUrl(tab.id, tab.url);
    // Trigger initial silent visit check here too (recentSiteVisits dedupes against onCommitted)
    void handleSiteVisited(tab.url, tab.id);
  }
});

chrome.webNavigation?.onCommitted.addListener(details => {
  if (details.frameId !== 0) return;
  const isReload = details.transitionType === 'reload' || details.transitionType === 'auto_subframe';
  void handleTabNavigationChange(details.tabId, details.url, isReload);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // ONLY react to URL changes — NEVER to status='loading' (which fires on every reload and causes reload loops!)
  if (changeInfo.url) {
    void handleTabNavigationChange(tabId, changeInfo.url, false);
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  void handleTabRemoved(tabId);
});

chrome.tabs.onActivated.addListener(activeInfo => {
  // Keep tabUrlById fresh without triggering disruptive pulls or reloads on every tab switch
  chrome.tabs.get(activeInfo.tabId, tab => {
    if (chrome.runtime.lastError || !tab?.url || tab.id === undefined) return;
    if (isSyncableHttpUrl(tab.url)) {
      rememberTabUrl(tab.id, tab.url);
    }
  });
});

// 6. Runtime IPC command router (Popup / Options / SidePanel / Content Script -> Background)
chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
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

    void executeCommand(cmd)
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
