/**
 * WebDAV RemoteStorageAdapter wrapper around WebDAVClient & WebDAVCapabilityDetector.
 */
import type { CapabilityReport, RemoteObjectStat, RemoteStorageAdapter, WebDAVConfig } from '../types';
import { WebDAVCapabilityDetector } from '../webdav/capability';
import { WebDAVClient } from '../webdav/client';
import { splitCleanStorageSegments, type StorageAdapterOptions } from './types';

export class WebDAVStorageAdapter implements RemoteStorageAdapter {
  readonly provider = 'webdav' as const;
  readonly displayEndpoint: string;

  private readonly config: WebDAVConfig;
  private readonly client: WebDAVClient;
  private readonly fetchImpl?: typeof fetch;

  constructor(config: WebDAVConfig | ({ provider: 'webdav' } & WebDAVConfig), options?: StorageAdapterOptions) {
    const { provider: _provider, ...webdavCfg } = config as WebDAVConfig & { provider?: 'webdav' };
    this.config = { ...webdavCfg };
    this.displayEndpoint = this.config.url;
    this.fetchImpl = options?.fetchImpl;
    this.client = new WebDAVClient(this.config, { fetchImpl: this.fetchImpl });
  }

  setStorageFormat(format: 'binary_enc' | 'base64_txt'): void {
    this.client.setStorageFormat(format);
  }

  validateConfig(): void {
    this.client.validateUrl();
  }

  checkCapabilities(): Promise<CapabilityReport> {
    return new WebDAVCapabilityDetector(this.config, { fetchImpl: this.fetchImpl }).runFullCheck();
  }

  ensureDir(subPath: string): Promise<void> {
    return this.client.ensureDir(subPath);
  }

  async list(subPath: string, depth: 0 | 1 = 1): Promise<RemoteObjectStat[]> {
    const entries = await this.client.propfind(subPath, depth);
    if (depth === 0) {
      return entries;
    }

    const targetNorm = splitCleanStorageSegments(subPath, 'WebDAV').join('/');
    return entries.filter((entry) => {
      const entryNorm = entry.path.replace(/^\/+|\/+$/g, '');
      if (!entryNorm) return false;
      if (!targetNorm) return true;
      if (entryNorm === targetNorm) return false;
      // Handle reverse-proxy prefix cases while preserving identically named child folders (e.g. a/a)
      if (entry.isCollection && entryNorm.endsWith(`/${targetNorm}`) && !entryNorm.startsWith(`${targetNorm}/`)) {
        return false;
      }
      return true;
    });
  }

  stat(subPath: string): Promise<RemoteObjectStat | null> {
    return this.client.stat(subPath);
  }

  getBytes(
    subPath: string,
    options?: { ifNoneMatch?: string },
  ): Promise<{
    notModified: boolean;
    bytes: Uint8Array;
    etag?: string;
    status: number;
  }> {
    return this.client.getBytes(subPath, options);
  }

  putBytes(
    subPath: string,
    bytes: Uint8Array,
    options?: { ifMatch?: string; ifNoneMatchStar?: boolean; contentType?: string },
  ): Promise<{ etag?: string; status: number }> {
    return this.client.putBytes(subPath, bytes, options);
  }

  delete(subPath: string, options?: { ifMatch?: string; isCollection?: boolean }): Promise<void> {
    return this.client.delete(subPath, options);
  }
}
