import { describe, expect, it } from 'vitest';
import { MockWebDAVServer } from '@sessionmesh/webdav-mock';
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  decodePairingCode,
  decryptWithDek,
  decryptWithPassword,
  deriveOpaqueId,
  encodePairingCode,
  encryptWithDek,
  encryptWithPassword,
  generateRandomBytes,
  generateSpaceDekBase64,
  isSmesEnvelope,
  parseSmesHeader,
  sha256Hex,
  SMES_FLAG_GZIP,
  SMES_FLAG_PROTOBUF,
} from '../src/crypto';
import {
  normalizeEtag,
  parseWebDAVMultistatusXml,
  WebDAVCapabilityDetector,
  WebDAVClient,
  WebDAVHttpError,
} from '../src/webdav';
import type { EventBatch, PairingPayload, SnapshotPayload, WebDAVConfig } from '../src/types';

function makeHttpsConfig(overrides: Partial<WebDAVConfig> = {}): WebDAVConfig {
  return {
    url: 'https://dav.sessionmesh.test/dav',
    authType: 'basic',
    username: 'alice',
    password: 'app-password-secret',
    rootPath: '/SessionMesh',
    requestTimeoutMs: 5000,
    ...overrides,
  };
}

describe('SMES v2 E2E Crypto Engine, Keyring Rotation & Pairing Code', () => {
  it('round-trips password envelope (JSON & Protobuf, compressed & uncompressed) and rejects wrong password/tampering', async () => {
    const payload = {
      spaceId: 'work-space',
      nested: { arr: [1, 2.5, true, false, null, 'hello 世界'], empty: {} },
      verifier: 'SESSIONMESH_SPACE_OK',
    };
    const aad = 'work-space|1|space_meta|/metadata/space.enc';

    for (const encoding of ['json', 'protobuf'] as const) {
      for (const compress of [true, false]) {
        const env = await encryptWithPassword(payload, 'StrongPass!2026', aad, {
          encoding,
          compress,
          iterations: 1000,
          keyEpoch: 1,
        });

        expect(isSmesEnvelope(env)).toBe(true);
        const header = parseSmesHeader(env);
        expect(header.version).toBe(2);
        expect(header.keyEpoch).toBe(1);
        expect(header.iterations).toBe(1000);
        expect(header.salt.byteLength).toBe(16);
        expect(header.iv.byteLength).toBe(12);
        expect(header.aad).toBe(aad);
        expect((header.flags & SMES_FLAG_GZIP) !== 0).toBe(compress);
        expect((header.flags & SMES_FLAG_PROTOBUF) !== 0).toBe(encoding === 'protobuf');

        // Plaintext must NEVER appear inside ciphertext envelope
        const rawStr = new TextDecoder('utf-8', { fatal: false }).decode(env);
        expect(rawStr).not.toContain('SESSIONMESH_SPACE_OK');
        expect(rawStr).not.toContain('hello 世界');

        const decrypted = await decryptWithPassword<typeof payload>(env, 'StrongPass!2026', aad);
        expect(decrypted).toEqual(payload);

        // Wrong password MUST fail with DECRYPT semantics
        await expect(decryptWithPassword(env, 'WrongPass!2026', aad)).rejects.toThrow(/DECRYPT/i);

        // Wrong expected AAD MUST fail
        await expect(
          decryptWithPassword(env, 'StrongPass!2026', 'other-space|1|space_meta|/metadata/space.enc'),
        ).rejects.toThrow(/DECRYPT/i);

        // Flipping ciphertext byte MUST fail
        const tamperedCipher = new Uint8Array(env);
        tamperedCipher[tamperedCipher.length - 1] ^= 0x01;
        await expect(decryptWithPassword(tamperedCipher, 'StrongPass!2026', aad)).rejects.toThrow(/DECRYPT/i);

        // Flipping header flags byte MUST fail GCM authentication
        const tamperedHeader = new Uint8Array(env);
        tamperedHeader[5] ^= SMES_FLAG_GZIP;
        await expect(decryptWithPassword(tamperedHeader, 'StrongPass!2026', aad)).rejects.toThrow(/DECRYPT/i);
      }
    }
  });

  it('supports HKDF DEK encryption and seamless multi-epoch keyring rotation', async () => {
    const dekEpoch1 = await generateSpaceDekBase64();
    const dekEpoch2 = await generateSpaceDekBase64();
    expect(base64ToBytes(dekEpoch1).byteLength).toBe(32);
    expect(dekEpoch1).not.toBe(dekEpoch2);

    const keyring: Record<number, string> = {
      1: dekEpoch1,
      2: dekEpoch2,
    };

    const objV1 = { cookie: 'sid=old-epoch-token', seq: 1 };
    const objV2 = { cookie: 'sid=new-epoch-token', seq: 2 };

    const env1 = await encryptWithDek(objV1, dekEpoch1, 1, 'spaceA|1|event_batch|/events/dev1/1.enc', {
      encoding: 'json',
      compress: true,
    });
    const env2 = await encryptWithDek(objV2, dekEpoch2, 2, 'spaceA|2|event_batch|/events/dev1/2.enc', {
      encoding: 'protobuf',
      compress: true,
    });

    expect(parseSmesHeader(env1).iterations).toBe(0);
    expect(parseSmesHeader(env1).keyEpoch).toBe(1);
    expect(parseSmesHeader(env2).keyEpoch).toBe(2);

    // Decrypt both epochs seamlessly with shared keyring + prefix AAD check
    const res1 = await decryptWithDek<typeof objV1>(env1, keyring, 'spaceA|');
    expect(res1.data).toEqual(objV1);
    expect(res1.header.keyEpoch).toBe(1);

    const res2 = await decryptWithDek<typeof objV2>(env2, keyring, 'spaceA|');
    expect(res2.data).toEqual(objV2);
    expect(res2.header.keyEpoch).toBe(2);

    // Missing epoch in keyring fails cleanly
    await expect(decryptWithDek(env2, { 1: dekEpoch1 }, 'spaceA|')).rejects.toThrow(/DECRYPT/i);

    // Cross-space AAD substitution fails cleanly
    await expect(decryptWithDek(env1, keyring, 'spaceB|')).rejects.toThrow(/DECRYPT/i);
  });

  it('encodes and decodes encrypted smesh://pair/v1 pairing codes', async () => {
    const payload: PairingPayload = {
      version: 1,
      webdav: makeHttpsConfig(),
      spaceId: 'personal-space',
      spaceName: 'Personal Space',
      createdAt: 1730000000000,
      fromDeviceName: 'Windows Edge Desktop',
    };

    const code = await encodePairingCode(payload, 'pair-secret-123');
    expect(code.startsWith('smesh://pair/v1.')).toBe(true);
    expect(code).not.toContain('app-password-secret');
    expect(code).not.toContain('dav.sessionmesh.test');

    const decoded = await decodePairingCode(code, 'pair-secret-123');
    expect(decoded).toEqual(payload);

    await expect(decodePairingCode(code, 'wrong-passphrase')).rejects.toThrow(/DECRYPT/i);
    await expect(decodePairingCode('https://not-a-pairing-code', 'pair-secret-123')).rejects.toThrow(/DECRYPT/i);
  });

  it('provides deterministic opaque IDs, SHA-256 hex, base64, and random bytes helpers', async () => {
    const opaque1 = await deriveOpaqueId('my-secret-space', 'sp');
    const opaque2 = await deriveOpaqueId('my-secret-space', 'sp');
    const opaqueOther = await deriveOpaqueId('other-space', 'sp');
    expect(opaque1).toBe(opaque2);
    expect(opaque1).not.toBe(opaqueOther);
    expect(opaque1.startsWith('sp_')).toBe(true);
    expect(opaque1).not.toContain('my-secret-space');

    const rnd = generateRandomBytes(64);
    expect(rnd.byteLength).toBe(64);
    expect(base64ToBytes(bytesToBase64(rnd))).toEqual(rnd);
    expect(bytesToHex(new Uint8Array([0x00, 0xab, 0xff]))).toBe('00abff');
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('WebDAV Acceptance Suite (W-001 through W-018)', () => {
  it('W-001: enforces HTTPS by default and rejects insecure HTTP / malformed URLs', async () => {
    const server = new MockWebDAVServer();

    // Non-localhost HTTP must be rejected
    const insecureClient = new WebDAVClient(
      makeHttpsConfig({ url: 'http://dav.example.com/dav', allowInsecureLocalhostForTesting: true }),
      { fetchImpl: server.fetchImpl },
    );
    expect(() => insecureClient.validateUrl()).toThrow(WebDAVHttpError);
    await expect(insecureClient.options()).rejects.toMatchObject({
      code: 'WEBDAV_INSECURE_HTTP',
      retryable: false,
    });

    // Localhost HTTP without explicit testing flag must be rejected
    const localhostBlocked = new WebDAVClient(
      makeHttpsConfig({ url: 'http://127.0.0.1:8080/dav', allowInsecureLocalhostForTesting: false }),
      { fetchImpl: server.fetchImpl },
    );
    expect(() => localhostBlocked.validateUrl()).toThrow(WebDAVHttpError);

    // Malformed URL rejected by capability detector
    const badReport = await new WebDAVCapabilityDetector(makeHttpsConfig({ url: 'not-a-valid-url' }), {
      fetchImpl: server.fetchImpl,
    }).runFullCheck();
    expect(badReport.overallOk).toBe(false);
    expect(badReport.consistencyLevel).toBe('incompatible');
    expect(badReport.checks[0].state).toBe('unsupported');

    // Plain HTTP rejected by capability detector at Step 2
    const httpReport = await new WebDAVCapabilityDetector(
      makeHttpsConfig({ url: 'http://dav.example.com/dav' }),
      { fetchImpl: server.fetchImpl },
    ).runFullCheck();
    expect(httpReport.overallOk).toBe(false);
    expect(httpReport.consistencyLevel).toBe('incompatible');
    expect(httpReport.checks[1].state).toBe('unsupported');
    expect(server.requestCount).toBe(0); // Never sent credentials over insecure HTTP!
  });

  it('W-002: rejects invalid credentials with non-retryable 401 and supports Basic / App-Password / Bearer auth', async () => {
    const server = new MockWebDAVServer({
      requireAuth: {
        username: 'alice',
        password: 'correct-app-password',
        bearerToken: 'bearer-xyz-999',
      },
    });

    const badClient = new WebDAVClient(
      makeHttpsConfig({ authType: 'basic', username: 'alice', password: 'wrong-password' }),
      { fetchImpl: server.fetchImpl },
    );

    // stat() MUST throw 401 — NEVER return null!
    await expect(badClient.stat('')).rejects.toMatchObject({
      status: 401,
      code: 'WEBDAV_AUTH_FAILED',
      retryable: false,
    });

    const badReport = await new WebDAVCapabilityDetector(
      makeHttpsConfig({ authType: 'basic', username: 'alice', password: 'wrong-password' }),
      { fetchImpl: server.fetchImpl },
    ).runFullCheck();
    expect(badReport.overallOk).toBe(false);
    expect(badReport.consistencyLevel).toBe('incompatible');
    expect(badReport.checks[4].id).toBe('authentication');
    expect(badReport.checks[4].state).toBe('unsupported');

    // Valid app_password auth succeeds
    const appPassClient = new WebDAVClient(
      makeHttpsConfig({ authType: 'app_password', username: 'alice', password: 'correct-app-password' }),
      { fetchImpl: server.fetchImpl },
    );
    const opt = await appPassClient.options();
    expect(opt.status).toBe(200);
    expect(opt.dav).toContain('1');

    // Valid bearer auth succeeds
    const bearerClient = new WebDAVClient(
      makeHttpsConfig({ authType: 'bearer', bearerToken: 'bearer-xyz-999', username: undefined, password: undefined }),
      { fetchImpl: server.fetchImpl },
    );
    await expect(bearerClient.options()).resolves.toMatchObject({ status: 200 });
  });

  it('W-003: distinguishes 403 Forbidden (read-only account) as non-retryable write failure', async () => {
    const server = new MockWebDAVServer({
      requireAuth: {
        username: 'admin',
        password: 'admin-password',
        readOnlyUsers: { viewer: 'view-only' },
      },
    });

    // Admin creates mount & root first
    const admin = new WebDAVClient(
      makeHttpsConfig({ username: 'admin', password: 'admin-password' }),
      { fetchImpl: server.fetchImpl },
    );
    await admin.ensureDir('spaces');
    await admin.putBytes('spaces/hello.txt', new TextEncoder().encode('read-me'));

    // Read-only viewer can read & PROPFIND, but cannot MKCOL or PUT or DELETE
    const viewerConfig = makeHttpsConfig({ username: 'viewer', password: 'view-only' });
    const viewer = new WebDAVClient(viewerConfig, { fetchImpl: server.fetchImpl });
    const read = await viewer.getBytes('spaces/hello.txt');
    expect(new TextDecoder().decode(read.bytes)).toBe('read-me');

    await expect(viewer.mkcol('spaces/blocked')).rejects.toMatchObject({
      status: 403,
      code: 'WEBDAV_FORBIDDEN',
      retryable: false,
    });
    await expect(viewer.putBytes('spaces/blocked.bin', new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
      status: 403,
      code: 'WEBDAV_FORBIDDEN',
      retryable: false,
    });

    const report = await new WebDAVCapabilityDetector(viewerConfig, { fetchImpl: server.fetchImpl }).runFullCheck();
    expect(report.overallOk).toBe(false);
    expect(report.consistencyLevel).toBe('incompatible');
    expect(report.checks[8].id).toBe('mkcol_probe_dir');
    expect(report.checks[8].state).toBe('unsupported');
  });

  it('W-004: runs all 19 capability checks cleanly, reports strong_cas, and leaves zero probe artifacts', async () => {
    const server = new MockWebDAVServer({
      requireAuth: { username: 'alice', password: 'app-password-secret' },
      storageQuotaBytes: 50 * 1024 * 1024,
    });
    // Ensure mount directory `/dav` exists just like real WebDAV mount points
    const setup = new WebDAVClient(makeHttpsConfig({ url: 'https://dav.sessionmesh.test', rootPath: '' }), {
      fetchImpl: server.fetchImpl,
    });
    await setup.ensureDir('dav');

    const detector = new WebDAVCapabilityDetector(makeHttpsConfig(), { fetchImpl: server.fetchImpl });
    const report = await detector.runFullCheck();

    expect(report.checks).toHaveLength(19);
    expect(report.overallOk).toBe(true);
    expect(report.consistencyLevel).toBe('strong_cas');
    expect(report.quotaAvailableBytes).toBeGreaterThan(0);

    for (const check of report.checks) {
      expect(check.state, `Step ${check.step} (${check.id}) failed: ${check.detail}`).toBe('supported');
    }

    // Verify Step 19 cleaned up every temporary probe directory/file
    const leftoverProbes = server.listAllStoredPaths().filter((p) => p.includes('.sessionmesh_probe_'));
    expect(leftoverProbes).toEqual([]);
  });

  it('W-005: creates nested collections recursively via ensureDir and enforces RFC 4918 MKCOL 405/409 semantics', async () => {
    const server = new MockWebDAVServer();
    const client = new WebDAVClient(makeHttpsConfig({ url: 'https://dav.sessionmesh.test', rootPath: '/SessionMesh' }), {
      fetchImpl: server.fetchImpl,
    });

    // Direct MKCOL without parent returns 409 Conflict
    await expect(client.mkcol('v1/spaces/sp_1/events')).rejects.toMatchObject({ status: 409 });

    // Recursive ensureDir succeeds idempotently
    await client.ensureDir('v1/spaces/sp_1/events/dev_a');
    await client.ensureDir('v1/spaces/sp_1/events/dev_a'); // second call is idempotent no-op

    // Direct MKCOL on existing directory returns 405 Method Not Allowed
    await expect(client.mkcol('v1/spaces/sp_1/events/dev_a')).rejects.toMatchObject({ status: 405 });

    const st = await client.stat('v1/spaces/sp_1/events/dev_a');
    expect(st).not.toBeNull();
    expect(st?.isCollection).toBe(true);
    expect(st?.path).toBe('/v1/spaces/sp_1/events/dev_a');
  });

  it('W-006: parses PROPFIND 207 Multi-Status across all 4 XML namespace styles, URL-encoded names, and multi-propstat 404s', async () => {
    const styles = ['D_upper', 'd_lower', 'default_xmlns', 'nextcloud'] as const;

    for (const style of styles) {
      const server = new MockWebDAVServer({ xmlNamespaceStyle: style });
      const client = new WebDAVClient(
        makeHttpsConfig({ url: 'https://dav.sessionmesh.test/remote.php/dav/files/alice', rootPath: '/SessionMesh' }),
        { fetchImpl: server.fetchImpl },
      );

      // Prepare mount path `/remote.php/dav/files/alice`
      const rootAdmin = new WebDAVClient(
        makeHttpsConfig({ url: 'https://dav.sessionmesh.test', rootPath: '' }),
        { fetchImpl: server.fetchImpl },
      );
      await rootAdmin.ensureDir('remote.php/dav/files/alice');

      await client.ensureDir('spaces/测试 空间');
      await client.putBytes('spaces/测试 空间/file%20name.enc', new Uint8Array([1, 2, 3, 4, 5]));

      const depth1 = await client.propfind('spaces/测试 空间', 1);
      expect(depth1.length).toBe(2);

      const dirStat = depth1.find((d) => d.isCollection);
      const fileStat = depth1.find((d) => !d.isCollection);

      expect(dirStat?.path).toBe('/spaces/测试 空间');
      expect(dirStat?.name).toBe('测试 空间');
      expect(dirStat?.status).toBe(200);
      expect(dirStat?.quotaAvailableBytes).toBeGreaterThan(0);

      expect(fileStat?.path).toBe('/spaces/测试 空间/file%20name.enc');
      expect(fileStat?.name).toBe('file%20name.enc');
      expect(fileStat?.size).toBe(5);
      expect(fileStat?.etag).toBeTruthy();
      expect(fileStat?.lastModified).toBeTypeOf('number');
    }

    // Extra direct XML parser checks: Apache lp1:, absolute URL href, CDATA, entity-encoded ETag, weak ETag
    const exoticXml = `<?xml version="1.0" encoding="utf-8"?>
      <!-- server comment -->
      <D:multistatus xmlns:D="DAV:" xmlns:lp1="DAV:">
        <D:response>
          <D:href>https://dav.example.com/mount/sub/item%20one.enc</D:href>
          <D:propstat>
            <D:prop>
              <lp1:resourcetype/>
              <lp1:getetag>W/&quot;weak-abc&quot;</lp1:getetag>
              <lp1:getcontentlength><![CDATA[1234]]></lp1:getcontentlength>
            </D:prop>
            <D:status>HTTP/1.1 200 OK</D:status>
          </D:propstat>
          <D:propstat>
            <D:prop><D:quota-used-bytes/></D:prop>
            <D:status>HTTP/1.1 404 Not Found</D:status>
          </D:propstat>
        </D:response>
      </D:multistatus>`;
    const parsed = parseWebDAVMultistatusXml(exoticXml, '/mount');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe('/sub/item one.enc');
    expect(parsed[0].name).toBe('item one.enc');
    expect(parsed[0].etag).toBe('weak-abc');
    expect(parsed[0].size).toBe(1234);
    expect(parsed[0].status).toBe(200);
    expect(parsed[0].isCollection).toBe(false);
  });

  it('W-007: performs binary PUT/GET/MOVE/DELETE accurately and returns null from stat() ONLY on genuine 404', async () => {
    const server = new MockWebDAVServer();
    const client = new WebDAVClient(makeHttpsConfig({ url: 'https://dav.sessionmesh.test', rootPath: '/SessionMesh' }), {
      fetchImpl: server.fetchImpl,
    });

    await client.ensureDir('files');
    expect(await client.stat('files/does-not-exist.enc')).toBeNull();

    const payload = generateRandomBytes(4096);
    const put = await client.putBytes('files/a.enc', payload);
    expect(put.status).toBe(201);
    expect(put.etag).toBeTruthy();

    const got = await client.getBytes('files/a.enc');
    expect(got.notModified).toBe(false);
    expect(await sha256Hex(got.bytes)).toBe(await sha256Hex(payload));

    // MOVE to b.enc
    await client.move('files/a.enc', 'files/b.enc', false);
    expect(await client.stat('files/a.enc')).toBeNull();
    expect((await client.stat('files/b.enc'))?.size).toBe(4096);

    // MOVE with overwrite=false fails with 412 if destination exists
    await client.putBytes('files/c.enc', new Uint8Array([9, 8, 7]));
    await expect(client.move('files/c.enc', 'files/b.enc', false)).rejects.toMatchObject({ status: 412 });

    // DELETE removes b.enc
    await client.delete('files/b.enc');
    expect(await client.stat('files/b.enc')).toBeNull();
  });

  it('W-008: normalizes strong/weak/unquoted ETags and supports 304 Not Modified conditional GET short-circuiting', async () => {
    expect(normalizeEtag('"abc"')).toBe('abc');
    expect(normalizeEtag('W/"abc"')).toBe('abc');
    expect(normalizeEtag('w/"abc"')).toBe('abc');
    expect(normalizeEtag('abc')).toBe('abc');
    expect(normalizeEtag('  ')).toBeUndefined();
    expect(normalizeEtag(null)).toBeUndefined();

    const server = new MockWebDAVServer({ weakEtags: true });
    const client = new WebDAVClient(makeHttpsConfig({ url: 'https://dav.sessionmesh.test', rootPath: '/SessionMesh' }), {
      fetchImpl: server.fetchImpl,
    });
    await client.ensureDir('devices');

    const put = await client.putBytes('devices/devA.enc', new TextEncoder().encode('state-v1'));
    expect(put.etag).toBeTruthy();
    expect(put.etag?.startsWith('W/')).toBe(false);

    // Conditional GET with matching ETag returns 304 Not Modified
    const cached = await client.getBytes('devices/devA.enc', { ifNoneMatch: put.etag });
    expect(cached.notModified).toBe(true);
    expect(cached.status).toBe(304);
    expect(cached.bytes.byteLength).toBe(0);

    // After update, old ETag fetches fresh content with new ETag
    const put2 = await client.putBytes('devices/devA.enc', new TextEncoder().encode('state-v2'));
    expect(put2.etag).not.toBe(put.etag);

    const fresh = await client.getBytes('devices/devA.enc', { ifNoneMatch: put.etag });
    expect(fresh.notModified).toBe(false);
    expect(fresh.status).toBe(200);
    expect(new TextDecoder().decode(fresh.bytes)).toBe('state-v2');
  });

  it('W-009: stores only SMES v2 encrypted ciphertext under opaque paths with zero plaintext leakage', async () => {
    const server = new MockWebDAVServer();
    const client = new WebDAVClient(makeHttpsConfig({ url: 'https://dav.sessionmesh.test', rootPath: '/SessionMesh' }), {
      fetchImpl: server.fetchImpl,
    });

    const opaqueSpace = await deriveOpaqueId('corp-prod-space', 'sp');
    const remotePath = `v1/spaces/${opaqueSpace}/events/dev-1/000001_batch.enc`;
    await client.ensureDir(`v1/spaces/${opaqueSpace}/events/dev-1`);

    const dek = await generateSpaceDekBase64();
    const sensitivePayload = {
      siteKey: 'github.com',
      cookieName: 'user_session',
      cookieValue: 'gho_SUPER_SECRET_SESSION_TOKEN_987654',
    };
    const aad = `corp-prod-space|1|event_batch|/${remotePath}`;
    const encrypted = await encryptWithDek(sensitivePayload, dek, 1, aad, {
      encoding: 'protobuf',
      compress: true,
    });

    await client.putBytes(remotePath, encrypted, { ifNoneMatchStar: true });

    const storedRaw = server.getStoredRawBytes(`/SessionMesh/${remotePath}`);
    expect(storedRaw).toBeDefined();
    expect(isSmesEnvelope(storedRaw!)).toBe(true);

    const rawText = new TextDecoder('utf-8', { fatal: false }).decode(storedRaw!);
    expect(rawText).not.toContain('github.com');
    expect(rawText).not.toContain('user_session');
    expect(rawText).not.toContain('gho_SUPER_SECRET_SESSION_TOKEN_987654');

    // Stored path must NOT reveal plaintext space name or domain
    const allPaths = server.listAllStoredPaths();
    expect(allPaths.some((p) => p.includes('github.com') || p.includes('corp-prod-space'))).toBe(false);
  });

  it('W-010: protects shared metadata updates with If-Match CAS and returns retryable 412 on stale ETag', async () => {
    const server = new MockWebDAVServer();
    const client = new WebDAVClient(makeHttpsConfig({ url: 'https://dav.sessionmesh.test', rootPath: '/SessionMesh' }), {
      fetchImpl: server.fetchImpl,
    });
    await client.ensureDir('metadata');

    const init = await client.putBytes('metadata/space.enc', new TextEncoder().encode('epoch-1'));
    const etag1 = init.etag!;

    // Device A updates using etag1 -> succeeds
    const updateA = await client.putBytes('metadata/space.enc', new TextEncoder().encode('epoch-2-by-A'), {
      ifMatch: etag1,
    });
    expect(updateA.etag).toBeTruthy();
    expect(updateA.etag).not.toBe(etag1);

    // Device B tries stale update using etag1 -> MUST fail with 412
    await expect(
      client.putBytes('metadata/space.enc', new TextEncoder().encode('epoch-2-by-B-stale'), {
        ifMatch: etag1,
      }),
    ).rejects.toMatchObject({
      status: 412,
      code: 'WEBDAV_PRECONDITION_FAILED',
      retryable: true,
    });

    // Verify A's update was NOT clobbered
    const current = await client.getBytes('metadata/space.enc');
    expect(new TextDecoder().decode(current.bytes)).toBe('epoch-2-by-A');

    // Device B re-reads current ETag, merges, and succeeds
    await client.putBytes('metadata/space.enc', new TextEncoder().encode('epoch-3-merged-by-B'), {
      ifMatch: current.etag,
    });
    const finalRead = await client.getBytes('metadata/space.enc');
    expect(new TextDecoder().decode(finalRead.bytes)).toBe('epoch-3-merged-by-B');
  });

  it('W-011: enforces immutable event creation via If-None-Match: * and rejects duplicate writes with 412', async () => {
    const server = new MockWebDAVServer();
    const client = new WebDAVClient(makeHttpsConfig({ url: 'https://dav.sessionmesh.test', rootPath: '/SessionMesh' }), {
      fetchImpl: server.fetchImpl,
    });
    await client.ensureDir('events/devA');

    const first = await client.putBytes('events/devA/000001_evt1.enc', new TextEncoder().encode('immutable-v1'), {
      ifNoneMatchStar: true,
    });
    expect(first.status).toBe(201);

    // Duplicate create to exact same path MUST be rejected with 412
    await expect(
      client.putBytes('events/devA/000001_evt1.enc', new TextEncoder().encode('overwrite-attempt'), {
        ifNoneMatchStar: true,
      }),
    ).rejects.toMatchObject({
      status: 412,
      code: 'WEBDAV_PRECONDITION_FAILED',
    });

    const read = await client.getBytes('events/devA/000001_evt1.enc');
    expect(new TextDecoder().decode(read.bytes)).toBe('immutable-v1');
  });

  it('W-012: detects servers that ignore conditional headers and transparently degrades to append_only_degraded', async () => {
    const weakServer = new MockWebDAVServer({ ignoreConditionalHeaders: true });
    const detector = new WebDAVCapabilityDetector(
      makeHttpsConfig({ url: 'https://dav.sessionmesh.test', rootPath: '/SessionMesh' }),
      { fetchImpl: weakServer.fetchImpl },
    );

    const report = await detector.runFullCheck();
    expect(report.overallOk).toBe(true);
    // Red line #18/#19: MUST NEVER claim strong_cas when server ignores conditional headers!
    expect(report.consistencyLevel).toBe('append_only_degraded');
    expect(report.checks[13].id).toBe('conditional_create');
    expect(report.checks[13].state).toBe('unsupported');
    expect(report.checks[14].id).toBe('conditional_update');
    expect(report.checks[14].state).toBe('unsupported');
    expect(report.checks[18].state).toBe('supported'); // probe still cleaned up!
  });

  it('W-013: handles offline/network outage as retryable error and NEVER misclassifies offline stat() as empty 404', async () => {
    const server = new MockWebDAVServer({ offline: true });
    const client = new WebDAVClient(makeHttpsConfig({ url: 'https://dav.sessionmesh.test', rootPath: '/SessionMesh' }), {
      fetchImpl: server.fetchImpl,
    });

    // Red line #6: offline stat() MUST throw, never return null!
    await expect(client.stat('metadata/space.enc')).rejects.toMatchObject({
      status: 0,
      code: 'WEBDAV_NETWORK_ERROR',
      retryable: true,
    });

    const report = await new WebDAVCapabilityDetector(
      makeHttpsConfig({ url: 'https://dav.sessionmesh.test', rootPath: '/SessionMesh' }),
      { fetchImpl: server.fetchImpl },
    ).runFullCheck();
    expect(report.overallOk).toBe(false);
    expect(report.consistencyLevel).toBe('incompatible');
    expect(report.checks[2].id).toBe('reachability');
    expect(report.checks[2].state).toBe('unsupported');
  });

  it('W-014: recovers after transient offline, 423 Locked, 429 Rate Limited, and timeout faults', async () => {
    const server = new MockWebDAVServer({ offline: true });
    const client = new WebDAVClient(
      makeHttpsConfig({ url: 'https://dav.sessionmesh.test', rootPath: '/SessionMesh', requestTimeoutMs: 500 }),
      { fetchImpl: server.fetchImpl },
    );

    await expect(client.ensureDir('events')).rejects.toMatchObject({ status: 0, retryable: true });

    // Come back online
    server.quirks.offline = false;
    await client.ensureDir('events');

    // Simulate 423 Locked on specific file
    server.quirks.lockedPaths = new Set(['/SessionMesh/events/locked.enc']);
    await expect(client.putBytes('events/locked.enc', new Uint8Array([1, 2]))).rejects.toMatchObject({
      status: 423,
      code: 'WEBDAV_LOCKED',
      retryable: true,
    });
    server.quirks.lockedPaths.clear();
    await expect(client.putBytes('events/locked.enc', new Uint8Array([1, 2]))).resolves.toMatchObject({ status: 201 });

    // Simulate 429 Too Many Requests
    server.quirks.rateLimitRemaining = 0;
    await expect(client.getBytes('events/locked.enc')).rejects.toMatchObject({
      status: 429,
      code: 'WEBDAV_RATE_LIMITED',
      retryable: true,
      retryAfterMs: 1000,
    });
    server.quirks.rateLimitRemaining = undefined;
    await expect(client.getBytes('events/locked.enc')).resolves.toMatchObject({ status: 200 });

    // Simulate timeout via artificialLatencyMs > requestTimeoutMs
    const fastTimeoutClient = new WebDAVClient(
      makeHttpsConfig({ url: 'https://dav.sessionmesh.test', rootPath: '/SessionMesh', requestTimeoutMs: 30 }),
      { fetchImpl: server.fetchImpl },
    );
    server.quirks.artificialLatencyMs = 150;
    await expect(fastTimeoutClient.getBytes('events/locked.enc')).rejects.toMatchObject({
      status: 0,
      code: 'WEBDAV_TIMEOUT',
      retryable: true,
    });
    server.quirks.artificialLatencyMs = 0;
  });

  it('W-015: detects bit-flip/corrupt ciphertext on storage and read path without silent acceptance', async () => {
    const server = new MockWebDAVServer();
    const client = new WebDAVClient(makeHttpsConfig({ url: 'https://dav.sessionmesh.test', rootPath: '/SessionMesh' }), {
      fetchImpl: server.fetchImpl,
    });
    await client.ensureDir('events/devA');

    const dek = await generateSpaceDekBase64();
    const aad = 'sp1|1|event_batch|/events/devA/1.enc';
    const goodEnv = await encryptWithDek({ hello: 'integrity' }, dek, 1, aad);
    await client.putBytes('events/devA/1.enc', goodEnv);

    // 1) Transient read corruption via corruptReadsForPaths
    server.quirks.corruptReadsForPaths = new Set(['/SessionMesh/events/devA/1.enc']);
    const corruptedRead = await client.getBytes('events/devA/1.enc');
    await expect(decryptWithDek(corruptedRead.bytes, dek, 'sp1|')).rejects.toThrow(/DECRYPT/i);

    // Clearing read quirk restores clean read
    server.quirks.corruptReadsForPaths.clear();
    const cleanRead = await client.getBytes('events/devA/1.enc');
    expect((await decryptWithDek(cleanRead.bytes, dek, 'sp1|')).data).toEqual({ hello: 'integrity' });

    // 2) Persistent disk corruption via server.corruptFile()
    server.corruptFile('/SessionMesh/events/devA/1.enc');
    const diskCorrupted = await client.getBytes('events/devA/1.enc');
    await expect(decryptWithDek(diskCorrupted.bytes, dek, 'sp1|')).rejects.toThrow(/DECRYPT/i);
  });

  it('W-016: trips non-retryable 507 Insufficient Storage circuit breaker when quota is exceeded', async () => {
    const server = new MockWebDAVServer({ storageQuotaBytes: 1024 });
    const client = new WebDAVClient(makeHttpsConfig({ url: 'https://dav.sessionmesh.test', rootPath: '/SessionMesh' }), {
      fetchImpl: server.fetchImpl,
    });
    await client.ensureDir('snapshots');

    await client.putBytes('snapshots/small.enc', generateRandomBytes(512));

    // Exceeding 1024-byte quota MUST return 507 with retryable: false!
    await expect(client.putBytes('snapshots/too-big.enc', generateRandomBytes(600))).rejects.toMatchObject({
      status: 507,
      code: 'WEBDAV_INSUFFICIENT_STORAGE',
      retryable: false,
    });

    // Deleting old file frees quota and restores uploads
    await client.delete('snapshots/small.enc');
    await expect(client.putBytes('snapshots/too-big.enc', generateRandomBytes(600))).resolves.toMatchObject({
      status: 201,
    });
  });

  it('W-017: handles multi-device concurrent immutable event writes across Devices A, B, and C with zero loss', async () => {
    const server = new MockWebDAVServer();
    const makeDeviceClient = () =>
      new WebDAVClient(makeHttpsConfig({ url: 'https://dav.sessionmesh.test', rootPath: '/SessionMesh' }), {
        fetchImpl: server.fetchImpl,
      });

    const dek = await generateSpaceDekBase64();
    const spaceId = 'shared-mesh-space';
    const opaqueSpace = await deriveOpaqueId(spaceId, 'sp');
    const devices = ['dev-A', 'dev-B', 'dev-C'] as const;

    // Initialize shared root + per-device isolated event directories
    const initClient = makeDeviceClient();
    for (const devId of devices) {
      await initClient.ensureDir(`v1/spaces/${opaqueSpace}/events/${devId}`);
    }

    // All 3 devices concurrently push 5 immutable encrypted batches each
    await Promise.all(
      devices.map(async (devId) => {
        const client = makeDeviceClient();
        for (let seq = 1; seq <= 5; seq += 1) {
          const batch: EventBatch = {
            batchId: `${devId}-b${seq}`,
            spaceId,
            deviceId: devId,
            deviceName: `Edge ${devId}`,
            fromSeq: seq,
            toSeq: seq,
            createdAt: 1730000000000 + seq * 1000,
            events: [],
          };
          const relPath = `v1/spaces/${opaqueSpace}/events/${devId}/${String(seq).padStart(6, '0')}_${batch.batchId}.enc`;
          const aad = `${spaceId}|1|event_batch|/${relPath}`;
          const encrypted = await encryptWithDek(batch, dek, 1, aad, { encoding: 'json', compress: true });
          const res = await client.putBytes(relPath, encrypted, { ifNoneMatchStar: true });
          expect(res.status).toBe(201);
        }
      }),
    );

    // Every device can list & decrypt all 15 immutable batches from all 3 devices
    const reader = makeDeviceClient();
    const recoveredBatchIds: string[] = [];
    for (const devId of devices) {
      const entries = await reader.propfind(`v1/spaces/${opaqueSpace}/events/${devId}`, 1);
      const files = entries.filter((e) => !e.isCollection);
      expect(files).toHaveLength(5);

      for (const f of files) {
        const dl = await reader.getBytes(f.path);
        const { data } = await decryptWithDek<EventBatch>(dl.bytes, dek, `${spaceId}|`);
        recoveredBatchIds.push(data.batchId);
      }
    }

    expect(recoveredBatchIds).toHaveLength(15);
    expect(new Set(recoveredBatchIds).size).toBe(15);
  });

  it('W-018: completes encrypted snapshot roundtrip over real HTTP MockWebDAVServer (with CORS headers & 19-step check)', async () => {
    const server = new MockWebDAVServer({
      requireAuth: { username: 'tester', password: 'secret' },
      xmlNamespaceStyle: 'nextcloud',
    });
    const httpServer = await server.startHttpServer(0);

    try {
      // Verify CORS preflight responds 204 with WebDAV methods allowed
      const preflightRes = await fetch(`${httpServer.url}/SessionMesh/`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'chrome-extension://abcdefghijklmnop',
          'Access-Control-Request-Method': 'PROPFIND',
        },
      });
      expect(preflightRes.status).toBe(204);
      expect(preflightRes.headers.get('access-control-allow-origin')).toBe('*');
      expect(preflightRes.headers.get('access-control-allow-methods')).toContain('PROPFIND');

      const config: WebDAVConfig = {
        url: httpServer.url,
        authType: 'basic',
        username: 'tester',
        password: 'secret',
        rootPath: '/SessionMesh',
        allowInsecureLocalhostForTesting: true,
        requestTimeoutMs: 10000,
      };

      // Run 19-step capability check over real TCP/HTTP localhost!
      const report = await new WebDAVCapabilityDetector(config).runFullCheck();
      expect(report.overallOk).toBe(true);
      expect(report.consistencyLevel).toBe('strong_cas');
      expect(report.checks[3].id).toBe('tls_certificate');
      expect(report.checks[3].state).toBe('unverified'); // Local HTTP test mode

      // Upload & restore a full encrypted SnapshotPayload over real HTTP (both JSON & Protobuf encodings)
      const client = new WebDAVClient(config);
      const dek = await generateSpaceDekBase64();
      const snapshot: SnapshotPayload = {
        snapshotId: 'snap-2026-001',
        spaceId: 'main-space',
        createdAt: 1730000123456,
        createdByDevice: 'dev-A',
        coveredVectorClock: { 'dev-A': 42, 'dev-B': 19 },
        cookies: {
          'cookie::trk1::0::::d:github.com::/::user_session': {
            logicalId: 'cookie::trk1::0::::d:github.com::/::user_session',
            siteKey: 'github.com',
            trackId: 'trk1',
            domain: '.github.com',
            path: '/',
            name: 'user_session',
            value: 'tok_real_http_roundtrip_value',
            storeScope: '0',
            partitionKey: { topLevelSite: 'https://github.com' },
            secure: true,
            httpOnly: true,
            sameSite: 'lax',
            session: false,
            expirationDate: 1893456000,
            hostOnly: false,
            version: {
              hlc: { physicalMs: 1730000123456, logical: 1, deviceId: 'dev-A' },
              vectorClock: { 'dev-A': 42 },
              deviceId: 'dev-A',
              deviceSeq: 42,
              versionId: 'v-42',
            },
            sourceDevice: 'dev-A',
            deleted: false,
            updatedAt: 1730000123456,
          },
        },
        localStorage: {
          'ls::trk1::https://github.com::theme': {
            logicalId: 'ls::trk1::https://github.com::theme',
            siteKey: 'github.com',
            trackId: 'trk1',
            origin: 'https://github.com',
            key: 'theme',
            value: 'dark',
            version: {
              hlc: { physicalMs: 1730000123457, logical: 0, deviceId: 'dev-A' },
              vectorClock: { 'dev-A': 43 },
              deviceId: 'dev-A',
              deviceSeq: 43,
              versionId: 'v-43',
            },
            sourceDevice: 'dev-A',
            deleted: false,
            updatedAt: 1730000123457,
          },
        },
        tombstones: {},
        tracks: {
          trk1: {
            trackId: 'trk1',
            siteKey: 'github.com',
            label: 'Work Account',
            originDeviceId: 'dev-A',
            originDeviceName: 'Edge A',
            cookieCount: 1,
            localStorageCount: 1,
            updatedAt: 1730000123457,
            memberDeviceIds: ['dev-A', 'dev-B'],
          },
        },
        rules: {
          spaceBlacklist: [],
          siteOverrides: {},
          ssoGroups: [],
          updatedAt: 1730000123457,
        },
      };

      await client.ensureDir('v1/spaces/sp_test/snapshots');

      for (const encoding of ['json', 'protobuf'] as const) {
        const path = `v1/spaces/sp_test/snapshots/${snapshot.snapshotId}_${encoding}.enc`;
        const aad = `main-space|1|snapshot|/${path}`;
        const encrypted = await encryptWithDek(snapshot, dek, 1, aad, { encoding, compress: true });
        const expectedSha = await sha256Hex(encrypted);

        const putRes = await client.putBytes(path, encrypted, { ifNoneMatchStar: true });
        expect(putRes.status).toBe(201);

        const dlRes = await client.getBytes(path);
        expect(await sha256Hex(dlRes.bytes)).toBe(expectedSha);

        const { data: restored, header } = await decryptWithDek<SnapshotPayload>(dlRes.bytes, dek, 'main-space|1|snapshot|');
        expect(restored).toEqual(snapshot);
        expect((header.flags & SMES_FLAG_PROTOBUF) !== 0).toBe(encoding === 'protobuf');
      }
    } finally {
      await httpServer.close();
    }
  });

  it('W-019 (Regression): passes all 19 capability checks against Nextcloud/Nginx servers blocking "/." dot-prefixed paths with 403', async () => {
    const strictNginxNextcloud = new MockWebDAVServer({
      forbidDotFiles: true,
      xmlNamespaceStyle: 'nextcloud',
      requireAuth: { username: 'user', password: 'app-password' },
    });
    const cfg = makeHttpsConfig({
      url: 'https://hubu.cloud/remote.php/dav/files/user/',
      authType: 'basic',
      username: 'user',
      password: 'app-password',
      rootPath: '/SessionMesh',
    });

    const report = await new WebDAVCapabilityDetector(cfg, {
      fetchImpl: strictNginxNextcloud.fetchImpl,
    }).runFullCheck();

    expect(report.overallOk).toBe(true);
    expect(report.consistencyLevel).toBe('strong_cas');
    expect(report.checks.every((c) => c.state === 'supported')).toBe(true);
  });

  it('W-020 (Regression): auto-switches to Base64 .txt mode when server silently drops .enc uploads', async () => {
    const extFilteredServer = new MockWebDAVServer({
      silentPutDropExtensions: ['.enc'],
    });
    const cfg = makeHttpsConfig({ url: 'https://dav.sessionmesh.test', rootPath: '/SessionMesh' });
    const report = await new WebDAVCapabilityDetector(cfg, {
      fetchImpl: extFilteredServer.fetchImpl,
    }).runFullCheck();

    expect(report.overallOk).toBe(true);
    expect(report.recommendedStorageFormat).toBe('base64_txt');
    expect(report.checks[15].state).toBe('supported'); // 512B full binary spectrum SHA-256 roundtrip via Base64 .txt!
    expect(report.checks[16].state).toBe('supported'); // 64KB binary roundtrip via Base64 .txt!
  });

  it('W-021 (Regression): detects broken YetiShare/hubu.cloud servers that return fake HTTP 201 while dropping all PUT files', async () => {
    const brokenPutServer = new MockWebDAVServer({
      silentPutDropExtensions: '*',
    });
    const cfg = makeHttpsConfig({ url: 'https://hubu.cloud/webdav', rootPath: '/SessionMesh' });
    const report = await new WebDAVCapabilityDetector(cfg, {
      fetchImpl: brokenPutServer.fetchImpl,
    }).runFullCheck();

    expect(report.overallOk).toBe(false);
    expect(report.consistencyLevel).toBe('incompatible');
    expect(report.summaryMessage).toContain('假上传成功');
    expect(report.checks[18].state).toBe('supported'); // Probe directory still cleaned up!
  });

  it('W-022 (Universal Compatibility): handles reverse-proxy href prefixes, blocked OPTIONS (403), 501 conditional-header rejection, and dummy ETag="1"', async () => {
    // 1. Reverse-proxy prefix tolerance in XML parser (/backend/dav/SessionMesh/sub.enc -> /sub.enc)
    const proxiedXml = `<?xml version="1.0" encoding="utf-8"?>
      <d:multistatus xmlns:d="DAV:">
        <d:response>
          <d:href>/remote.php/dav/files/alice/SessionMesh/</d:href>
          <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
        </d:response>
        <d:response>
          <d:href>/remote.php/dav/files/alice/SessionMesh/devices/</d:href>
          <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
        </d:response>
      </d:multistatus>`;
    const parsedProxied = parseWebDAVMultistatusXml(proxiedXml, '/SessionMesh');
    expect(parsedProxied[0].path).toBe('/');
    expect(parsedProxied[1].path).toBe('/devices');

    // 2. Custom gateway wrapper around MockWebDAVServer simulating:
    //    - Cloudflare WAF returning 403 on OPTIONS
    //    - Alist/IIS returning 501 Not Implemented whenever If-Match or If-None-Match header is sent
    //    - Constant dummy ETag: "1" on every response
    //    - Blocking .enc extension (forcing Base64 .txt mode)
    const baseServer = new MockWebDAVServer({
      forbidDotFiles: true,
      silentPutDropExtensions: ['.enc'],
      ignoreConditionalHeaders: true,
    });
    const quirkyFetch: typeof fetch = async (input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'OPTIONS') {
        return new Response('WAF blocked OPTIONS', { status: 403 });
      }
      const hdrs = new Headers(init?.headers);
      if (hdrs.has('if-match') || hdrs.has('if-none-match')) {
        return new Response('Conditional headers not implemented', { status: 501 });
      }
      const res = await baseServer.fetchImpl(input, init);
      const patchedHeaders = new Headers(res.headers);
      if (patchedHeaders.has('etag')) {
        patchedHeaders.set('etag', '1');
      }
      return new Response(res.body, { status: res.status, headers: patchedHeaders });
    };

    const cfg = makeHttpsConfig({ url: 'https://quirky-cloud-gateway.test/dav', rootPath: '/SessionMesh' });
    const report = await new WebDAVCapabilityDetector(cfg, { fetchImpl: quirkyFetch }).runFullCheck();
    expect(report.overallOk).toBe(true);
    expect(report.consistencyLevel).toBe('append_only_degraded');
    expect(report.recommendedStorageFormat).toBe('base64_txt');
  });
});
