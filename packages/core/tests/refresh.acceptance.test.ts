import { describe, it, expect, afterEach } from 'vitest';
import { MockWebDAVServer } from '@sessionmesh/webdav-mock';
import { AutoRefreshController } from '../src/refresh';
import { MultiDeviceHarness, SimulatedBrowserDevice } from '../src/sim';
import type { WebDAVConfig } from '../src/types';

function createBaseConfig(): WebDAVConfig {
  return {
    url: 'https://dav.refresh.test/webdav',
    authType: 'basic',
    username: 'carol',
    password: 'refresh-password-456',
    rootPath: '/mesh',
  };
}

describe('Auto-Refresh & Page Safety Acceptance Suite (R-001 .. R-007)', () => {
  let harness: MultiDeviceHarness | null = null;

  afterEach(() => {
    harness?.disposeAll();
    harness = null;
  });

  it('R-001: Applying remote cookie changes auto-reloads matching open tab', async () => {
    const dav = new MockWebDAVServer({
      requireAuth: { username: 'carol', password: 'refresh-password-456' },
    });
    const webdav = createBaseConfig();
    harness = new MultiDeviceHarness({
      webdav,
      fetchImpl: dav.fetchImpl,
      debounceMs: 0,
      refreshCoalesceMs: 0,
      pbkdf2Iterations: 1000,
    });

    const devA = await harness.createDevice('Device-A');
    const devB = await harness.createDevice('Device-B');

    devA.browser.seedCookie({ domain: '.app.io', name: 'sid', value: 'v1' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: 'ref-space',
      spaceName: 'Refresh Space',
      encryptionPassword: 'pass',
      deviceName: 'Device-A',
    });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: 'ref-space',
      spaceName: 'Refresh Space',
      encryptionPassword: 'pass',
      deviceName: 'Device-B',
    });

    const appTabId = devB.browser.openTab('https://dashboard.app.io/home', {
      active: true,
      safeToReload: true,
    });
    devB.browser.resetReloadHistory();

    await devA.browser.simulateUserCookieSet({ domain: '.app.io', name: 'sid', value: 'v2' });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();

    await devB.engine.syncNow();
    expect(devB.browser.reloadedTabIds).toEqual([appTabId]);
    expect(devB.browser.reloadCountByTab.get(appTabId)).toBe(1);
  });

  it('R-002: Unrelated tabs on different sites are NEVER reloaded', async () => {
    const browser = new SimulatedBrowserDevice();
    const ctrl = new AutoRefreshController(browser, { coalesceMs: 0 });

    const targetTab = browser.openTab('https://sub.target.com/page', { safeToReload: true });
    const otherTab1 = browser.openTab('https://unrelated.org/inbox', { safeToReload: true });
    const otherTab2 = browser.openTab('chrome://extensions', { safeToReload: true });

    const res = await ctrl.notifyAppliedChanges({
      siteKey: 'target.com',
      versionDigest: 'digest-1',
      autoRefreshEnabled: true,
      refreshProtectionEnabled: true,
      immediate: true,
    });

    expect(res.reloadedTabIds).toEqual([targetTab]);
    expect(browser.reloadCountByTab.get(targetTab)).toBe(1);
    expect(browser.reloadCountByTab.get(otherTab1)).toBeUndefined();
    expect(browser.reloadCountByTab.get(otherTab2)).toBeUndefined();
  });

  it('R-003: Unsaved form / file upload / unreachable probe defers reload until tab becomes safe', async () => {
    const browser = new SimulatedBrowserDevice();
    const ctrl = new AutoRefreshController(browser, { coalesceMs: 0 });

    const dirtyTab = browser.openTab('https://docs.example.com/edit/1', {
      safeToReload: false,
      unsafeReasons: ['dirty_form_input', 'pending_file_upload'],
    });
    const probeFailTab = browser.openTab('https://docs.example.com/edit/2', {
      safeToReload: true,
    });
    browser.setTabProbeThrows(probeFailTab, true);

    const res = await ctrl.notifyAppliedChanges({
      siteKey: 'example.com',
      versionDigest: 'digest-dirty',
      autoRefreshEnabled: true,
      refreshProtectionEnabled: true,
      immediate: true,
    });

    expect(res.reloadedTabIds).toEqual([]);
    expect(res.deferred).toHaveLength(2);
    expect(browser.reloadedTabIds).toHaveLength(0);
    expect(ctrl.getDeferredReloads()).toHaveLength(2);

    // Flushing while still unsafe returns false
    expect(await ctrl.flushDeferredForTab(dirtyTab)).toBe(false);
    expect(browser.reloadedTabIds).toHaveLength(0);

    // User finishes editing -> tab becomes safe -> deferred reload executes!
    browser.setTabSafeToReload(dirtyTab, true, []);
    expect(await ctrl.flushDeferredForTab(dirtyTab)).toBe(true);
    expect(browser.reloadedTabIds).toEqual([dirtyTab]);
    expect(ctrl.getDeferredReloads().find((d) => d.tabId === dirtyTab)).toBeUndefined();
  });

  it('R-004: Same (tabId, versionDigest) is deduplicated and never triggers duplicate reloads', async () => {
    const browser = new SimulatedBrowserDevice();
    const ctrl = new AutoRefreshController(browser, { coalesceMs: 0 });

    const tabId = browser.openTab('https://dedup.io/app', { safeToReload: true });

    const first = await ctrl.notifyAppliedChanges({
      siteKey: 'dedup.io',
      versionDigest: 'same-version-hash',
      autoRefreshEnabled: true,
      refreshProtectionEnabled: true,
      immediate: true,
    });
    const second = await ctrl.notifyAppliedChanges({
      siteKey: 'dedup.io',
      versionDigest: 'same-version-hash',
      autoRefreshEnabled: true,
      refreshProtectionEnabled: true,
      immediate: true,
    });

    expect(first.reloadedTabIds).toEqual([tabId]);
    expect(second.reloadedTabIds).toEqual([]);
    expect(browser.reloadCountByTab.get(tabId)).toBe(1);
  });

  it('R-005: Multiple rapid cookie updates within coalesceMs coalesce into a SINGLE reload', async () => {
    const browser = new SimulatedBrowserDevice();
    const ctrl = new AutoRefreshController(browser, { coalesceMs: 40 });

    const tabId = browser.openTab('https://burst.io/home', { safeToReload: true });

    // Fire 5 rapid version updates within 40ms
    await Promise.all([
      ctrl.notifyAppliedChanges({
        siteKey: 'burst.io',
        versionDigest: 'v1',
        autoRefreshEnabled: true,
        refreshProtectionEnabled: true,
      }),
      ctrl.notifyAppliedChanges({
        siteKey: 'burst.io',
        versionDigest: 'v2',
        autoRefreshEnabled: true,
        refreshProtectionEnabled: true,
      }),
      ctrl.notifyAppliedChanges({
        siteKey: 'burst.io',
        versionDigest: 'v3',
        autoRefreshEnabled: true,
        refreshProtectionEnabled: true,
      }),
      ctrl.notifyAppliedChanges({
        siteKey: 'burst.io',
        versionDigest: 'v4',
        autoRefreshEnabled: true,
        refreshProtectionEnabled: true,
      }),
      ctrl.notifyAppliedChanges({
        siteKey: 'burst.io',
        versionDigest: 'v5',
        autoRefreshEnabled: true,
        refreshProtectionEnabled: true,
      }),
    ]);

    expect(browser.reloadCountByTab.get(tabId)).toBe(1);
    ctrl.dispose();
  });

  it('R-006: Closed tabs are safely skipped and never throw or reload', async () => {
    const browser = new SimulatedBrowserDevice();
    const ctrl = new AutoRefreshController(browser, { coalesceMs: 30 });

    const openTab = browser.openTab('https://close.io/a', { safeToReload: true });
    const closingTab = browser.openTab('https://close.io/b', { safeToReload: true });

    const promise = ctrl.notifyAppliedChanges({
      siteKey: 'close.io',
      versionDigest: 'v1',
      autoRefreshEnabled: true,
      refreshProtectionEnabled: true,
    });

    // Close second tab before coalesce timer fires
    browser.closeTab(closingTab);

    const res = await promise;
    expect(res.reloadedTabIds).toEqual([openTab]);
    expect(browser.reloadCountByTab.get(openTab)).toBe(1);
    expect(browser.reloadCountByTab.get(closingTab)).toBeUndefined();

    // Deferred reload for a tab that was later closed also cleans up gracefully
    browser.setTabSafeToReload(openTab, false, ['dirty']);
    await ctrl.notifyAppliedChanges({
      siteKey: 'close.io',
      versionDigest: 'v2',
      autoRefreshEnabled: true,
      refreshProtectionEnabled: true,
      immediate: true,
    });
    browser.closeTab(openTab);
    expect(await ctrl.flushDeferredForTab(openTab)).toBe(false);
    expect(ctrl.getDeferredReloads()).toHaveLength(0);
    ctrl.dispose();
  });

  it('R-007: Loop guard caps reloads per window AND markSessionRejectedByServer stops server-rejected reload loops (Prohibition #20)', async () => {
    const browser = new SimulatedBrowserDevice({ fixedNowMs: 1_700_000_000_000 });
    const ctrl = new AutoRefreshController(browser, {
      coalesceMs: 0,
      maxReloadsPerWindow: 2,
      windowMs: 30_000,
    });

    const tabId = browser.openTab('https://guard.io/app', { safeToReload: true });

    // Reload #1 & #2 succeed within window
    const r1 = await ctrl.notifyAppliedChanges({
      siteKey: 'guard.io',
      versionDigest: 'v1',
      autoRefreshEnabled: true,
      refreshProtectionEnabled: true,
      immediate: true,
    });
    const r2 = await ctrl.notifyAppliedChanges({
      siteKey: 'guard.io',
      versionDigest: 'v2',
      autoRefreshEnabled: true,
      refreshProtectionEnabled: true,
      immediate: true,
    });
    // Reload #3 inside 30s window is blocked by loop guard!
    const r3 = await ctrl.notifyAppliedChanges({
      siteKey: 'guard.io',
      versionDigest: 'v3',
      autoRefreshEnabled: true,
      refreshProtectionEnabled: true,
      immediate: true,
    });

    expect(r1.reloadedTabIds).toEqual([tabId]);
    expect(r2.reloadedTabIds).toEqual([tabId]);
    expect(r3.reloadedTabIds).toEqual([]);
    expect(r3.skippedLoopGuard).toBe(true);
    expect(browser.reloadCountByTab.get(tabId)).toBe(2);

    // Advance past 30s window, but server rejects session -> markSessionRejectedByServer blocks all reloads!
    browser.advanceTime(35_000);
    ctrl.markSessionRejectedByServer('guard.io');
    expect(ctrl.isSessionRejected('guard.io')).toBe(true);

    const r4 = await ctrl.notifyAppliedChanges({
      siteKey: 'guard.io',
      versionDigest: 'v4',
      autoRefreshEnabled: true,
      refreshProtectionEnabled: true,
      immediate: true,
    });
    expect(r4.reloadedTabIds).toEqual([]);
    expect(r4.skippedLoopGuard).toBe(true);
    expect(browser.reloadCountByTab.get(tabId)).toBe(2);

    // Once user logs in again and clears rejection, auto-refresh works again
    ctrl.clearSessionRejected('guard.io');
    expect(ctrl.isSessionRejected('guard.io')).toBe(false);
    const r5 = await ctrl.notifyAppliedChanges({
      siteKey: 'guard.io',
      versionDigest: 'v5',
      autoRefreshEnabled: true,
      refreshProtectionEnabled: true,
      immediate: true,
    });
    expect(r5.reloadedTabIds).toEqual([tabId]);
    expect(browser.reloadCountByTab.get(tabId)).toBe(3);
  });
});
