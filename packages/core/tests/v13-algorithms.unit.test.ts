import { describe, expect, it } from 'vitest';
import type {
  BrowserCookieInput,
  CausalVersion,
  CookieRecord,
  PairingPayload,
  SessionSharePayload,
} from '../src/types';
import {
  buildDebugExportResult,
  formatCookieHeaderString,
  formatCurlCommand,
  formatFetchSnippet,
  formatHeadersJson,
  formatNetscapeCookiesTxt,
  formatPlaywrightStorageState,
  formatPostmanApifoxCookies,
  selectCookiesForDebugExport,
} from '../src/export';
import {
  SESSION_SHARE_AAD,
  SESSION_SHARE_PBKDF2_ITERATIONS,
  SESSION_SHARE_PREFIX,
  SmesCryptoError,
  clampSharedCookiesExpiry,
  decodeIdbKey,
  decodePairingCode,
  decodeSessionShare,
  decodeTypedValue,
  encodeIdbKey,
  encodePairingCode,
  encodeSessionShare,
  encodeTypedValue,
  generateSharePassphrase,
  toSessionSharePreview,
} from '../src/crypto';
import {
  evaluateSiteExpiryHealth,
  isLikelyAuthCookie,
  isShortLivedCsrfOrAntiBotCookie,
} from '../src/diagnostics';
import { buildCookieLogicalId } from '../src/version';

const NOW_MS = 1_750_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function makeBrowserCookie(overrides: Partial<BrowserCookieInput> = {}): BrowserCookieInput {
  return {
    domain: '.example.com',
    name: 'session_id',
    value: 'sess_xyz',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    session: false,
    expirationDate: NOW_SEC + 86_400 * 30,
    hostOnly: false,
    ...overrides,
  };
}

function makeVersion(deviceId = 'devA', seq = 1): CausalVersion {
  return {
    hlc: { physicalMs: NOW_MS, logical: 0, deviceId },
    vectorClock: { [deviceId]: seq },
    deviceId,
    deviceSeq: seq,
    versionId: `${deviceId}:${seq}:${NOW_MS}.0`,
  };
}

