/**
 * Local Directory RemoteStorageAdapter backed by Chromium File System Access API
 * (or VirtualDirectoryHandle in-memory mocks for Node Vitest).
 */
import type {
  CapabilityReport,
  LocalDirectoryStorageConfig,
  RemoteObjectStat,
  RemoteStorageAdapter,
} from '../types';
import { bytesToHex } from '../crypto/encoding';
import { generateRandomBytes, sha256Hex } from '../crypto/smes';
import { createHttpStatusError, WebDAVHttpError } from '../webdav/errors';
import { normalizeEtag } from '../webdav/xml';
import {
  buildCapabilityReport,
  createCapabilityChecksTemplate,
  describeAdapterError,
  splitCleanStorageSegments,
  type DirectoryHandleResolver,
  type StorageAdapterOptions,
  type VirtualDirectoryHandle,
} from './types';

function isPermissionDomError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name;
  return name === 'NotAllowedError' || name === 'SecurityError';
}

function isNotFoundDomError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { name?: string }).name === 'NotFoundError';
}

function isTypeMismatchDomError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { name?: string }).name === 'TypeMismatchError';
}

function isQuotaDomError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { name?: string }).name === 'QuotaExceededError';
}

function makePermissionError(phase: string): WebDAVHttpError {
  return new WebDAVHttpError({
    status: 403,
    code: 'ERR_LOCAL_DIR_PERMISSION',
    phase,
    message: '本地同步文件夹需要重新授予读写权限',
    retryable: false,
    suggestion: '请在界面中点击「重新授权本地文件夹」以授予读写权限。',
  });
}

function makeMissingHandleError(handleKey: string): WebDAVHttpError {
  return new WebDAVHttpError({
    status: 404,
    code: 'ERR_LOCAL_DIR_MISSING',
    phase: 'resolve_handle',
    message: `未找到本地同步文件夹句柄 (${handleKey})，请重新选择目录`,
    retryable: false,
    suggestion: '请在存储设置中重新选择本地同步文件夹。',
  });
}

const LOCAL_DIR_CAPABILITY_STEPS = [
  { step: 1, id: 'config_format', name: 'Local Directory Handle Config Validation' },
  { step: 2, id: 'handle_permission', name: 'Directory Handle & Read/Write Permission' },
  { step: 3, id: 'temp_mkdir', name: 'Subdirectory Traversal & Creation' },
  { step: 4, id: 'temp_put', name: 'Temporary File Write' },
  { step: 5, id: 'temp_get', name: 'Temporary File Read' },
  { step: 6, id: 'conditional_create', name: 'Conditional Create (If-None-Match: *)' },
  { step: 7, id: 'conditional_update', name: 'Conditional Update (If-Match CAS)' },
  { step: 8, id: 'sha256_consistency', name: 'Binary Read/Write SHA-256 Consistency' },
  { step: 9, id: 'payload_size_64kb', name: '64KB Binary Payload Support' },
  { step: 10, id: 'probe_cleanup', name: 'Temporary Probe Cleanup' },
];

export class LocalDirectoryStorageAdapter implements RemoteStorageAdapter {
  readonly provider = 'local_directory' as const;
  readonly displayEndpoint: string;

  private readonly config: LocalDirectoryStorageConfig;
  private readonly resolveDirectoryHandle?: DirectoryHandleResolver;

  constructor(config: LocalDirectoryStorageConfig, options?: StorageAdapterOptions) {
    this.config = { ...config };
    this.resolveDirectoryHandle = options?.resolveDirectoryHandle;
    const label = this.config.directoryLabel || this.config.handleKey || 'local';
    const prefix = splitCleanStorageSegments(this.config.rootPrefix || '', 'Local Directory').join('/');
    this.displayEndpoint = prefix ? `local://${label}/${prefix}` : `local://${label}`;
  }

  validateConfig(): void {
    if (!this.config.handleKey || !this.config.handleKey.trim()) {
      throw new WebDAVHttpError({
        status: 0,
        code: 'ERR_LOCAL_DIR_MISSING',
        phase: 'validate_config',
        message: 'Local directory handleKey is required',
        retryable: false,
        suggestion: 'Select a local directory for synchronization.',
      });
    }
    if (this.config.rootPrefix !== undefined) {
      splitCleanStorageSegments(this.config.rootPrefix, 'Local Directory');
    }
  }

