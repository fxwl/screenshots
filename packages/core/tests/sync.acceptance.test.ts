import { describe, it, expect, afterEach } from 'vitest';
import { MockWebDAVServer } from '@sessionmesh/webdav-mock';
import { MultiDeviceHarness } from '../src/sim';
import type { WebDAVConfig } from '../src/types';

function createBaseConfig(): WebDAVConfig {
  return {
    url: 'https://dav.example.test/remote.php/dav/files/alice',
    authType: 'basic',
    username: 'alice',
    password: 'app-secret-password-999',
    rootPath: '/sync-root',
  };
}

describe('Multi-Device Sync Engine Acceptance Suite (S-001 .. S-016)', () => {
  let harness: MultiDeviceHarness | null = null;

  afterEach(() => {
    harness?.disposeAll();
    harness = null;
  });

  function setup(server?: MockWebDAVServer, opts?: { debounceMs?: number; refreshCoalesceMs?: number }) {
    const dav =
      server ??
      new MockWebDAVServer({
        requireAuth: { username: 'alice', password: 'app-secret-password-999' },
      });
    const webdav = createBaseConfig();
    harness = new MultiDeviceHarness({
      webdav,
      fetchImpl: dav.fetchImpl,
      debounceMs: opts?.debounceMs ?? 0,
      refreshCoalesceMs: opts?.refreshCoalesceMs ?? 0,
      pbkdf2Iterations: 1000,
    });
    return { dav, webdav, harness };
  }

  const SPACE_ID = 'default-space';
  const SPACE_NAME = 'Personal Sync';
  const ENC_PASS = 'e2e-master-pass-2026!';

  it('S-001: New device B joins existing space without overwriting remote data', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    devA.browser.seedCookie({ domain: '.alpha.com', name: 'sid_a', value: 'AAA-1' });
    devB.browser.seedCookie({ domain: '.beta.com', name: 'sid_b', value: 'BBB-1' });

    const repA = await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });
    expect(repA.isNewSpace).toBe(true);
    expect(repA.localUploadedSites).toContain('alpha.com');

    const repB = await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-B',
    });
    expect(repB.isNewSpace).toBe(false);
    expect(repB.autoSyncedSites).toContain('alpha.com');
    expect(repB.localUploadedSites).toContain('beta.com');

    // Device B received alpha.com from A AND kept its own beta.com
    expect(devB.browser.findJarCookie('sid_a', 'alpha.com')?.value).toBe('AAA-1');
    expect(devB.browser.findJarCookie('sid_b', 'beta.com')?.value).toBe('BBB-1');

    // Device A pulls beta.com from B and still has alpha.com intact
    await devA.engine.syncNow();
    expect(devA.browser.findJarCookie('sid_a', 'alpha.com')?.value).toBe('AAA-1');
    expect(devA.browser.findJarCookie('sid_b', 'beta.com')?.value).toBe('BBB-1');
  });

  it('S-002: Device A logs into new site X and auto-syncs to Device B', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-B',
    });

    await devA.browser.simulateUserCookieSet({
      domain: '.newsite.org',
      name: 'auth_token',
      value: 'tok_v1',
      secure: true,
      httpOnly: true,
    });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();

    await devB.engine.syncNow();
    const pulled = devB.browser.findJarCookie('auth_token', 'newsite.org');
    expect(pulled?.value).toBe('tok_v1');
    expect(pulled?.httpOnly).toBe(true);
    expect(pulled?.secure).toBe(true);
  });

  it('S-003: On-demand site visit triggers targeted pull and restores session', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-B',
    });

    await devA.browser.simulateUserCookieSet({
      domain: '.portal.dev',
      name: 'portal_sid',
      value: 'ready_on_visit',
    });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();

    expect(devB.browser.findJarCookie('portal_sid', 'portal.dev')).toBeUndefined();
    await devB.engine.onSiteVisited('https://app.portal.dev/dashboard');
    expect(devB.browser.findJarCookie('portal_sid', 'portal.dev')?.value).toBe('ready_on_visit');
  });

  it('S-004: 3-device A/B/C bidirectional update propagation', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');
    const devC = await h.createDevice('Device-C');

    devA.browser.seedCookie({ domain: '.tri.io', name: 'session', value: 'from-A-1' });

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-B',
    });
    await devC.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-C',
    });

    expect(devB.browser.findJarCookie('session', 'tri.io')?.value).toBe('from-A-1');
    expect(devC.browser.findJarCookie('session', 'tri.io')?.value).toBe('from-A-1');

    // Device B updates session
    await devB.browser.simulateUserCookieSet({ domain: '.tri.io', name: 'session', value: 'from-B-2' });
    await devB.engine.flushPendingLocalChanges();
    await devB.engine.syncNow();

    await devA.engine.syncNow();
    await devC.engine.syncNow();
    expect(devA.browser.findJarCookie('session', 'tri.io')?.value).toBe('from-B-2');
    expect(devC.browser.findJarCookie('session', 'tri.io')?.value).toBe('from-B-2');

    // Device C updates session
    await devC.browser.simulateUserCookieSet({ domain: '.tri.io', name: 'session', value: 'from-C-3' });
    await devC.engine.flushPendingLocalChanges();
    await devC.engine.syncNow();

    await devA.engine.syncNow();
    await devB.engine.syncNow();
    expect(devA.browser.findJarCookie('session', 'tri.io')?.value).toBe('from-C-3');
    expect(devB.browser.findJarCookie('session', 'tri.io')?.value).toBe('from-C-3');
  });

  it('S-005: Cookie attribute updates (expirationDate, httpOnly, sameSite, path) propagate faithfully', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    const futureExp = Math.floor(Date.now() / 1000) + 86400;
    devA.browser.seedCookie({
      domain: '.attrs.io',
      name: 'cfg',
      value: 'v1',
      path: '/app',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
      session: false,
      expirationDate: futureExp,
    });

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-B',
    });

    const newExp = futureExp + 7200;
    await devA.browser.simulateUserCookieSet({
      domain: '.attrs.io',
      name: 'cfg',
      value: 'v2',
      path: '/app',
      secure: true,
      httpOnly: true,
      sameSite: 'strict',
      session: false,
      expirationDate: newExp,
    });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();

    await devB.engine.syncNow();
    const c = devB.browser.findJarCookie('cfg', 'attrs.io');
    expect(c?.value).toBe('v2');
    expect(c?.path).toBe('/app');
    expect(c?.httpOnly).toBe(true);
    expect(c?.sameSite).toBe('strict');
    expect(c?.expirationDate).toBe(newExp);
  });

  it('S-006: Multi-cookie & subdomain login session batches and syncs together under one siteKey', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-B',
    });

    await devA.browser.simulateUserCookieSet({ domain: '.bilibili.com', name: 'SESSDATA', value: 's1', secure: true });
    await devA.browser.simulateUserCookieSet({ domain: 'passport.bilibili.com', name: 'bili_jct', value: 'j1', hostOnly: true, secure: true });
    await devA.browser.simulateUserCookieSet({ domain: '.bilibili.com', name: 'DedeUserID', value: '12345' });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();

    await devB.engine.syncNow();
    expect(devB.browser.findJarCookie('SESSDATA', 'bilibili.com')?.value).toBe('s1');
    expect(devB.browser.findJarCookie('bili_jct', 'passport.bilibili.com')?.value).toBe('j1');
    expect(devB.browser.findJarCookie('DedeUserID', 'bilibili.com')?.value).toBe('12345');

    const sites = await devB.engine.getSitesOverview();
    const biliSites = sites.filter((s) => s.siteKey.includes('bilibili'));
    expect(biliSites).toHaveLength(1);
    expect(biliSites[0].siteKey).toBe('bilibili.com');
  });

  it('S-007: Explicit delete creates Tombstone, propagates to B, and blocks stale resurrection from offline C', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');
    const devC = await h.createDevice('Device-C');

    devA.browser.seedCookie({ domain: '.tomb.io', name: 'login', value: 'v1' });

    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });
    await devC.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-C' });

    expect(devB.browser.findJarCookie('login', 'tomb.io')?.value).toBe('v1');
    expect(devC.browser.findJarCookie('login', 'tomb.io')?.value).toBe('v1');

    // Device C goes offline with stale cookie v1
    devC.browser.setOnline(false);

    // Device A logs out (explicit delete)
    devA.browser.simulateExplicitDelete('login', 'tomb.io');
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();

    // Device B pulls -> cookie removed
    await devB.engine.syncNow();
    expect(devB.browser.findJarCookie('login', 'tomb.io')).toBeUndefined();

    // Device C comes back online -> tombstone removes stale cookie on C and does NOT resurrect on A/B
    devC.browser.setOnline(true);
    await devC.engine.syncNow();
    expect(devC.browser.findJarCookie('login', 'tomb.io')).toBeUndefined();

    await devA.engine.syncNow();
    await devB.engine.syncNow();
    expect(devA.browser.findJarCookie('login', 'tomb.io')).toBeUndefined();
    expect(devB.browser.findJarCookie('login', 'tomb.io')).toBeUndefined();

    // Re-login after tombstone creates causal successor -> succeeds everywhere
    await devA.browser.simulateUserCookieSet({ domain: '.tomb.io', name: 'login', value: 'v2-fresh' });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();
    await devB.engine.syncNow();
    expect(devB.browser.findJarCookie('login', 'tomb.io')?.value).toBe('v2-fresh');
  });

  it('S-008: Concurrent updates to different cookies merge cleanly with zero conflicts', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    devA.browser.seedCookie({ domain: '.merge.io', name: 'c1', value: 'init1' });
    devA.browser.seedCookie({ domain: '.merge.io', name: 'c2', value: 'init2' });

    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });

    // Both go offline and update different cookies
    devA.browser.setOnline(false);
    devB.browser.setOnline(false);

    await devA.browser.simulateUserCookieSet({ domain: '.merge.io', name: 'c1', value: 'A-updated' });
    await devB.browser.simulateUserCookieSet({ domain: '.merge.io', name: 'c2', value: 'B-updated' });
    await devA.engine.flushPendingLocalChanges();
    await devB.engine.flushPendingLocalChanges();

    devA.browser.setOnline(true);
    devB.browser.setOnline(true);

    await devA.engine.syncNow();
    await devB.engine.syncNow();
    await devA.engine.syncNow();

    expect(devA.browser.findJarCookie('c1', 'merge.io')?.value).toBe('A-updated');
    expect(devA.browser.findJarCookie('c2', 'merge.io')?.value).toBe('B-updated');
    expect(devB.browser.findJarCookie('c1', 'merge.io')?.value).toBe('A-updated');
    expect(devB.browser.findJarCookie('c2', 'merge.io')?.value).toBe('B-updated');
    expect(await devA.engine.getConflicts()).toHaveLength(0);
    expect(await devB.engine.getConflicts()).toHaveLength(0);
  });

  it('S-009: Concurrent updates to the same cookie converge deterministically across A, B, and C and record conflict', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A', { fixedNowMs: 1_700_000_000_000 });
    const devB = await h.createDevice('Device-B', { fixedNowMs: 1_700_000_005_000 });
    const devC = await h.createDevice('Device-C', { fixedNowMs: 1_700_000_010_000 });

    devA.browser.seedCookie({ domain: '.race.io', name: 'token', value: 'v0' });

    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });
    await devC.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-C' });

    // Offline concurrent writes to the same cookie
    devA.browser.setOnline(false);
    devB.browser.setOnline(false);

    await devA.browser.simulateUserCookieSet({ domain: '.race.io', name: 'token', value: 'from-A' });
    await devB.browser.simulateUserCookieSet({ domain: '.race.io', name: 'token', value: 'from-B' });
    await devA.engine.flushPendingLocalChanges();
    await devB.engine.flushPendingLocalChanges();

    devA.browser.setOnline(true);
    devB.browser.setOnline(true);

    await devA.engine.syncNow();
    await devB.engine.syncNow();
    await devA.engine.syncNow();
    await devC.engine.syncNow();

    const valA = devA.browser.findJarCookie('token', 'race.io')?.value;
    const valB = devB.browser.findJarCookie('token', 'race.io')?.value;
    const valC = devC.browser.findJarCookie('token', 'race.io')?.value;

    expect(valA).toBe('from-B');
    expect(valB).toBe(valA);
    expect(valC).toBe(valA);

    const conflictsA = await devA.engine.getConflicts();
    expect(conflictsA.length).toBeGreaterThanOrEqual(1);

    // Manual conflict resolution overrides deterministically across all devices
    await devA.engine.resolveConflict(conflictsA[0].conflictId, 'local');
    await devB.engine.syncNow();
    await devC.engine.syncNow();

    expect(devA.browser.findJarCookie('token', 'race.io')?.value).toBe('from-A');
    expect(devB.browser.findJarCookie('token', 'race.io')?.value).toBe('from-A');
    expect(devC.browser.findJarCookie('token', 'race.io')?.value).toBe('from-A');
  });

  it('S-010: Offline edits persist locally and auto-recover once WebDAV comes back online (W-013/W-014)', async () => {
    const { dav, webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });

    // Server goes offline
    dav.quirks.offline = true;

    await devA.browser.simulateUserCookieSet({ domain: '.offline.io', name: 'queued', value: 'val-offline' });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();

    const statusOffline = await devA.engine.getStatusSummary();
    expect(statusOffline.pendingUploads).toBeGreaterThan(0);

    // Server comes back online
    dav.quirks.offline = false;
    const res = await devA.engine.syncNow();
    expect(res.pushedEvents).toBeGreaterThan(0);

    await devB.engine.syncNow();
    expect(devB.browser.findJarCookie('queued', 'offline.io')?.value).toBe('val-offline');
  });

  it('S-011: Engine / Service Worker restart preserves queued outbound events & device identity without duplication', async () => {
    const { dav, webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    const joinA = await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });

    // Queue event while offline, then simulate full MV3 Service Worker restart
    dav.quirks.offline = true;
    await devA.browser.simulateUserCookieSet({ domain: '.restart.io', name: 'survive', value: 'yes' });
    await devA.engine.flushPendingLocalChanges();

    // Restart Device A engine using same storage + keyVault
    await devA.restartEngine();
    const statusAfterRestart = await devA.engine.getStatusSummary();
    expect(statusAfterRestart.device?.deviceId).toBe(joinA.deviceId);
    expect(statusAfterRestart.pendingUploads).toBe(1);
    expect(statusAfterRestart.locked).toBe(false);

    // Come back online and flush queued event
    dav.quirks.offline = false;
    const syncRes = await devA.engine.syncNow();
    expect(syncRes.pushedEvents).toBe(1);

    await devB.engine.syncNow();
    expect(devB.browser.findJarCookie('survive', 'restart.io')?.value).toBe('yes');
  });

  it('S-012: Writing identical cookie value and attributes emits ZERO new events', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    devA.browser.seedCookie({ domain: '.noop.io', name: 'steady', value: 'same', secure: true });
    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });

    const beforeSeq = (await devA.engine.getStatusSummary()).device!.sequence;

    // Re-write exact same value & attributes
    await devA.browser.simulateUserCookieSet({ domain: '.noop.io', name: 'steady', value: 'same', secure: true });
    await devA.engine.flushPendingLocalChanges();
    const pushRes = await devA.engine.syncNow();

    const afterSeq = (await devA.engine.getStatusSummary()).device!.sequence;
    expect(pushRes.pushedEvents).toBe(0);
    expect(afterSeq).toBe(beforeSeq);
  });

  it('S-013: Echo suppression prevents sync loops when remote cookies are applied locally', async () => {
    const { dav, webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    devA.browser.seedCookie({ domain: '.echo.io', name: 'loop', value: 'v1' });
    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });

    const seqBefore = (await devB.engine.getStatusSummary()).device!.sequence;

    await devA.browser.simulateUserCookieSet({ domain: '.echo.io', name: 'loop', value: 'v2' });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();

    await devB.engine.syncNow();
    await devB.engine.flushPendingLocalChanges();

    // Device B applied cookie, which fired onCookieChanged on B, but EchoSuppressor suppressed it!
    const statusB = await devB.engine.getStatusSummary();
    expect(statusB.pendingUploads).toBe(0);
    expect(statusB.device!.sequence).toBe(seqBefore);

    // Extra syncNow on B pushes 0 events and ETag short-circuit keeps requests minimal
    dav.resetStats();
    const secondSync = await devB.engine.syncNow();
    expect(secondSync.pushedEvents).toBe(0);
    expect(secondSync.pulledEvents).toBe(0);
  });

  it('S-014: Clock skew resilience — 6-hour skewed clocks still honor strict causal dominance', async () => {
    const { webdav, harness: h } = setup();
    // Device A clock is 3 hours AHEAD; Device B clock is 3 hours BEHIND
    const devA = await h.createDevice('Device-A', { clockOffsetMs: +3 * 3600 * 1000 });
    const devB = await h.createDevice('Device-B', { clockOffsetMs: -3 * 3600 * 1000 });

    devA.browser.seedCookie({ domain: '.skew.io', name: 'tok', value: 'from-future-A' });
    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });

    expect(devB.browser.findJarCookie('tok', 'skew.io')?.value).toBe('from-future-A');

    // Device B (whose wall clock is 6h behind A!) updates after receiving A's version
    await devB.browser.simulateUserCookieSet({ domain: '.skew.io', name: 'tok', value: 'from-past-B-causal-next' });
    await devB.engine.flushPendingLocalChanges();
    await devB.engine.syncNow();

    await devA.engine.syncNow();
    expect(devA.browser.findJarCookie('tok', 'skew.io')?.value).toBe('from-past-B-causal-next');
  });

  it('S-015: Expired cookie removal is distinguished from explicit logout and does not wipe peer sessions', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    devA.browser.seedCookie({ domain: '.exp.io', name: 'sess', value: 'alive' });
    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });

    // Natural expiration on A
    devA.browser.simulateCookieExpired('sess', 'exp.io');
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();

    const cookiesA = await devA.engine.getSiteCookies('exp.io');
    expect(cookiesA.find((c) => c.name === 'sess')?.syncStatus).toBe('EXPIRED');

    // Device B's session is NOT destroyed by A's natural expiration
    await devB.engine.syncNow();
    expect(devB.browser.findJarCookie('sess', 'exp.io')?.value).toBe('alive');

    // When Device B later refreshes the cookie, Device A receives the new causal version and returns to IN_SYNC
    await devB.browser.simulateUserCookieSet({ domain: '.exp.io', name: 'sess', value: 'refreshed-by-B' });
    await devB.engine.flushPendingLocalChanges();
    await devB.engine.syncNow();
    await devA.engine.syncNow();
    expect(devA.browser.findJarCookie('sess', 'exp.io')?.value).toBe('refreshed-by-B');
    const refreshedA = await devA.engine.getSiteCookies('exp.io');
    expect(refreshedA.find((c) => c.name === 'sess')?.syncStatus).toBe('IN_SYNC');
  });

  it('S-016: Transient overwrite removal followed by new value coalesces as UPDATE (never emits DELETE)', async () => {
    const { webdav, harness: h } = setup(undefined, { debounceMs: 25 });
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    devA.browser.seedCookie({ domain: '.over.io', name: 'jwt', value: 'jwt-1' });
    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });

    // Chromium fires removed:true cause:'overwrite' followed by removed:false cause:'explicit'
    await devA.browser.simulateUserCookieSet({ domain: '.over.io', name: 'jwt', value: 'jwt-2' });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();

    const { events } = await devA.engine.getHistoryAndLogs({ siteKey: 'over.io' });
    expect(events.some((e) => e.operation === 'DELETE')).toBe(false);

    await devB.engine.syncNow();
    expect(devB.browser.findJarCookie('jwt', 'over.io')?.value).toBe('jwt-2');
  });

  it('ETag Short-Circuit + 507 Storage Full halt (W-016) + Corrupt remote file isolation (W-015) + RollingTokenDamper', async () => {
    const { dav, webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    devA.browser.seedCookie({ domain: '.opt.io', name: 'roll', value: 'v0' });
    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });

    // 1. ETag short-circuit: pulling again when nothing changed should NOT re-GET peer device or events
    await devB.engine.syncNow();
    dav.resetStats();
    await devB.engine.syncNow({ direction: 'pull' });
    // At most metadata/space.enc (304) + PROPFIND devices/
    expect(dav.methodCounts['PROPFIND'] ?? 0).toBeLessThanOrEqual(1);
    expect(dav.methodCounts['GET'] ?? 0).toBeLessThanOrEqual(1);

    // 2. RollingTokenDamper: rapid alternating flips between A (foreground tab) and B (background)
    devA.browser.openTab('https://opt.io/home', { active: true });
    for (let i = 1; i <= 4; i++) {
      await devA.browser.simulateUserCookieSet({ domain: '.opt.io', name: 'roll', value: `A-${i}` });
      await devA.engine.flushPendingLocalChanges();
      await devA.engine.syncNow();
      await devB.engine.syncNow();

      await devB.browser.simulateUserCookieSet({ domain: '.opt.io', name: 'roll', value: `B-${i}` });
      await devB.engine.flushPendingLocalChanges();
      await devB.engine.syncNow();
      await devA.engine.syncNow();
    }
    const overviewB = await devB.engine.getSitesOverview();
    expect(overviewB.find((s) => s.siteKey === 'opt.io')?.rollingTokenDamped).toBe(true);

    // 3. Corrupt remote event file isolation (W-015)
    await devA.browser.simulateUserCookieSet({ domain: '.corrupt.io', name: 'ok', value: 'good' });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();

    const storedPaths = dav.listAllStoredPaths();
    const targetEventPath = storedPaths.find((p) => p.includes('/events/') && p.endsWith('.enc'))!;
    expect(targetEventPath).toBeTruthy();
    dav.corruptFile(targetEventPath);

    // Device C joins — must isolate corrupt event file and NOT crash
    const devC = await h.createDevice('Device-C');
    await expect(
      devC.engine.saveAndJoinSpace({
        webdav,
        spaceId: SPACE_ID,
        spaceName: SPACE_NAME,
        encryptionPassword: ENC_PASS,
        deviceName: 'Device-C',
      }),
    ).resolves.toBeTruthy();
    const integrity = await devC.engine.checkIntegrity();
    expect(integrity.corruptedPaths.length).toBeGreaterThanOrEqual(1);

    // 4. HTTP 507 Storage Full halts write retries immediately (W-016)
    dav.quirks.storageQuotaBytes = 10; // tiny quota forces 507
    await devA.browser.simulateUserCookieSet({ domain: '.full.io', name: 'big', value: 'x'.repeat(200) });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();
    const statusFull = await devA.engine.getStatusSummary();
    expect(statusFull.latestError?.code).toBe('ERR_STORAGE_FULL');
    const tasksAfter507 = await devA.engine.getRetryTasks();
    expect(tasksAfter507.every((t) => t.status !== 'RETRYING')).toBe(true);
  });
});
