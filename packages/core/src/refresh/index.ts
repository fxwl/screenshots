import { domainMatchesSiteKey, resolveSiteKey } from '../psl';
import type { BrowserApiAdapter, SsoDomainGroup } from '../types';

export interface DeferredReloadRecord {
  tabId: number;
  url: string;
  siteKey: string;
  versionDigest: string;
  reasons: string[];
  deferredAt: number;
}

export interface AutoRefreshResult {
  reloadedTabIds: number[];
  deferred: DeferredReloadRecord[];
  skippedLoopGuard: boolean;
}

interface PendingCoalesceBatch {
  siteKey: string;
  versionDigest: string;
  autoRefreshEnabled: boolean;
  refreshProtectionEnabled: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolvers: Array<(res: AutoRefreshResult) => void>;
}

export interface AutoRefreshControllerOptions {
  coalesceMs?: number;
  maxReloadsPerWindow?: number;
  windowMs?: number;
  getSsoGroups?: () => SsoDomainGroup[];
  onChange?: () => void;
}

export class AutoRefreshController {
  private readonly browser: BrowserApiAdapter;
  private readonly coalesceMs: number;
  private readonly maxReloadsPerWindow: number;
  private readonly windowMs: number;
  private readonly getSsoGroups?: () => SsoDomainGroup[];
  private readonly onChange?: () => void;

  private readonly lastReloadedDigestByTab = new Map<number, string>();
  private readonly reloadTimestampsBySite = new Map<string, number[]>();
  private readonly rejectedSites = new Set<string>();
  private readonly deferredByTab = new Map<number, DeferredReloadRecord>();
  private readonly pendingCoalesce = new Map<string, PendingCoalesceBatch>();

  constructor(browser: BrowserApiAdapter, options?: AutoRefreshControllerOptions) {
    this.browser = browser;
    this.coalesceMs = options?.coalesceMs ?? 800;
    this.maxReloadsPerWindow = options?.maxReloadsPerWindow ?? 2;
    this.windowMs = options?.windowMs ?? 30_000;
    this.getSsoGroups = options?.getSsoGroups;
    this.onChange = options?.onChange;
  }

  private now(): number {
    return this.browser.now ? this.browser.now() : Date.now();
  }

  private tabMatchesSite(tabUrl: string | undefined, siteKey: string): boolean {
    if (!tabUrl) return false;
    let hostname: string;
    try {
      const parsed = new URL(tabUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return false;
      }
      hostname = parsed.hostname;
    } catch {
      return false;
    }
    const ssoGroups = this.getSsoGroups?.();
    if (domainMatchesSiteKey(hostname, siteKey, ssoGroups)) {
      return true;
    }
    return resolveSiteKey(hostname, ssoGroups) === siteKey;
  }

  private isLoopGuarded(siteKey: string, nowMs: number): boolean {
    if (this.rejectedSites.has(siteKey)) {
      return true;
    }
    const timestamps = this.reloadTimestampsBySite.get(siteKey) ?? [];
    const recent = timestamps.filter((ts) => nowMs - ts < this.windowMs);
    this.reloadTimestampsBySite.set(siteKey, recent);
    return recent.length >= this.maxReloadsPerWindow;
  }

  private recordReloadTimestamp(siteKey: string, nowMs: number): void {
    const timestamps = this.reloadTimestampsBySite.get(siteKey) ?? [];
    const recent = timestamps.filter((ts) => nowMs - ts < this.windowMs);
    recent.push(nowMs);
    this.reloadTimestampsBySite.set(siteKey, recent);
  }

