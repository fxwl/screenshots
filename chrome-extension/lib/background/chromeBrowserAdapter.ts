import type {
  BrowserApiAdapter,
  BrowserCookieChangeCause,
  BrowserCookieChangeEvent,
  BrowserCookieInput,
  BrowserTabInfo,
  IndexedDbMutation,
  IndexedDbRecord,
  IndexedDbTargetRule,
  InspectedIndexedDbDatabase,
  PageReloadSafetyStatus,
  PartitionKeyInfo,
  SameSiteValue,
} from '@sessionmesh/core';
import type { AccountSwitchToastPayload, ContentScriptCommand } from '@sessionmesh/shared';

type ChromeCookieWithPartition = chrome.cookies.Cookie & {
  partitionKey?: PartitionKeyInfo;
};

type ChromeSetDetailsWithPartition = chrome.cookies.SetDetails & {
  partitionKey?: PartitionKeyInfo;
};

type ChromeCookieDetailsWithPartition = chrome.cookies.Details & {
  partitionKey?: PartitionKeyInfo;
};

const CONTENT_MESSAGE_TIMEOUT_MS = 2_000;
const MAX_BUFFERED_COOKIE_EVENTS = 500;

function mapSameSite(raw?: string): SameSiteValue {
  switch (raw) {
    case 'no_restriction':
      return 'no_restriction';
    case 'lax':
      return 'lax';
    case 'strict':
      return 'strict';
    default:
      return 'unspecified';
  }
}

function mapCookieCause(raw?: string): BrowserCookieChangeCause {
  switch (raw) {
    case 'evicted':
    case 'expired':
    case 'explicit':
    case 'expired_overwrite':
    case 'overwrite':
      return raw;
    default:
      return 'explicit';
  }
}

function normalizePartitionKey(raw?: PartitionKeyInfo | null): PartitionKeyInfo | null {
  if (!raw || !raw.topLevelSite) return null;
  const info: PartitionKeyInfo = { topLevelSite: raw.topLevelSite };
  if (raw.hasCrossSiteAncestor !== undefined) {
    info.hasCrossSiteAncestor = Boolean(raw.hasCrossSiteAncestor);
  }
  return info;
}

function normalizeAdapterStoreId(storeId?: string): string {
  if (!storeId || storeId === '0' || storeId === 'firefox-default' || storeId === 'default') {
    return 'default';
  }
  return storeId;
}

function toBrowserCookieInput(cookie: ChromeCookieWithPartition): BrowserCookieInput {
  return {
    domain: cookie.domain,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path || '/',
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: mapSameSite(cookie.sameSite),
    session: Boolean(cookie.session),
    expirationDate: cookie.session ? undefined : cookie.expirationDate,
    hostOnly: Boolean(cookie.hostOnly),
    storeId: normalizeAdapterStoreId(cookie.storeId),
    partitionKey: normalizePartitionKey(cookie.partitionKey),
  };
}

function isPartitionKeyUnsupportedError(errMsg: string): boolean {
  const lower = errMsg.toLowerCase();
  return (
    lower.includes('partitionkey') ||
    lower.includes('partition_key') ||
    lower.includes('unexpected property') ||
    lower.includes('unknown property')
  );
}

function ensureHttpsUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.protocol = 'https:';
    return parsed.toString();
  } catch {
    return rawUrl.replace(/^http:\/\//i, 'https://');
  }
}

