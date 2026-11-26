/**
 * Storage Provider Factory, Config Normalization, Secret Sanitization & S3 Vendor Presets.
 */
import type {
  RemoteStorageAdapter,
  S3StorageConfig,
  S3VendorPreset,
  SanitizedStorageProviderConfig,
  StorageProviderConfig,
  WebDAVConfig,
} from '../types';
import { WebDAVHttpError } from '../webdav/errors';
import { GitHubGistStorageAdapter } from './githubGistAdapter';
import { LocalDirectoryStorageAdapter } from './localDirAdapter';
import { S3StorageAdapter } from './s3Adapter';
import { isLocalhostHostname, type StorageAdapterOptions } from './types';
import { WebDAVStorageAdapter } from './webdavAdapter';

export interface S3VendorPresetInfo {
  id: S3VendorPreset;
  label: string;
  defaultRegion: string;
  defaultAddressingStyle: 'path' | 'virtual_hosted';
  defaultSignatureMode: 'aws_v4' | 'oss_v4';
  endpointPlaceholder: string;
  regionPlaceholder: string;
  notes: string;
}

export const S3_VENDOR_PRESETS: Record<S3VendorPreset, S3VendorPresetInfo> = {
  r2: {
    id: 'r2',
    label: 'Cloudflare R2',
    defaultRegion: 'auto',
    defaultAddressingStyle: 'path',
    defaultSignatureMode: 'aws_v4',
    endpointPlaceholder: 'https://<account_id>.r2.cloudflarestorage.com',
    regionPlaceholder: 'auto',
    notes: '使用 Cloudflare R2 S3 兼容端点与 Path-Style 访问，Region 填写 auto。',
  },
  aliyun_oss: {
    id: 'aliyun_oss',
    label: '阿里云 OSS',
    defaultRegion: 'cn-hangzhou',
    defaultAddressingStyle: 'virtual_hosted',
    defaultSignatureMode: 'oss_v4',
    endpointPlaceholder: 'https://oss-cn-hangzhou.aliyuncs.com',
    regionPlaceholder: 'cn-hangzhou',
    notes: '默认使用 Virtual-Hosted 域名风格与 OSS4-HMAC-SHA256 签名（Region 如 cn-hangzhou）。',
  },
  aws_s3: {
    id: 'aws_s3',
    label: 'AWS S3',
    defaultRegion: 'us-east-1',
    defaultAddressingStyle: 'virtual_hosted',
    defaultSignatureMode: 'aws_v4',
    endpointPlaceholder: 'https://s3.us-east-1.amazonaws.com',
    regionPlaceholder: 'us-east-1',
    notes: 'Amazon S3 标准端点，默认 Virtual-Hosted 风格与 AWS SigV4。',
  },
  minio: {
    id: 'minio',
    label: 'MinIO / 自建 S3',
    defaultRegion: 'us-east-1',
    defaultAddressingStyle: 'path',
    defaultSignatureMode: 'aws_v4',
    endpointPlaceholder: 'https://minio.example.com:9000',
    regionPlaceholder: 'us-east-1',
    notes: '适用于自建 MinIO、RustFS、Garage、Ceph RGW 等，默认 Path-Style。',
  },
  cos: {
    id: 'cos',
    label: '腾讯云 COS',
    defaultRegion: 'ap-guangzhou',
    defaultAddressingStyle: 'virtual_hosted',
    defaultSignatureMode: 'aws_v4',
    endpointPlaceholder: 'https://cos.ap-guangzhou.myqcloud.com',
    regionPlaceholder: 'ap-guangzhou',
    notes: '腾讯云 COS S3 兼容接口（Bucket 格式通常为 name-appid）。',
  },
  b2: {
    id: 'b2',
    label: 'Backblaze B2',
    defaultRegion: 'us-west-004',
    defaultAddressingStyle: 'virtual_hosted',
    defaultSignatureMode: 'aws_v4',
    endpointPlaceholder: 'https://s3.us-west-004.backblazeb2.com',
    regionPlaceholder: 'us-west-004',
    notes: 'Backblaze B2 S3 Compatible API。',
  },
  custom: {
    id: 'custom',
    label: '自定义 S3 兼容存储',
    defaultRegion: 'us-east-1',
    defaultAddressingStyle: 'path',
    defaultSignatureMode: 'aws_v4',
    endpointPlaceholder: 'https://s3.example.com',
    regionPlaceholder: 'us-east-1',
    notes: '通用 S3 SigV4 对象存储服务。',
  },
};

function resolveDefaultS3AddressingStyle(cfg: S3StorageConfig): 'path' | 'virtual_hosted' {
  if (cfg.addressingStyle) return cfg.addressingStyle;
  try {
    const parsed = new URL(cfg.endpoint);
    if (isLocalhostHostname(parsed.hostname)) {
      return 'path';
    }
  } catch {
    // ignore invalid URL during normalization
  }
  const preset = cfg.vendorPreset ? S3_VENDOR_PRESETS[cfg.vendorPreset] : undefined;
  return preset?.defaultAddressingStyle ?? 'path';
}