  private getRootSegments(): string[] {
    if (!this.config.rootPrefix) return [];
    return splitCleanStorageSegments(this.config.rootPrefix, 'Local Directory');
  }

  private async getAuthorizedRootHandle(phase: string): Promise<VirtualDirectoryHandle> {
    this.validateConfig();
    if (!this.resolveDirectoryHandle) {
      throw makeMissingHandleError(this.config.handleKey);
    }
    const handle = await this.resolveDirectoryHandle(this.config.handleKey);
    if (!handle) {
      throw makeMissingHandleError(this.config.handleKey);
    }
    if (typeof handle.queryPermission === 'function') {
      const state = await handle.queryPermission({ mode: 'readwrite' });
      if (state === 'prompt' || state === 'denied') {
        throw makePermissionError(phase);
      }
    }
    return handle;
  }

  private wrapFsError(err: unknown, phase: string, displayPath: string): never {
    if (err instanceof WebDAVHttpError) throw err;
    if (isPermissionDomError(err)) {
      throw makePermissionError(phase);
    }
    if (isNotFoundDomError(err)) {
      throw createHttpStatusError(404, phase, displayPath);
    }
    if (isTypeMismatchDomError(err)) {
      throw createHttpStatusError(409, phase, displayPath);
    }
    if (isQuotaDomError(err)) {
      throw createHttpStatusError(507, phase, displayPath);
    }
    throw new WebDAVHttpError({
      status: 500,
      code: 'ERR_LOCAL_DIR_IO',
      phase,
      message: `Local directory ${phase} failed (${displayPath}): ${err instanceof Error ? err.message : String(err)}`,
      retryable: false,
      suggestion: 'Verify the local directory still exists and has read/write permissions.',
    });
  }

