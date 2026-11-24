import { describe, it, expect, afterEach } from 'vitest';
import { MockWebDAVServer } from '@sessionmesh/webdav-mock';
import { MultiDeviceHarness } from '../src/sim';
import type { WebDAVConfig } from '../src/types';

function createBaseConfig(): WebDAVConfig {
  return {
    url: 'https://dav.tracks.test/webdav',
    authType: 'basic',
    username: 'bob',
    password: 'tracks-password-123',
    rootPath: '/mesh',
  };
}

describe('Auto-Discovery & Multi-Track Acceptance Suite (T-001 .. T-007)', () => {
  let harness: MultiDeviceHarness | null = null;

  afterEach(() => {
    harness?.disposeAll();
    harness = null;
  });

  function setup() {
    const dav = new MockWebDAVServer({
      requireAuth: { username: 'bob', password: 'tracks-password-123' },
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

  const SPACE_ID = 'tracks-space';
  const SPACE_NAME = 'Multi-Account Space';
  const ENC_PASS = 'tracks-master-secret!';

  it('T-001: Auto-discovers existing browser sites while filtering analytics noise cookies (_ga/_gid/_fbp)', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    // Real logged-in site
    devA.browser.seedCookie({ domain: '.github.com', name: 'user_session', value: 'gh_tok_1', secure: true, httpOnly: true });
    devA.browser.seedCookie({ domain: '.github.com', name: '_ga', value: 'GA1.2.12345' });

    // Noise-only site (should NOT be uploaded or create a track)
    devA.browser.seedCookie({ domain: '.news-portal.com', name: '_ga', value: 'GA1.2.999' });
    devA.browser.seedCookie({ domain: '.news-portal.com', name: '_gid', value: 'GID.999' });
    devA.browser.seedCookie({ domain: '.news-portal.com', name: '_fbp', value: 'fb.1.999' });

    const report = await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    expect(report.localUploadedSites).toContain('github.com');
    expect(report.localUploadedSites).not.toContain('news-portal.com');

    const ghCookies = await devA.engine.getSiteCookies('github.com');
    expect(ghCookies.map((c) => c.name)).toEqual(['user_session']);
  });

  it('T-002: A has site, B does not -> B auto-pulls Track-A and enters bidirectional sync', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    devA.browser.seedCookie({ domain: '.notion.so', name: 'token_v2', value: 'notion-A-1', secure: true });

    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    const joinB = await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });

    expect(joinB.autoSyncedSites).toContain('notion.so');
    expect(joinB.pendingDecisions).toHaveLength(0);
    expect(devB.browser.findJarCookie('token_v2', 'notion.so')?.value).toBe('notion-A-1');

    // Bidirectional sync: B updates -> A receives automatically
    await devB.browser.simulateUserCookieSet({ domain: '.notion.so', name: 'token_v2', value: 'notion-B-2', secure: true });
    await devB.engine.flushPendingLocalChanges();
    await devB.engine.syncNow();

    await devA.engine.syncNow();
    expect(devA.browser.findJarCookie('token_v2', 'notion.so')?.value).toBe('notion-B-2');
  });

  it('T-003: Both A and B have login state -> pauses overwrite, asks user (use_remote_track / use_local_override_track / keep_independent / blacklist)', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    // 4 overlapping sites to test all 4 user choices!
    devA.browser.seedCookie({ domain: '.site-use-a.com', name: 'uid', value: 'A-user' });
    devA.browser.seedCookie({ domain: '.site-use-a.com', name: 'only_on_a', value: 'a-extra' });
    devB.browser.seedCookie({ domain: '.site-use-a.com', name: 'uid', value: 'B-user' });
    devB.browser.seedCookie({ domain: '.site-use-a.com', name: 'stale_on_b', value: 'should-be-cleaned' });

    devA.browser.seedCookie({ domain: '.site-use-b.com', name: 'uid', value: 'A-old' });
    devA.browser.seedCookie({ domain: '.site-use-b.com', name: 'stale_on_a', value: 'should-vanish-on-a' });
    devB.browser.seedCookie({ domain: '.site-use-b.com', name: 'uid', value: 'B-winner' });

    devA.browser.seedCookie({ domain: '.site-indep.com', name: 'uid', value: 'A-acct' });
    devB.browser.seedCookie({ domain: '.site-indep.com', name: 'uid', value: 'B-acct' });

    devA.browser.seedCookie({ domain: '.site-bl.com', name: 'uid', value: 'A-bl' });
    devB.browser.seedCookie({ domain: '.site-bl.com', name: 'uid', value: 'B-bl' });

    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    const joinB = await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });

    expect(joinB.pendingDecisions.map((d) => d.siteKey).sort()).toEqual([
      'site-bl.com',
      'site-indep.com',
      'site-use-a.com',
      'site-use-b.com',
    ]);

    // Verify ZERO silent overwrite happened on B!
    expect(devB.browser.findJarCookie('uid', 'site-use-a.com')?.value).toBe('B-user');
    expect(devB.browser.findJarCookie('uid', 'site-use-b.com')?.value).toBe('B-winner');
    expect(devB.browser.findJarCookie('uid', 'site-indep.com')?.value).toBe('B-acct');

    const pendingMap = new Map(joinB.pendingDecisions.map((p) => [p.siteKey, p]));

    // Choice 1: use_remote_track (A overwrites B cleanly + saves SafetyUndoPoint!)
    const trackA1 = pendingMap.get('site-use-a.com')!.remoteTracks[0].trackId;
    await devB.engine.resolveSiteDecision('site-use-a.com', { type: 'use_remote_track', trackId: trackA1 });
    expect(devB.browser.findJarCookie('uid', 'site-use-a.com')?.value).toBe('A-user');
    expect(devB.browser.findJarCookie('only_on_a', 'site-use-a.com')?.value).toBe('a-extra');
    // Clean Track Switch removed stale_on_b!
    expect(devB.browser.findJarCookie('stale_on_b', 'site-use-a.com')).toBeUndefined();
    const undos = await devB.engine.getUndoPoints();
    expect(undos.some((u) => u.siteKey === 'site-use-a.com')).toBe(true);

    // Choice 2: use_local_override_track (B overwrites A cleanly)
    const trackA2 = pendingMap.get('site-use-b.com')!.remoteTracks[0].trackId;
    await devB.engine.resolveSiteDecision('site-use-b.com', { type: 'use_local_override_track', trackId: trackA2 });
    await devA.engine.syncNow();
    expect(devA.browser.findJarCookie('uid', 'site-use-b.com')?.value).toBe('B-winner');
    expect(devA.browser.findJarCookie('stale_on_a', 'site-use-b.com')).toBeUndefined();

    // Choice 3: keep_independent (creates Track-B)
    await devB.engine.resolveSiteDecision('site-indep.com', { type: 'keep_independent', customLabel: 'B Work Account' });
    expect(devB.browser.findJarCookie('uid', 'site-indep.com')?.value).toBe('B-acct');

    // Choice 4: blacklist (device-level)
    await devB.engine.resolveSiteDecision('site-bl.com', { type: 'blacklist', scope: 'device' });
    expect(await devB.engine.getPendingDecisions()).toHaveLength(0);
  });

  it('T-004: Independent tracks (Track-A vs Track-B) never overwrite each other during ongoing sync', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    devA.browser.seedCookie({ domain: '.mail.io', name: 'acct', value: 'personal-1' });
    devB.browser.seedCookie({ domain: '.mail.io', name: 'acct', value: 'work-1' });

    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });

    await devB.engine.resolveSiteDecision('mail.io', { type: 'keep_independent', customLabel: 'Work Mail' });

    // Both devices keep updating their cookies
    await devA.browser.simulateUserCookieSet({ domain: '.mail.io', name: 'acct', value: 'personal-2' });
    await devB.browser.simulateUserCookieSet({ domain: '.mail.io', name: 'acct', value: 'work-2' });
    await devA.engine.flushPendingLocalChanges();
    await devB.engine.flushPendingLocalChanges();

    await devA.engine.syncNow();
    await devB.engine.syncNow();
    await devA.engine.syncNow();

    expect(devA.browser.findJarCookie('acct', 'mail.io')?.value).toBe('personal-2');
    expect(devB.browser.findJarCookie('acct', 'mail.io')?.value).toBe('work-2');
  });

  it('T-005: Device C joins with no local data when remote has Track-A & Track-B -> prompts C, then syncs chosen track bidirectionally', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');
    const devC = await h.createDevice('Device-C');

    devA.browser.seedCookie({ domain: '.cloud.io', name: 'user', value: 'alice-v1' });
    devB.browser.seedCookie({ domain: '.cloud.io', name: 'user', value: 'bob-v1' });

    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });
    await devB.engine.resolveSiteDecision('cloud.io', { type: 'keep_independent', customLabel: 'Bob Account' });

    // Device C has NO cookies for cloud.io, yet remote has 2 tracks!
    const joinC = await devC.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-C' });

    const pd = joinC.pendingDecisions.find((p) => p.siteKey === 'cloud.io');
    expect(pd).toBeDefined();
    expect(pd?.reason).toBe('multiple_remote_tracks');
    expect(pd?.remoteTracks).toHaveLength(2);
    expect(devC.browser.findJarCookie('user', 'cloud.io')).toBeUndefined();

    // C chooses Alice's track
    const aliceTrack = pd!.remoteTracks.find((t) => t.originDeviceName === 'Device-A')!;
    await devC.engine.resolveSiteDecision('cloud.io', { type: 'use_remote_track', trackId: aliceTrack.trackId });
    expect(devC.browser.findJarCookie('user', 'cloud.io')?.value).toBe('alice-v1');

    // Now A <-> C sync bidirectionally while B remains isolated!
    await devC.browser.simulateUserCookieSet({ domain: '.cloud.io', name: 'user', value: 'alice-v2-from-C' });
    await devC.engine.flushPendingLocalChanges();
    await devC.engine.syncNow();

    await devA.engine.syncNow();
    await devB.engine.syncNow();
    expect(devA.browser.findJarCookie('user', 'cloud.io')?.value).toBe('alice-v2-from-C');
    expect(devB.browser.findJarCookie('user', 'cloud.io')?.value).toBe('bob-v1');
  });

  it('T-006: Runtime track switch (with Clean Track Switch + Safety Undo), split independent, and rename track', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');
    const devC = await h.createDevice('Device-C');

    devA.browser.seedCookie({ domain: '.shop.io', name: 'acct', value: 'alice' });
    devA.browser.seedCookie({ domain: '.shop.io', name: 'alice_only', value: 'a1' });
    devB.browser.seedCookie({ domain: '.shop.io', name: 'acct', value: 'bob' });
    devB.browser.seedCookie({ domain: '.shop.io', name: 'bob_only', value: 'b1' });

    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });
    await devB.engine.resolveSiteDecision('shop.io', { type: 'keep_independent', customLabel: 'Bob Track' });

    const joinC = await devC.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-C' });
    const tracks = joinC.pendingDecisions.find((p) => p.siteKey === 'shop.io')!.remoteTracks;
    const trackA = tracks.find((t) => t.originDeviceName === 'Device-A')!;
    const trackB = tracks.find((t) => t.originDeviceName === 'Device-B')!;

    // C starts on Track-A
    await devC.engine.resolveSiteDecision('shop.io', { type: 'use_remote_track', trackId: trackA.trackId });
    expect(devC.browser.findJarCookie('acct', 'shop.io')?.value).toBe('alice');
    expect(devC.browser.findJarCookie('alice_only', 'shop.io')?.value).toBe('a1');

    // Rename Track-A and verify propagation
    await devA.engine.renameSiteTrack('shop.io', trackA.trackId, 'Alice VIP');
    await devC.engine.syncNow();
    const overviewC = await devC.engine.getSitesOverview();
    expect(overviewC.find((s) => s.siteKey === 'shop.io')?.activeTrack?.label).toBe('Alice VIP');

    // Switch C from Track-A to Track-B (Clean Track Switch removes alice_only!)
    await devC.engine.switchSiteTrack('shop.io', trackB.trackId);
    expect(devC.browser.findJarCookie('acct', 'shop.io')?.value).toBe('bob');
    expect(devC.browser.findJarCookie('bob_only', 'shop.io')?.value).toBe('b1');
    expect(devC.browser.findJarCookie('alice_only', 'shop.io')).toBeUndefined();

    // 1-Click Safety Undo restores Alice's cookies and binding!
    const undoPoints = await devC.engine.getUndoPoints();
    const switchUndo = undoPoints.find((u) => u.reason.startsWith('switch_track:'));
    expect(switchUndo).toBeDefined();
    await devC.engine.applyUndoPoint(switchUndo!.undoId);
    expect(devC.browser.findJarCookie('acct', 'shop.io')?.value).toBe('alice');
    expect(devC.browser.findJarCookie('alice_only', 'shop.io')?.value).toBe('a1');
    expect(devC.browser.findJarCookie('bob_only', 'shop.io')).toBeUndefined();

    // Split C into its own independent track
    await devC.engine.splitSiteIndependent('shop.io', 'Charlie Own Track');
    const overviewAfterSplit = await devC.engine.getSitesOverview();
    const shopView = overviewAfterSplit.find((s) => s.siteKey === 'shop.io')!;
    expect(shopView.binding.state).toBe('INDEPENDENT');
    expect(shopView.activeTrack?.label).toBe('Charlie Own Track');
  });

  it('T-007: Space-level and device-level blacklists completely block sync, upload, apply, and prompts', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');
    const devC = await h.createDevice('Device-C');

    devA.browser.seedCookie({ domain: '.mybank.com', name: 'bank_tok', value: 'secret-bank' });
    devA.browser.seedCookie({ domain: '.work-only.com', name: 'w_tok', value: 'work-val' });
    devB.browser.seedCookie({ domain: '.mybank.com', name: 'bank_tok', value: 'b-bank' });

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    // Space-level blacklist for mybank.com
    await devA.engine.addBlacklistEntry({
      pattern: 'mybank.com',
      matchType: 'subdomain',
      scope: 'space',
      reason: 'Sensitive banking site',
    });

    // Join B and C
    await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });
    await devC.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-C' });

    // Space-level blacklist blocked mybank.com on B & C
    expect(devC.browser.findJarCookie('bank_tok', 'mybank.com')).toBeUndefined();
    expect(devB.browser.findJarCookie('bank_tok', 'mybank.com')?.value).toBe('b-bank'); // untouched

    // Device-level blacklist on B for work-only.com -> B ignores updates, while A <-> C still sync!
    await devB.engine.addBlacklistEntry({
      pattern: 'work-only.com',
      matchType: 'subdomain',
      scope: 'device',
      reason: 'Do not sync work site on personal laptop B',
    });

    await devA.browser.simulateUserCookieSet({ domain: '.work-only.com', name: 'w_tok', value: 'work-v2' });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();

    await devB.engine.syncNow();
    await devC.engine.syncNow();

    expect(devB.browser.findJarCookie('w_tok', 'work-only.com')?.value).toBe('work-val'); // blocked by device blacklist
    expect(devC.browser.findJarCookie('w_tok', 'work-only.com')?.value).toBe('work-v2'); // synced cleanly to C!
  });

  it('Batch decision resolution and SSO domain group aggregation', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    devA.browser.seedCookie({ domain: '.batch1.io', name: 't', value: 'A1' });
    devA.browser.seedCookie({ domain: '.batch2.io', name: 't', value: 'A2' });
    devB.browser.seedCookie({ domain: '.batch1.io', name: 't', value: 'B1' });
    devB.browser.seedCookie({ domain: '.batch2.io', name: 't', value: 'B2' });

    await devA.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-A' });
    await devA.engine.upsertSsoGroup({
      groupId: 'sso-corp',
      name: 'Corp SSO',
      primarySiteKey: 'corp.io',
      domains: ['corp.io', 'corp-auth.net'],
    });
    const joinB = await devB.engine.saveAndJoinSpace({ webdav, spaceId: SPACE_ID, spaceName: SPACE_NAME, encryptionPassword: ENC_PASS, deviceName: 'Device-B' });
    expect(joinB.pendingDecisions.map((d) => d.siteKey).sort()).toEqual(['batch1.io', 'batch2.io']);

    // Resolve both pending sites in one batch call as independent
    await devB.engine.resolveBatchDecisions(['batch1.io', 'batch2.io'], { type: 'keep_independent' });
    expect(await devB.engine.getPendingDecisions()).toHaveLength(0);
    expect(devB.browser.findJarCookie('t', 'batch1.io')?.value).toBe('B1');
    expect(devB.browser.findJarCookie('t', 'batch2.io')?.value).toBe('B2');

    // Verify SSO group propagated and groups corp-auth.net under corp.io
    await devA.browser.simulateUserCookieSet({ domain: '.corp-auth.net', name: 'sso_sid', value: 'corp-1' });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();
    await devB.engine.syncNow();
    expect(devB.browser.findJarCookie('sso_sid', 'corp-auth.net')?.value).toBe('corp-1');
    const sitesB = await devB.engine.getSitesOverview();
    expect(sitesB.some((s) => s.siteKey === 'corp.io')).toBe(true);
  });
});
