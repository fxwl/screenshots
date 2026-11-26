import type {
  S3VendorPreset,
  SanitizedStorageProviderConfig,
  StorageProviderConfig,
  StorageProviderType,
  WebDAVAuthType,
  WebDAVConfig,
} from '@sessionmesh/core';
import { unwrapCommand } from '@sessionmesh/shared';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@sessionmesh/ui';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cloud,
  Copy,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  FileCode2,
  FolderOpen,
  HelpCircle,
  Info,
  Loader2,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  copyToClipboard,
  extractErrorMessage,
  getS3VendorOption,
  openExternalUrl,
  S3_VENDOR_OPTIONS,
  WEBDAV_PRESETS,
  type UiNonSensitiveMeta,
} from '../utils/helpers';
import {
  isDirectoryPickerSupported,
  pickAndStoreLocalDirectory,
  queryLocalDirectoryPermission,
  requestLocalDirectoryPermission,
  type DirectoryPermissionState,
} from '../utils/localDirHandles';

export interface StorageFormDraft {
  provider: StorageProviderType;
  // WebDAV
  webdavUrl: string;
  webdavAuthType: WebDAVAuthType;
  webdavUsername: string;
  webdavPassword: string;
  webdavBearerToken: string;
  webdavRootPath: string;
  webdavStorageFormat?: 'binary_enc' | 'base64_txt';
  webdavAllowInsecureLocalhost: boolean;
  // S3 / R2 / OSS
  s3VendorPreset: S3VendorPreset;
  s3Endpoint: string;
  s3Bucket: string;
  s3Region: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  s3SessionToken: string;
  s3RootPrefix: string;
  s3AddressingStyle: 'path' | 'virtual_hosted';
  s3SignatureMode: 'aws_v4' | 'oss_v4';
  s3AllowInsecureLocalhost: boolean;
  // GitHub Private Gist
  gistToken: string;
  gistId: string;
  gistApiBaseUrl: string;
  gistRootPrefix: string;
  gistAllowInsecureLocalhost: boolean;
  // Local Directory
  localDirHandleKey: string;
  localDirLabel: string;
  localDirRootPrefix: string;
}

const DEFAULT_R2 = getS3VendorOption('r2');

export function createDefaultStorageDraft(provider: StorageProviderType = 'webdav'): StorageFormDraft {
  return {
    provider,
    webdavUrl: '',
    webdavAuthType: 'basic',
    webdavUsername: '',
    webdavPassword: '',
    webdavBearerToken: '',
    webdavRootPath: '/SessionMesh',
    webdavStorageFormat: undefined,
    webdavAllowInsecureLocalhost: false,
    s3VendorPreset: 'r2',
    s3Endpoint: '',
    s3Bucket: '',
    s3Region: DEFAULT_R2.defaultRegion,
    s3AccessKeyId: '',
    s3SecretAccessKey: '',
    s3SessionToken: '',
    s3RootPrefix: 'SessionMesh',
    s3AddressingStyle: DEFAULT_R2.defaultAddressingStyle,
    s3SignatureMode: DEFAULT_R2.defaultSignatureMode,
    s3AllowInsecureLocalhost: false,
    gistToken: '',
    gistId: '',
    gistApiBaseUrl: 'https://api.github.com',
    gistRootPrefix: 'SessionMesh',
    gistAllowInsecureLocalhost: false,
    localDirHandleKey: '',
    localDirLabel: '',
    localDirRootPrefix: 'SessionMesh',
  };
}

export function isLoopbackHttpUrl(rawUrl: string): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(rawUrl.trim());
}

export function normalizeWebdavRootPath(rootPath: string): string {
  const rawRoot = (rootPath.trim() || '/SessionMesh').replace(/\/+$/, '');
  return rawRoot ? (rawRoot.startsWith('/') ? rawRoot : `/${rawRoot}`) : '/SessionMesh';
}

export function stripWebdavProvider(storage: Extract<StorageProviderConfig, { provider: 'webdav' }>): WebDAVConfig {
  return {
    url: storage.url,
    authType: storage.authType,
    username: storage.username,
    password: storage.password,
    bearerToken: storage.bearerToken,
    rootPath: storage.rootPath,
    requestTimeoutMs: storage.requestTimeoutMs,
    retryPolicy: storage.retryPolicy,
    storageFormat: storage.storageFormat,
    allowInsecureLocalhostForTesting: storage.allowInsecureLocalhostForTesting,
  };
}

