import { describe, it, expect, afterEach } from 'vitest';
import { MockWebDAVServer } from '@sessionmesh/webdav-mock';
import {
  envRuleMatchesUrl,
  isDevLikeUrlOrHost,
  mapCookieToTargetEnv,
  parseEnvTarget,
} from '../src/sync/EnvCookieMapper';
import { MultiDeviceHarness } from '../src/sim';
import type { WebDAVConfig } from '../src/types';

function createBaseConfig(): WebDAVConfig {
  return {
    url: 'https://dav.multi-env.test/webdav',
    authType: 'basic',
    username: 'devuser',
    password: 'dev-password-123',
    rootPath: '/mesh',
  };
}

describe('Multi-Account Rotation & Dev/Prod Environment Cookie Sync Suite', () => {
  let harness: MultiDeviceHarness | null = null;

  afterEach(() => {
    harness?.disposeAll();
    harness = null;
  });

  function setup() {
    const dav = new MockWebDAVServer({
      requireAuth: { username: 'devuser', password: 'dev-password-123' },
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

  const SPACE_ID = 'acct-env-space';
  const SPACE_NAME = 'Dev & Multi-Account Space';
  const ENC_PASS = 'master-pass-789!';

  it('MA-001: Creates clean account slots without invalidating previous account cookies, then rotates 1 -> 2 -> 3 -> 1 deterministically', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    // Start logged into Account 1 (Super Admin)
    devA.browser.seedCookie({
      domain: '.console.io',
      name: 'auth_token',
      value: 'tok_admin_1',
      secure: true,
      httpOnly: true,
    });
    devA.browser.seedCookie({
      domain: '.console.io',
      name: 'role_hint',
      value: 'super_admin',
    });

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    const tabId = devA.browser.openTab('https://console.io/dashboard', {
      active: true,
      safeToReload: true,
    });

    // Rename initial track to "超级管理员"
    const initOverview = await devA.engine.getSitesOverview();
    const firstTrack = initOverview.find((s) => s.siteKey === 'console.io')!.activeTrack!;
    await devA.engine.renameSiteTrack('console.io', firstTrack.trackId, '超级管理员');

    // Create Clean Account 2 ("运营账号") -> wipes local jar cleanly while keeping Account 1 intact!
    const track2 = await devA.engine.createSiteAccountTrack('console.io', {
      mode: 'clean_new',
      label: '运营账号',
      triggerRefresh: true,
    });
    expect(track2.label).toBe('运营账号');
    expect(devA.browser.findJarCookie('auth_token', 'console.io')).toBeUndefined();
    expect(devA.browser.findJarCookie('role_hint', 'console.io')).toBeUndefined();
    expect(devA.browser.reloadedTabIds).toContain(tabId);

    // Verify Account 1's cookies were NOT tombstoned in storage!
    const acct1Stored = await devA.engine.getSiteCookies('console.io', firstTrack.trackId);
    expect(acct1Stored.filter((c) => !c.deleted).map((c) => c.value).sort()).toEqual([
      'super_admin',
      'tok_admin_1',
    ]);

    // User logs into Account 2 on the clean page
    await devA.browser.simulateUserCookieSet({
      domain: '.console.io',
      name: 'auth_token',
      value: 'tok_operator_2',
      secure: true,
      httpOnly: true,
    });
    await devA.browser.simulateUserCookieSet({
      domain: '.console.io',
      name: 'operator_Flag',
      value: 'op_only',
    });

    // Create Clean Account 3 ("测试访客") -> captures Account 2 and clears jar again
    const track3 = await devA.engine.createSiteAccountTrack('console.io', {
      mode: 'clean_new',
      label: '测试访客',
      triggerRefresh: true,
    });
    expect(track3.label).toBe('测试访客');
    expect(devA.browser.findJarCookie('auth_token', 'console.io')).toBeUndefined();

    // User logs into Account 3
    await devA.browser.simulateUserCookieSet({
      domain: '.console.io',
      name: 'auth_token',
      value: 'tok_guest_3',
      secure: true,
      httpOnly: true,
    });

    // Currently on Account 3 (#3/3) -> Rotate 1st click -> Account 1 (#1/3)
    const r1 = await devA.engine.rotateSiteTrack('console.io', 'next');
    expect(r1.index).toBe(1);
    expect(r1.total).toBe(3);
    expect(r1.track.label).toBe('超级管理员');
    expect(devA.browser.findJarCookie('auth_token', 'console.io')?.value).toBe('tok_admin_1');
    expect(devA.browser.findJarCookie('role_hint', 'console.io')?.value).toBe('super_admin');
    expect(devA.browser.findJarCookie('operator_Flag', 'console.io')).toBeUndefined();

    // Rotate 2nd click -> Account 2 (#2/3)
    const r2 = await devA.engine.rotateSiteTrack('console.io', 'next');
    expect(r2.index).toBe(2);
    expect(r2.total).toBe(3);
    expect(r2.track.label).toBe('运营账号');
    expect(devA.browser.findJarCookie('auth_token', 'console.io')?.value).toBe('tok_operator_2');
    expect(devA.browser.findJarCookie('operator_Flag', 'console.io')?.value).toBe('op_only');
    expect(devA.browser.findJarCookie('role_hint', 'console.io')).toBeUndefined();

    // Rotate 3rd click -> Account 3 (#3/3)
    const r3 = await devA.engine.rotateSiteTrack('console.io', 'next');
    expect(r3.index).toBe(3);
    expect(r3.total).toBe(3);
    expect(r3.track.label).toBe('测试访客');
    expect(devA.browser.findJarCookie('auth_token', 'console.io')?.value).toBe('tok_guest_3');
    expect(devA.browser.findJarCookie('operator_Flag', 'console.io')).toBeUndefined();
  });

  it('MA-002: Creating clean_new account on an unmanaged site automatically archives existing login as 默认账号 first', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
      settingsPatch: { syncScopeMode: 'managed_only' },
      initialManagedSiteKeys: [],
    });

    // Site was NOT yet managed, but user already logged into main account in browser
    devA.browser.seedCookie({ domain: '.saas.app', name: 'sid', value: 'main_acct_sid' });

    const secondAcct = await devA.engine.createSiteAccountTrack('saas.app', {
      mode: 'clean_new',
      label: '小号 B',
    });

    expect(secondAcct.label).toBe('小号 B');
    expect(devA.browser.findJarCookie('sid', 'saas.app')).toBeUndefined();

    const overview = await devA.engine.getSitesOverview();
    const saasSummary = overview.find((s) => s.siteKey === 'saas.app')!;
    expect(saasSummary.allTracks.map((t) => t.label)).toEqual(['默认账号', '小号 B']);

    // Rotating back restores main_acct_sid!
    const rotated = await devA.engine.rotateSiteTrack('saas.app', 'next');
    expect(rotated.track.label).toBe('默认账号');
    expect(devA.browser.findJarCookie('sid', 'saas.app')?.value).toBe('main_acct_sid');
  });

  it('MA-003: Deleting an active account track switches cleanly to the remaining track and syncs removal to peer devices', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    devA.browser.seedCookie({ domain: '.portal.dev', name: 'uid', value: 'user_1' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    const track2 = await devA.engine.createSiteAccountTrack('portal.dev', {
      mode: 'clean_new',
      label: '临时账号 2',
    });
    await devA.browser.simulateUserCookieSet({
      domain: '.portal.dev',
      name: 'uid',
      value: 'user_2',
    });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();

    // Device B joins and sees 2 tracks
    const joinB = await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-B',
    });
    expect(joinB.pendingDecisions[0]?.remoteTracks).toHaveLength(2);

    // Delete active track2 on Device A -> auto-switches Device A back to user_1
    const delRes = await devA.engine.deleteSiteTrack('portal.dev', track2.trackId);
    expect(delRes.deletedTrackId).toBe(track2.trackId);
    expect(delRes.switchedToTrack).toBeDefined();
    expect(devA.browser.findJarCookie('uid', 'portal.dev')?.value).toBe('user_1');

    // Sync Device B -> removed track disappears on Device B as well
    await devB.engine.syncNow();
    const overviewB = await devB.engine.getSitesOverview();
    expect(overviewB.find((s) => s.siteKey === 'portal.dev')?.allTracks).toHaveLength(1);
  });

  it('ENV-001: Unit-tests EnvCookieMapper domain rewrite & HTTP attribute adaptation for localhost / IP / HTTPS dev domains', () => {
    const localTarget = parseEnvTarget('http://localhost:3000')!;
    expect(localTarget.scheme).toBe('http');
    expect(localTarget.host).toBe('localhost');
    expect(localTarget.port).toBe('3000');
    expect(localTarget.isLocalOrIp).toBe(true);
    expect(isDevLikeUrlOrHost('http://localhost:3000')).toBe(true);
    expect(isDevLikeUrlOrHost('http://127.0.0.1:5173')).toBe(true);
    expect(isDevLikeUrlOrHost('https://github.com')).toBe(false);

    const mappedLocal = mapCookieToTargetEnv(
      {
        domain: '.corp.com',
        name: 'sso_jwt',
        value: 'jwt_xyz',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'no_restriction',
        session: false,
        expirationDate: 2_000_000_000,
        hostOnly: false,
        partitionKey: { topLevelSite: 'https://corp.com' },
      },
      localTarget,
      { adaptForHttp: true },
    );

    expect(mappedLocal.domain).toBe('localhost');
    expect(mappedLocal.hostOnly).toBe(true);
    expect(mappedLocal.secure).toBe(false);
    expect(mappedLocal.sameSite).toBe('lax');
    expect(mappedLocal.httpOnly).toBe(true);
    expect(mappedLocal.partitionKey).toBeNull();

    // Explicit wildcard HTTPS staging domain (.staging.corp.com) preserves wildcard & Secure
    const wildcardHttpsTarget = parseEnvTarget('.staging.corp.com')!;
    expect(wildcardHttpsTarget.scheme).toBe('https');
    expect(wildcardHttpsTarget.explicitWildcardDomain).toBe(true);
    const mappedStaging = mapCookieToTargetEnv(
      {
        domain: '.corp.com',
        name: 'sso_jwt',
        value: 'jwt_xyz',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'no_restriction',
        session: true,
        hostOnly: false,
      },
      wildcardHttpsTarget,
      { adaptForHttp: true },
    );
    expect(mappedStaging.domain).toBe('.staging.corp.com');
    expect(mappedStaging.hostOnly).toBe(false);
    expect(mappedStaging.secure).toBe(true);
    expect(mappedStaging.sameSite).toBe('no_restriction');
  });

  it('ENV-002: Syncs production HTTPS cookies + LocalStorage to http://localhost:3000 even when localhost preset blacklist is active', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    // Seed prod HTTPS cookies (Secure + HttpOnly + SameSite=None + colliding subdomain cookie)
    devA.browser.seedCookie({
      domain: '.acme.com',
      name: 'access_token',
      value: 'root_old_token',
      secure: true,
      httpOnly: true,
      sameSite: 'no_restriction',
    });
    devA.browser.seedCookie({
      domain: 'app.acme.com',
      hostOnly: true,
      name: 'access_token',
      value: 'app_specific_fresh_token',
      secure: true,
      httpOnly: true,
      sameSite: 'no_restriction',
    });
    devA.browser.seedCookie({
      domain: '.acme.com',
      name: 'tenant_id',
      value: 't_888',
      secure: true,
    });
    devA.browser.seedCookie({
      domain: '.acme.com',
      name: '_ga',
      value: 'GA1.1.noise',
    });

    // Open prod and localhost tabs + seed LocalStorage
    devA.browser.openTab('https://app.acme.com/home', { active: false });
    devA.browser.seedLocalStorage('https://app.acme.com', {
      auth_profile: '{"id":42,"role":"admin"}',
      local_debug_keep: 'prod',
    });
    const localTabId = devA.browser.openTab('http://localhost:3000/ workbench', {
      active: true,
      safeToReload: true,
    });
    devA.browser.seedLocalStorage('http://localhost:3000', {
      stale_ls_key: 'old',
      vite_hmr_flag: 'keep_me',
    });
    devA.browser.seedCookie({
      domain: 'localhost',
      hostOnly: true,
      name: 'stale_dev_cookie',
      value: 'remove_me',
      secure: false,
    });

    // Enable localhost preset blacklist (ensuring localhost never uploads to cloud WebDAV, yet local env sync works!)
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
      presetCategories: ['localhost'],
    });

    const rule = await devA.engine.upsertEnvSyncRule({
      name: 'Acme Prod -> Localhost 3000',
      scope: 'device',
      enabled: true,
      sourceSiteKey: 'acme.com',
      targetUrl: 'http://localhost:3000',
      syncCookies: true,
      syncLocalStorage: true,
      adaptForHttp: true,
      cleanTargetBeforeSync: true,
      autoSync: true,
      autoReloadTarget: true,
      excludeCookieNames: ['vite_hmr_flag'],
    });

    expect(envRuleMatchesUrl(rule, 'http://localhost:3000/dashboard')).toBe('target');
    expect(envRuleMatchesUrl(rule, 'https://app.acme.com/settings')).toBe('source');

    const res = await devA.engine.executeEnvCookieSync({ ruleId: rule.id });
    expect(res.appliedCookies).toBe(2);
    expect(res.failedCookies).toBe(0);
    expect(res.removedStaleCookies).toBe(1);
    expect(res.reloadedTabs).toBe(1);
    expect(devA.browser.reloadedTabIds).toContain(localTabId);

    // More specific hostOnly cookie (app.acme.com) beat root (.acme.com) when flattened onto localhost!
    const localTok = await devA.browser.getCookie({
      url: 'http://localhost:3000/',
      name: 'access_token',
    });
    expect(localTok?.value).toBe('app_specific_fresh_token');
    expect(localTok?.secure).toBe(false);
    expect(localTok?.sameSite).toBe('lax');
    expect(localTok?.httpOnly).toBe(true);

    const localTenant = await devA.browser.getCookie({
      url: 'http://localhost:3000/',
      name: 'tenant_id',
    });
    expect(localTenant?.value).toBe('t_888');

    // Noise cookie _ga was filtered and stale_dev_cookie was cleaned!
    expect(devA.browser.findJarCookie('_ga', 'localhost')).toBeUndefined();
    expect(devA.browser.findJarCookie('stale_dev_cookie', 'localhost')).toBeUndefined();

    // LocalStorage synced to http://localhost:3000 while excluded key vite_hmr_flag was preserved!
    const localLs = devA.browser.getRawLocalStorage('http://localhost:3000');
    expect(localLs.auth_profile).toBe('{"id":42,"role":"admin"}');
    expect(localLs.stale_ls_key).toBeUndefined();
    expect(localLs.vite_hmr_flag).toBe('keep_me');
  });

  it('ENV-003: Live auto-cascade — rotating multi-accounts or receiving remote cloud updates on Prod automatically updates localhost!', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    devA.browser.seedCookie({
      domain: '.shop-admin.com',
      name: 'session',
      value: 'acct_merchant_A',
      secure: true,
    });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    // Add second account on Device A
    await devA.engine.createSiteAccountTrack('shop-admin.com', {
      mode: 'clean_new',
      label: '超级管理员 B',
    });
    await devA.browser.simulateUserCookieSet({
      domain: '.shop-admin.com',
      name: 'session',
      value: 'acct_superadmin_B',
      secure: true,
    });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();

    // Configure autoSync rule: shop-admin.com (following active account) -> http://127.0.0.1:5173
    const rule = await devA.engine.upsertEnvSyncRule({
      name: 'Shop -> Vite 5173',
      scope: 'space',
      enabled: true,
      sourceSiteKey: 'shop-admin.com',
      targetUrl: 'http://127.0.0.1:5173',
      syncCookies: true,
      syncLocalStorage: false,
      adaptForHttp: true,
      cleanTargetBeforeSync: true,
      autoSync: true,
      autoReloadTarget: false,
    });
    await devA.engine.executeEnvCookieSync({ ruleId: rule.id });
    expect(devA.browser.findJarCookie('session', '127.0.0.1')?.value).toBe('acct_superadmin_B');

    // Rotate account on shop-admin.com -> 127.0.0.1 automatically rotates to acct_merchant_A!
    await devA.engine.rotateSiteTrack('shop-admin.com', 'next');
    expect(devA.browser.findJarCookie('session', '127.0.0.1')?.value).toBe('acct_merchant_A');

    // Device B joins space, inherits space-scoped EnvCookieSyncRule, chooses Merchant A track -> 127.0.0.1 auto-populates on B too!
    const joinB = await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-B',
    });
    const merchantTrack = joinB.pendingDecisions[0]!.remoteTracks.find(
      (t) => t.label !== '超级管理员 B',
    )!;
    await devB.engine.resolveSiteDecision('shop-admin.com', {
      type: 'use_remote_track',
      trackId: merchantTrack.trackId,
    });

    // Update cookie on Device A and sync -> Device B pulls from WebDAV and auto-cascades to B's 127.0.0.1!
    await devA.browser.simulateUserCookieSet({
      domain: '.shop-admin.com',
      name: 'session',
      value: 'acct_merchant_A_refreshed_v2',
      secure: true,
    });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();

    await devB.engine.syncNow();
    expect(devB.browser.findJarCookie('session', '127.0.0.1')?.value).toBe(
      'acct_merchant_A_refreshed_v2',
    );
  });

  it('ENV-004: Pinned background account track syncs Test Account B to localhost while main Prod site stays logged into Account A, plus reverse write-back & JSON export/import', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    devA.browser.seedCookie({ domain: '.cloud-erp.io', name: 'token', value: 'prod_personal_A' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    // Create Test Account B, log in, then switch main browser back to Personal Account A
    const trackB = await devA.engine.createSiteAccountTrack('cloud-erp.io', {
      mode: 'clean_new',
      label: '联调测试号 B',
    });
    await devA.browser.simulateUserCookieSet({
      domain: '.cloud-erp.io',
      name: 'token',
      value: 'qa_sandbox_B',
    });
    await devA.engine.rotateSiteTrack('cloud-erp.io', 'next');
    // Main browser on cloud-erp.io is back on prod_personal_A!
    expect(devA.browser.findJarCookie('token', 'cloud-erp.io')?.value).toBe('prod_personal_A');

    // Pin localhost:8080 specifically to background trackB ("联调测试号 B")!
    const pinnedRule = await devA.engine.upsertEnvSyncRule({
      name: 'Pinned QA Account -> Localhost 8080',
      scope: 'device',
      enabled: true,
      sourceSiteKey: 'cloud-erp.io',
      sourceTrackId: trackB.trackId,
      targetUrl: 'http://localhost:8080',
      syncCookies: true,
      syncLocalStorage: false,
      adaptForHttp: true,
      cleanTargetBeforeSync: true,
      autoSync: true,
      autoReloadTarget: false,
    });

    await devA.engine.executeEnvCookieSync({ ruleId: pinnedRule.id });
    expect(devA.browser.findJarCookie('token', 'localhost')?.value).toBe('qa_sandbox_B');
    expect(devA.browser.findJarCookie('token', 'cloud-erp.io')?.value).toBe('prod_personal_A');

    // Reverse sync (localhost -> staging.cloud-erp.io) via adHoc / reverse
    await devA.browser.simulateUserCookieSet({
      domain: 'localhost',
      hostOnly: true,
      name: 'token',
      value: 'minted_on_localhost',
      secure: false,
    });
    const revRes = await devA.engine.executeEnvCookieSync({
      adHoc: {
        sourceSiteKey: 'localhost',
        targetUrl: 'https://staging.cloud-erp.io',
        adaptForHttp: false,
      },
    });
    expect(revRes.appliedCookies).toBe(1);
    expect(devA.browser.findJarCookie('token', 'staging.cloud-erp.io')?.value).toBe(
      'minted_on_localhost',
    );

    // Rules JSON export & import round-trip preserves deviceEnvSyncRules & space envSyncRules
    const exportedJson = await devA.engine.exportRulesJson();
    await devA.engine.removeEnvSyncRule(pinnedRule.id, 'device');
    expect((await devA.engine.getRulesAndBlacklist()).envSyncRules).toHaveLength(0);

    await devA.engine.importRulesJson(exportedJson);
    const restoredRules = (await devA.engine.getRulesAndBlacklist()).envSyncRules;
    expect(restoredRules).toHaveLength(1);
    expect(restoredRules[0]?.sourceTrackId).toBe(trackB.trackId);
  });

  it('MA-004: LocalStorage does not leak when rotating to a 0-LS account, and pagehide LS writes from unloading tab cannot pollute new account', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    devA.browser.openTab('https://spa.io/app', { active: true, safeToReload: true });
    devA.browser.seedCookie({ domain: '.spa.io', name: 'sid', value: 'acct_A_sid' });
    devA.browser.seedLocalStorage('https://spa.io', {
      jwt: 'acct_A_jwt',
      profile: 'alice',
    });

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });
    await devA.engine.ingestLocalStorageSnapshot('https://spa.io', {
      jwt: 'acct_A_jwt',
      profile: 'alice',
    });

    // Create Account B (clean_new): wipes browser cookies & LS while preserving Account A's LS
    const trackB = await devA.engine.createSiteAccountTrack('spa.io', {
      mode: 'clean_new',
      label: '无LS账号B',
    });
    expect(devA.browser.getRawLocalStorage('https://spa.io')).toEqual({});

    // Simulate unloading Account A firing pagehide right after switching to Account B!
    await devA.engine.ingestLocalStorageMutations(
      'https://spa.io',
      [{ key: 'jwt', value: 'leaked_pagehide_A' }],
      { isPageLeaving: true },
    );
    const lsRecordsB = await devA.engine.getLocalStorageRecords({ siteKey: 'spa.io' });
    expect(lsRecordsB.filter((r) => r.trackId === trackB.trackId && !r.deleted)).toHaveLength(0);

    // Log into Account B using cookie ONLY (0 localStorage items)
    await devA.browser.simulateUserCookieSet({
      domain: '.spa.io',
      name: 'sid',
      value: 'acct_B_sid',
    });

    // Rotate back to Account A -> Account A's LS is restored!
    const backToA = await devA.engine.rotateSiteTrack('spa.io', 'next');
    expect(backToA.track.trackId).not.toBe(trackB.trackId);
    expect(devA.browser.getRawLocalStorage('https://spa.io')).toEqual({
      jwt: 'acct_A_jwt',
      profile: 'alice',
    });

    // Rotate from Account A -> Account B (which has 0 LS records!) -> Account A's LS MUST be wiped!
    const backToB = await devA.engine.rotateSiteTrack('spa.io', 'next');
    expect(backToB.track.trackId).toBe(trackB.trackId);
    expect(devA.browser.findJarCookie('sid', 'spa.io')?.value).toBe('acct_B_sid');
    expect(devA.browser.getRawLocalStorage('https://spa.io')).toEqual({});

    // Another unloading pagehide from Account A right after rotation is STILL muted!
    await devA.engine.ingestLocalStorageMutations(
      'https://spa.io',
      [{ key: 'jwt', value: 'leaked_pagehide_A_again' }],
      { isPageLeaving: true },
    );
    const lsAfterRotate = await devA.engine.getLocalStorageRecords({ siteKey: 'spa.io' });
    expect(lsAfterRotate.filter((r) => r.trackId === trackB.trackId && !r.deleted)).toHaveLength(0);

    // After the 2.5s mute window expires, normal mutations on Account B work properly
    devA.browser.advanceTime(3_000);
    await devA.engine.ingestLocalStorageMutations('https://spa.io', [
      { key: 'b_flag', value: 'ok_b' },
    ]);
    const lsAfterWindow = await devA.engine.getLocalStorageRecords({ siteKey: 'spa.io' });
    expect(
      lsAfterWindow.some(
        (r) => r.trackId === trackB.trackId && r.key === 'b_flag' && r.value === 'ok_b',
      ),
    ).toBe(true);
  });

  it('MA-005: Pure-LocalStorage SPA (0 cookies) archives Account 1 on clean_new, and push_only policy still permits local account rotation', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
      settingsPatch: { syncScopeMode: 'managed_only' },
      initialManagedSiteKeys: [],
    });

    // Unmanaged pure-LS SPA with ZERO cookies
    devA.browser.openTab('https://pure-spa.app/workspace', { active: true, safeToReload: true });
    devA.browser.seedLocalStorage('https://pure-spa.app', {
      auth_jwt: 'spa_user_1_jwt',
    });

    // Create clean_new Account 2 -> MUST archive existing pure-LS Account 1 as "默认账号"!
    const track2 = await devA.engine.createSiteAccountTrack('pure-spa.app', {
      mode: 'clean_new',
      label: '小号 2',
    });
    expect(track2.label).toBe('小号 2');
    expect(devA.browser.getRawLocalStorage('https://pure-spa.app')).toEqual({});

    // Set site policy to push_only -> local user-initiated rotation must STILL work!
    await devA.engine.upsertSiteRule({
      siteKey: 'pure-spa.app',
      pattern: 'pure-spa.app',
      direction: 'push_only',
      syncCookies: true,
      syncLocalStorage: true,
      autoRefresh: false,
      updatedAt: Date.now(),
    });

    // Log into Account 2 via localStorage
    devA.browser.seedLocalStorage('https://pure-spa.app', {
      auth_jwt: 'spa_user_2_jwt',
    });

    // Rotate back to Account 1 ("默认账号") under push_only!
    const r1 = await devA.engine.rotateSiteTrack('pure-spa.app', 'next');
    expect(r1.track.label).toBe('默认账号');
    expect(devA.browser.getRawLocalStorage('https://pure-spa.app')).toEqual({
      auth_jwt: 'spa_user_1_jwt',
    });

    // Rotate forward to Account 2 -> Account 2's reconciled LS was preserved too!
    const r2 = await devA.engine.rotateSiteTrack('pure-spa.app', 'next');
    expect(r2.track.label).toBe('小号 2');
    expect(devA.browser.getRawLocalStorage('https://pure-spa.app')).toEqual({
      auth_jwt: 'spa_user_2_jwt',
    });
  });

  it('MA-006: on_page_leave mode pushes previous account updates on rotate, reload guard distinguishes probe_unreachable vs unsaved_form_input, and deleteSiteTrack undo avoids dangling trackId', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    devA.browser.seedCookie({ domain: '.work.io', name: 'sid', value: 'v1_initial' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
      settingsPatch: { syncTimingMode: 'on_page_leave', refreshProtection: true },
    });

    const unreachableTab = devA.browser.openTab('https://work.io/list', {
      active: false,
      safeToReload: false,
      unsafeReasons: ['probe_unreachable'],
    });
    const dirtyFormTab = devA.browser.openTab('https://work.io/edit', {
      active: true,
      safeToReload: false,
      unsafeReasons: ['unsaved_form_input'],
    });

    const track2 = await devA.engine.createSiteAccountTrack('work.io', {
      mode: 'clean_new',
      label: '工作号 2',
    });
    // probe_unreachable tab WAS reloaded on explicit user action; dirty form tab was protected!
    expect(devA.browser.reloadedTabIds).toContain(unreachableTab);
    expect(devA.browser.reloadedTabIds).not.toContain(dirtyFormTab);

    // Log into track2 in on_page_leave mode (cookie update stays buffered while tab is open!)
    await devA.browser.simulateUserCookieSet({
      domain: '.work.io',
      name: 'sid',
      value: 'v2_fresh_before_rotate',
    });
    await devA.engine.flushPendingLocalChanges();

    // Rotate away to Account 1 -> MUST push track2's pending v2_fresh_before_rotate to WebDAV!
    await devA.engine.rotateSiteTrack('work.io', 'next');

    // Device B joins and sees track2 already has v2_fresh_before_rotate in cloud!
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-B',
    });
    const track2CookiesOnB = await devB.engine.getSiteCookies('work.io', track2.trackId);
    expect(track2CookiesOnB.find((c) => c.name === 'sid')?.value).toBe('v2_fresh_before_rotate');

    // Switch back to track2 and delete it -> captures SafetyUndoPoint, switches to Account 1
    await devA.engine.switchSiteTrack('work.io', track2.trackId);
    const delRes = await devA.engine.deleteSiteTrack('work.io', track2.trackId);
    expect(delRes.switchedToTrack).toBeDefined();
    expect(devA.browser.findJarCookie('sid', 'work.io')?.value).toBe('v1_initial');

    // Applying the delete_track SafetyUndoPoint restores browser cookies safely without dangling trackId!
    const undoPoints = await devA.engine.getUndoPoints();
    const delUndo = undoPoints.find((u) => u.reason === `delete_track:${track2.trackId}`);
    expect(delUndo).toBeDefined();
    await devA.engine.applyUndoPoint(delUndo!.undoId);
    expect(devA.browser.findJarCookie('sid', 'work.io')?.value).toBe('v2_fresh_before_rotate');
    const overviewAfterUndo = await devA.engine.getSitesOverview();
    const workAfterUndo = overviewAfterUndo.find((s) => s.siteKey === 'work.io')!;
    expect(workAfterUndo.binding.trackId).toBeUndefined();
    expect(workAfterUndo.binding.state).toBe('PENDING_CHOICE');
  });

  it('MA-007: Rapid 20-step forward/backward rotation across 5 accounts & MV3 cold restart preserves exact sortOrder and cookie isolation', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    devA.browser.seedCookie({ domain: '.stress.io', name: 'uid', value: 'acct_1' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });
    const t1 = (await devA.engine.getSitesOverview()).find((s) => s.siteKey === 'stress.io')!
      .activeTrack!;
    await devA.engine.renameSiteTrack('stress.io', t1.trackId, 'A1');

    for (let i = 2; i <= 5; i += 1) {
      await devA.engine.createSiteAccountTrack('stress.io', {
        mode: 'clean_new',
        label: `A${i}`,
        triggerRefresh: false,
      });
      await devA.browser.simulateUserCookieSet({
        domain: '.stress.io',
        name: 'uid',
        value: `acct_${i}`,
      });
      await devA.browser.simulateUserCookieSet({
        domain: '.stress.io',
        name: `only_${i}`,
        value: `marker_${i}`,
      });
    }

    // Cold MV3 restart before stress rotation!
    await devA.restartEngine();

    // Currently on A5 (#5/5). Rotate forward 10 times (2 full loops)
    const expectedForward = ['A1', 'A2', 'A3', 'A4', 'A5', 'A1', 'A2', 'A3', 'A4', 'A5'];
    for (let step = 0; step < expectedForward.length; step += 1) {
      const res = await devA.engine.rotateSiteTrack('stress.io', 'next');
      const expectedLabel = expectedForward[step]!;
      const num = expectedLabel.slice(1);
      expect(res.track.label).toBe(expectedLabel);
      expect(devA.browser.findJarCookie('uid', 'stress.io')?.value).toBe(`acct_${num}`);
      const allStressCookies = (await devA.browser.getAllCookies({ domain: 'stress.io' })).map(
        (c) => c.name,
      );
      expect(allStressCookies.sort()).toEqual(num === '1' ? ['uid'] : [`only_${num}`, 'uid']);
    }

    // Rotate backward 5 times
    const expectedBackward = ['A4', 'A3', 'A2', 'A1', 'A5'];
    for (let step = 0; step < expectedBackward.length; step += 1) {
      const res = await devA.engine.rotateSiteTrack('stress.io', 'prev');
      expect(res.track.label).toBe(expectedBackward[step]);
    }
  });

  it('ENV-005: Clears CHIPS partitionKey across HTTPS envs, handles __Host-/__Secure- cookies, and syncs prototype-named LocalStorage keys safely', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    // CHIPS partitioned cookie + __Host- + __Secure- on prod
    const httpsDevTarget = parseEnvTarget('https://dev.corp.local')!;
    const mappedChips = mapCookieToTargetEnv(
      {
        domain: '.prod.corp.com',
        name: '__Host-csrf',
        value: 'csrf_123',
        path: '/sub',
        secure: true,
        httpOnly: true,
        sameSite: 'no_restriction',
        session: true,
        hostOnly: true,
        partitionKey: { topLevelSite: 'https://prod.corp.com' },
      },
      httpsDevTarget,
      { adaptForHttp: true },
    );
    expect(mappedChips.partitionKey).toBeNull();
    expect(mappedChips.domain).toBe('dev.corp.local');
    expect(mappedChips.hostOnly).toBe(true);
    expect(mappedChips.path).toBe('/');
    expect(mappedChips.secure).toBe(true);

    // Prototype-named keys in LocalStorage (`toString`, `constructor`, `hasOwnProperty`)
    devA.browser.openTab('https://prod.corp.com/', { active: false });
    devA.browser.seedLocalStorage('https://prod.corp.com', {
      toString: 'custom_toString_val',
      constructor: 'custom_ctor_val',
      jwt: 'tok_999',
    });
    devA.browser.openTab('http://localhost:3000/', { active: true });
    devA.browser.seedLocalStorage('http://localhost:3000', {});

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    const res = await devA.engine.executeEnvCookieSync({
      adHoc: {
        sourceSiteKey: 'prod.corp.com',
        targetUrl: 'http://localhost:3000',
        syncCookies: false,
        syncLocalStorage: true,
      },
    });
    expect(res.appliedLocalStorage).toBe(3);
    const localLs = devA.browser.getRawLocalStorage('http://localhost:3000');
    expect(localLs.toString).toBe('custom_toString_val');
    expect(localLs.constructor).toBe('custom_ctor_val');
    expect(localLs.jwt).toBe('tok_999');
  });

  it('ENV-006: Subdomain isolation (uat vs prod), child-subdomain preservation on cleanTargetBeforeSync, and safe reverse sync', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    // Both prod.company.com and uat.company.com have hostOnly cookies & LS
    devA.browser.seedCookie({
      domain: 'prod.company.com',
      hostOnly: true,
      name: 'prod_only_secret',
      value: 'DO_NOT_LEAK',
      secure: true,
    });
    devA.browser.seedCookie({
      domain: 'uat.company.com',
      hostOnly: true,
      name: 'uat_sid',
      value: 'uat_token_123',
      secure: true,
    });
    devA.browser.openTab('https://prod.company.com/', { active: false });
    devA.browser.seedLocalStorage('https://prod.company.com', { env_ls: 'PROD_SECRET' });
    devA.browser.openTab('https://uat.company.com/', { active: false });
    devA.browser.seedLocalStorage('https://uat.company.com', { env_ls: 'UAT_SAFE' });

    // Target dev.example.com has a stale cookie AND child subdomain api.dev.example.com has its own cookie!
    devA.browser.seedCookie({
      domain: 'dev.example.com',
      hostOnly: true,
      name: 'stale_on_dev',
      value: 'remove_me',
      secure: true,
    });
    devA.browser.seedCookie({
      domain: 'api.dev.example.com',
      hostOnly: true,
      name: 'api_gateway_sid',
      value: 'must_survive',
      secure: true,
    });
    devA.browser.openTab('https://dev.example.com/', { active: true });
    devA.browser.seedLocalStorage('https://dev.example.com', {});

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    // Entering full subdomain URL automatically sets sourceHostFilter = 'uat.company.com'!
    const rule = await devA.engine.upsertEnvSyncRule({
      scope: 'device',
      enabled: true,
      sourceSiteKey: 'https://uat.company.com',
      targetUrl: 'https://dev.example.com',
      syncCookies: true,
      syncLocalStorage: true,
      adaptForHttp: true,
      cleanTargetBeforeSync: true,
      autoSync: false,
      autoReloadTarget: false,
    });
    expect(rule.sourceSiteKey).toBe('company.com');
    expect(rule.sourceHostFilter).toBe('uat.company.com');

    const res = await devA.engine.executeEnvCookieSync({ ruleId: rule.id });
    expect(res.appliedCookies).toBe(1);
    expect(res.removedStaleCookies).toBe(1);

    // Only UAT cookie & LS arrived; prod cookie & LS did NOT leak; api.dev.example.com cookie survived!
    expect(devA.browser.findJarCookie('uat_sid', 'dev.example.com')?.value).toBe('uat_token_123');
    expect(devA.browser.findJarCookie('prod_only_secret', 'dev.example.com')).toBeUndefined();
    expect(devA.browser.findJarCookie('stale_on_dev', 'dev.example.com')).toBeUndefined();
    expect(devA.browser.findJarCookie('api_gateway_sid', 'api.dev.example.com')?.value).toBe(
      'must_survive',
    );
    expect(devA.browser.getRawLocalStorage('https://dev.example.com')).toEqual({
      env_ls: 'UAT_SAFE',
    });

    // Reverse sync safety: even when forward rule has cleanTargetBeforeSync: true,
    // reverse: true MUST NOT wipe existing prod cookies AND writes wildcard `.acme.com`!
    devA.browser.seedCookie({
      domain: '.acme.com',
      name: 'prod_existing',
      value: 'keep_prod_alive',
      secure: true,
    });
    devA.browser.seedCookie({
      domain: 'localhost',
      hostOnly: true,
      name: 'dev_minted',
      value: 'from_local_3000',
      secure: false,
    });
    const acmeRule = await devA.engine.upsertEnvSyncRule({
      scope: 'device',
      enabled: true,
      sourceSiteKey: 'acme.com',
      targetUrl: 'http://localhost:3000',
      syncCookies: true,
      syncLocalStorage: false,
      adaptForHttp: true,
      cleanTargetBeforeSync: true,
      autoSync: false,
      autoReloadTarget: false,
    });
    const revRes = await devA.engine.executeEnvCookieSync({ ruleId: acmeRule.id, reverse: true });
    expect(revRes.removedStaleCookies).toBe(0);
    expect(devA.browser.findJarCookie('prod_existing', 'acme.com')?.value).toBe('keep_prod_alive');
    // Reverse-synced cookie is reachable from subdomain app.acme.com!
    const onSubdomain = await devA.browser.getCookie({
      url: 'https://app.acme.com/',
      name: 'dev_minted',
    });
    expect(onSubdomain?.value).toBe('from_local_3000');
  });

  it('ENV-007: Unmanaged pure-LS auto-cascade + rule deduplication + circular loop immunity + sensitive blacklist + multi-port localhost LS sync', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
      presetCategories: ['banking', 'localhost'],
      settingsPatch: { syncScopeMode: 'managed_only' },
      initialManagedSiteKeys: [],
    });

    // 1. Unmanaged pure-LS site cascades live mutations to localhost:3000 and persists lastSyncedAt across restart
    devA.browser.openTab('https://spa-prod.io/', { active: false });
    devA.browser.openTab('http://localhost:3000/', { active: true });
    devA.browser.seedLocalStorage('http://localhost:3000', {});

    const lsRule = await devA.engine.upsertEnvSyncRule({
      scope: 'device',
      enabled: true,
      sourceSiteKey: 'spa-prod.io',
      targetUrl: 'http://localhost:3000',
      syncCookies: true,
      syncLocalStorage: true,
      adaptForHttp: true,
      cleanTargetBeforeSync: false,
      autoSync: true,
      autoReloadTarget: false,
    });

    // Deduplication: calling upsertEnvSyncRule again without id updates existing rule in place!
    const deduped = await devA.engine.upsertEnvSyncRule({
      scope: 'device',
      enabled: true,
      sourceSiteKey: 'spa-prod.io',
      targetUrl: 'http://localhost:3000/',
      syncCookies: true,
      syncLocalStorage: true,
      adaptForHttp: true,
      cleanTargetBeforeSync: false,
      autoSync: true,
      autoReloadTarget: false,
    });
    expect(deduped.id).toBe(lsRule.id);
    expect((await devA.engine.getRulesAndBlacklist()).envSyncRules).toHaveLength(1);

    // Live LS mutation on unmanaged spa-prod.io triggers auto env sync!
    devA.browser.seedLocalStorage('https://spa-prod.io', { jwt: 'unmanaged_live_jwt' });
    await devA.engine.ingestLocalStorageMutations('https://spa-prod.io', [
      { key: 'jwt', value: 'unmanaged_live_jwt' },
    ]);
    expect(devA.browser.getRawLocalStorage('http://localhost:3000').jwt).toBe('unmanaged_live_jwt');

    // Cold restart verifies lastSyncedAt was persisted!
    await devA.restartEngine();
    const afterRestartRules = (await devA.engine.getRulesAndBlacklist()).envSyncRules;
    expect(afterRestartRules[0]?.lastSyncedAt).toBeGreaterThan(0);

    // 2. Circular autoSync rules (envA.test <-> envB.test) terminate cleanly with zero infinite loop!
    await devA.engine.upsertEnvSyncRule({
      scope: 'device',
      enabled: true,
      sourceSiteKey: 'enva.test',
      targetUrl: 'https://envb.test',
      syncCookies: true,
      syncLocalStorage: false,
      adaptForHttp: true,
      cleanTargetBeforeSync: false,
      autoSync: true,
      autoReloadTarget: false,
    });
    await devA.engine.upsertEnvSyncRule({
      scope: 'device',
      enabled: true,
      sourceSiteKey: 'envb.test',
      targetUrl: 'https://enva.test',
      syncCookies: true,
      syncLocalStorage: false,
      adaptForHttp: true,
      cleanTargetBeforeSync: false,
      autoSync: true,
      autoReloadTarget: false,
    });
    const emitCountBefore = devA.browser.cookieChangedEmitCount;
    await devA.browser.simulateUserCookieSet({
      domain: 'enva.test',
      hostOnly: true,
      name: 'loop_tok',
      value: 'v1',
      secure: true,
    });
    await devA.engine.flushPendingLocalChanges();
    expect(devA.browser.findJarCookie('loop_tok', 'envb.test')?.value).toBe('v1');
    expect(devA.browser.cookieChangedEmitCount - emitCountBefore).toBeLessThanOrEqual(4);

    // 3. Sensitive banking blacklist cannot be bypassed by EnvCookieSync!
    await expect(
      devA.engine.executeEnvCookieSync({
        adHoc: {
          sourceSiteKey: 'icbc.com.cn',
          targetUrl: 'http://localhost:3000',
        },
      }),
    ).rejects.toThrow(/受保护敏感黑名单/);

    // 4. Multi-port localhost LS sync (3000 -> 8080) preserves localhost cookies and copies LS cleanly!
    devA.browser.seedCookie({
      domain: 'localhost',
      hostOnly: true,
      name: 'shared_local_cookie',
      value: 'keep_me',
      secure: false,
    });
    devA.browser.openTab('http://localhost:8080/', { active: false });
    devA.browser.seedLocalStorage('http://localhost:8080', { old_8080: 'stale' });
    await devA.engine.executeEnvCookieSync({
      adHoc: {
        sourceSiteKey: 'http://localhost:3000',
        targetUrl: 'http://localhost:8080',
        syncCookies: true,
        syncLocalStorage: true,
        cleanTargetBeforeSync: true,
      },
    });
    expect(devA.browser.findJarCookie('shared_local_cookie', 'localhost')?.value).toBe('keep_me');
    expect(devA.browser.getRawLocalStorage('http://localhost:8080').jwt).toBe('unmanaged_live_jwt');
  });

  it('PW-001: Immediate E2E encryption password verification validates existing/new/opaque/wrong-password/WebDAV-auth cases without mutating remote', async () => {
    const { dav, webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    // 1. Non-existent space -> exists: false, verified: false (zero remote writes!)
    const beforeFiles = dav.listAllStoredPaths();
    const nonExistRes = await devB.engine.verifyRemoteSpacePassword({
      webdav,
      spaceId: SPACE_ID,
      encryptionPassword: ENC_PASS,
    });
    expect(nonExistRes).toEqual({ exists: false, verified: false });
    expect(dav.listAllStoredPaths()).toEqual(beforeFiles);

    // Device A initializes the space
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    // 2. Existing space + correct password -> exists: true, verified: true, returns spaceName & keyEpoch
    const okRes = await devB.engine.verifyRemoteSpacePassword({
      webdav,
      spaceId: SPACE_ID,
      encryptionPassword: ENC_PASS,
    });
    expect(okRes.exists).toBe(true);
    expect(okRes.verified).toBe(true);
    expect(okRes.spaceId).toBe(SPACE_ID);
    expect(okRes.spaceName).toBe(SPACE_NAME);
    expect(okRes.keyEpoch).toBe(1);

    // 3. Existing space + wrong password -> exists: true, verified: false, DECRYPT_ERROR (zero writes!)
    const filesBeforeWrong = dav.listAllStoredPaths();
    const wrongRes = await devB.engine.verifyRemoteSpacePassword({
      webdav,
      spaceId: SPACE_ID,
      encryptionPassword: 'wrong-password-999!',
    });
    expect(wrongRes.exists).toBe(true);
    expect(wrongRes.verified).toBe(false);
    expect(wrongRes.errorCode).toBe('DECRYPT_ERROR');
    expect(dav.listAllStoredPaths()).toEqual(filesBeforeWrong);

    // 4. Existing space queried via opaque `sp_...` directory ID -> verifies cleanly!
    const probed = await devB.engine.probeRemoteSpaces(webdav);
    expect(probed).toHaveLength(1);
    const opaqueRes = await devB.engine.verifyRemoteSpacePassword({
      webdav,
      spaceId: probed[0]!.opaqueId,
      encryptionPassword: ENC_PASS,
    });
    expect(opaqueRes.exists).toBe(true);
    expect(opaqueRes.verified).toBe(true);
    expect(opaqueRes.spaceId).toBe(SPACE_ID);

    // 5. Invalid WebDAV credentials -> throws structured auth error instead of returning exists: false!
    await expect(
      devB.engine.verifyRemoteSpacePassword({
        webdav: { ...webdav, password: 'bad-webdav-password' },
        spaceId: SPACE_ID,
        encryptionPassword: ENC_PASS,
      }),
    ).rejects.toThrow(/401|认证|unauthorized|auth/i);
  });

  it('ENV-008: Target-side LocalStorage hydration automatically populates http://localhost:3000 when opened AFTER Prod login, with zero reload loop', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    // Developer logs into Prod SPA while http://localhost:3000 tab is NOT open yet!
    devA.browser.openTab('https://prod-spa.com/app', { active: true });
    devA.browser.seedCookie({
      domain: '.prod-spa.com',
      name: 'auth_sid',
      value: 'prod_sid_99',
      secure: true,
    });
    devA.browser.seedLocalStorage('https://prod-spa.com', {
      jwt_token: 'prod_jwt_xyz',
    });

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
      presetCategories: ['localhost'],
    });
    await devA.engine.ingestLocalStorageSnapshot('https://prod-spa.com', {
      jwt_token: 'prod_jwt_xyz',
    });

    // Configure autoSync + syncLocalStorage + autoReloadTarget rule while localhost:3000 is closed
    await devA.engine.upsertEnvSyncRule({
      name: 'Prod SPA -> Localhost 3000',
      scope: 'device',
      enabled: true,
      sourceSiteKey: 'prod-spa.com',
      targetUrl: 'http://localhost:3000',
      syncCookies: true,
      syncLocalStorage: true,
      adaptForHttp: true,
      cleanTargetBeforeSync: false,
      autoSync: true,
      autoReloadTarget: true,
    });

    // Now developer starts dev server & opens http://localhost:3000 -> content script fires CONTENT_PAGE_MOUNTED!
    const localTabId = devA.browser.openTab('http://localhost:3000/', {
      active: true,
      safeToReload: true,
    });
    devA.browser.seedLocalStorage('http://localhost:3000', {});
    await devA.engine.ingestLocalStorageSnapshot('http://localhost:3000', {});

    // Localhost received BOTH cookies & localStorage and reloaded ONCE!
    expect(devA.browser.findJarCookie('auth_sid', 'localhost')?.value).toBe('prod_sid_99');
    expect(devA.browser.getRawLocalStorage('http://localhost:3000').jwt_token).toBe('prod_jwt_xyz');
    expect(devA.browser.reloadCountByTab.get(localTabId)).toBe(1);

    // After that reload, CONTENT_PAGE_MOUNTED fires again with the hydrated LS -> ZERO extra reload!
    await devA.engine.ingestLocalStorageSnapshot('http://localhost:3000', {
      jwt_token: 'prod_jwt_xyz',
    });
    expect(devA.browser.reloadCountByTab.get(localTabId)).toBe(1);
  });

  it('ENV-009: Peer track deletion clears dangling deviceEnvSyncRule.sourceTrackId and RulesEngine rejects unsafe targetUrl on JSON import', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');
    const devB = await h.createDevice('Device-B');

    devA.browser.seedCookie({ domain: '.erp-sync.io', name: 'sid', value: 'acct_1_keep' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    const track2 = await devA.engine.createSiteAccountTrack('erp-sync.io', {
      mode: 'clean_new',
      label: '将被删除的测试号',
    });
    await devA.browser.simulateUserCookieSet({
      domain: '.erp-sync.io',
      name: 'sid',
      value: 'acct_2_temp',
    });
    await devA.engine.flushPendingLocalChanges();
    await devA.engine.syncNow();

    // Device B joins and pins a device-level env rule to track2
    await devB.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-B',
    });
    const pinnedRuleOnB = await devB.engine.upsertEnvSyncRule({
      scope: 'device',
      enabled: true,
      sourceSiteKey: 'erp-sync.io',
      sourceTrackId: track2.trackId,
      targetUrl: 'http://localhost:5173',
      syncCookies: true,
      syncLocalStorage: false,
      adaptForHttp: true,
      cleanTargetBeforeSync: false,
      autoSync: false,
      autoReloadTarget: false,
    });
    expect(pinnedRuleOnB.sourceTrackId).toBe(track2.trackId);

    // Device A deletes track2 and syncs -> Device B pulls
    await devA.engine.deleteSiteTrack('erp-sync.io', track2.trackId);
    await devB.engine.syncNow();

    const rulesOnB = (await devB.engine.getRulesAndBlacklist()).envSyncRules;
    expect(rulesOnB.find((r) => r.id === pinnedRuleOnB.id)?.sourceTrackId).toBeUndefined();

    // Executing the rule on B gracefully falls back to remaining Account 1 instead of syncing 0 cookies!
    const execRes = await devB.engine.executeEnvCookieSync({ ruleId: pinnedRuleOnB.id });
    expect(execRes.appliedCookies).toBe(1);
    expect(devB.browser.findJarCookie('sid', 'localhost')?.value).toBe('acct_1_keep');

    // Malformed / javascript: URLs in imported rules JSON are rejected while valid subdomain rules auto-infer sourceHostFilter
    await devB.engine.importRulesJson({
      envSyncRules: [
        { sourceSiteKey: 'evil.com', targetUrl: 'javascript:alert(1)' },
        { sourceSiteKey: 'broken.com', targetUrl: '://not-a-url' },
        { sourceSiteKey: 'https://uat.good.com', targetUrl: 'http://localhost:4000' },
      ],
    });
    const importedSpaceRules = (await devB.engine.getRulesAndBlacklist()).envSyncRules.filter(
      (r) => r.scope === 'space',
    );
    expect(importedSpaceRules).toHaveLength(1);
    expect(importedSpaceRules[0]?.sourceSiteKey).toBe('good.com');
    expect(importedSpaceRules[0]?.sourceHostFilter).toBe('uat.good.com');
  });

  it('ENV-010: Reverse Dev->Prod sync writes LocalStorage and cookies back to open subdomain and custom-port production tabs', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    // Open prod subdomain tab on a custom port and a local HTTP dev tab on another port
    devA.browser.openTab('https://app.r30-env.test:8443/', { active: false });
    devA.browser.seedLocalStorage('https://app.r30-env.test:8443', { existing_key: 'keep_me' });
    devA.browser.openTab('http://127.0.0.1:5173/', { active: true });
    devA.browser.seedCookie({
      domain: '127.0.0.1',
      hostOnly: true,
      name: 'dev_edited',
      value: 'from_local_dev',
      secure: false,
    });
    devA.browser.seedLocalStorage('http://127.0.0.1:5173', {
      existing_key: 'keep_me',
      dev_ls_key: 'dev_val_99',
    });

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    const rule = await devA.engine.upsertEnvSyncRule({
      scope: 'device',
      enabled: true,
      sourceSiteKey: 'r30-env.test',
      targetUrl: 'http://127.0.0.1:5173',
      syncCookies: true,
      syncLocalStorage: true,
      adaptForHttp: true,
      cleanTargetBeforeSync: true,
      autoSync: false,
      autoReloadTarget: false,
    });

    const revRes = await devA.engine.executeEnvCookieSync({ ruleId: rule.id, reverse: true });
    expect(revRes.appliedLocalStorage).toBe(2);
    expect(revRes.appliedCookies).toBe(1);

    const prodLs = devA.browser.getRawLocalStorage('https://app.r30-env.test:8443');
    expect(prodLs.dev_ls_key).toBe('dev_val_99');
    const prodCookie = await devA.browser.getCookie({
      url: 'https://app.r30-env.test:8443/',
      name: 'dev_edited',
    });
    expect(prodCookie?.value).toBe('from_local_dev');
  });

  it('MA-008: updateSiteTrack (label & accountNote), reorderSiteTracks rotation order, and inactive-track cookie/LS edit & export without clobbering active account', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    devA.browser.openTab('https://acct-hub.io/', { active: true, safeToReload: true });
    devA.browser.seedCookie({ domain: '.acct-hub.io', name: 'sid', value: 'acct_1_sid' });
    devA.browser.seedLocalStorage('https://acct-hub.io', { role: 'owner' });

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });
    await devA.engine.ingestLocalStorageSnapshot('https://acct-hub.io', { role: 'owner' });

    const track1 = (await devA.engine.getSitesOverview()).find((s) => s.siteKey === 'acct-hub.io')!
      .activeTrack!;
    const updated1 = await devA.engine.updateSiteTrack('acct-hub.io', track1.trackId, {
      label: '主号',
      accountNote: '超级管理员 · 手机号 138****0001',
    });
    expect(updated1.label).toBe('主号');
    expect(updated1.accountNote).toBe('超级管理员 · 手机号 138****0001');

    const track2 = await devA.engine.createSiteAccountTrack('acct-hub.io', {
      mode: 'clean_new',
      label: '运营号',
      accountNote: '测试运营',
      triggerRefresh: false,
    });
    await devA.browser.simulateUserCookieSet({
      domain: '.acct-hub.io',
      name: 'sid',
      value: 'acct_2_sid',
    });

    const track3 = await devA.engine.createSiteAccountTrack('acct-hub.io', {
      mode: 'clean_new',
      label: '只读审计号',
      triggerRefresh: false,
    });
    await devA.browser.simulateUserCookieSet({
      domain: '.acct-hub.io',
      name: 'sid',
      value: 'acct_3_sid',
    });

    // Reorder tracks: [track3, track1, track2]
    const reordered = await devA.engine.reorderSiteTracks('acct-hub.io', [
      track3.trackId,
      track1.trackId,
      track2.trackId,
    ]);
    expect(reordered.map((t) => t.trackId)).toEqual([track3.trackId, track1.trackId, track2.trackId]);
    expect(reordered.map((t) => t.sortOrder)).toEqual([1, 2, 3]);

    // Currently on track3 (#1). Rotating next MUST go to track1 (#2) -> track2 (#3)
    const rot1 = await devA.engine.rotateSiteTrack('acct-hub.io', 'next');
    expect(rot1.track.trackId).toBe(track1.trackId);
    expect(devA.browser.findJarCookie('sid', 'acct-hub.io')?.value).toBe('acct_1_sid');

    // While track1 is active, import/upsert cookies & LS directly into INACTIVE track2 without clobbering browser!
    const importedCount = await devA.engine.importCookiesJson(
      [
        {
          domain: '.acct-hub.io',
          name: 'bg_imported',
          value: 'only_in_track2',
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'lax',
          session: true,
          hostOnly: false,
        },
      ],
      'acct-hub.io',
      track2.trackId,
    );
    expect(importedCount).toBe(1);
    await devA.engine.upsertLocalStorageItem(
      'https://acct-hub.io',
      'bg_ls',
      'track2_ls_val',
      track2.trackId,
    );

    // Active browser session on track1 MUST remain untouched!
    expect(devA.browser.findJarCookie('sid', 'acct-hub.io')?.value).toBe('acct_1_sid');
    expect(devA.browser.findJarCookie('bg_imported', 'acct-hub.io')).toBeUndefined();
    expect(devA.browser.getRawLocalStorage('https://acct-hub.io')).toEqual({ role: 'owner' });

    // Track-scoped export & LS query returns track2's exact data!
    const exportedT2 = await devA.engine.exportCookiesJson('acct-hub.io', track2.trackId);
    expect(exportedT2.map((c) => c.name).sort()).toEqual(['bg_imported', 'sid']);
    const lsT2 = await devA.engine.getLocalStorageRecords({
      siteKey: 'acct-hub.io',
      trackId: track2.trackId,
    });
    expect(lsT2.map((r) => `${r.key}=${r.value}`)).toEqual(['bg_ls=track2_ls_val']);

    // Clear accountNote cleanly
    const cleared = await devA.engine.updateSiteTrack('acct-hub.io', track1.trackId, {
      accountNote: '',
    });
    expect(cleared.accountNote).toBeUndefined();
  });

  it('MA-007: Deferred offline-origin LocalStorage cleanup wipes stale keys and applies target LS cleanly when closed tab reopens', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    devA.browser.seedCookie({ domain: '.offline-ls.io', name: 'sid', value: 'user_a_sid' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    // Visit origin once so Account 1 stores LS, then close tab before switching accounts
    const tab1 = devA.browser.openTab('https://offline-ls.io/app', { active: true, safeToReload: true });
    devA.browser.seedLocalStorage('https://offline-ls.io', {
      auth_user: 'alice',
      role: 'owner',
      stale_extra: 'must_vanish',
    });
    await devA.engine.ingestLocalStorageSnapshot('https://offline-ls.io', {
      auth_user: 'alice',
      role: 'owner',
      stale_extra: 'must_vanish',
    });
    const ov1 = await devA.engine.getSitesOverview();
    const track1 = ov1.find((s) => s.siteKey === 'offline-ls.io')!.activeTrack!;

    devA.browser.closeTab(tab1);
    const track2 = await devA.engine.createSiteAccountTrack('offline-ls.io', {
      mode: 'clean_new',
      label: 'Clean Slot B',
      triggerRefresh: true,
    });

    // Tab was NOT open -> browser localStorage still held alice's stale keys on disk
    expect(devA.browser.getRawLocalStorage('https://offline-ls.io')).toEqual({
      auth_user: 'alice',
      role: 'owner',
      stale_extra: 'must_vanish',
    });

    // User now opens the site tab -> CONTENT_PAGE_MOUNTED sends stale disk snapshot to engine
    const tab2 = devA.browser.openTab('https://offline-ls.io/login', { active: true, safeToReload: true });
    await devA.engine.ingestLocalStorageSnapshot(
      'https://offline-ls.io',
      devA.browser.getRawLocalStorage('https://offline-ls.io'),
    );

    // Stale keys MUST be wiped from browser AND must NOT leak into track2!
    expect(devA.browser.getRawLocalStorage('https://offline-ls.io')).toEqual({});
    expect(devA.browser.reloadedTabIds).toContain(tab2);
    const track2Ls = await devA.engine.getLocalStorageRecords({
      siteKey: 'offline-ls.io',
      trackId: track2.trackId,
    });
    expect(track2Ls.filter((r) => !r.deleted)).toEqual([]);

    // Now log in as Bob on track2, then close tab
    devA.browser.seedLocalStorage('https://offline-ls.io', {
      auth_user: 'bob',
      bob_only: 'b_secret',
    });
    await devA.engine.ingestLocalStorageMutations('https://offline-ls.io', [
      { key: 'auth_user', value: 'bob' },
      { key: 'bob_only', value: 'b_secret' },
    ]);
    devA.browser.closeTab(tab2);

    // Switch back to Account 1 while tab closed -> next page mount wipes bob_only and restores alice's LS!
    await devA.engine.switchSiteTrack('offline-ls.io', track1.trackId);
    devA.browser.openTab('https://offline-ls.io/app', { active: true, safeToReload: true });
    await devA.engine.ingestLocalStorageSnapshot(
      'https://offline-ls.io',
      devA.browser.getRawLocalStorage('https://offline-ls.io'),
    );
    expect(devA.browser.getRawLocalStorage('https://offline-ls.io')).toEqual({
      auth_user: 'alice',
      role: 'owner',
      stale_extra: 'must_vanish',
    });
  });

  it('MA-008: Ad-hoc env injection defers LocalStorage when target localhost tab is closed and hydrates cleanly upon mount', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    devA.browser.seedCookie({ domain: '.prod-src.io', name: 'sid', value: 'prod_sid_9' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    const prodTab = devA.browser.openTab('https://prod-src.io/app', { active: true });
    devA.browser.seedLocalStorage('https://prod-src.io', {
      auth_token: 'ls_prod_tok',
      role: 'admin',
    });
    await devA.engine.ingestLocalStorageSnapshot('https://prod-src.io', {
      auth_token: 'ls_prod_tok',
      role: 'admin',
    });
    expect(prodTab).toBeGreaterThan(0);

    // Execute ad-hoc env injection BEFORE http://localhost:4100 tab is open
    const res = await devA.engine.executeEnvCookieSync({
      adHoc: {
        sourceSiteKey: 'prod-src.io',
        targetUrl: 'http://localhost:4100',
        syncCookies: true,
        syncLocalStorage: true,
        cleanTargetBeforeSync: true,
        autoReloadTarget: true,
      },
    });
    expect(res.appliedCookies).toBeGreaterThanOrEqual(1);
    expect(devA.browser.findJarCookie('sid', 'localhost')?.value).toBe('prod_sid_9');

    // Developer now opens http://localhost:4100/home -> mount triggers deferred hydration + single reload!
    devA.browser.seedLocalStorage('https://ignored.example', {});
    devA.browser.seedLocalStorage('http://localhost:4100', { old_dev_trash: 'stale_val' });
    const devTab = devA.browser.openTab('http://localhost:4100/home', {
      active: true,
      safeToReload: true,
    });
    await devA.engine.ingestLocalStorageSnapshot('http://localhost:4100', {
      old_dev_trash: 'stale_val',
    });

    expect(devA.browser.getRawLocalStorage('http://localhost:4100')).toEqual({
      auth_token: 'ls_prod_tok',
      role: 'admin',
    });
    expect(devA.browser.reloadedTabIds).toContain(devTab);
  });

  it('MA-009: Reverse env sync on a rule pinned to an inactive track writes cookies/LS to that inactive track without polluting active browser jar', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    devA.browser.seedCookie({ domain: '.multi-rev.io', name: 'sid', value: 'admin_live_1' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    const track2 = await devA.engine.createSiteAccountTrack('multi-rev.io', {
      mode: 'clean_new',
      label: 'Beta Ops',
      triggerRefresh: false,
    });
    await devA.browser.simulateUserCookieSet({
      domain: '.multi-rev.io',
      name: 'sid',
      value: 'beta_2',
    });

    // Switch back to Track 1 so Track 2 (Beta Ops) is INACTIVE
    const ov = await devA.engine.getSitesOverview();
    const track1 = ov
      .find((s) => s.siteKey === 'multi-rev.io')!
      .allTracks.find((t) => t.trackId !== track2.trackId)!;
    await devA.engine.switchSiteTrack('multi-rev.io', track1.trackId);

    const pinnedRule = await devA.engine.upsertEnvSyncRule({
      scope: 'device',
      enabled: true,
      sourceSiteKey: 'multi-rev.io',
      sourceTrackId: track2.trackId,
      targetUrl: 'http://localhost:3900',
      syncCookies: true,
      syncLocalStorage: true,
      adaptForHttp: true,
      cleanTargetBeforeSync: true,
      autoSync: false,
      autoReloadTarget: false,
    });

    // Modify cookie + LS on localhost:3900 and run reverse sync on pinned inactive track2
    devA.browser.seedCookie({
      domain: 'localhost',
      hostOnly: true,
      name: 'dev_minted_rev',
      value: 'rev_beta_only',
      secure: false,
    });
    devA.browser.openTab('http://localhost:3900/', { active: false });
    devA.browser.seedLocalStorage('http://localhost:3900', { dev_ls_back: 'beta_ls_99' });

    const revRes = await devA.engine.executeEnvCookieSync({
      ruleId: pinnedRule.id,
      reverse: true,
    });
    expect(revRes.appliedCookies).toBeGreaterThanOrEqual(1);
    expect(revRes.appliedLocalStorage).toBe(1);

    // Active track (Track 1: admin_live_1) in browser jar MUST NOT receive dev_minted_rev!
    expect(devA.browser.findJarCookie('sid', 'multi-rev.io')?.value).toBe('admin_live_1');
    expect(devA.browser.findJarCookie('dev_minted_rev', 'multi-rev.io')).toBeUndefined();

    // Inactive Track 2 MUST now contain dev_minted_rev + dev_ls_back!
    const t2Cookies = await devA.engine.getSiteCookies('multi-rev.io', track2.trackId);
    expect(t2Cookies.find((c) => c.name === 'dev_minted_rev')?.value).toBe('rev_beta_only');
    const t2Ls = await devA.engine.getLocalStorageRecords({
      siteKey: 'multi-rev.io',
      trackId: track2.trackId,
    });
    expect(t2Ls.find((r) => r.key === 'dev_ls_back')?.value).toBe('beta_ls_99');
  });

  it('MA-010: Safety undo point restores previous LocalStorage cleanly even when target origin tab was closed during applyUndoPoint', async () => {
    const { webdav, harness: h } = setup();
    const devA = await h.createDevice('Device-A');

    const tab1 = devA.browser.openTab('https://undo-ls.io/app', { active: true, safeToReload: true });
    devA.browser.seedCookie({ domain: '.undo-ls.io', name: 'sid', value: 'orig_user_sid' });
    devA.browser.seedLocalStorage('https://undo-ls.io', {
      auth_user: 'orig_user',
      role: 'founder',
    });

    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
    });

    await devA.engine.createSiteAccountTrack('undo-ls.io', {
      mode: 'clean_new',
      label: 'Temp Slot',
      triggerRefresh: false,
    });
    devA.browser.seedLocalStorage('https://undo-ls.io', {
      auth_user: 'temp_user',
      temp_extra: 'must_go',
    });
    await devA.engine.ingestLocalStorageSnapshot('https://undo-ls.io', {
      auth_user: 'temp_user',
      temp_extra: 'must_go',
    });

    // Close the site tab BEFORE clicking applyUndoPoint
    devA.browser.closeTab(tab1);
    const undos = await devA.engine.getUndoPoints();
    expect(undos.length).toBeGreaterThanOrEqual(1);
    await devA.engine.applyUndoPoint(undos[0].undoId);

    // Cookies restore immediately; LS restores when user next opens undo-ls.io!
    expect(devA.browser.findJarCookie('sid', 'undo-ls.io')?.value).toBe('orig_user_sid');
    const reopenedTab = devA.browser.openTab('https://undo-ls.io/app', {
      active: true,
      safeToReload: true,
    });
    await devA.engine.ingestLocalStorageSnapshot(
      'https://undo-ls.io',
      devA.browser.getRawLocalStorage('https://undo-ls.io'),
    );

    expect(devA.browser.getRawLocalStorage('https://undo-ls.io')).toEqual({
      auth_user: 'orig_user',
      role: 'founder',
    });
    expect(devA.browser.reloadedTabIds).toContain(reopenedTab);
  });

  it('MA-011: on_page_leave holds pending uploads when pagehide fires during same-site navigation or while another tab stays open, then flushes on last tab close', async () => {
    const { dav, webdav, harness: h } = setup();
    const devA = await h.createDevice(
      'Device-A',
      undefined,
      { defaultSyncTimingMode: 'on_page_leave' },
    );

    const tab1 = devA.browser.openTab('https://same-nav.io/login', { active: true });
    devA.browser.seedCookie({ domain: '.same-nav.io', name: 'sid', value: 'init_1' });
    await devA.engine.saveAndJoinSpace({
      webdav,
      spaceId: SPACE_ID,
      spaceName: SPACE_NAME,
      encryptionPassword: ENC_PASS,
      deviceName: 'Device-A',
      settingsPatch: { syncScopeMode: 'managed_only', syncTimingMode: 'on_page_leave' },
      initialManagedSiteKeys: ['same-nav.io'],
    });

    const batchesBefore = dav.listAllStoredPaths().filter((p) => p.includes('/events/')).length;

    // Simulate same-site navigation (/login -> /dashboard): Set-Cookie mutates while tab1 stays on same-nav.io,
    // and old page fires pagehide -> onSitePageLeft while tab1 is STILL open on same-nav.io!
    await devA.browser.simulateUserCookieSet({
      domain: '.same-nav.io',
      name: 'nav_ck',
      value: 'keep_buffered',
    });
    await devA.engine.onSitePageLeft('https://same-nav.io');

    // Must remain buffered locally (0 extra WebDAV event batches uploaded!)
    expect(dav.listAllStoredPaths().filter((p) => p.includes('/events/')).length).toBe(batchesBefore);
    expect((await devA.engine.getStatusSummary()).pendingUploads).toBeGreaterThanOrEqual(1);

    // User actually leaves/closes the last tab -> now flushes to WebDAV!
    devA.browser.closeTab(tab1);
    await devA.engine.onSitePageLeft('https://same-nav.io');
    expect(dav.listAllStoredPaths().filter((p) => p.includes('/events/')).length).toBeGreaterThan(batchesBefore);
    expect((await devA.engine.getStatusSummary()).pendingUploads).toBe(0);
  });
});
