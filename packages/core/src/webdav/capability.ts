/**
 * 19-Step WebDAV Server Capability & Consistency Detector.
 * Explicitly distinguishes strong_cas vs append_only_degraded vs incompatible —
 * NEVER falsely claims strong CAS when conditional headers are ignored or unsupported.
 */
import type { CapabilityCheckResult, CapabilityReport, ConsistencyLevel, WebDAVConfig } from '../types';
import { bytesToHex, generateRandomBytes, sha256Hex } from '../crypto';
import { WebDAVClient, type WebDAVClientOptions } from './client';
import { WebDAVHttpError } from './errors';

interface StepSpec {
  step: number;
  id: string;
  name: string;
}

const ALL_19_STEPS: StepSpec[] = [
  { step: 1, id: 'url_format', name: 'URL Format Validation' },
  { step: 2, id: 'https_enforced', name: 'HTTPS Enforcement' },
  { step: 3, id: 'reachability', name: 'Server Reachability (OPTIONS)' },
  { step: 4, id: 'tls_certificate', name: 'TLS Transport Security' },
  { step: 5, id: 'authentication', name: 'Authentication Verification' },
  { step: 6, id: 'root_access', name: 'Root Directory Access' },
  { step: 7, id: 'propfind', name: 'PROPFIND & XML Multistatus Parsing' },
  { step: 8, id: 'file_read', name: 'Resource Read Access' },
  { step: 9, id: 'mkcol_probe_dir', name: 'MKCOL Probe Directory Creation' },
  { step: 10, id: 'temp_put', name: 'Temporary File PUT' },
  { step: 11, id: 'temp_get', name: 'Temporary File GET' },
  { step: 12, id: 'temp_delete', name: 'Temporary File DELETE' },
  { step: 13, id: 'etag_presence', name: 'ETag Header / Property Support' },
  { step: 14, id: 'conditional_create', name: 'Conditional Create (If-None-Match: *)' },
  { step: 15, id: 'conditional_update', name: 'Conditional Update (If-Match CAS)' },
  { step: 16, id: 'sha256_consistency', name: 'Binary Read/Write SHA-256 Consistency' },
  { step: 17, id: 'payload_size_64kb', name: '64KB Binary Payload Support' },
  { step: 18, id: 'latency_measurement', name: 'Round-Trip Latency Measurement' },
  { step: 19, id: 'probe_cleanup', name: 'Temporary Probe Cleanup' },
];

function nowMs(): number {
  return Date.now();
}