export function draftFromStorageConfig(
  cfg?: StorageProviderConfig | SanitizedStorageProviderConfig | null,
  fallbackMeta?: UiNonSensitiveMeta,
): StorageFormDraft {
  const base = createDefaultStorageDraft(cfg?.provider ?? fallbackMeta?.storageProvider ?? 'webdav');

  if (fallbackMeta) {
    if (fallbackMeta.webdavUrl) base.webdavUrl = fallbackMeta.webdavUrl;
    if (fallbackMeta.authType) base.webdavAuthType = fallbackMeta.authType;
    if (fallbackMeta.username) base.webdavUsername = fallbackMeta.username;
    if (fallbackMeta.rootPath) base.webdavRootPath = fallbackMeta.rootPath;
    if (fallbackMeta.s3VendorPreset) base.s3VendorPreset = fallbackMeta.s3VendorPreset;
    if (fallbackMeta.s3Bucket) base.s3Bucket = fallbackMeta.s3Bucket;
    if (fallbackMeta.s3Region) base.s3Region = fallbackMeta.s3Region;
    if (fallbackMeta.s3RootPrefix) base.s3RootPrefix = fallbackMeta.s3RootPrefix;
    if (fallbackMeta.s3AddressingStyle) base.s3AddressingStyle = fallbackMeta.s3AddressingStyle;
    if (fallbackMeta.s3SignatureMode) base.s3SignatureMode = fallbackMeta.s3SignatureMode;
    if (fallbackMeta.gistId) base.gistId = fallbackMeta.gistId;
    if (fallbackMeta.gistApiBaseUrl) base.gistApiBaseUrl = fallbackMeta.gistApiBaseUrl;
    if (fallbackMeta.gistRootPrefix) base.gistRootPrefix = fallbackMeta.gistRootPrefix;
    if (fallbackMeta.localDirLabel) base.localDirLabel = fallbackMeta.localDirLabel;
    if (fallbackMeta.localDirHandleKey) base.localDirHandleKey = fallbackMeta.localDirHandleKey;
    if (fallbackMeta.localDirRootPrefix) base.localDirRootPrefix = fallbackMeta.localDirRootPrefix;
  }

  if (!cfg) return base;

  switch (cfg.provider) {
    case 'webdav':
      return {
        ...base,
        provider: 'webdav',
        webdavUrl: cfg.url || base.webdavUrl,
        webdavAuthType: cfg.authType || base.webdavAuthType,
        webdavUsername: cfg.username ?? base.webdavUsername,
        webdavPassword: 'password' in cfg && typeof cfg.password === 'string' ? cfg.password : '',
        webdavBearerToken: 'bearerToken' in cfg && typeof cfg.bearerToken === 'string' ? cfg.bearerToken : '',
        webdavRootPath: cfg.rootPath || '/SessionMesh',
        webdavStorageFormat: cfg.storageFormat,
        webdavAllowInsecureLocalhost: Boolean(cfg.allowInsecureLocalhostForTesting || isLoopbackHttpUrl(cfg.url || '')),
      };
    case 's3': {
      const preset = cfg.vendorPreset ?? 'r2';
      const presetMeta = getS3VendorOption(preset);
      return {
        ...base,
        provider: 's3',
        s3VendorPreset: preset,
        s3Endpoint: cfg.endpoint || '',
        s3Bucket: cfg.bucket || '',
        s3Region: cfg.region || presetMeta.defaultRegion,
        s3AccessKeyId: cfg.accessKeyId || '',
        s3SecretAccessKey:
          'secretAccessKey' in cfg && typeof cfg.secretAccessKey === 'string' ? cfg.secretAccessKey : '',
        s3SessionToken: 'sessionToken' in cfg && typeof cfg.sessionToken === 'string' ? cfg.sessionToken : '',
        s3RootPrefix: cfg.rootPrefix || 'SessionMesh',
        s3AddressingStyle: cfg.addressingStyle ?? presetMeta.defaultAddressingStyle,
        s3SignatureMode: cfg.signatureMode ?? presetMeta.defaultSignatureMode,
        s3AllowInsecureLocalhost: Boolean(
          cfg.allowInsecureLocalhostForTesting || isLoopbackHttpUrl(cfg.endpoint || ''),
        ),
      };
    }
    case 'github_gist':
      return {
        ...base,
        provider: 'github_gist',
        gistToken:
          'personalAccessToken' in cfg && typeof cfg.personalAccessToken === 'string' ? cfg.personalAccessToken : '',
        gistId: cfg.gistId || '',
        gistApiBaseUrl: cfg.apiBaseUrl || 'https://api.github.com',
        gistRootPrefix: cfg.rootPrefix || 'SessionMesh',
        gistAllowInsecureLocalhost: Boolean(
          cfg.allowInsecureLocalhostForTesting || isLoopbackHttpUrl(cfg.apiBaseUrl || ''),
        ),
      };
    case 'local_directory':
      return {
        ...base,
        provider: 'local_directory',
        localDirHandleKey: cfg.handleKey || '',
        localDirLabel: cfg.directoryLabel || '',
        localDirRootPrefix: cfg.rootPrefix || 'SessionMesh',
      };
    default:
      return base;
  }
}

export function buildStorageConfigFromDraft(
  draft: StorageFormDraft,
  options?: { lowFrequencyMode?: boolean },
): StorageProviderConfig {
  switch (draft.provider) {
    case 'webdav': {
      const trimmedUrl = draft.webdavUrl.trim();
      const isLocal = isLoopbackHttpUrl(trimmedUrl);
      return {
        provider: 'webdav',
        url: trimmedUrl,
        authType: draft.webdavAuthType,
        username: draft.webdavAuthType === 'bearer' ? undefined : draft.webdavUsername.trim(),
        password: draft.webdavAuthType === 'bearer' ? undefined : draft.webdavPassword,
        bearerToken: draft.webdavAuthType === 'bearer' ? draft.webdavBearerToken.trim() : undefined,
        rootPath: normalizeWebdavRootPath(draft.webdavRootPath),
        retryPolicy: options?.lowFrequencyMode ? 'low_frequency_nutstore' : 'standard',
        storageFormat: draft.webdavStorageFormat,
        allowInsecureLocalhostForTesting: draft.webdavAllowInsecureLocalhost && isLocal ? true : undefined,
      };
    }
    case 's3': {
      const endpoint = draft.s3Endpoint.trim().replace(/\/+$/, '');
      const isLocal = isLoopbackHttpUrl(endpoint);
      return {
        provider: 's3',
        vendorPreset: draft.s3VendorPreset,
        endpoint,
        region: draft.s3Region.trim() || getS3VendorOption(draft.s3VendorPreset).defaultRegion,
        bucket: draft.s3Bucket.trim(),
        accessKeyId: draft.s3AccessKeyId.trim(),
        secretAccessKey: draft.s3SecretAccessKey,
        sessionToken: draft.s3SessionToken.trim() || undefined,
        rootPrefix: draft.s3RootPrefix.trim() || 'SessionMesh',
        addressingStyle: draft.s3AddressingStyle,
        signatureMode: draft.s3SignatureMode,
        allowInsecureLocalhostForTesting: draft.s3AllowInsecureLocalhost && isLocal ? true : undefined,
      };
    }
    case 'github_gist': {
      const apiBaseUrl = (draft.gistApiBaseUrl.trim() || 'https://api.github.com').replace(/\/+$/, '');
      const isLocal = isLoopbackHttpUrl(apiBaseUrl);
      return {
        provider: 'github_gist',
        personalAccessToken: draft.gistToken.trim(),
        gistId: draft.gistId.trim() || undefined,
        apiBaseUrl,
        rootPrefix: draft.gistRootPrefix.trim() || 'SessionMesh',
        allowInsecureLocalhostForTesting: draft.gistAllowInsecureLocalhost && isLocal ? true : undefined,
      };
    }
    case 'local_directory':
      return {
        provider: 'local_directory',
        handleKey: draft.localDirHandleKey.trim(),
        directoryLabel: draft.localDirLabel.trim() || '本地同步文件夹',
        rootPrefix: draft.localDirRootPrefix.trim() || 'SessionMesh',
      };
  }
}

