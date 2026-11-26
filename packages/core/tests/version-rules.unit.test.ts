import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPACE_SETTINGS,
  type BlacklistEntry,
  type BrowserCookieInput,
  type CausalVersion,
  type CookieRecord,
  type DeviceCheckpoint,
  type DeviceSiteBinding,
  type LocalStorageRecord,
  type SiteTrack,
  type SpaceRuleSet,
  type SsoDomainGroup,
  type Tombstone,
} from '../src/types';
import {
  domainMatchesSiteKey,
  getRegistrableDomain,
  isAnalyticsNoiseCookie,
  normalizeDomain,
  resolveSiteKey,
} from '../src/psl';
import {
  HlcClock,
  applyUserSiteDecision,
  buildCookieLogicalId,
  buildLocalStorageLogicalId,
  compareHlcDeterministic,
  compareVectorClocks,
  createNextCausalVersion,
  evaluateSiteDiscovery,
  incrementVectorClock,
  mergeVectorClocks,
  resolveItemMerge,
  updateTombstoneReclaimability,
} from '../src/version';
import { RulesEngine, buildPresetBlacklistEntries } from '../src/rules';

// ---------------------------------------------------------------------------
// Test Builders
// ---------------------------------------------------------------------------

function makeBrowserCookie(overrides: Partial<BrowserCookieInput> = {}): BrowserCookieInput {
  return {
    domain: '.github.com',
    name: 'user_session',
    value: 'sess_abc',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    session: false,
    expirationDate: 1900000000,
    hostOnly: false,
    ...overrides,
  };
}

function makeVersion(
  deviceId: string,
  deviceSeq: number,
  physicalMs: number,
  logical: number,
  vectorClock: Record<string, number>,
): CausalVersion {
  return {
    hlc: { physicalMs, logical, deviceId },
    vectorClock,
    deviceId,
    deviceSeq,
    versionId: `${deviceId}:${deviceSeq}:${physicalMs}.${logical}`,
  };
}

function makeCookieRecord(
  version: CausalVersion,
  overrides: Partial<CookieRecord> = {},
): CookieRecord {
  const trackId = overrides.trackId ?? 'trk_devA_github.com';
  const domain = overrides.domain ?? '.github.com';
  const path = overrides.path ?? '/';
  const name = overrides.name ?? 'user_session';
  const hostOnly = overrides.hostOnly ?? false;
  return {
    logicalId:
      overrides.logicalId ??
      buildCookieLogicalId({
        trackId,
        hostOnly,
        domain,
        path,
        name,
      }),
    siteKey: overrides.siteKey ?? 'github.com',
    trackId,
    domain,
    path,
    name,
    value: overrides.value ?? `val_${version.deviceId}_${version.deviceSeq}`,
    storeScope: overrides.storeScope ?? 'default',
    partitionKey: overrides.partitionKey ?? null,
    secure: overrides.secure ?? true,
    httpOnly: overrides.httpOnly ?? true,
    sameSite: overrides.sameSite ?? 'lax',
    session: overrides.session ?? false,
    expirationDate: overrides.expirationDate ?? 1900000000,
    hostOnly,
    version,
    sourceDevice: overrides.sourceDevice ?? version.deviceId,
    deleted: overrides.deleted ?? false,
    updatedAt: overrides.updatedAt ?? version.hlc.physicalMs,
    ...overrides,
  };
}

function makeLsRecord(
  version: CausalVersion,
  overrides: Partial<LocalStorageRecord> = {},
): LocalStorageRecord {
  const trackId = overrides.trackId ?? 'trk_devA_github.com';
  const origin = overrides.origin ?? 'https://github.com';
  const key = overrides.key ?? 'auth_token';
  return {
    logicalId: overrides.logicalId ?? buildLocalStorageLogicalId(trackId, origin, key),
    siteKey: overrides.siteKey ?? 'github.com',
    trackId,
    origin,
    key,
    value: overrides.value ?? `ls_${version.deviceId}_${version.deviceSeq}`,
    version,
    sourceDevice: overrides.sourceDevice ?? version.deviceId,
    deleted: overrides.deleted ?? false,
    updatedAt: overrides.updatedAt ?? version.hlc.physicalMs,
    ...overrides,
  };
}

function makeTombstone(
  objectId: string,
  deleteVersion: CausalVersion,
  overrides: Partial<Tombstone> = {},
): Tombstone {
  return {
    objectId,
    objectType: overrides.objectType ?? 'cookie',
    siteKey: overrides.siteKey ?? 'github.com',
    trackId: overrides.trackId ?? 'trk_devA_github.com',
    deleteVersion,
    previousVersion: overrides.previousVersion ?? null,
    sourceDevice: overrides.sourceDevice ?? deleteVersion.deviceId,
    reason: overrides.reason ?? 'logout',
    createdAt: overrides.createdAt ?? deleteVersion.hlc.physicalMs,
    acknowledgedDevices: overrides.acknowledgedDevices ?? [deleteVersion.deviceId],
    reclaimable: overrides.reclaimable ?? false,
  };
}

function makeTrack(overrides: Partial<SiteTrack> = {}): SiteTrack {
  const siteKey = overrides.siteKey ?? 'github.com';
  const originDeviceId = overrides.originDeviceId ?? 'devA';
  return {
    trackId: overrides.trackId ?? `trk_${originDeviceId}_${siteKey}`,
    siteKey,
    label: overrides.label ?? 'Device A 的版本',
    originDeviceId,
    originDeviceName: overrides.originDeviceName ?? 'Device A',
    cookieCount: overrides.cookieCount ?? 3,
    localStorageCount: overrides.localStorageCount ?? 1,
    updatedAt: overrides.updatedAt ?? 1700000000000,
    memberDeviceIds: overrides.memberDeviceIds ?? [originDeviceId],
    revision: overrides.revision ?? 1,
  };
}

// ---------------------------------------------------------------------------
// 1. PSL & Domain Grouping Engine
// ---------------------------------------------------------------------------

