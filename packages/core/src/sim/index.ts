import {
  InMemoryStorageBackend,
  isLocalOrSingleLabelHost,
  SyncEngine,
  type SyncEngineOptions,
} from '../sync';
import type {
  BrowserApiAdapter,
  BrowserCookieChangeCause,
  BrowserCookieChangeEvent,
  BrowserCookieInput,
  BrowserTabInfo,
  PageReloadSafetyStatus,
  PartitionKeyInfo,
  WebDAVConfig,
} from '../types';

interface SimTab {
  id: number;
  url: string;
  title: string;
  active: boolean;
  safeToReload: boolean;
  unsafeReasons: string[];
  probeThrows: boolean;
}

export interface SimulatedBrowserDeviceOptions {
  deviceName?: string;
  browser?: string;
  browserVersion?: string;
  extensionVersion?: string;
  platform?: string;
  clockOffsetMs?: number;
  fixedNowMs?: number;
  online?: boolean;
  rejectPartitionKey?: boolean;
}

function cloneCookie(c: BrowserCookieInput): BrowserCookieInput {
  return {
    ...c,
    partitionKey: c.partitionKey ? { ...c.partitionKey } : c.partitionKey,
  };
}

function cookieJarKey(c: {
  domain: string;
  path: string;
  name: string;
  hostOnly: boolean;
  storeId?: string;
  partitionKey?: PartitionKeyInfo | null;
}): string {
  const store = c.storeId && c.storeId !== 'default' ? c.storeId : '0';
  const pk = c.partitionKey?.topLevelSite ?? '';
  const normDom = c.hostOnly
    ? c.domain.toLowerCase().replace(/^\.+/, '')
    : c.domain.toLowerCase().startsWith('.')
      ? c.domain.toLowerCase()
      : `.${c.domain.toLowerCase()}`;
  return `${store}::${pk}::${c.hostOnly ? 'h' : 'd'}::${normDom}::${c.path || '/'}::${c.name}`;
}

function domainMatchesHost(cookieDomain: string, hostOnly: boolean, hostname: string): boolean {
  const host = hostname.toLowerCase();
  const clean = cookieDomain.toLowerCase().replace(/^\.+/, '');
  if (hostOnly) {
    return host === clean;
  }
  return host === clean || host.endsWith(`.${clean}`);
}

function pathMatches(cookiePath: string, urlPath: string): boolean {
  const cp = cookiePath || '/';
  const up = urlPath || '/';
  if (cp === '/') return true;
  if (up === cp) return true;
  if (cp.endsWith('/')) return up.startsWith(cp);
  return up.startsWith(`${cp}/`);
}