function isExactTabOrigin(tabUrl: string | undefined, expectedOrigin: string): boolean {
  if (!tabUrl) return false;
  try {
    return new URL(tabUrl).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function sendTabMessageWithTimeout<T>(
  tabId: number,
  command: ContentScriptCommand,
  timeoutMs = CONTENT_MESSAGE_TIMEOUT_MS,
): Promise<T | null> {
  return new Promise<T | null>(resolve => {
    let settled = false;
    const finish = (val: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    try {
      chrome.tabs.sendMessage(tabId, command, (response: T | undefined) => {
        if (chrome.runtime.lastError) {
          finish(null);
          return;
        }
        finish(response ?? null);
      });
    } catch {
      finish(null);
    }
  });
}

function parseBrowserFromUserAgent(ua: string): { browser: string; browserVersion: string } {
  const edgeMatch = ua.match(/Edg\/([\d.]+)/);
  if (edgeMatch) return { browser: 'Edge', browserVersion: edgeMatch[1] };

  const firefoxMatch = ua.match(/Firefox\/([\d.]+)/);
  if (firefoxMatch) return { browser: 'Firefox', browserVersion: firefoxMatch[1] };

  const chromeMatch = ua.match(/Chrome\/([\d.]+)/);
  if (chromeMatch) return { browser: 'Chrome', browserVersion: chromeMatch[1] };

  return { browser: 'Chromium', browserVersion: 'unknown' };
}

export interface ChromeBrowserAdapterOptions {
  /**
   * Optional hook invoked whenever a raw chrome.cookies.onChanged event arrives.
   * Useful for waking SyncEngine and scheduling MV3 flush alarms on cold wakeups.
   */
  onRawCookieActivity?: (event: BrowserCookieChangeEvent) => void;
}

/**
 * MV3 Chrome/Edge implementation of @sessionmesh/core's BrowserApiAdapter.
 * Registers chrome.cookies.onChanged synchronously upon construction so cold
 * Service Worker wakeups never lose the triggering cookie event.
 */
export class ChromeBrowserAdapter implements BrowserApiAdapter {
  private readonly cookieListeners = new Set<(event: BrowserCookieChangeEvent) => void>();
  private readonly bufferedCookieEvents: BrowserCookieChangeEvent[] = [];
  private readonly onRawCookieActivity?: (event: BrowserCookieChangeEvent) => void;
  private partitionKeySupported = true;

  constructor(options?: ChromeBrowserAdapterOptions) {
    this.onRawCookieActivity = options?.onRawCookieActivity;

    if (typeof chrome !== 'undefined' && chrome.cookies?.onChanged) {
      chrome.cookies.onChanged.addListener(this.handleRawChromeCookieChange);
    }
  }

  private readonly handleRawChromeCookieChange = (changeInfo: chrome.cookies.CookieChangeInfo): void => {
    const event: BrowserCookieChangeEvent = {
      removed: Boolean(changeInfo.removed),
      cookie: toBrowserCookieInput(changeInfo.cookie as ChromeCookieWithPartition),
      cause: mapCookieCause(changeInfo.cause),
    };

    try {
      this.onRawCookieActivity?.(event);
    } catch {
      // ignore activity hook failures
    }

    if (this.cookieListeners.size === 0) {
      if (this.bufferedCookieEvents.length < MAX_BUFFERED_COOKIE_EVENTS) {
        this.bufferedCookieEvents.push(event);
      }
      return;
    }

    for (const listener of this.cookieListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('SessionMesh cookie listener error:', err);
      }
    }
  };

  private getAllCookiesOnce(
    details: chrome.cookies.GetAllDetails & { partitionKey?: Record<string, unknown> },
  ): Promise<{ cookies: BrowserCookieInput[]; error?: string }> {
    return new Promise(resolve => {
      try {
        chrome.cookies.getAll(details as chrome.cookies.GetAllDetails, cookies => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            resolve({ cookies: [], error: lastError.message || 'cookies.getAll failed' });
            return;
          }
          resolve({
            cookies: (cookies ?? []).map(c => toBrowserCookieInput(c as ChromeCookieWithPartition)),
          });
        });
      } catch (err) {
        resolve({ cookies: [], error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  async getAllCookies(filter?: { domain?: string; url?: string; storeId?: string }): Promise<BrowserCookieInput[]> {
    const details: chrome.cookies.GetAllDetails & { partitionKey?: Record<string, unknown> } = {};
    if (filter?.domain) details.domain = filter.domain;
    if (filter?.url) details.url = filter.url;
    if (filter?.storeId && filter.storeId !== 'default') details.storeId = filter.storeId;

    if (this.partitionKeySupported) {
      // Chromium omits CHIPS partitioned cookies unless partitionKey: {} is explicitly provided.
      const withPartitions = await this.getAllCookiesOnce({ ...details, partitionKey: {} });
      if (!withPartitions.error) {
        return withPartitions.cookies;
      }
      if (isPartitionKeyUnsupportedError(withPartitions.error)) {
        this.partitionKeySupported = false;
      } else {
        return [];
      }
    }

    const unpartitioned = await this.getAllCookiesOnce(details);
    return unpartitioned.cookies;
  }

  private getCookieOnce(
    details: ChromeCookieDetailsWithPartition,
  ): Promise<{ cookie: BrowserCookieInput | null; error?: string }> {
    return new Promise(resolve => {
      try {
        chrome.cookies.get(details as chrome.cookies.Details, cookie => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            resolve({ cookie: null, error: lastError.message || 'cookies.get failed' });
            return;
          }
          resolve({
            cookie: cookie ? toBrowserCookieInput(cookie as ChromeCookieWithPartition) : null,
          });
        });
      } catch (err) {
        resolve({ cookie: null, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  async getCookie(details: {
    url: string;
    name: string;
    storeId?: string;
    partitionKey?: PartitionKeyInfo | null;
  }): Promise<BrowserCookieInput | null> {
    const req: ChromeCookieDetailsWithPartition = {
      url: details.url,
      name: details.name,
    };
    if (details.storeId && details.storeId !== 'default') req.storeId = details.storeId;

    const partition = normalizePartitionKey(details.partitionKey);
    if (partition && this.partitionKeySupported) {
      req.partitionKey = partition;
    }

    const first = await this.getCookieOnce(req);
    if (!first.error) {
      return first.cookie;
    }

    if (req.partitionKey && isPartitionKeyUnsupportedError(first.error)) {
      this.partitionKeySupported = false;
      delete req.partitionKey;
      const retry = await this.getCookieOnce(req);
      return retry.cookie;
    }

    return null;
  }

  private setCookieOnce(
    details: ChromeSetDetailsWithPartition,
  ): Promise<{ cookie: BrowserCookieInput | null; error?: string }> {
    return new Promise(resolve => {
      try {
        chrome.cookies.set(details as chrome.cookies.SetDetails, cookie => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            resolve({ cookie: null, error: lastError.message || 'cookies.set failed' });
            return;
          }
          if (!cookie) {
            resolve({ cookie: null, error: 'Browser rejected cookie without explicit error' });
            return;
          }
          resolve({ cookie: toBrowserCookieInput(cookie as ChromeCookieWithPartition) });
        });
      } catch (err) {
        resolve({ cookie: null, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  async setCookie(
    details: BrowserCookieInput & { url: string },
  ): Promise<{ cookie: BrowserCookieInput | null; error?: string }> {
    const isHostPrefix = details.name.startsWith('__Host-');
    const isSecurePrefix = details.name.startsWith('__Secure-');
    const mustBeSecure = details.secure || isHostPrefix || isSecurePrefix || details.sameSite === 'no_restriction';

    const targetUrl = mustBeSecure ? ensureHttpsUrl(details.url) : details.url;
    const setDetails: ChromeSetDetailsWithPartition = {
      url: targetUrl,
      name: details.name,
      value: details.value,
      path: isHostPrefix ? '/' : details.path || '/',
      secure: mustBeSecure,
      httpOnly: Boolean(details.httpOnly),
      sameSite: details.sameSite,
    };

    // CRITICAL Chromium rule: NEVER pass `domain` for `__Host-` or `hostOnly` cookies!
    if (!isHostPrefix && !details.hostOnly && details.domain) {
      setDetails.domain = details.domain;
    }

    if (!details.session && typeof details.expirationDate === 'number' && Number.isFinite(details.expirationDate)) {
      setDetails.expirationDate = details.expirationDate;
    }

    if (details.storeId && details.storeId !== 'default') {
      setDetails.storeId = details.storeId;
    }

    const partition = normalizePartitionKey(details.partitionKey);
    if (partition && this.partitionKeySupported) {
      setDetails.partitionKey = partition;
    }

    const first = await this.setCookieOnce(setDetails);
    if (!first.error) {
      return first;
    }

    // Feature-detection fallback if runtime browser rejects partitionKey
    if (setDetails.partitionKey) {
      if (isPartitionKeyUnsupportedError(first.error)) {
        this.partitionKeySupported = false;
      }
      delete setDetails.partitionKey;
      return await this.setCookieOnce(setDetails);
    }

    return first;
  }

  private removeCookieOnce(details: ChromeCookieDetailsWithPartition): Promise<{ error?: string }> {
    return new Promise(resolve => {
      try {
        chrome.cookies.remove(details as chrome.cookies.Details, () => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            resolve({ error: lastError.message });
            return;
          }
          resolve({});
        });
      } catch (err) {
        resolve({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  async removeCookie(details: {
    url: string;
    name: string;
    storeId?: string;
    partitionKey?: PartitionKeyInfo | null;
  }): Promise<void> {
    const req: ChromeCookieDetailsWithPartition = {
      url: details.url,
      name: details.name,
    };
    if (details.storeId && details.storeId !== 'default') req.storeId = details.storeId;

    const partition = normalizePartitionKey(details.partitionKey);
    if (partition && this.partitionKeySupported) {
      req.partitionKey = partition;
    }

    const first = await this.removeCookieOnce(req);
    if (first.error && req.partitionKey) {
      if (isPartitionKeyUnsupportedError(first.error)) {
        this.partitionKeySupported = false;
      }
      delete req.partitionKey;
      await this.removeCookieOnce(req);
    }
  }

  onCookieChanged(listener: (event: BrowserCookieChangeEvent) => void): () => void {
    this.cookieListeners.add(listener);

    // Replay any events captured during cold MV3 Service Worker startup
    if (this.bufferedCookieEvents.length > 0) {
      const pending = this.bufferedCookieEvents.splice(0, this.bufferedCookieEvents.length);
      for (const evt of pending) {
        try {
          listener(evt);
        } catch (err) {
          console.error('SessionMesh buffered cookie replay error:', err);
        }
      }
    }

    return () => {
      this.cookieListeners.delete(listener);
    };
  }

  async queryTabs(filter?: { active?: boolean; url?: string }): Promise<BrowserTabInfo[]> {
    return new Promise<BrowserTabInfo[]>(resolve => {
      const queryInfo: chrome.tabs.QueryInfo = {};
      if (filter?.active !== undefined) queryInfo.active = filter.active;
      if (filter?.url !== undefined) queryInfo.url = filter.url;

      try {
        chrome.tabs.query(queryInfo, tabs => {
          if (chrome.runtime.lastError || !tabs) {
            resolve([]);
            return;
          }
          const result: BrowserTabInfo[] = [];
          for (const tab of tabs) {
            if (typeof tab.id !== 'number') continue;
            result.push({
              id: tab.id,
              url: tab.url,
              title: tab.title,
              favIconUrl: tab.favIconUrl,
              active: Boolean(tab.active),
              windowId: tab.windowId,
              status: tab.status === 'loading' || tab.status === 'complete' ? tab.status : undefined,
            });
          }
          resolve(result);
        });
      } catch {
        resolve([]);
      }
    });
  }

  async reloadTab(tabId: number): Promise<void> {
    return new Promise<void>(resolve => {
      try {
        chrome.tabs.reload(tabId, {}, () => {
          // Consume lastError gracefully (e.g. tab already closed)
          void chrome.runtime.lastError;
          resolve();
        });
      } catch {
        resolve();
      }
    });
  }

  async checkTabSafeToReload(tabId: number): Promise<PageReloadSafetyStatus> {
    const res = await sendTabMessageWithTimeout<PageReloadSafetyStatus>(tabId, {
      type: 'CS_CHECK_PAGE_SAFE_TO_RELOAD',
    });

    // Conservative safety policy: if content script probe is unreachable, defer reload
    if (!res || typeof res.safe !== 'boolean') {
      return {
        safe: false,
        reasons: ['probe_unreachable'],
      };
    }

    return {
      safe: res.safe,
      reasons: Array.isArray(res.reasons) ? res.reasons : [],
    };
  }

  private async findTabsByExactOrigin(origin: string): Promise<BrowserTabInfo[]> {
    const allTabs = await this.queryTabs();
    const matched = allTabs.filter(tab => isExactTabOrigin(tab.url, origin));
    // Prioritize active tabs first
    matched.sort((a, b) => Number(b.active) - Number(a.active));
    return matched;
  }

  private async getOriginStorage(
    origin: string,
    type: 'CS_GET_LOCAL_STORAGE' | 'CS_GET_SESSION_STORAGE',
  ): Promise<{ available: boolean; items: Record<string, string> }> {
    const tabs = await this.findTabsByExactOrigin(origin);
    for (const tab of tabs) {
      const res = await sendTabMessageWithTimeout<{ available: boolean; items: Record<string, string> }>(tab.id, {
        type,
        origin,
      });
      if (res?.available) {
        return {
          available: true,
          items: res.items ?? {},
        };
      }
    }
    return { available: false, items: {} };
  }

  private async applyOriginStorageMutations(
    origin: string,
    command: ContentScriptCommand,
  ): Promise<{ applied: boolean; reason?: string }> {
    const tabs = await this.findTabsByExactOrigin(origin);
    if (tabs.length === 0) {
      return { applied: false, reason: 'no_open_tab_for_origin' };
    }

    // Apply to all open tabs of this exact origin so every tab updates its echo-suppression baseline
    let anyApplied = false;
    let lastReason: string | undefined;

    for (const tab of tabs) {
      const res = await sendTabMessageWithTimeout<{ applied: boolean; reason?: string }>(tab.id, command);
      if (res?.applied) {
        anyApplied = true;
      } else if (res?.reason) {
        lastReason = res.reason;
      }
    }

    return anyApplied ? { applied: true } : { applied: false, reason: lastReason ?? 'content_script_unreachable' };
  }

  async getLocalStorage(origin: string): Promise<{ available: boolean; items: Record<string, string> }> {
    return this.getOriginStorage(origin, 'CS_GET_LOCAL_STORAGE');
  }

  async applyLocalStorage(
    origin: string,
    mutations: Array<{ key: string; value?: string; deleted?: boolean }>,
  ): Promise<{ applied: boolean; reason?: string }> {
    return this.applyOriginStorageMutations(origin, {
      type: 'CS_APPLY_LOCAL_STORAGE',
      origin,
      mutations,
    });
  }

  async getSessionStorage(origin: string): Promise<{ available: boolean; items: Record<string, string> }> {
    return this.getOriginStorage(origin, 'CS_GET_SESSION_STORAGE');
  }

  async applySessionStorage(
    origin: string,
    mutations: Array<{ key: string; value?: string; deleted?: boolean }>,
  ): Promise<{ applied: boolean; reason?: string }> {
    return this.applyOriginStorageMutations(origin, {
      type: 'CS_APPLY_SESSION_STORAGE',
      origin,
      mutations,
    });
  }

  async inspectIndexedDb(
    origin: string,
  ): Promise<{ available: boolean; databases: InspectedIndexedDbDatabase[]; reason?: string }> {
    const tabs = await this.findTabsByExactOrigin(origin);
    if (tabs.length === 0) {
      return { available: false, databases: [], reason: 'no_open_tab_for_origin' };
    }

    let lastReason: string | undefined;
    for (const tab of tabs) {
      const res = await sendTabMessageWithTimeout<{
        available: boolean;
        databases?: InspectedIndexedDbDatabase[];
        reason?: string;
      }>(
        tab.id,
        {
          type: 'CS_INSPECT_INDEXED_DB',
          origin,
        },
        4_000,
      );
      if (res?.available) {
        return {
          available: true,
          databases: res.databases ?? [],
        };
      }
      if (res?.reason) {
        lastReason = res.reason;
      }
    }

    return {
      available: false,
      databases: [],
      reason: lastReason ?? 'content_script_unreachable',
    };
  }

  async getIndexedDbRecords(
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
  }> {
    const tabs = await this.findTabsByExactOrigin(origin);
    if (tabs.length === 0) {
      return { available: false, totalBytes: 0, records: [], reason: 'no_open_tab_for_origin' };
    }

    let lastReason: string | undefined;
    for (const tab of tabs) {
      const res = await sendTabMessageWithTimeout<{
        available: boolean;
        quotaExceeded?: boolean;
        totalBytes?: number;
        records?: Array<
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
      }>(
        tab.id,
        {
          type: 'CS_GET_INDEXED_DB_RECORDS',
          origin,
          targets,
          maxTotalBytes,
        },
        5_000,
      );
      if (res?.available) {
        return {
          available: true,
          quotaExceeded: res.quotaExceeded,
          totalBytes: res.totalBytes ?? 0,
          records: res.records ?? [],
          reason: res.reason,
        };
      }
      if (res?.reason) {
        lastReason = res.reason;
      }
    }

    return {
      available: false,
      totalBytes: 0,
      records: [],
      reason: lastReason ?? 'content_script_unreachable',
    };
  }

  async applyIndexedDbMutations(
    origin: string,
    mutations: IndexedDbMutation[],
    clearStores?: Array<{ dbName: string; storeName: string }>,
  ): Promise<{ applied: boolean; reason?: string }> {
    const tabs = await this.findTabsByExactOrigin(origin);
    if (tabs.length === 0) {
      return { applied: false, reason: 'no_open_tab_for_origin' };
    }

    let lastReason: string | undefined;
    // IndexedDB is shared across the origin; apply once on the first responsive tab (active tab prioritized).
    for (const tab of tabs) {
      const res = await sendTabMessageWithTimeout<{ applied: boolean; reason?: string }>(
        tab.id,
        {
          type: 'CS_APPLY_INDEXED_DB_MUTATIONS',
          origin,
          mutations,
          clearStores,
        },
        5_000,
      );
      if (res?.applied) {
        return { applied: true };
      }
      if (res?.reason) {
        lastReason = res.reason;
      }
    }

    return { applied: false, reason: lastReason ?? 'content_script_unreachable' };
  }

  async configureOriginExtendedMonitors(
    origin: string,
    config: {
      syncSessionStorage: boolean;
      sessionStorageKeyAllowlist?: string[];
      syncIndexedDb: boolean;
      indexedDbTargets?: IndexedDbTargetRule[];
      indexedDbMaxTotalBytes?: number;
    },
  ): Promise<void> {
    const tabs = await this.findTabsByExactOrigin(origin);
    if (tabs.length === 0) return;

    await Promise.allSettled(
      tabs.map(tab =>
        sendTabMessageWithTimeout(tab.id, {
          type: 'CS_CONFIGURE_EXTENDED_MONITORS',
          origin,
          syncSessionStorage: config.syncSessionStorage,
          sessionStorageKeyAllowlist: config.sessionStorageKeyAllowlist,
          syncIndexedDb: config.syncIndexedDb,
          indexedDbTargets: config.indexedDbTargets,
          indexedDbMaxTotalBytes: config.indexedDbMaxTotalBytes,
        }),
      ),
    );
  }

  async sendAccountToastToTab(tabId: number, payload: AccountSwitchToastPayload): Promise<boolean> {
    const res = await sendTabMessageWithTimeout<{ shown?: boolean }>(tabId, {
      type: 'CS_SHOW_ACCOUNT_TOAST',
      payload,
    });
    return Boolean(res?.shown ?? res);
  }

  async copyTextInTab(tabId: number, text: string, toastMessage?: string): Promise<boolean> {
    const res = await sendTabMessageWithTimeout<{ copied?: boolean }>(tabId, {
      type: 'CS_COPY_TEXT_TO_CLIPBOARD',
      text,
      toastMessage,
    });
    return Boolean(res?.copied);
  }

  async getDevicePlatformInfo(): Promise<{
    browser: string;
    browserVersion: string;
    extensionVersion: string;
    platform: string;
  }> {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const { browser, browserVersion } = parseBrowserFromUserAgent(ua);
    const extensionVersion =
      typeof chrome !== 'undefined' && chrome.runtime?.getManifest ? chrome.runtime.getManifest().version : '2.0.0';

    let platform = 'unknown';
    if (typeof chrome !== 'undefined' && chrome.runtime?.getPlatformInfo) {
      platform = await new Promise<string>(resolve => {
        try {
          chrome.runtime.getPlatformInfo(info => {
            if (chrome.runtime.lastError || !info) {
              resolve('unknown');
              return;
            }
            resolve(info.os ? `${info.os}/${info.arch || 'unknown'}` : 'unknown');
          });
        } catch {
          resolve('unknown');
        }
      });
    } else if (typeof navigator !== 'undefined' && navigator.platform) {
      platform = navigator.platform;
    }

    return {
      browser,
      browserVersion,
      extensionVersion,
      platform,
    };
  }

  isOnline(): boolean {
    if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
      return navigator.onLine;
    }
    return true;
  }
}