export function normalizeStorageProviderConfig(
  config?: StorageProviderConfig | null,
  legacyWebdav?: WebDAVConfig | null,
): StorageProviderConfig | null {
  if (!config) {
    if (!legacyWebdav) return null;
    return {
      ...legacyWebdav,
      provider: 'webdav',
      url: legacyWebdav.url.trim(),
      rootPath: legacyWebdav.rootPath || '/SessionMesh',
    };
  }

  const provider = (config as { provider?: string }).provider ?? 'webdav';

  switch (provider) {
    case 'webdav': {
      const cfg = config as { provider?: 'webdav' } & WebDAVConfig;
      return {
        ...cfg,
        provider: 'webdav',
        url: (cfg.url || '').trim(),
        rootPath: cfg.rootPath || '/SessionMesh',
      };
    }
    case 's3': {
      const cfg = config as S3StorageConfig;
      const preset = cfg.vendorPreset ? S3_VENDOR_PRESETS[cfg.vendorPreset] : undefined;
      return {
        ...cfg,
        provider: 's3',
        endpoint: (cfg.endpoint || '').trim(),
        bucket: (cfg.bucket || '').trim(),
        region: (cfg.region || preset?.defaultRegion || 'us-east-1').trim(),
        accessKeyId: (cfg.accessKeyId || '').trim(),
        rootPrefix: cfg.rootPrefix ?? '/SessionMesh',
        addressingStyle: resolveDefaultS3AddressingStyle(cfg),
        signatureMode: cfg.signatureMode ?? preset?.defaultSignatureMode ?? 'aws_v4',
      };
    }
    case 'github_gist': {
      const cfg = config as Extract<StorageProviderConfig, { provider: 'github_gist' }>;
      return {
        ...cfg,
        provider: 'github_gist',
        personalAccessToken: (cfg.personalAccessToken || '').trim(),
        gistId: cfg.gistId?.trim() || undefined,
        apiBaseUrl: (cfg.apiBaseUrl || 'https://api.github.com').trim().replace(/\/+$/, ''),
        rootPrefix: cfg.rootPrefix ?? 'SessionMesh',
      };
    }
    case 'local_directory': {
      const cfg = config as Extract<StorageProviderConfig, { provider: 'local_directory' }>;
      const handleKey = (cfg.handleKey || '').trim();
      return {
        ...cfg,
        provider: 'local_directory',
        handleKey,
        directoryLabel: (cfg.directoryLabel || handleKey).trim(),
        rootPrefix: cfg.rootPrefix ?? 'SessionMesh',
      };
    }
    default:
      throw new WebDAVHttpError({
        status: 0,
        code: 'UNSUPPORTED_STORAGE_PROVIDER',
        phase: 'normalize_config',
        message: `Unsupported storage provider: "${provider}"`,
        retryable: false,
        suggestion: 'Choose one of: webdav, s3, github_gist, local_directory.',
      });
  }
}

export function sanitizeStorageProviderConfig(
  config?: StorageProviderConfig | null,
): SanitizedStorageProviderConfig | null {
  if (!config) return null;
  const provider = (config as { provider?: string }).provider ?? 'webdav';

  switch (provider) {
    case 'webdav': {
      const { password: _password, bearerToken: _bearerToken, ...rest } = config as {
        provider: 'webdav';
      } & WebDAVConfig;
      return {
        ...rest,
        provider: 'webdav',
      };
    }
    case 's3': {
      const { secretAccessKey: _secret, sessionToken: _token, ...rest } = config as S3StorageConfig;
      return {
        ...rest,
        provider: 's3',
      };
    }
    case 'github_gist': {
      const { personalAccessToken: _pat, ...rest } = config as Extract<
        StorageProviderConfig,
        { provider: 'github_gist' }
      >;
      return {
        ...rest,
        provider: 'github_gist',
      };
    }
    case 'local_directory': {
      const cfg = config as Extract<StorageProviderConfig, { provider: 'local_directory' }>;
      return {
        ...cfg,
        provider: 'local_directory',
      };
    }
    default:
      return null;
  }
}

export function createRemoteStorageAdapter(
  config: StorageProviderConfig,
  options?: StorageAdapterOptions,
): RemoteStorageAdapter {
  const normalized = normalizeStorageProviderConfig(config);
  if (!normalized) {
    throw new WebDAVHttpError({
      status: 0,
      code: 'STORAGE_CONFIG_MISSING',
      phase: 'create_adapter',
      message: 'Storage provider configuration is missing',
      retryable: false,
      suggestion: 'Configure a valid WebDAV, S3, GitHub Gist, or Local Directory storage provider.',
    });
  }

  switch (normalized.provider) {
    case 'webdav':
      return new WebDAVStorageAdapter(normalized, options);
    case 's3':
      return new S3StorageAdapter(normalized, options);
    case 'github_gist':
      return new GitHubGistStorageAdapter(normalized, options);
    case 'local_directory':
      return new LocalDirectoryStorageAdapter(normalized, options);
    default:
      throw new WebDAVHttpError({
        status: 0,
        code: 'UNSUPPORTED_STORAGE_PROVIDER',
        phase: 'create_adapter',
        message: `Unsupported storage provider: "${(normalized as { provider: string }).provider}"`,
        retryable: false,
        suggestion: 'Choose one of: webdav, s3, github_gist, local_directory.',
      });
  }
}