function makeCookieRecord(overrides: Partial<CookieRecord> = {}): CookieRecord {
  const trackId = overrides.trackId ?? 'trk_main';
  const domain = overrides.domain ?? '.example.com';
  const path = overrides.path ?? '/';
  const name = overrides.name ?? 'session_id';
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
    siteKey: overrides.siteKey ?? 'example.com',
    trackId,
    domain,
    path,
    name,
    value: overrides.value ?? 'secret_val',
    storeScope: overrides.storeScope ?? 'default',
    partitionKey: overrides.partitionKey ?? null,
    secure: overrides.secure ?? true,
    httpOnly: overrides.httpOnly ?? true,
    sameSite: overrides.sameSite ?? 'lax',
    session: overrides.session ?? false,
    expirationDate: overrides.expirationDate ?? NOW_SEC + 86_400 * 7,
    hostOnly,
    version: overrides.version ?? makeVersion(),
    sourceDevice: overrides.sourceDevice ?? 'devA',
    deleted: overrides.deleted ?? false,
    updatedAt: overrides.updatedAt ?? NOW_MS,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Debug Export (Feature 1.1)
// ---------------------------------------------------------------------------

describe('export: One-Click Debug Export', () => {
  it('1. excludes deleted, expired (seconds & ms), and analytics noise cookies by default', () => {
    const cookies: CookieRecord[] = [
      makeCookieRecord({ name: 'session_id', value: 'valid' }),
      makeCookieRecord({ name: 'session_temp', session: true, expirationDate: undefined }),
      makeCookieRecord({ name: 'deleted_tok', deleted: true }),
      makeCookieRecord({ name: 'expired_sec', expirationDate: NOW_SEC - 10 }),
      makeCookieRecord({ name: 'expired_boundary', expirationDate: NOW_SEC }),
      makeCookieRecord({ name: 'expired_ms', expirationDate: NOW_MS - 1000 }),
      makeCookieRecord({ name: '_ga', value: 'GA1.2.3' }),
      makeCookieRecord({ name: '_gid', value: 'GID.1' }),
      makeCookieRecord({ name: '_fbp', value: 'fb.1' }),
    ];

    const filtered = selectCookiesForDebugExport(cookies, { nowMs: NOW_MS });
    expect(filtered.map((c) => c.name)).toEqual(['session_id', 'session_temp']);

    const withNoise = selectCookiesForDebugExport(cookies, {
      nowMs: NOW_MS,
      filterNoise: false,
    });
    expect(withNoise.map((c) => c.name)).toContain('_ga');
    expect(withNoise.map((c) => c.name)).toContain('_fbp');
    expect(withNoise.map((c) => c.name)).not.toContain('deleted_tok');
    expect(withNoise.map((c) => c.name)).not.toContain('expired_sec');
  });

  it('2. applies RFC 6265 scheme matching (https vs http vs localhost/127.0.0.1/[::1])', () => {
    const cookies: CookieRecord[] = [
      makeCookieRecord({ name: 'sec_remote', domain: '.example.com', secure: true }),
      makeCookieRecord({ name: 'insec_remote', domain: '.example.com', secure: false }),
      makeCookieRecord({ name: 'local_sec', domain: 'localhost', hostOnly: true, secure: true }),
      makeCookieRecord({ name: 'v4_sec', domain: '127.0.0.1', hostOnly: true, secure: true }),
      makeCookieRecord({ name: 'v6_sec', domain: '[::1]', hostOnly: true, secure: true }),
    ];

    expect(
      selectCookiesForDebugExport(cookies, { targetUrl: 'http://example.com/', nowMs: NOW_MS }).map((c) => c.name),
    ).toEqual(['insec_remote']);
    expect(
      selectCookiesForDebugExport(cookies, { targetUrl: 'https://example.com/', nowMs: NOW_MS }).map((c) => c.name),
    ).toEqual(['insec_remote', 'sec_remote']);
    expect(
      selectCookiesForDebugExport(cookies, { targetUrl: 'http://localhost:3000/', nowMs: NOW_MS }).map((c) => c.name),
    ).toEqual(['local_sec']);
    expect(
      selectCookiesForDebugExport(cookies, { targetUrl: 'http://127.0.0.1:8080/', nowMs: NOW_MS }).map((c) => c.name),
    ).toEqual(['v4_sec']);
    expect(
      selectCookiesForDebugExport(cookies, { targetUrl: 'http://[::1]:5173/', nowMs: NOW_MS }).map((c) => c.name),
    ).toEqual(['v6_sec']);
  });

  it('3. enforces RFC 6265 hostOnly/subdomain matching, path boundaries, and longest-path-first order', () => {
    const cookies: CookieRecord[] = [
      makeCookieRecord({ name: 'root_wild', domain: '.example.com', path: '/', hostOnly: false }),
      makeCookieRecord({ name: 'api_specific', domain: 'api.example.com', path: '/api', hostOnly: true }),
      makeCookieRecord({ name: 'api_trailing', domain: 'api.example.com', path: '/api/', hostOnly: true }),
      makeCookieRecord({ name: 'other_sub', domain: 'admin.example.com', path: '/', hostOnly: true }),
      makeCookieRecord({ name: 'lookalike', domain: 'notexample.com', path: '/', hostOnly: false }),
    ];

    const v1 = selectCookiesForDebugExport(cookies, {
      targetUrl: 'https://api.example.com/api/v1/profile',
      nowMs: NOW_MS,
    });
    expect(v1.map((c) => c.name)).toEqual(['api_trailing', 'api_specific', 'root_wild']);

    // /apiv2 must NOT match /api or /api/
    const v2 = selectCookiesForDebugExport(cookies, {
      targetUrl: 'https://api.example.com/apiv2',
      nowMs: NOW_MS,
    });
    expect(v2.map((c) => c.name)).toEqual(['root_wild']);

    // /api exact matches /api and /, NOT /api/
    const exact = selectCookiesForDebugExport(cookies, {
      targetUrl: 'https://api.example.com/api',
      nowMs: NOW_MS,
    });
    expect(exact.map((c) => c.name)).toEqual(['api_specific', 'root_wild']);

    // hostOnly domain must not match deeper subdomain
    const deeper = selectCookiesForDebugExport(cookies, {
      targetUrl: 'https://v2.api.example.com/api/v1',
      nowMs: NOW_MS,
    });
    expect(deeper.map((c) => c.name)).toEqual(['root_wild']);
  });

  it('4. deduplicates identical cookie identities and skips URL filtering for non-HTTP URLs', () => {
    const older = makeCookieRecord({ name: 'sid', value: 'old_v', updatedAt: NOW_MS - 5000 });
    const newer = makeCookieRecord({ name: 'sid', value: 'new_v', updatedAt: NOW_MS });
    const nonHttp = selectCookiesForDebugExport([older, newer], {
      targetUrl: 'chrome://settings',
      nowMs: NOW_MS,
    });
    expect(nonHttp).toHaveLength(1);
    expect(nonHttp[0].value).toBe('new_v');
  });

  it('5. formats Cookie header, POSIX single-quoted cURL without CRLF injection, Node fetch, and headers JSON', () => {
    const cookies = [
      makeBrowserCookie({ name: 'sid', value: "abc'def\r\nX-Injected: 1" }),
      makeBrowserCookie({ name: 'theme', value: 'dark' }),
    ];

    expect(formatCookieHeaderString(cookies)).toBe("sid=abc'defX-Injected: 1; theme=dark");

    const curl = formatCurlCommand("https://example.com/api?q='test'\r\n", cookies);
    expect(curl).toBe(
      "curl 'https://example.com/api?q='\\''test'\\''' -H 'Cookie: sid=abc'\\''defX-Injected: 1; theme=dark'",
    );
    expect(curl).not.toMatch(/[\r\n]/);

    const fetchCode = formatFetchSnippet('https://example.com/api', cookies);
    expect(fetchCode).toContain('browser fetch forbids');
    expect(fetchCode).toContain('fetch("https://example.com/api", {');
    expect(fetchCode).toContain('"Cookie": "sid=abc\'defX-Injected: 1; theme=dark"');

    const headersJson = JSON.parse(formatHeadersJson(cookies)) as Record<string, string>;
    expect(headersJson).toEqual({ Cookie: "sid=abc'defX-Injected: 1; theme=dark" });
  });

  it('6. formats Playwright storageState.json with strict sameSite, expires, domain dot, and sorted origins', () => {
    const cookies = [
      makeBrowserCookie({
        name: 'host_tok',
        domain: 'app.example.com',
        hostOnly: true,
        sameSite: 'no_restriction',
        session: false,
        expirationDate: (NOW_SEC + 3600) * 1000,
      }),
      makeBrowserCookie({
        name: 'wild_sess',
        domain: 'example.com',
        hostOnly: false,
        sameSite: 'strict',
        session: true,
        expirationDate: undefined,
      }),
      makeBrowserCookie({
        name: 'unspec',
        domain: '.example.com',
        hostOnly: false,
        sameSite: 'unspecified',
        session: false,
        expirationDate: NOW_SEC + 100,
      }),
    ];

    const raw = formatPlaywrightStorageState(
      cookies,
      {
        'https://b.example.com': { z: '2', a: '1' },
        'https://a.example.com': { token: 't1' },
        'https://empty.example.com': {},
      },
      { 'https://a.example.com': { ss: 'ignored' } },
    );
    const parsed = JSON.parse(raw) as {
      cookies: Array<Record<string, unknown>>;
      origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
    };

    expect(parsed.cookies).toEqual([
      expect.objectContaining({
        name: 'host_tok',
        domain: 'app.example.com',
        expires: NOW_SEC + 3600,
        sameSite: 'None',
      }),
      expect.objectContaining({
        name: 'wild_sess',
        domain: '.example.com',
        expires: -1,
        sameSite: 'Strict',
      }),
      expect.objectContaining({
        name: 'unspec',
        domain: '.example.com',
        expires: NOW_SEC + 100,
        sameSite: 'Lax',
      }),
    ]);

    expect(parsed.origins).toEqual([
      { origin: 'https://a.example.com', localStorage: [{ name: 'token', value: 't1' }] },
      {
        origin: 'https://b.example.com',
        localStorage: [
          { name: 'a', value: '1' },
          { name: 'z', value: '2' },
        ],
      },
    ]);
  });

  it('7. formats Postman/Apifox JSON with domain fallback and Netscape cookies.txt with #HttpOnly_ prefix', () => {
    const cookies = [
      makeBrowserCookie({
        name: 'auth',
        value: 'jwt123',
        domain: '.example.com',
        hostOnly: false,
        path: '/app',
        secure: true,
        httpOnly: true,
        session: false,
        expirationDate: 1900000000,
      }),
      makeBrowserCookie({
        name: 'prefs',
        value: 'v1',
        domain: '',
        hostOnly: true,
        path: '/',
        secure: false,
        httpOnly: false,
        session: true,
        expirationDate: undefined,
      }),
    ];

    const postman = JSON.parse(formatPostmanApifoxCookies(cookies, 'example.com')) as Array<
      Record<string, unknown>
    >;
    expect(postman).toHaveLength(2);
    expect(postman[0]).toMatchObject({
      key: 'auth',
      name: 'auth',
      value: 'jwt123',
      domain: '.example.com',
      hostOnly: false,
      path: '/app',
      secure: true,
      httpOnly: true,
      session: false,
      expirationDate: 1900000000,
    });
    expect(postman[1]).toMatchObject({
      key: 'prefs',
      domain: 'example.com',
      hostOnly: true,
      session: true,
    });
    expect(postman[1].expirationDate).toBeUndefined();

    const netscape = formatNetscapeCookiesTxt([
      cookies[0],
      makeBrowserCookie({
        name: 'tab\tname',
        value: 'val\r\n1',
        domain: 'app.example.com',
        hostOnly: true,
        secure: false,
        httpOnly: false,
        session: true,
        expirationDate: undefined,
      }),
    ]);
    const lines = netscape.trim().split('\n');
    expect(lines[0]).toBe('# Netscape HTTP Cookie File');
    expect(lines).toContain('#HttpOnly_.example.com\tTRUE\t/app\tTRUE\t1900000000\tauth\tjwt123');
    expect(lines).toContain('app.example.com\tFALSE\t/\tFALSE\t0\ttabname\tval1');
  });

  it('8. builds complete DebugExportResult across all 7 DebugExportFormat options', () => {
    const cookies = [
      makeCookieRecord({ name: 'main_sid', domain: '.example.com', path: '/', hostOnly: false }),
      makeCookieRecord({ name: 'docs_sid', domain: 'docs.example.com', path: '/', hostOnly: true }),
    ];

    const curlRes = buildDebugExportResult({
      format: 'curl',
      siteKey: 'example.com',
      trackId: 'trk_1',
      trackLabel: 'Work',
      targetUrl: 'https://api.example.com/v1',
      cookies,
      nowMs: NOW_MS,
      liveFallback: true,
    });
    expect(curlRes.cookieCount).toBe(1);
    expect(curlRes.originCount).toBe(0);
    expect(curlRes.suggestedFilename).toBe('example.com.curl.sh');
    expect(curlRes.liveFallback).toBe(true);
    expect(curlRes.content).toContain('main_sid=');
    expect(curlRes.content).not.toContain('docs_sid=');

    const fetchRes = buildDebugExportResult({ format: 'fetch', siteKey: 'example.com', cookies, nowMs: NOW_MS });
    expect(fetchRes.suggestedFilename).toBe('example.com.fetch.js');
    expect(fetchRes.cookieCount).toBe(2);

    const headerRes = buildDebugExportResult({ format: 'cookie_header', siteKey: 'example.com', cookies, nowMs: NOW_MS });
    expect(headerRes.suggestedFilename).toBe('example.com.cookie.txt');

    const jsonRes = buildDebugExportResult({ format: 'headers_json', siteKey: 'example.com', cookies, nowMs: NOW_MS });
    expect(jsonRes.suggestedFilename).toBe('example.com.headers.json');

    const pwRes = buildDebugExportResult({
      format: 'playwright_storage_state',
      siteKey: 'example.com',
      targetUrl: 'https://api.example.com/v1',
      cookies,
      localStorageByOrigin: { 'https://example.com': { k: 'v' } },
      nowMs: NOW_MS,
    });
    expect(pwRes.cookieCount).toBe(2);
    expect(pwRes.originCount).toBe(1);
    expect(pwRes.suggestedFilename).toBe('example.com.storageState.json');

    const postmanRes = buildDebugExportResult({
      format: 'postman_apifox',
      siteKey: 'example.com',
      targetUrl: 'https://api.example.com/v1',
      cookies,
      nowMs: NOW_MS,
    });
    expect(postmanRes.cookieCount).toBe(2);
    expect(postmanRes.suggestedFilename).toBe('example.com.cookies.json');

    const netscapeRes = buildDebugExportResult({
      format: 'netscape_cookies_txt',
      siteKey: 'localhost',
      cookies: [makeCookieRecord({ name: 'local', domain: 'localhost', hostOnly: true, secure: false })],
      nowMs: NOW_MS,
    });
    expect(netscapeRes.targetUrl).toBe('http://localhost/');
    expect(netscapeRes.suggestedFilename).toBe('localhost.cookies.txt');
  });
});

// ---------------------------------------------------------------------------
// 2. Temporary Encrypted Team Session Share (Feature 1.3)
// ---------------------------------------------------------------------------

describe('crypto/sessionShare: Temporary Encrypted Session Share', () => {
  it('9. generates high-entropy passphrases without visually ambiguous characters', () => {
    const p1 = generateSharePassphrase();
    const p2 = generateSharePassphrase(24);
    expect(p1).toHaveLength(16);
    expect(p2).toHaveLength(24);
    expect(p1).not.toBe(p2);
    expect(p1).not.toMatch(/[0Oo1Il]/);
    expect(p2).not.toMatch(/[0Oo1Il]/);
    expect(() => generateSharePassphrase(0)).toThrow(/CRYPTO_INVALID_ARG/);
  });

  it('10. round-trips session share payloads and hides plaintext secrets inside code', async () => {
    const payload: SessionSharePayload = {
      version: 1,
      shareId: 'shr_abc123',
      siteKey: 'github.com',
      accountLabel: 'QA Bot',
      note: 'Temporary staging access',
      sharedBy: 'Alice',
      createdAt: NOW_MS,
      expiresAt: NOW_MS + 3600_000,
      clampCookieExpiry: true,
      cookies: [
        makeBrowserCookie({ name: 'user_session', value: 'super-secret-cookie', domain: '.github.com' }),
      ],
      localStorageByOrigin: { 'https://github.com': { theme: 'dark' } },
      sessionStorageByOrigin: { 'https://github.com': { tabState: '1' } },
    };

    expect(SESSION_SHARE_PBKDF2_ITERATIONS).toBe(150_000);
    const code = await encodeSessionShare(payload, 'share-pass-999', { iterations: 1000 });
    expect(code.startsWith(SESSION_SHARE_PREFIX)).toBe(true);
    expect(code).not.toContain('super-secret-cookie');
    expect(code).not.toContain('github.com');

    const decoded = await decodeSessionShare(code, 'share-pass-999', { nowMs: NOW_MS + 1000 });
    expect(decoded).toEqual(payload);
  });

  it('11. rejects wrong passphrase, tampered ciphertext, malformed prefix/base64, and pairing cross-domain codes', async () => {
    const payload: SessionSharePayload = {
      version: 1,
      shareId: 'shr_sec',
      siteKey: 'example.com',
      createdAt: NOW_MS,
      expiresAt: NOW_MS + 60_000,
      clampCookieExpiry: false,
      cookies: [makeBrowserCookie()],
    };
    const code = await encodeSessionShare(payload, 'correct-pass', { iterations: 1000 });

    await expect(decodeSessionShare(code, 'wrong-pass', { nowMs: NOW_MS })).rejects.toThrow(/DECRYPT/);
    await expect(decodeSessionShare(code, '')).rejects.toThrow(/DECRYPT/);
    await expect(decodeSessionShare(`${SESSION_SHARE_PREFIX}***invalid***`, 'correct-pass')).rejects.toThrow(
      /DECRYPT_INVALID_SHARE_CODE/,
    );
    await expect(decodeSessionShare(SESSION_SHARE_PREFIX, 'correct-pass')).rejects.toThrow(
      /DECRYPT_INVALID_SHARE_CODE/,
    );
    await expect(decodeSessionShare(`${code.slice(0, -4)}AAAA`, 'correct-pass')).rejects.toThrow(/DECRYPT/);

    // Domain separation against pairing codes
    expect(SESSION_SHARE_AAD).not.toBe('sessionmesh:pairing:v1');
    const pairingPayload: PairingPayload = {
      version: 1,
      webdav: {
        url: 'https://dav.example.com/dav',
        authType: 'basic',
        username: 'u',
        password: 'p',
        rootPath: '/sm',
      },
      spaceId: 'sp1',
      spaceName: 'Space 1',
      createdAt: NOW_MS,
      fromDeviceName: 'DevA',
    };
    const pairCode = await encodePairingCode(pairingPayload, 'same-pass');
    await expect(decodeSessionShare(pairCode, 'same-pass')).rejects.toThrow(/DECRYPT_INVALID_SHARE_CODE/);
    const forgedShare = pairCode.replace('smesh://pair/v1.', SESSION_SHARE_PREFIX);
    await expect(decodeSessionShare(forgedShare, 'same-pass')).rejects.toThrow(/DECRYPT_AAD_MISMATCH/);
  });

  it('12. validates encode parameters & TTL and enforces SHARE_EXPIRED unless allowExpired is true', async () => {
    const basePayload: SessionSharePayload = {
      version: 1,
      shareId: 'shr_ttl',
      siteKey: 'example.com',
      createdAt: NOW_MS,
      expiresAt: NOW_MS + 60_000,
      clampCookieExpiry: false,
      cookies: [makeBrowserCookie()],
    };

    await expect(encodeSessionShare(basePayload, '')).rejects.toThrow(/ENCRYPT_EMPTY_PASSWORD/);
    await expect(
      encodeSessionShare({ ...basePayload, expiresAt: NOW_MS }, 'pw', { iterations: 1000 }),
    ).rejects.toThrow(/ENCRYPT_INVALID_SHARE_TTL/);

    const code = await encodeSessionShare(basePayload, 'pw', { iterations: 1000 });

    // Exact boundary nowMs === expiresAt is not yet expired (> check)
    const atBoundary = await decodeSessionShare(code, 'pw', { nowMs: NOW_MS + 60_000 });
    expect(atBoundary.shareId).toBe('shr_ttl');

    let capturedErr: unknown;
    try {
      await decodeSessionShare(code, 'pw', { nowMs: NOW_MS + 60_001 });
    } catch (err) {
      capturedErr = err;
    }
    expect(capturedErr).toBeInstanceOf(SmesCryptoError);
    expect((capturedErr as SmesCryptoError).code).toBe('SHARE_EXPIRED');

    const allowed = await decodeSessionShare(code, 'pw', {
      nowMs: NOW_MS + 60_001,
      allowExpired: true,
    });
    expect(allowed.shareId).toBe('shr_ttl');
  });

  it('13. builds SessionSharePreview with accurate counts and remainingMs clamping', () => {
    const payload: SessionSharePayload = {
      version: 1,
      shareId: 'shr_prev',
      siteKey: 'example.com',
      accountLabel: 'Demo',
      note: 'Read-only',
      sharedBy: 'Bob',
      createdAt: NOW_MS,
      expiresAt: NOW_MS + 3600_000,
      clampCookieExpiry: true,
      cookies: [
        makeBrowserCookie({ name: 'sid' }),
        makeBrowserCookie({ name: 'sid', domain: 'sub.example.com' }),
        makeBrowserCookie({ name: 'csrf_ok' }),
      ],
      localStorageByOrigin: {
        'https://example.com': { a: '1', b: '2' },
        'https://app.example.com': { c: '3' },
      },
      sessionStorageByOrigin: {
        'https://example.com': { s: '4' },
      },
    };

    const preview = toSessionSharePreview(payload, NOW_MS + 1000_000);
    expect(preview).toEqual({
      shareId: 'shr_prev',
      siteKey: 'example.com',
      accountLabel: 'Demo',
      note: 'Read-only',
      sharedBy: 'Bob',
      createdAt: NOW_MS,
      expiresAt: NOW_MS + 3600_000,
      remainingMs: 2600_000,
      clampCookieExpiry: true,
      cookieCount: 3,
      cookieNames: ['sid', 'csrf_ok'],
      localStorageCount: 3,
      sessionStorageCount: 1,
    });
    expect(toSessionSharePreview(payload, NOW_MS + 9999_000).remainingMs).toBe(0);
  });

  it('14. clamps shared cookie expiries without mutating source cookies', () => {
    const expiresAtMs = NOW_MS + 3600_000;
    const maxExpSec = Math.floor(expiresAtMs / 1000);
    const cookies = [
      makeBrowserCookie({ name: 'sess', session: true, expirationDate: undefined }),
      makeBrowserCookie({ name: 'long_tok', session: false, expirationDate: NOW_SEC + 86_400 * 30 }),
      makeBrowserCookie({ name: 'short_tok', session: false, expirationDate: NOW_SEC + 600 }),
      makeBrowserCookie({ name: 'ms_tok', session: false, expirationDate: (NOW_SEC + 99999) * 1000 }),
    ];

    const unclamped = clampSharedCookiesExpiry(cookies, expiresAtMs, false);
    expect(unclamped).not.toBe(cookies);
    expect(unclamped[0]).not.toBe(cookies[0]);
    expect(unclamped[0].session).toBe(true);
    expect(unclamped[1].expirationDate).toBe(NOW_SEC + 86_400 * 30);

    const clamped = clampSharedCookiesExpiry(cookies, expiresAtMs, true);
    expect(clamped.every((c) => c.session === false)).toBe(true);
    expect(clamped[0].expirationDate).toBe(maxExpSec);
    expect(clamped[1].expirationDate).toBe(maxExpSec);
    expect(clamped[2].expirationDate).toBe(NOW_SEC + 600);
    expect(clamped[3].expirationDate).toBe(maxExpSec);
    expect(cookies[0].session).toBe(true); // original unmodified
  });
});

// ---------------------------------------------------------------------------
// 3. Safe Structured-Clone Value & IDB Key Codec (Feature 1.2)
// ---------------------------------------------------------------------------

describe('crypto/typedCloneCodec: Safe Structured-Clone & IDB Key Codec', () => {
  it('15. round-trips primitives, special numbers (-0/NaN/Infinity/-Infinity), undefined, and bigint', () => {
    const input = {
      n: null,
      b: false,
      s: 'hello 世界',
      u: undefined,
      nan: NaN,
      inf: Infinity,
      ninf: -Infinity,
      neg0: -0,
      big: 98765432109876543210987654321n,
      arr: [1, undefined, NaN, -Infinity],
    };

    const encoded = encodeTypedValue(input);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.byteLength).toBeGreaterThan(0);

    const decoded = decodeTypedValue<typeof input>(encoded.encoded);
    expect(decoded.n).toBeNull();
    expect(decoded.b).toBe(false);
    expect(decoded.s).toBe('hello 世界');
    expect('u' in decoded).toBe(true);
    expect(decoded.u).toBeUndefined();
    expect(Number.isNaN(decoded.nan)).toBe(true);
    expect(decoded.inf).toBe(Infinity);
    expect(decoded.ninf).toBe(-Infinity);
    expect(Object.is(decoded.neg0, -0)).toBe(true);
    expect(decoded.big).toBe(98765432109876543210987654321n);
    expect(decoded.arr[1]).toBeUndefined();
    expect(Number.isNaN(decoded.arr[2] as number)).toBe(true);
    expect(decoded.arr[3]).toBe(-Infinity);
  });

  it('16. round-trips Date (incl. Invalid Date), RegExp, ArrayBuffer, TypedArrays, DataView, Map, and Set', () => {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, 0xdeadbeef, false);
    const subU8 = new Uint8Array(buf, 1, 2);

    const input = {
      date: new Date('2026-01-15T12:30:00.123Z'),
      badDate: new Date(NaN),
      regex: /session-\d+/gi,
      u8: subU8,
      ab: buf,
      i16: new Int16Array([-300, 300]),
      f64: new Float64Array([1.5, -2.25]),
      dv: new DataView(buf),
      map: new Map<unknown, unknown>([
        ['k1', 123],
        [42, { nested: new Set(['a', 'b']) }],
      ]),
      set: new Set<unknown>([1, 'two', undefined]),
    };

    const res = encodeTypedValue(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const decoded = decodeTypedValue<typeof input>(res.encoded);
    expect(decoded.date).toBeInstanceOf(Date);
    expect(decoded.date.toISOString()).toBe('2026-01-15T12:30:00.123Z');
    expect(Number.isNaN(decoded.badDate.getTime())).toBe(true);
    expect(decoded.regex).toBeInstanceOf(RegExp);
    expect(decoded.regex.source).toBe('session-\\d+');
    expect(decoded.regex.flags).toBe('gi');
    expect(Array.from(decoded.u8)).toEqual([0xad, 0xbe]);
    expect(Array.from(new Uint8Array(decoded.ab))).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(Array.from(decoded.i16)).toEqual([-300, 300]);
    expect(Array.from(decoded.f64)).toEqual([1.5, -2.25]);
    expect(decoded.dv.getUint32(0, false)).toBe(0xdeadbeef);
    expect(decoded.map.get('k1')).toBe(123);
    const mapNested = decoded.map.get(42) as { nested: Set<string> };
    expect(Array.from(mapNested.nested)).toEqual(['a', 'b']);
    expect(Array.from(decoded.set)).toEqual([1, 'two', undefined]);
  });

  it('17. escapes literal $sm_t user object keys, supports null-prototype objects, and handles shared DAG refs', () => {
    const shared = { count: 7 };
    const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, { x: 1 });
    const payload = {
      spoofDate: { $sm_t: 'date', v: new Date(0) },
      spoofRaw: { $sm_t: 'raw_obj', v: 'literal-string' },
      left: shared,
      right: shared,
      nullProto,
    };

    const res = encodeTypedValue(payload);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const decoded = decodeTypedValue<typeof payload>(res.encoded);
    expect(decoded.spoofDate.$sm_t).toBe('date');
    expect(decoded.spoofDate.v).toBeInstanceOf(Date);
    expect((decoded.spoofDate.v as Date).getTime()).toBe(0);
    expect(decoded.spoofRaw).toEqual({ $sm_t: 'raw_obj', v: 'literal-string' });
    expect(decoded.left).toEqual({ count: 7 });
    expect(decoded.right).toEqual({ count: 7 });
    expect(decoded.nullProto).toEqual({ x: 1 });
  });

  it('18. detects circular references in objects, arrays, Maps, and Sets without crashing', () => {
    const circObj: Record<string, unknown> = { a: 1 };
    circObj.self = circObj;
    expect(encodeTypedValue(circObj)).toEqual({ ok: false, reason: 'circular_reference' });

    const circArr: unknown[] = [];
    circArr.push(circArr);
    expect(encodeTypedValue(circArr)).toEqual({ ok: false, reason: 'circular_reference' });

    const circMap = new Map<unknown, unknown>();
    circMap.set('self', circMap);
    expect(encodeTypedValue(circMap)).toEqual({ ok: false, reason: 'circular_reference' });

    const circSet = new Set<unknown>();
    circSet.add(circSet);
    expect(encodeTypedValue(circSet)).toEqual({ ok: false, reason: 'circular_reference' });
  });

  it('19. rejects non-serializable host objects (CryptoKey, Blob, File, Function, Symbol, WeakMap, DOM/FileSystemHandle)', async () => {
    const cryptoKey = await globalThis.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    );
    const keyRes = encodeTypedValue({ key: cryptoKey });
    expect(keyRes.ok).toBe(false);
    if (!keyRes.ok) {
      expect(keyRes.reason).toContain('unsupported_non_serializable_type:');
    }

    expect(encodeTypedValue(new Blob(['hello']))).toMatchObject({
      ok: false,
      reason: 'unsupported_non_serializable_type:Blob',
    });

    if (typeof File !== 'undefined') {
      expect(encodeTypedValue(new File(['a'], 'a.txt'))).toMatchObject({
        ok: false,
        reason: 'unsupported_non_serializable_type:File',
      });
    }

    expect(encodeTypedValue(() => 1)).toEqual({
      ok: false,
      reason: 'unsupported_non_serializable_type:Function',
    });
    expect(encodeTypedValue(Symbol('s'))).toEqual({
      ok: false,
      reason: 'unsupported_non_serializable_type:Symbol',
    });
    expect(encodeTypedValue(new WeakMap())).toEqual({
      ok: false,
      reason: 'unsupported_non_serializable_type:WeakMap',
    });

    const plainDomLike = { nodeType: 1, nodeName: 'DIV' };
    expect(encodeTypedValue(plainDomLike)).toEqual({
      ok: false,
      reason: 'unsupported_non_serializable_type:DOMNode',
    });

    const fakeFsHandle = { [Symbol.toStringTag]: 'FileSystemFileHandle' };
    expect(encodeTypedValue(fakeFsHandle)).toEqual({
      ok: false,
      reason: 'unsupported_non_serializable_type:FileSystemFileHandle',
    });
  });

  it('20. deterministically encodes/decodes valid IDB keys without collisions and rejects invalid keys', () => {
    const kNum = encodeIdbKey(42);
    const kInf = encodeIdbKey(Infinity);
    const kNInf = encodeIdbKey(-Infinity);
    const kNeg0 = encodeIdbKey(-0);
    const kZero = encodeIdbKey(0);
    const kStr = encodeIdbKey('42');
    const kArr = encodeIdbKey([42]);
    const kDate = encodeIdbKey(new Date(42));
    const kU8 = encodeIdbKey(new Uint8Array([1, 2, 3]));
    const kAb = encodeIdbKey(Uint8Array.from([1, 2, 3]).buffer);
    const kNested = encodeIdbKey(['users', 1, new Date(1700000000000), [new Uint8Array([9])]]);

    expect(
      kNum.ok && kInf.ok && kNInf.ok && kNeg0.ok && kZero.ok && kStr.ok && kArr.ok && kDate.ok && kU8.ok && kAb.ok && kNested.ok,
    ).toBe(true);
    if (
      !kNum.ok || !kInf.ok || !kNInf.ok || !kNeg0.ok || !kZero.ok || !kStr.ok || !kArr.ok || !kDate.ok || !kU8.ok || !kAb.ok || !kNested.ok
    ) {
      return;
    }

    expect(new Set([kNum.encodedKey, kStr.encodedKey, kArr.encodedKey, kDate.encodedKey, kU8.encodedKey]).size).toBe(5);
    expect(kU8.encodedKey).toBe(kAb.encodedKey);
    expect(kNeg0.encodedKey).toBe(kZero.encodedKey);

    expect(decodeIdbKey(kNum.encodedKey)).toBe(42);
    expect(decodeIdbKey(kInf.encodedKey)).toBe(Infinity);
    expect(decodeIdbKey(kNInf.encodedKey)).toBe(-Infinity);
    expect(decodeIdbKey(kStr.encodedKey)).toBe('42');
    expect(decodeIdbKey(kArr.encodedKey)).toEqual([42]);
    expect((decodeIdbKey(kDate.encodedKey) as Date).getTime()).toBe(42);
    expect(Array.from(new Uint8Array(decodeIdbKey(kU8.encodedKey) as ArrayBuffer))).toEqual([1, 2, 3]);

    const decodedNested = decodeIdbKey(kNested.encodedKey) as unknown[];
    expect(decodedNested[0]).toBe('users');
    expect(decodedNested[1]).toBe(1);
    expect((decodedNested[2] as Date).getTime()).toBe(1700000000000);
    expect(Array.from(new Uint8Array((decodedNested[3] as unknown[])[0] as ArrayBuffer))).toEqual([9]);

    const circKey: unknown[] = [];
    circKey.push(circKey);
    expect(encodeIdbKey(NaN).ok).toBe(false);
    expect(encodeIdbKey(new Date(NaN)).ok).toBe(false);
    expect(encodeIdbKey(true).ok).toBe(false);
    expect(encodeIdbKey(null).ok).toBe(false);
    expect(encodeIdbKey(undefined).ok).toBe(false);
    expect(encodeIdbKey({ plain: 1 }).ok).toBe(false);
    expect(encodeIdbKey(circKey).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Multi-Provider Pairing v2 + v1 Compat (pairing.ts)
// ---------------------------------------------------------------------------

describe('crypto/pairing: Multi-Provider v2 + v1 Compatibility', () => {
  it('21. decodes v1 WebDAV pairing payload and populates normalized storage alongside webdav', async () => {
    const v1Payload: PairingPayload = {
      version: 1,
      webdav: {
        url: 'https://dav.example.com/dav',
        authType: 'basic',
        username: 'alice',
        password: 'pw',
        rootPath: '/SessionMesh',
      },
      spaceId: 'sp_v1',
      spaceName: 'V1 Space',
      createdAt: NOW_MS,
      fromDeviceName: 'Laptop',
    };

    const code = await encodePairingCode(v1Payload, 'pair-pw-1');
    const decoded = await decodePairingCode(code, 'pair-pw-1');
    expect(decoded.version).toBe(1);
    expect(decoded.webdav).toEqual(v1Payload.webdav);
    expect(decoded.storage).toEqual({
      provider: 'webdav',
      ...v1Payload.webdav,
    });
  });

  it('22. decodes v2 WebDAV storage (back-populating webdav) and v2 legacy webdav-only payloads', async () => {
    const v2Webdav: PairingPayload = {
      version: 2,
      storage: {
        provider: 'webdav',
        url: 'https://dav.example.com/v2',
        authType: 'app_password',
        username: 'bob',
        password: 'app-pw',
        rootPath: '/sm',
      },
      spaceId: 'sp_v2_dav',
      spaceName: 'V2 WebDAV',
      createdAt: NOW_MS,
      fromDeviceName: 'Desktop',
    };

    const davCode = await encodePairingCode(v2Webdav, 'pair-pw-2');
    const davDecoded = await decodePairingCode(davCode, 'pair-pw-2');
    expect(davDecoded.version).toBe(2);
    expect(davDecoded.storage?.provider).toBe('webdav');
    expect(davDecoded.webdav).toEqual({
      url: 'https://dav.example.com/v2',
      authType: 'app_password',
      username: 'bob',
      password: 'app-pw',
      rootPath: '/sm',
    });

    const v2LegacyWebdav: PairingPayload = {
      version: 2,
      webdav: {
        url: 'https://dav.example.com/legacy',
        authType: 'bearer',
        bearerToken: 'tok',
        rootPath: '/sm',
      },
      spaceId: 'sp_v2_legacy',
      spaceName: 'V2 Legacy',
      createdAt: NOW_MS,
      fromDeviceName: 'Desktop',
    };
    const legacyCode = await encodePairingCode(v2LegacyWebdav, 'pair-pw-leg');
    const legacyDecoded = await decodePairingCode(legacyCode, 'pair-pw-leg');
    expect(legacyDecoded.storage).toEqual({
      provider: 'webdav',
      ...v2LegacyWebdav.webdav,
    });
  });

  it('23. round-trips v2 S3, GitHub Gist, and Local Directory providers without fabricating webdav', async () => {
    const providers: PairingPayload[] = [
      {
        version: 2,
        storage: {
          provider: 's3',
          vendorPreset: 'r2',
          endpoint: 'https://acct.r2.cloudflarestorage.com',
          region: 'auto',
          bucket: 'sessionmesh',
          accessKeyId: 'ak_123',
          secretAccessKey: 'sk_456',
          rootPrefix: 'sm/',
        },
        spaceId: 'sp_s3',
        spaceName: 'S3 Space',
        createdAt: NOW_MS,
        fromDeviceName: 'Desktop',
      },
      {
        version: 2,
        storage: {
          provider: 'github_gist',
          personalAccessToken: 'ghp_secret_token',
          gistId: 'gist_123',
        },
        spaceId: 'sp_gist',
        spaceName: 'Gist Space',
        createdAt: NOW_MS,
        fromDeviceName: 'Laptop',
      },
      {
        version: 2,
        storage: {
          provider: 'local_directory',
          directoryLabel: 'OneDrive/SessionMesh',
          handleKey: 'hdl_local_1',
        },
        spaceId: 'sp_local',
        spaceName: 'Local Space',
        createdAt: NOW_MS,
        fromDeviceName: 'Workstation',
      },
    ];

    for (const payload of providers) {
      const code = await encodePairingCode(payload, 'pair-pw-multi');
      const decoded = await decodePairingCode(code, 'pair-pw-multi');
      expect(decoded).toEqual(payload);
      expect(decoded.webdav).toBeUndefined();
    }
  });

  it('24. rejects malformed v1/v2 pairing payloads and cross-domain session share tokens', async () => {
    await expect(
      encodePairingCode(
        {
          version: 1,
          spaceId: 'sp_bad',
          spaceName: 'Bad',
          createdAt: NOW_MS,
          fromDeviceName: 'Dev',
        },
        'pw',
      ),
    ).rejects.toThrow(/ENCRYPT_INVALID_PAIRING_CODE/);

    await expect(
      encodePairingCode(
        {
          version: 2,
          spaceId: 'sp_bad2',
          spaceName: 'Bad2',
          createdAt: NOW_MS,
          fromDeviceName: 'Dev',
        },
        'pw',
      ),
    ).rejects.toThrow(/ENCRYPT_INVALID_PAIRING_CODE/);

    const shareCode = await encodeSessionShare(
      {
        version: 1,
        shareId: 'shr_x',
        siteKey: 'example.com',
        createdAt: NOW_MS,
        expiresAt: NOW_MS + 60_000,
        clampCookieExpiry: false,
        cookies: [makeBrowserCookie()],
      },
      'pw',
      { iterations: 1000 },
    );
    await expect(decodePairingCode(shareCode, 'pw')).rejects.toThrow(/DECRYPT_INVALID_PAIRING_CODE/);
    await expect(
      decodePairingCode(shareCode.replace(SESSION_SHARE_PREFIX, 'smesh://pair/v1.'), 'pw'),
    ).rejects.toThrow(/DECRYPT_AAD_MISMATCH/);
  });
});

// ---------------------------------------------------------------------------
// 5. Smart Cookie Expiry Warning (Feature 2.3)
// ---------------------------------------------------------------------------

describe('diagnostics/expiryMonitor: Smart Cookie Expiry Warning', () => {
  it('25. identifies short-lived CSRF and anti-bot cookies without false positives on auth cookies', () => {
    for (const name of [
      'csrf',
      'xsrf',
      '_csrf',
      'XSRF-TOKEN',
      'nonce',
      'oauth_state',
      '_cf_bm',
      'cf_clearance',
      'ak_bmsc',
      'bm_sz',
      'AWSALB',
      'AWSALBCORS',
    ]) {
      expect(isShortLivedCsrfOrAntiBotCookie(name), name).toBe(true);
    }
    expect(isShortLivedCsrfOrAntiBotCookie('user_session')).toBe(false);
    expect(isShortLivedCsrfOrAntiBotCookie('__Host-sid')).toBe(false);
  });

  it('26. classifies likely auth cookies while excluding noise and CSRF/anti-bot cookies even if httpOnly', () => {
    expect(isLikelyAuthCookie({ name: 'cf_clearance', httpOnly: true, secure: true })).toBe(false);
    expect(isLikelyAuthCookie({ name: 'AWSALBCORS', httpOnly: true, secure: true })).toBe(false);
    expect(isLikelyAuthCookie({ name: '_ga', httpOnly: true, secure: true })).toBe(false);
    expect(isLikelyAuthCookie({ name: 'opaque_http', httpOnly: true, secure: true })).toBe(true);
    expect(isLikelyAuthCookie({ name: 'auth_token', httpOnly: false, secure: true })).toBe(true);
    expect(isLikelyAuthCookie({ name: 'refresh_tok', httpOnly: false, secure: true })).toBe(true);
    expect(isLikelyAuthCookie({ name: '__Host-id', httpOnly: false, secure: true })).toBe(true);
    expect(isLikelyAuthCookie({ name: '__Secure-id', httpOnly: false, secure: true })).toBe(true);
    expect(isLikelyAuthCookie({ name: 'theme_pref', httpOnly: false, secure: false })).toBe(false);
    expect(isLikelyAuthCookie({ name: 'theme_pref', httpOnly: false, secure: false }, true)).toBe(true);
  });

  it('27. grades L1 watched and L2 auth cookies across expired/critical/expiring_soon/healthy and counts sessionOnlyAuthCount', () => {
    const cookies: CookieRecord[] = [
      makeCookieRecord({
        name: 'custom_watched',
        httpOnly: false,
        expirationDate: NOW_SEC + 60 * 30, // 30m -> critical
      }),
      makeCookieRecord({
        name: 'user_session',
        httpOnly: true,
        expirationDate: NOW_SEC - 120, // -2m -> expired
      }),
      makeCookieRecord({
        name: 'refresh_token',
        httpOnly: true,
        expirationDate: NOW_SEC + 3600 * 10, // 10h -> expiring_soon
      }),
      makeCookieRecord({
        name: 'long_auth',
        httpOnly: true,
        expirationDate: NOW_SEC + 86_400 * 30, // healthy
      }),
      makeCookieRecord({
        name: 'sess_only_http',
        httpOnly: true,
        session: true,
        expirationDate: undefined,
      }),
      makeCookieRecord({
        name: 'watched_sess_only',
        httpOnly: false,
        session: true,
        expirationDate: undefined,
      }),
      makeCookieRecord({
        name: 'ui_lang',
        httpOnly: false,
        session: true,
        expirationDate: undefined,
      }),
    ];

    const health = evaluateSiteExpiryHealth({
      siteKey: 'example.com',
      cookies,
      tracks: { trk_main: { label: 'Main Account' } },
      watchedCookieNames: ['CUSTOM_WATCHED', 'WATCHED_SESS_ONLY'],
      nowMs: NOW_MS,
    });

    expect(health.status).toBe('expired');
    expect(health.sessionOnlyAuthCount).toBe(2);
    expect(health.expiringCookies.map((c) => [c.name, c.status, c.watched])).toEqual([
      ['user_session', 'expired', false],
      ['custom_watched', 'critical', true],
      ['refresh_token', 'expiring_soon', false],
    ]);
    expect(health.expiringCookies[0].trackLabel).toBe('Main Account');
    expect(health.remainingMs).toBe(-120_000);
    expect(health.earliestExpiryAt).toBe(NOW_MS - 120_000);
  });

  it('28. applies L3 whole-track fallback only when no L1/L2 persistent cookie exists and all non-noise cookies expire soon', () => {
    const trackACookies: CookieRecord[] = [
      makeCookieRecord({
        trackId: 'trk_a',
        name: 'x_custom_1',
        httpOnly: false,
        expirationDate: NOW_SEC + 3600 * 5,
      }),
      makeCookieRecord({
        trackId: 'trk_a',
        name: 'x_custom_2',
        httpOnly: false,
        expirationDate: NOW_SEC + 3600 * 1,
      }),
      makeCookieRecord({
        trackId: 'trk_a',
        name: '_ga',
        httpOnly: false,
        expirationDate: NOW_SEC + 86_400 * 365,
      }),
    ];
    const healthA = evaluateSiteExpiryHealth({
      siteKey: 'custom.example',
      cookies: trackACookies,
      nowMs: NOW_MS,
    });
    expect(healthA.status).toBe('critical');
    expect(healthA.expiringCookies).toHaveLength(2);

    // One long-lived non-noise cookie prevents L3 fallback
    const healthB = evaluateSiteExpiryHealth({
      siteKey: 'custom.example',
      cookies: [
        ...trackACookies,
        makeCookieRecord({
          trackId: 'trk_a',
          name: 'x_long_pref',
          httpOnly: false,
          expirationDate: NOW_SEC + 86_400 * 60,
        }),
      ],
      nowMs: NOW_MS,
    });
    expect(healthB.status).toBe('healthy');

    // Healthy L2 auth cookie prevents L3 fallback on short-lived non-auth cookies
    const healthC = evaluateSiteExpiryHealth({
      siteKey: 'custom.example',
      cookies: [
        makeCookieRecord({
          trackId: 'trk_c',
          name: 'session_id',
          httpOnly: true,
          expirationDate: NOW_SEC + 86_400 * 30,
        }),
        makeCookieRecord({
          trackId: 'trk_c',
          name: 'x_banner_dismissed',
          httpOnly: false,
          expirationDate: NOW_SEC + 1800,
        }),
      ],
      nowMs: NOW_MS,
    });
    expect(healthC.status).toBe('healthy');
  });

  it('29. ignores ancient (>7d) expired non-watched cookies, deleted cookies, disabled settings, and inactive tracks when configured', () => {
    const eightDaysAgoSec = NOW_SEC - 8 * 86_400;
    const cookies: CookieRecord[] = [
      makeCookieRecord({
        trackId: 'trk_active',
        name: 'stale_session',
        httpOnly: true,
        expirationDate: eightDaysAgoSec,
      }),
      makeCookieRecord({
        trackId: 'trk_active',
        name: 'watched_stale',
        httpOnly: false,
        expirationDate: eightDaysAgoSec,
      }),
      makeCookieRecord({
        trackId: 'trk_active',
        name: 'deleted_soon',
        httpOnly: true,
        deleted: true,
        expirationDate: NOW_SEC + 600,
      }),
      makeCookieRecord({
        trackId: 'trk_inactive',
        name: 'inactive_auth',
        httpOnly: true,
        expirationDate: NOW_SEC + 600,
      }),
    ];

    expect(
      evaluateSiteExpiryHealth({
        siteKey: 'example.com',
        cookies,
        settings: { enabled: false },
        nowMs: NOW_MS,
      }).status,
    ).toBe('healthy');

    const activeOnly = evaluateSiteExpiryHealth({
      siteKey: 'example.com',
      cookies,
      activeTrackId: 'trk_active',
      settings: { includeInactiveTracks: false },
      nowMs: NOW_MS,
    });
    expect(activeOnly.status).toBe('healthy');
    expect(activeOnly.expiringCookies).toHaveLength(0);

    const withWatchedAndInactive = evaluateSiteExpiryHealth({
      siteKey: 'example.com',
      cookies,
      activeTrackId: 'trk_active',
      watchedCookieNames: ['watched_stale'],
      settings: { includeInactiveTracks: true },
      nowMs: NOW_MS,
    });
    expect(withWatchedAndInactive.status).toBe('expired');
    expect(withWatchedAndInactive.expiringCookies.map((c) => c.name)).toEqual([
      'watched_stale',
      'inactive_auth',
    ]);
  });

  it('30. handles millisecond expirationDate and custom lead-hour boundaries accurately', () => {
    const cookies: CookieRecord[] = [
      makeCookieRecord({
        name: 'ms_critical',
        httpOnly: true,
        expirationDate: NOW_MS + 3600_000, // 1h in ms
      }),
      makeCookieRecord({
        name: 'sec_expiring_soon',
        httpOnly: true,
        expirationDate: NOW_SEC + 3600 * 6, // 6h in sec
      }),
    ];

    const health = evaluateSiteExpiryHealth({
      siteKey: 'example.com',
      cookies,
      settings: { warningLeadHours: 12, criticalLeadHours: 1 },
      nowMs: NOW_MS,
    });
    expect(health.status).toBe('critical');
    expect(health.expiringCookies.map((c) => [c.name, c.status])).toEqual([
      ['ms_critical', 'critical'],
      ['sec_expiring_soon', 'expiring_soon'],
    ]);
  });
});