export function validateStorageDraft(draft: StorageFormDraft): string | null {
  switch (draft.provider) {
    case 'webdav': {
      const trimmed = draft.webdavUrl.trim();
      if (!trimmed) return '请填写 WebDAV 服务器地址。';
      const isHttps = trimmed.startsWith('https://');
      const isLocal = isLoopbackHttpUrl(trimmed);
      if (!isHttps && !(draft.webdavAllowInsecureLocalhost && isLocal)) {
        return '出于凭据安全要求，WebDAV 服务器必须使用 https:// 协议（禁止不安全的明文 HTTP）。';
      }
      try {
        new URL(trimmed);
      } catch {
        return 'WebDAV URL 格式无效，请检查协议、主机名与路径。';
      }
      if (draft.webdavAuthType === 'bearer') {
        if (!draft.webdavBearerToken.trim()) return '请填写 Bearer Token。';
      } else {
        if (!draft.webdavUsername.trim()) return '请填写 WebDAV 用户名。';
        if (!draft.webdavPassword) return '请填写 WebDAV 密码或应用专用密码。';
      }
      return null;
    }
    case 's3': {
      const endpoint = draft.s3Endpoint.trim();
      if (!endpoint) return '请填写 S3 / R2 / OSS 服务端点 URL。';
      const isHttps = endpoint.startsWith('https://');
      const isLocal = isLoopbackHttpUrl(endpoint);
      if (!isHttps && !(draft.s3AllowInsecureLocalhost && isLocal)) {
        return '出于凭据安全要求，S3 存储端点必须使用 https:// 协议（仅本机回环调试可显式开启放行）。';
      }
      try {
        new URL(endpoint);
      } catch {
        return 'S3 Endpoint URL 格式无效，请检查协议与域名。';
      }
      if (!draft.s3Bucket.trim() || draft.s3Bucket.includes('/')) {
        return '请填写有效的 Bucket 存储桶名称（不能包含 "/"）。';
      }
      if (!draft.s3Region.trim()) {
        return '请填写 Region 区域（Cloudflare R2 请填 auto）。';
      }
      if (!draft.s3AccessKeyId.trim()) {
        return '请填写 Access Key ID。';
      }
      if (!draft.s3SecretAccessKey) {
        return '请填写 Secret Access Key。';
      }
      return null;
    }
    case 'github_gist': {
      if (!draft.gistToken.trim()) {
        return '请填写 GitHub Personal Access Token（仅需勾选最小 gist 权限）。';
      }
      const apiBase = (draft.gistApiBaseUrl.trim() || 'https://api.github.com').trim();
      const isHttps = apiBase.startsWith('https://');
      const isLocal = isLoopbackHttpUrl(apiBase);
      if (!isHttps && !(draft.gistAllowInsecureLocalhost && isLocal)) {
        return 'GitHub API 地址必须使用 https:// 协议（仅本地 Mock 测试可显式勾选放行 HTTP）。';
      }
      try {
        new URL(apiBase);
      } catch {
        return 'GitHub API Base URL 格式无效。';
      }
      return null;
    }
    case 'local_directory': {
      if (!isDirectoryPickerSupported()) {
        return '当前浏览器不支持本地同步文件夹授权（showDirectoryPicker），请改用 WebDAV / S3 / GitHub Gist 或下方的 .smesh-backup 加密文件备份。';
      }
      if (!draft.localDirHandleKey.trim()) {
        return '请先点击「选择本地同步文件夹」授权同步目录。';
      }
      return null;
    }
  }
}

export function toNonSensitiveMetaPatch(draft: StorageFormDraft): Partial<UiNonSensitiveMeta> {
  switch (draft.provider) {
    case 'webdav':
      return {
        storageProvider: 'webdav',
        storageEndpoint: draft.webdavUrl.trim(),
        webdavUrl: draft.webdavUrl.trim(),
        authType: draft.webdavAuthType,
        rootPath: normalizeWebdavRootPath(draft.webdavRootPath),
        username: draft.webdavAuthType === 'bearer' ? undefined : draft.webdavUsername.trim(),
      };
    case 's3':
      return {
        storageProvider: 's3',
        storageEndpoint: `${draft.s3Endpoint.trim()} (${draft.s3Bucket.trim()})`,
        s3VendorPreset: draft.s3VendorPreset,
        s3Bucket: draft.s3Bucket.trim(),
        s3Region: draft.s3Region.trim(),
        s3RootPrefix: draft.s3RootPrefix.trim() || 'SessionMesh',
        s3AddressingStyle: draft.s3AddressingStyle,
        s3SignatureMode: draft.s3SignatureMode,
      };
    case 'github_gist':
      return {
        storageProvider: 'github_gist',
        storageEndpoint: draft.gistId.trim()
          ? `${draft.gistApiBaseUrl.trim()}/gists/${draft.gistId.trim()}`
          : `${draft.gistApiBaseUrl.trim()}/gists`,
        gistId: draft.gistId.trim() || undefined,
        gistApiBaseUrl: draft.gistApiBaseUrl.trim() || 'https://api.github.com',
        gistRootPrefix: draft.gistRootPrefix.trim() || 'SessionMesh',
      };
    case 'local_directory':
      return {
        storageProvider: 'local_directory',
        storageEndpoint: `local://${draft.localDirLabel.trim() || draft.localDirHandleKey.trim()}`,
        localDirLabel: draft.localDirLabel.trim(),
        localDirHandleKey: draft.localDirHandleKey.trim(),
        localDirRootPrefix: draft.localDirRootPrefix.trim() || 'SessionMesh',
      };
  }
}

export function extractStorageSecretForCompare(draft: StorageFormDraft): string {
  switch (draft.provider) {
    case 'webdav':
      return draft.webdavAuthType === 'bearer' ? draft.webdavBearerToken : draft.webdavPassword;
    case 's3':
      return draft.s3SecretAccessKey;
    case 'github_gist':
      return draft.gistToken;
    case 'local_directory':
      return '';
  }
}

export function getStorageVerifyIdentity(draft: StorageFormDraft): string {
  switch (draft.provider) {
    case 'webdav':
      return `webdav|${draft.webdavUrl.trim()}|${draft.webdavRootPath.trim()}`;
    case 's3':
      return `s3|${draft.s3Endpoint.trim()}|${draft.s3Bucket.trim()}|${draft.s3Region.trim()}|${draft.s3RootPrefix.trim()}`;
    case 'github_gist':
      return `github_gist|${draft.gistApiBaseUrl.trim()}|${draft.gistId.trim()}|${draft.gistRootPrefix.trim()}`;
    case 'local_directory':
      return `local_directory|${draft.localDirHandleKey.trim()}|${draft.localDirRootPrefix.trim()}`;
  }
}

interface StorageProviderFormProps {
  draft: StorageFormDraft;
  onChange: (next: StorageFormDraft) => void;
  onLowFrequencyHint?: (recommended: boolean) => void;
  notifyPermissionOnGrant?: boolean;
  onLocalDirPermissionGranted?: () => void | Promise<void>;
  secretHint?: string;
  expertMode?: boolean;
  showChooserTip?: boolean;
}