  async notifyAppliedChanges(params: {
    siteKey: string;
    versionDigest: string;
    autoRefreshEnabled: boolean;
    refreshProtectionEnabled: boolean;
    immediate?: boolean;
  }): Promise<AutoRefreshResult> {
    if (!params.autoRefreshEnabled) {
      return { reloadedTabIds: [], deferred: [], skippedLoopGuard: false };
    }

    if (params.immediate || this.coalesceMs <= 0) {
      return this.executeRefresh(
        params.siteKey,
        params.versionDigest,
        params.refreshProtectionEnabled,
      );
    }

    return new Promise<AutoRefreshResult>((resolve) => {
      const existing = this.pendingCoalesce.get(params.siteKey);
      if (existing) {
        existing.versionDigest = params.versionDigest;
        existing.autoRefreshEnabled = existing.autoRefreshEnabled || params.autoRefreshEnabled;
        existing.refreshProtectionEnabled =
          existing.refreshProtectionEnabled || params.refreshProtectionEnabled;
        existing.resolvers.push(resolve);
        return;
      }

      const batch: PendingCoalesceBatch = {
        siteKey: params.siteKey,
        versionDigest: params.versionDigest,
        autoRefreshEnabled: params.autoRefreshEnabled,
        refreshProtectionEnabled: params.refreshProtectionEnabled,
        resolvers: [resolve],
        timer: setTimeout(async () => {
          this.pendingCoalesce.delete(params.siteKey);
          const result = await this.executeRefresh(
            batch.siteKey,
            batch.versionDigest,
            batch.refreshProtectionEnabled,
          );
          for (const res of batch.resolvers) {
            res(result);
          }
        }, this.coalesceMs),
      };

      this.pendingCoalesce.set(params.siteKey, batch);
    });
  }

  private async executeRefresh(
    siteKey: string,
    versionDigest: string,
    refreshProtectionEnabled: boolean,
  ): Promise<AutoRefreshResult> {
    const nowMs = this.now();

    if (this.isLoopGuarded(siteKey, nowMs)) {
      return { reloadedTabIds: [], deferred: [], skippedLoopGuard: true };
    }

    const tabs = await this.browser.queryTabs();
    const openTabIds = new Set(tabs.map((t) => t.id));

    // Prune closed tabs from caches (R-006)
    for (const cachedTabId of Array.from(this.lastReloadedDigestByTab.keys())) {
      if (!openTabIds.has(cachedTabId)) {
        this.lastReloadedDigestByTab.delete(cachedTabId);
      }
    }
    let deferredMutated = false;
    for (const deferredTabId of Array.from(this.deferredByTab.keys())) {
      if (!openTabIds.has(deferredTabId)) {
        this.deferredByTab.delete(deferredTabId);
        deferredMutated = true;
      }
    }

    const matchingTabs = tabs.filter((tab) => this.tabMatchesSite(tab.url, siteKey));
    const reloadedTabIds: number[] = [];
    const deferred: DeferredReloadRecord[] = [];

    let didReloadAny = false;

    for (const tab of matchingTabs) {
      // R-004: deduplicate by (tabId, versionDigest)
      if (this.lastReloadedDigestByTab.get(tab.id) === versionDigest) {
        continue;
      }

      // R-003: refresh safety protection
      if (refreshProtectionEnabled) {
        let safe = false;
        let reasons: string[] = [];
        try {
          const check = await this.browser.checkTabSafeToReload(tab.id);
          safe = Boolean(check?.safe);
          reasons = check?.reasons ?? [];
        } catch {
          // Conservative policy: probe unreachable -> defer reload
          safe = false;
          reasons = ['safety_probe_unavailable'];
        }

        if (!safe) {
          const normalizedReasons =
            reasons.length > 0 ? reasons : ['unsaved_or_active_interaction'];
          const isPassiveViewingOnly = normalizedReasons.every(
            (r) => r === 'user_actively_viewing' || r === 'media_playing',
          );
          if (isPassiveViewingOnly) {
            // Silently skip refreshing while user is actively viewing/scrolling/watching media without raising an alarm
            continue;
          }
          const record: DeferredReloadRecord = {
            tabId: tab.id,
            url: tab.url ?? '',
            siteKey,
            versionDigest,
            reasons: normalizedReasons,
            deferredAt: nowMs,
          };
          this.deferredByTab.set(tab.id, record);
          deferred.push(record);
          deferredMutated = true;
          continue;
        }
      }

      // R-006: safely reload only if tab is still alive
      try {
        await this.browser.reloadTab(tab.id);
        this.lastReloadedDigestByTab.set(tab.id, versionDigest);
        if (this.deferredByTab.delete(tab.id)) {
          deferredMutated = true;
        }
        reloadedTabIds.push(tab.id);
        didReloadAny = true;
      } catch {
        // Tab closed concurrently — clean up and continue
        this.lastReloadedDigestByTab.delete(tab.id);
        if (this.deferredByTab.delete(tab.id)) {
          deferredMutated = true;
        }
      }
    }

    if (didReloadAny) {
      this.recordReloadTimestamp(siteKey, nowMs);
    }

    if (deferredMutated) {
      this.onChange?.();
    }

    return { reloadedTabIds, deferred, skippedLoopGuard: false };
  }