function normalizeOrigin(urlOrOrigin: string): string | null {
  try {
    const u = new URL(urlOrOrigin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

export class SimulatedBrowserDevice implements BrowserApiAdapter {
  private readonly jar = new Map<string, BrowserCookieInput>();
  private readonly cookieListeners = new Set<(event: BrowserCookieChangeEvent) => void>();
  private readonly tabs = new Map<number, SimTab>();
  private nextTabId = 1;

  private readonly localStorageByOrigin = new Map<string, Map<string, string>>();
  private readonly explicitOpenOrigins = new Set<string>();

  private readonly platformInfo: {
    browser: string;
    browserVersion: string;
    extensionVersion: string;
    platform: string;
  };

  clockOffsetMs: number;
  private fixedNowMs: number | null;
  online: boolean;
  rejectPartitionKey: boolean;
  corruptReadBackValue = false;
  rejectCookiePredicate?: (details: BrowserCookieInput & { url: string }) => string | null;
  onTabReload?: (tabId: number, url: string) => void;

  reloadedTabIds: number[] = [];
  reloadCountByTab = new Map<number, number>();
  cookieChangedEmitCount = 0;

  constructor(options?: SimulatedBrowserDeviceOptions) {
    this.platformInfo = {
      browser: options?.browser ?? 'Edge',
      browserVersion: options?.browserVersion ?? '130.0.0.0',
      extensionVersion: options?.extensionVersion ?? '1.1.0',
      platform: options?.platform ?? 'Windows',
    };
    this.clockOffsetMs = options?.clockOffsetMs ?? 0;
    this.fixedNowMs = options?.fixedNowMs ?? null;
    this.online = options?.online ?? true;
    this.rejectPartitionKey = options?.rejectPartitionKey ?? false;
  }

  now(): number {
    if (this.fixedNowMs !== null) {
      return this.fixedNowMs + this.clockOffsetMs;
    }
    return Date.now() + this.clockOffsetMs;
  }

  setFixedNow(ms: number | null): void {
    this.fixedNowMs = ms;
  }

  advanceTime(deltaMs: number): void {
    if (this.fixedNowMs !== null) {
      this.fixedNowMs += deltaMs;
    } else {
      this.clockOffsetMs += deltaMs;
    }
  }

  setClockOffsetMs(offsetMs: number): void {
    this.clockOffsetMs = offsetMs;
  }

  isOnline(): boolean {
    return this.online;
  }

  setOnline(online: boolean): void {
    this.online = online;
  }

  private emitCookieChanged(event: BrowserCookieChangeEvent): void {
    this.cookieChangedEmitCount += 1;
    const payload: BrowserCookieChangeEvent = {
      removed: event.removed,
      cause: event.cause,
      cookie: cloneCookie(event.cookie),
    };
    for (const listener of Array.from(this.cookieListeners)) {
      listener(payload);
    }
  }

  private isCookieExpired(c: BrowserCookieInput): boolean {
    return !c.session && c.expirationDate !== undefined && c.expirationDate <= this.now() / 1000;
  }

  // =========================================================================
  // BrowserApiAdapter Implementation
  // =========================================================================

  async getAllCookies(filter?: {
    domain?: string;
    url?: string;
    storeId?: string;
  }): Promise<BrowserCookieInput[]> {
    const out: BrowserCookieInput[] = [];
    for (const c of this.jar.values()) {
      if (this.isCookieExpired(c)) continue;
      if (filter?.storeId && (c.storeId || '0') !== filter.storeId) continue;
      if (filter?.domain) {
        const cleanFilter = filter.domain.toLowerCase().replace(/^\.+/, '');
        const cleanCookie = c.domain.toLowerCase().replace(/^\.+/, '');
        if (cleanCookie !== cleanFilter && !cleanCookie.endsWith(`.${cleanFilter}`)) continue;
      }
      if (filter?.url) {
        try {
          const u = new URL(filter.url);
          if (!domainMatchesHost(c.domain, c.hostOnly, u.hostname)) continue;
          if (!pathMatches(c.path, u.pathname)) continue;
          if (c.secure && u.protocol !== 'https:') continue;
        } catch {
          continue;
        }
      }
      out.push(cloneCookie(c));
    }
    return out;
  }

  async getCookie(details: {
    url: string;
    name: string;
    storeId?: string;
    partitionKey?: PartitionKeyInfo | null;
  }): Promise<BrowserCookieInput | null> {
    let parsed: URL;
    try {
      parsed = new URL(details.url);
    } catch {
      return null;
    }

    const reqStore = details.storeId && details.storeId !== 'default' ? details.storeId : '0';
    const reqPk = details.partitionKey?.topLevelSite ?? '';

    let best: BrowserCookieInput | null = null;
    for (const c of this.jar.values()) {
      if (this.isCookieExpired(c)) continue;
      if (c.name !== details.name) continue;
      const cStore = c.storeId && c.storeId !== 'default' ? c.storeId : '0';
      if (cStore !== reqStore) continue;
      const cPk = c.partitionKey?.topLevelSite ?? '';
      if (cPk !== reqPk) continue;
      if (!domainMatchesHost(c.domain, c.hostOnly, parsed.hostname)) continue;
      if (!pathMatches(c.path, parsed.pathname)) continue;
      if (c.secure && parsed.protocol !== 'https:') continue;

      if (!best || c.path.length > best.path.length || (c.hostOnly && !best.hostOnly)) {
        best = c;
      }
    }

    if (!best) return null;
    const copy = cloneCookie(best);
    if (this.corruptReadBackValue) {
      copy.value = `${copy.value}_CORRUPTED_READBACK`;
    }
    return copy;
  }

  async setCookie(
    details: BrowserCookieInput & { url: string },
  ): Promise<{ cookie: BrowserCookieInput | null; error?: string }> {
    let parsed: URL;
    try {
      parsed = new URL(details.url);
    } catch {
      return { cookie: null, error: `Invalid cookie URL: ${details.url}` };
    }

    if (this.rejectCookiePredicate) {
      const reason = this.rejectCookiePredicate(details);
      if (reason) {
        return { cookie: null, error: reason };
      }
    }

    if (this.rejectPartitionKey && details.partitionKey) {
      return { cookie: null, error: 'Unsupported partitionKey in this browser environment' };
    }

    // Strict Chromium cookie prefix & SameSite enforcement
    if (details.name.startsWith('__Host-')) {
      if (!details.secure || parsed.protocol !== 'https:') {
        return { cookie: null, error: '__Host- cookie requires secure=true and https:// URL' };
      }
      if ((details.path || '/') !== '/') {
        return { cookie: null, error: '__Host- cookie requires path="/"' };
      }
      if (!details.hostOnly || details.domain.startsWith('.')) {
        return { cookie: null, error: '__Host- cookie must be hostOnly without Domain attribute' };
      }
    }

    if (details.name.startsWith('__Secure-')) {
      if (!details.secure || parsed.protocol !== 'https:') {
        return { cookie: null, error: '__Secure- cookie requires secure=true and https:// URL' };
      }
    }

    if (details.sameSite === 'no_restriction' && !details.secure) {
      return { cookie: null, error: 'SameSite=None cookie requires secure=true' };
    }

    const cleanDomain = details.domain.toLowerCase().replace(/^\.+/, '');
    // Emulate real Chromium CanonicalCookie semantics: localhost, IPv4/IPv6, and single-label hosts are ALWAYS hostOnly
    const effectiveHostOnly = isLocalOrSingleLabelHost(cleanDomain) ? true : Boolean(details.hostOnly);
    const stored: BrowserCookieInput = {
      domain: effectiveHostOnly
        ? cleanDomain
        : details.domain.toLowerCase().startsWith('.')
          ? details.domain.toLowerCase()
          : `.${details.domain.toLowerCase()}`,
      name: details.name,
      value: details.value,
      path: details.path || '/',
      secure: details.secure,
      httpOnly: details.httpOnly,
      sameSite: details.sameSite,
      session: details.session,
      expirationDate: details.session ? undefined : details.expirationDate,
      hostOnly: effectiveHostOnly,
      storeId: details.storeId && details.storeId !== 'default' ? details.storeId : '0',
      partitionKey: details.partitionKey ? { ...details.partitionKey } : null,
    };

    const key = cookieJarKey(stored);
    const existing = this.jar.get(key);
    if (existing) {
      this.jar.delete(key);
      // Accurate Chromium behavior: overwrite fires removed=true cause=overwrite before new value
      this.emitCookieChanged({
        removed: true,
        cause: 'overwrite',
        cookie: existing,
      });
    }

    this.jar.set(key, stored);
    this.emitCookieChanged({
      removed: false,
      cause: 'explicit',
      cookie: stored,
    });

    return { cookie: cloneCookie(stored) };
  }

  async removeCookie(details: {
    url: string;
    name: string;
    storeId?: string;
    partitionKey?: PartitionKeyInfo | null;
  }): Promise<void> {
    const found = await this.getCookie(details);
    if (!found) return;
    const key = cookieJarKey(found);
    const prev = this.jar.get(key);
    if (!prev) return;
    this.jar.delete(key);
    this.emitCookieChanged({
      removed: true,
      cause: 'explicit',
      cookie: prev,
    });
  }

  onCookieChanged(listener: (event: BrowserCookieChangeEvent) => void): () => void {
    this.cookieListeners.add(listener);
    return () => {
      this.cookieListeners.delete(listener);
    };
  }

  async queryTabs(filter?: { active?: boolean; url?: string }): Promise<BrowserTabInfo[]> {
    const out: BrowserTabInfo[] = [];
    for (const tab of this.tabs.values()) {
      if (filter?.active !== undefined && tab.active !== filter.active) continue;
      if (filter?.url && tab.url !== filter.url) continue;
      out.push({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        active: tab.active,
        windowId: 1,
        status: 'complete',
      });
    }
    return out;
  }

  async reloadTab(tabId: number): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      throw new Error(`No tab with id: ${tabId}`);
    }
    this.reloadedTabIds.push(tabId);
    this.reloadCountByTab.set(tabId, (this.reloadCountByTab.get(tabId) ?? 0) + 1);
    if (this.onTabReload) {
      this.onTabReload(tabId, tab.url);
    }
  }

  async checkTabSafeToReload(tabId: number): Promise<PageReloadSafetyStatus> {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      throw new Error(`No tab with id: ${tabId}`);
    }
    if (tab.probeThrows) {
      throw new Error('Content script unreachable');
    }
    return {
      safe: tab.safeToReload,
      reasons: [...tab.unsafeReasons],
    };
  }

  private isOriginContextOpen(origin: string): boolean {
    if (this.explicitOpenOrigins.has(origin)) return true;
    for (const tab of this.tabs.values()) {
      if (normalizeOrigin(tab.url) === origin) return true;
    }
    return false;
  }

  async getLocalStorage(origin: string): Promise<{ available: boolean; items: Record<string, string> }> {
    const norm = normalizeOrigin(origin);
    if (!norm || !this.isOriginContextOpen(norm)) {
      return { available: false, items: {} };
    }
    const store = this.localStorageByOrigin.get(norm);
    const items: Record<string, string> = Object.create(null);
    if (store) {
      for (const [k, v] of store.entries()) {
        Object.defineProperty(items, k, {
          value: v,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    return { available: true, items };
  }

  async applyLocalStorage(
    origin: string,
    mutations: Array<{ key: string; value?: string; deleted?: boolean }>,
  ): Promise<{ applied: boolean; reason?: string }> {
    const norm = normalizeOrigin(origin);
    if (!norm || !this.isOriginContextOpen(norm)) {
      return { applied: false, reason: 'No open tab/context for origin' };
    }
    let store = this.localStorageByOrigin.get(norm);
    if (!store) {
      store = new Map<string, string>();
      this.localStorageByOrigin.set(norm, store);
    }
    for (const m of mutations) {
      if (m.deleted) {
        store.delete(m.key);
      } else {
        store.set(m.key, m.value ?? '');
      }
    }
    return { applied: true };
  }

  async getDevicePlatformInfo(): Promise<{
    browser: string;
    browserVersion: string;
    extensionVersion: string;
    platform: string;
  }> {
    return { ...this.platformInfo };
  }

  // =========================================================================
  // Direct Simulation Helpers for Tests
  // =========================================================================

  /**
   * Seeds a cookie directly into the browser jar WITHOUT triggering onCookieChanged
   * (simulates cookies already present before extension setup / join).
   */
  seedCookie(
    partial: Partial<BrowserCookieInput> & { domain: string; name: string; value: string },
  ): BrowserCookieInput {
    const hostOnly =
      partial.hostOnly ??
      (partial.name.startsWith('__Host-') ? true : !partial.domain.startsWith('.'));
    const stored: BrowserCookieInput = {
      domain: hostOnly
        ? partial.domain.toLowerCase().replace(/^\.+/, '')
        : partial.domain.toLowerCase().startsWith('.')
          ? partial.domain.toLowerCase()
          : `.${partial.domain.toLowerCase()}`,
      name: partial.name,
      value: partial.value,
      path: partial.path ?? '/',
      secure:
        partial.secure ??
        (partial.name.startsWith('__Host-') ||
          partial.name.startsWith('__Secure-') ||
          partial.sameSite === 'no_restriction'),
      httpOnly: partial.httpOnly ?? false,
      sameSite: partial.sameSite ?? 'lax',
      session: partial.session ?? partial.expirationDate === undefined,
      expirationDate: partial.expirationDate,
      hostOnly,
      storeId: partial.storeId ?? '0',
      partitionKey: partial.partitionKey ?? null,
    };
    this.jar.set(cookieJarKey(stored), stored);
    return cloneCookie(stored);
  }

  /**
   * Simulates a user/site setting or updating a cookie in the browser, firing accurate onCookieChanged events.
   */
  async simulateUserCookieSet(
    partial: Partial<BrowserCookieInput> & { domain: string; name: string; value: string },
  ): Promise<BrowserCookieInput | null> {
    const hostOnly =
      partial.hostOnly ??
      (partial.name.startsWith('__Host-') ? true : !partial.domain.startsWith('.'));
    const secure =
      partial.secure ??
      (partial.name.startsWith('__Host-') ||
        partial.name.startsWith('__Secure-') ||
        partial.sameSite === 'no_restriction');
    const cleanHost = partial.domain.toLowerCase().replace(/^\.+/, '');
    const path = partial.path ?? '/';
    const url = `${secure ? 'https' : 'http'}://${cleanHost}${path.startsWith('/') ? path : `/${path}`}`;

    const res = await this.setCookie({
      url,
      domain: hostOnly ? cleanHost : partial.domain.toLowerCase(),
      name: partial.name,
      value: partial.value,
      path,
      secure,
      httpOnly: partial.httpOnly ?? false,
      sameSite: partial.sameSite ?? 'lax',
      session: partial.session ?? partial.expirationDate === undefined,
      expirationDate: partial.expirationDate,
      hostOnly,
      storeId: partial.storeId ?? '0',
      partitionKey: partial.partitionKey ?? null,
    });
    return res.cookie;
  }

  simulateCookieRemoval(
    name: string,
    cause: BrowserCookieChangeCause,
    domainFilter?: string,
  ): boolean {
    for (const [k, c] of Array.from(this.jar.entries())) {
      if (c.name !== name) continue;
      if (
        domainFilter &&
        c.domain.toLowerCase().replace(/^\.+/, '') !== domainFilter.toLowerCase().replace(/^\.+/, '')
      ) {
        continue;
      }
      this.jar.delete(k);
      this.emitCookieChanged({
        removed: true,
        cause,
        cookie: c,
      });
      return true;
    }
    return false;
  }

  simulateExplicitDelete(name: string, domainFilter?: string): boolean {
    return this.simulateCookieRemoval(name, 'explicit', domainFilter);
  }

  simulateCookieExpired(name: string, domainFilter?: string): boolean {
    return this.simulateCookieRemoval(name, 'expired', domainFilter);
  }

  simulateCookieEvicted(name: string, domainFilter?: string): boolean {
    return this.simulateCookieRemoval(name, 'evicted', domainFilter);
  }

  getJarCookies(): BrowserCookieInput[] {
    return Array.from(this.jar.values())
      .filter((c) => !this.isCookieExpired(c))
      .map(cloneCookie);
  }

  findJarCookie(name: string, domainFilter?: string): BrowserCookieInput | undefined {
    for (const c of this.jar.values()) {
      if (this.isCookieExpired(c)) continue;
      if (c.name !== name) continue;
      if (
        domainFilter &&
        c.domain.toLowerCase().replace(/^\.+/, '') !== domainFilter.toLowerCase().replace(/^\.+/, '')
      ) {
        continue;
      }
      return cloneCookie(c);
    }
    return undefined;
  }

  openTab(
    url: string,
    opts?: { active?: boolean; safeToReload?: boolean; unsafeReasons?: string[]; title?: string },
  ): number {
    const id = this.nextTabId++;
    if (opts?.active) {
      for (const t of this.tabs.values()) t.active = false;
    }
    this.tabs.set(id, {
      id,
      url,
      title: opts?.title ?? url,
      active: opts?.active ?? false,
      safeToReload: opts?.safeToReload ?? true,
      unsafeReasons: opts?.unsafeReasons ?? [],
      probeThrows: false,
    });
    return id;
  }

  closeTab(tabId: number): void {
    this.tabs.delete(tabId);
  }

  setTabSafeToReload(tabId: number, safe: boolean, reasons: string[] = []): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.safeToReload = safe;
    tab.unsafeReasons = [...reasons];
  }

  setTabActive(tabId: number): void {
    for (const t of this.tabs.values()) {
      t.active = t.id === tabId;
    }
  }

  setTabProbeThrows(tabId: number, throws: boolean): void {
    const tab = this.tabs.get(tabId);
    if (tab) tab.probeThrows = throws;
  }

  openOrigin(origin: string): void {
    const norm = normalizeOrigin(origin);
    if (norm) this.explicitOpenOrigins.add(norm);
  }

  closeOrigin(origin: string): void {
    const norm = normalizeOrigin(origin);
    if (norm) this.explicitOpenOrigins.delete(norm);
  }

  seedLocalStorage(origin: string, items: Record<string, string>): void {
    const norm = normalizeOrigin(origin);
    if (!norm) return;
    let store = this.localStorageByOrigin.get(norm);
    if (!store) {
      store = new Map<string, string>();
      this.localStorageByOrigin.set(norm, store);
    }
    for (const [k, v] of Object.entries(items)) {
      store.set(k, v);
    }
  }

  getRawLocalStorage(origin: string): Record<string, string> {
    const norm = normalizeOrigin(origin);
    if (!norm) return {};
    const store = this.localStorageByOrigin.get(norm);
    if (!store) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of store.entries()) out[k] = v;
    return out;
  }

  resetReloadHistory(): void {
    this.reloadedTabIds = [];
    this.reloadCountByTab.clear();
  }
}

export class SimulatedKeyVault {
  private readonly keys = new Map<string, string>();

  async saveDek(spaceId: string, dekBase64: string): Promise<void> {
    this.keys.set(spaceId, dekBase64);
  }

  async loadDek(spaceId: string): Promise<string | null> {
    return this.keys.get(spaceId) ?? null;
  }

  async clearDek(spaceId: string): Promise<void> {
    this.keys.delete(spaceId);
  }
}

export interface SimulatedDeviceNode {
  name: string;
  browser: SimulatedBrowserDevice;
  storage: InMemoryStorageBackend;
  keyVault: SimulatedKeyVault;
  engine: SyncEngine;
  restartEngine: (overrideOpts?: Partial<SyncEngineOptions>) => Promise<SyncEngine>;
  dispose: () => void;
}

export interface MultiDeviceHarnessOptions {
  webdav: WebDAVConfig;
  fetchImpl?: typeof fetch;
  debounceMs?: number;
  refreshCoalesceMs?: number;
  pbkdf2Iterations?: number;
}

export class MultiDeviceHarness {
  readonly webdav: WebDAVConfig;
  readonly fetchImpl?: typeof fetch;
  readonly debounceMs: number;
  readonly refreshCoalesceMs: number;
  readonly pbkdf2Iterations: number;
  private readonly nodes: SimulatedDeviceNode[] = [];

  constructor(options: MultiDeviceHarnessOptions) {
    this.webdav = options.webdav;
    this.fetchImpl = options.fetchImpl;
    this.debounceMs = options.debounceMs ?? 0;
    this.refreshCoalesceMs = options.refreshCoalesceMs ?? 0;
    this.pbkdf2Iterations = options.pbkdf2Iterations ?? 1000;
  }

  async createDevice(
    name: string,
    browserOpts?: SimulatedBrowserDeviceOptions,
    engineOpts?: Partial<SyncEngineOptions>,
  ): Promise<SimulatedDeviceNode> {
    const browser = new SimulatedBrowserDevice({
      deviceName: name,
      ...browserOpts,
    });
    const storage = new InMemoryStorageBackend();
    const keyVault = new SimulatedKeyVault();

    const buildEngine = (extra?: Partial<SyncEngineOptions>) =>
      new SyncEngine({
        storage,
        browser,
        webdavClientOptions: this.fetchImpl ? { fetchImpl: this.fetchImpl } : undefined,
        debounceMs: this.debounceMs,
        refreshCoalesceMs: this.refreshCoalesceMs,
        pbkdf2Iterations: this.pbkdf2Iterations,
        keyVault,
        ...engineOpts,
        ...extra,
      });

    const engine = buildEngine();
    await engine.init();

    const node: SimulatedDeviceNode = {
      name,
      browser,
      storage,
      keyVault,
      engine,
      restartEngine: async (overrideOpts?: Partial<SyncEngineOptions>) => {
        node.engine.dispose();
        const fresh = buildEngine(overrideOpts);
        await fresh.init();
        node.engine = fresh;
        return fresh;
      },
      dispose: () => {
        node.engine.dispose();
      },
    };

    this.nodes.push(node);
    return node;
  }

  disposeAll(): void {
    for (const node of this.nodes) {
      node.dispose();
    }
    this.nodes.length = 0;
  }
}
