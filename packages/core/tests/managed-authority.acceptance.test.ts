import { describe, it, expect, afterEach } from 'vitest';
import { MockWebDAVServer } from '@sessionmesh/webdav-mock';
import { MultiDeviceHarness } from '../src/sim';
import { ChangeDetector } from '../src/sync/ChangeDetector';
import { toStructuredError } from '../src/diagnostics';
import { EchoSuppressor, buildEchoCookieKey } from '../src/sync/EchoSuppressor';
import { applyCookieWithVerification } from '../src/sync/CookieApplyHelper';
import type { BrowserApiAdapter, BrowserCookieInput, WebDAVConfig } from '../src/types';

function createBaseConfig(overrides: Partial<WebDAVConfig> = {}): WebDAVConfig {
  return {
    url: 'https://dav.managed.test/webdav',
    authType: 'basic',
    username: 'alice',
    password: 'managed-password-123',
    rootPath: '/mesh',
    ...overrides,
  };
}

describe('Managed Sites, Space Auto-Detection, Authority Mode & Per-Device Policies (M-001 .. M-010)', () => {
  let harness: MultiDeviceHarness | null = null;

  afterEach(() => {
    harness?.disposeAll();
    harness = null;
  });

  function setup(configOverrides: Partial<WebDAVConfig> = {}) {
    const dav = new MockWebDAVServer({
      requireAuth: { username: 'alice', password: 'managed-password-123' },
    });
    const webdav = createBaseConfig(configOverrides);
    harness = new MultiDeviceHarness({
      webdav,
      fetchImpl: dav.fetchImpl,
      debounceMs: 0,
      refreshCoalesceMs: 0,
      pbkdf2Iterations: 1000,
    });
    return { dav, webdav, harness };
  }

  const SPACE_ID = 'team-work-2026';
  const SPACE_NAME = '核心研发空间';
  const ENC_PASS = 'managed-master-secret!';

  it('M-001: Opt-in managed_only mode only uploads opted-in sites on A and auto-syncs space sites to B without uploading B bystanders', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Desktop-A');
    const devB = await h.createDevice('Laptop-B');

    // Device A has 5 sites in browser, plus analytics noise on another site
    devA.browser.seedCookie({ domain: '.github.com', name: 'user_session', value: 'gh_A_1', secure: true, httpOnly: true });
    devA.browser.seedCookie({ domain: '.bilibili.com', name: 'SESSDATA', value: 'bili_A_1' });
    devA.browser.seedCookie({ domain: '.notion.so', name: 'token_v2', value: 'notion_A_1' });
    devA.browser.seedCookie({ domain: '.reddit.com', name: 'reddit_session', value: 'red_A_1' });
    devA.browser.seedCookie({ domain: '.youtube.com', name: 'SAPISID', value: 'yt_A_1' });
    devA.browser.seedCookie({ domain: '.tracker-only.io', name: '_ga', value: 'GA1.2.999' });

    // Scan candidates BEFORE space creation
    const preCandidates = await devA.engine.scanBrowserCandidateSites();
    expect(preCandidates.map((c) => c.siteKey).sort()).toEqual([
      'bilibili.com',
      'github.com',
      'notion.so',
      'reddit.com',
      'youtube.com',
    ]);
    expect(preCandidates.some((c) => c.siteKey === 'tracker-only.io')).toBe(false);
    expect(preCandidates.every((c) => c.alreadyManaged === false)).toBe(true);

    // Device A joins in managed_only mode and ONLY opts in github.com
    const joinA = await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Desktop-A',
      settingsPatch: { syncScopeMode: 'managed_only' },
      initialManagedSiteKeys: ['github.com'],
    });

    expect(joinA.localUploadedSites).toEqual(['github.com']);
    const overviewA = await devA.engine.getSitesOverview();
    expect(overviewA.map((s) => s.siteKey)).toEqual(['github.com']);

    // Mutating bystander site on A MUST NOT upload or create tracks!
    await devA.browser.simulateUserCookieSet({ domain: '.reddit.com', name: 'reddit_session', value: 'red_A_2' });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();
    expect((await devA.engine.getSitesOverview()).map((s) => s.siteKey)).toEqual(['github.com']);

    // Device B has 4 random bystander sites in browser
    devB.browser.seedCookie({ domain: '.twitter.com', name: 'auth_token', value: 'tw_B_1' });
    devB.browser.seedCookie({ domain: '.discord.com', name: '__dcfduid', value: 'dc_B_1' });
    devB.browser.seedCookie({ domain: '.spotify.com', name: 'sp_dc', value: 'sp_B_1' });
    devB.browser.seedCookie({ domain: '.twitch.tv', name: 'auth-token', value: 'ttv_B_1' });

    // Device B joins the existing managed_only space (inherits syncScopeMode: 'managed_only')
    const joinB = await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Laptop-B',
    });

    expect(joinB.localUploadedSites).toEqual([]);
    expect(joinB.autoSyncedSites).toEqual(['github.com']);
    expect(joinB.pendingDecisions).toEqual([]);
    expect(devB.browser.findJarCookie('user_session', 'github.com')?.value).toBe('gh_A_1');

    // None of B's 4 random sites were uploaded to A!
    await devA.engine.syncNow();
    expect((await devA.engine.getSitesOverview()).map((s) => s.siteKey)).toEqual(['github.com']);
    expect((await devB.engine.getSitesOverview()).map((s) => s.siteKey)).toEqual(['github.com']);

    // scanBrowserCandidateSites on A marks github.com alreadyManaged=true and others false
    const postCandidatesA = await devA.engine.scanBrowserCandidateSites();
    expect(postCandidatesA.find((c) => c.siteKey === 'github.com')?.alreadyManaged).toBe(true);
    expect(postCandidatesA.find((c) => c.siteKey === 'bilibili.com')?.alreadyManaged).toBe(false);
  });

  it('M-002: addManagedSites syncs existing site + pre-added empty site; removeManagedSite handles device_unmanage vs space_remove cleanly', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Desktop-A');
    const devB = await h.createDevice('Laptop-B');

    devA.browser.seedCookie({ domain: '.github.com', name: 'user_session', value: 'gh_1' });
    devA.browser.seedCookie({ domain: '.bilibili.com', name: 'SESSDATA', value: 'bili_1' });

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Desktop-A',
      settingsPatch: { syncScopeMode: 'managed_only' },
      initialManagedSiteKeys: ['github.com'],
    });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Laptop-B',
    });

    // Add bilibili.com (has cookies) AND preadded.io (0 cookies right now!) via addManagedSites
    const addRes = await devA.engine.addManagedSites(['bilibili.com', 'preadded.io']);
    expect(addRes.added.sort()).toEqual(['bilibili.com', 'preadded.io']);
    expect(addRes.pendingDecisions).toEqual([]);

    // Device B syncs -> gets bilibili.com immediately and preadded.io track
    await devB.engine.syncNow();
    expect(devB.browser.findJarCookie('SESSDATA', 'bilibili.com')?.value).toBe('bili_1');
    expect((await devB.engine.getSitesOverview()).map((s) => s.siteKey).sort()).toEqual([
      'bilibili.com',
      'github.com',
      'preadded.io',
    ]);

    // Later user logs into preadded.io on A -> auto-syncs immediately to B!
    await devA.browser.simulateUserCookieSet({ domain: '.preadded.io', name: 'sid', value: 'pre_login_1' });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();
    await devB.engine.syncNow();
    expect(devB.browser.findJarCookie('sid', 'preadded.io')?.value).toBe('pre_login_1');

    // 1) device_unmanage on B for bilibili.com: B stops syncing bilibili.com, A is unaffected!
    await devB.engine.removeManagedSite('bilibili.com', 'device_unmanage');
    expect((await devB.engine.getSitesOverview()).map((s) => s.siteKey)).not.toContain('bilibili.com');

    // B's local mutation on bilibili.com MUST NOT propagate to A
    await devB.browser.simulateUserCookieSet({ domain: '.bilibili.com', name: 'SESSDATA', value: 'bili_B_local' });
    await devB.engine.flushPendingLocalChanges();
    await devB.engine.syncNow();
    await devA.engine.syncNow();
    expect(devA.browser.findJarCookie('SESSDATA', 'bilibili.com')?.value).toBe('bili_1');

    // A's update on bilibili.com MUST NOT overwrite unmanaged B
    await devA.browser.simulateUserCookieSet({ domain: '.bilibili.com', name: 'SESSDATA', value: 'bili_A_v2' });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();
    await devB.engine.syncNow();
    expect(devB.browser.findJarCookie('SESSDATA', 'bilibili.com')?.value).toBe('bili_B_local');
    expect((await devA.engine.getSitesOverview()).map((s) => s.siteKey)).toContain('bilibili.com');

    // 2) space_remove on A for preadded.io: removes tracks & remote records across the entire space!
    await devA.engine.removeManagedSite('preadded.io', 'space_remove');
    expect((await devA.engine.getSitesOverview()).map((s) => s.siteKey)).not.toContain('preadded.io');
    expect(await devA.engine.getSiteCookies('preadded.io')).toEqual([]);

    await devB.engine.syncNow();
    expect((await devB.engine.getSitesOverview()).map((s) => s.siteKey)).not.toContain('preadded.io');
    expect(await devB.engine.getSiteCookies('preadded.io')).toEqual([]);
  });

  it('M-003: probeRemoteSpaces returns human-readable spaceId & spaceName before password entry (binary_enc & base64_txt) and fixes sp_ double-hashing', async () => {
    // Test 1: default binary_enc mode
    const { webdav, harness: h } = setup({ storageFormat: 'binary_enc' });
    const devA = await h.createDevice('Desktop-A');
    const freshClient = await h.createDevice('BrandNew-Client');

    devA.browser.seedCookie({ domain: '.github.com', name: 'user_session', value: 'gh_probe_1' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Desktop-A',
    });

    // Brand-new client probes WebDAV BEFORE entering encryptionPassword
    const probed = await freshClient.engine.probeRemoteSpaces(webdav);
    expect(probed).toHaveLength(1);
    expect(probed[0].opaqueId.startsWith('sp_')).toBe(true);
    expect(probed[0].spaceId).toBe(SPACE_ID);
    expect(probed[0].hintId).toBe(SPACE_ID);
    expect(probed[0].spaceName).toBe(SPACE_NAME);
    expect(typeof probed[0].updatedAt).toBe('number');

    // Rename space -> fresh client immediately probes updated spaceName
    await devA.engine.renameSpace(SPACE_ID, '新版研发空间');
    const probedAfterRename = await freshClient.engine.probeRemoteSpaces(webdav);
    expect(probedAfterRename[0].spaceId).toBe(SPACE_ID);
    expect(probedAfterRename[0].spaceName).toBe('新版研发空间');

    // Double-hashing bug fix: joining by opaqueId `sp_...` joins existing space (no new dir!)
    const joinByOpaque = await freshClient.engine.saveAndJoinSpace({
      webdav,
      spaceId: probed[0].opaqueId,
      spaceName: 'Ignored Fallback Name',
      encryptionPassword: ENC_PASS,
      deviceName: 'BrandNew-Client',
    });
    expect(joinByOpaque.isNewSpace).toBe(false);
    expect(joinByOpaque.spaceId).toBe(SPACE_ID);
    expect(joinByOpaque.spaceName).toBe('新版研发空间');
    expect(freshClient.browser.findJarCookie('user_session', 'github.com')?.value).toBe('gh_probe_1');

    // Verify still only 1 space exists on WebDAV (no double-hashed duplicate directory!)
    const probedFinal = await freshClient.engine.probeRemoteSpaces(webdav);
    expect(probedFinal).toHaveLength(1);
  });

  it('M-004: probeRemoteSpaces works cleanly in base64_txt WebDAV compatibility mode', async () => {
    const { webdav, harness: h } = setup({ storageFormat: 'base64_txt' });
    const devA = await h.createDevice('Nutstore-A');
    const devB = await h.createDevice('Nutstore-B');

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: 'nutstore-space',
      spaceName: '坚果云同步空间',
      encryptionPassword: ENC_PASS,
      deviceName: 'Nutstore-A',
    });

    // Probe using base64_txt config AND using default binary_enc config (before capability detection!)
    const probedTxt = await devB.engine.probeRemoteSpaces(webdav);
    expect(probedTxt).toHaveLength(1);
    expect(probedTxt[0].spaceId).toBe('nutstore-space');
    expect(probedTxt[0].spaceName).toBe('坚果云同步空间');

    const probedDefault = await devB.engine.probeRemoteSpaces({
      ...webdav,
      storageFormat: 'binary_enc',
    });
    expect(probedDefault).toHaveLength(1);
    expect(probedDefault[0].spaceId).toBe('nutstore-space');
    expect(probedDefault[0].spaceName).toBe('坚果云同步空间');
  });

  it('M-005: authorityMode=primary_device auto-resolves B overlap, while Device C (independent_tracks) keeps own track and Device D (pull_only) never pushes back', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Desktop-A');
    const devB = await h.createDevice('Laptop-B');
    const devC = await h.createDevice('WorkPC-C');
    const devD = await h.createDevice('ReadOnly-D');

    devA.browser.seedCookie({ domain: '.github.com', name: 'user_session', value: 'A_PRIMARY' });
    devA.browser.seedCookie({ domain: '.github.com', name: 'a_extra', value: 'from_A' });

    const joinA = await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Desktop-A',
    });
    const devAId = joinA.deviceId;

    // Configure Desktop-A as unified Primary Authority Device
    const updatedSettings = await devA.engine.setSpaceAuthorityPolicy({
      authorityMode: 'primary_device',
      primaryDeviceId: devAId,
    });
    expect(updatedSettings.authorityMode).toBe('primary_device');
    expect(updatedSettings.primaryDeviceId).toBe(devAId);

    // Pre-configure Per-Device Policies for C (independent_tracks) and D (pull_only)
    const devCIdentity = await devC.storage.get<{ deviceId: string }>('global', 'deviceIdentity');
    const devDIdentity = await devD.storage.get<{ deviceId: string }>('global', 'deviceIdentity');
    const devCId = devCIdentity!.deviceId;
    const devDId = devDIdentity!.deviceId;

    await devA.engine.upsertDevicePolicy({
      deviceId: devCId,
      mode: 'independent_tracks',
      direction: 'bidirectional',
      updatedAt: Date.now(),
    });
    await devA.engine.upsertDevicePolicy({
      deviceId: devDId,
      mode: 'inherit',
      direction: 'pull_only',
      updatedAt: Date.now() + 1,
    });

    // Device B has overlapping github.com cookies -> auto-adopts Desktop-A's track with ZERO prompt!
    devB.browser.seedCookie({ domain: '.github.com', name: 'user_session', value: 'B_OVERLAP' });
    devB.browser.seedCookie({ domain: '.github.com', name: 'stale_on_b', value: 'should_vanish' });
    const joinB = await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Laptop-B',
    });
    expect(joinB.pendingDecisions).toEqual([]);
    expect(await devB.engine.getPendingDecisions()).toEqual([]);
    expect(devB.browser.findJarCookie('user_session', 'github.com')?.value).toBe('A_PRIMARY');
    expect(devB.browser.findJarCookie('a_extra', 'github.com')?.value).toBe('from_A');
    expect(devB.browser.findJarCookie('stale_on_b', 'github.com')).toBeUndefined();
    // SafetyUndoPoint was still recorded before Clean Track Switch
    expect((await devB.engine.getUndoPoints()).some((u) => u.siteKey === 'github.com')).toBe(true);

    // Device C (independent_tracks) has overlapping github.com cookies -> keeps its OWN independent track with ZERO prompt!
    devC.browser.seedCookie({ domain: '.github.com', name: 'user_session', value: 'C_INDEPENDENT' });
    const joinC = await devC.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'WorkPC-C',
    });
    expect(joinC.pendingDecisions).toEqual([]);
    expect(devC.browser.findJarCookie('user_session', 'github.com')?.value).toBe('C_INDEPENDENT');
    const overviewC = await devC.engine.getSitesOverview();
    expect(overviewC.find((s) => s.siteKey === 'github.com')?.binding.state).toBe('INDEPENDENT');

    // Sync A & B to make sure C's independent track did NOT overwrite A or B
    await devA.engine.syncNow();
    await devB.engine.syncNow();
    expect(devA.browser.findJarCookie('user_session', 'github.com')?.value).toBe('A_PRIMARY');
    expect(devB.browser.findJarCookie('user_session', 'github.com')?.value).toBe('A_PRIMARY');

    // Device D (pull_only) joins -> receives A's primary track automatically even though both A and C tracks exist!
    devD.browser.seedCookie({ domain: '.local-only-on-d.io', name: 'd_tok', value: 'must_not_upload' });
    const joinD = await devD.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'ReadOnly-D',
    });
    expect(joinD.pendingDecisions).toEqual([]);
    expect(joinD.localUploadedSites).toEqual([]);
    expect(devD.browser.findJarCookie('user_session', 'github.com')?.value).toBe('A_PRIMARY');

    // Device D mutates github.com locally -> MUST NOT push back to A!
    await devD.browser.simulateUserCookieSet({ domain: '.github.com', name: 'user_session', value: 'D_MUTATION' });
    await devD.engine.flushPendingLocalChanges();
    const syncD = await devD.engine.syncNow();
    expect(syncD.pushedEvents).toBe(0);

    await devA.engine.syncNow();
    expect(devA.browser.findJarCookie('user_session', 'github.com')?.value).toBe('A_PRIMARY');
    expect((await devA.engine.getSitesOverview()).some((s) => s.siteKey === 'local-only-on-d.io')).toBe(false);

    // Desktop-A updates github.com -> Device D receives update cleanly!
    await devA.browser.simulateUserCookieSet({ domain: '.github.com', name: 'user_session', value: 'A_PRIMARY_V2' });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();

    await devD.engine.syncNow();
    expect(devD.browser.findJarCookie('user_session', 'github.com')?.value).toBe('A_PRIMARY_V2');
    // Device C stays completely independent!
    await devC.engine.syncNow();
    expect(devC.browser.findJarCookie('user_session', 'github.com')?.value).toBe('C_INDEPENDENT');
  });

  it('M-006: Per-device follow_device, push_only, disabled, and excludedSiteKeys overrides + removeDevicePolicy', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Desktop-A');
    const devC = await h.createDevice('WorkPC-C');
    const devE = await h.createDevice('Follower-E');
    const devP = await h.createDevice('PushOnly-P');

    devA.browser.seedCookie({ domain: '.gitlab.com', name: 'session', value: 'A_GL' });
    devA.browser.seedCookie({ domain: '.jira.com', name: 'session', value: 'A_JIRA' });

    const joinA = await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Desktop-A',
    });
    await devA.engine.setSpaceAuthorityPolicy({
      authorityMode: 'primary_device',
      primaryDeviceId: joinA.deviceId,
    });

    const devCId = (await devC.storage.get<{ deviceId: string }>('global', 'deviceIdentity'))!.deviceId;
    const devEId = (await devE.storage.get<{ deviceId: string }>('global', 'deviceIdentity'))!.deviceId;
    const devPId = (await devP.storage.get<{ deviceId: string }>('global', 'deviceIdentity'))!.deviceId;

    await devA.engine.upsertDevicePolicy({
      deviceId: devCId,
      mode: 'independent_tracks',
      direction: 'bidirectional',
      updatedAt: Date.now(),
    });
    await devA.engine.upsertDevicePolicy({
      deviceId: devEId,
      mode: 'follow_device',
      followDeviceId: devCId,
      direction: 'bidirectional',
      excludedSiteKeys: ['jira.com'],
      updatedAt: Date.now() + 1,
    });
    await devA.engine.upsertDevicePolicy({
      deviceId: devPId,
      mode: 'inherit',
      direction: 'push_only',
      updatedAt: Date.now() + 2,
    });

    devC.browser.seedCookie({ domain: '.gitlab.com', name: 'session', value: 'C_GL' });
    await devC.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'WorkPC-C',
    });

    // Follower-E explicitly follows WorkPC-C (NOT Primary Desktop-A!) and excludes jira.com
    devE.browser.seedCookie({ domain: '.gitlab.com', name: 'session', value: 'E_OLD' });
    const joinE = await devE.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Follower-E',
    });
    expect(joinE.pendingDecisions).toEqual([]);
    expect(devE.browser.findJarCookie('session', 'gitlab.com')?.value).toBe('C_GL');
    // Excluded site jira.com was NOT synced to E!
    expect(devE.browser.findJarCookie('session', 'jira.com')).toBeUndefined();

    // PushOnly-P pushes its own new site to space, but NEVER applies remote cookies to its local browser!
    devP.browser.seedCookie({ domain: '.push-site.io', name: 'ptok', value: 'P_PUSHED' });
    await devP.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'PushOnly-P',
    });
    expect(devP.browser.findJarCookie('session', 'jira.com')).toBeUndefined();
    await devA.engine.syncNow();
    expect(devA.browser.findJarCookie('ptok', 'push-site.io')?.value).toBe('P_PUSHED');

    // removeDevicePolicy restores normal inheritance
    await devA.engine.removeDevicePolicy(devPId);
    const settingsAfterRemove = await devA.engine.getSpaceSettings();
    expect(settingsAfterRemove.devicePolicies?.[devPId]).toBeUndefined();
  });

  it('M-007: Same-track CONCURRENT conflict under primary_device deterministically awards victory to primaryDeviceId even with earlier clock', async () => {
    const { webdav, harness: h } = setup();
    // Desktop-A has an EARLIER clock (-120s), Laptop-B has a LATER clock (+120s)
    const devA = await h.createDevice('Desktop-A', { clockOffsetMs: -120_000 });
    const devB = await h.createDevice('Laptop-B', { clockOffsetMs: +120_000 });

    devA.browser.seedCookie({ domain: '.github.com', name: 'user_session', value: 'initial_v1' });
    const joinA = await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Desktop-A',
    });
    await devA.engine.setSpaceAuthorityPolicy({
      authorityMode: 'primary_device',
      primaryDeviceId: joinA.deviceId,
    });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Laptop-B',
    });
    expect(devB.browser.findJarCookie('user_session', 'github.com')?.value).toBe('initial_v1');

    // Both devices go offline and concurrently update the same cookie on the shared track
    devA.browser.setOnline(false);
    devB.browser.setOnline(false);

    await devA.browser.simulateUserCookieSet({ domain: '.github.com', name: 'user_session', value: 'PRIMARY_A_WINS' });
    await devB.browser.simulateUserCookieSet({ domain: '.github.com', name: 'user_session', value: 'LATER_CLOCK_B_LOSES' });
    await devA.engine.flushPendingLocalChanges();
    await devB.engine.flushPendingLocalChanges();

    // Come back online and sync in both directions
    devA.browser.setOnline(true);
    devB.browser.setOnline(true);
    await devB.engine.syncNow();
    await devA.engine.syncNow();
    await devB.engine.syncNow();

    // Primary Device A MUST win on BOTH devices despite B having a +240s newer wall clock!
    expect(devA.browser.findJarCookie('user_session', 'github.com')?.value).toBe('PRIMARY_A_WINS');
    expect(devB.browser.findJarCookie('user_session', 'github.com')?.value).toBe('PRIMARY_A_WINS');
  });

  it('M-008: setSpaceAuthorityPolicy re-evaluates existing pendingDecisions and latest_wins adopts newest remote track', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Desktop-A', { fixedNowMs: 1_700_000_001_000 });
    const devB = await h.createDevice('Laptop-B', { fixedNowMs: 1_700_000_005_000 });
    const devC = await h.createDevice('Tablet-C', { fixedNowMs: 1_700_000_009_000 });

    devA.browser.seedCookie({ domain: '.notion.so', name: 'token_v2', value: 'A_OLDER' });
    devB.browser.seedCookie({ domain: '.notion.so', name: 'token_v2', value: 'B_NEWER' });

    const joinA = await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Desktop-A',
    });

    // Default authorityMode='ask' -> Device B gets pending decision
    const joinB = await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Laptop-B',
    });
    expect(joinB.pendingDecisions).toHaveLength(1);

    // Switching space authority to primary_device (Desktop-A) directly on B immediately resolves B's pending decision!
    await devB.engine.setSpaceAuthorityPolicy({
      authorityMode: 'primary_device',
      primaryDeviceId: joinA.deviceId,
    });
    expect(await devB.engine.getPendingDecisions()).toEqual([]);
    expect(devB.browser.findJarCookie('token_v2', 'notion.so')?.value).toBe('A_OLDER');

    // Now test latest_wins with 2 tracks: B splits independent (newer timestamp), then switch to latest_wins
    await devB.browser.simulateUserCookieSet({ domain: '.notion.so', name: 'token_v2', value: 'B_INDEP_NEWEST' });
    await devB.engine.flushPendingLocalChanges();
    await devB.engine.splitSiteIndependent('notion.so', 'B Newest Track');
    await devB.engine.setSpaceAuthorityPolicy({ authorityMode: 'latest_wins' });

    // Device C joins with overlapping cookie -> latest_wins auto-adopts B's newest track with ZERO prompt!
    devC.browser.seedCookie({ domain: '.notion.so', name: 'token_v2', value: 'C_OVERLAP' });
    const joinC = await devC.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Tablet-C',
    });
    expect(joinC.pendingDecisions).toEqual([]);
    expect(devC.browser.findJarCookie('token_v2', 'notion.so')?.value).toBe('B_INDEP_NEWEST');
  });

  it('M-009: dismissLatestError clears latestError, persists across engine restart, and emits state change', async () => {
    const { webdav, harness: h } = setup();
    let stateChanges = 0;
    const devA = await h.createDevice(
      'Desktop-A',
      {},
      {
        onStateChange: () => {
          stateChanges += 1;
        },
      },
    );

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Desktop-A',
    });

    // Trigger a genuine DECRYPT_ERROR via wrong unlock password
    await devA.engine.lockSession();
    await expect(devA.engine.unlockSession('wrong-password')).rejects.toBeTruthy();

    const summaryBefore = await devA.engine.getStatusSummary();
    expect(summaryBefore.latestError).not.toBeNull();
    expect(summaryBefore.latestError?.code).toBe('DECRYPT_ERROR');

    const beforeCount = stateChanges;
    await devA.engine.dismissLatestError();
    expect(stateChanges).toBeGreaterThan(beforeCount);

    const summaryAfter = await devA.engine.getStatusSummary();
    expect(summaryAfter.latestError).toBeNull();

    // Restart engine to verify persistence
    await devA.restartEngine();
    const summaryRestarted = await devA.engine.getStatusSummary();
    expect(summaryRestarted.latestError).toBeNull();
  });

  it('M-010: managed_only enforces isolation on LocalStorage & onSiteVisited, and primaryDevice leader overrides remote overlap', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Desktop-A');
    const devB = await h.createDevice('Laptop-B');

    devA.browser.seedCookie({ domain: '.github.com', name: 'user_session', value: 'gh_A' });
    const joinA = await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Desktop-A',
      settingsPatch: { syncScopeMode: 'managed_only' },
      initialManagedSiteKeys: ['github.com'],
    });
    await devA.engine.setSpaceAuthorityPolicy({
      authorityMode: 'primary_device',
      primaryDeviceId: joinA.deviceId,
    });

    // Bystander LocalStorage & onSiteVisited MUST be ignored in managed_only mode
    devA.browser.seedLocalStorage('https://unmanaged.io', { jwt: 'secret_local_only' });
    await devA.engine.ingestLocalStorageSnapshot('https://unmanaged.io', { jwt: 'secret_local_only' });
    await devA.engine.ingestLocalStorageMutations('https://unmanaged.io', [{ key: 'jwt', value: 'secret_2' }]);
    await devA.engine.onSiteVisited('https://unmanaged.io/dashboard');
    expect(await devA.engine.getLocalStorageRecords({ siteKey: 'unmanaged.io' })).toEqual([]);
    expect((await devA.engine.getSitesOverview()).map((s) => s.siteKey)).toEqual(['github.com']);

    // Managed site LocalStorage DOES sync
    await devA.engine.ingestLocalStorageSnapshot('https://github.com', { theme: 'dark' });
    expect((await devA.engine.getLocalStorageRecords({ siteKey: 'github.com' })).map((r) => r.key)).toEqual(['theme']);

    // Laptop-B joins and adds a new managed site `linear.app` while Desktop-A ALSO has local `linear.app` cookies
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Laptop-B',
    });
    devB.browser.seedCookie({ domain: '.linear.app', name: 'lin_tok', value: 'B_LINEAR' });
    devA.browser.seedCookie({ domain: '.linear.app', name: 'lin_tok', value: 'A_PRIMARY_LINEAR' });

    await devB.engine.addManagedSites(['linear.app']);
    // Desktop-A (the Primary Authority!) pulls linear.app -> auto-overrides remote with A's local data!
    await devA.engine.syncNow();
    expect(await devA.engine.getPendingDecisions()).toEqual([]);
    expect(devA.browser.findJarCookie('lin_tok', 'linear.app')?.value).toBe('A_PRIMARY_LINEAR');

    // Laptop-B syncs -> receives Primary Device A's authoritative override!
    await devB.engine.syncNow();
    expect(devB.browser.findJarCookie('lin_tok', 'linear.app')?.value).toBe('A_PRIMARY_LINEAR');
  });

  it('M-011 & M-012: Fresh managed_only space and expired remote cookies report clean SYNCED status with zero false attentionItems', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Desktop-A');
    const devB = await h.createDevice('Laptop-B', { clockOffsetMs: +7200 * 1000 });

    // Seed bystander cookies on A -> fresh managed_only join with 0 selected sites
    devA.browser.seedCookie({ domain: '.bystander.io', name: 'sid', value: 'local_1' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Desktop-A',
      settingsPatch: { syncScopeMode: 'managed_only' },
      initialManagedSiteKeys: [],
    });

    const summaryFresh = await devA.engine.getStatusSummary();
    expect(summaryFresh.status).toBe('SYNCED');
    expect(summaryFresh.pendingUploads).toBe(0);
    expect(summaryFresh.pendingApplies).toBe(0);
    expect(summaryFresh.attentionItems).toEqual([]);

    // Now Device A adds a short-lived cookie (expires in 1800s), while Device B is 2 hours ahead (already expired on B!)
    const shortExp = Math.floor(Date.now() / 1000) + 1800;
    await devA.engine.upsertCookie('shortlived.io', {
      domain: '.shortlived.io',
      name: 'short_tok',
      value: 'v1',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
      session: false,
      expirationDate: shortExp,
      hostOnly: false,
    });

    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Laptop-B',
    });

    // Expired remote cookie MUST become EXPIRED (NOT APPLY_FAILED / PARTIAL)
    const cookiesOnB = await devB.engine.getSiteCookies('shortlived.io');
    expect(cookiesOnB[0]?.syncStatus).toBe('EXPIRED');
    const summaryB = await devB.engine.getStatusSummary();
    expect(summaryB.status).toBe('SYNCED');
    expect(summaryB.attentionItems).toEqual([]);
  });

  it('M-013: Actionable attentionItems surface exact details for apply_failed, pending_decision, conflict, deferred_reload, and clear cleanly via retry/dismiss', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Desktop-A');
    const devB = await h.createDevice('Laptop-B');

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Desktop-A',
      settingsPatch: { syncScopeMode: 'managed_only' },
    });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Laptop-B',
    });

    // 1. Cookie apply failure on bound site -> status='PARTIAL' + exact apply_failed AttentionItem
    await devA.engine.upsertCookie('strict.io', {
      domain: '.strict.io',
      name: 'blocked_cookie',
      value: 'v1',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      session: true,
      hostOnly: false,
    });

    devB.browser.rejectCookiePredicate = (c) =>
      c.name === 'blocked_cookie' ? 'Browser policy blocked this cookie' : null;
    await devB.engine.syncNow();

    let statusB = await devB.engine.getStatusSummary();
    expect(statusB.status).toBe('PARTIAL');
    const applyItem = statusB.attentionItems.find((i) => i.kind === 'apply_failed');
    expect(applyItem).toBeDefined();
    expect(applyItem?.siteKey).toBe('strict.io');
    expect(applyItem?.detail).toContain('blocked_cookie');

    // Dismissing apply_failed immediately clears PARTIAL -> SYNCED and empties attentionItems
    await devB.engine.dismissAttentionItem(applyItem!.id);
    statusB = await devB.engine.getStatusSummary();
    expect(statusB.status).toBe('SYNCED');
    expect(statusB.attentionItems).toEqual([]);

    // When a NEW version of blocked_cookie arrives, it alerts again; then retryFailedCookies fixes it once browser allows
    await devA.engine.upsertCookie('strict.io', {
      domain: '.strict.io',
      name: 'blocked_cookie',
      value: 'v2_updated',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      session: true,
      hostOnly: false,
    });
    await devB.engine.syncNow();
    expect((await devB.engine.getStatusSummary()).status).toBe('PARTIAL');

    devB.browser.rejectCookiePredicate = undefined;
    const retryRes = await devB.engine.retryFailedCookies('strict.io');
    expect(retryRes).toEqual({ retried: 1, succeeded: 1, failed: 0 });
    statusB = await devB.engine.getStatusSummary();
    expect(statusB.status).toBe('SYNCED');
    expect(statusB.attentionItems).toEqual([]);

    // 2. Form-safe deferred reload -> surfaces deferred_reload item and clears on forceReloadDeferredTab
    const tabId = devB.browser.openTab('https://strict.io/settings', {
      active: true,
      safeToReload: false,
      unsafeReasons: ['dirty_form_input'],
    });
    await devA.engine.upsertCookie('strict.io', {
      domain: '.strict.io',
      name: 'blocked_cookie',
      value: 'v3_form_dirty',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      session: true,
      hostOnly: false,
    });
    await devB.engine.syncNow();

    statusB = await devB.engine.getStatusSummary();
    const reloadItem = statusB.attentionItems.find((i) => i.kind === 'deferred_reload');
    expect(reloadItem).toBeDefined();
    expect(reloadItem?.siteKey).toBe('strict.io');
    expect(reloadItem?.tabId).toBe(tabId);
    expect(reloadItem?.detail).toContain('表单有未保存输入');

    const reloaded = await devB.engine.forceReloadDeferredTab(tabId);
    expect(reloaded).toBe(true);
    statusB = await devB.engine.getStatusSummary();
    expect(statusB.attentionItems.find((i) => i.kind === 'deferred_reload')).toBeUndefined();
  });

  it('M-014: Chromium Set-Cookie Max-Age=0 (expired_overwrite) propagates logout Tombstone & pre-open tab LocalStorage uploads on join', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Edge-A');
    const devB = await h.createDevice('Chrome-B');

    // Open tab + LocalStorage + Cookie on A BEFORE saveAndJoinSpace
    devA.browser.openTab('https://portal.io/dashboard', { active: true, safeToReload: true });
    devA.browser.seedLocalStorage('https://portal.io', { ws_token: 'tok_pre_join' });
    devA.browser.seedCookie({ domain: '.portal.io', name: 'sid', value: 'sid_alive_1' });

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Edge-A',
      settingsPatch: { syncScopeMode: 'managed_only' },
      initialManagedSiteKeys: ['portal.io'],
    });

    devB.browser.openTab('https://portal.io/dashboard', { active: true, safeToReload: true });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Chrome-B',
    });

    expect(devB.browser.findJarCookie('sid', 'portal.io')?.value).toBe('sid_alive_1');
    expect((await devB.browser.getLocalStorage('https://portal.io')).items.ws_token).toBe('tok_pre_join');

    // Simulate real Chromium HTTP `Set-Cookie: sid=; Max-Age=0` (`removed: true, cause: 'expired_overwrite'`)
    const cur = devA.browser.findJarCookie('sid', 'portal.io')!;
    await devA.browser.removeCookie({ url: 'https://portal.io/', name: 'sid' });
    // Trigger raw expired_overwrite change event on A's browser adapter
    (devA.browser as unknown as { emitCookieChanged: (ev: unknown) => void }).emitCookieChanged({
      removed: true,
      cause: 'expired_overwrite',
      cookie: cur,
    });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();
    await devB.engine.syncNow();

    expect(devB.browser.findJarCookie('sid', 'portal.io')).toBeUndefined();
  });

  it('M-015: Wrong password on locked session sets DECRYPT_ERROR and subsequent valid unlockSession cleanly recovers to SYNCED', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Edge-A');

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Edge-A',
      settingsPatch: { syncScopeMode: 'managed_only' },
    });

    await devA.engine.lockSession();
    expect((await devA.engine.getStatusSummary()).status).toBe('LOCKED');

    // Wrong password attempt -> DECRYPT_ERROR
    await expect(devA.engine.unlockSession('WRONG-PASS')).rejects.toMatchObject({ code: 'DECRYPT_ERROR' });
    const errSummary = await devA.engine.getStatusSummary();
    expect(errSummary.status).toBe('DECRYPT_ERROR');
    expect(errSummary.locked).toBe(true);
    expect(errSummary.attentionItems.some((i) => i.kind === 'decrypt_error')).toBe(true);

    // Correct password attempt -> MUST clear DECRYPT_ERROR and recover to SYNCED!
    await devA.engine.unlockSession(ENC_PASS);
    const okSummary = await devA.engine.getStatusSummary();
    expect(okSummary.locked).toBe(false);
    expect(okSummary.status).toBe('SYNCED');
    expect(okSummary.attentionItems).toEqual([]);
  });

  it('M-016: applyCookieWithVerification disambiguates colliding hostOnly vs wildcard-domain cookies when getCookie returns sibling', async () => {
    const wildcardCookie: BrowserCookieInput = {
      domain: '.collide.io',
      name: 'layered',
      value: 'wildcard_val',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
      session: true,
      hostOnly: false,
    };
    const hostOnlyCookie: BrowserCookieInput = {
      domain: 'app.collide.io',
      name: 'layered',
      value: 'hostonly_val',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
      session: true,
      hostOnly: true,
    };
    const jar: BrowserCookieInput[] = [wildcardCookie];

    // Simulate real Chromium `chrome.cookies.get()` returning the earlier-created wildcard cookie
    // when asked for url="https://app.collide.io/", name="layered"
    const ambiguousBrowser = {
      async setCookie(details: BrowserCookieInput & { url: string }) {
        jar.push({ ...details });
        return { cookie: { ...details } };
      },
      async getCookie() {
        return wildcardCookie;
      },
      async getAllCookies() {
        return [...jar];
      },
    } as unknown as BrowserApiAdapter;

    const res = await applyCookieWithVerification(ambiguousBrowser, hostOnlyCookie, Date.now());
    expect(res.accepted).toBe(true);
  });

  it('M-017: LocalStorage sync handles Object.prototype reserved keys (__proto__, constructor, toString, hasOwnProperty)', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Edge-A');
    const devB = await h.createDevice('Chrome-B');

    devA.browser.openTab('https://proto.io/', { active: true, safeToReload: true });
    devB.browser.openTab('https://proto.io/', { active: true, safeToReload: true });
    devA.browser.seedCookie({ domain: '.proto.io', name: 'sid', value: 'v1' });

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Edge-A',
      settingsPatch: { syncScopeMode: 'managed_only', syncLocalStorage: true },
      initialManagedSiteKeys: ['proto.io'],
    });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Chrome-B',
    });

    const weirdItems: Record<string, string> = Object.create(null);
    for (const [k, v] of [
      ['__proto__', 'proto_ok'],
      ['constructor', 'ctor_ok'],
      ['toString', 'tostr_ok'],
      ['hasOwnProperty', 'hop_ok'],
    ]) {
      Object.defineProperty(weirdItems, k, {
        value: v,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }

    await devA.engine.ingestLocalStorageSnapshot('https://proto.io', weirdItems);
    await devA.engine.syncNow();
    await devB.engine.syncNow();

    const recsB = await devB.engine.getLocalStorageRecords({ siteKey: 'proto.io' });
    const mapB = new Map(recsB.filter((r) => !r.deleted).map((r) => [r.key, r.value]));
    expect(mapB.get('__proto__')).toBe('proto_ok');
    expect(mapB.get('constructor')).toBe('ctor_ok');
    expect(mapB.get('toString')).toBe('tostr_ok');
    expect(mapB.get('hasOwnProperty')).toBe('hop_ok');
  });

  it('M-018: Cold-restarted peer (DEK-only, no password in RAM) treats peer keyEpoch rotation as DECRYPT_ERROR rather than corrupted_file', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Edge-A');
    const devB = await h.createDevice('Chrome-B');

    devA.browser.seedCookie({ domain: '.rot.io', name: 'sid', value: 'v1' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Edge-A',
      settingsPatch: { syncScopeMode: 'managed_only' },
      initialManagedSiteKeys: ['rot.io'],
    });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Chrome-B',
    });

    // Simulate cold MV3 SW restart on devB (loaded from persisted DEK keyring, NO plaintext password in RAM)
    await devB.restartEngine();
    expect((await devB.engine.getStatusSummary()).locked).toBe(false);

    // Peer A rotates master password (keyEpoch 1 -> 2) and writes a new cookie
    await devA.engine.rotateSpacePassword(ENC_PASS, 'New-Rotated-Master-2026!');
    await devA.engine.upsertCookie('rot.io', {
      domain: '.rot.io',
      name: 'epoch2_tok',
      value: 'v2_rotated',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
      session: true,
      hostOnly: false,
    });
    await devA.engine.syncNow();

    // Cold-restarted devB syncs -> MUST enter DECRYPT_ERROR and NOT misclassify as corrupted_file!
    await devB.engine.syncNow();
    const stB = await devB.engine.getStatusSummary();
    expect(stB.status).toBe('DECRYPT_ERROR');
    expect(stB.attentionItems.some((a) => a.kind === 'corrupted_file')).toBe(false);

    // Unlocking with the new rotated password cleanly syncs epoch2_tok & returns to SYNCED
    await devB.engine.unlockSession('New-Rotated-Master-2026!');
    await devB.engine.syncNow();
    expect(devB.browser.findJarCookie('epoch2_tok', 'rot.io')?.value).toBe('v2_rotated');
    expect((await devB.engine.getStatusSummary()).status).toBe('SYNCED');
  });

  it('M-019: Transient network error during peer pull is NOT misclassified as corrupted_file', async () => {
    const { dav, webdav, harness: h } = setup();
    const devA = await h.createDevice('Edge-A');
    const devB = await h.createDevice('Chrome-B');

    devA.browser.seedCookie({ domain: '.netblip.io', name: 'sid', value: 'v1' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Edge-A',
      settingsPatch: { syncScopeMode: 'managed_only' },
      initialManagedSiteKeys: ['netblip.io'],
    });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Chrome-B',
    });

    await devA.engine.upsertCookie('netblip.io', {
      domain: '.netblip.io',
      name: 'sid',
      value: 'v2',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
      session: true,
      hostOnly: false,
    });
    await devA.engine.syncNow();

    // Inject network offline error mid-sync on B -> must NOT mark A's manifest/events as corrupted_file!
    dav.quirks.offline = true;
    await devB.engine.syncNow();
    const stOffline = await devB.engine.getStatusSummary();
    expect(stOffline.attentionItems.some((a) => a.kind === 'corrupted_file')).toBe(false);

    // Recover online -> syncs cleanly to v2 with 0 attention items
    dav.quirks.offline = false;
    await devB.engine.syncNow();
    expect(devB.browser.findJarCookie('sid', 'netblip.io')?.value).toBe('v2');
    expect((await devB.engine.getStatusSummary()).attentionItems).toEqual([]);
  });

  it('M-020: importCookiesJson batches all imported cookies into a single WebDAV event batch upload', async () => {
    const { dav, webdav, harness: h } = setup();
    const devA = await h.createDevice('Edge-A');
    const devB = await h.createDevice('Chrome-B');

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Edge-A',
      settingsPatch: { syncScopeMode: 'managed_only' },
    });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Chrome-B',
    });

    const countBatches = () =>
      dav.listAllStoredPaths().filter((p) => p.includes('/events/') && p.endsWith('.enc')).length;
    const beforeBatches = countBatches();

    const imported = Array.from({ length: 25 }, (_, i) => ({
      domain: '.batchimp.io',
      name: `c_${i}`,
      value: `v_${i}`,
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax' as const,
      session: true,
      hostOnly: false,
    }));
    const n = await devA.engine.importCookiesJson(imported, 'batchimp.io');
    expect(n).toBe(25);

    // Must have created ONLY 1 batched event file (not 25 separate PUTs!)
    expect(countBatches() - beforeBatches).toBe(1);

    await devB.engine.syncNow();
    expect(devB.browser.findJarCookie('c_0', 'batchimp.io')?.value).toBe('v_0');
    expect(devB.browser.findJarCookie('c_24', 'batchimp.io')?.value).toBe('v_24');
  });

  it('M-021: manifestDirty recovers cleanly when devices/<id>.enc fails with HTTP 423 Locked after event batch PUT succeeded', async () => {
    const { dav, webdav, harness: h } = setup();
    const devA = await h.createDevice('Edge-A');
    const devB = await h.createDevice('Chrome-B');

    devA.browser.seedCookie({ domain: '.lock423.io', name: 'sid', value: 'v1' });
    const joinA = await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Edge-A',
      settingsPatch: { syncScopeMode: 'managed_only' },
      initialManagedSiteKeys: ['lock423.io'],
    });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Chrome-B',
    });
    expect(devB.browser.findJarCookie('sid', 'lock423.io')?.value).toBe('v1');

    // Lock ONLY devA's device manifest path (`devices/<devA>.enc`) -> event batch PUT succeeds while manifest PUT gets 423!
    const devAManifestPath = dav
      .listAllStoredPaths()
      .find((p) => p.endsWith(`/devices/${joinA.deviceId}.enc`));
    expect(devAManifestPath).toBeDefined();
    dav.quirks.lockedPaths = new Set([devAManifestPath!]);

    await devA.browser.simulateUserCookieSet({
      domain: '.lock423.io',
      name: 'sid',
      value: 'v2_after_423',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
      session: true,
      hostOnly: false,
    });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow(); // event batch uploaded, manifest PUT hit 423 -> manifestDirty=true!

    // Release 423 lock -> next syncNow MUST republish dirty manifest even though pendingOutboundEvents is empty!
    dav.quirks.lockedPaths.clear();
    await devA.engine.syncNow();
    await devB.engine.syncNow();

    expect(devB.browser.findJarCookie('sid', 'lock423.io')?.value).toBe('v2_after_423');
    expect((await devB.engine.getStatusSummary()).attentionItems).toEqual([]);
  });

  it('M-022: Pending outbound queue compacts duplicate objectId edits and chunks large uploads into <=60-event batches without raising pending_upload alarms', async () => {
    const { dav, webdav, harness: h } = setup();
    const devA = await h.createDevice('Edge-A');
    const devB = await h.createDevice('Chrome-B');

    devA.browser.seedCookie({ domain: '.compact.io', name: 'k1', value: 'init1' });
    devA.browser.seedCookie({ domain: '.compact.io', name: 'k2', value: 'init2' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Edge-A',
      settingsPatch: { syncScopeMode: 'managed_only' },
      initialManagedSiteKeys: ['compact.io'],
    });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Chrome-B',
    });

    // Go offline and generate 100 rapid updates across just 2 cookies -> MUST compact down to 2 pending events!
    dav.quirks.offline = true;
    for (let i = 1; i <= 50; i += 1) {
      await devA.browser.simulateUserCookieSet({
        domain: '.compact.io',
        name: 'k1',
        value: `v1_${i}`,
      });
      await devA.browser.simulateUserCookieSet({
        domain: '.compact.io',
        name: 'k2',
        value: `v2_${i}`,
      });
    }
    await devA.engine.flushPendingLocalChanges();

    const stOffline = await devA.engine.getStatusSummary();
    expect(stOffline.pendingUploads).toBe(2);
    // Routine pending uploads and 1st transient offline blip must NOT spam attentionItems!
    expect(stOffline.attentionItems).toEqual([]);

    // Come back online -> scheduled flush auto-drains the 2 compacted events in 1 batch
    dav.quirks.offline = false;
    await devA.engine.flushPendingLocalChanges();
    expect((await devA.engine.getStatusSummary()).pendingUploads).toBe(0);

    await devB.engine.syncNow();
    expect(devB.browser.findJarCookie('k1', 'compact.io')?.value).toBe('v1_50');
    expect(devB.browser.findJarCookie('k2', 'compact.io')?.value).toBe('v2_50');

    // Now import 130 distinct cookies -> MUST chunk cleanly into 3 batches (60 + 60 + 10)
    const countBatches = () =>
      dav.listAllStoredPaths().filter((p) => p.includes('/events/') && p.endsWith('.enc')).length;
    const beforeBatches = countBatches();

    const bulk = Array.from({ length: 130 }, (_, i) => ({
      domain: '.chunked.io',
      name: `bulk_${i}`,
      value: `val_${i}`,
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax' as const,
      session: true,
      hostOnly: false,
    }));
    const importedCount = await devA.engine.importCookiesJson(bulk, 'chunked.io');
    expect(importedCount).toBe(130);
    expect(countBatches() - beforeBatches).toBe(3);

    await devB.engine.syncNow();
    expect(devB.browser.findJarCookie('bulk_0', 'chunked.io')?.value).toBe('val_0');
    expect(devB.browser.findJarCookie('bulk_129', 'chunked.io')?.value).toBe('val_129');
  });

  it(
    'M-023: Transient HTTP 503s stay silent for first 2 retries with exponential backoff, surface 1 calm dismissible warning at threshold 3, report errorMessage on manual syncNow, and auto-drain on scheduled flush after recovery',
    async () => {
      const dav = new MockWebDAVServer({
        requireAuth: { username: 'alice', password: 'managed-password-123' },
      });
      let inject503 = false;
      let putCount = 0;
      const wrappedFetch: typeof fetch = async (input, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'PUT') {
          putCount += 1;
          if (inject503) {
            return new Response('Service Temporarily Unavailable', { status: 503 });
          }
        }
        return dav.fetchImpl(input, init);
      };

      const webdav = createBaseConfig();
      harness = new MultiDeviceHarness({
        webdav,
        fetchImpl: wrappedFetch,
        debounceMs: 0,
        refreshCoalesceMs: 0,
        pbkdf2Iterations: 1000,
      });

      let clockMs = 1_700_000_000_000;
      const devA = await harness.createDevice(
        'Edge-A',
        { fixedNowMs: clockMs },
        { autoPushCooldownMs: 12_000, transientErrorAlertThreshold: 3 },
      );
      const devB = await harness.createDevice('Chrome-B');

      devA.browser.seedCookie({ domain: '.backoff503.io', name: 'sid', value: 'v1' });
      await devA.engine.saveAndJoinSpace({
        webdav,
        spaceId: SPACE_ID,
        spaceName: SPACE_NAME,
        encryptionPassword: ENC_PASS,
        deviceName: 'Edge-A',
        settingsPatch: { syncScopeMode: 'managed_only' },
        initialManagedSiteKeys: ['backoff503.io'],
      });
      await devB.engine.saveAndJoinSpace({
        webdav,
        spaceId: SPACE_ID,
        spaceName: SPACE_NAME,
        encryptionPassword: ENC_PASS,
        deviceName: 'Chrome-B',
      });
      expect(devB.browser.findJarCookie('sid', 'backoff503.io')?.value).toBe('v1');

      // Advance past initial cooldown and inject HTTP 503 on PUT
      clockMs += 20_000;
      devA.browser.setFixedNow(clockMs);
      inject503 = true;

      // Failure #1 -> silent (0 attentionItems) + 15s backoff scheduled
      await devA.browser.simulateUserCookieSet({
        domain: '.backoff503.io',
        name: 'sid',
        value: 'v2_503',
      });
      await devA.engine.flushPendingLocalChanges();

      let stA = await devA.engine.getStatusSummary();
      expect(stA.pendingUploads).toBe(1);
      expect(stA.attentionItems).toEqual([]);
      expect(devA.engine.getNextAutoPushDelayMs()).toBe(15_000);

      // Inside backoff window (+5s): another edit compacts into the same 1 queued event and makes ZERO WebDAV PUTs!
      const putsBeforeBackoffEdit = putCount;
      clockMs += 5_000;
      devA.browser.setFixedNow(clockMs);
      await devA.browser.simulateUserCookieSet({
        domain: '.backoff503.io',
        name: 'sid',
        value: 'v3_compacted',
      });
      await devA.engine.flushPendingLocalChanges();
      expect(putCount).toBe(putsBeforeBackoffEdit);
      expect((await devA.engine.getStatusSummary()).pendingUploads).toBe(1);

      // Failure #2 (after 15s backoff expires) -> STILL silent (0 attentionItems), backoff doubles to 30s
      clockMs += 11_000;
      devA.browser.setFixedNow(clockMs);
      await devA.engine.flushPendingLocalChanges();
      stA = await devA.engine.getStatusSummary();
      expect(stA.attentionItems).toEqual([]);
      expect(devA.engine.getNextAutoPushDelayMs()).toBe(30_000);

      // Failure #3 (after 30s backoff expires) -> surfaces ONE calm amber dismissible warning (never red error or pending_upload)
      clockMs += 31_000;
      devA.browser.setFixedNow(clockMs);
      await devA.engine.flushPendingLocalChanges();
      stA = await devA.engine.getStatusSummary();
      expect(stA.attentionItems).toHaveLength(1);
      expect(stA.attentionItems[0].kind).toBe('latest_error');
      expect(stA.attentionItems[0].severity).toBe('warning');
      expect(stA.attentionItems[0].dismissible).toBe(true);
      expect(stA.attentionItems.some((i) => i.kind === 'pending_upload')).toBe(false);

      // Dismissing latest_error MUST clear attentionItems cleanly without spawning a zombie retry_tasks card!
      await devA.engine.dismissAttentionItem('latest_error');
      expect((await devA.engine.getStatusSummary()).attentionItems).toEqual([]);

      // Manual syncNow while still 503 MUST report errorMessage so UI doesn't display fake green success
      const failedManualRes = await devA.engine.syncNow();
      expect(failedManualRes.pushedEvents).toBe(0);
      expect(failedManualRes.errorMessage).toBeTruthy();

      // Server recovers -> scheduled flushPendingLocalChanges() (ALARM_FLUSH) auto-drains without manual syncNow!
      inject503 = false;
      clockMs += 125_000;
      devA.browser.setFixedNow(clockMs);
      await devA.engine.flushPendingLocalChanges();

      stA = await devA.engine.getStatusSummary();
      expect(stA.pendingUploads).toBe(0);
      expect(stA.status).toBe('SYNCED');
      expect(stA.attentionItems).toEqual([]);
      expect(devA.engine.getNextAutoPushDelayMs()).toBeNull();

      await devB.engine.syncNow();
      expect(devB.browser.findJarCookie('sid', 'backoff503.io')?.value).toBe('v3_compacted');
    },
    15_000,
  );

  it('M-024: syncTimingMode="on_page_leave" holds compacted changes quietly while tab is open and uploads once when tab closes/leaves', async () => {
    const { dav, webdav, harness: h } = setup();
    const devA = await h.createDevice(
      'Edge-A',
      undefined,
      { defaultSyncTimingMode: 'on_page_leave' },
    );
    const devB = await h.createDevice('Chrome-B');

    devA.browser.seedCookie({ domain: '.noisy-gh.io', name: '_gh_sess', value: 'init' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Edge-A',
      settingsPatch: { syncScopeMode: 'managed_only', syncTimingMode: 'on_page_leave' },
      initialManagedSiteKeys: ['noisy-gh.io'],
    });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Chrome-B',
    });

    const countEventBatches = () =>
      dav.listAllStoredPaths().filter((p) => p.includes('/events/') && p.endsWith('.enc')).length;
    const batchesBeforeBrowse = countEventBatches();

    // User opens noisy-gh.io and browses while site rotates cookies + LocalStorage repeatedly
    const tabId = devA.browser.openTab('https://noisy-gh.io/pulls', { active: true });
    for (let i = 1; i <= 20; i += 1) {
      await devA.browser.simulateUserCookieSet({
        domain: '.noisy-gh.io',
        name: '_gh_sess',
        value: `sess_${i}`,
      });
      await devA.engine.ingestLocalStorageMutations('https://noisy-gh.io', [
        { key: 'last_seen_ts', value: String(1000 + i) },
      ]);
    }
    await devA.engine.flushPendingLocalChanges();

    // While tab stays open: ZERO WebDAV event batches uploaded, queue compacted to 2 items, 0 alarms!
    expect(countEventBatches()).toBe(batchesBeforeBrowse);
    const stBrowsing = await devA.engine.getStatusSummary();
    expect(stBrowsing.pendingUploads).toBe(2);
    expect(stBrowsing.attentionItems).toEqual([]);
    expect(devA.engine.getNextAutoPushDelayMs()).toBeNull();

    // User closes the tab -> onSitePageLeft uploads 1 single compacted batch automatically!
    devA.browser.closeTab(tabId);
    await devA.engine.onSitePageLeft('https://noisy-gh.io/pulls');

    expect(countEventBatches()).toBe(batchesBeforeBrowse + 1);
    expect((await devA.engine.getStatusSummary()).pendingUploads).toBe(0);

    await devB.engine.syncNow({ triggerRefresh: false });
    expect(devB.browser.findJarCookie('_gh_sess', 'noisy-gh.io')?.value).toBe('sess_20');
    const lsB = await devB.engine.getLocalStorageRecords({ siteKey: 'noisy-gh.io' });
    expect(lsB.find((r) => r.key === 'last_seen_ts')?.value).toBe('1020');
  });

  it('M-025: Anti-reload-loop shields prevent LocalStorage reloads, site-visit/background-poll reloads, passive-viewing alarm spam, and post-reload Set-Cookie ping-pong', async () => {
    const { dav, webdav, harness: h } = setup();
    let clockMs = 1_700_100_000_000;
    const devA = await h.createDevice('Edge-A', { fixedNowMs: clockMs });
    const devB = await h.createDevice(
      'Chrome-B',
      { fixedNowMs: clockMs },
      { maxReloadsPerWindow: 1, reloadWindowMs: 120_000 },
    );

    devA.browser.seedCookie({ domain: '.noloop.io', name: 'sid', value: 'v1' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Edge-A',
      settingsPatch: { syncScopeMode: 'managed_only', autoRefresh: true, refreshProtection: true },
      initialManagedSiteKeys: ['noloop.io'],
    });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Chrome-B',
    });

    const tabB = devB.browser.openTab('https://noloop.io/feed', { active: true, safeToReload: true });
    devB.browser.resetReloadHistory();

    // 1. LocalStorage-only update from A MUST NOT reload B even with autoRefresh=true!
    devB.browser.openOrigin('https://noloop.io');
    devB.browser.seedLocalStorage('https://noloop.io', { theme: 'light' });
    await devA.engine.ingestLocalStorageMutations('https://noloop.io', [
      { key: 'telemetry_tick', value: '99999' },
    ]);
    await devA.engine.syncNow();
    await devB.engine.syncNow();
    expect(devB.browser.reloadedTabIds).toEqual([]);

    // 2. Background poll (`triggerRefresh: false`) and `onSiteVisited()` MUST apply cookies silently with 0 reloads!
    await devA.browser.simulateUserCookieSet({ domain: '.noloop.io', name: 'sid', value: 'v2_bg' });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();

    await devB.engine.onSiteVisited('https://noloop.io/feed');
    expect(devB.browser.findJarCookie('sid', 'noloop.io')?.value).toBe('v2_bg');
    expect(devB.browser.reloadedTabIds).toEqual([]);

    // 3. Passive user viewing/media playback skips reload silently WITHOUT lighting up deferred_reload alarm!
    devB.browser.setTabSafeToReload(tabB, false, ['user_actively_viewing']);
    await devA.browser.simulateUserCookieSet({ domain: '.noloop.io', name: 'sid', value: 'v3_viewing' });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();
    await devB.engine.syncNow();
    expect(devB.browser.reloadedTabIds).toEqual([]);
    expect((await devB.engine.getStatusSummary()).attentionItems).toEqual([]);

    // 4. When manual syncNow DOES reload tabB, server's reload-induced Set-Cookie within 12s MUST NOT immediately ping-pong back to WebDAV!
    devB.browser.setTabSafeToReload(tabB, true, []);
    await devA.browser.simulateUserCookieSet({ domain: '.noloop.io', name: 'sid', value: 'v4_manual' });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();

    const countBatches = () =>
      dav.listAllStoredPaths().filter((p) => p.includes('/events/') && p.endsWith('.enc')).length;

    await devB.engine.syncNow();
    expect(devB.browser.reloadedTabIds).toEqual([tabB]);

    const batchesRightAfterReload = countBatches();
    // Simulate server rotating Set-Cookie 2 seconds after reload on B
    clockMs += 2_000;
    devB.browser.setFixedNow(clockMs);
    await devB.browser.simulateUserCookieSet({
      domain: '.noloop.io',
      name: 'sid',
      value: 'v4_reload_echo',
    });
    await devB.engine.flushPendingLocalChanges();
    // Shielded during 12s post-reload window -> ZERO immediate WebDAV bounce!
    expect(countBatches()).toBe(batchesRightAfterReload);
  });

  it('M-026: Oversized >256KB LocalStorage SPA blobs are skipped, medium LS batches chunk by byte size (<=384KB), and multi-tab onSiteVisited applies all sibling sites in one pull', async () => {
    const { dav, webdav, harness: h } = setup();
    const devA = await h.createDevice('Edge-A');
    const devB = await h.createDevice('Chrome-B', undefined, { autoPushCooldownMs: 12_000 });

    devA.browser.seedCookie({ domain: '.site1.io', name: 'sid1', value: 'v1' });
    devA.browser.seedCookie({ domain: '.site2.io', name: 'sid2', value: 'v1' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Edge-A',
      settingsPatch: { syncScopeMode: 'managed_only' },
      initialManagedSiteKeys: ['site1.io', 'site2.io'],
    });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Chrome-B',
    });

    // 1. Giant 400KB LocalStorage cache blob MUST be skipped while normal auth token syncs cleanly!
    await devA.engine.ingestLocalStorageMutations('https://site1.io', [
      { key: 'giant_spa_cache', value: 'X'.repeat(400 * 1024) },
      { key: 'auth_jwt', value: 'jwt_real_token_123' },
    ]);
    await devA.engine.syncNow();
    await devB.engine.syncNow();
    const lsB = await devB.engine.getLocalStorageRecords({ siteKey: 'site1.io' });
    expect(lsB.find((r) => r.key === 'giant_spa_cache')).toBeUndefined();
    expect(lsB.find((r) => r.key === 'auth_jwt')?.value).toBe('jwt_real_token_123');

    // 2. Five 100KB medium LS values (500KB total) MUST split into >=2 byte-bounded batches (<=384KB each)
    const countBatches = () =>
      dav.listAllStoredPaths().filter((p) => p.includes('/events/') && p.endsWith('.enc')).length;
    const beforeBytesBatches = countBatches();
    await devA.engine.ingestLocalStorageMutations(
      'https://site1.io',
      Array.from({ length: 5 }, (_, i) => ({ key: `med_${i}`, value: 'M'.repeat(100 * 1024) })),
    );
    await devA.engine.syncNow();
    expect(countBatches() - beforeBytesBatches).toBeGreaterThanOrEqual(2);

    // 3. Multi-tab session restore: A updates BOTH site1.io and site2.io; B visits site1.io then immediately site2.io
    await devA.browser.simulateUserCookieSet({ domain: '.site1.io', name: 'sid1', value: 'v2_multi' });
    await devA.browser.simulateUserCookieSet({ domain: '.site2.io', name: 'sid2', value: 'v2_multi' });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();

    await devB.engine.onSiteVisited('https://site1.io/home');
    await devB.engine.onSiteVisited('https://site2.io/home');
    // BOTH sibling sites MUST have been applied even though the 2nd onSiteVisited hit the 5s pull throttle!
    expect(devB.browser.findJarCookie('sid1', 'site1.io')?.value).toBe('v2_multi');
    expect(devB.browser.findJarCookie('sid2', 'site2.io')?.value).toBe('v2_multi');
  });

  it('M-027: ChangeDetector maxWaitMs prevents trailing-debounce starvation under continuous cookie churn', async () => {
    const { harness: h } = setup();
    const devA = await h.createDevice('Edge-A');
    const flushedBatches: number[] = [];
    const detector = new ChangeDetector({
      browser: devA.browser,
      echoSuppressor: new EchoSuppressor(),
      debounceMs: 150,
      maxWaitMs: 260,
      onFlushedChanges: async (changes) => {
        flushedBatches.push(changes.length);
      },
    });

    // Spam a cookie change every 40ms for 400ms (always shorter than debounceMs=150ms!)
    for (let i = 0; i < 10; i += 1) {
      detector.handleCookieChange({
        removed: false,
        cause: 'explicit',
        cookie: {
          domain: '.busy.io',
          name: `c_${i}`,
          value: `v_${i}`,
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'lax',
          session: true,
          hostOnly: false,
        },
      });
      await new Promise((r) => setTimeout(r, 40));
    }

    // Without maxWaitMs, flush() would NEVER have fired during the 400ms stream!
    expect(flushedBatches.length).toBeGreaterThanOrEqual(1);
    detector.dispose();
  });

  it('M-028: reconcileLocalManagedCookies recovers a cookie changed right before abrupt browser exit without overwriting untouched peer updates', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Edge-A');
    const devB = await h.createDevice('Chrome-B');

    devA.browser.seedCookie({ domain: '.crashrec.io', name: 'sid', value: 'v1_synced' });
    devA.browser.seedCookie({ domain: '.peerwin.io', name: 'tok', value: 'p1_synced' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Edge-A',
      settingsPatch: { syncScopeMode: 'managed_only' },
      initialManagedSiteKeys: ['crashrec.io', 'peerwin.io'],
    });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Chrome-B',
    });

    // Simulate Device B updating peerwin.io overnight while Device A is offline/restarting
    await devB.browser.simulateUserCookieSet({ domain: '.peerwin.io', name: 'tok', value: 'p2_from_B' });
    await devB.engine.flushPendingLocalChanges();
    await devB.engine.syncNow();

    // Simulate Device A writing crashrec.io's cookie directly to jar right before abrupt browser crash (never flushed to SyncEngine!)
    devA.browser.seedCookie({ domain: '.crashrec.io', name: 'sid', value: 'v2_before_crash' });
    await devA.restartEngine();

    const recovered = await devA.engine.reconcileLocalManagedCookies();
    expect(recovered).toBe(1); // ONLY crashrec.io recovered; peerwin.io untouched!

    await devA.engine.syncNow();
    await devB.engine.syncNow();
    // Device B gets A's recovered pre-crash login, AND Device A gets B's overnight update!
    expect(devB.browser.findJarCookie('sid', 'crashrec.io')?.value).toBe('v2_before_crash');
    expect(devA.browser.findJarCookie('tok', 'peerwin.io')?.value).toBe('p2_from_B');
  });

  it('M-029: onSiteVisited discovers a brand-new site added on Peer A immediately on first visit on Peer B, while keeping unmanaged sites untouched, and listRemoteDir excludes self-entry', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Edge-A');
    const devB = await h.createDevice('Chrome-B');

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Edge-A',
      settingsPatch: { syncScopeMode: 'managed_only' },
    });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Chrome-B',
    });

    // Edge-A later adds a brand-new site via Popup ("纳入同步管理") and uploads login
    devA.browser.seedCookie({ domain: '.freshsite.io', name: 'sid', value: 'fresh_alice' });
    await devA.engine.addManagedSites(['freshsite.io']);

    // Without running manual syncNow() on B first, user opens freshsite.io on Chrome-B -> MUST auto-discover & apply!
    await devB.engine.onSiteVisited('https://app.freshsite.io/home');
    expect(devB.browser.findJarCookie('sid', 'freshsite.io')?.value).toBe('fresh_alice');

    // Visiting a truly unmanaged site on B MUST keep it unmanaged (never uploaded or added to sites overview)
    devB.browser.seedCookie({ domain: '.random-unmanaged.io', name: 'x', value: 'local_only' });
    await devB.engine.onSiteVisited('https://random-unmanaged.io/');
    const sitesB = await devB.engine.getSitesOverview();
    expect(sitesB.some((s) => s.siteKey === 'random-unmanaged.io')).toBe(false);

    // listRemoteDir('') must exclude the space self-folder (sp_xxx)
    const rootEntries = await devA.engine.listRemoteDir('');
    expect(rootEntries.some((e) => e.name.startsWith('sp_'))).toBe(false);
    expect(rootEntries.some((e) => e.name === 'metadata')).toBe(true);
  });

  it('M-030: createSpace with managed_only settingsPatch creates a 100% isolated empty space without leaking existing browser cookies', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Edge-A');

    devA.browser.seedCookie({ domain: '.personal.io', name: 'sid', value: 'personal_secret' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Edge-A',
      settingsPatch: { syncScopeMode: 'managed_only' },
      initialManagedSiteKeys: ['personal.io'],
    });

    const workReport = await devA.engine.createSpace('work-isolated', '工作隔离空间', 'WorkPass-2026!', {
      syncScopeMode: 'managed_only',
      syncTimingMode: 'on_page_leave',
      autoRefresh: false,
    });
    expect(workReport.isNewSpace).toBe(true);
    expect(workReport.localUploadedSites).toEqual([]);
    const workSites = await devA.engine.getSitesOverview();
    expect(workSites.some((s) => s.siteKey === 'personal.io')).toBe(false);
    const workSettings = await devA.engine.getSpaceSettings();
    expect(workSettings.syncScopeMode).toBe('managed_only');
    expect(workSettings.syncTimingMode).toBe('on_page_leave');
    expect(workSettings.autoRefresh).toBe(false);
  });

  it('M-031: EchoSuppressor suppresses in-flight explicit remove followed immediately by set on same cookie, and applyUndoPoint never leaks rollback deletion onto prior track', async () => {
    const sup = new EchoSuppressor();
    const now = 1_700_000_000_000;
    const cookieOld: BrowserCookieInput = {
      domain: 'overlap.io',
      name: 'acct_sid',
      value: 'edge_work',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      session: false,
      hostOnly: true,
    };
    const cookieRestored: BrowserCookieInput = { ...cookieOld, value: 'chrome_personal' };
    const hashOld = 'hash_old';
    const hashRestored = 'hash_restored';

    // Register remove then immediately register set BEFORE async remove IPC arrives
    sup.registerCookieMutation(cookieOld, 'remove', hashOld, now);
    sup.registerCookieMutation(cookieRestored, 'set', hashRestored, now + 2);

    // Delayed remove IPC arrives -> MUST be suppressed!
    expect(
      sup.shouldSuppressCookieEvent({ removed: true, cause: 'explicit', cookie: cookieOld }, hashOld, now + 10),
    ).toBe(true);
    // Followed by set IPC -> MUST ALSO be suppressed!
    expect(
      sup.shouldSuppressCookieEvent(
        { removed: false, cause: 'explicit', cookie: cookieRestored },
        hashRestored,
        now + 15,
      ),
    ).toBe(true);
  });

  it('M-032: Deleting a cookie while a prior upsert is still buffered in ChangeDetector never resurrects the tombstone on flush/syncNow', async () => {
    const dav = new MockWebDAVServer({
      requireAuth: { username: 'alice', password: 'managed-password-123' },
    });
    const webdav = createBaseConfig();
    harness = new MultiDeviceHarness({
      webdav,
      fetchImpl: dav.fetchImpl,
      debounceMs: 5000,
      refreshCoalesceMs: 0,
      pbkdf2Iterations: 1000,
    });
    const devA = await harness.createDevice('Edge-A');
    const devB = await harness.createDevice('Chrome-B');

    // Simulate login firing onCookieChanged right before join (still inside debounce window)
    await devA.browser.setCookie({
      url: 'https://critical.example.com/',
      domain: 'critical.example.com',
      name: 'bank_auth_tok',
      value: 'vip_v1',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      session: false,
      hostOnly: true,
    });

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Edge-A',
      settingsPatch: { syncScopeMode: 'managed_only' },
      initialManagedSiteKeys: ['example.com'],
    });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Chrome-B',
    });

    // Now simulate a live login update STILL inside the 5000ms debounce buffer, followed IMMEDIATELY by explicit all_devices delete!
    await devA.browser.setCookie({
      url: 'https://critical.example.com/',
      domain: 'critical.example.com',
      name: 'bank_auth_tok',
      value: 'vip_v2',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      session: false,
      hostOnly: true,
    });

    const cookiesBefore = await devA.engine.getSiteCookies('example.com');
    const target = cookiesBefore.find((c) => c.name === 'bank_auth_tok' && !c.deleted);
    expect(target).toBeTruthy();

    await devA.engine.deleteCookies([target!.logicalId], 'all_devices', 'example.com');
    await devA.engine.syncNow({ triggerRefresh: false });
    await devB.engine.syncNow({ triggerRefresh: false });

    // Deleted cookie MUST stay deleted on BOTH devices — never resurrected by stale buffered upsert!
    expect(devA.browser.findJarCookie('bank_auth_tok', 'critical.example.com')).toBeUndefined();
    expect(devB.browser.findJarCookie('bank_auth_tok', 'critical.example.com')).toBeUndefined();
    expect((await devA.engine.getSiteCookies('example.com')).filter((c) => !c.deleted)).toEqual([]);
    expect((await devB.engine.getSiteCookies('example.com')).filter((c) => !c.deleted)).toEqual([]);

    // Genuine re-login AFTER delete must still sync cleanly to both devices!
    await devA.browser.setCookie({
      url: 'https://critical.example.com/',
      domain: 'critical.example.com',
      name: 'bank_auth_tok',
      value: 'vip_relogin_v3',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      session: false,
      hostOnly: true,
    });
    await devA.engine.syncNow({ triggerRefresh: false });
    await devB.engine.syncNow({ triggerRefresh: false });
    expect(devB.browser.findJarCookie('bank_auth_tok', 'critical.example.com')?.value).toBe('vip_relogin_v3');
  });

  it('M-033: storeId="default" is never passed to browser.setCookie and deleting active space never re-persists deleted space data', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Edge-A');

    // 1. Verify applyCookieWithVerification strips storeId: 'default'
    let capturedStoreId: string | undefined = 'UNSET';
    const spyBrowser: BrowserApiAdapter = {
      ...devA.browser,
      setCookie: async (details) => {
        capturedStoreId = details.storeId;
        return devA.browser.setCookie(details);
      },
      getCookie: (d) => devA.browser.getCookie(d),
      getAllCookies: (f) => devA.browser.getAllCookies(f),
      removeCookie: (d) => devA.browser.removeCookie(d),
      onCookieChanged: (l) => devA.browser.onCookieChanged(l),
      getLocalStorage: (o) => devA.browser.getLocalStorage(o),
      applyLocalStorage: (o, m) => devA.browser.applyLocalStorage(o, m),
      queryTabs: (f) => devA.browser.queryTabs(f),
      reloadTab: (id) => devA.browser.reloadTab(id),
      checkTabSafeToReload: (id) => devA.browser.checkTabSafeToReload(id),
      getDevicePlatformInfo: () => devA.browser.getDevicePlatformInfo(),
    };
    const res = await applyCookieWithVerification(
      spyBrowser,
      {
        domain: 'app.example.com',
        name: 'manual_tok',
        value: 'abc123',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'lax',
        session: false,
        expirationDate: Math.floor(Date.now() / 1000) + 3600,
        hostOnly: true,
        storeId: 'default',
        partitionKey: null,
      },
      Date.now(),
    );
    expect(res.accepted).toBe(true);
    expect(capturedStoreId).toBeUndefined();

    // 2. Verify deleting active space when a second space exists does NOT re-persist deleted space back into storage
    devA.browser.seedCookie({ domain: '.alpha.io', name: 'secret_a', value: 'only_in_a' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: 'space-a',
      spaceName: 'Space A',
      encryptionPassword: ENC_PASS,
      deviceName: 'Edge-A',
      settingsPatch: { syncScopeMode: 'managed_only' },
      initialManagedSiteKeys: ['alpha.io'],
    });
    await devA.engine.createSpace('space-b', 'Space B', 'SecondSpacePass!', {
      syncScopeMode: 'managed_only',
      syncTimingMode: 'on_page_leave',
      autoRefresh: false,
    });
    // Switch back to space-a, then delete active space-a while space-b remains
    await devA.engine.switchSpace('space-a');
    await devA.engine.deleteLocalSpace('space-a', false);

    const statusAfter = await devA.engine.getStatusSummary();
    expect(statusAfter.activeSpaceId).toBe('space-b');
    expect(statusAfter.spaces.map((s) => s.spaceId)).toEqual(['space-b']);
    // Confirm deleted space-a's storage namespace stays completely empty!
    const leftoverMeta = await devA.storage.get('space:space-a', 'meta');
    const leftoverCookies = await devA.storage.get('space:space-a', 'cookies');
    expect(leftoverMeta).toBeUndefined();
    expect(leftoverCookies).toBeUndefined();
  });

  it('M-034: 507 storageFullHalted blocks background retries, while explicit userInitiated syncNow recovers cleanly once space is freed', async () => {
    const { dav, webdav, harness: h } = setup();
    const devA = await h.createDevice('Edge-A');
    const devB = await h.createDevice('Chrome-B');

    devA.browser.seedCookie({ domain: '.quota.io', name: 'sid', value: 'v1' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Edge-A',
      settingsPatch: { syncScopeMode: 'managed_only' },
      initialManagedSiteKeys: ['quota.io'],
    });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Chrome-B',
    });

    // Trigger 507 Storage Full
    dav.quirks.storageQuotaBytes = 10;
    await devA.browser.simulateUserCookieSet({ domain: '.quota.io', name: 'sid', value: 'v2_after_quota' });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow({ triggerRefresh: false });
    expect((await devA.engine.getStatusSummary()).latestError?.code).toBe('ERR_STORAGE_FULL');

    // Free up WebDAV space externally
    dav.quirks.storageQuotaBytes = undefined;

    // Non-user-initiated background sync still respects storageFullHalted (no silent write storm)
    const bgRes = await devA.engine.syncNow({ triggerRefresh: false });
    expect(bgRes.pushedEvents).toBe(0);

    // Explicit user click ("立即同步" -> userInitiated: true) probes recovery & succeeds!
    const manualRes = await devA.engine.syncNow({ triggerRefresh: false, userInitiated: true });
    expect(manualRes.pushedEvents).toBeGreaterThan(0);
    expect((await devA.engine.getStatusSummary()).latestError).toBeNull();

    await devB.engine.syncNow({ triggerRefresh: false });
    expect(devB.browser.findJarCookie('sid', 'quota.io')?.value).toBe('v2_after_quota');
  });

  it('M-035: Deleting one colliding cookie (hostOnly /admin) preserves sibling same-name cookies (hostOnly / and wildcard .domain /) on both devices even under Chromium collateral removeCookie behavior', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Edge-A');
    const devB = await h.createDevice('Chrome-B');

    // Patch both mock browsers so removeCookie({ url, name }) reproduces Chromium's real behavior:
    // deleting EVERY cookie matching (url, name) regardless of hostOnly/domain/path!
    for (const dev of [devA, devB]) {
      const origRemove = dev.browser.removeCookie.bind(dev.browser);
      dev.browser.removeCookie = async (details) => {
        for (let i = 0; i < 10; i++) {
          const hit = await dev.browser.getCookie(details);
          if (!hit) break;
          await origRemove(details);
        }
      };
    }

    devA.browser.seedCookie({ domain: 'sub.collide.io', hostOnly: true, path: '/', name: 'ambig_tok', value: 'host_val', secure: true });
    devA.browser.seedCookie({ domain: '.collide.io', hostOnly: false, path: '/', name: 'ambig_tok', value: 'wild_val', secure: true });
    devA.browser.seedCookie({ domain: 'sub.collide.io', hostOnly: true, path: '/admin', name: 'ambig_tok', value: 'admin_val', secure: true });

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Edge-A',
      settingsPatch: { syncScopeMode: 'managed_only' },
      initialManagedSiteKeys: ['collide.io'],
    });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Chrome-B',
    });

    const cookiesA = await devA.engine.getSiteCookies('collide.io');
    const adminRec = cookiesA.find((c) => c.name === 'ambig_tok' && c.path === '/admin');
    expect(adminRec).toBeTruthy();

    await devA.engine.deleteCookies([adminRec!.logicalId], 'all_devices', 'collide.io');
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow({ triggerRefresh: false });
    await devB.engine.syncNow({ triggerRefresh: false });

    const jarA = (await devA.browser.getAllCookies())
      .filter((c) => c.name === 'ambig_tok')
      .map((c) => `${c.hostOnly ? 'h' : 'w'}:${c.path}:${c.value}`)
      .sort();
    const jarB = (await devB.browser.getAllCookies())
      .filter((c) => c.name === 'ambig_tok')
      .map((c) => `${c.hostOnly ? 'h' : 'w'}:${c.path}:${c.value}`)
      .sort();
    expect(jarA).toEqual(['h:/:host_val', 'w:/:wild_val']);
    expect(jarB).toEqual(['h:/:host_val', 'w:/:wild_val']);
  });

  it('M-036: Chromium default storeId "0" normalizes to "default" so manual upsert never duplicates records on readback/reconcile', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Chrome-Default-Store');
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: 'm036-store-norm',
      spaceName: 'M036 Store Norm',
      encryptionPassword: ENC_PASS,
      deviceName: 'Chrome-Default-Store',
      settingsPatch: {
        syncScopeMode: 'managed_only',
        syncTimingMode: 'realtime',
        autoRefresh: false,
      },
      initialManagedSiteKeys: ['storenorm.dev'],
    });

    // Simulate real Chromium where cookies.set(storeId: undefined) lands in storeId "0"
    await devA.engine.upsertCookie('storenorm.dev', {
      domain: '.storenorm.dev',
      name: 'color_mode',
      value: 'auto_dark',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
      session: false,
      expirationDate: Math.floor(Date.now() / 1000) + 86400,
      hostOnly: false,
    });

    // Simulate Chromium returning the same cookie with storeId: "0" on onChanged & getAllCookies
    await devA.browser.setCookie({
      url: 'https://storenorm.dev/',
      domain: '.storenorm.dev',
      name: 'color_mode',
      value: 'auto_dark',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
      session: false,
      expirationDate: Math.floor(Date.now() / 1000) + 86400,
      hostOnly: false,
      storeId: '0',
    });

    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow({ triggerRefresh: false });

    const records = (await devA.engine.getSiteCookies('storenorm.dev')).filter((c) => !c.deleted);
    expect(records).toHaveLength(1);
    expect(records[0].name).toBe('color_mode');
    expect(records[0].storeScope).toBe('default');
  });

  it('M-037: buildEchoCookieKey normalizes storeId/storeScope so local_only cookie deletion never emits cross-device tombstones on Chromium', async () => {
    // Key parity across CookieRecord (storeScope: 'default') and BrowserCookieInput (storeId: 'default' | '0' | undefined)
    const kScope = buildEchoCookieKey({ domain: '.r.io', path: '/', name: 'ck', storeScope: 'default' });
    const kDefault = buildEchoCookieKey({ domain: '.r.io', path: '/', name: 'ck', storeId: 'default' });
    const kZero = buildEchoCookieKey({ domain: '.r.io', path: '/', name: 'ck', storeId: '0' });
    const kUndef = buildEchoCookieKey({ domain: '.r.io', path: '/', name: 'ck' });
    expect(kScope).toBe(kDefault);
    expect(kDefault).toBe(kZero);
    expect(kZero).toBe(kUndef);

    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Edge-A');
    const devB = await h.createDevice('Chrome-B');

    // Simulate ChromeBrowserAdapter behavior emitting storeId: 'default' on onCookieChanged
    const origOnCookieChanged = devA.browser.onCookieChanged.bind(devA.browser);
    devA.browser.onCookieChanged = (listener) =>
      origOnCookieChanged((evt) =>
        listener({
          ...evt,
          cookie: { ...evt.cookie, storeId: evt.cookie.storeId && evt.cookie.storeId !== '0' ? evt.cookie.storeId : 'default' },
        }),
      );

    await devA.engine.dispose();
    await devA.engine.init();
    devA.browser.seedCookie({ domain: '.localonly.test', name: 'local_drop', value: 'keep_on_b', secure: true });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Edge-A',
      settingsPatch: { syncScopeMode: 'managed_only', syncTimingMode: 'realtime' },
      initialManagedSiteKeys: ['localonly.test'],
    });
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Chrome-B',
    });

    const targetRec = (await devA.engine.getSiteCookies('localonly.test')).find((c) => c.name === 'local_drop')!;
    expect(targetRec).toBeTruthy();

    await devA.engine.deleteCookies([targetRec.logicalId], 'local_only', 'localonly.test');
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow({ triggerRefresh: false });
    await devB.engine.syncNow({ triggerRefresh: false });

    expect(devA.browser.findJarCookie('local_drop', 'localonly.test')).toBeUndefined();
    expect(devB.browser.findJarCookie('local_drop', 'localonly.test')?.value).toBe('keep_on_b');
    const recAfterA = (await devA.engine.getSiteCookies('localonly.test')).find((c) => c.name === 'local_drop');
    expect(recAfterA?.syncStatus).toBe('REMOTE_ONLY');
    expect(recAfterA?.deleted).toBe(false);

    // Regression: offline WebDAV error whose hex deviceId contains substring `aad` must classify as ERR_NETWORK_OFFLINE, never DECRYPT_ERROR
    const hexNetworkErr = toStructuredError(
      new Error(
        'WebDAV putBytes network error (/SessionMesh/v1/spaces/sp_6618/events/dev_17185bf6deaadc59/0000000004_b_bb41.enc): Failed to fetch: MockWebDAVServer is offline',
      ),
      'push',
    );
    expect(hexNetworkErr.code).toBe('ERR_NETWORK_OFFLINE');
    expect(hexNetworkErr.retryable).toBe(true);
  });

  it('M-038: addManagedSites pre-pulls remote tracks before creating a local track so B adopts or surfaces pendingDecisions immediately', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('PrePull-A');
    const devB = await h.createDevice('PrePull-B');

    devA.browser.seedCookie({
      domain: '.prepull-clean.test',
      name: 'sid',
      value: 'A_CLEAN_1',
      secure: true,
    });
    devA.browser.seedCookie({
      domain: '.prepull-clash.test',
      name: 'sid',
      value: 'A_CLASH_1',
      secure: true,
    });

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'PrePull-A',
      settingsPatch: { syncScopeMode: 'managed_only', authorityMode: 'ask' },
      initialManagedSiteKeys: ['prepull-clean.test'],
    });

    // B joins in managed_only mode before prepull-late.test or prepull-clash.test exist in WebDAV
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'PrePull-B',
      settingsPatch: { syncScopeMode: 'managed_only', authorityMode: 'ask' },
    });

    // Simulate A adding two new sites AFTER B already joined (B has not polled yet!)
    devA.browser.seedCookie({
      domain: '.prepull-late.test',
      name: 'sid',
      value: 'A_LATE_99',
      secure: true,
    });
    await devA.engine.addManagedSites(['prepull-late.test', 'prepull-clash.test']);

    // B seeds local cookie on prepull-clash.test and adds BOTH sites on B without calling syncNow() first
    devB.browser.seedCookie({
      domain: '.prepull-clash.test',
      name: 'sid',
      value: 'B_CLASH_2',
      secure: true,
    });

    const resB = await devB.engine.addManagedSites(['prepull-late.test', 'prepull-clash.test']);

    // 1) prepull-late.test (clean on B): auto-pulled A's session without creating a duplicate local track!
    expect(resB.added).toContain('prepull-late.test');
    const bLateCookies = (await devB.browser.getAllCookies())
      .filter((c) => c.domain.includes('prepull-late.test'));
    expect(bLateCookies.map((c) => c.value)).toEqual(['A_LATE_99']);

    const bLateOverview = (await devB.engine.getSitesOverview()).find(
      (s) => s.siteKey === 'prepull-late.test',
    );
    expect(bLateOverview?.allTracks).toHaveLength(1);
    expect(bLateOverview?.binding.trackId).toBe(bLateOverview?.allTracks[0].trackId);

    // 2) prepull-clash.test (overlapping local cookie under ask mode): surfaces pendingDecision instead of creating an unlinked duplicate track
    expect(resB.pendingDecisions.map((d) => d.siteKey)).toContain('prepull-clash.test');
    const bClashOverview = (await devB.engine.getSitesOverview()).find(
      (s) => s.siteKey === 'prepull-clash.test',
    );
    expect(bClashOverview?.allTracks).toHaveLength(1);
    expect(bClashOverview?.binding.state).toBe('PENDING_CHOICE');
  });
});