const PROVIDER_CARDS: Array<{
  id: StorageProviderType;
  title: string;
  subtitle: string;
  badge?: string;
  badgeVariant?: 'success' | 'info' | 'secondary' | 'outline';
  icon: typeof Server;
}> = [
  {
    id: 'local_directory',
    title: '本地同步盘文件夹',
    subtitle: 'OneDrive · iCloud · Dropbox · 本地目录',
    badge: '零账号·最快',
    badgeVariant: 'info',
    icon: FolderOpen,
  },
  {
    id: 'github_gist',
    title: 'GitHub Private Gist',
    subtitle: '免费零配置 · 自动建私密 Gist',
    badge: '新手推荐',
    badgeVariant: 'success',
    icon: FileCode2,
  },
  {
    id: 'webdav',
    title: 'WebDAV 云盘 / NAS',
    subtitle: '坚果云 · Nextcloud · 群晖 · Alist',
    icon: Server,
  },
  {
    id: 's3',
    title: 'S3 / R2 / 阿里云 OSS',
    subtitle: '高可用强一致对象存储 (免费额度)',
    badge: '多端强一致',
    badgeVariant: 'success',
    icon: Cloud,
  },
];

const RECOMMENDED_S3_CORS_JSON = JSON.stringify(
  [
    {
      AllowedOrigins: ['*'],
      AllowedMethods: ['GET', 'PUT', 'HEAD', 'DELETE'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['ETag', 'x-amz-request-id', 'x-oss-request-id'],
      MaxAgeSeconds: 3600,
    },
  ],
  null,
  2,
);

const GITHUB_NEW_GIST_TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=gist&description=SessionMesh%20Sync';
const JIANGUOYUN_SAFETY_URL = 'https://www.jianguoyun.com/d/home#/safety';
const CLOUDFLARE_R2_DASH_URL = 'https://dash.cloudflare.com/?to=/:account/r2/overview';

export function StorageProviderForm({
  draft,
  onChange,
  onLowFrequencyHint,
  notifyPermissionOnGrant = false,
  onLocalDirPermissionGranted,
  secretHint,
  expertMode = false,
  showChooserTip = true,
}: StorageProviderFormProps) {
  const [showSecret, setShowSecret] = useState(false);
  const [webdavTip, setWebdavTip] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState<Record<string, boolean>>({});
  const [webdavAdvancedOpen, setWebdavAdvancedOpen] = useState(
    () =>
      expertMode ||
      draft.webdavAuthType === 'bearer' ||
      (Boolean(draft.webdavRootPath.trim()) && normalizeWebdavRootPath(draft.webdavRootPath) !== '/SessionMesh'),
  );
  const [s3AdvancedOpen, setS3AdvancedOpen] = useState(
    () =>
      expertMode ||
      draft.s3VendorPreset === 'custom' ||
      Boolean(draft.s3SessionToken.trim()) ||
      (Boolean(draft.s3RootPrefix.trim()) && draft.s3RootPrefix.trim() !== 'SessionMesh'),
  );
  const [gistAdvancedOpen, setGistAdvancedOpen] = useState(
    () =>
      expertMode ||
      Boolean(draft.gistId.trim()) ||
      draft.gistApiBaseUrl !== 'https://api.github.com' ||
      draft.gistAllowInsecureLocalhost,
  );
  const [localDirAdvancedOpen, setLocalDirAdvancedOpen] = useState(
    () => expertMode || (Boolean(draft.localDirRootPrefix.trim()) && draft.localDirRootPrefix.trim() !== 'SessionMesh'),
  );
  const [pickingDir, setPickingDir] = useState(false);
  const [requestingPerm, setRequestingPerm] = useState(false);
  const [dirPermState, setDirPermState] = useState<DirectoryPermissionState | 'missing' | null>(null);

  const pickerSupported = isDirectoryPickerSupported();
  const activeS3Preset = getS3VendorOption(draft.s3VendorPreset);

  useEffect(() => {
    if (expertMode) {
      setWebdavAdvancedOpen(true);
      setS3AdvancedOpen(true);
      setGistAdvancedOpen(true);
      setLocalDirAdvancedOpen(true);
    }
  }, [expertMode]);

  useEffect(() => {
    if (draft.provider !== 'local_directory' || !draft.localDirHandleKey || !pickerSupported) {
      setDirPermState(null);
      return;
    }
    let active = true;
    void queryLocalDirectoryPermission(draft.localDirHandleKey, 'readwrite').then(state => {
      if (active) setDirPermState(state);
    });
    return () => {
      active = false;
    };
  }, [draft.provider, draft.localDirHandleKey, pickerSupported]);

  const toggleGuide = (key: string) => {
    setGuideOpen(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const update = (patch: Partial<StorageFormDraft>) => {
    onChange({ ...draft, ...patch });
  };

  const handleSelectS3Preset = (presetId: S3VendorPreset) => {
    const preset = getS3VendorOption(presetId);
    update({
      s3VendorPreset: presetId,
      s3Region: preset.defaultRegion,
      s3AddressingStyle: preset.defaultAddressingStyle,
      s3SignatureMode: preset.defaultSignatureMode,
    });
    if (presetId === 'custom') {
      setS3AdvancedOpen(true);
    }
  };

  const handlePickLocalDirectory = async () => {
    setPickingDir(true);
    try {
      const picked = await pickAndStoreLocalDirectory();
      setDirPermState(picked.permissionState);
      update({
        localDirHandleKey: picked.handleKey,
        localDirLabel: picked.directoryLabel,
      });
      if (picked.permissionState === 'granted') {
        if (notifyPermissionOnGrant) {
          await unwrapCommand({
            type: 'NOTIFY_LOCAL_DIR_PERMISSION_GRANTED',
            handleKey: picked.handleKey,
          }).catch(() => undefined);
          await onLocalDirPermissionGranted?.();
        }
        toast.success(`已授权本地同步文件夹「${picked.directoryLabel}」`);
      } else {
        toast.warning(`已选择「${picked.directoryLabel}」，请点击「重新授予目录读写权限」完成授权`);
      }
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (!isAbort) {
        toast.error(`选择文件夹失败：${extractErrorMessage(err)}`);
      }
    } finally {
      setPickingDir(false);
    }
  };

  const handleRegrantLocalPermission = async () => {
    if (!draft.localDirHandleKey) return;
    setRequestingPerm(true);
    try {
      const state = await requestLocalDirectoryPermission(draft.localDirHandleKey, 'readwrite');
      setDirPermState(state);
      if (state === 'granted') {
        if (notifyPermissionOnGrant) {
          await unwrapCommand({
            type: 'NOTIFY_LOCAL_DIR_PERMISSION_GRANTED',
            handleKey: draft.localDirHandleKey,
          }).catch(() => undefined);
          await onLocalDirPermissionGranted?.();
        }
        toast.success('已重新授予本地文件夹读写权限');
      } else if (state === 'missing') {
        toast.warning('未在本地找到该目录句柄，请重新点击「选择本地同步文件夹」');
      } else {
        toast.warning('目录读写权限未获批准，请在浏览器弹窗中允许访问');
      }
    } catch (err) {
      toast.error(`重新授权失败：${extractErrorMessage(err)}`);
    } finally {
      setRequestingPerm(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* 4 Provider Cards */}
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label className="text-xs font-medium text-muted-foreground">选择适合你的存储方式：</Label>
          {showChooserTip ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <Sparkles className="h-3 w-3 text-primary" />
              电脑装了 OneDrive / iCloud 选「本地同步盘」最快；有 GitHub 选「Private Gist」1 分钟搞定
            </span>
          ) : null}
        </div>
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {PROVIDER_CARDS.map(card => {
            const Icon = card.icon;
            const active = draft.provider === card.id;
            return (
              <button
                key={card.id}
                type="button"
                onClick={() => update({ provider: card.id })}
                className={`flex flex-col items-start justify-between gap-1.5 rounded-xl border p-3 text-left transition-all ${
                  active
                    ? 'border-primary bg-primary/[0.07] ring-1 ring-primary/40 shadow-2xs'
                    : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
                }`}>
                <div className="flex w-full items-center justify-between gap-2">
                  <div
                    className={`flex h-7 w-7 items-center justify-center rounded-lg ${
                      active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                    }`}>
                    <Icon className="h-4 w-4" />
                  </div>
                  {card.badge ? (
                    <Badge variant={card.badgeVariant || 'success'} className="px-1.5 py-0 text-[10px]">
                      {card.badge}
                    </Badge>
                  ) : null}
                </div>
                <div className="min-w-0 w-full">
                  <div className="truncate text-xs font-semibold text-foreground">{card.title}</div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{card.subtitle}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {secretHint ? (
        <div className="flex items-start gap-2 rounded-lg border border-sky-500/35 bg-sky-500/[0.06] px-3 py-2 text-xs text-sky-900 dark:text-sky-200">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
          <span>{secretHint}</span>
        </div>
      ) : null}

      {/* 1. WebDAV Form */}
      {draft.provider === 'webdav' ? (
        <div className="space-y-4 rounded-xl border border-border bg-muted/15 p-4">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="text-xs text-muted-foreground">点选常用网盘快速填入模板：</Label>
              <button
                type="button"
                onClick={() => toggleGuide('webdav')}
                className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/15">
                <BookOpen className="h-3.5 w-3.5" />
                {guideOpen.webdav ? '收起获取教程' : '怎么获取坚果云 / Nextcloud 应用密码？'}
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {WEBDAV_PRESETS.map(preset => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => {
                    update({
                      webdavUrl: preset.exampleUrl,
                      webdavAuthType: preset.defaultAuthType,
                      webdavRootPath: preset.defaultRootPath,
                    });
                    setWebdavTip(preset.tip);
                    if (preset.recommendLowFreq) {
                      onLowFrequencyHint?.(true);
                    }
                  }}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-3 py-1 text-xs font-medium text-secondary-foreground transition-colors hover:border-primary/50 hover:bg-primary/10">
                  <Cloud className="h-3 w-3 text-primary" />
                  {preset.label}
                </button>
              ))}
            </div>
            {webdavTip ? (
              <p className="rounded-lg bg-muted/70 px-3 py-2 text-xs text-muted-foreground">{webdavTip}</p>
            ) : null}

            {/* Step-by-step WebDAV beginner guide */}
            {guideOpen.webdav ? (
              <div className="space-y-2.5 rounded-xl border border-primary/30 bg-background p-3.5 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-foreground">📖 坚果云 / Nextcloud 保姆级配置步骤</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 px-2.5 text-[11px]"
                    onClick={() => openExternalUrl(JIANGUOYUN_SAFETY_URL)}>
                    打开坚果云安全选项
                    <ExternalLink className="ml-1 h-3 w-3" />
                  </Button>
                </div>
                <ol className="list-decimal space-y-1.5 pl-4 text-muted-foreground leading-relaxed">
                  <li>
                    <strong className="text-foreground">坚果云用户</strong>：点击右上角按钮进入网页版【账户信息 →
                    安全选项】，滑到底部【第三方应用管理】点击【添加应用】，名称填 <code>SessionMesh</code> 生成
                    <strong className="text-foreground">应用密码</strong>（切勿填写坚果云网页登录密码，否则会报 401）。
                  </li>
                  <li>
                    坚果云不允许直接在 <code>/dav/</code> 根目录建文件夹，请先点上方「坚果云」预设，保持地址为{' '}
                    <code>https://dav.jianguoyun.com/dav/我的坚果云/</code>（或你在坚果云中已有的同步文件夹名）。
                  </li>
                  <li>
                    <strong className="text-foreground">Nextcloud / 群晖 NAS</strong>：Nextcloud 请在【个人设置 → 安全 →
                    设备与会话】生成应用专用密码；群晖请在套件中心启用 WebDAV Server 的 HTTPS 端口（默认 5006）。
                  </li>
                </ol>
              </div>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="sm-webdav-url">WebDAV 服务器地址（HTTPS）*</Label>
              <Input
                id="sm-webdav-url"
                type="url"
                value={draft.webdavUrl}
                onChange={e => {
                  const nextUrl = e.target.value;
                  const patch: Partial<StorageFormDraft> = { webdavUrl: nextUrl };
                  if (nextUrl.toLowerCase().includes('jianguoyun.com') && draft.webdavAuthType === 'basic') {
                    patch.webdavAuthType = 'app_password';
                  }
                  update(patch);
                  if (nextUrl.toLowerCase().includes('jianguoyun.com')) {
                    onLowFrequencyHint?.(true);
                  }
                }}
                placeholder="https://dav.jianguoyun.com/dav/我的坚果云/ 或 https://cloud.example.com/remote.php/dav/files/user/"
              />
            </div>

            {draft.webdavAuthType === 'bearer' ? (
              <div className="space-y-1.5 sm:col-span-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="sm-webdav-bearer">Bearer Token *</Label>
                  <button
                    type="button"
                    onClick={() => setShowSecret(prev => !prev)}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                    {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    {showSecret ? '隐藏' : '显示'}
                  </button>
                </div>
                <Input
                  id="sm-webdav-bearer"
                  type={showSecret ? 'text' : 'password'}
                  value={draft.webdavBearerToken}
                  onChange={e => update({ webdavBearerToken: e.target.value })}
                  placeholder="输入 Bearer Access Token"
                />
              </div>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="sm-webdav-user">用户名 / 邮箱 *</Label>
                  <Input
                    id="sm-webdav-user"
                    value={draft.webdavUsername}
                    onChange={e => update({ webdavUsername: e.target.value })}
                    placeholder="填写网盘账号或邮箱"
                  />
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="sm-webdav-pass">
                      {draft.webdavAuthType === 'app_password' ? '应用专用密码 *' : '密码 / 应用专用密码 *'}
                    </Label>
                    <button
                      type="button"
                      onClick={() => setShowSecret(prev => !prev)}
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                      {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      {showSecret ? '隐藏' : '显示'}
                    </button>
                  </div>
                  <Input
                    id="sm-webdav-pass"
                    type={showSecret ? 'text' : 'password'}
                    value={draft.webdavPassword}
                    onChange={e => update({ webdavPassword: e.target.value })}
                    placeholder="坚果云 / Nextcloud 请填应用专用密码"
                  />
                </div>
              </>
            )}
          </div>

          {/* Collapsible WebDAV Advanced Settings */}
          <div className="rounded-lg border border-border bg-background/80">
            <button
              type="button"
              onClick={() => setWebdavAdvancedOpen(prev => !prev)}
              className="flex w-full items-center justify-between px-3.5 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
              <span>
                高级选项（认证方式：
                {draft.webdavAuthType === 'bearer'
                  ? 'Bearer Token'
                  : draft.webdavAuthType === 'app_password'
                    ? '应用专用密码'
                    : 'Basic'}
                {' · '}远端目录：{normalizeWebdavRootPath(draft.webdavRootPath)}，默认无需修改）
              </span>
              {webdavAdvancedOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
            {webdavAdvancedOpen ? (
              <div className="grid gap-3 border-t border-border p-3.5 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>认证方式</Label>
                  <Select
                    value={draft.webdavAuthType}
                    onValueChange={val => update({ webdavAuthType: val as WebDAVAuthType })}>
                    <SelectTrigger>
                      <SelectValue placeholder="选择认证方式" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="basic">Basic 账号密码</SelectItem>
                      <SelectItem value="app_password">应用专用密码（坚果云 / Nextcloud 推荐）</SelectItem>
                      <SelectItem value="bearer">Bearer Token</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="sm-webdav-root">远端存储子目录</Label>
                  <Input
                    id="sm-webdav-root"
                    value={draft.webdavRootPath}
                    onChange={e => update({ webdavRootPath: e.target.value })}
                    placeholder="/SessionMesh"
                  />
                </div>
              </div>
            ) : null}
          </div>

          {isLoopbackHttpUrl(draft.webdavUrl) ? (
            <div className="flex items-center justify-between rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs">
              <span>检测到本机回环地址，仅限开发或本地 Mock 测试允许放行 HTTP：</span>
              <Switch
                checked={draft.webdavAllowInsecureLocalhost}
                onCheckedChange={checked => update({ webdavAllowInsecureLocalhost: checked })}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 2. S3 / Cloudflare R2 / Aliyun OSS / MinIO Form */}
      {draft.provider === 's3' ? (
        <div className="space-y-4 rounded-xl border border-border bg-muted/15 p-4">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="text-xs font-medium text-muted-foreground">
                选择云厂商（自动匹配区域、寻址与签名规则）：
              </Label>
              <button
                type="button"
                onClick={() => toggleGuide('s3')}
                className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/15">
                <BookOpen className="h-3.5 w-3.5" />
                {guideOpen.s3 ? '收起获取教程' : `怎么获取 ${activeS3Preset.shortLabel} 密钥与配置跨域？`}
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {S3_VENDOR_OPTIONS.map(opt => {
                const selected = draft.s3VendorPreset === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => handleSelectS3Preset(opt.id)}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                      selected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-secondary/60 text-secondary-foreground hover:border-primary/50 hover:bg-primary/10'
                    }`}>
                    <Database className="h-3 w-3" />
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <p className="rounded-lg bg-muted/70 px-3 py-2 text-xs text-muted-foreground">{activeS3Preset.tip}</p>

            {/* Step-by-step S3 / R2 / OSS guide + 1-click CORS JSON copy */}
            {guideOpen.s3 ? (
              <div className="space-y-2.5 rounded-xl border border-primary/30 bg-background p-3.5 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-foreground">
                    📖 {activeS3Preset.shortLabel} 快速开通与密钥获取小抄
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {draft.s3VendorPreset === 'r2' ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 px-2.5 text-[11px]"
                        onClick={() => openExternalUrl(CLOUDFLARE_R2_DASH_URL)}>
                        打开 Cloudflare R2 控制台
                        <ExternalLink className="ml-1 h-3 w-3" />
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="h-7 px-2.5 text-[11px]"
                      onClick={() =>
                        void copyToClipboard(RECOMMENDED_S3_CORS_JSON, '已复制标准 S3/OSS CORS 规则 JSON')
                      }>
                      <Copy className="mr-1 h-3 w-3" />
                      复制 CORS 跨域规则 JSON
                    </Button>
                  </div>
                </div>
                {draft.s3VendorPreset === 'r2' ? (
                  <ol className="list-decimal space-y-1.5 pl-4 text-muted-foreground leading-relaxed">
                    <li>
                      打开 Cloudflare 控制台左侧【R2 对象存储】，点击【创建存储桶】起个名字（例如{' '}
                      <code>sessionmesh-sync</code>）并填入下方 Bucket。
                    </li>
                    <li>
                      回到 R2 概览页右上角点击【管理 R2 API 令牌】→【创建 API 令牌】，权限选择
                      <strong className="text-foreground">对象读和写</strong>，限定到刚才的存储桶。
                    </li>
                    <li>
                      创建完成后页面会展示 <strong>为 S3 客户端使用管辖权特定的终结点</strong>（即 Endpoint）、
                      <strong>Access Key ID</strong> 与 <strong>Secret Access Key</strong>，依次复制粘贴到下方即可。
                    </li>
                  </ol>
                ) : (
                  <ol className="list-decimal space-y-1.5 pl-4 text-muted-foreground leading-relaxed">
                    <li>
                      在对象存储控制台新建一个私有读写 Bucket，并创建仅限该 Bucket 读写的子账号 AccessKey ID 与 Secret。
                    </li>
                    <li>
                      若连接时报跨域拦截，可在存储桶【权限/安全管理 → 跨域设置 (CORS)】中粘贴右上角复制的规则（放行{' '}
                      <code>GET / PUT / HEAD / DELETE</code> 并暴露 <code>ETag</code> 响应头）。
                    </li>
                  </ol>
                )}
              </div>
            ) : null}
          </div>

          {draft.s3VendorPreset === 'aliyun_oss' ? (
            <Alert className="border-amber-500/40 bg-amber-500/[0.08]">
              <Info className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              <AlertTitle className="text-xs font-semibold">阿里云 OSS 填写提示</AlertTitle>
              <AlertDescription className="text-xs leading-relaxed">
                Endpoint 填地域节点即可（如 <code>https://oss-cn-hangzhou.aliyuncs.com</code>），无需把 Bucket 名字拼进
                Endpoint；如遇跨域拦截请点上方「怎么获取密钥与配置跨域」复制 CORS 规则。
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sm-s3-endpoint">Endpoint 服务端点（HTTPS）*</Label>
              <Input
                id="sm-s3-endpoint"
                type="url"
                value={draft.s3Endpoint}
                onChange={e => update({ s3Endpoint: e.target.value })}
                placeholder={activeS3Preset.endpointPlaceholder}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sm-s3-bucket">Bucket 存储桶名称 *</Label>
              <Input
                id="sm-s3-bucket"
                value={draft.s3Bucket}
                onChange={e => update({ s3Bucket: e.target.value })}
                placeholder="sessionmesh-vault"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sm-s3-ak">Access Key ID *</Label>
              <Input
                id="sm-s3-ak"
                value={draft.s3AccessKeyId}
                onChange={e => update({ s3AccessKeyId: e.target.value })}
                placeholder="AKIA... / R2 Access Key ID"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="sm-s3-sk">Secret Access Key *</Label>
                <button
                  type="button"
                  onClick={() => setShowSecret(prev => !prev)}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                  {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  {showSecret ? '隐藏' : '显示'}
                </button>
              </div>
              <Input
                id="sm-s3-sk"
                type={showSecret ? 'text' : 'password'}
                value={draft.s3SecretAccessKey}
                onChange={e => update({ s3SecretAccessKey: e.target.value })}
                placeholder="输入 Secret Access Key"
              />
            </div>
          </div>

          {/* Collapsible S3 Advanced Settings */}
          <div className="rounded-lg border border-border bg-background/80">
            <button
              type="button"
              onClick={() => setS3AdvancedOpen(prev => !prev)}
              className="flex w-full items-center justify-between px-3.5 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
              <span>
                高级选项（区域 Region：{draft.s3Region || activeS3Preset.defaultRegion} · 寻址与签名已由「
                {activeS3Preset.shortLabel}」预设自动配好）
              </span>
              {s3AdvancedOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
            {s3AdvancedOpen ? (
              <div className="grid gap-3 border-t border-border p-3.5 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="sm-s3-region">Region 区域 *</Label>
                  <Input
                    id="sm-s3-region"
                    value={draft.s3Region}
                    onChange={e => update({ s3Region: e.target.value })}
                    placeholder={activeS3Preset.regionPlaceholder}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="sm-s3-prefix">对象根目录前缀 (Root Prefix)</Label>
                  <Input
                    id="sm-s3-prefix"
                    value={draft.s3RootPrefix}
                    onChange={e => update({ s3RootPrefix: e.target.value })}
                    placeholder="SessionMesh"
                  />
                </div>

                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="sm-s3-sts">Session Token（可选，仅 STS 临时凭据需要）</Label>
                  <Input
                    id="sm-s3-sts"
                    type={showSecret ? 'text' : 'password'}
                    value={draft.s3SessionToken}
                    onChange={e => update({ s3SessionToken: e.target.value })}
                    placeholder="常规长期 AK/SK 请留空"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>寻址风格 (Addressing Style)</Label>
                  <Select
                    value={draft.s3AddressingStyle}
                    onValueChange={val => update({ s3AddressingStyle: val as 'path' | 'virtual_hosted' })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="path">Path-Style（endpoint/bucket/key · R2 / MinIO 默认）</SelectItem>
                      <SelectItem value="virtual_hosted">
                        Virtual-Hosted-Style（bucket.endpoint/key · 阿里云 OSS / AWS S3）
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label>签名模式 (Signature Mode)</Label>
                  <Select
                    value={draft.s3SignatureMode}
                    onValueChange={val => update({ s3SignatureMode: val as 'aws_v4' | 'oss_v4' })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="aws_v4">AWS SigV4 兼容签名（aws_v4）</SelectItem>
                      <SelectItem value="oss_v4">阿里云 OSS V4 签名（oss_v4）</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ) : null}
          </div>

          {isLoopbackHttpUrl(draft.s3Endpoint) ? (
            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs">
              <span>检测到本机回环地址，勾选以允许本地 MinIO / S3 Mock 使用 HTTP 明文测试：</span>
              <input
                type="checkbox"
                checked={draft.s3AllowInsecureLocalhost}
                onChange={e => update({ s3AllowInsecureLocalhost: e.target.checked })}
                className="h-4 w-4 rounded border-input accent-primary"
              />
            </label>
          ) : null}
        </div>
      ) : null}

      {/* 3. GitHub Private Gist Form */}
      {draft.provider === 'github_gist' ? (
        <div className="space-y-4 rounded-xl border border-border bg-muted/15 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/30 bg-primary/[0.04] px-3.5 py-3">
            <div className="space-y-0.5">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <ShieldCheck className="h-4 w-4 text-primary" />
                零成本免费同步 · 只需粘贴一个 GitHub Gist Token
              </div>
              <p className="text-[11px] text-muted-foreground">
                自动创建私密 Secret Gist 保存加密数据（强制拦截公开 Gist），首台电脑无需手动创建 Gist。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="default"
                className="h-8 text-xs"
                onClick={() => openExternalUrl(GITHUB_NEW_GIST_TOKEN_URL)}>
                一键前往 GitHub 生成 Token
                <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
              </Button>
              <button
                type="button"
                onClick={() => toggleGuide('gist')}
                className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
                <HelpCircle className="h-3.5 w-3.5" />
                {guideOpen.gist ? '收起图解' : '3 步说明'}
              </button>
            </div>
          </div>

          {guideOpen.gist ? (
            <div className="rounded-xl border border-primary/30 bg-background p-3.5 text-xs space-y-1.5">
              <div className="font-semibold text-foreground">📖 1 分钟获取 GitHub Gist Token：</div>
              <ol className="list-decimal space-y-1 pl-4 text-muted-foreground leading-relaxed">
                <li>
                  点击上方蓝色按钮<strong>「一键前往 GitHub 生成 Token」</strong>（已自动帮您填好备注并只勾选最小{' '}
                  <code>gist</code> 权限）。
                </li>
                <li>
                  在打开的页面中选择有效期（Expiration 建议选 <code>No expiration</code> 或 <code>1 year</code>
                  ），直接滚到最底部点击绿色按钮 <strong>Generate token</strong>。
                </li>
                <li>
                  复制生成的 <code>ghp_...</code> 字符串粘贴到下方即可！系统会自动创建或查找您的私密同步空间。
                </li>
              </ol>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="sm-gist-pat">GitHub Personal Access Token（仅需 gist 权限）*</Label>
              <button
                type="button"
                onClick={() => setShowSecret(prev => !prev)}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                {showSecret ? '隐藏' : '显示'}
              </button>
            </div>
            <Input
              id="sm-gist-pat"
              type={showSecret ? 'text' : 'password'}
              value={draft.gistToken}
              onChange={e => update({ gistToken: e.target.value })}
              placeholder="粘贴 ghp_... 或 github_pat_..."
            />
          </div>

          {/* Advanced GitHub Gist Settings (includes optional Gist ID & Enterprise API Base URL) */}
          <div className="rounded-lg border border-border bg-background/80">
            <button
              type="button"
              onClick={() => setGistAdvancedOpen(prev => !prev)}
              className="flex w-full items-center justify-between px-3.5 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
              <span>
                高级选项（{draft.gistId.trim() ? `已指定 Gist ID: ${draft.gistId.trim()}` : 'Gist ID 自动创建/探测'} ·
                默认无需修改）
              </span>
              {gistAdvancedOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
            {gistAdvancedOpen ? (
              <div className="space-y-3 border-t border-border p-3.5">
                <div className="space-y-1.5">
                  <Label htmlFor="sm-gist-id">指定已有 Gist ID（可选，首次使用请留空）</Label>
                  <Input
                    id="sm-gist-id"
                    value={draft.gistId}
                    onChange={e => update({ gistId: e.target.value })}
                    placeholder="留空将自动探测已有 SessionMesh 私有 Gist 或自动新建"
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="sm-gist-api">API Base URL</Label>
                    <Input
                      id="sm-gist-api"
                      value={draft.gistApiBaseUrl}
                      onChange={e => update({ gistApiBaseUrl: e.target.value })}
                      placeholder="https://api.github.com"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="sm-gist-prefix">对象前缀 (Root Prefix)</Label>
                    <Input
                      id="sm-gist-prefix"
                      value={draft.gistRootPrefix}
                      onChange={e => update({ gistRootPrefix: e.target.value })}
                      placeholder="SessionMesh"
                    />
                  </div>
                </div>
                {isLoopbackHttpUrl(draft.gistApiBaseUrl) ? (
                  <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs">
                    <span>检测到本地回环地址，允许本机 Mock Gist 服务使用 HTTP 测试：</span>
                    <input
                      type="checkbox"
                      checked={draft.gistAllowInsecureLocalhost}
                      onChange={e => update({ gistAllowInsecureLocalhost: e.target.checked })}
                      className="h-4 w-4 rounded border-input accent-primary"
                    />
                  </label>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* 4. Local Directory Sync Form */}
      {draft.provider === 'local_directory' ? (
        <div className="space-y-4 rounded-xl border border-border bg-muted/15 p-4">
          {!pickerSupported ? (
            <Alert className="border-amber-500/40 bg-amber-500/10">
              <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              <AlertTitle className="text-sm font-semibold">当前浏览器不支持本地同步目录直连</AlertTitle>
              <AlertDescription className="text-xs leading-relaxed">
                当前浏览器（如 Firefox）暂不支持直接授权本地目录。建议您上方切换为{' '}
                <strong>GitHub Private Gist / WebDAV / S3 · R2</strong>，或使用单文件加密备份（
                <code>.smesh-backup</code>）同步。
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="rounded-xl border border-border bg-background p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="space-y-1">
                    <div className="text-xs font-semibold text-foreground">
                      免填任何网盘密钥 · 直接借助本机 OneDrive / iCloud Drive / Dropbox 文件夹同步
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      只需在你的云盘同步目录里选一个文件夹，SessionMesh
                      会把加密文件写进去，由云盘客户端自动同步到另一台电脑。
                    </p>
                  </div>
                  <Button type="button" size="sm" disabled={pickingDir} onClick={() => void handlePickLocalDirectory()}>
                    {pickingDir ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    {draft.localDirHandleKey ? '更换同步文件夹' : '选择同步文件夹 (OneDrive / iCloud / 本地目录)'}
                  </Button>
                </div>

                <div className="grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-3">
                  <div className="rounded-lg bg-muted/40 px-2.5 py-2">
                    <strong className="text-foreground">① 点选云盘目录</strong>：选择 OneDrive / iCloud
                    下的任意文件夹并允许读写
                  </div>
                  <div className="rounded-lg bg-muted/40 px-2.5 py-2">
                    <strong className="text-foreground">② 自动加密落盘</strong>：所有登录态加密后存入{' '}
                    <code>{draft.localDirRootPrefix || 'SessionMesh'}/</code> 子目录
                  </div>
                  <div className="rounded-lg bg-muted/40 px-2.5 py-2">
                    <strong className="text-foreground">③ 多端自动汇合</strong>
                    ：另一台电脑安装扩展并选同一个同步盘文件夹即可
                  </div>
                </div>

                {draft.localDirHandleKey ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-500/35 bg-emerald-500/[0.06] px-3 py-2.5 text-xs">
                    <div className="space-y-0.5 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-foreground truncate">
                          已选目录：{draft.localDirLabel || draft.localDirHandleKey}
                        </span>
                        {dirPermState === 'granted' ? (
                          <Badge variant="success" className="text-[10px]">
                            <CheckCircle2 className="mr-1 h-3 w-3" />
                            读写权限已就绪
                          </Badge>
                        ) : dirPermState === 'prompt' ? (
                          <Badge variant="warning" className="text-[10px]">
                            <AlertTriangle className="mr-1 h-3 w-3" />
                            需要重新授权
                          </Badge>
                        ) : dirPermState === 'denied' || dirPermState === 'missing' ? (
                          <Badge variant="destructive" className="text-[10px]">
                            {dirPermState === 'missing' ? '目录需重选' : '权限被拒绝'}
                          </Badge>
                        ) : null}
                      </div>
                    </div>

                    {dirPermState === 'prompt' ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={requestingPerm}
                        onClick={() => void handleRegrantLocalPermission()}>
                        {requestingPerm ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        重新授予目录读写权限
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-border py-3.5 text-center text-xs text-muted-foreground">
                    尚未选择文件夹 — 请点击上方「选择同步文件夹」按钮授权目录
                  </div>
                )}
              </div>

              <div className="rounded-lg border border-border bg-background/80">
                <button
                  type="button"
                  onClick={() => setLocalDirAdvancedOpen(prev => !prev)}
                  className="flex w-full items-center justify-between px-3.5 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                  <span>高级选项（子文件夹名称：{draft.localDirRootPrefix || 'SessionMesh'}，默认无需修改）</span>
                  {localDirAdvancedOpen ? (
                    <ChevronUp className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                </button>
                {localDirAdvancedOpen ? (
                  <div className="space-y-1.5 border-t border-border p-3.5">
                    <Label htmlFor="sm-localdir-prefix">加密数据子文件夹名称</Label>
                    <Input
                      id="sm-localdir-prefix"
                      value={draft.localDirRootPrefix}
                      onChange={e => update({ localDirRootPrefix: e.target.value })}
                      placeholder="SessionMesh"
                    />
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
