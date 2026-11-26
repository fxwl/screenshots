export {
  type RemoteStorageAdapter,
  type RemoteObjectStat,
  type StorageProviderType,
  type StorageProviderConfig,
  type SanitizedStorageProviderConfig,
  type S3StorageConfig,
  type S3VendorPreset,
  type GitHubGistStorageConfig,
  type LocalDirectoryStorageConfig,
  type LocalDirEntry,
  type VirtualDirectoryHandle,
  type DirectoryHandleResolver,
  type StorageAdapterOptions,
  type StorageAdapterFactoryOptions,
} from './types';

export { WebDAVStorageAdapter } from './webdavAdapter';
export {
  encodeRfc3986,
  canonicalizeUri,
  canonicalizeQueryString,
  formatAmzDate,
  hmacSha256Bytes,
  signS3Request,
  type S3SignatureAlgorithm,
  type S3SignRequestInput,
  type S3SignedRequest,
} from './s3SigV4';
export { S3StorageAdapter, parseS3ListObjectsV2Xml } from './s3Adapter';
export {
  GitHubGistStorageAdapter,
  encodeGistFilename,
  decodeGistFilename,
} from './githubGistAdapter';
export { LocalDirectoryStorageAdapter } from './localDirAdapter';
export {
  ARCHIVE_BACKUP_AAD,
  encodeArchiveBackup,
  decodeArchiveBackup,
} from './archiveBackup';
export {
  S3_VENDOR_PRESETS,
  type S3VendorPresetInfo,
  normalizeStorageProviderConfig,
  sanitizeStorageProviderConfig,
  createRemoteStorageAdapter,
} from './factory';
