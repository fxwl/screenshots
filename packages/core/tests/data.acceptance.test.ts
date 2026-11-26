import { describe, it, expect, afterEach } from 'vitest';
import { MockWebDAVServer } from '@sessionmesh/webdav-mock';
import { DiagnosticLogger, scrubSensitiveText, toStructuredError } from '../src/diagnostics';
import { MultiDeviceHarness } from '../src/sim';
import { InMemoryStorageBackend, SyncEngine } from '../src/sync';
import type { WebDAVConfig } from '../src/types';

function createBaseConfig(): WebDAVConfig {
  return {
    url: 'https://dav.data.test/webdav',
    authType: 'basic',
    username: 'dave',
    password: 'super-secret-dav-password',
    rootPath: '/sessionmesh-data',
  };
}

describe('Data Management, Security & System Acceptance Suite (D-001 .. D-017)', () => {
  let harness: MultiDeviceHarness | null = null;

  afterEach(() => {
    harness?.disposeAll();
    harness = null;
  });

  function setup() {
    const dav = new MockWebDAVServer({
      requireAuth: { username: 'dave', password: 'super-secret-dav-password' },
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

  const SPACE_ID = 'data-space';
  const SPACE_NAME = 'Data Space';
  const ENC_PASS = 'ultra-secret-e2e-pass!';

  it('D-001 & D-002: Full cookie attribute inspection and manual upsert/edit sync across devices', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });

    const exp = Math.floor(Date.now() / 1000) + 3600;
    const rec = await devA.engine.upsertCookie('inspect.io', {
      domain: '.inspect.io',
      name: 'auth',
      value: 'tok-123',
      path: '/api',
      secure: true,
      httpOnly: true,
      sameSite: 'strict',
      session: false,
      expirationDate: exp,
      hostOnly: false,
      partitionKey: { topLevelSite: 'https://inspect.io' },
    });

    expect(rec.applyResult?.accepted).toBe(true);
    expect(rec.httpOnly).toBe(true);
    expect(rec.sameSite).toBe('strict');
    expect(rec.partitionKey?.topLevelSite).toBe('https://inspect.io');
    expect(rec.version.versionId).toBeTruthy();

    await devB.engine.syncNow();
    const listB = await devB.engine.getSiteCookies('inspect.io');
    expect(listB).toHaveLength(1);
    expect(listB[0].value).toBe('tok-123');
    expect(listB[0].path).toBe('/api');
    expect(listB[0].expirationDate).toBe(exp);
    expect(listB[0].applyResult?.accepted).toBe(true);
  });

  it('D-003: Single cookie apply read-back verification reports APPLY_FAILED on browser rejection or mismatch (Prohibition #7)', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });

    const rec = await devA.engine.upsertCookie('verify.io', {
      domain: '.verify.io',
      name: 'strict_tok',
      value: 'expected-val',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
      session: true,
      hostOnly: false,
    });

    // Simulate browser rejecting cookie on Device B
    devB.browser.rejectCookiePredicate = () => 'Browser policy rejected cookie';
    const syncRes = await devB.engine.syncNow();
    expect(syncRes.failedCookies).toBe(1);

    const cookiesB = await devB.engine.getSiteCookies('verify.io');
    expect(cookiesB[0].syncStatus).toBe('APPLY_FAILED');
    expect(cookiesB[0].applyResult?.accepted).toBe(false);
    expect(cookiesB[0].applyResult?.reason).toContain('rejected');

    // Simulate read-back value corruption
    devB.browser.rejectCookiePredicate = undefined;
    devB.browser.corruptReadBackValue = true;
    const corruptedRes = await devB.engine.applyCookieToBrowser(cookiesB[0].logicalId);
    expect(corruptedRes.syncStatus).toBe('APPLY_FAILED');
    expect(corruptedRes.applyResult?.accepted).toBe(false);

    // Fix browser -> manual applyCookieToBrowser succeeds
    devB.browser.corruptReadBackValue = false;
    const fixedRes = await devB.engine.applyCookieToBrowser(rec.logicalId);
    expect(fixedRes.syncStatus).toBe('IN_SYNC');
    expect(fixedRes.applyResult?.accepted).toBe(true);
  });

  it('D-004: Chromium special cookies (__Host-, __Secure-, SameSite=None, CHIPS partitionKey fallback)', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B', { rejectPartitionKey: true });

    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });

    // __Host- cookie (must enforce hostOnly, path='/', secure=true, https URL)
    const hostRec = await devA.engine.upsertCookie('secure.io', {
      domain: 'app.secure.io',
      name: '__Host-session',
      value: 'host-val',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      session: true,
      hostOnly: true,
    });
    expect(hostRec.applyResult?.accepted).toBe(true);

    // __Secure- + SameSite=None
    const secRec = await devA.engine.upsertCookie('secure.io', {
      domain: '.secure.io',
      name: '__Secure-sso',
      value: 'sso-val',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'no_restriction',
      session: true,
      hostOnly: false,
    });
    expect(secRec.applyResult?.accepted).toBe(true);

    // CHIPS partitioned cookie -> Device B rejects partitionKey and gracefully degrades!
    await devA.engine.upsertCookie('secure.io', {
      domain: 'embed.secure.io',
      name: 'chips_id',
      value: 'part-1',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'no_restriction',
      session: true,
      hostOnly: true,
      partitionKey: { topLevelSite: 'https://parent.example' },
    });

    await devB.engine.syncNow();
    const jarHost = devB.browser.findJarCookie('__Host-session', 'app.secure.io');
    expect(jarHost?.hostOnly).toBe(true);
    expect(jarHost?.path).toBe('/');
    expect(jarHost?.secure).toBe(true);

    const jarSec = devB.browser.findJarCookie('__Secure-sso', 'secure.io');
    expect(jarSec?.sameSite).toBe('no_restriction');
    expect(jarSec?.secure).toBe(true);

    const cookiesB = await devB.engine.getSiteCookies('secure.io');
    const chipsB = cookiesB.find((c) => c.name === 'chips_id')!;
    expect(chipsB.applyResult?.accepted).toBe(true);
    expect(chipsB.applyResult?.degradedPartitionKey).toBe(true);
  });

  it('D-005: Explicit 3-scope delete (local_only, remote_track_only, all_devices)', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    devA.browser.seedCookie({ domain: '.del.io', name: 'c_local', value: 'v1' });
    devA.browser.seedCookie({ domain: '.del.io', name: 'c_remote', value: 'v2' });
    devA.browser.seedCookie({ domain: '.del.io', name: 'c_all', value: 'v3' });

    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });

    const cookiesA = await devA.engine.getSiteCookies('del.io');
    const byName = new Map(cookiesA.map((c) => [c.name, c.logicalId]));

    // 1. local_only: deletes ONLY from A's browser, B keeps it
    await devA.engine.deleteCookies([byName.get('c_local')!], 'local_only', 'del.io');
    await devB.engine.syncNow();
    expect(devA.browser.findJarCookie('c_local', 'del.io')).toBeUndefined();
    expect(devB.browser.findJarCookie('c_local', 'del.io')?.value).toBe('v1');

    // 2. remote_track_only: cleans track record without deleting browsers' local cookies
    await devA.engine.deleteCookies([byName.get('c_remote')!], 'remote_track_only', 'del.io');
    await devB.engine.syncNow();
    expect(devA.browser.findJarCookie('c_remote', 'del.io')?.value).toBe('v2');
    expect(devB.browser.findJarCookie('c_remote', 'del.io')?.value).toBe('v2');
    expect((await devB.engine.getSiteCookies('del.io')).find((c) => c.name === 'c_remote')).toBeUndefined();

    // 3. all_devices: deletes from A's browser AND propagates Tombstone removing from B's browser
    await devA.engine.deleteCookies([byName.get('c_all')!], 'all_devices', 'del.io');
    await devB.engine.syncNow();
    expect(devA.browser.findJarCookie('c_all', 'del.io')).toBeUndefined();
    expect(devB.browser.findJarCookie('c_all', 'del.io')).toBeUndefined();
  });

  it('D-006: Export and Import Cookies JSON roundtrip', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });

    const imported = await devA.engine.importCookiesJson(
      [
        {
          domain: '.json.io',
          name: 'k1',
          value: 'val1',
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'lax',
          session: true,
          hostOnly: false,
        },
        {
          domain: '.json.io',
          name: 'k2',
          value: 'val2',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'strict',
          session: true,
          hostOnly: false,
        },
      ],
      'json.io',
    );
    expect(imported).toBe(2);

    const exported = await devA.engine.exportCookiesJson('json.io');
    expect(exported).toHaveLength(2);
    expect(exported.map((c) => c.name).sort()).toEqual(['k1', 'k2']);

    await devB.engine.syncNow();
    expect(devB.browser.findJarCookie('k1', 'json.io')?.value).toBe('val1');
    expect(devB.browser.findJarCookie('k2', 'json.io')?.value).toBe('val2');
  });

  it('D-007 & D-008: LocalStorage sync with strict Origin isolation and pending context apply on open', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });

    // Strict origin isolation: https://app.ls.io vs https://app.ls.io:8443
    devA.browser.openOrigin('https://app.ls.io');
    devA.browser.openOrigin('https://app.ls.io:8443');

    await devA.engine.ingestLocalStorageMutations('https://app.ls.io', [
      { key: 'theme', value: 'dark' },
      { key: 'jwt', value: 'ls-tok-1' },
    ]);
    await devA.engine.ingestLocalStorageMutations('https://app.ls.io:8443', [
      { key: 'theme', value: 'port-8443-light' },
    ]);

    // Device B does NOT have https://app.ls.io open yet (D-008 pending context!)
    await devB.engine.syncNow();
    const pendingLs = await devB.engine.getLocalStorageRecords({ origin: 'https://app.ls.io' });
    expect(pendingLs).toHaveLength(2);
    expect(pendingLs.every((r) => r.contextAvailable === false)).toBe(true);

    // Now Device B opens https://app.ls.io -> pending LocalStorage records apply cleanly!
    devB.browser.openOrigin('https://app.ls.io');
    await devB.engine.onSiteVisited('https://app.ls.io/home');
    expect(devB.browser.getRawLocalStorage('https://app.ls.io')).toEqual({
      theme: 'dark',
      jwt: 'ls-tok-1',
    });
    // Strict Origin isolation: port 8443 did NOT leak into standard 443 origin
    expect(devB.browser.getRawLocalStorage('https://app.ls.io').theme).toBe('dark');

    // Delete on A propagates to B
    await devA.engine.ingestLocalStorageMutations('https://app.ls.io', [
      { key: 'jwt', deleted: true },
    ]);
    await devB.engine.syncNow();
    expect(devB.browser.getRawLocalStorage('https://app.ls.io')).toEqual({ theme: 'dark' });
  });

  it('D-009: Historical event restore creates a NEW causal successor RESTORE event and propagates', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    devA.browser.seedCookie({ domain: '.hist.io', name: 'token', value: 'v1-good' });
    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });

    await devA.browser.simulateUserCookieSet({ domain: '.hist.io', name: 'token', value: 'v2-broken' });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();
    await devB.engine.syncNow();
    expect(devB.browser.findJarCookie('token', 'hist.io')?.value).toBe('v2-broken');

    const { events } = await devA.engine.getHistoryAndLogs({ siteKey: 'hist.io' });
    const v1Event = events.find((e) => e.cookieData?.value === 'v1-good')!;
    expect(v1Event).toBeDefined();

    await devA.engine.restoreHistoricalEvent(v1Event.eventId);

    const { events: eventsAfter } = await devA.engine.getHistoryAndLogs({ siteKey: 'hist.io' });
    const restoreEv = eventsAfter.find((e) => e.operation === 'RESTORE')!;
    expect(restoreEv).toBeDefined();
    expect(restoreEv.deviceSeq).toBeGreaterThan(v1Event.deviceSeq);

    await devB.engine.syncNow();
    expect(devB.browser.findJarCookie('token', 'hist.io')?.value).toBe('v1-good');
  });

  it('D-010 & D-012: Per-site rule overrides, blacklist priority, and rules JSON export/import', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });

    // Configure push_only on pushonly.io for space
    await devA.engine.upsertSiteRule({
      siteKey: 'pushonly.io',
      pattern: 'pushonly.io',
      direction: 'push_only',
      syncCookies: true,
      syncLocalStorage: false,
      autoRefresh: false,
      updatedAt: Date.now(),
    });

    // Blacklist beats site rule (D-012)
    await devA.engine.upsertSiteRule({
      siteKey: 'bank.io',
      pattern: 'bank.io',
      direction: 'bidirectional',
      syncCookies: true,
      syncLocalStorage: true,
      autoRefresh: true,
      updatedAt: Date.now(),
    });
    await devA.engine.addBlacklistEntry({
      pattern: 'bank.io',
      matchType: 'subdomain',
      scope: 'space',
      reason: 'Bank override test',
    });

    await devA.browser.simulateUserCookieSet({ domain: '.bank.io', name: 'pin', value: '0000' });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();
    await devB.engine.syncNow();
    expect(devB.browser.findJarCookie('pin', 'bank.io')).toBeUndefined();

    // Rules JSON export & import roundtrip
    const exportedJson = await devA.engine.exportRulesJson();
    expect(exportedJson).toContain('pushonly.io');
    await devB.engine.importRulesJson(exportedJson);
    const rulesB = await devB.engine.getRulesAndBlacklist();
    expect(rulesB.siteOverrides['pushonly.io']?.direction).toBe('push_only');
  });

  it('D-011: Multi-space complete isolation (Prohibition #16)', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    devA.browser.seedCookie({ domain: '.space1.io', name: 's1', value: 'only-in-space1' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: 'space-one',
      spaceName: 'Work Space',
      encryptionPassword: 'pass-space-one',
      deviceName: 'Device-A',
    });

    // Create Space 2 on same WebDAV server
    await devA.engine.createSpace('space-two', 'Personal Space', 'pass-space-two');
    await devA.engine.upsertCookie('space2.io', {
      domain: '.space2.io',
      name: 's2',
      value: 'only-in-space2',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
      session: true,
      hostOnly: false,
    });
    await devA.engine.addBlacklistEntry({
      pattern: 'only-blocked-in-space2.io',
      matchType: 'subdomain',
      scope: 'device',
    });

    // Switch back to space-one -> ZERO leakage from space-two!
    await devA.engine.switchSpace('space-one');
    expect((await devA.engine.getStatusSummary()).activeSpaceId).toBe('space-one');
    expect(await devA.engine.getSiteCookies('space2.io')).toHaveLength(0);
    expect((await devA.engine.getSiteCookies('space1.io'))[0]?.value).toBe('only-in-space1');
    const rules1 = await devA.engine.getRulesAndBlacklist();
    expect(rules1.deviceBlacklist.some((b) => b.pattern === 'only-blocked-in-space2.io')).toBe(false);

    // Rename & delete space-two cleanly
    await devA.engine.renameSpace('space-two', 'Renamed Space Two');
    expect((await devA.engine.getStatusSummary()).spaces.find((s) => s.spaceId === 'space-two')?.name).toBe(
      'Renamed Space Two',
    );
    await devA.engine.deleteLocalSpace('space-two', true);
    expect((await devA.engine.getStatusSummary()).spaces.find((s) => s.spaceId === 'space-two')).toBeUndefined();
  });

  it('D-013: Device management (rename, pause, remove/revoke stops removed device from syncing)', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    devA.browser.seedCookie({ domain: '.devmgmt.io', name: 'k', value: 'v1' });
    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    const joinB = await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });
    await devA.engine.syncNow();

    const devicesOnA = await devA.engine.getDevices();
    expect(devicesOnA.length).toBe(2);

    await devA.engine.renameDevice(joinB.deviceId, 'Old Laptop');
    await devA.engine.setDeviceState(joinB.deviceId, 'removed');

    await devA.browser.simulateUserCookieSet({ domain: '.devmgmt.io', name: 'k', value: 'v2-after-remove' });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();

    // Device B pulls -> discovers it was removed and halts without applying v2-after-remove
    await devB.engine.syncNow();
    expect(devB.browser.findJarCookie('k', 'devmgmt.io')?.value).toBe('v1');
    const statusB = await devB.engine.getStatusSummary();
    expect(statusB.device?.state).toBe('removed');
    expect(statusB.device?.name).toBe('Old Laptop');
    expect(statusB.status).toBe('LOCKED');

    // A permanently revoked active peer C also transitions to LOCKED and halts all sync
    const devC = await h.createDevice('Device-C');
    const joinC = await devC.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-C',
    });
    await devA.engine.setDeviceState(joinC.deviceId, 'revoked');
    await devA.browser.simulateUserCookieSet({ domain: '.devmgmt.io', name: 'k', value: 'v3-after-revoke' });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();
    await devC.engine.syncNow();
    const statusCRevoked = await devC.engine.getStatusSummary();
    expect(statusCRevoked.device?.state).toBe('revoked');
    expect(statusCRevoked.status).toBe('LOCKED');
    expect(devC.browser.findJarCookie('k', 'devmgmt.io')?.value).toBe('v2-after-remove');
  });

  it('D-014: Wrong encryption password causes DECRYPT_ERROR with ZERO damage to remote or local data + Password/DEK rotation', async () => {
    const { dav, webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    devA.browser.seedCookie({ domain: '.vault.io', name: 'a_key', value: 'a-secret' });
    devB.browser.seedCookie({ domain: '.local-b.io', name: 'b_key', value: 'b-precious' });

    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });

    // Snapshot raw WebDAV bytes before bad-password attempt (only file paths with stored bytes)
    const pathsBefore = dav.listAllStoredPaths().sort();
    const rawBytesBefore = new Map<string, Uint8Array>();
    for (const p of pathsBefore) {
      const raw = dav.getStoredRawBytes(p);
      if (raw !== undefined) {
        rawBytesBefore.set(p, new Uint8Array(raw));
      }
    }
    expect(rawBytesBefore.size).toBeGreaterThan(0);

    // Device B joins with WRONG password -> MUST fail with DECRYPT_ERROR!
    await expect(
      devB.engine.saveAndJoinSpace({
        webdav,
        spaceId: SPACE_ID,
        spaceName: SPACE_NAME,
        encryptionPassword: 'WRONG-PASSWORD',
        deviceName: 'Device-B',
      }),
    ).rejects.toMatchObject({ code: 'DECRYPT_ERROR' });

    // Verify remote WebDAV files are 100% byte-for-byte untouched!
    expect(dav.listAllStoredPaths().sort()).toEqual(pathsBefore);
    for (const [p, beforeBytes] of rawBytesBefore.entries()) {
      expect(dav.getStoredRawBytes(p)).toEqual(beforeBytes);
    }
    // Verify Device B local cookies are 100% untouched!
    expect(devB.browser.findJarCookie('b_key', 'local-b.io')?.value).toBe('b-precious');

    // Password & DEK keyEpoch rotation: old files encrypted with epoch 1 STILL decrypt!
    const NEW_PASS = 'rotated-master-pass-2027!';
    await devA.engine.rotateSpacePassword(ENC_PASS, NEW_PASS);

    // Joining with OLD password fails, joining with NEW password succeeds and decrypts epoch-1 events!
    await expect(
      devB.engine.saveAndJoinSpace({
        webdav,
        spaceId: SPACE_ID,
        spaceName: SPACE_NAME,
        encryptionPassword: ENC_PASS,
        deviceName: 'Device-B',
      }),
    ).rejects.toMatchObject({ code: 'DECRYPT_ERROR' });

    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: NEW_PASS,
      deviceName: 'Device-B',
    });
    expect(devB.browser.findJarCookie('a_key', 'vault.io')?.value).toBe('a-secret');
  });

  it('D-015: Manual push/pull, global pause, pairing code roundtrip, and scrubbed diagnostics (Prohibition #15)', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });

    // Pairing code roundtrip
    const code = await devA.engine.generatePairingCode('pair-pass-777');
    expect(code.startsWith('smesh://pair/v1.')).toBe(true);
    const decoded = await devB.engine.decodePairingCode(code, 'pair-pass-777');
    expect(decoded.spaceId).toBe(SPACE_ID);
    expect(decoded.webdav?.url).toBe(webdav.url);
    expect(decoded.fromDeviceName).toBe('Device-A');

    await devB.engine.saveAndJoinSpace({
      webdav: decoded.webdav,
      spaceId: decoded.spaceId,
      spaceName: decoded.spaceName,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-B',
    });

    // Global pause stops syncing
    await devA.engine.setGlobalPaused(true);
    expect((await devA.engine.getStatusSummary()).status).toBe('PAUSED');
    await devA.browser.simulateUserCookieSet({ domain: '.pause.io', name: 'p', value: 'ignored' });
    await devA.engine.flushPendingLocalChanges();
    const pausedSync = await devA.engine.syncNow();
    expect(pausedSync.pushedEvents).toBe(0);
    await devA.engine.setGlobalPaused(false);

    // Scrubbed Diagnostics verification (Prohibition #15)
    const storage = new InMemoryStorageBackend();
    const logger = new DiagnosticLogger(storage);
    logger.registerSecret('super-secret-dav-password');
    logger.registerSecret(ENC_PASS);
    const logged = await logger.log({
      level: 'error',
      phase: 'test',
      message: `Auth failed with Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret and password=super-secret-dav-password and ${code} and Cookie: sid=RAW_SECRET_COOKIE`,
    });
    expect(logged.message).not.toContain('super-secret-dav-password');
    expect(logged.message).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(logged.message).not.toContain('RAW_SECRET_COOKIE');
    expect(logged.message).not.toContain(code);
    expect(scrubSensitiveText('https://user:myPass99@dav.test/root')).not.toContain('myPass99');
    expect(toStructuredError(new Error('Failed to fetch'), 'sync').code).toBe('ERR_NETWORK_OFFLINE');
  });

  it('D-016: Retry queue persistence + WebDAV maintenance (listRemoteDir, checkIntegrity, snapshot, GC, backup & restore, rebuildIndex)', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    devA.browser.seedCookie({ domain: '.maint.io', name: 'k1', value: 'orig-v1' });
    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });

    // Create backup when value is orig-v1
    const { backupId } = await devA.engine.createBackup();
    const backups = await devA.engine.listBackups();
    expect(backups.some((b) => b.name.includes(backupId))).toBe(true);

    // Delete cookie and create snapshot + GC
    devA.browser.simulateExplicitDelete('k1', 'maint.io');
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();
    await devB.engine.syncNow();
    await devA.engine.syncNow();

    const { snapshotId } = await devA.engine.createSnapshot();
    expect(snapshotId).toMatch(/^snap_/);

    const gcRes = await devA.engine.garbageCollectHistory();
    expect(gcRes.reclaimedTombstones).toBeGreaterThanOrEqual(1);
    expect(gcRes.removedEventFiles).toBeGreaterThanOrEqual(1);

    // Check remote dir listing & integrity
    const dirEntries = await devA.engine.listRemoteDir();
    expect(dirEntries.length).toBeGreaterThan(0);
    const integrity = await devA.engine.checkIntegrity();
    expect(integrity.ok).toBe(true);
    expect(integrity.spaceMetadataOk).toBe(true);

    // Restore backup -> recovers orig-v1 cleanly & creates undo point!
    await devA.engine.restoreBackup(backupId);
    expect(devA.browser.findJarCookie('k1', 'maint.io')?.value).toBe('orig-v1');
    await devB.engine.syncNow();
    expect(devB.browser.findJarCookie('k1', 'maint.io')?.value).toBe('orig-v1');

    // Rebuild index cleanly reconstructs state from WebDAV
    await devB.engine.rebuildIndex();
    expect((await devB.engine.getSiteCookies('maint.io'))[0]?.value).toBe('orig-v1');
  });

  it('D-017: Storage schema upgrade migration preserves legacy data + duplicate deviceId regeneration', async () => {
    const { dav, webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    devA.browser.seedCookie({ domain: '.mig.io', name: 'legacy', value: 'v-old' });
    const joinA = await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    // Simulate legacy storage (schemaVersion = 0, cookie missing storeScope)
    await devA.storage.set('global', 'schemaVersion', 0);
    const ns = `space:${SPACE_ID}`;
    const rawCookies = (await devA.storage.get<Record<string, Record<string, unknown>>>(ns, 'cookies'))!;
    for (const c of Object.values(rawCookies)) {
      delete c.storeScope;
    }
    await devA.storage.set(ns, 'cookies', rawCookies);

    // Restart engine -> migration upgrades schemaVersion & backfills missing fields with zero data loss
    await devA.restartEngine();
    expect(await devA.storage.get<number>('global', 'schemaVersion')).toBe(2);
    const migratedCookies = await devA.engine.getSiteCookies('mig.io');
    expect(migratedCookies).toHaveLength(1);
    expect(migratedCookies[0].storeScope).toBe('default');
    expect(migratedCookies[0].value).toBe('v-old');

    // Duplicate deviceId detection: simulate cloned profile having same deviceId but different instanceNonce
    const clonedStorage = new InMemoryStorageBackend();
    await clonedStorage.set('global', 'deviceIdentity', {
      deviceId: joinA.deviceId,
      instanceNonce: 'inst_cloned_machine_2',
      defaultName: 'Cloned PC',
      createdAt: Date.now(),
    });
    const clonedBrowser = (await h.createDevice('Temp')).browser;
    const clonedEngine = new SyncEngine({
      storage: clonedStorage,
      browser: clonedBrowser,
      webdavClientOptions: { fetchImpl: dav.fetchImpl },
      debounceMs: 0,
      refreshCoalesceMs: 0,
      pbkdf2Iterations: 1000,
    });
    await clonedEngine.init();
    const joinCloned = await clonedEngine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Cloned PC',
    });
    // Regenerated a unique deviceId instead of overwriting Device A's manifest!
    expect(joinCloned.deviceId).not.toBe(joinA.deviceId);
    clonedEngine.dispose();

    // Probe remote spaces, test WebDAV connection, and verify sessionLockEnabled lock/unlock across restart
    const cap = await devA.engine.testWebDAVConnection(webdav);
    expect(cap.overallOk).toBe(true);
    expect(cap.consistencyLevel).toBe('strong_cas');

    const probed = await devA.engine.probeRemoteSpaces(webdav);
    expect(probed.some((s) => s.hintId === SPACE_ID)).toBe(true);

    await devA.engine.updateSpaceSettings({ sessionLockEnabled: true });
    await devA.restartEngine();
    expect((await devA.engine.getStatusSummary()).locked).toBe(true);
    await expect(devA.engine.unlockSession('BAD-PASS')).rejects.toMatchObject({ code: 'DECRYPT_ERROR' });
    await devA.engine.unlockSession(ENC_PASS);
    expect((await devA.engine.getStatusSummary()).locked).toBe(false);
    await devA.engine.lockSession();
    expect((await devA.engine.getStatusSummary()).locked).toBe(true);
  });
});