describe('psl: normalizeDomain, getRegistrableDomain, SSO grouping, noise cookies', () => {
  it('normalizes domains, URLs, ports, leading/trailing dots, localhost, IPv4, and IPv6', () => {
    expect(normalizeDomain('  .GitHub.COM  ')).toBe('github.com');
    expect(normalizeDomain('..sub.Example.COM.:8443')).toBe('sub.example.com');
    expect(normalizeDomain('https://Passport.BiliBili.com:443/login?next=/')).toBe(
      'passport.bilibili.com',
    );
    expect(normalizeDomain('LOCALHOST:3000')).toBe('localhost');
    expect(normalizeDomain('http://127.0.0.1:8080/api')).toBe('127.0.0.1');
    expect(normalizeDomain('192.168.1.10:9000')).toBe('192.168.1.10');
    expect(normalizeDomain('[::1]:8080')).toBe('[::1]');
    expect(normalizeDomain('::1')).toBe('[::1]');
    expect(normalizeDomain('http://[::1]:3000/test')).toBe('[::1]');
    expect(normalizeDomain('2001:DB8::1')).toBe('[2001:db8::1]');
    expect(normalizeDomain('')).toBe('');
    expect(normalizeDomain('   ')).toBe('');
  });

  it('extracts eTLD+1 across standard TLDs and all multi-label public suffixes', () => {
    // Standard TLDs
    expect(getRegistrableDomain('.github.com')).toBe('github.com');
    expect(getRegistrableDomain('https://passport.bilibili.com/login')).toBe('bilibili.com');
    expect(getRegistrableDomain('a.b.c.example.org')).toBe('example.org');

    // Multi-label country & hosting public suffixes
    const cases: Array<[string, string]> = [
      ['mail.icbc.com.cn', 'icbc.com.cn'],
      ['a.b.example.net.cn', 'example.net.cn'],
      ['portal.org.cn', 'portal.org.cn'],
      ['www.beijing.gov.cn', 'beijing.gov.cn'],
      ['cs.tsinghua.edu.cn', 'tsinghua.edu.cn'],
      ['news.bbc.co.uk', 'bbc.co.uk'],
      ['www.wikimedia.org.uk', 'wikimedia.org.uk'],
      ['mail.ox.ac.uk', 'ox.ac.uk'],
      ['shop.rakuten.co.jp', 'rakuten.co.jp'],
      ['dns.ocn.ne.jp', 'ocn.ne.jp'],
      ['app.bank.com.au', 'bank.com.au'],
      ['news.scmp.com.hk', 'scmp.com.hk'],
      ['shop.pchome.com.tw', 'pchome.com.tw'],
      ['portal.dbs.com.sg', 'dbs.com.sg'],
      ['mail.naver.co.kr', 'naver.co.kr'],
      ['sub.myuser.github.io', 'myuser.github.io'],
      ['myuser.github.io', 'myuser.github.io'],
      ['preview.my-app.vercel.app', 'my-app.vercel.app'],
      ['branch.docs.pages.dev', 'docs.pages.dev'],
      ['demo.site.netlify.app', 'site.netlify.app'],
      ['v1.myproj.appspot.com', 'myproj.appspot.com'],
    ];

    for (const [input, expected] of cases) {
      expect(getRegistrableDomain(input), `failed for ${input}`).toBe(expected);
    }

    // Bare multi-label suffix returns itself
    expect(getRegistrableDomain('github.io')).toBe('github.io');

    // Special hosts: localhost & IPs
    expect(getRegistrableDomain('http://localhost:5173/dashboard')).toBe('localhost');
    expect(getRegistrableDomain('http://127.0.0.1:8080/')).toBe('127.0.0.1');
    expect(getRegistrableDomain('http://[::1]:8080/')).toBe('[::1]');
  });

  it('maps linked SSO domains via resolveSiteKey and verifies domainMatchesSiteKey', () => {
    const ssoGroups: SsoDomainGroup[] = [
      {
        groupId: 'sso_alibaba',
        name: 'Alibaba Ecosystem',
        primarySiteKey: 'taobao.com',
        domains: ['taobao.com', 'tmall.com', '*.alicdn.com', 'login.alibaba.com'],
      },
      {
        groupId: 'sso_github',
        name: 'GitHub',
        primarySiteKey: 'github.com',
        domains: ['github.com', 'githubusercontent.com'],
      },
    ];

    expect(resolveSiteKey('https://detail.tmall.com/item.htm', ssoGroups)).toBe('taobao.com');
    expect(resolveSiteKey('.img.alicdn.com', ssoGroups)).toBe('taobao.com');
    expect(resolveSiteKey('login.alibaba.com', ssoGroups)).toBe('taobao.com');
    // Unrelated subdomain of alibaba.com not matched by login.alibaba.com
    expect(resolveSiteKey('www.alibaba.com', ssoGroups)).toBe('alibaba.com');
    expect(resolveSiteKey('raw.githubusercontent.com', ssoGroups)).toBe('github.com');
    expect(resolveSiteKey('docs.python.org', ssoGroups)).toBe('python.org');

    // domainMatchesSiteKey
    expect(domainMatchesSiteKey('.tmall.com', 'taobao.com', ssoGroups)).toBe(true);
    expect(domainMatchesSiteKey('sub.tmall.com', 'taobao.com', ssoGroups)).toBe(true);
    expect(domainMatchesSiteKey('.api.github.com', 'github.com', ssoGroups)).toBe(true);
    expect(domainMatchesSiteKey('raw.githubusercontent.com', 'github.com', ssoGroups)).toBe(true);
    expect(domainMatchesSiteKey('evilgithub.com', 'github.com', ssoGroups)).toBe(false);
    expect(domainMatchesSiteKey('otheruser.github.io', 'myuser.github.io')).toBe(false);
    expect(domainMatchesSiteKey('sub.myuser.github.io', 'myuser.github.io')).toBe(true);
  });

  it('filters pure analytics/tracking noise cookies while never filtering auth/session cookies', () => {
    const noiseCookies = [
      '_ga',
      '_ga_ABCDEF1234',
      '_gid',
      '_gat',
      '_gat_gtag_UA_123456_1',
      '_gat_UA-99999-1',
      '_fbp',
      '_fbc',
      'hm_lvt_a1b2c3d4',
      'Hm_lvt_a1b2c3d4',
      'hm_lpvt_a1b2c3d4',
      'Hm_lpvt_a1b2c3d4',
      '_clck',
      '_clsk',
      '__utma',
      '__utmb',
      '__utmc',
      '__utmz',
      'mp_9a8b7c_mixpanel',
    ];
    for (const name of noiseCookies) {
      expect(isAnalyticsNoiseCookie(name), `expected noise: ${name}`).toBe(true);
    }

    const authCookies = [
      'session',
      'session_id',
      'JSESSIONID',
      'PHPSESSID',
      'connect.sid',
      'user_session',
      '_gh_sess',
      'dotcom_user',
      'SESSDATA',
      'DedeUserID',
      'bili_jct',
      'auth_token',
      'access_token',
      'refresh_token',
      'csrftoken',
      '__Host-next-auth.session-token',
      '__Secure-3PSID',
      'SID',
      'HSID',
      'ga_auth_token',
      '_gate_session',
      'mixpanel_auth',
    ];
    for (const name of authCookies) {
      expect(isAnalyticsNoiseCookie(name), `must NOT filter auth cookie: ${name}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Logical IDs, HLC Clock Skew & Vector Clock Causality
// ---------------------------------------------------------------------------

describe('version: logical IDs, HLC clock skew, VectorClock causal comparison', () => {
  it('builds exact canonical logical IDs isolating track, storeScope, partitionKey, hostOnly, origin', () => {
    expect(
      buildCookieLogicalId({
        trackId: 'trk_devA_github.com',
        hostOnly: false,
        domain: '.GitHub.COM',
        path: '/',
        name: 'user_session',
      }),
    ).toBe('cookie::trk_devA_github.com::default::none::d:github.com::/::user_session');

    expect(
      buildCookieLogicalId({
        trackId: 'trk_devA_github.com',
        storeScope: 'store-1',
        partitionKey: { topLevelSite: 'https://embedder.example' },
        hostOnly: true,
        domain: 'api.github.com',
        path: '/v1',
        name: '__Host-sid',
      }),
    ).toBe(
      'cookie::trk_devA_github.com::store-1::https://embedder.example::h:api.github.com::/v1::__Host-sid',
    );

    // hostOnly vs domain cookie on same domain+path+name MUST have distinct IDs
    const hostId = buildCookieLogicalId({
      trackId: 'trk_1',
      hostOnly: true,
      domain: 'example.com',
      path: '/',
      name: 'sid',
    });
    const domainId = buildCookieLogicalId({
      trackId: 'trk_1',
      hostOnly: false,
      domain: '.example.com',
      path: '/',
      name: 'sid',
    });
    expect(hostId).not.toBe(domainId);

    // LocalStorage logical ID preserves strict scheme + host + port isolation
    expect(buildLocalStorageLogicalId('trk_1', 'https://github.com', 'theme')).toBe(
      'ls::trk_1::https://github.com::theme',
    );
    expect(buildLocalStorageLogicalId('trk_1', 'https://GitHub.com:443/', 'theme')).toBe(
      'ls::trk_1::https://github.com::theme',
    );
    expect(buildLocalStorageLogicalId('trk_1', 'https://github.com:8443', 'theme')).not.toBe(
      buildLocalStorageLogicalId('trk_1', 'https://github.com', 'theme'),
    );
    expect(buildLocalStorageLogicalId('trk_1', 'http://github.com', 'theme')).not.toBe(
      buildLocalStorageLogicalId('trk_1', 'https://github.com', 'theme'),
    );
  });

  it('maintains strict HLC monotonicity under large physical clock skew and backwards jumps', () => {
    const T0 = 1_700_000_000_000;
    const FIVE_HOURS = 5 * 60 * 60 * 1000;

    // Device A runs 5 hours ahead of real time
    const clockA = new HlcClock('devA');
    const hlcA1 = clockA.tick(T0 + FIVE_HOURS);
    expect(hlcA1).toEqual({ physicalMs: T0 + FIVE_HOURS, logical: 0, deviceId: 'devA' });

    // Device B runs at normal time (5 hours behind A)
    const clockB = new HlcClock('devB');
    const hlcB0 = clockB.tick(T0);
    expect(hlcB0).toEqual({ physicalMs: T0, logical: 0, deviceId: 'devB' });

    // B receives A's message from the future -> B's HLC leaps forward cleanly
    const hlcB1 = clockB.receive(hlcA1, T0 + 1000);
    expect(hlcB1.physicalMs).toBe(T0 + FIVE_HOURS);
    expect(hlcB1.logical).toBe(1);
    expect(hlcB1.deviceId).toBe('devB');

    // B's local clock jumps backwards by 2 hours -> logical counter strictly increments
    const hlcB2 = clockB.tick(T0 - 2 * 3600 * 1000);
    expect(hlcB2.physicalMs).toBe(T0 + FIVE_HOURS);
    expect(hlcB2.logical).toBe(2);

    // Receiving another event with identical physicalMs & higher logical takes max(logical) + 1
    const hlcB3 = clockB.receive(
      { physicalMs: T0 + FIVE_HOURS, logical: 10, deviceId: 'devC' },
      T0,
    );
    expect(hlcB3).toEqual({ physicalMs: T0 + FIVE_HOURS, logical: 11, deviceId: 'devB' });

    // Returned snapshots are defensive copies
    hlcB3.logical = 999;
    expect(clockB.current().logical).toBe(11);
  });

  it('compares VectorClocks purely causally and is immune to physical clock skew', () => {
    expect(compareVectorClocks({}, {})).toBe('EQUAL');
    expect(compareVectorClocks({ devA: 0 }, {})).toBe('EQUAL');
    expect(compareVectorClocks({ devA: 2, devB: 1 }, { devA: 2, devB: 1 })).toBe('EQUAL');
    expect(compareVectorClocks({ devA: 3, devB: 1 }, { devA: 2, devB: 1 })).toBe('LOCAL_NEWER');
    expect(compareVectorClocks({ devA: 2, devB: 1 }, { devA: 2, devB: 2 })).toBe('REMOTE_NEWER');
    expect(compareVectorClocks({ devA: 2, devB: 1 }, { devA: 1, devB: 2 })).toBe('CONCURRENT');

    const base = { devA: 1 };
    const inc = incrementVectorClock(base, 'devA');
    expect(base).toEqual({ devA: 1 }); // pure
    expect(inc).toEqual({ devA: 2 });
    expect(incrementVectorClock(inc, 'devB', 5)).toEqual({ devA: 2, devB: 5 });
    expect(mergeVectorClocks({ devA: 3, devB: 1 }, { devA: 1, devB: 4, devC: 2 })).toEqual({
      devA: 3,
      devB: 4,
      devC: 2,
    });

    // Skewed physical clocks: Device A's wall clock is +24h ahead, Device B is -24h behind,
    // yet B causally observed A's write and produced seq=1 -> B MUST dominate A!
    const vA = makeVersion('devA', 1, 1_900_000_000_000, 0, { devA: 1 });
    const vB = makeVersion('devB', 1, 1_500_000_000_000, 0, { devA: 1, devB: 1 });
    expect(compareVectorClocks(vA.vectorClock, vB.vectorClock)).toBe('REMOTE_NEWER');
  });

  it('breaks ties deterministically via compareHlcDeterministic & createNextCausalVersion', () => {
    const clock = new HlcClock('devA');
    const v1 = createNextCausalVersion({
      clock,
      baseVectorClock: { devB: 2 },
      deviceId: 'devA',
      nextDeviceSeq: 1,
      nowMs: 1000,
    });
    expect(v1.vectorClock).toEqual({ devA: 1, devB: 2 });
    expect(v1.deviceSeq).toBe(1);
    expect(v1.hlc).toEqual({ physicalMs: 1000, logical: 0, deviceId: 'devA' });

    const a = makeVersion('devA', 1, 1000, 0, { devA: 1 });
    const b = makeVersion('devB', 1, 1000, 0, { devB: 1 });
    expect(compareHlcDeterministic(a, b)).toBeLessThan(0);
    expect(compareHlcDeterministic(b, a)).toBeGreaterThan(0);

    // Logical breaks tie when physicalMs matches
    const aLogical = makeVersion('devA', 2, 1000, 3, { devA: 2 });
    expect(compareHlcDeterministic(aLogical, b)).toBeGreaterThan(0);

    // Event ID breaks tie if everything else is equal
    expect(compareHlcDeterministic(a, a, 'evt_1', 'evt_2')).toBeLessThan(0);
    expect(compareHlcDeterministic(a, a, 'evt_2', 'evt_1')).toBeGreaterThan(0);
    expect(compareHlcDeterministic(a, a, 'evt_1', 'evt_1')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Item Merge, Tombstone Non-Resurrection & 3-Way Convergence
// ---------------------------------------------------------------------------

describe('version: resolveItemMerge, tombstone non-resurrection, 3-way convergence, reclaimability', () => {
  it('handles causal dominance for records (LOCAL_NEWER, REMOTE_NEWER, EQUAL, missing sides)', () => {
    const v1 = makeVersion('devA', 1, 1000, 0, { devA: 1 });
    const v2 = makeVersion('devB', 1, 900, 0, { devA: 1, devB: 1 }); // physically earlier, causally newer!
    const r1 = makeCookieRecord(v1, { value: 'old' });
    const r2 = makeCookieRecord(v2, { value: 'new' });

    // Empty merge
    expect(resolveItemMerge({ spaceId: 'sp1' })).toEqual({
      comparison: 'EQUAL',
      winner: 'local',
      changedLocal: false,
    });

    // Remote only -> adopt remote
    const remoteOnly = resolveItemMerge({ spaceId: 'sp1', remoteRecord: r1 });
    expect(remoteOnly.winner).toBe('remote');
    expect(remoteOnly.changedLocal).toBe(true);
    expect(remoteOnly.record?.value).toBe('old');

    // Local only -> keep local
    const localOnly = resolveItemMerge({ spaceId: 'sp1', localRecord: r1 });
    expect(localOnly.winner).toBe('local');
    expect(localOnly.changedLocal).toBe(false);

    // Remote causally newer (even with older wall clock!) -> remote wins
    const remoteNewer = resolveItemMerge({
      spaceId: 'sp1',
      localRecord: r1,
      remoteRecord: r2,
    });
    expect(remoteNewer.comparison).toBe('REMOTE_NEWER');
    expect(remoteNewer.winner).toBe('remote');
    expect(remoteNewer.record?.value).toBe('new');
    expect(remoteNewer.changedLocal).toBe(true);
    expect(remoteNewer.conflict).toBeUndefined();

    // Local causally newer -> local wins
    const localNewer = resolveItemMerge({
      spaceId: 'sp1',
      localRecord: r2,
      remoteRecord: r1,
    });
    expect(localNewer.comparison).toBe('LOCAL_NEWER');
    expect(localNewer.winner).toBe('local');
    expect(localNewer.record?.value).toBe('new');
    expect(localNewer.changedLocal).toBe(false);

    // Equal -> unchanged
    const eq = resolveItemMerge({ spaceId: 'sp1', localRecord: r1, remoteRecord: r1 });
    expect(eq.comparison).toBe('EQUAL');
    expect(eq.changedLocal).toBe(false);
  });

  it('enforces Prohibition #4: older or equal record NEVER resurrects a Tombstone, while post-delete causal successor does', () => {
    const vCreate = makeVersion('devA', 1, 1000, 0, { devA: 1 });
    const vDelete = makeVersion('devB', 1, 2000, 0, { devA: 1, devB: 1 });
    const vReLogin = makeVersion('devA', 2, 3000, 0, { devA: 2, devB: 1 });

    const oldRec = makeCookieRecord(vCreate, { value: 'stale_session' });
    const tomb = makeTombstone(oldRec.logicalId, vDelete);
    const equalRec = makeCookieRecord(vDelete, { value: 'same_vc_zombie' });
    const newRec = makeCookieRecord(vReLogin, { value: 'fresh_login' });

    // Local has tombstone, remote replays older record -> tombstone wins, NO resurrection
    const staleReplay = resolveItemMerge({
      spaceId: 'sp1',
      localTombstone: tomb,
      remoteRecord: oldRec,
    });
    expect(staleReplay.winner).toBe('tombstone');
    expect(staleReplay.tombstone).toEqual(tomb);
    expect(staleReplay.record).toBeUndefined();
    expect(staleReplay.changedLocal).toBe(false);

    // Local has tombstone, remote sends record with equal vector clock -> tombstone still wins!
    const equalReplay = resolveItemMerge({
      spaceId: 'sp1',
      localTombstone: tomb,
      remoteRecord: equalRec,
    });
    expect(equalReplay.winner).toBe('tombstone');
    expect(equalReplay.changedLocal).toBe(false);

    // Local has older record, remote sends newer tombstone -> tombstone wins & deletes local
    const remoteDel = resolveItemMerge({
      spaceId: 'sp1',
      localRecord: oldRec,
      remoteTombstone: tomb,
    });
    expect(remoteDel.comparison).toBe('REMOTE_NEWER');
    expect(remoteDel.winner).toBe('tombstone');
    expect(remoteDel.tombstone).toEqual(tomb);
    expect(remoteDel.changedLocal).toBe(true);

    // Local has tombstone, remote sends causally strictly newer post-delete re-login -> remote wins!
    const reLogin = resolveItemMerge({
      spaceId: 'sp1',
      localTombstone: tomb,
      remoteRecord: newRec,
    });
    expect(reLogin.comparison).toBe('REMOTE_NEWER');
    expect(reLogin.winner).toBe('remote');
    expect(reLogin.record?.value).toBe('fresh_login');
    expect(reLogin.changedLocal).toBe(true);

    // Local has BOTH stale record and newer tombstone on same side -> tombstone takes precedence
    const sameSideStale = resolveItemMerge({
      spaceId: 'sp1',
      localRecord: oldRec,
      localTombstone: tomb,
      remoteRecord: oldRec,
    });
    expect(sameSideStale.winner).toBe('tombstone');
    expect(sameSideStale.changedLocal).toBe(false);
  });

  it('resolves concurrent updates deterministically across all 6 permutations of A/B/C and emits ConflictRecord', () => {
    const vA = makeVersion('devA', 1, 5000, 0, { devA: 1 });
    const vB = makeVersion('devB', 1, 5000, 0, { devB: 1 });
    const vC = makeVersion('devC', 1, 5000, 0, { devC: 1 });

    const rA = makeCookieRecord(vA, { value: 'token_A' });
    const rB = makeCookieRecord(vB, { value: 'token_B' });
    const rC = makeCookieRecord(vC, { value: 'token_C' });

    const permutations: Array<[CookieRecord, CookieRecord, CookieRecord]> = [
      [rA, rB, rC],
      [rA, rC, rB],
      [rB, rA, rC],
      [rB, rC, rA],
      [rC, rA, rB],
      [rC, rB, rA],
    ];

    for (const [first, second, third] of permutations) {
      const step1 = resolveItemMerge({
        spaceId: 'sp1',
        localRecord: first,
        remoteRecord: second,
      });
      expect(step1.comparison).toBe('CONCURRENT');
      expect(step1.conflict).toBeDefined();
      expect(step1.conflict?.resolved).toBe(false);
      expect(step1.conflict?.resolvedBy).toBe('auto');
      expect(step1.record).toBeDefined();

      const step2 = resolveItemMerge({
        spaceId: 'sp1',
        localRecord: step1.record,
        remoteRecord: third,
      });
      expect(step2.comparison).toBe('CONCURRENT');
      expect(step2.record?.value).toBe('token_C'); // devC > devB > devA at equal HLC (5000, 0)
    }
  });

  it('converges symmetrically on concurrent record update vs concurrent delete (including LocalStorage)', () => {
    const vUpdate = makeVersion('devA', 2, 6000, 0, { devA: 2 });
    const vDelete = makeVersion('devB', 2, 6000, 0, { devB: 2 }); // devB > devA at same HLC -> tombstone wins

    const lsRec = makeLsRecord(vUpdate, { value: 'updated_ls' });
    const lsTomb = makeTombstone(lsRec.logicalId, vDelete, { objectType: 'localStorage' });

    // Perspective 1: Local has record, remote sends concurrent delete
    const fromA = resolveItemMerge({
      spaceId: 'sp1',
      localRecord: lsRec,
      remoteTombstone: lsTomb,
    });
    expect(fromA.comparison).toBe('CONCURRENT');
    expect(fromA.winner).toBe('tombstone');
    expect(fromA.tombstone).toEqual(lsTomb);
    expect(fromA.changedLocal).toBe(true);
    expect(fromA.conflict).toBeDefined();
    expect(fromA.conflict?.objectType).toBe('localStorage');
    expect(fromA.conflict?.winningSide).toBe('remote');

    // Perspective 2: Local has tombstone, remote sends concurrent update
    const fromB = resolveItemMerge({
      spaceId: 'sp1',
      localTombstone: lsTomb,
      remoteRecord: lsRec,
    });
    expect(fromB.comparison).toBe('CONCURRENT');
    expect(fromB.winner).toBe('tombstone');
    expect(fromB.tombstone).toEqual(lsTomb);
    expect(fromB.changedLocal).toBe(false);
    expect(fromB.conflict).toBeDefined();
    expect(fromB.conflict?.winningSide).toBe('local');

    // Reverse: Update has higher HLC than concurrent delete -> record wins on BOTH sides!
    const vUpdateLater = makeVersion('devA', 3, 7000, 0, { devA: 3 });
    const lsRecLater = makeLsRecord(vUpdateLater, { value: 'newer_update' });

    const sideA = resolveItemMerge({
      spaceId: 'sp1',
      localRecord: lsRecLater,
      remoteTombstone: lsTomb,
    });
    const sideB = resolveItemMerge({
      spaceId: 'sp1',
      localTombstone: lsTomb,
      remoteRecord: lsRecLater,
    });

    expect(sideA.winner).toBe('local');
    expect(sideA.record?.value).toBe('newer_update');
    expect(sideB.winner).toBe('remote');
    expect(sideB.record?.value).toBe('newer_update');
    expect(sideA.conflict).toBeDefined();
    expect(sideB.conflict).toBeDefined();
  });

  it('merges concurrent tombstones cleanly without emitting a conflict', () => {
    const vDelA = makeVersion('devA', 2, 5000, 0, { devA: 2 });
    const vDelB = makeVersion('devB', 3, 5500, 0, { devB: 3 });
    const tA = makeTombstone('cookie::trk::default::none::d:github.com::/::sid', vDelA, {
      acknowledgedDevices: ['devA'],
    });
    const tB = makeTombstone('cookie::trk::default::none::d:github.com::/::sid', vDelB, {
      acknowledgedDevices: ['devB'],
    });

    const outcome = resolveItemMerge({
      spaceId: 'sp1',
      localTombstone: tA,
      remoteTombstone: tB,
    });
    expect(outcome.winner).toBe('tombstone');
    expect(outcome.conflict).toBeUndefined();
    expect(outcome.tombstone?.acknowledgedDevices).toEqual(['devA', 'devB']);
    expect(outcome.tombstone?.deleteVersion.vectorClock).toEqual({ devA: 2, devB: 3 });
  });

  it('marks tombstones reclaimable ONLY when all active devices acknowledged AND retention elapsed', () => {
    const createdAt = 1_700_000_000_000;
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const vDel = makeVersion('devA', 5, createdAt, 0, { devA: 5 });
    const tomb = makeTombstone('cookie::1', vDel, {
      createdAt,
      acknowledgedDevices: ['devA'],
      reclaimable: false,
    });

    const cpA: DeviceCheckpoint = {
      deviceId: 'devA',
      spaceId: 'sp1',
      processedVectorClock: { devA: 5 },
      updatedAt: createdAt + 1000,
    };
    const cpBBehind: DeviceCheckpoint = {
      deviceId: 'devB',
      spaceId: 'sp1',
      processedVectorClock: { devA: 4 },
      updatedAt: createdAt + 1000,
    };
    const cpBCaughtUp: DeviceCheckpoint = {
      deviceId: 'devB',
      spaceId: 'sp1',
      processedVectorClock: { devA: 5 },
      updatedAt: createdAt + 2000,
    };

    // Device B has not processed devA:5 yet -> NOT reclaimable even after 30 days
    const notAcked = updateTombstoneReclaimability(
      tomb,
      ['devA', 'devB'],
      { devA: cpA, devB: cpBBehind },
      createdAt + 30 * 24 * 3600 * 1000,
    );
    expect(notAcked.reclaimable).toBe(false);
    expect(notAcked.acknowledgedDevices).toEqual(['devA']);

    // Device B missing checkpoint entirely -> NOT reclaimable
    const missingCp = updateTombstoneReclaimability(
      tomb,
      ['devA', 'devB'],
      { devA: cpA },
      createdAt + sevenDays + 1,
    );
    expect(missingCp.reclaimable).toBe(false);

    // All active devices acknowledged, but retention period NOT elapsed -> NOT reclaimable
    const tooEarly = updateTombstoneReclaimability(
      tomb,
      ['devA', 'devB'],
      { devA: cpA, devB: cpBCaughtUp },
      createdAt + sevenDays - 1,
    );
    expect(tooEarly.reclaimable).toBe(false);
    expect(tooEarly.acknowledgedDevices).toEqual(['devA', 'devB']);

    // All active devices acknowledged AND default 7-day retention elapsed -> reclaimable!
    const ready = updateTombstoneReclaimability(
      tomb,
      ['devA', 'devB'],
      { devA: cpA, devB: cpBCaughtUp },
      createdAt + sevenDays,
    );
    expect(ready.reclaimable).toBe(true);
    expect(ready.acknowledgedDevices).toEqual(['devA', 'devB']);

    // Custom retention window works for fast test verification
    const customReady = updateTombstoneReclaimability(
      tomb,
      ['devA', 'devB'],
      { devA: cpA, devB: cpBCaughtUp },
      createdAt + 5000,
      5000,
    );
    expect(customReady.reclaimable).toBe(true);

    // Empty activeDeviceIds must not prematurely mark reclaimable
    const emptyActive = updateTombstoneReclaimability(
      tomb,
      [],
      { devA: cpA },
      createdAt + sevenDays,
    );
    expect(emptyActive.reclaimable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. SiteTrack Multi-Device Discovery & User Decisions
// ---------------------------------------------------------------------------

describe('version: evaluateSiteDiscovery (all 5 flows) & applyUserSiteDecision', () => {
  const NOW = 1_700_000_000_000;

  it('Flow 1: blacklisted site always yields BLACKLISTED / skip_blacklisted even if previously bound', () => {
    const existingBinding: DeviceSiteBinding = {
      siteKey: 'paypal.com',
      state: 'AUTO_BOUND',
      trackId: 'trk_devA_paypal.com',
      hasLocalBaseline: true,
      decidedBy: 'auto',
    };

    const res = evaluateSiteDiscovery({
      siteKey: 'paypal.com',
      isBlacklisted: true,
      existingBinding,
      localCookies: [makeBrowserCookie({ domain: '.paypal.com', name: 'sid' })],
      localStorageCount: 2,
      remoteTracks: [makeTrack({ siteKey: 'paypal.com', trackId: 'trk_devA_paypal.com' })],
      deviceId: 'devA',
      deviceName: 'Work PC',
      filterNoise: true,
      nowMs: NOW,
    });

    expect(res.action).toBe('skip_blacklisted');
    expect(res.binding.state).toBe('BLACKLISTED');
    expect(res.binding.trackId).toBeUndefined();
    expect(res.createdTrack).toBeUndefined();
    expect(res.pendingDecision).toBeUndefined();
  });

  it('Flow 2: already bound (AUTO_BOUND / USER_BOUND / INDEPENDENT) with valid track returns sync_bound_track', () => {
    const trackA = makeTrack({ siteKey: 'github.com', trackId: 'trk_devA_github.com' });

    for (const state of ['AUTO_BOUND', 'USER_BOUND', 'INDEPENDENT'] as const) {
      const res = evaluateSiteDiscovery({
        siteKey: 'github.com',
        isBlacklisted: false,
        existingBinding: {
          siteKey: 'github.com',
          state,
          trackId: trackA.trackId,
          hasLocalBaseline: true,
          decidedBy: state === 'AUTO_BOUND' ? 'auto' : 'user',
        },
        localCookies: [makeBrowserCookie()],
        localStorageCount: 0,
        remoteTracks: [trackA],
        deviceId: 'devB',
        deviceName: 'Home PC',
        filterNoise: true,
        nowMs: NOW,
      });

      expect(res.action).toBe('sync_bound_track');
      expect(res.binding.state).toBe(state);
      expect(res.binding.trackId).toBe(trackA.trackId);
    }

    // If a USER_BOUND remote track no longer exists remotely, fall back to re-discovery
    const vanished = evaluateSiteDiscovery({
      siteKey: 'github.com',
      isBlacklisted: false,
      existingBinding: {
        siteKey: 'github.com',
        state: 'USER_BOUND',
        trackId: 'trk_deleted_github.com',
        hasLocalBaseline: false,
        decidedBy: 'user',
      },
      localCookies: [],
      localStorageCount: 0,
      remoteTracks: [trackA],
      deviceId: 'devC',
      deviceName: 'Laptop',
      filterNoise: true,
      nowMs: NOW,
    });
    expect(vanished.action).toBe('auto_pull_remote');
    expect(vanished.binding.trackId).toBe(trackA.trackId);
  });

  it('Flow 3a: 0 remote tracks & meaningful local data creates initial SiteTrack trk_${deviceId}_${siteKey}', () => {
    const res = evaluateSiteDiscovery({
      siteKey: 'github.com',
      isBlacklisted: false,
      localCookies: [
        makeBrowserCookie({ name: '_ga', value: 'GA1.2.123' }),
        makeBrowserCookie({ name: 'user_session', value: 'real_token' }),
      ],
      localStorageCount: 1,
      remoteTracks: [],
      deviceId: 'devA',
      deviceName: 'Office Edge',
      filterNoise: true,
      nowMs: NOW,
    });

    expect(res.action).toBe('create_initial_track');
    expect(res.binding.state).toBe('AUTO_BOUND');
    expect(res.binding.trackId).toBe('trk_devA_github.com');
    expect(res.createdTrack).toBeDefined();
    expect(res.createdTrack?.trackId).toBe('trk_devA_github.com');
    expect(res.createdTrack?.cookieCount).toBe(1); // _ga filtered!
    expect(res.createdTrack?.localStorageCount).toBe(1);
    expect(res.createdTrack?.memberDeviceIds).toEqual(['devA']);
  });

  it('Flow 3b: 1 remote track & 0 meaningful local data (ignoring analytics noise!) auto-binds & pulls', () => {
    const trackA = makeTrack({ siteKey: 'github.com', trackId: 'trk_devA_github.com' });

    // Local ONLY has analytics noise cookies (_ga, _gid) and filterNoise=true
    const res = evaluateSiteDiscovery({
      siteKey: 'github.com',
      isBlacklisted: false,
      localCookies: [
        makeBrowserCookie({ name: '_ga', value: 'GA1.1' }),
        makeBrowserCookie({ name: '_gid', value: 'GID1.1' }),
      ],
      localStorageCount: 0,
      remoteTracks: [trackA],
      deviceId: 'devB',
      deviceName: 'Home Edge',
      filterNoise: true,
      nowMs: NOW,
    });

    expect(res.action).toBe('auto_pull_remote');
    expect(res.binding.state).toBe('AUTO_BOUND');
    expect(res.binding.trackId).toBe(trackA.trackId);
    expect(res.pendingDecision).toBeUndefined();

    // With filterNoise=false, those cookies count as local data -> triggers PENDING_CHOICE
    const withoutFilter = evaluateSiteDiscovery({
      siteKey: 'github.com',
      isBlacklisted: false,
      localCookies: [makeBrowserCookie({ name: '_ga', value: 'GA1.1' })],
      localStorageCount: 0,
      remoteTracks: [trackA],
      deviceId: 'devB',
      deviceName: 'Home Edge',
      filterNoise: false,
      nowMs: NOW,
    });
    expect(withoutFilter.action).toBe('await_user_choice');
    expect(withoutFilter.pendingDecision?.reason).toBe('both_sides_have_data');
  });

  it('Flow 3c: >=1 remote tracks & local meaningful data pauses overwrite with both_sides_have_data', () => {
    const trackA = makeTrack({ siteKey: 'github.com', trackId: 'trk_devA_github.com' });

    const res = evaluateSiteDiscovery({
      siteKey: 'github.com',
      isBlacklisted: false,
      localCookies: [makeBrowserCookie({ name: 'user_session', value: 'b_account' })],
      localStorageCount: 2,
      remoteTracks: [trackA],
      deviceId: 'devB',
      deviceName: 'Home Edge',
      filterNoise: true,
      nowMs: NOW,
    });

    expect(res.action).toBe('await_user_choice');
    expect(res.binding.state).toBe('PENDING_CHOICE');
    expect(res.binding.trackId).toBeUndefined();
    expect(res.pendingDecision).toEqual({
      siteKey: 'github.com',
      reason: 'both_sides_have_data',
      hasLocalData: true,
      localCookieCount: 1,
      localLocalStorageCount: 2,
      remoteTracks: [trackA],
      detectedAt: NOW,
    });
  });

  it('Flow 3d: Device C with 0 local data & >=2 remote tracks yields multiple_remote_tracks', () => {
    const trackA = makeTrack({
      siteKey: 'github.com',
      trackId: 'trk_devA_github.com',
      originDeviceId: 'devA',
      label: 'Work Account',
    });
    const trackB = makeTrack({
      siteKey: 'github.com',
      trackId: 'trk_devB_github.com',
      originDeviceId: 'devB',
      label: 'Personal Account',
    });

    const res = evaluateSiteDiscovery({
      siteKey: 'github.com',
      isBlacklisted: false,
      localCookies: [],
      localStorageCount: 0,
      remoteTracks: [trackA, trackB],
      deviceId: 'devC',
      deviceName: 'Laptop C',
      filterNoise: true,
      nowMs: NOW,
    });

    expect(res.action).toBe('await_user_choice');
    expect(res.binding.state).toBe('PENDING_CHOICE');
    expect(res.binding.trackId).toBeUndefined();
    expect(res.binding.availableTrackIds).toEqual([trackA.trackId, trackB.trackId]);
    expect(res.pendingDecision).toEqual({
      siteKey: 'github.com',
      reason: 'multiple_remote_tracks',
      hasLocalData: false,
      localCookieCount: 0,
      localLocalStorageCount: 0,
      remoteTracks: [trackA, trackB],
      detectedAt: NOW,
    });
  });

  it('applies all 4 applyUserSiteDecision actions cleanly', () => {
    const trackA = makeTrack({ siteKey: 'github.com', trackId: 'trk_devA_github.com' });
    const trackB = makeTrack({
      siteKey: 'github.com',
      trackId: 'trk_devB_github.com',
      originDeviceId: 'devB',
    });

    // 1. use_remote_track
    const useRemote = applyUserSiteDecision({
      siteKey: 'github.com',
      action: { type: 'use_remote_track', trackId: trackA.trackId },
      remoteTracks: [trackA, trackB],
      deviceId: 'devC',
      deviceName: 'Laptop C',
      localCookieCount: 0,
      localStorageCount: 0,
      nowMs: NOW,
    });
    expect(useRemote.mode).toBe('pull_remote_into_local');
    expect(useRemote.binding.state).toBe('USER_BOUND');
    expect(useRemote.binding.trackId).toBe(trackA.trackId);
    expect(useRemote.binding.decidedBy).toBe('user');

    // Invalid remote track throws
    expect(() =>
      applyUserSiteDecision({
        siteKey: 'github.com',
        action: { type: 'use_remote_track', trackId: 'trk_nonexistent' },
        remoteTracks: [trackA],
        deviceId: 'devC',
        deviceName: 'Laptop C',
        localCookieCount: 0,
        localStorageCount: 0,
        nowMs: NOW,
      }),
    ).toThrow();

    // 2. use_local_override_track (overrides existing trackA)
    const overrideRemote = applyUserSiteDecision({
      siteKey: 'github.com',
      action: { type: 'use_local_override_track', trackId: trackA.trackId },
      remoteTracks: [trackA],
      deviceId: 'devB',
      deviceName: 'Home B',
      localCookieCount: 4,
      localStorageCount: 2,
      nowMs: NOW,
    });
    expect(overrideRemote.mode).toBe('push_local_override_remote');
    expect(overrideRemote.binding.state).toBe('USER_BOUND');
    expect(overrideRemote.binding.trackId).toBe(trackA.trackId);
    expect(overrideRemote.newTrack).toBeUndefined();

    // 3. keep_independent -> creates dedicated track for this device
    const keepIndep = applyUserSiteDecision({
      siteKey: 'github.com',
      action: { type: 'keep_independent', customLabel: '个人小号' },
      remoteTracks: [trackA],
      deviceId: 'devB',
      deviceName: 'Home B',
      localCookieCount: 2,
      localStorageCount: 1,
      nowMs: NOW,
    });
    expect(keepIndep.mode).toBe('push_local_new_track');
    expect(keepIndep.binding.state).toBe('INDEPENDENT');
    expect(keepIndep.newTrack).toBeDefined();
    expect(keepIndep.newTrack?.trackId).toBe('trk_devB_github.com');
    expect(keepIndep.newTrack?.label).toBe('个人小号');
    expect(keepIndep.binding.trackId).toBe(keepIndep.newTrack?.trackId);

    // keep_independent avoids trackId collision if trk_devB_github.com already exists
    const keepIndepSecond = applyUserSiteDecision({
      siteKey: 'github.com',
      action: { type: 'keep_independent' },
      remoteTracks: [trackA, trackB],
      deviceId: 'devB',
      deviceName: 'Home B',
      localCookieCount: 1,
      localStorageCount: 0,
      nowMs: NOW,
    });
    expect(keepIndepSecond.newTrack?.trackId).not.toBe(trackB.trackId);
    expect(keepIndepSecond.newTrack?.trackId).toContain('trk_devB_github.com');

    // 4. blacklist (device and space scopes)
    const blDevice = applyUserSiteDecision({
      siteKey: 'github.com',
      action: { type: 'blacklist', scope: 'device' },
      remoteTracks: [trackA],
      deviceId: 'devB',
      deviceName: 'Home B',
      localCookieCount: 2,
      localStorageCount: 0,
      nowMs: NOW,
    });
    expect(blDevice.mode).toBe('blacklisted');
    expect(blDevice.binding.state).toBe('BLACKLISTED');
    expect(blDevice.binding.trackId).toBeUndefined();
    expect(blDevice.blacklistToAdd).toEqual({ scope: 'device', pattern: 'github.com' });
  });
});

// ---------------------------------------------------------------------------
// 5. Two-Tier Blacklist & Rules Engine
// ---------------------------------------------------------------------------

describe('rules: buildPresetBlacklistEntries & RulesEngine', () => {
  it('builds preset blacklist entries for banking, password_manager, webdav_self, and localhost', () => {
    const presets = buildPresetBlacklistEntries(
      ['banking', 'password_manager', 'webdav_self', 'localhost'],
      'https://dav.jianguoyun.com/dav/',
      'space',
    );

    const engine = new RulesEngine(DEFAULT_SPACE_SETTINGS, {
      spaceBlacklist: presets,
      siteOverrides: {},
      ssoGroups: [],
      updatedAt: Date.now(),
    });

    // Banking & payment
    expect(engine.isBlacklisted('mybank.icbc.com.cn').blacklisted).toBe(true);
    expect(engine.isBlacklisted('https://www.paypal.com/signin').blacklisted).toBe(true);
    expect(engine.isBlacklisted('alipay.com').blacklisted).toBe(true);

    // Password managers
    expect(engine.isBlacklisted('my.1password.com').blacklisted).toBe(true);
    expect(engine.isBlacklisted('vault.bitwarden.com').blacklisted).toBe(true);
    expect(engine.isBlacklisted('lastpass.com').blacklisted).toBe(true);

    // WebDAV self
    expect(engine.isBlacklisted('https://dav.jianguoyun.com/dav/SessionMesh').blacklisted).toBe(
      true,
    );
    expect(engine.isBlacklisted('dav.jianguoyun.com').blacklisted).toBe(true);

    // Localhost & loopback & *.local
    expect(engine.isBlacklisted('http://localhost:3000/app').blacklisted).toBe(true);
    expect(engine.isBlacklisted('app.localhost').blacklisted).toBe(true);
    expect(engine.isBlacklisted('http://127.0.0.1:8080').blacklisted).toBe(true);
    expect(engine.isBlacklisted('http://[::1]:8080/').blacklisted).toBe(true);
    expect(engine.isBlacklisted('::1').blacklisted).toBe(true);
    expect(engine.isBlacklisted('myserver.local').blacklisted).toBe(true);

    // Normal site is NOT blacklisted
    expect(engine.isBlacklisted('github.com').blacklisted).toBe(false);
    expect(engine.isBlacklisted('local.com').blacklisted).toBe(false);
  });

  it('supports exact_domain, subdomain, wildcard, and strict origin matchTypes', () => {
    const spaceRules: SpaceRuleSet = {
      spaceBlacklist: [
        {
          id: 'bl_exact',
          pattern: 'exact.example.org',
          matchType: 'exact_domain',
          scope: 'space',
          createdAt: 1,
        },
        {
          id: 'bl_sub',
          pattern: '*.corp.example.com',
          matchType: 'subdomain',
          scope: 'space',
          createdAt: 2,
        },
        {
          id: 'bl_wild',
          pattern: '*bank*',
          matchType: 'wildcard',
          scope: 'space',
          createdAt: 3,
        },
        {
          id: 'bl_origin',
          pattern: 'https://admin.example.com:8443',
          matchType: 'origin',
          scope: 'space',
          createdAt: 4,
        },
      ],
      siteOverrides: {},
      ssoGroups: [],
      updatedAt: 100,
    };

    const engine = new RulesEngine(DEFAULT_SPACE_SETTINGS, spaceRules);

    // exact_domain
    expect(engine.isBlacklisted('exact.example.org').blacklisted).toBe(true);
    expect(engine.isBlacklisted('https://exact.example.org:443/path').blacklisted).toBe(true);
    expect(engine.isBlacklisted('sub.exact.example.org').blacklisted).toBe(false);

    // subdomain (*.corp.example.com matches both apex corp.example.com and subdomains)
    expect(engine.isBlacklisted('corp.example.com').blacklisted).toBe(true);
    expect(engine.isBlacklisted('hr.corp.example.com').blacklisted).toBe(true);
    expect(engine.isBlacklisted('deep.hr.corp.example.com').blacklisted).toBe(true);
    expect(engine.isBlacklisted('notcorp.example.com').blacklisted).toBe(false);

    // wildcard (*bank*) matches host, NOT unrelated URL path
    expect(engine.isBlacklisted('mybank.net').blacklisted).toBe(true);
    expect(engine.isBlacklisted('https://ebank.foo.org/login').blacklisted).toBe(true);
    expect(engine.isBlacklisted('https://example.org/bank/info').blacklisted).toBe(false);

    // origin (strict scheme + host + port)
    expect(engine.isBlacklisted('https://admin.example.com:8443/panel').blacklisted).toBe(true);
    expect(engine.isBlacklisted('https://admin.example.com:8443').blacklisted).toBe(true);
    expect(engine.isBlacklisted('https://admin.example.com/panel').blacklisted).toBe(false);
    expect(engine.isBlacklisted('http://admin.example.com:8443/panel').blacklisted).toBe(false);
    expect(engine.isBlacklisted('admin.example.com').blacklisted).toBe(false);
  });

  it('enforces priority: deviceBlacklist > spaceBlacklist > siteOverrides > global defaults', () => {
    const devEntry: BlacklistEntry = {
      id: 'dev_bl_1',
      pattern: '*.secret.com',
      matchType: 'subdomain',
      scope: 'device',
      createdAt: 10,
    };
    const spaceEntry: BlacklistEntry = {
      id: 'space_bl_1',
      pattern: 'secret.com',
      matchType: 'exact_domain',
      scope: 'space',
      createdAt: 20,
    };
    const spaceEntry2: BlacklistEntry = {
      id: 'space_bl_2',
      pattern: 'blocked.org',
      matchType: 'exact_domain',
      scope: 'space',
      createdAt: 21,
    };

    const spaceRules: SpaceRuleSet = {
      spaceBlacklist: [spaceEntry, spaceEntry2],
      siteOverrides: {
        'secret.com': {
          siteKey: 'secret.com',
          pattern: 'secret.com',
          direction: 'bidirectional',
          syncCookies: true,
          syncLocalStorage: true,
          autoRefresh: true,
          updatedAt: 50,
        },
        'blocked.org': {
          siteKey: 'blocked.org',
          pattern: 'blocked.org',
          direction: 'bidirectional',
          syncCookies: true,
          syncLocalStorage: true,
          autoRefresh: true,
          updatedAt: 50,
        },
        'github.com': {
          siteKey: 'github.com',
          pattern: 'github.com',
          direction: 'push_only',
          syncCookies: true,
          syncLocalStorage: false,
          autoRefresh: false,
          updatedAt: 50,
        },
        'admin.github.com': {
          siteKey: 'admin.github.com',
          pattern: 'admin.github.com',
          direction: 'pull_only',
          syncCookies: true,
          syncLocalStorage: true,
          autoRefresh: true,
          updatedAt: 51,
        },
        'disabled.dev': {
          siteKey: 'disabled.dev',
          pattern: 'disabled.dev',
          direction: 'disabled',
          syncCookies: true,
          syncLocalStorage: true,
          autoRefresh: true,
          updatedAt: 52,
        },
      },
      ssoGroups: [
        {
          groupId: 'gh',
          name: 'GitHub',
          primarySiteKey: 'github.com',
          domains: ['github.com', 'githubusercontent.com'],
        },
      ],
      updatedAt: 100,
    };

    const engine = new RulesEngine(DEFAULT_SPACE_SETTINGS, spaceRules, [devEntry]);

    // Device blacklist beats BOTH space blacklist and siteOverride
    const secretPolicy = engine.getEffectivePolicy('secret.com');
    expect(secretPolicy.excluded).toBe(true);
    expect(secretPolicy.excludedBy?.id).toBe('dev_bl_1');
    expect(secretPolicy.direction).toBe('disabled');
    expect(secretPolicy.syncCookies).toBe(false);
    expect(secretPolicy.syncLocalStorage).toBe(false);
    expect(secretPolicy.autoRefresh).toBe(false);

    // Space blacklist beats siteOverride
    const blockedPolicy = engine.getEffectivePolicy('blocked.org');
    expect(blockedPolicy.excluded).toBe(true);
    expect(blockedPolicy.excludedBy?.id).toBe('space_bl_2');
    expect(blockedPolicy.direction).toBe('disabled');

    // Site override applies to siteKey & SSO group members
    const ghPolicy = engine.getEffectivePolicy('raw.githubusercontent.com');
    expect(ghPolicy.excluded).toBe(false);
    expect(ghPolicy.direction).toBe('push_only');
    expect(ghPolicy.syncLocalStorage).toBe(false);
    expect(ghPolicy.autoRefresh).toBe(false);

    // More specific exact_domain override beats broader siteKey override
    const adminGhPolicy = engine.getEffectivePolicy('admin.github.com');
    expect(adminGhPolicy.direction).toBe('pull_only');
    expect(adminGhPolicy.syncLocalStorage).toBe(true);

    // Disabled site override excludes syncing even when not in blacklist
    const disabledPolicy = engine.getEffectivePolicy('disabled.dev');
    expect(disabledPolicy.excluded).toBe(true);
    expect(disabledPolicy.excludedBy).toBeUndefined();
    expect(disabledPolicy.direction).toBe('disabled');
    expect(disabledPolicy.syncCookies).toBe(false);

    // Unmatched site falls back to global defaults
    const defaultPolicy = engine.getEffectivePolicy('example.com');
    expect(defaultPolicy).toEqual({
      excluded: false,
      direction: 'bidirectional',
      syncCookies: true,
      syncLocalStorage: true,
      syncSessionStorage: false,
      syncIndexedDb: false,
      indexedDbMaxTotalBytes: 1024 * 1024,
      autoRefresh: true,
    });

    // update() replaces rules live
    engine.update(
      { ...DEFAULT_SPACE_SETTINGS, direction: 'pull_only', autoRefresh: false },
      { spaceBlacklist: [], siteOverrides: {}, ssoGroups: [], updatedAt: 200 },
      [],
    );
    expect(engine.isBlacklisted('secret.com').blacklisted).toBe(false);
    expect(engine.getEffectivePolicy('secret.com')).toEqual({
      excluded: false,
      direction: 'pull_only',
      syncCookies: true,
      syncLocalStorage: true,
      syncSessionStorage: false,
      syncIndexedDb: false,
      indexedDbMaxTotalBytes: 1024 * 1024,
      autoRefresh: false,
    });
  });

  it('exports and parses rules JSON cleanly and rejects invalid JSON', () => {
    const spaceRules: SpaceRuleSet = {
      spaceBlacklist: buildPresetBlacklistEntries(['localhost'], undefined, 'space'),
      siteOverrides: {
        'github.com': {
          siteKey: 'github.com',
          pattern: 'github.com',
          direction: 'push_only',
          syncCookies: true,
          syncLocalStorage: false,
          autoRefresh: true,
          updatedAt: 12345,
        },
      },
      ssoGroups: [
        {
          groupId: 'sso_1',
          name: 'Taobao',
          primarySiteKey: 'taobao.com',
          domains: ['taobao.com', 'tmall.com'],
        },
      ],
      updatedAt: 12345,
    };
    const deviceBl: BlacklistEntry[] = [
      {
        id: 'dev_1',
        pattern: 'private.internal',
        matchType: 'exact_domain',
        scope: 'device',
        createdAt: 12345,
      },
    ];

    const engine = new RulesEngine(DEFAULT_SPACE_SETTINGS, spaceRules, deviceBl);
    const exported = engine.exportRulesJson();
    const parsed = RulesEngine.parseRulesJson(exported);

    expect(parsed.spaceRules.spaceBlacklist).toHaveLength(spaceRules.spaceBlacklist.length);
    expect(parsed.spaceRules.siteOverrides?.['github.com']?.direction).toBe('push_only');
    expect(parsed.spaceRules.ssoGroups).toHaveLength(1);
    expect(parsed.deviceBlacklist).toEqual(deviceBl);

    // Invalid JSON throws descriptive error
    expect(() => RulesEngine.parseRulesJson('{not valid json')).toThrow(/Invalid rules JSON/);
    expect(() => RulesEngine.parseRulesJson('[]')).toThrow(/root must be a JSON object/);
  });
});