  private async traverseDir(
    root: VirtualDirectoryHandle,
    segments: string[],
    create: boolean,
    phase: string,
  ): Promise<VirtualDirectoryHandle | null> {
    let cur = root;
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      try {
        cur = await cur.getDirectoryHandle(seg, { create });
      } catch (err) {
        if (!create && isNotFoundDomError(err)) {
          return null;
        }
        this.wrapFsError(err, phase, `/${segments.slice(0, i + 1).join('/')}`);
      }
    }
    return cur;
  }

  private async computeFileStat(
    fileHandle: Awaited<ReturnType<VirtualDirectoryHandle['getFileHandle']>>,
    relPath: string,
    name: string,
  ): Promise<{ stat: RemoteObjectStat; bytes: Uint8Array }> {
    const file = await fileHandle.getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha = await sha256Hex(bytes);
    const etag = `${sha}-${file.size}-${file.lastModified}`;
    return {
      bytes,
      stat: {
        path: relPath,
        name,
        isCollection: false,
        etag,
        size: file.size,
        lastModified: file.lastModified,
        status: 200,
      },
    };
  }

  async ensureDir(subPath: string): Promise<void> {
    const root = await this.getAuthorizedRootHandle('ensureDir');
    const rootSegments = this.getRootSegments();
    const subSegments = splitCleanStorageSegments(subPath, 'Local Directory');
    await this.traverseDir(root, [...rootSegments, ...subSegments], true, 'ensureDir');
  }

  async list(subPath: string, depth: 0 | 1 = 1): Promise<RemoteObjectStat[]> {
    if (depth === 0) {
      const st = await this.stat(subPath);
      return st ? [st] : [];
    }

    const root = await this.getAuthorizedRootHandle('list');
    const rootSegments = this.getRootSegments();
    const subSegments = splitCleanStorageSegments(subPath, 'Local Directory');
    const targetDir = await this.traverseDir(root, [...rootSegments, ...subSegments], false, 'list');
    if (!targetDir) {
      return [];
    }

    const displayDir = subSegments.length > 0 ? `/${subSegments.join('/')}` : '/';
    const items: RemoteObjectStat[] = [];

    try {
      for await (const [entryKey, entryHandle] of targetDir.entries()) {
        const entryName = entryHandle.name || entryKey;
        const childPath = subSegments.length > 0 ? `/${subSegments.join('/')}/${entryName}` : `/${entryName}`;
        if (entryHandle.kind === 'directory') {
          items.push({
            path: childPath,
            name: entryName,
            isCollection: true,
            size: 0,
            status: 200,
          });
        } else {
          const fh = await targetDir.getFileHandle(entryName, { create: false });
          const { stat } = await this.computeFileStat(fh, childPath, entryName);
          items.push(stat);
        }
      }
    } catch (err) {
      this.wrapFsError(err, 'list', displayDir);
    }

    return items;
  }

  async stat(subPath: string): Promise<RemoteObjectStat | null> {
    const root = await this.getAuthorizedRootHandle('stat');
    const rootSegments = this.getRootSegments();
    const subSegments = splitCleanStorageSegments(subPath, 'Local Directory');

    if (subSegments.length === 0) {
      if (rootSegments.length === 0) {
        return { path: '/', name: '', isCollection: true, size: 0, status: 200 };
      }
      const rootDir = await this.traverseDir(root, rootSegments, false, 'stat');
      return rootDir ? { path: '/', name: '', isCollection: true, size: 0, status: 200 } : null;
    }

    const parentSegments = [...rootSegments, ...subSegments.slice(0, -1)];
    const targetName = subSegments[subSegments.length - 1];
    const relPath = `/${subSegments.join('/')}`;
    const parentDir = await this.traverseDir(root, parentSegments, false, 'stat');
    if (!parentDir) {
      return null;
    }

    try {
      const fh = await parentDir.getFileHandle(targetName, { create: false });
      const { stat } = await this.computeFileStat(fh, relPath, targetName);
      return stat;
    } catch (err) {
      if (isPermissionDomError(err)) {
        throw makePermissionError('stat');
      }
      if (!isNotFoundDomError(err) && !isTypeMismatchDomError(err)) {
        this.wrapFsError(err, 'stat', relPath);
      }
    }

    try {
      await parentDir.getDirectoryHandle(targetName, { create: false });
      return {
        path: relPath,
        name: targetName,
        isCollection: true,
        size: 0,
        status: 200,
      };
    } catch (err) {
      if (isPermissionDomError(err)) {
        throw makePermissionError('stat');
      }
      if (isNotFoundDomError(err)) {
        return null;
      }
      this.wrapFsError(err, 'stat', relPath);
    }
  }

  async getBytes(
    subPath: string,
    options?: { ifNoneMatch?: string },
  ): Promise<{
    notModified: boolean;
    bytes: Uint8Array;
    etag?: string;
    status: number;
  }> {
    const root = await this.getAuthorizedRootHandle('getBytes');
    const rootSegments = this.getRootSegments();
    const subSegments = splitCleanStorageSegments(subPath, 'Local Directory');
    if (subSegments.length === 0) {
      throw createHttpStatusError(400, 'getBytes', '/');
    }

    const relPath = `/${subSegments.join('/')}`;
    const parentDir = await this.traverseDir(root, [...rootSegments, ...subSegments.slice(0, -1)], false, 'getBytes');
    if (!parentDir) {
      throw createHttpStatusError(404, 'getBytes', relPath);
    }

    const targetName = subSegments[subSegments.length - 1];
    try {
      const fh = await parentDir.getFileHandle(targetName, { create: false });
      const { stat, bytes } = await this.computeFileStat(fh, relPath, targetName);
      if (options?.ifNoneMatch && normalizeEtag(options.ifNoneMatch) === stat.etag) {
        return {
          notModified: true,
          bytes: new Uint8Array(0),
          etag: stat.etag,
          status: 304,
        };
      }
      return {
        notModified: false,
        bytes,
        etag: stat.etag,
        status: 200,
      };
    } catch (err) {
      this.wrapFsError(err, 'getBytes', relPath);
    }
  }

  async putBytes(
    subPath: string,
    bytes: Uint8Array,
    options?: { ifMatch?: string; ifNoneMatchStar?: boolean; contentType?: string },
  ): Promise<{ etag?: string; status: number }> {
    const root = await this.getAuthorizedRootHandle('putBytes');
    const rootSegments = this.getRootSegments();
    const subSegments = splitCleanStorageSegments(subPath, 'Local Directory');
    if (subSegments.length === 0) {
      throw createHttpStatusError(400, 'putBytes', '/');
    }

    const relPath = `/${subSegments.join('/')}`;
    const parentDir = await this.traverseDir(root, [...rootSegments, ...subSegments.slice(0, -1)], true, 'putBytes');
    if (!parentDir) {
      throw createHttpStatusError(409, 'putBytes', relPath);
    }

    const targetName = subSegments[subSegments.length - 1];
    let existingEtag: string | undefined;
    let existed = false;

    try {
      const existingFh = await parentDir.getFileHandle(targetName, { create: false });
      const { stat } = await this.computeFileStat(existingFh, relPath, targetName);
      existingEtag = stat.etag;
      existed = true;
    } catch (err) {
      if (isPermissionDomError(err)) {
        throw makePermissionError('putBytes');
      }
      if (!isNotFoundDomError(err)) {
        this.wrapFsError(err, 'putBytes', relPath);
      }
    }

    if (options?.ifNoneMatchStar && existed) {
      throw createHttpStatusError(412, 'putBytes', relPath);
    }
    if (options?.ifMatch) {
      const expected = normalizeEtag(options.ifMatch) ?? options.ifMatch;
      if (!existed) {
        throw createHttpStatusError(412, 'putBytes', relPath);
      }
      if (expected !== '*' && expected !== existingEtag) {
        throw createHttpStatusError(412, 'putBytes', relPath);
      }
    }

    try {
      const fh = await parentDir.getFileHandle(targetName, { create: true });
      const writable = await fh.createWritable();
      await writable.write(bytes);
      await writable.close();
      const { stat } = await this.computeFileStat(fh, relPath, targetName);
      return {
        etag: stat.etag,
        status: existed ? 200 : 201,
      };
    } catch (err) {
      this.wrapFsError(err, 'putBytes', relPath);
    }
  }

  async delete(subPath: string, options?: { ifMatch?: string; isCollection?: boolean }): Promise<void> {
    const root = await this.getAuthorizedRootHandle('delete');
    const rootSegments = this.getRootSegments();
    const subSegments = splitCleanStorageSegments(subPath, 'Local Directory');
    if (subSegments.length === 0) {
      if (rootSegments.length === 0) return;
      const parentOfRoot = await this.traverseDir(root, rootSegments.slice(0, -1), false, 'delete');
      if (!parentOfRoot) return;
      try {
        await parentOfRoot.removeEntry(rootSegments[rootSegments.length - 1], { recursive: true });
      } catch (err) {
        if (!isNotFoundDomError(err)) {
          this.wrapFsError(err, 'delete', '/');
        }
      }
      return;
    }

    const relPath = `/${subSegments.join('/')}`;
    const parentDir = await this.traverseDir(root, [...rootSegments, ...subSegments.slice(0, -1)], false, 'delete');
    if (!parentDir) {
      return;
    }

    const targetName = subSegments[subSegments.length - 1];
    if (options?.ifMatch) {
      try {
        const fh = await parentDir.getFileHandle(targetName, { create: false });
        const { stat } = await this.computeFileStat(fh, relPath, targetName);
        const expected = normalizeEtag(options.ifMatch) ?? options.ifMatch;
        if (expected !== '*' && expected !== stat.etag) {
          throw createHttpStatusError(412, 'delete', relPath);
        }
      } catch (err) {
        if (err instanceof WebDAVHttpError) throw err;
        if (isPermissionDomError(err)) throw makePermissionError('delete');
        if (isNotFoundDomError(err)) {
          throw createHttpStatusError(412, 'delete', relPath);
        }
        this.wrapFsError(err, 'delete', relPath);
      }
    }

    try {
      await parentDir.removeEntry(targetName, { recursive: Boolean(options?.isCollection) });
    } catch (err) {
      if (isNotFoundDomError(err)) {
        return;
      }
      this.wrapFsError(err, 'delete', relPath);
    }
  }

  async checkCapabilities(): Promise<CapabilityReport> {
    const startedAt = Date.now();
    const checks = createCapabilityChecksTemplate(LOCAL_DIR_CAPABILITY_STEPS);
    const setCheck = (
      stepNum: number,
      state: CapabilityReport['checks'][number]['state'],
      detail?: string,
      latencyMs?: number,
    ) => {
      const item = checks[stepNum - 1];
      item.state = state;
      if (detail !== undefined) item.detail = detail;
      if (latencyMs !== undefined) item.latencyMs = latencyMs;
    };

    try {
      this.validateConfig();
      setCheck(1, 'supported', `Valid handle key "${this.config.handleKey}"`);
    } catch (err) {
      const msg = describeAdapterError(err);
      setCheck(1, 'unsupported', msg);
      return buildCapabilityReport({
        startedAt,
        url: this.displayEndpoint,
        consistencyLevel: 'incompatible',
        overallOk: false,
        checks,
        summaryMessage: msg,
      });
    }

    const tPerm = Date.now();
    try {
      await this.getAuthorizedRootHandle('checkCapabilities');
      setCheck(2, 'supported', 'Directory handle resolved with readwrite permission', Date.now() - tPerm);
    } catch (err) {
      const msg = describeAdapterError(err);
      setCheck(2, 'unsupported', msg, Date.now() - tPerm);
      return buildCapabilityReport({
        startedAt,
        url: this.displayEndpoint,
        consistencyLevel: 'incompatible',
        overallOk: false,
        checks,
        summaryMessage: msg,
      });
    }

    const probeToken = bytesToHex(generateRandomBytes(6));
    const probeDir = `sm_probe_${probeToken}`;
    const basicFile = `${probeDir}/basic.enc`;
    const casCreateFile = `${probeDir}/cas_create.enc`;
    const casUpdateFile = `${probeDir}/cas_update.enc`;
    const shaFile = `${probeDir}/sha_check.enc`;
    const size64File = `${probeDir}/size_64k.enc`;

    let probeCreated = false;
    let basicOk = true;
    let abortMsg: string | undefined;

    try {
      const tMk = Date.now();
      try {
        await this.ensureDir(probeDir);
        probeCreated = true;
        setCheck(3, 'supported', `Created probe directory ${probeDir}`, Date.now() - tMk);
      } catch (err) {
        basicOk = false;
        abortMsg = `Local directory creation failed: ${describeAdapterError(err)}`;
        setCheck(3, 'unsupported', describeAdapterError(err), Date.now() - tMk);
      }

      if (basicOk) {
        const probeBytes = new TextEncoder().encode(`sessionmesh-local-probe:${probeToken}`);
        const tPut = Date.now();
        try {
          const putRes = await this.putBytes(basicFile, probeBytes);
          setCheck(4, 'supported', `Wrote ${probeBytes.byteLength} bytes`, Date.now() - tPut);
          const tGet = Date.now();
          const got = await this.getBytes(basicFile);
          if (got.bytes.byteLength === probeBytes.byteLength && putRes.etag) {
            setCheck(5, 'supported', `Read ${got.bytes.byteLength} bytes (ETag: ${putRes.etag.slice(0, 12)}...)`, Date.now() - tGet);
          } else {
            basicOk = false;
            abortMsg = 'Local directory read length mismatch';
            setCheck(5, 'unsupported', abortMsg, Date.now() - tGet);
          }
        } catch (err) {
          basicOk = false;
          abortMsg = `Local directory write/read failed: ${describeAdapterError(err)}`;
          setCheck(4, 'unsupported', describeAdapterError(err), Date.now() - tPut);
        }
      }

      if (basicOk) {
        // Step 6: If-None-Match: *
        const tCondCreate = Date.now();
        try {
          await this.putBytes(casCreateFile, new TextEncoder().encode('v1'), { ifNoneMatchStar: true });
          let rejected = false;
          try {
            await this.putBytes(casCreateFile, new TextEncoder().encode('v2'), { ifNoneMatchStar: true });
          } catch (dupErr) {
            if (dupErr instanceof WebDAVHttpError && dupErr.status === 412) rejected = true;
          }
          setCheck(
            6,
            rejected ? 'supported' : 'unsupported',
            rejected ? 'Duplicate create rejected with 412' : 'If-None-Match: * failed to reject duplicate',
            Date.now() - tCondCreate,
          );
        } catch (err) {
          setCheck(6, 'unsupported', describeAdapterError(err), Date.now() - tCondCreate);
        }

        // Step 7: If-Match CAS
        const tCondUpdate = Date.now();
        try {
          const init = await this.putBytes(casUpdateFile, new TextEncoder().encode('cas-v1'));
          await this.putBytes(casUpdateFile, new TextEncoder().encode('cas-v2'), { ifMatch: init.etag });
          let rejectedStale = false;
          try {
            await this.putBytes(casUpdateFile, new TextEncoder().encode('cas-v3-stale'), { ifMatch: init.etag });
          } catch (staleErr) {
            if (staleErr instanceof WebDAVHttpError && staleErr.status === 412) rejectedStale = true;
          }
          setCheck(
            7,
            rejectedStale ? 'supported' : 'unsupported',
            rejectedStale ? 'Valid If-Match succeeded; stale ETag rejected with 412' : 'Stale If-Match not rejected',
            Date.now() - tCondUpdate,
          );
        } catch (err) {
          setCheck(7, 'unsupported', describeAdapterError(err), Date.now() - tCondUpdate);
        }

        // Step 8: 512B binary SHA-256
        const tSha = Date.now();
        try {
          const sample = new Uint8Array(512);
          for (let i = 0; i < 256; i += 1) sample[i] = i;
          sample.set(generateRandomBytes(256), 256);
          const expectedHash = await sha256Hex(sample);
          await this.putBytes(shaFile, sample);
          const readBack = await this.getBytes(shaFile);
          const actualHash = await sha256Hex(readBack.bytes);
          if (actualHash === expectedHash) {
            setCheck(8, 'supported', `SHA-256 verified (${expectedHash.slice(0, 12)}...)`, Date.now() - tSha);
          } else {
            basicOk = false;
            setCheck(8, 'unsupported', 'Binary payload SHA-256 mismatch', Date.now() - tSha);
          }
        } catch (err) {
          basicOk = false;
          setCheck(8, 'unsupported', describeAdapterError(err), Date.now() - tSha);
        }

        // Step 9: 64KB payload
        const t64 = Date.now();
        try {
          const p64 = generateRandomBytes(64 * 1024);
          const h64 = await sha256Hex(p64);
          await this.putBytes(size64File, p64);
          const r64 = await this.getBytes(size64File);
          if (r64.bytes.byteLength === p64.byteLength && (await sha256Hex(r64.bytes)) === h64) {
            setCheck(9, 'supported', '64KB binary round-trip SHA-256 verified', Date.now() - t64);
          } else {
            basicOk = false;
            setCheck(9, 'unsupported', '64KB payload mismatch', Date.now() - t64);
          }
        } catch (err) {
          basicOk = false;
          setCheck(9, 'unsupported', describeAdapterError(err), Date.now() - t64);
        }
      }
    } finally {
      const tClean = Date.now();
      if (probeCreated) {
        try {
          await this.delete(probeDir, { isCollection: true });
          setCheck(10, 'supported', `Cleaned up probe directory ${probeDir}`, Date.now() - tClean);
        } catch (err) {
          setCheck(10, 'unsupported', describeAdapterError(err), Date.now() - tClean);
        }
      } else {
        setCheck(10, 'unverified', 'No probe directory created');
      }
    }

    if (!basicOk || abortMsg) {
      return buildCapabilityReport({
        startedAt,
        url: this.displayEndpoint,
        consistencyLevel: 'incompatible',
        overallOk: false,
        checks,
        summaryMessage: abortMsg ?? 'Local directory failed read/write checks.',
      });
    }

    const strongCas = checks[5].state === 'supported' && checks[6].state === 'supported';

    return buildCapabilityReport({
      startedAt,
      url: this.displayEndpoint,
      consistencyLevel: strongCas ? 'strong_cas' : 'append_only_degraded',
      overallOk: true,
      checks,
      summaryMessage: strongCas
        ? 'Local directory passed all checks with strong CAS concurrency protection.'
        : 'Local directory passed basic read/write checks.',
    });
  }
}