function describeError(err: unknown): string {
  if (err instanceof WebDAVHttpError) {
    return `${err.code} (HTTP ${err.status}): ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export class WebDAVCapabilityDetector {
  private readonly config: WebDAVConfig;
  private readonly client: WebDAVClient;

  constructor(config: WebDAVConfig, options?: WebDAVClientOptions) {
    this.config = { ...config };
    this.client = new WebDAVClient(config, options);
  }

  async runFullCheck(): Promise<CapabilityReport> {
    const startedAt = nowMs();
    const checks: CapabilityCheckResult[] = ALL_19_STEPS.map((s) => ({
      id: s.id,
      step: s.step,
      name: s.name,
      state: 'unverified',
    }));

    const setCheck = (
      stepNum: number,
      state: CapabilityCheckResult['state'],
      detail?: string,
      latencyMs?: number,
    ) => {
      const item = checks[stepNum - 1];
      item.state = state;
      if (detail !== undefined) item.detail = detail;
      if (latencyMs !== undefined) item.latencyMs = latencyMs;
    };

    let recommendedStorageFormat: 'binary_enc' | 'base64_txt' =
      this.config.storageFormat === 'base64_txt' ? 'base64_txt' : 'binary_enc';

    const finalize = (
      consistencyLevel: ConsistencyLevel,
      overallOk: boolean,
      summaryMessage: string,
      quotaUsedBytes?: number,
      quotaAvailableBytes?: number,
    ): CapabilityReport => {
      const totalLatencyMs = Math.max(0, nowMs() - startedAt);
      return {
        testedAt: startedAt,
        url: this.config.url,
        overallOk,
        consistencyLevel,
        checks,
        totalLatencyMs,
        quotaUsedBytes,
        quotaAvailableBytes,
        recommendedStorageFormat,
        summaryMessage,
      };
    };

    // Step 1: URL Format Validation
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(this.config.url);
      setCheck(1, 'supported', `Valid URL (${parsedUrl.origin})`);
    } catch {
      setCheck(1, 'unsupported', `Malformed URL: "${this.config.url}"`);
      return finalize('incompatible', false, 'Invalid WebDAV URL format.');
    }

    // Step 2: HTTPS Enforcement
    const isHttps = parsedUrl.protocol === 'https:';
    try {
      this.client.validateUrl();
      if (isHttps) {
        setCheck(2, 'supported', 'HTTPS protocol enforced');
      } else {
        setCheck(2, 'supported', 'Localhost HTTP explicitly allowed for testing');
      }
    } catch (err) {
      setCheck(2, 'unsupported', describeError(err));
      return finalize('incompatible', false, 'HTTPS is required for WebDAV connections.');
    }

    // Step 3: Reachability (OPTIONS) + Step 4: TLS + Step 5: Authentication
    const tOptions = nowMs();
    let optionsStatus = 0;
    try {
      const opt = await this.client.options('');
      optionsStatus = opt.status;
      const optLatency = Math.max(0, nowMs() - tOptions);
      setCheck(
        3,
        'supported',
        `HTTP ${opt.status}${opt.dav.length ? ` (DAV: ${opt.dav.join(', ')})` : ''}`,
        optLatency,
      );
      if (isHttps) {
        setCheck(4, 'supported', 'TLS handshake succeeded over HTTPS');
      } else {
        setCheck(4, 'unverified', 'Skipped TLS verification for local HTTP test endpoint');
      }
      setCheck(5, 'supported', `Authenticated (${this.config.authType})`);
    } catch (err) {
      const optLatency = Math.max(0, nowMs() - tOptions);
      if (err instanceof WebDAVHttpError && err.status === 401) {
        setCheck(3, 'supported', 'Server reachable (returned HTTP 401)', optLatency);
        setCheck(4, isHttps ? 'supported' : 'unverified', isHttps ? 'TLS connection established' : 'Local HTTP test mode');
        setCheck(5, 'unsupported', describeError(err), optLatency);
        return finalize('incompatible', false, 'WebDAV authentication failed (401 Unauthorized).');
      }
      if (
        err instanceof WebDAVHttpError &&
        (err.status === 403 || err.status === 404 || err.status === 405 || err.status === 501)
      ) {
        // Cloudflare WAF, IIS, Box, Synology reverse proxy, or Nutstore often block/405 OPTIONS
        // while allowing full PROPFIND/MKCOL/PUT/GET; continue to Step 6/7 verification!
        setCheck(
          3,
          'unverified',
          `OPTIONS returned HTTP ${err.status}; falling back to PROPFIND reachability check`,
          optLatency,
        );
        setCheck(4, isHttps ? 'supported' : 'unverified', isHttps ? 'TLS connection established' : 'Local HTTP test mode');
      } else {
        setCheck(3, 'unsupported', describeError(err), optLatency);
        setCheck(4, 'unsupported', isHttps ? 'Could not establish TLS connection' : 'Server unreachable');
        return finalize('incompatible', false, `WebDAV server unreachable: ${describeError(err)}`);
      }
    }

    // Step 6: Root Access (ensure root directory exists & accessible)
    let quotaUsedBytes: number | undefined;
    let quotaAvailableBytes: number | undefined;
    const tRoot = nowMs();
    try {
      await this.client.ensureDir('');
      setCheck(6, 'supported', `Root path "${this.config.rootPath || '/'}" accessible`, Math.max(0, nowMs() - tRoot));
      if (optionsStatus === 0) {
        setCheck(5, 'supported', `Authenticated (${this.config.authType})`);
      }
    } catch (err) {
      const lat = Math.max(0, nowMs() - tRoot);
      if (err instanceof WebDAVHttpError && err.status === 401) {
        setCheck(5, 'unsupported', describeError(err), lat);
        return finalize('incompatible', false, 'WebDAV authentication failed (401 Unauthorized).');
      }
      // If rootPath creation failed with 403 (e.g. Nutstore /dav/ forbids creating top-level sync folders via WebDAV),
      // probe mount root `/` to discover existing writable folders (such as `/我的坚果云`) and guide the user!
      if (err instanceof WebDAVHttpError && err.status === 403 && this.config.rootPath && this.config.rootPath !== '/') {
        try {
          const mountClient = new WebDAVClient({ ...this.config, rootPath: '/' }, { fetchImpl: (this.client as unknown as { customFetch?: typeof fetch }).customFetch });
          const topItems = await mountClient.propfind('', 1);
          const subDirs = topItems.filter((i) => i.isCollection && i.path !== '/' && i.name).map((i) => `/${i.name}`);
          if (subDirs.length > 0) {
            const hint = `该服务器禁止在顶层直接新建目录 "${this.config.rootPath}" (HTTP 403，如坚果云需在已有同步夹内读写)。检测到可用目录：[${subDirs.join(', ')}]，建议将「远端根目录」改为 "${subDirs[0]}/SessionMesh"。`;
            setCheck(6, 'unsupported', `${describeError(err)} | ${hint}`, lat);
            return finalize('incompatible', false, hint);
          }
        } catch {
          // ignore mount discovery error
        }
      }
      setCheck(6, 'unsupported', describeError(err), lat);
      return finalize('incompatible', false, `Root directory access failed: ${describeError(err)}`);
    }

    // Step 7: PROPFIND Depth 1 & XML Parsing
    const tProp = nowMs();
    try {
      const entries = await this.client.propfind('', 1);
      const rootEntry = entries.find((e) => e.path === '/') ?? entries[0];
      if (rootEntry) {
        quotaUsedBytes = rootEntry.quotaUsedBytes;
        quotaAvailableBytes = rootEntry.quotaAvailableBytes;
      }
      setCheck(7, 'supported', `Parsed ${entries.length} multistatus resource(s)`, Math.max(0, nowMs() - tProp));
    } catch (err) {
      const lat = Math.max(0, nowMs() - tProp);
      if (err instanceof WebDAVHttpError && err.status === 401) {
        setCheck(5, 'unsupported', describeError(err), lat);
      }
      setCheck(7, 'unsupported', describeError(err), lat);
      return finalize('incompatible', false, `PROPFIND failed: ${describeError(err)}`, quotaUsedBytes, quotaAvailableBytes);
    }

    // Steps 8-19 use an isolated temporary probe directory without a leading dot "."
    // (Nginx `location ~ /\. { deny all; }` and Nextcloud/WAF rules reject "/.xxx" with HTTP 403!)
    const probeToken = bytesToHex(generateRandomBytes(6));
    const probeDir = `sm_probe_${probeToken}`;
    const tempFile = `${probeDir}/basic.enc`;
    const casCreateFile = `${probeDir}/cas_create.enc`;
    const casUpdateFile = `${probeDir}/cas_update.enc`;
    const shaFile = `${probeDir}/sha_check.enc`;
    const size64File = `${probeDir}/size_64k.enc`;
    const createdFiles: string[] = [];
    let probeDirCreated = false;
    let basicCrudOk = true;
    let abortSummary: string | undefined;

    try {
      // Step 9: MKCOL probe directory
      const tMkcol = nowMs();
      try {
        await this.client.mkcol(probeDir);
        probeDirCreated = true;
        setCheck(9, 'supported', `Created probe directory ${probeDir}`, Math.max(0, nowMs() - tMkcol));
      } catch (err) {
        basicCrudOk = false;
        setCheck(9, 'unsupported', describeError(err), Math.max(0, nowMs() - tMkcol));
        // Still attempt read check (step 8) on root stat before exiting
        try {
          await this.client.stat('');
          setCheck(8, 'supported', 'Root metadata readable (write/MKCOL blocked)');
        } catch (readErr) {
          setCheck(8, 'unsupported', describeError(readErr));
        }
        abortSummary = `Server rejected directory creation (MKCOL): ${describeError(err)}`;
      }

      if (!abortSummary) {
        // Step 10: Temp PUT + Step 11: Temp GET (with automatic Base64 .txt fallback when .enc is filtered/dropped!)
        const probePayload = new TextEncoder().encode(`sessionmesh-probe:${probeToken}`);
        let tempPutEtag: string | undefined;
        let tempGetEtag: string | undefined;
        let putSucceeded = false;
        let getSucceeded = false;
        const tPut = nowMs();

        try {
          const putRes = await this.client.putBytes(tempFile, probePayload);
          createdFiles.push(tempFile);
          tempPutEtag = putRes.etag;
          putSucceeded = true;
          setCheck(10, 'supported', `HTTP ${putRes.status}`, Math.max(0, nowMs() - tPut));
        } catch (err) {
          // If .enc PUT was rejected with 403/415/400, try base64_txt immediately before giving up!
          if (
            recommendedStorageFormat === 'binary_enc' &&
            err instanceof WebDAVHttpError &&
            (err.status === 403 || err.status === 415 || err.status === 400)
          ) {
            this.client.setStorageFormat('base64_txt');
            try {
              const txtPutRes = await this.client.putBytes(tempFile, probePayload);
              recommendedStorageFormat = 'base64_txt';
              createdFiles.push(tempFile);
              tempPutEtag = txtPutRes.etag;
              putSucceeded = true;
              setCheck(
                10,
                'supported',
                `HTTP ${txtPutRes.status} (auto-switched to Base64 .txt mode; .enc blocked with ${err.status})`,
                Math.max(0, nowMs() - tPut),
              );
            } catch {
              this.client.setStorageFormat('binary_enc');
              basicCrudOk = false;
              setCheck(10, 'unsupported', describeError(err), Math.max(0, nowMs() - tPut));
              setCheck(8, 'unverified', 'Skipped due to PUT failure');
              abortSummary = `Temporary file upload (PUT) failed: ${describeError(err)}`;
            }
          } else {
            basicCrudOk = false;
            setCheck(10, 'unsupported', describeError(err), Math.max(0, nowMs() - tPut));
            setCheck(8, 'unverified', 'Skipped due to PUT failure');
            abortSummary = `Temporary file upload (PUT) failed: ${describeError(err)}`;
          }
        }

        if (!abortSummary && putSucceeded) {
          const tGet = nowMs();
          try {
            const getRes = await this.client.getBytes(tempFile);
            tempGetEtag = getRes.etag;
            const readLatency = Math.max(0, nowMs() - tGet);
            if (getRes.bytes.byteLength === probePayload.byteLength) {
              getSucceeded = true;
              setCheck(8, 'supported', `Verified file GET (${getRes.bytes.byteLength} bytes)`, readLatency);
              setCheck(11, 'supported', `HTTP ${getRes.status} (${getRes.bytes.byteLength} bytes)`, readLatency);
            } else {
              basicCrudOk = false;
              setCheck(8, 'unsupported', 'Downloaded length mismatch', readLatency);
              setCheck(
                11,
                'unsupported',
                `Expected ${probePayload.byteLength} bytes, got ${getRes.bytes.byteLength}`,
                readLatency,
              );
            }
          } catch (err) {
            const readLatency = Math.max(0, nowMs() - tGet);
            // If PUT returned 2xx on .enc yet GET returned 404 (e.g. YetiShare / hubu.cloud silent extension drop!),
            // inspect PROPFIND on probeDir AND automatically test Base64 .txt mode!
            if (
              recommendedStorageFormat === 'binary_enc' &&
              err instanceof WebDAVHttpError &&
              err.status === 404
            ) {
              let dirChildrenNames: string[] = [];
              try {
                const dirEntries = await this.client.propfind(probeDir, 1);
                dirChildrenNames = dirEntries
                  .filter((e) => !e.isCollection && e.name)
                  .map((e) => `${e.name}(${e.size}B)`);
              } catch {
                // ignore diagnostic propfind error
              }

              // Switch to Base64 .txt mode and test PUT + GET!
              this.client.setStorageFormat('base64_txt');
              const tTxt = nowMs();
              try {
                const txtPut = await this.client.putBytes(tempFile, probePayload);
                const txtGet = await this.client.getBytes(tempFile);
                const txtLat = Math.max(0, nowMs() - tTxt);
                if (txtGet.bytes.byteLength === probePayload.byteLength) {
                  recommendedStorageFormat = 'base64_txt';
                  tempPutEtag = txtPut.etag;
                  tempGetEtag = txtGet.etag;
                  getSucceeded = true;
                  setCheck(
                    10,
                    'supported',
                    `HTTP ${txtPut.status} (已自动切换为 Base64 .txt 兼容封装；服务端丢弃了 .enc 上传)`,
                    txtLat,
                  );
                  setCheck(
                    8,
                    'supported',
                    `Verified file GET via Base64 .txt mode (${txtGet.bytes.byteLength} bytes)`,
                    txtLat,
                  );
                  setCheck(
                    11,
                    'supported',
                    `HTTP ${txtGet.status} (${txtGet.bytes.byteLength} bytes, Base64 .txt mode)`,
                    txtLat,
                  );
                } else {
                  this.client.setStorageFormat('binary_enc');
                }
              } catch (txtErr) {
                // Both .enc AND .txt failed GET after PUT returned 201! Inspect probeDir again for conclusive report.
                let txtDirChildren: string[] = [];
                try {
                  const dirEntries2 = await this.client.propfind(probeDir, 1);
                  txtDirChildren = dirEntries2
                    .filter((e) => !e.isCollection && e.name)
                    .map((e) => `${e.name}(${e.size}B)`);
                } catch {
                  // ignore
                }
                this.client.setStorageFormat('binary_enc');
                basicCrudOk = false;
                const diagListing =
                  dirChildrenNames.length > 0 || txtDirChildren.length > 0
                    ? `PROPFIND 目录内可见项: [${[...dirChildrenNames, ...txtDirChildren].join(', ')}]`
                    : 'PROPFIND 检测目录内文件数为 0（服务端未实际落盘任何文件）';
                const detailMsg = `${describeError(err)} | 已自动尝试 .txt 兼容上传同样返回 ${describeError(txtErr)} | ${diagListing}`;
                setCheck(8, 'unsupported', detailMsg, readLatency);
                setCheck(11, 'unsupported', detailMsg, readLatency);
                abortSummary =
                  `检测到该 WebDAV 服务端存在「假上传成功 (Silent PUT Drop)」故障：服务器对 .enc 与 .txt 文件 PUT 均返回成功状态码，但实际未保存文件（立即重读返回 HTTP 404，且 ${diagListing}）。` +
                  `该问题通常由免费网盘（如 YetiShare 架构服务端）后端存储节点异常引起，请用通用客户端验证该网盘能否正常上传并下载小文件，或更换为坚果云 / Nextcloud / Alist / NAS WebDAV。`;
              }
            }

            if (!getSucceeded && !abortSummary) {
              basicCrudOk = false;
              setCheck(8, 'unsupported', describeError(err), readLatency);
              setCheck(11, 'unsupported', describeError(err), readLatency);
            }
          }

          if (!abortSummary) {
            // Step 13 (collected before deleting tempFile): ETag presence check via PUT / GET / PROPFIND
          let detectedEtag = tempPutEtag ?? tempGetEtag;
          if (!detectedEtag) {
            try {
              const st = await this.client.stat(tempFile);
              detectedEtag = st?.etag;
            } catch {
              // ignore
            }
          }
          if (detectedEtag) {
            setCheck(13, 'supported', `ETag returned (${detectedEtag})`);
          } else {
            setCheck(13, 'unsupported', 'Server did not return ETag in PUT, GET, or PROPFIND');
          }

          // Step 12: Temp DELETE
          const tDel = nowMs();
          try {
            await this.client.delete(tempFile);
            const idx = createdFiles.indexOf(tempFile);
            if (idx !== -1) createdFiles.splice(idx, 1);
            setCheck(12, 'supported', 'Temporary file deleted', Math.max(0, nowMs() - tDel));
          } catch (err) {
            basicCrudOk = false;
            setCheck(12, 'unsupported', describeError(err), Math.max(0, nowMs() - tDel));
          }

          // Step 14: Conditional Create (If-None-Match: *) — MUST create first (201/200/204) AND reject duplicate with 412!
          const tCondCreate = nowMs();
          try {
            const firstCreate = await this.client.putBytes(casCreateFile, new TextEncoder().encode('v1'), {
              ifNoneMatchStar: true,
            });
            createdFiles.push(casCreateFile);

            let rejectedDuplicate412 = false;
            let duplicateDetail = '';
            try {
              await this.client.putBytes(casCreateFile, new TextEncoder().encode('v2-should-fail'), {
                ifNoneMatchStar: true,
              });
              duplicateDetail = 'Server ignored If-None-Match: * and overwrote existing file';
            } catch (dupErr) {
              if (dupErr instanceof WebDAVHttpError && dupErr.status === 412) {
                rejectedDuplicate412 = true;
              } else {
                duplicateDetail = `Duplicate create returned unexpected error: ${describeError(dupErr)}`;
              }
            }

            const lat = Math.max(0, nowMs() - tCondCreate);
            if (rejectedDuplicate412) {
              setCheck(14, 'supported', `Initial HTTP ${firstCreate.status}, duplicate rejected with 412`, lat);
            } else {
              setCheck(14, 'unsupported', duplicateDetail, lat);
            }
          } catch (err) {
            setCheck(14, 'unsupported', describeError(err), Math.max(0, nowMs() - tCondCreate));
          }

          // Step 15: Conditional Update (If-Match) — MUST allow valid ETag AND reject stale ETag with 412!
          const tCondUpdate = nowMs();
          try {
            const initPut = await this.client.putBytes(casUpdateFile, new TextEncoder().encode('cas-v1'));
            createdFiles.push(casUpdateFile);
            let etagV1 = initPut.etag;
            if (!etagV1) {
              const st = await this.client.stat(casUpdateFile);
              etagV1 = st?.etag;
            }
            if (!etagV1) {
              setCheck(
                15,
                'unsupported',
                'Cannot verify If-Match because server did not supply an ETag',
                Math.max(0, nowMs() - tCondUpdate),
              );
            } else {
              const updateRes = await this.client.putBytes(casUpdateFile, new TextEncoder().encode('cas-v2'), {
                ifMatch: etagV1,
              });
              let etagV2 = updateRes.etag;
              if (!etagV2) {
                const st2 = await this.client.stat(casUpdateFile);
                etagV2 = st2?.etag;
              }

              let rejectedStale412 = false;
              let staleDetail = '';
              try {
                await this.client.putBytes(casUpdateFile, new TextEncoder().encode('cas-v3-stale'), {
                  ifMatch: etagV1,
                });
                staleDetail = 'Server accepted stale ETag in If-Match instead of returning 412';
              } catch (staleErr) {
                if (staleErr instanceof WebDAVHttpError && staleErr.status === 412) {
                  rejectedStale412 = true;
                } else {
                  staleDetail = `Stale If-Match returned unexpected error: ${describeError(staleErr)}`;
                }
              }

              const lat = Math.max(0, nowMs() - tCondUpdate);
              if (rejectedStale412) {
                setCheck(
                  15,
                  'supported',
                  `Valid If-Match succeeded${etagV2 && etagV2 !== etagV1 ? ' with rotated ETag' : ''}; stale ETag rejected with 412`,
                  lat,
                );
              } else {
                setCheck(15, 'unsupported', staleDetail, lat);
              }
            }
          } catch (err) {
            setCheck(15, 'unsupported', describeError(err), Math.max(0, nowMs() - tCondUpdate));
          }

          // Step 16: SHA-256 Binary Read/Write Consistency (full byte spectrum 0x00..0xFF + random)
          const tSha = nowMs();
          try {
            const binarySample = new Uint8Array(512);
            for (let i = 0; i < 256; i += 1) binarySample[i] = i;
            binarySample.set(generateRandomBytes(256), 256);
            const expectedHash = await sha256Hex(binarySample);

            await this.client.putBytes(shaFile, binarySample);
            createdFiles.push(shaFile);
            const readBack = await this.client.getBytes(shaFile);
            const actualHash = await sha256Hex(readBack.bytes);
            const lat = Math.max(0, nowMs() - tSha);

            if (actualHash === expectedHash) {
              setCheck(16, 'supported', `SHA-256 verified (${expectedHash.slice(0, 12)}...)`, lat);
            } else {
              basicCrudOk = false;
              setCheck(
                16,
                'unsupported',
                `Binary corruption detected: expected ${expectedHash.slice(0, 12)}, got ${actualHash.slice(0, 12)}`,
                lat,
              );
            }
          } catch (err) {
            basicCrudOk = false;
            setCheck(16, 'unsupported', describeError(err), Math.max(0, nowMs() - tSha));
          }

          // Step 17: 64KB Payload Size Test
          const t64k = nowMs();
          try {
            const payload64k = generateRandomBytes(64 * 1024);
            const hash64k = await sha256Hex(payload64k);
            await this.client.putBytes(size64File, payload64k);
            createdFiles.push(size64File);
            const read64k = await this.client.getBytes(size64File);
            const readHash64k = await sha256Hex(read64k.bytes);
            const lat = Math.max(0, nowMs() - t64k);

            if (read64k.bytes.byteLength === payload64k.byteLength && readHash64k === hash64k) {
              setCheck(17, 'supported', '64KB binary round-trip SHA-256 verified', lat);
            } else {
              basicCrudOk = false;
              setCheck(17, 'unsupported', `64KB payload mismatch (received ${read64k.bytes.byteLength} bytes)`, lat);
            }
          } catch (err) {
            basicCrudOk = false;
            setCheck(17, 'unsupported', describeError(err), Math.max(0, nowMs() - t64k));
          }

          // Step 18: Latency Measurement
          const tPing = nowMs();
          try {
            await this.client.stat(probeDir);
            const pingLatency = Math.max(0, nowMs() - tPing);
            setCheck(18, 'supported', `Measured RTT: ${pingLatency}ms`, pingLatency);
          } catch (err) {
            setCheck(18, 'unsupported', describeError(err), Math.max(0, nowMs() - tPing));
          }
          }
        }
      }
    } finally {
      // Step 19: Probe Cleanup (always delete temp files and probe directory)
      const tClean = nowMs();
      if (probeDirCreated) {
        const cleanupErrors: string[] = [];
        for (const f of createdFiles) {
          try {
            await this.client.delete(f);
          } catch (err) {
            if (!(err instanceof WebDAVHttpError && err.status === 404)) {
              cleanupErrors.push(`${f}: ${describeError(err)}`);
            }
          }
        }
        try {
          await this.client.delete(probeDir, { isCollection: true });
        } catch (err) {
          if (!(err instanceof WebDAVHttpError && err.status === 404)) {
            cleanupErrors.push(`${probeDir}: ${describeError(err)}`);
          }
        }
        const lat = Math.max(0, nowMs() - tClean);
        if (cleanupErrors.length === 0) {
          setCheck(19, 'supported', `Cleaned up probe directory ${probeDir}`, lat);
        } else {
          setCheck(19, 'unsupported', `Cleanup incomplete: ${cleanupErrors.join('; ')}`, lat);
        }
      } else {
        setCheck(19, 'unverified', 'No probe directory created');
      }
    }

    if (abortSummary || !basicCrudOk) {
      return finalize(
        'incompatible',
        false,
        abortSummary ?? 'WebDAV server failed core read/write or binary integrity checks.',
        quotaUsedBytes,
        quotaAvailableBytes,
      );
    }

    const etagOk = checks[12].state === 'supported';
    const condCreateOk = checks[13].state === 'supported';
    const condUpdateOk = checks[14].state === 'supported';

    if (etagOk && condCreateOk && condUpdateOk) {
      return finalize(
        'strong_cas',
        true,
        'WebDAV server passed all 19 capability checks with full strong CAS concurrency protection.',
        quotaUsedBytes,
        quotaAvailableBytes,
      );
    }

    return finalize(
      'append_only_degraded',
      true,
      'WebDAV server supports basic encrypted CRUD, but lacks full ETag / conditional write (If-Match / If-None-Match) protection. Operating in append-only degraded consistency mode.',
      quotaUsedBytes,
      quotaAvailableBytes,
    );
  }
}
