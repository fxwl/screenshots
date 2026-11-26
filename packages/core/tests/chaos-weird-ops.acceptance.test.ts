import { describe, it, expect, afterEach } from 'vitest';
import { MockWebDAVServer } from '@sessionmesh/webdav-mock';
import { toStructuredError } from '../src/diagnostics';
import { parseEnvTarget } from '../src/sync/EnvCookieMapper';
import { MultiDeviceHarness } from '../src/sim';
import type { WebDAVConfig } from '../src/types';

function createBaseConfig(): WebDAVConfig {
  return {
    url: 'https://dav.chaos.test/webdav',
    authType: 'basic',
    username: 'chaosuser',
    password: 'chaos-password-123',
    rootPath: '/mesh',
  };
}

describe('Chaos, Weird Operations, Fault-Injection & Real-HTTP E2E Suite', () => {
  let harness: MultiDeviceHarness | null = null;

  afterEach(() => {
    harness?.disposeAll();
    harness = null;
  });

  function setup() {
    const dav = new MockWebDAVServer({
      requireAuth: { username: 'chaosuser', password: 'chaos-password-123' },
    });
    const webdav = createBaseConfig();
    harness = new MultiDeviceHarness({
      webdav,
      fetchImpl: dav.fetchImpl,
      debounceMs: 0,
      refreshCoalesceMs: 0,
      pbkdf2Iterations: 1000,
    });
    return { dav, webdav, harness };
  }

  const SPACE_ID = 'chaos-space';
  const SPACE_NAME = 'Chaos Lab';
  const ENC_PASS = 'Chaos-Master-Pass-2026!';

  it('CHAOS-001: Locked session rejects ALL multi-account & env-sync mutations cleanly with zero browser/state corruption', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    devA.browser.seedCookie({ domain: '.locked.io', name: 'sid', value: 'acct_1_safe' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });
    const track2 = await devA.engine.createSiteAccountTrack('locked.io', {
      mode: 'clean_new',
      label: '账号2',
    });
    await devA.browser.simulateUserCookieSet({
      domain: '.locked.io',
      name: 'sid',
      value: 'acct_2_safe',
    });
    await devA.engine.flushPendingLocalChanges();

    // Lock the session (DEK wiped from memory)
    await devA.engine.lockSession();

    // Every mutating multi-account / env-sync operation MUST reject BEFORE mutating cookies or tracks!
    await expect(devA.engine.rotateSiteTrack('locked.io', 'next')).rejects.toThrow(/locked/i);
    await expect(
      devA.engine.createSiteAccountTrack('locked.io', { mode: 'clean_new', label: '非法新建' }),
    ).rejects.toThrow(/locked/i);
    await expect(devA.engine.switchSiteTrack('locked.io', track2.trackId)).rejects.toThrow(/locked/i);
    await expect(devA.engine.deleteSiteTrack('locked.io', track2.trackId)).rejects.toThrow(/locked/i);
    await expect(devA.engine.renameSiteTrack('locked.io', track2.trackId, '改名')).rejects.toThrow(
      /locked/i,
    );
    await expect(
      devA.engine.upsertEnvSyncRule({
        scope: 'device',
        enabled: true,
        sourceSiteKey: 'locked.io',
        targetUrl: 'http://localhost:3000',
        syncCookies: true,
        syncLocalStorage: false,
        adaptForHttp: true,
        cleanTargetBeforeSync: false,
        autoSync: false,
        autoReloadTarget: false,
      }),
    ).rejects.toThrow(/locked/i);
    await expect(
      devA.engine.executeEnvCookieSync({
        adHoc: { sourceSiteKey: 'locked.io', targetUrl: 'http://localhost:3000' },
      }),
    ).rejects.toThrow(/locked/i);
    await expect(
      devA.engine.upsertLocalStorageItem('https://locked.io', 'k_locked', 'v_locked'),
    ).rejects.toThrow(/locked/i);
    await expect(
      devA.engine.upsertCookie('locked.io', {
        domain: '.locked.io',
        name: 'ck_locked',
        value: 'v',
        path: '/',
        hostOnly: false,
        secure: false,
        httpOnly: false,
        sameSite: 'lax',
        session: true,
      }),
    ).rejects.toThrow(/locked/i);
    await expect(devA.engine.updateSpaceSettings({ pollingIntervalSec: 120 })).rejects.toThrow(/locked/i);

    // Browser jar and tracks were 100% untouched!
    expect(devA.browser.findJarCookie('sid', 'locked.io')?.value).toBe('acct_2_safe');

    // Unlocking with wrong password fails; right password unlocks and rotation works immediately!
    await expect(devA.engine.unlockSession('wrong-pass')).rejects.toThrow();
    await devA.engine.unlockSession(ENC_PASS);
    const rotated = await devA.engine.rotateSiteTrack('locked.io', 'next');
    expect(rotated.total).toBe(2);
    expect(devA.browser.findJarCookie('sid', 'locked.io')?.value).toBe('acct_1_safe');
  });

  it('CHAOS-002: WebDAV 503 outage & 507 storage-full during account rotation/creation/delete never corrupts local switch or skips persistence', async () => {
    const { dav, webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    devA.browser.seedCookie({ domain: '.outage.io', name: 'tok', value: 'v1_before_outage' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    // Simulate sudden WebDAV outage (network blackout) while browser thinks it is online!
    dav.quirks.offline = true;

    // Create Account 2, log in, rotate back & forth — ALL MUST SUCCEED LOCALLY without throwing!
    const track2 = await devA.engine.createSiteAccountTrack('outage.io', {
      mode: 'clean_new',
      label: '断网新建号',
    });
    expect(devA.browser.findJarCookie('tok', 'outage.io')).toBeUndefined();

    await devA.browser.simulateUserCookieSet({
      domain: '.outage.io',
      name: 'tok',
      value: 'v2_created_during_503',
    });
    const rotTo1 = await devA.engine.rotateSiteTrack('outage.io', 'next');
    expect(rotTo1.track.trackId).not.toBe(track2.trackId);
    expect(devA.browser.findJarCookie('tok', 'outage.io')?.value).toBe('v1_before_outage');

    // Simulate HTTP 507 Storage Full during rotation back to track2
    dav.quirks.offline = false;
    dav.quirks.storageQuotaBytes = 1;
    const rotTo2 = await devA.engine.rotateSiteTrack('outage.io', 'next');
    expect(rotTo2.track.trackId).toBe(track2.trackId);
    expect(devA.browser.findJarCookie('tok', 'outage.io')?.value).toBe('v2_created_during_503');

    // Cold MV3 restart during outage -> persisted runtime MUST still remember track2 & its cookies!
    await devA.restartEngine();
    const overviewAfterRestart = await devA.engine.getSitesOverview();
    const outageSite = overviewAfterRestart.find((s) => s.siteKey === 'outage.io')!;
    expect(outageSite.activeTrack?.trackId).toBe(track2.trackId);
    expect(outageSite.allTracks).toHaveLength(2);

    // WebDAV recovers -> Device A syncs queued changes -> Device B receives both tracks!
    dav.quirks.storageQuotaBytes = undefined;
    await devA.engine.syncNow({ userInitiated: true });
    const joinB = await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-B',
    });
    const bTrack2Cookies = await devB.engine.getSiteCookies('outage.io', track2.trackId);
    expect(bTrack2Cookies.find((c) => c.name === 'tok')?.value).toBe('v2_created_during_503');
    expect(joinB.pendingDecisions[0]?.remoteTracks).toHaveLength(2);
  });

  it('CHAOS-003: clean_new during PENDING_CHOICE archives local login, blacklist blocks all track switches, and device disabled policy still permits local rotation', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    devA.browser.seedCookie({ domain: '.pending-chaos.io', name: 'uid', value: 'remote_A' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    // Device B already has its own local login cookies AND joins -> enters PENDING_CHOICE!
    devB.browser.seedCookie({ domain: '.pending-chaos.io', name: 'uid', value: 'local_B_precious' });
    const joinB = await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-B',
    });
    expect(joinB.pendingDecisions.some((d) => d.siteKey === 'pending-chaos.io')).toBe(true);

    // Weird action: User ignores PENDING_CHOICE and clicks "+ 空白新账号" directly!
    const track3 = await devB.engine.createSiteAccountTrack('pending-chaos.io', {
      mode: 'clean_new',
      label: '直接新建号',
    });
    expect(track3.label).toBe('直接新建号');
    expect(devB.browser.findJarCookie('uid', 'pending-chaos.io')).toBeUndefined();

    // Verify Device B's precious local_B_precious WAS archived (total 3 tracks: remote_A, Device-B 原账号, 直接新建号)!
    const overviewB = await devB.engine.getSitesOverview();
    const chaosSite = overviewB.find((s) => s.siteKey === 'pending-chaos.io')!;
    expect(chaosSite.allTracks).toHaveLength(3);
    const archivedLocal = chaosSite.allTracks.find((t) => t.label.includes('原账号'))!;
    expect(archivedLocal).toBeDefined();

    await devB.engine.switchSiteTrack('pending-chaos.io', archivedLocal.trackId);
    expect(devB.browser.findJarCookie('uid', 'pending-chaos.io')?.value).toBe('local_B_precious');

    // Blacklisting blocks ALL track switching/rotation/creation/splitting cleanly!
    const bl = await devB.engine.addBlacklistEntry({
      pattern: 'pending-chaos.io',
      matchType: 'subdomain',
      scope: 'device',
      presetCategory: 'custom',
    });
    await expect(devB.engine.rotateSiteTrack('pending-chaos.io', 'next')).rejects.toThrow(/黑名单/);
    await expect(
      devB.engine.switchSiteTrack('pending-chaos.io', track3.trackId),
    ).rejects.toThrow(/黑名单/);
    await expect(devB.engine.splitSiteIndependent('pending-chaos.io')).rejects.toThrow(/黑名单/);
    await expect(
      devB.engine.createSiteAccountTrack('pending-chaos.io', { mode: 'clean_new' }),
    ).rejects.toThrow(/blacklisted/i);

    // Remove blacklist -> previously bound active track is immediately restored cleanly!
    await devB.engine.removeBlacklistEntry(bl.id, 'device');
    const restoredOverview = (await devB.engine.getSitesOverview()).find(
      (s) => s.siteKey === 'pending-chaos.io',
    )!;
    expect(restoredOverview.binding.state).toBe('USER_BOUND');
    expect(restoredOverview.activeTrack?.trackId).toBe(archivedLocal.trackId);

    // Set device policy direction = 'disabled' -> local rotation STILL works!
    const summaryB = await devB.engine.getStatusSummary();
    await devB.engine.upsertDevicePolicy({
      deviceId: summaryB.device!.deviceId,
      mode: 'inherit',
      direction: 'disabled',
      updatedAt: Date.now(),
    });
    const rotDisabled = await devB.engine.rotateSiteTrack('pending-chaos.io', 'next');
    expect(rotDisabled.siteKey).toBe('pending-chaos.io');
    expect(rotDisabled.total).toBe(3);
  });

  it('CHAOS-004: Weird/hostile inputs — sp_../../ traversal, control chars & 500-char labels, URL credentials stripping, bare IPv6, Punycode IDN, colliding sibling cookies, single-track no-op', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    // 1. Path traversal in `sp_../../evil` spaceId is safely hashed (not treated as raw path!)
    const traversalVerify = await devA.engine.verifyRemoteSpacePassword({
      webdav,
      spaceId: 'sp_../../etc/passwd',
      encryptionPassword: ENC_PASS,
    });
    expect(traversalVerify).toEqual({ exists: false, verified: false });

    // 2. Parse weird target URLs
    expect(parseEnvTarget('::1')?.host).toBe('[::1]');
    expect(parseEnvTarget('http://[::1]:3000')?.origin).toBe('http://[::1]:3000');
    expect(parseEnvTarget('http://例子.测试:3000')?.host).toBe('xn--fsqu00a.xn--0zwm56d');
    expect(parseEnvTarget('chrome://settings')).toBeNull();
    expect(parseEnvTarget('edge://extensions')).toBeNull();
    expect(parseEnvTarget('file:///C:/Users/test.html')).toBeNull();
    expect(parseEnvTarget('javascript:alert(1)')).toBeNull();
    expect(parseEnvTarget('about:blank')).toBeNull();
    expect(parseEnvTarget('...')).toBeNull();
    expect(parseEnvTarget('   ')).toBeNull();

    // 3. Seed weird & colliding cookies on same site: empty value, unicode/semicolon value,
    // hostOnly vs wildcard domain + sibling /admin path!
    devA.browser.seedCookie({
      domain: '.weird.io',
      hostOnly: false,
      path: '/',
      name: 'sess',
      value: 'root_domain_val; 中文🎉=1',
    });
    devA.browser.seedCookie({
      domain: 'weird.io',
      hostOnly: true,
      path: '/',
      name: 'sess',
      value: 'host_only_val',
    });
    devA.browser.seedCookie({
      domain: 'weird.io',
      hostOnly: true,
      path: '/admin',
      name: 'sess',
      value: 'admin_path_val',
    });
    devA.browser.seedCookie({
      domain: '.weird.io',
      name: 'empty_flag',
      value: '',
    });

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    // Single-track rotate is a clean no-op (no spurious revision bump or tab reload!)
    const tabId = devA.browser.openTab('https://weird.io/', { active: true, safeToReload: true });
    const t1Before = (await devA.engine.getSitesOverview()).find((s) => s.siteKey === 'weird.io')!
      .activeTrack!;
    const noopRot = await devA.engine.rotateSiteTrack('weird.io', 'next');
    expect(noopRot.index).toBe(1);
    expect(noopRot.total).toBe(1);
    expect(devA.browser.reloadedTabIds).not.toContain(tabId);
    const t1After = (await devA.engine.getSitesOverview()).find((s) => s.siteKey === 'weird.io')!
      .activeTrack!;
    expect(t1After.revision).toBe(t1Before.revision);

    // Rename with full uppercase URL + control chars + 500-char garbage -> sanitized & capped <= 80 chars!
    const hugeDirtyLabel = `  超级\r\n\t\x00管理  ${'A'.repeat(400)}`;
    await devA.engine.renameSiteTrack('https://APP.WEIRD.IO:443/home?x=1', t1Before.trackId, hugeDirtyLabel);
    const renamed = (await devA.engine.getSitesOverview()).find((s) => s.siteKey === 'weird.io')!
      .activeTrack!;
    expect(renamed.label.length).toBeLessThanOrEqual(80);
    expect(/[\r\n\t\x00]/.test(renamed.label)).toBe(false);
    expect(renamed.label.startsWith('超级管理 A')).toBe(true);

    // Create Account 2, rotate back to Account 1 -> all 4 colliding/empty/unicode cookies survive intact!
    await devA.engine.createSiteAccountTrack('weird.io', {
      mode: 'clean_new',
      label: '账号2',
    });
    await devA.browser.simulateUserCookieSet({
      domain: '.weird.io',
      name: 'sess',
      value: 'acct2_only',
    });
    await devA.engine.rotateSiteTrack('weird.io', 'next');
    const restoredAll = await devA.browser.getAllCookies({ domain: 'weird.io' });
    expect(restoredAll).toHaveLength(4);
    expect(restoredAll.find((c) => !c.hostOnly && c.name === 'sess')?.value).toBe(
      'root_domain_val; 中文🎉=1',
    );
    expect(restoredAll.find((c) => c.hostOnly && c.path === '/')?.value).toBe('host_only_val');
    expect(restoredAll.find((c) => c.hostOnly && c.path === '/admin')?.value).toBe('admin_path_val');
    expect(restoredAll.find((c) => c.name === 'empty_flag')?.value).toBe('');

    // Credentials & query secrets pasted into targetUrl are stripped before saving!
    const cleanRule = await devA.engine.upsertEnvSyncRule({
      scope: 'device',
      enabled: true,
      sourceSiteKey: 'weird.io',
      targetUrl: 'http://admin:TOPSECRET@localhost:3000/dashboard?jwt=leak#frag',
      syncCookies: true,
      syncLocalStorage: false,
      adaptForHttp: true,
      cleanTargetBeforeSync: false,
      autoSync: false,
      autoReloadTarget: false,
    });
    expect(cleanRule.targetUrl).toBe('http://localhost:3000');

    // Reject dead rule where BOTH syncCookies and syncLocalStorage are false
    await expect(
      devA.engine.upsertEnvSyncRule({
        scope: 'device',
        enabled: true,
        sourceSiteKey: 'weird.io',
        targetUrl: 'http://localhost:4000',
        syncCookies: false,
        syncLocalStorage: false,
        adaptForHttp: true,
        cleanTargetBeforeSync: false,
        autoSync: false,
        autoReloadTarget: false,
      }),
    ).rejects.toThrow(/至少开启/);
  });

  it('CHAOS-005: Concurrent Promise.all action storm (8 parallel rotations, duplicate delete race, concurrent env sync)', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    devA.browser.seedCookie({ domain: '.storm.io', name: 'acct', value: 'A1' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    const t2 = await devA.engine.createSiteAccountTrack('storm.io', {
      mode: 'clean_new',
      label: 'A2',
      triggerRefresh: false,
    });
    await devA.browser.simulateUserCookieSet({ domain: '.storm.io', name: 'acct', value: 'A2' });

    await devA.engine.createSiteAccountTrack('storm.io', {
      mode: 'clean_new',
      label: 'A3',
      triggerRefresh: false,
    });
    await devA.browser.simulateUserCookieSet({ domain: '.storm.io', name: 'acct', value: 'A3' });

    // Fire 8 concurrent rotations in parallel! (Currently on A3 -> 8 steps mod 3 = 2 -> lands on A2)
    const rotResults = await Promise.all(
      Array.from({ length: 8 }, () => devA.engine.rotateSiteTrack('storm.io', 'next')),
    );
    expect(rotResults).toHaveLength(8);
    const finalRot = rotResults[7]!;
    expect(finalRot.track.label).toBe('A2');
    expect(devA.browser.findJarCookie('acct', 'storm.io')?.value).toBe('A2');

    // Concurrent double-delete race on the same trackId -> 1 succeeds, 1 rejects cleanly!
    const deleteSettlements = await Promise.allSettled([
      devA.engine.deleteSiteTrack('storm.io', t2.trackId),
      devA.engine.deleteSiteTrack('storm.io', t2.trackId),
    ]);
    expect(deleteSettlements.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(deleteSettlements.filter((r) => r.status === 'rejected')).toHaveLength(1);

    // Remaining 2 tracks intact and browser jar matches active track
    const afterStorm = (await devA.engine.getSitesOverview()).find((s) => s.siteKey === 'storm.io')!;
    expect(afterStorm.allTracks).toHaveLength(2);
    expect(devA.browser.findJarCookie('acct', 'storm.io')?.value).toBe('A1');
  });

  it('CHAOS-006: Multi-tab (3 tabs) LocalStorage echo suppression absorbs all fan-out echoes while passing real divergent user edits immediately', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    // Open 3 tabs on the same origin!
    devA.browser.openTab('https://multitab.io/tab1', { active: true });
    devA.browser.openTab('https://multitab.io/tab2', { active: false });
    devA.browser.openTab('https://multitab.io/tab3', { active: false });
    devA.browser.seedLocalStorage('https://multitab.io', { jwt: 'acct1_jwt', empty_k: '' });

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });
    await devA.engine.ingestLocalStorageSnapshot('https://multitab.io', {
      jwt: 'acct1_jwt',
      empty_k: '',
    });

    await devA.engine.createSiteAccountTrack('multitab.io', {
      mode: 'clean_new',
      label: 'Account 2',
      triggerRefresh: false,
    });
    devA.browser.seedLocalStorage('https://multitab.io', { jwt: 'acct2_jwt' });
    await devA.engine.ingestLocalStorageMutations('https://multitab.io', [
      { key: 'jwt', value: 'acct2_jwt' },
    ]);
    await devA.engine.syncNow();

    // Rotate back to Account 1 (applies jwt='acct1_jwt' & empty_k='')
    await devA.engine.rotateSiteTrack('multitab.io', 'next');
    const historyBeforeEchoes = (await devA.engine.getHistoryAndLogs({ siteKey: 'multitab.io' }))
      .events.length;

    // Simulate ALL 3 tabs echoing the exact applied LS value within 100ms!
    for (let t = 0; t < 3; t += 1) {
      devA.browser.advanceTime(30);
      await devA.engine.ingestLocalStorageMutations('https://multitab.io', [
        { key: 'jwt', value: 'acct1_jwt' },
        { key: 'empty_k', value: '' },
      ]);
    }
    const historyAfterEchoes = (await devA.engine.getHistoryAndLogs({ siteKey: 'multitab.io' }))
      .events.length;
    expect(historyAfterEchoes).toBe(historyBeforeEchoes);

    // Real divergent user edit arriving 100ms later (still inside TTL) passes through immediately!
    devA.browser.advanceTime(100);
    await devA.engine.ingestLocalStorageMutations('https://multitab.io', [
      { key: 'jwt', value: 'acct1_jwt_fresh_user_edit' },
    ]);
    const lsRecs = await devA.engine.getLocalStorageRecords({ siteKey: 'multitab.io' });
    expect(lsRecs.some((r) => r.key === 'jwt' && r.value === 'acct1_jwt_fresh_user_edit')).toBe(
      true,
    );
  });

  it('CHAOS-007: SSO Domain Group multi-account rotation swaps sibling SSO domains atomically and env-syncs both domains', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    await devA.engine.upsertSsoGroup({
      groupId: 'sso-corp',
      name: 'Corp Unified SSO',
      primarySiteKey: 'corp.com',
      domains: ['corp.com', 'corp-cloud.net'],
    });

    // Account 1 logged into BOTH SSO domains
    await devA.browser.simulateUserCookieSet({
      domain: '.corp.com',
      name: 'sso_id',
      value: 'u1_main',
    });
    await devA.browser.simulateUserCookieSet({
      domain: '.corp-cloud.net',
      name: 'cloud_tok',
      value: 'u1_cloud',
    });
    await devA.engine.flushPendingLocalChanges();

    // Create Account 2 cleanly -> wipes BOTH corp.com AND corp-cloud.net!
    await devA.engine.createSiteAccountTrack('corp.com', {
      mode: 'clean_new',
      label: 'SSO 账号 2',
      triggerRefresh: false,
    });
    expect(devA.browser.findJarCookie('sso_id', 'corp.com')).toBeUndefined();
    expect(devA.browser.findJarCookie('cloud_tok', 'corp-cloud.net')).toBeUndefined();

    // Log Account 2 into BOTH SSO domains
    await devA.browser.simulateUserCookieSet({
      domain: '.corp.com',
      name: 'sso_id',
      value: 'u2_main',
    });
    await devA.browser.simulateUserCookieSet({
      domain: '.corp-cloud.net',
      name: 'cloud_tok',
      value: 'u2_cloud',
    });

    // Rotate back to Account 1 -> BOTH domains restore atomically!
    await devA.engine.rotateSiteTrack('corp.com', 'next');
    expect(devA.browser.findJarCookie('sso_id', 'corp.com')?.value).toBe('u1_main');
    expect(devA.browser.findJarCookie('cloud_tok', 'corp-cloud.net')?.value).toBe('u1_cloud');

    // Env sync corp.com -> http://localhost:3000 carries cookies from BOTH SSO domains!
    const envRes = await devA.engine.executeEnvCookieSync({
      adHoc: {
        sourceSiteKey: 'corp.com',
        targetUrl: 'http://localhost:3000',
      },
    });
    expect(envRes.appliedCookies).toBe(2);
    expect(devA.browser.findJarCookie('sso_id', 'localhost')?.value).toBe('u1_main');
    expect(devA.browser.findJarCookie('cloud_tok', 'localhost')?.value).toBe('u1_cloud');
  });

  it('CHAOS-008: REAL HTTP local WebDAV server (TCP socket + real fetch) full multi-device E2E lifecycle', async () => {
    const realDav = new MockWebDAVServer({
      requireAuth: { username: 'realadmin', password: 'realpassword123' },
    });
    const running = await realDav.startHttpServer(0);

    try {
      const realWebdav: WebDAVConfig = {
        url: running.url,
        authType: 'basic',
        username: 'realadmin',
        password: 'realpassword123',
        rootPath: '/SessionMeshRealTest',
        allowInsecureLocalhostForTesting: true,
      };

      const realHarness = new MultiDeviceHarness({
        webdav: realWebdav,
        fetchImpl: globalThis.fetch,
        debounceMs: 0,
        refreshCoalesceMs: 0,
        pbkdf2Iterations: 1000,
      });
      harness = realHarness;

      const devA = await realHarness.createDevice('Real-Laptop-A');
      const devB = await realHarness.createDevice('Real-Desktop-B');

      // 1. Real 19-point capability probe over live HTTP socket!
      const cap = await devA.engine.testWebDAVConnection(realWebdav);
      expect(cap.overallOk).toBe(true);

      // 2. Pre-creation E2E password verification over real HTTP -> exists: false
      const preVerify = await devB.engine.verifyRemoteSpacePassword({
        webdav: realWebdav,
        spaceId: 'real-http-space',
        encryptionPassword: ENC_PASS,
      });
      expect(preVerify).toEqual({ exists: false, verified: false });

      // 3. Device A joins & creates 2 accounts + space-scoped env rule over real HTTP
      devA.browser.seedCookie({
        domain: '.realprod.com',
        name: 'session_jwt',
        value: 'real_acct_1',
        secure: true,
        httpOnly: true,
      });
      await devA.engine.saveAndJoinSpace({
        webdav: realWebdav,
        spaceId: 'real-http-space',
        spaceName: 'Real HTTP Space',
        encryptionPassword: ENC_PASS,
        deviceName: 'Real-Laptop-A',
      });
      await devA.engine.createSiteAccountTrack('realprod.com', {
        mode: 'clean_new',
        label: '实测小号 2',
      });
      await devA.browser.simulateUserCookieSet({
        domain: '.realprod.com',
        name: 'session_jwt',
        value: 'real_acct_2',
        secure: true,
        httpOnly: true,
      });
      // Targeting exact same local WebDAV port is STILL blocked, while a different local dev port (:5173) works!
      await expect(
        devA.engine.upsertEnvSyncRule({
          scope: 'device',
          enabled: true,
          sourceSiteKey: 'realprod.com',
          targetUrl: running.url,
          syncCookies: true,
          syncLocalStorage: false,
          adaptForHttp: true,
          cleanTargetBeforeSync: false,
          autoSync: false,
          autoReloadTarget: false,
        }),
      ).rejects.toThrow(/WebDAV/);

      await devA.engine.upsertEnvSyncRule({
        scope: 'space',
        enabled: true,
        sourceSiteKey: 'realprod.com',
        targetUrl: 'http://127.0.0.1:5173',
        syncCookies: true,
        syncLocalStorage: false,
        adaptForHttp: true,
        cleanTargetBeforeSync: true,
        autoSync: true,
        autoReloadTarget: false,
      });
      await devA.engine.flushPendingLocalChanges();
      await devA.engine.syncNow({ userInitiated: true });

      // 4. Device B verifies wrong password -> DECRYPT_ERROR; right password -> verified: true!
      const wrongVerify = await devB.engine.verifyRemoteSpacePassword({
        webdav: realWebdav,
        spaceId: 'real-http-space',
        encryptionPassword: 'wrong-real-password',
      });
      expect(wrongVerify.exists).toBe(true);
      expect(wrongVerify.verified).toBe(false);
      expect(wrongVerify.errorCode).toBe('DECRYPT_ERROR');

      const okVerify = await devB.engine.verifyRemoteSpacePassword({
        webdav: realWebdav,
        spaceId: 'real-http-space',
        encryptionPassword: ENC_PASS,
      });
      expect(okVerify.exists).toBe(true);
      expect(okVerify.verified).toBe(true);
      expect(okVerify.spaceName).toBe('Real HTTP Space');

      // 5. Device B joins over real HTTP, resolves to Account 2, rotates to Account 1, verifies localhost auto-sync!
      const joinB = await devB.engine.saveAndJoinSpace({
        webdav: realWebdav,
        spaceId: 'real-http-space',
        spaceName: 'Real HTTP Space',
        encryptionPassword: ENC_PASS,
        deviceName: 'Real-Desktop-B',
      });
      const acct2Track = joinB.pendingDecisions[0]!.remoteTracks.find(
        (t) => t.label === '实测小号 2',
      )!;
      await devB.engine.resolveSiteDecision('realprod.com', {
        type: 'use_remote_track',
        trackId: acct2Track.trackId,
      });
      expect(devB.browser.findJarCookie('session_jwt', 'realprod.com')?.value).toBe('real_acct_2');

      // Rotate on Device B -> switches to real_acct_1 AND auto-syncs to 127.0.0.1!
      await devB.engine.rotateSiteTrack('realprod.com', 'next');
      expect(devB.browser.findJarCookie('session_jwt', 'realprod.com')?.value).toBe('real_acct_1');
      expect(devB.browser.findJarCookie('session_jwt', '127.0.0.1')?.value).toBe('real_acct_1');
    } finally {
      await running.close();
    }
  });

  it('CHAOS-009: Partial browser cookie rejection during env sync reports exact errors, expired cookies skipped, and multi-space rules stay strictly isolated', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    // Seed expired cookie + accepted cookie + cookie that browser will reject
    devA.browser.seedCookie({
      domain: '.partial.io',
      name: 'expired_old',
      value: 'dead',
      session: false,
      expirationDate: Math.floor(Date.now() / 1000) - 3600,
    });
    devA.browser.seedCookie({
      domain: '.partial.io',
      name: 'good_tok',
      value: 'alive',
    });
    devA.browser.seedCookie({
      domain: '.partial.io',
      name: 'browser_blocked',
      value: 'nope',
    });

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: 'space-alpha',
      spaceName: 'Alpha',
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    devA.browser.rejectCookiePredicate = (d) =>
      d.name === 'browser_blocked' ? 'Simulated Chromium rejection' : null;

    const ruleAlpha = await devA.engine.upsertEnvSyncRule({
      scope: 'device',
      enabled: true,
      sourceSiteKey: 'partial.io',
      targetUrl: 'http://localhost:3000',
      syncCookies: true,
      syncLocalStorage: false,
      adaptForHttp: true,
      cleanTargetBeforeSync: false,
      autoSync: false,
      autoReloadTarget: false,
      includeCookieNames: ['good_tok', 'browser_blocked', 'exclude_wins'],
      excludeCookieNames: ['exclude_wins'],
    });
    const res = await devA.engine.executeEnvCookieSync({ ruleId: ruleAlpha.id });
    expect(res.appliedCookies).toBe(1);
    expect(res.failedCookies).toBe(1);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain('browser_blocked');

    // Create and switch to Space Beta -> Space Alpha's env rules & tracks MUST NOT leak into Space Beta!
    devA.browser.rejectCookiePredicate = undefined;
    await devA.engine.createSpace('space-beta', 'Beta', 'Beta-Pass-999!');
    expect((await devA.engine.getRulesAndBlacklist()).envSyncRules).toHaveLength(0);

    // Switch back to Space Alpha -> Alpha's rule is still intact!
    await devA.engine.switchSpace('space-alpha', ENC_PASS);
    expect((await devA.engine.getRulesAndBlacklist()).envSyncRules).toHaveLength(1);
  });

  it('CHAOS-010: Global Pause (setGlobalPaused) guarantees ZERO WebDAV network traffic during local account rotation/creation/deletion until unpaused', async () => {
    const { dav, webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    devA.browser.seedCookie({ domain: '.paused.io', name: 'sid', value: 'acct_1' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    await devA.engine.setGlobalPaused(true);
    dav.resetStats();

    // Perform local multi-account creation & rotation while globally paused
    const t2 = await devA.engine.createSiteAccountTrack('paused.io', {
      mode: 'clean_new',
      label: '暂停时建号',
      triggerRefresh: false,
    });
    await devA.browser.simulateUserCookieSet({
      domain: '.paused.io',
      name: 'sid',
      value: 'acct_2_paused',
    });
    await devA.engine.rotateSiteTrack('paused.io', 'next');
    expect(devA.browser.findJarCookie('sid', 'paused.io')?.value).toBe('acct_1');
    await devA.engine.rotateSiteTrack('paused.io', 'next');
    expect(devA.browser.findJarCookie('sid', 'paused.io')?.value).toBe('acct_2_paused');
    await devA.engine.deleteSiteTrack('paused.io', t2.trackId);

    // ZERO WebDAV requests were sent while globally paused!
    expect(dav.requestCount).toBe(0);

    // Unpause -> syncNow pushes pending changes to WebDAV cleanly!
    await devA.engine.setGlobalPaused(false);
    await devA.engine.syncNow({ userInitiated: true });
    expect(dav.requestCount).toBeGreaterThan(0);
  });

  it('CHAOS-011: Cloud Backup restoreBackup resurrects deleted accounts across devices without removedTracks re-deletion, IME full-width URLs parse cleanly, and importRulesJson drops WebDAV-self/duplicate env rules', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    // Full-width CJK IME colon/dot normalization
    expect(parseEnvTarget('http://localhost：3000')?.origin).toBe('http://localhost:3000');
    expect(parseEnvTarget('localhost：5173')?.origin).toBe('http://localhost:5173');
    expect(parseEnvTarget('dev。myapp。local：8080')?.origin).toBe('http://dev.myapp.local:8080');

    devA.browser.seedCookie({ domain: '.backup-acct.io', name: 'sid', value: 'acct_1_val' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    const track2 = await devA.engine.createSiteAccountTrack('backup-acct.io', {
      mode: 'clean_new',
      label: '重要账号2',
      triggerRefresh: false,
    });
    await devA.browser.simulateUserCookieSet({
      domain: '.backup-acct.io',
      name: 'sid',
      value: 'acct_2_precious',
    });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();

    // Create backup while both accounts exist
    const { backupId } = await devA.engine.createBackup();

    // Device B joins and sees both tracks
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-B',
    });

    // Accidentally delete track2 on Device A -> Device B pulls removal
    await devA.engine.deleteSiteTrack('backup-acct.io', track2.trackId);
    await devB.engine.syncNow();
    expect(
      (await devB.engine.getSitesOverview()).find((s) => s.siteKey === 'backup-acct.io')?.allTracks,
    ).toHaveLength(1);

    // Restore backup on Device A -> track2 MUST be resurrected on BOTH Device A and Device B!
    await devA.engine.restoreBackup(backupId);
    await devA.engine.syncNow();
    await devB.engine.syncNow();

    const tracksA =
      (await devA.engine.getSitesOverview()).find((s) => s.siteKey === 'backup-acct.io')?.allTracks ??
      [];
    const tracksB =
      (await devB.engine.getSitesOverview()).find((s) => s.siteKey === 'backup-acct.io')?.allTracks ??
      [];
    expect(tracksA).toHaveLength(2);
    expect(tracksB).toHaveLength(2);
    expect(tracksB.some((t) => t.trackId === track2.trackId)).toBe(true);

    // importRulesJson filters out rules targeting WebDAV server itself & deduplicates identical IDs
    await devA.engine.importRulesJson({
      envSyncRules: [
        { id: 'r_webdav', sourceSiteKey: 'a.com', targetUrl: 'https://dav.chaos.test' },
        { id: 'r_dup', sourceSiteKey: 'a.com', targetUrl: 'http://localhost:3000' },
        { id: 'r_dup', sourceSiteKey: 'b.com', targetUrl: 'http://localhost:4000' },
      ],
    });
    const importedSpaceEnv = (await devA.engine.getRulesAndBlacklist()).envSyncRules.filter(
      (r) => r.scope === 'space',
    );
    expect(importedSpaceEnv).toHaveLength(1);
    expect(importedSpaceEnv[0]?.id).toBe('r_dup');
  });

  it('CHAOS-012: Reverse env write-back from local dev port works even when WebDAV self-host shares 127.0.0.1 on a different port, while identical WebDAV port stays strictly blocked', async () => {
    const dav = new MockWebDAVServer({
      requireAuth: { username: 'u', password: 'p' },
    });
    const running = await dav.startHttpServer(0);
    const localWebdav: WebDAVConfig = {
      url: running.url, // e.g. http://127.0.0.1:<davPort>
      authType: 'basic',
      username: 'u',
      password: 'p',
      rootPath: '/SessionMeshChaos12',
      allowInsecureLocalhostForTesting: true,
    };

    try {
      const h = new MultiDeviceHarness({
        webdav: localWebdav,
        fetchImpl: globalThis.fetch,
        debounceMs: 0,
        refreshCoalesceMs: 0,
        pbkdf2Iterations: 1000,
      });
      harness = h;
      const devA = await h.createDevice('LocalDav-Dev');
      devA.browser.seedCookie({
        domain: 'localhost',
        hostOnly: true,
        name: 'http_sid',
        value: 'prod_admin',
        httpOnly: true,
        secure: false,
      });

      await devA.engine.saveAndJoinSpace({
        webdav: localWebdav,
        spaceId: 'chaos-12',
        spaceName: 'LocalWebDAV Reverse',
        encryptionPassword: ENC_PASS,
        deviceName: 'LocalDav-Dev',
        presetCategories: ['banking', 'password_manager', 'webdav_self'],
      });

      const devPort = new URL(running.url).port === '5173' ? 5174 : 5173;
      const rule = await devA.engine.upsertEnvSyncRule({
        name: 'Prod -> Local Dev',
        scope: 'device',
        enabled: true,
        sourceSiteKey: 'localhost',
        targetUrl: `http://127.0.0.1:${devPort}`,
        syncCookies: true,
        syncLocalStorage: false,
        adaptForHttp: true,
        cleanTargetBeforeSync: true,
        autoSync: true,
        autoReloadTarget: false,
      });

      // Forward sync succeeds
      const fwd = await devA.engine.executeEnvCookieSync({ ruleId: rule.id });
      expect(fwd.appliedCookies).toBeGreaterThanOrEqual(1);
      expect(devA.browser.findJarCookie('http_sid', '127.0.0.1')?.value).toBe('prod_admin');

      // Dev acquires a new cookie; reverse write-back to Prod MUST succeed (different port from WebDAV!)
      await devA.browser.simulateUserCookieSet({
        domain: '127.0.0.1',
        hostOnly: true,
        name: 'dev_token',
        value: 'written_back_ok',
        secure: false,
      });
      const rev = await devA.engine.executeEnvCookieSync({ ruleId: rule.id, reverse: true });
      expect(rev.appliedCookies).toBeGreaterThanOrEqual(1);
      expect(devA.browser.findJarCookie('dev_token', 'localhost')?.value).toBe('written_back_ok');
      expect(devA.browser.findJarCookie('http_sid', 'localhost')?.value).toBe('prod_admin');

      // Identical port as WebDAV server MUST remain strictly blocked as source!
      await expect(
        devA.engine.executeEnvCookieSync({
          adHoc: {
            sourceSiteKey: running.url,
            targetUrl: 'http://localhost:3000',
            syncCookies: true,
            syncLocalStorage: false,
            adaptForHttp: true,
            cleanTargetBeforeSync: false,
            autoReloadTarget: false,
          },
        }),
      ).rejects.toThrow(/受保护敏感黑名单/);

      // Credentialed URL passed in targetUrl or name MUST never persist userinfo or query secrets
      const credRule = await devA.engine.upsertEnvSyncRule({
        scope: 'device',
        enabled: true,
        sourceSiteKey: 'localhost',
        targetUrl: `http://evil:supersecret@127.0.0.1:${devPort}/admin?api_key=leak99#frag`,
        syncCookies: true,
        syncLocalStorage: false,
        adaptForHttp: true,
        cleanTargetBeforeSync: false,
        autoSync: false,
        autoReloadTarget: false,
      });
      expect(credRule.targetUrl).toBe(`http://127.0.0.1:${devPort}`);
      expect(credRule.name).not.toContain('supersecret');
      expect(credRule.name).not.toContain('leak99');
    } finally {
      await running.close();
    }
  });

  it('CHAOS-013: Locally compacted duplicate edits never trigger false missingSeqGaps in checkIntegrity, while genuinely deleted remote batch files are still detected', async () => {
    const { dav, webdav, harness: h } = setup();
    const devA = await h.createDevice('Compact-Device-A');

    devA.browser.seedCookie({ domain: '.compact.io', name: 'tok', value: 'v1' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Compact-Device-A',
    });

    // Mutate the SAME cookie 3 times before pushing so enqueueOutboundEvent compacts earlier deviceSeqs!
    await devA.browser.simulateUserCookieSet({ domain: '.compact.io', name: 'tok', value: 'v2' });
    await devA.browser.simulateUserCookieSet({ domain: '.compact.io', name: 'tok', value: 'v3' });
    await devA.browser.simulateUserCookieSet({ domain: '.compact.io', name: 'tok', value: 'v4' });
    await devA.engine.syncNow({ userInitiated: true });

    // Integrity check MUST pass with ZERO false missingSeqGaps!
    const okReport = await devA.engine.checkIntegrity();
    expect(okReport.ok).toBe(true);
    expect(okReport.missingSeqGaps).toEqual([]);

    // Push a 3rd batch, then DELETE the middle batch directly on WebDAV -> genuine gap MUST still be caught!
    await devA.browser.simulateUserCookieSet({ domain: '.compact.io', name: 'tok', value: 'v5' });
    await devA.engine.syncNow({ userInitiated: true });

    const eventFiles = dav
      .listAllStoredPaths()
      .filter((p) => p.includes('/events/') && p.endsWith('.enc'))
      .sort();
    expect(eventFiles.length).toBeGreaterThanOrEqual(3);
    // Delete the middle batch file directly on WebDAV to simulate real WebDAV data loss
    const delRes = await dav.fetchImpl(`${new URL(webdav.url).origin}${eventFiles[1]!}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Basic ${Buffer.from(`${webdav.username}:${webdav.password}`).toString('base64')}`,
      },
    });
    expect(delRes.status).toBeLessThan(300);

    const gapReport = await devA.engine.checkIntegrity();
    expect(gapReport.ok).toBe(false);
    expect(gapReport.missingSeqGaps.length).toBeGreaterThanOrEqual(1);
  });

  it('CHAOS-014: Localhost/IP cookies created with hostOnly=false normalize to Chromium hostOnly=true with zero duplicates and delete cleanly without sibling resurrection', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Localhost-Device-A');

    // Seed an initial localhost cookie so localhost is managed
    devA.browser.seedCookie({
      domain: 'localhost',
      hostOnly: true,
      name: 'http_sid',
      value: 'ops2',
      secure: false,
    });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Localhost-Device-A',
    });

    // Simulate Chromium's collateral removeCookie behavior (removes ALL matching url+name cookies)
    const origRemove = devA.browser.removeCookie.bind(devA.browser);
    devA.browser.removeCookie = async (details) => {
      const all = await devA.browser.getAllCookies({ url: details.url, storeId: details.storeId });
      for (const c of all) {
        if (c.name === details.name) {
          await origRemove(details);
        }
      }
    };

    // Upsert a manual localhost cookie with hostOnly=false (as an older UI/import JSON might send)
    const created = await devA.engine.upsertCookie('localhost', {
      domain: 'localhost',
      name: 'manual_ck',
      value: 'hello_edge_2026',
      path: '/',
      secure: false,
      httpOnly: false,
      sameSite: 'lax',
      session: true,
      hostOnly: false,
    });
    expect(created.applyResult?.accepted).toBe(true);
    expect(created.hostOnly).toBe(true);
    expect(created.domain).toBe('localhost');

    // Flush any echo events -> MUST NOT create a duplicate CookieRecord!
    await devA.engine.flushPendingLocalChanges();
    const localhostCookies = await devA.engine.getSiteCookies('localhost');
    const manualRecords = localhostCookies.filter((c) => c.name === 'manual_ck');
    expect(manualRecords).toHaveLength(1);
    expect(devA.browser.findJarCookie('manual_ck', 'localhost')?.value).toBe('hello_edge_2026');

    // Delete via all_devices -> MUST permanently remove manual_ck from browser jar (NEVER resurrected as collidingSibling!)
    await devA.engine.deleteCookies([created.logicalId], 'all_devices', 'localhost');
    await devA.engine.flushPendingLocalChanges();
    expect(devA.browser.findJarCookie('manual_ck', 'localhost')).toBeUndefined();
    expect(devA.browser.findJarCookie('http_sid', 'localhost')?.value).toBe('ops2');
    expect((await devA.engine.getSiteCookies('localhost')).some((c) => c.name === 'manual_ck')).toBe(
      false,
    );
  });

  it('CHAOS-015: save_current creates a decoupled snapshot (Cookie+LS) AND syncNow immediately captures live open-tab localStorage CREATE/UPDATE/DELETE across devices', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('SaveCur-A');
    const devB = await h.createDevice('SaveCur-B');

    const origin = 'https://spa-sync.io';
    devA.browser.openTab(origin);
    devB.browser.openTab(origin);
    devA.browser.seedCookie({ domain: '.spa-sync.io', name: 'sid', value: 'acct1_sid' });
    devA.browser.seedLocalStorage(origin, { token: 'tok1', keep_me: 'yes', drop_me: 'temp' });

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'SaveCur-A',
    });

    // 1. save_current creates a decoupled snapshot account (Account 2) while keeping browser session intact
    const snapTrack = await devA.engine.createSiteAccountTrack('spa-sync.io', {
      mode: 'save_current',
      label: '快照号2',
    });
    expect(devA.browser.findJarCookie('sid', 'spa-sync.io')?.value).toBe('acct1_sid');
    expect((await devA.browser.getLocalStorage(origin)).items.token).toBe('tok1');

    // Mutate active snapshot copy directly in browser (WITHOUT content-script event!)
    await devA.browser.simulateUserCookieSet({
      domain: '.spa-sync.io',
      name: 'sid',
      value: 'acct2_copy_sid',
    });
    await devA.browser.applyLocalStorage(origin, [
      { key: 'token', value: 'tok2_copy' },
      { key: 'drop_me', deleted: true },
    ]);

    // Rotate back to Account 1 -> Account 1 MUST still have original acct1_sid + tok1 + drop_me!
    await devA.engine.rotateSiteTrack('spa-sync.io', 'next');
    expect(devA.browser.findJarCookie('sid', 'spa-sync.io')?.value).toBe('acct1_sid');
    expect((await devA.browser.getLocalStorage(origin)).items.token).toBe('tok1');
    expect((await devA.browser.getLocalStorage(origin)).items.drop_me).toBe('temp');

    // Rotate back to Account 2 -> Account 2 MUST have acct2_copy_sid + tok2_copy and NO drop_me!
    await devA.engine.switchSiteTrack('spa-sync.io', snapTrack.trackId);
    expect(devA.browser.findJarCookie('sid', 'spa-sync.io')?.value).toBe('acct2_copy_sid');
    expect((await devA.browser.getLocalStorage(origin)).items.token).toBe('tok2_copy');
    expect((await devA.browser.getLocalStorage(origin)).items.drop_me).toBeUndefined();

    // 2. Device B joins and adopts Account 2 -> gets tok2_copy
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'SaveCur-B',
    });
    await devB.engine.switchSiteTrack('spa-sync.io', snapTrack.trackId);
    expect((await devB.browser.getLocalStorage(origin)).items.token).toBe('tok2_copy');

    // 3. Direct same-tab localStorage UPDATE + DELETE on Device A (no storage event fired!) -> immediate syncNow() MUST capture & deliver BOTH!
    await devA.browser.applyLocalStorage(origin, [
      { key: 'token', value: 'tok2_renewed' },
      { key: 'keep_me', deleted: true },
    ]);
    await devA.engine.syncNow({ userInitiated: true });
    await devB.engine.syncNow({ userInitiated: true });

    const bLs = (await devB.browser.getLocalStorage(origin)).items;
    expect(bLs.token).toBe('tok2_renewed');
    expect(bLs.keep_me).toBeUndefined();

    // 4. clean_new -> immediate login Cookie+LS -> immediate save_current MUST preserve LS on BOTH tracks (zero split-brain!)
    const track3 = await devA.engine.createSiteAccountTrack('spa-sync.io', {
      mode: 'clean_new',
      label: '空白号3',
      triggerRefresh: false,
    });
    await devA.browser.simulateUserCookieSet({ domain: '.spa-sync.io', name: 'sid', value: 'acct3_sid' });
    await devA.browser.applyLocalStorage(origin, [{ key: 'token', value: 'tok3_fresh' }]);
    const track4 = await devA.engine.createSiteAccountTrack('spa-sync.io', {
      mode: 'save_current',
      label: '紧接快照4',
    });
    expect(track4.trackId).not.toBe(track3.trackId);
    await devA.browser.simulateUserCookieSet({ domain: '.spa-sync.io', name: 'sid', value: 'acct4_sid' });
    await devA.browser.applyLocalStorage(origin, [{ key: 'token', value: 'tok4_copy' }]);
    // Switch back to track3 -> MUST still have BOTH acct3_sid AND tok3_fresh (zero Cookie/LS split-brain)!
    await devA.engine.switchSiteTrack('spa-sync.io', track3.trackId);
    expect(devA.browser.findJarCookie('sid', 'spa-sync.io')?.value).toBe('acct3_sid');
    expect((await devA.browser.getLocalStorage(origin)).items.token).toBe('tok3_fresh');
  });

  it('CHAOS-016: rebuildIndex preserves unpushed local tracks & pendingOutboundEvents, and concurrent renameSpace + syncNow serialize cleanly', async () => {
    const { dav, webdav, harness: h } = setup();
    const devA = await h.createDevice('Rebuild-A');
    const devB = await h.createDevice('Rebuild-B');
    const rebuildOrigin = 'https://app.rebuild.io';
    devA.browser.openTab(rebuildOrigin);
    devB.browser.openTab(rebuildOrigin);

    devA.browser.seedCookie({ domain: '.rebuild.io', name: 'sid', value: 'baseline_sid' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Rebuild-A',
    });

    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Rebuild-B',
    });
    expect(devB.browser.findJarCookie('sid', 'rebuild.io')?.value).toBe('baseline_sid');

    // Add an SSO group & confirm synchronous cached accessor reflects it
    await devA.engine.upsertSsoGroup({
      groupId: 'sso-rebuild',
      name: 'Rebuild SSO',
      domains: ['rebuild.io', 'sso-rebuild.org'],
      primarySiteKey: 'rebuild.io',
    });
    expect(devA.engine.getCachedSsoGroups().some((g) => g.groupId === 'sso-rebuild')).toBe(true);

    // Go offline, create a clean_new unpushed track AND modify cookie/localStorage in pendingOutboundEvents
    dav.quirks.offline = true;
    const offlineTrack = await devA.engine.createSiteAccountTrack('rebuild.io', {
      mode: 'clean_new',
      label: '离线新号',
      triggerRefresh: false,
    });
    await devA.browser.simulateUserCookieSet({
      domain: '.rebuild.io',
      name: 'sid',
      value: 'offline_new_sid',
    });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.upsertLocalStorageItem(
      'https://app.rebuild.io',
      'offline_key',
      'offline_val_999',
    );
    expect((await devA.engine.getStatusSummary()).pendingUploads).toBeGreaterThanOrEqual(2);

    // Come back online BEFORE push (no syncNow yet), and run rebuildIndex!
    dav.quirks.offline = false;
    await devA.engine.rebuildIndex();

    // Unpushed track & uncommitted pendingOutboundEvents MUST survive rebuildIndex cleanly
    const tracksAfterRebuild = (await devA.engine.getSitesOverview()).find(
      (s) => s.siteKey === 'rebuild.io',
    )?.allTracks;
    expect(tracksAfterRebuild?.some((t) => t.trackId === offlineTrack.trackId)).toBe(true);
    expect(devA.browser.findJarCookie('sid', 'rebuild.io')?.value).toBe('offline_new_sid');
    const cookiesAfterRebuild = await devA.engine.getSiteCookies('rebuild.io', offlineTrack.trackId);
    expect(cookiesAfterRebuild.find((c) => c.name === 'sid')?.value).toBe('offline_new_sid');
    const lsAfterRebuild = await devA.engine.getLocalStorageRecords({ siteKey: 'rebuild.io' });
    expect(
      lsAfterRebuild.find((r) => r.trackId === offlineTrack.trackId && r.key === 'offline_key')?.value,
    ).toBe('offline_val_999');

    // Now push & sync to Device B -> Device B switches to offlineTrack and converges!
    await devA.engine.syncNow({ userInitiated: true });
    await devB.engine.syncNow({ userInitiated: true });
    await devB.engine.switchSiteTrack('rebuild.io', offlineTrack.trackId);
    expect(devB.browser.findJarCookie('sid', 'rebuild.io')?.value).toBe('offline_new_sid');
    expect((await devB.browser.getLocalStorage('https://app.rebuild.io')).items.offline_key).toBe(
      'offline_val_999',
    );

    // Concurrent renameSpace + syncNow serialization test (must not race or throw ETag mismatch)
    await Promise.all([
      devA.engine.renameSpace(SPACE_ID, 'Concurrent Name 1'),
      devA.engine.syncNow({ userInitiated: true }),
      devA.engine.renameSpace(SPACE_ID, 'Concurrent Final Name'),
    ]);
    expect((await devA.engine.getStatusSummary()).activeSpaceName).toBe('Concurrent Final Name');
    await devB.engine.syncNow({ direction: 'pull', triggerRefresh: false });
    const probed = await devB.engine.probeRemoteSpaces(webdav);
    expect(probed.find((p) => p.spaceId === SPACE_ID)?.spaceName).toBe('Concurrent Final Name');

    // Global Pause + interactive mutations MUST NOT leak uploads while paused, then push after resume
    await devA.engine.setGlobalPaused(true);
    const reqsBeforePausedEdit = dav.requestCount;
    await devA.engine.upsertCookie('rebuild.io', {
      domain: '.rebuild.io',
      name: 'paused_edit_ck',
      value: 'paused_cookie_val',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
      session: true,
      hostOnly: false,
    });
    await devA.engine.upsertLocalStorageItem(
      'https://app.rebuild.io',
      'paused_edit_ls',
      'paused_ls_val',
    );
    expect(dav.requestCount).toBe(reqsBeforePausedEdit);
    await devA.engine.setGlobalPaused(false);
    await devA.engine.syncNow({ userInitiated: true });
    await devB.engine.syncNow({ userInitiated: true });
    expect(devB.browser.findJarCookie('paused_edit_ck', 'rebuild.io')?.value).toBe('paused_cookie_val');
    expect((await devB.browser.getLocalStorage('https://app.rebuild.io')).items.paused_edit_ls).toBe(
      'paused_ls_val',
    );
  });

  it('CHAOS-017: Emoji UTF-16 code-point badge/label truncation & degraded WebDAV quirks (d_lower, weakEtags, forbidDotFiles, 423 locked, corrupt read integrity)', async () => {
    const dav = new MockWebDAVServer({
      requireAuth: { username: 'chaosuser', password: 'chaos-password-123' },
      xmlNamespaceStyle: 'd_lower',
      weakEtags: true,
      ignoreConditionalHeaders: true,
      forbidDotFiles: true,
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

    devA.browser.seedCookie({ domain: '.emoji.io', name: 'sid', value: 'e1' });
    const joinReport = await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: '🔥Device-A🚀',
    });
    expect(joinReport.isNewSpace).toBe(true);
    expect((await devA.engine.testWebDAVConnection(webdav)).overallOk).toBe(true);

    // 1. Emoji badgeText > 4 code points and long emoji labels truncate by Unicode code point without lone surrogates
    const created = await devA.engine.createSiteAccountTrack('emoji.io', {
      mode: 'save_current',
      label: `${'🔥🚀'.repeat(45)}Tail`,
      badgeText: '🔥🚀⚡🎯X',
    });
    expect(created.badgeText).toBe('🔥🚀⚡🎯');
    expect(Array.from(created.label).length).toBe(80);
    expect(() => encodeURIComponent(created.badgeText!)).not.toThrow();
    expect(() => encodeURIComponent(created.label)).not.toThrow();

    // Unpaired high/low surrogate characters are stripped cleanly
    const tUpdated = await devA.engine.updateSiteTrack('emoji.io', created.trackId, {
      badgeText: 'A\uD83DB\uD83D\uDE80C',
    });
    expect(tUpdated.badgeText).toBe('AB🚀C');
    expect(() => encodeURIComponent(tUpdated.badgeText!)).not.toThrow();

    // 2. Push emoji tracks & peer joins cleanly on degraded WebDAV (d_lower + weakEtags + ignoreConditionalHeaders + forbidDotFiles)
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow({ userInitiated: true });

    const joinB = await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-B',
    });
    const peerSiteBefore = (await devB.engine.getSitesOverview()).find((s) => s.siteKey === 'emoji.io');
    expect(peerSiteBefore?.allTracks.some((t) => t.badgeText === 'AB🚀C')).toBe(true);
    if (joinB.pendingDecisions.some((d) => d.siteKey === 'emoji.io')) {
      await devB.engine.resolveSiteDecision('emoji.io', {
        type: 'use_remote_track',
        trackId: created.trackId,
      });
    }
    await devB.engine.syncNow({ userInitiated: true });
    expect(devB.browser.findJarCookie('sid', 'emoji.io')?.value).toBe('e1');

    // 3. Inject 423 Locked on space root -> sync fails gracefully, then recovers after lock cleared
    dav.quirks.lockedPaths = new Set(['/webdav/mesh']);
    await devA.browser.simulateUserCookieSet({ domain: '.emoji.io', name: 'sid', value: 'e2_after_423' });
    await devA.engine.flushPendingLocalChanges();
    const lockedRes = await devA.engine.syncNow({ userInitiated: true });
    expect(lockedRes.errorMessage).toBeTruthy();

    dav.quirks.lockedPaths = undefined;
    const recoveredRes = await devA.engine.syncNow({ userInitiated: true });
    expect(recoveredRes.errorMessage).toBeFalsy();
    await devB.engine.syncNow({ direction: 'pull', triggerRefresh: false });
    expect(devB.browser.findJarCookie('sid', 'emoji.io')?.value).toBe('e2_after_423');

    // 4. Bit-flip corruption on one remote batch -> checkIntegrity detects corruptedPaths without throwing
    const batchPath = [...(dav as unknown as { nodes: Map<string, { kind: string }> }).nodes.keys()].find((p) =>
      p.includes('/events/') && p.endsWith('.enc'),
    );
    expect(batchPath).toBeTruthy();
    dav.quirks.corruptReadsForPaths = new Set([batchPath!]);
    const integrity = await devA.engine.checkIntegrity();
    expect(integrity.ok).toBe(false);
    expect(integrity.corruptedPaths.some((cp) => batchPath!.endsWith(cp))).toBe(true);
    dav.quirks.corruptReadsForPaths = undefined;
  });

  it('CHAOS-018: Backend migration after SW restart (no RAM password) bootstraps dirs, migrates space.enc, and auto-heals 409 missing parent collections on putBytes', async () => {
    const dav1 = new MockWebDAVServer({
      requireAuth: { username: 'chaosuser', password: 'chaos-password-123' },
    });
    const dav2 = new MockWebDAVServer({
      requireAuth: { username: 'chaosuser', password: 'chaos-password-123' },
    });
    const routeFetch: typeof fetch = (input, init) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.startsWith('https://dav2.')) return dav2.fetchImpl(input, init);
      return dav1.fetchImpl(input, init);
    };
    const webdav1: WebDAVConfig = {
      url: 'https://dav1.chaos.test/webdav',
      authType: 'basic',
      username: 'chaosuser',
      password: 'chaos-password-123',
      rootPath: '/mesh1',
    };
    const webdav2: WebDAVConfig = {
      url: 'https://dav2.chaos.test/webdav',
      authType: 'basic',
      username: 'chaosuser',
      password: 'chaos-password-123',
      rootPath: '/custom-mesh2',
    };

    harness = new MultiDeviceHarness({
      webdav: webdav1,
      fetchImpl: routeFetch,
      debounceMs: 0,
      refreshCoalesceMs: 0,
      pbkdf2Iterations: 1000,
    });
    const devA = await harness.createDevice('Device-A');
    const devB = await harness.createDevice('Device-B');

    devA.browser.seedCookie({ domain: '.migrate.io', name: 'sid', value: 'm1' });
    await devA.engine.saveAndJoinSpace({
      webdav: webdav1,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    // Simulate MV3 Service Worker idle restart: DEK comes from keyVault, encryptionPassword is NOT in RAM
    await devA.restartEngine();
    expect((await devA.engine.getStatusSummary()).locked).toBe(false);

    // Migrate to completely empty WebDAV 2 with custom rootPath -> dirs & space.enc MUST bootstrap!
    await devA.engine.updateSpaceStorageConfig({ provider: 'webdav', ...webdav2 });
    await devA.browser.simulateUserCookieSet({ domain: '.migrate.io', name: 'sid', value: 'm2_migrated' });
    await devA.engine.flushPendingLocalChanges();
    const pushRes = await devA.engine.syncNow({ userInitiated: true });
    expect(pushRes.errorMessage).toBeFalsy();
    expect((await devA.engine.getStatusSummary()).pendingUploads).toBe(0);

    const dav2Nodes = (dav2 as unknown as { nodes: Map<string, unknown> }).nodes;
    expect(Array.from(dav2Nodes.keys()).some((k) => k.includes('/events/') && k.endsWith('.enc'))).toBe(true);

    const integrity = await devA.engine.checkIntegrity();
    expect(integrity.ok).toBe(true);
    expect(integrity.spaceMetadataOk).toBe(true);

    // Simulate external deletion of events/<devId> directory on WebDAV 2 -> putBytes auto-recovers from 409
    for (const k of Array.from(dav2Nodes.keys())) {
      if (k.includes('/events/')) {
        dav2Nodes.delete(k);
      }
    }
    await devA.browser.simulateUserCookieSet({ domain: '.migrate.io', name: 'sid', value: 'm3_healed_409' });
    await devA.engine.flushPendingLocalChanges();
    const healedPush = await devA.engine.syncNow({ userInitiated: true });
    expect(healedPush.errorMessage).toBeFalsy();
    expect((await devA.engine.getStatusSummary()).pendingUploads).toBe(0);
    expect(Array.from(dav2Nodes.keys()).some((k) => k.includes('/events/') && k.endsWith('.enc'))).toBe(true);

    // Peer Device B can verify & join migrated WebDAV 2 using the original encryption password!
    const verified = await devB.engine.verifyRemoteSpacePassword({
      webdav: webdav2,
      spaceId: SPACE_ID,
      encryptionPassword: ENC_PASS,
    });
    expect(verified).toMatchObject({ exists: true, verified: true, spaceName: SPACE_NAME });

    // URL / HTTPS diagnostic suggestions must reflect the storage provider (not always say WebDAV)
    const gistHttpErr = toStructuredError({
      code: 'GIST_INSECURE_HTTP',
      phase: 'validate_url',
      message: 'Insecure http:// GitHub Gist API URLs are forbidden; HTTPS is required.',
    });
    expect(gistHttpErr.suggestion).toContain('GitHub API');
    expect(gistHttpErr.suggestion).not.toContain('WebDAV');

    const s3HttpErr = toStructuredError({
      code: 'S3_INSECURE_HTTP',
      phase: 'validate_url',
      message: 'Insecure http:// S3 endpoint URLs are forbidden; HTTPS is required.',
    });
    expect(s3HttpErr.suggestion).toContain('S3');
    expect(s3HttpErr.suggestion).not.toContain('WebDAV');

    const webdavHttpErr = toStructuredError({
      code: 'WEBDAV_INSECURE_HTTP',
      phase: 'validate_url',
      message: 'Insecure http:// WebDAV URLs are forbidden; HTTPS is required.',
    });
    expect(webdavHttpErr.suggestion).toContain('WebDAV');
  });
});