  markSessionRejectedByServer(siteKey: string): void {
    this.rejectedSites.add(siteKey);
    // Drop pending deferred reloads for this site to prevent loop
    for (const [tabId, rec] of Array.from(this.deferredByTab.entries())) {
      if (rec.siteKey === siteKey) {
        this.deferredByTab.delete(tabId);
      }
    }
  }

  isSessionRejected(siteKey: string): boolean {
    return this.rejectedSites.has(siteKey);
  }

  clearSessionRejected(siteKey: string): void {
    this.rejectedSites.delete(siteKey);
  }

  getDeferredReloads(): DeferredReloadRecord[] {
    return Array.from(this.deferredByTab.values());
  }

  dismissDeferredForTab(tabId: number): boolean {
    const deleted = this.deferredByTab.delete(tabId);
    if (deleted) {
      this.onChange?.();
    }
    return deleted;
  }

  async forceReloadTab(tabId: number): Promise<boolean> {
    const record = this.deferredByTab.get(tabId);
    const nowMs = this.now();
    try {
      await this.browser.reloadTab(tabId);
      if (record) {
        this.lastReloadedDigestByTab.set(tabId, record.versionDigest);
        this.recordReloadTimestamp(record.siteKey, nowMs);
      }
      this.deferredByTab.delete(tabId);
      this.onChange?.();
      return true;
    } catch {
      if (this.deferredByTab.delete(tabId)) {
        this.onChange?.();
      }
      return false;
    }
  }

  async flushDeferredForTab(tabId: number): Promise<boolean> {
    const record = this.deferredByTab.get(tabId);
    if (!record) return false;

    const nowMs = this.now();
    if (this.isLoopGuarded(record.siteKey, nowMs)) {
      return false;
    }

    // Ensure tab still exists and still matches site
    const tabs = await this.browser.queryTabs();
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab || !this.tabMatchesSite(tab.url, record.siteKey)) {
      this.deferredByTab.delete(tabId);
      this.onChange?.();
      return false;
    }

    // Re-verify safety before flushing
    try {
      const check = await this.browser.checkTabSafeToReload(tabId);
      if (!check.safe) {
        record.reasons = check.reasons.length > 0 ? check.reasons : record.reasons;
        return false;
      }
    } catch {
      return false;
    }

    try {
      await this.browser.reloadTab(tabId);
      this.lastReloadedDigestByTab.set(tabId, record.versionDigest);
      this.deferredByTab.delete(tabId);
      this.recordReloadTimestamp(record.siteKey, nowMs);
      this.onChange?.();
      return true;
    } catch {
      this.deferredByTab.delete(tabId);
      this.onChange?.();
      return false;
    }
  }

  dispose(): void {
    for (const batch of this.pendingCoalesce.values()) {
      clearTimeout(batch.timer);
      for (const res of batch.resolvers) {
        res({ reloadedTabIds: [], deferred: [], skippedLoopGuard: false });
      }
    }
    this.pendingCoalesce.clear();
  }
}
